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
 * 專業工作站遷移驗收（2026-08-27）：
 * - CanvasLibraryPanel 新增風格库 tab（kunpeng 161 條 + 提示詞模板）
 * - LoRA 庫掛進 CanvasEmbed 頂欄並注入生成鏈路
 * - 配方模板入口存在（CanvasLibraryPanel 配方模板 tab）
 * 全部 expected-pass：只斷言已落地的接線，不斷言未實現的行為。
 */

const PANEL = read("src/components/canvas/CanvasLibraryPanel.tsx");
const EMBED = read("src/components/canvas/CanvasEmbed.tsx");
const GENERATION = read("src/components/canvas/embed/use-canvas-generation.ts");
const CANVAS_API = read("src/app/api/canvas/generate/route.ts");

test("CanvasLibraryPanel ships a styles tab with all 161 kunpeng assets and prompt templates", () => {
  // tab 存在且與既有兩 tab 同層
  assert.match(PANEL, /\{ id: "styles", label: "风格库" \}/);
  // 161 條全量渲染（KUNPENG_STYLE_ASSETS.map），不走服務端聚合
  assert.match(PANEL, /KUNPENG_STYLE_ASSETS\.filter/);
  assert.match(PANEL, /KUNPENG_PROMPT_TEMPLATES\.filter/);
  // 客戶端過濾沿用 300ms debounce 搜尋模式
  assert.match(PANEL, /useDebouncedValue\(styleQuery\)/);
  // 數據完整性由 lib 層測試保證；面板斷言不重複計數
  assert.equal(KUNPENG_STYLE_ASSETS.length, 161);
  assert.ok(KUNPENG_PROMPT_TEMPLATES.length >= 2);
  // 來源聲明（MIT 溯源）展示在面板
  assert.match(PANEL, /KUNPENG_SOURCE\.sourceName/);
});

test("styles tab cards align with prompt-card actions: insert / use / save", () => {
  // 插入畫布（onInsertText）+ 填入當前節點（onUsePrompt，buildKunpengStylePrompt 組裝）+ 存入素材
  assert.match(PANEL, /buildKunpengStylePrompt\(s\)/);
  assert.match(PANEL, /onInsertText\(buildKunpengStylePrompt\(s\), s\.name\)/);
  assert.match(PANEL, /onUsePrompt\(buildKunpengStylePrompt\(s\)\)/);
  // 存入素材走既有 PUT /api/canvas/assets（與提示詞卡同款 deterministic id）
  assert.match(PANEL, /saveStyleToAssets/);
  assert.match(PANEL, /kunpeng-\$\{item\.id\}/);
});

test("LoRA library panel is mounted in CanvasEmbed topbar with generation wiring", () => {
  // 掛載點：資源庫按鈕同層的「LoRA」入口
  assert.match(EMBED, /setLoraPanelOpen\(true\)/);
  assert.match(EMBED, /aria-label="LoRA 模型库"/);
  assert.match(EMBED, /<LoraLibraryPanel value=\{selectedLora\} onChange=\{setSelectedLora\} \/>/);
  // 面板本體是逐檔複製品（canvas-workstation/panels/LoraLibraryPanel.tsx）
  assert.match(EMBED, /from "@\/components\/canvas-workstation\/panels\/LoraLibraryPanel"/);
});

test("selected LoRA flows into the canvas generation payload", () => {
  // use-canvas-generation 消費 selectedLora：模型支援才帶，單選
  assert.match(GENERATION, /selectedLora/);
  assert.match(GENERATION, /generationCapabilities\(modelId\)\?\.lora === true/);
  assert.match(GENERATION, /loraModelVersionIds: \[lora\.versionId\]/);
  // /api/canvas/generate 接收並轉發（form + JSON 兩條路徑）
  assert.match(CANVAS_API, /loraModelVersionIds\?: string\[\]/);
  assert.match(CANVAS_API, /form\.append\("loraModelVersionIds", JSON\.stringify\(loraModelVersionIds\)\)/);
  assert.match(CANVAS_API, /loraModelVersionIds \} : \{\}/);
});

test("recipe template section is mounted inside CanvasLibraryPanel", () => {
  // 配方模板 tab（有 onApplyRecipeTemplate 才渲染）
  assert.match(PANEL, /\{ id: "recipes" as LibraryTab, label: "配方模板" \}/);
  assert.match(PANEL, /<RecipeTemplateSection/);
  // hook 原樣引用（useRecipeTemplates 數據面零改寫）
  assert.match(PANEL, /from "@\/components\/canvas-workstation\/panels\/use-recipe-templates"/);
  // CanvasEmbed 提供套用接線（prompt 槽填進當前節點）
  assert.match(EMBED, /onApplyRecipeTemplate/);
});

test("migrated panels are verbatim copies of pro-workstation originals", () => {
  // 複製鐵律：hooks/面板與源逐行等價（僅 import 路徑/外殼接入差異）
  const loraOriginal = read("src/components/pro-workstation/LoraLibraryPanel.tsx");
  const loraCopy = read("src/components/canvas-workstation/panels/LoraLibraryPanel.tsx");
  assert.equal(loraCopy, loraOriginal, "LoraLibraryPanel 必須逐字複製");

  const recipeOriginal = read("src/components/pro-workstation/use-recipe-templates.ts");
  const recipeCopy = read("src/components/canvas-workstation/panels/use-recipe-templates.ts");
  assert.equal(recipeCopy, recipeOriginal, "use-recipe-templates 必須逐字複製");

  // RecipeTemplateSection 允許的差異白名單：遷移註釋 + 三句依賴工作站 UI 的空態文案
  const sectionOriginal = read("src/components/pro-workstation/RecipeTemplateSection.tsx");
  const sectionCopy = read("src/components/canvas-workstation/panels/RecipeTemplateSection.tsx");
  const normalize = (s: string) =>
    s
      .replace(/ \* 2026-08-27 自[\s\S]*?\n \*\n/, "")
      .replace("登录后，在成片卡上点「存为模板」，配方会沉淀到这里。", "登录后即可保存配方模板。")
      .replace("还没有保存的模板。任何一次出图的成片卡上都有「存为模板」。", "还没有保存的模板。")
      .replace(" * 配方模板区（吞併决策主线一第三件）：内置模板 chips + 我的模板列表。\n *\n", " * 配方模板区（吞併决策主线一第三件）：内置模板 chips + 我的模板列表。\n");
  assert.equal(normalize(sectionCopy), normalize(sectionOriginal), "RecipeTemplateSection 除白名單外必須逐字等價");
});
