import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  KUNPENG_STYLE_ASSETS,
} from "../../../lib/kunpeng-style-assets";
import { KUNPENG_PROMPT_TEMPLATES } from "../../../lib/kunpeng-prompt-templates";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

/**
 * 专业工作站迁移验收（2026-08-27）：
 * - CanvasLibraryPanel 新增风格库 tab（kunpeng 161 条 + 提示词模板）
 * - LoRA 库挂进 CanvasEmbed 顶栏并注入生成链路
 * - 配方模板入口存在（CanvasLibraryPanel 配方模板 tab）
 * 全部 expected-pass：只断言已落地的接线，不断言未实现的行为。
 */

const PANEL = read("src/components/canvas/CanvasLibraryPanel.tsx");
const EMBED = read("src/components/canvas/CanvasEmbed.tsx");
const GENERATION = read("src/components/canvas/embed/use-canvas-generation.ts");
const CANVAS_API = read("src/app/api/canvas/generate/route.ts");

test("CanvasLibraryPanel ships a styles tab with all 161 kunpeng assets and prompt templates", () => {
  // tab 存在且与既有两 tab 同层
  assert.match(PANEL, /\{ id: "styles", label: "风格库" \}/);
  // 161 条全量渲染（KUNPENG_STYLE_ASSETS.map），不走服务端聚合
  assert.match(PANEL, /KUNPENG_STYLE_ASSETS\.filter/);
  assert.match(PANEL, /KUNPENG_PROMPT_TEMPLATES\.filter/);
  // 客户端过滤沿用 300ms debounce 搜寻模式
  assert.match(PANEL, /useDebouncedValue\(styleQuery\)/);
  // 数据完整性由 lib 层测试保证；面板断言不重复计数
  assert.equal(KUNPENG_STYLE_ASSETS.length, 161);
  assert.ok(KUNPENG_PROMPT_TEMPLATES.length >= 2);
  // 来源声明（MIT 溯源）展示在面板
  assert.match(PANEL, /KUNPENG_SOURCE\.sourceName/);
});

test("styles tab cards align with prompt-card actions: insert / use / save", () => {
  // 插入画布（onInsertText）+ 填入当前节点（onUsePrompt，buildKunpengStylePrompt 组装）+ 存入素材
  assert.match(PANEL, /buildKunpengStylePrompt\(s\)/);
  assert.match(PANEL, /onInsertText\(buildKunpengStylePrompt\(s\), s\.name\)/);
  assert.match(PANEL, /onUsePrompt\(buildKunpengStylePrompt\(s\)\)/);
  // 存入素材走既有 PUT /api/canvas/assets（与提示词卡同款 deterministic id）
  assert.match(PANEL, /saveStyleToAssets/);
  assert.match(PANEL, /kunpeng-\$\{item\.id\}/);
});

test("LoRA library panel is mounted in CanvasEmbed topbar with generation wiring", () => {
  // 挂载点：资源库按钮同层的「LoRA」入口
  assert.match(EMBED, /setLoraPanelOpen\(true\)/);
  assert.match(EMBED, /aria-label="LoRA 模型库"/);
  assert.match(EMBED, /<LoraLibraryPanel value=\{selectedLora\} onChange=\{setSelectedLora\} \/>/);
  // 面板本体是逐档复制品（canvas-workstation/panels/LoraLibraryPanel.tsx）
  assert.match(EMBED, /from "@\/components\/canvas-workstation\/panels\/LoraLibraryPanel"/);
});

test("selected LoRA flows into the canvas generation payload", () => {
  // use-canvas-generation 消费 selectedLora：模型支援才带，单选
  assert.match(GENERATION, /selectedLora/);
  assert.match(GENERATION, /generationCapabilities\(modelId\)\?\.lora === true/);
  assert.match(GENERATION, /loraModelVersionIds: \[lora\.versionId\]/);
  // /api/canvas/generate 接收并转发（form + JSON 两条路径）
  assert.match(CANVAS_API, /loraModelVersionIds\?: string\[\]/);
  assert.match(CANVAS_API, /form\.append\("loraModelVersionIds", JSON\.stringify\(loraModelVersionIds\)\)/);
  assert.match(CANVAS_API, /loraModelVersionIds \} : \{\}/);
});

test("recipe template section is mounted inside CanvasLibraryPanel", () => {
  // 配方模板 tab（有 onApplyRecipeTemplate 才渲染）
  assert.match(PANEL, /\{ id: "recipes" as LibraryTab, label: "配方模板" \}/);
  assert.match(PANEL, /<RecipeTemplateSection/);
  // hook 原样引用（useRecipeTemplates 数据面零改写）
  assert.match(PANEL, /from "@\/components\/canvas-workstation\/panels\/use-recipe-templates"/);
  // CanvasEmbed 提供套用接线（prompt 槽填进当前节点）
  assert.match(EMBED, /onApplyRecipeTemplate/);
});

test("migrated panels are verbatim copies of pro-workstation originals", () => {
  // 复制铁律：hooks/面板与源逐行等价（仅 import 路径/外壳接入差异）
  const loraOriginal = read("src/components/pro-workstation/LoraLibraryPanel.tsx");
  const loraCopy = read("src/components/canvas-workstation/panels/LoraLibraryPanel.tsx");
  assert.equal(loraCopy, loraOriginal, "LoraLibraryPanel 必须逐字复制");

  const recipeOriginal = read("src/components/pro-workstation/use-recipe-templates.ts");
  const recipeCopy = read("src/components/canvas-workstation/panels/use-recipe-templates.ts");
  assert.equal(recipeCopy, recipeOriginal, "use-recipe-templates 必须逐字复制");

  // RecipeTemplateSection 允许的差异白名单：迁移注释 + 三句依赖工作站 UI 的空态文案
  const sectionOriginal = read("src/components/pro-workstation/RecipeTemplateSection.tsx");
  const sectionCopy = read("src/components/canvas-workstation/panels/RecipeTemplateSection.tsx");
  const normalize = (s: string) =>
    s
      .replace(/ \* 2026-08-27 自[\s\S]*?\n \*\n/, "")
      .replace("登录后，在成片卡上点「存为模板」，配方会沉淀到这里。", "登录后即可保存配方模板。")
      .replace("还没有保存的模板。任何一次出图的成片卡上都有「存为模板」。", "还没有保存的模板。")
      .replace(" * 配方模板区（吞并决策主线一第三件）：内置模板 chips + 我的模板列表。\n *\n", " * 配方模板区（吞并决策主线一第三件）：内置模板 chips + 我的模板列表。\n");
  assert.equal(normalize(sectionCopy), normalize(sectionOriginal), "RecipeTemplateSection 除白名单外必须逐字等价");
});
