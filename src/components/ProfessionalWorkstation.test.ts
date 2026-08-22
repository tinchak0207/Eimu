import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CREATOR_RESOURCES } from "../lib/creator-resource-library";
import { SCENARIO_TEMPLATES } from "../lib/scenario-templates";

const WORKSTATION_ENTRY = "src/components/pro-workstation/InvokeInspiredWorkstation.tsx";
const WORKSTATION_CSS_ENTRY = "src/components/pro-workstation/workstation.css";

/**
 * 工作台在 2026-08-03 从单文件（tsx 5108 行 / css 4296 行）拆成「入口 + 模块」。
 * 读入口时返回入口与拆出模块的拼接，断言因此仍以「整个工作台实现」为单位，
 * 不必逐条改写成新文件名，也不会因为代码换了文件而漏检。
 *
 * 数组顺序即拼接顺序，跨行 `[\s\S]` 断言依赖它：
 * - tsx 以入口打头，保证体量最大的 hooks 与 JSX 保持原相对顺序；
 * - css 必须严格按 @import 顺序，否则层叠语义与浏览器读到的不一致。
 * 尚未存在的文件会被跳过，拆分可以分批落地。
 */
const WORKSTATION_TSX_MODULES = [
  WORKSTATION_ENTRY,
  "src/components/pro-workstation/workstation-constants.ts",
  "src/components/pro-workstation/workstation-subcomponents.tsx",
  "src/components/pro-workstation/workstation-tours.ts",
  "src/components/pro-workstation/workstation-cursor-demo.ts",
  "src/components/pro-workstation/use-panel-resize.ts",
  "src/components/pro-workstation/use-canvas-annotation.ts",
  "src/components/pro-workstation/use-boards-library.ts",
  "src/components/pro-workstation/workstation-recall.ts",
  "src/components/pro-workstation/panels/WorkstationTopbar.tsx",
  "src/components/pro-workstation/panels/CanvasStage.tsx",
  "src/components/pro-workstation/panels/LeftPromptTab.tsx",
  "src/components/pro-workstation/panels/LeftSettingsTab.tsx",
  "src/components/pro-workstation/panels/InspectorPanel.tsx",
];

const WORKSTATION_CSS_MODULES = [
  WORKSTATION_CSS_ENTRY,
  "src/components/pro-workstation/workstation-part-01.css",
  "src/components/pro-workstation/workstation-part-02.css",
  "src/components/pro-workstation/workstation-part-03.css",
  "src/components/pro-workstation/workstation-part-04.css",
  "src/components/pro-workstation/workstation-part-05.css",
  "src/components/pro-workstation/workstation-part-06.css",
];

function readRaw(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

function readBundle(paths: string[]) {
  return paths
    .filter((relPath) => existsSync(join(process.cwd(), relPath)))
    .map(readRaw)
    .join("\n");
}

function read(relPath: string) {
  if (relPath === WORKSTATION_ENTRY) return readBundle(WORKSTATION_TSX_MODULES);
  if (relPath === WORKSTATION_CSS_ENTRY) return readBundle(WORKSTATION_CSS_MODULES);
  return readRaw(relPath);
}

/**
 * 去掉注释后的源码。`assert.doesNotMatch` 断言必须用这个读法，
 * 否则解释「为什么某个符号不该出现在这里」的注释会把断言自己触发掉。
 */
function readCode(relPath: string) {
  return read(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("professional creator library ships attributable GPT Image 2 and Nano Banana Pro resources", () => {
  const libraryPath = join(process.cwd(), "src/lib/creator-resource-library.ts");
  assert.ok(existsSync(libraryPath), "creator resource library should exist");

  const library = read("src/lib/creator-resource-library.ts");
  const source = read("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  // 资源库 UI 已拆到独立的懒加载面板文件，交互契约随之搬到那里断言
  const panel = read("src/components/pro-workstation/CreatorResourcePanel.tsx");

  assert.match(library, /CREATOR_RESOURCES/);
  assert.ok((library.match(/modelId: "gpt-image-2"/g) ?? []).length >= 14);
  assert.ok((library.match(/modelId: "gemini-3\.1-flash-image"/g) ?? []).length >= 14);
  assert.match(library, /sourceUrl:/);
  assert.match(library, /sourceCommit:/);
  assert.match(library, /license:/);
  assert.ok((library.match(/previewImageUrl:/g) ?? []).length >= 6);
  assert.match(library, /freestylefly\/awesome-gpt-image-2/);
  assert.match(library, /YouMind-OpenLab\/awesome-gpt-image-2/);
  assert.match(library, /PicoTrex\/Awesome-Nano-Banana-images/);
  assert.match(library, /ZeroLu\/awesome-nanobanana-pro/);
  assert.match(panel, /CreatorResourcePanel/);
  assert.match(panel, /creator-resource-favorites/);
  assert.match(panel, /toggleFavorite/);
  assert.match(panel, /pro-resource-library/);
  assert.match(panel, /Nano Banana Pro/);
  assert.match(panel, /SCENARIO_TEMPLATES/);
  assert.match(panel, /确认套用/);
  assert.match(panel, /templateChanges/);
  assert.match(panel, /onUndo/);
  // 套用逻辑仍留在父组件，统一面板只负责确认并触发对应模板类型
  assert.match(source, /applyCreatorResource/);
  assert.match(source, /onApplyResource=\{applyCreatorResource\}/);
  assert.match(source, /onApplyScenario=\{applyScenario\}/);
  assert.match(source, /undoTemplateApply/);
});

test("professional workstation copy follows the Apple-style simplified Chinese contract", () => {
  const source = read("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  // 禁用词表管的是「界面上显示的文案」，注释里出现术语不算违约，所以负向断言读去注释版
  const displayed = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");

  [
    "Eimu · 创作工作站",
    "画面描述",
    "创作模板",
    "更多要求",
    "构图要求",
    "项目与品牌",
    "避免内容",
    "参考图设置",
    "张数",
    "品牌",
    "生成信息",
    "导入配置",
    "播放引导",
    "返回普通模式",
    "正在生成",
    "已完成",
    "进行中",
    "任务",
    "重试失败任务",
    "设为参考",
    "清空标注",
  ].forEach((copy) => assert.match(source, new RegExp(copy)));

  [
    "专业生图工作站",
    "主提示词",
    "场景模板",
    "风格模板",
    "工作流预设",
    "项目上下文",
    "反向提示词",
    "上传参考图",
    "用途与强度",
    "生产配置",
    "队列参数",
    "品牌资产",
    "队列检查器",
    "图库与生成溯源",
    "生成溯源",
    "配置召回 / JSON",
    "执行流程",
    "标注转参考图",
    "转入素材",
    "预估词元",
    "槽位",
    "开箱即用",
    "一键就绪",
    "完整参数",
    "架构校验",
    "自动把风格语言包裹",
    "AI 会主动避开",
    "生成中...",
  ].forEach((copy) => assert.doesNotMatch(displayed, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));
  assert.doesNotMatch(displayed, /生成步骤/);
  assert.doesNotMatch(displayed, /WORKFLOW_PLAN_STEPS/);
});

test("professional workstation totals model and quality coin cost", () => {
  const source = read("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  assert.match(source, /imageGenerationCoins/);
  assert.match(source, /预计[\s\S]*张[\s\S]*币/);
});

test("professional workstation is based on open-source workstation patterns", () => {
  const source = read("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const sources = read("src/components/pro-workstation/workstation-sources.ts");
  const design = read("docs/plans/2026-06-09-pro-workstation-platform-design.md");
  const refactor = read("docs/plans/2026-06-10-pro-workstation-ux-refactor.md");
  const playground = read("src/components/ImagePlayground.tsx");
  const styles = read("src/components/pro-workstation/workstation.css");
  const pkg = read("package.json");

  assert.match(sources, /github\.com\/invoke-ai\/InvokeAI/);
  assert.match(sources, /Apache-2\.0/);
  assert.match(sources, /github\.com\/Stability-AI\/StableStudio/);
  assert.match(sources, /MIT/);
  assert.match(sources, /github\.com\/Comfy-Org\/ComfyUI_frontend/);
  assert.match(sources, /github\.com\/comfyanonymous\/ComfyUI/);
  assert.match(sources, /github\.com\/lllyasviel\/Fooocus/);
  assert.match(sources, /github\.com\/AUTOMATIC1111\/stable-diffusion-webui/);
  assert.match(sources, /AGPL-3\.0/);
  assert.match(sources, /product-reference/);
  assert.match(sources, /Unified Canvas/);
  assert.match(sources, /Control Layers/);
  assert.match(sources, /Board & Gallery Management/);
  assert.match(sources, /Queue/);
  assert.match(sources, /Prompt Library/);
  assert.match(sources, /Image Prompt/);
  assert.match(sources, /PNG Info/);
  assert.match(design, /\/api\/generate-images/);
  assert.match(design, /quota/);
  assert.match(design, /history/);
  assert.match(design, /Mobile should keep normal mode/);
  assert.match(design, /No fake node execution engine/);
  assert.match(refactor, /regionalPrompts/);
  assert.match(refactor, /driver\.js/);
  assert.match(source, /WORKSTATION_SOURCES/);
  assert.match(source, /WORKFLOW_PRESETS/);
  assert.match(source, /WORKFLOW_SCHEMA_VERSION/);
  assert.match(source, /REFERENCE_IMAGE_ROLES/);
  assert.match(source, /promptHint/);
  assert.match(source, /negativeHint/);
  assert.match(source, /estimatedCredits/);
  assert.match(source, /negativePrompt/);
  assert.match(source, /workflowPreset/);
  assert.match(source, /role/);
  assert.match(source, /队列/);
  assert.match(source, /生成信息/);
  assert.match(source, /pro-studio-shell/);
  assert.match(source, /pro-studio-topbar/);
  assert.match(source, /pro-mode-segment/);
  assert.match(source, /pro-side-tabs/);
  assert.match(source, /pro-canvas-stage/);
  assert.match(source, /pro-inspector-tabs/);
  assert.match(source, /pro-accordion/);
  assert.match(source, /workspaceMode/);
  assert.match(source, /activateWorkspace/);
  assert.match(source, /leftPanelTab/);
  assert.match(source, /inspectorTab/);
  assert.match(source, /activeCanvasTool/);
  assert.match(source, /galleryMode/);
  assert.doesNotMatch(source, /pro-workstation-grid/);
  assert.doesNotMatch(source, /pro-command-rail/);
  assert.doesNotMatch(source, /pro-launchpad-grid/);
  assert.match(source, /copyProvenanceConfig/);
  assert.match(source, /restoreProvenanceConfig/);
  assert.match(source, /restoreHistoryEntry/);
  assert.match(source, /parseWorkflowRecallConfig/);
  assert.match(source, /extractPromptSection/);
  assert.match(source, /recentWorkflows/);
  assert.match(source, /navigator\.clipboard\.writeText/);
  assert.match(source, /复制配置/);
  assert.match(source, /导入配置/);
  assert.match(source, /最近任务/);
  assert.match(source, /promptStats/);
  assert.match(source, /尚未输入/);
  assert.match(source, /className="pro-accordion pro-collapsed-mobile"/);
  assert.doesNotMatch(source, /className="pro-accordion pro-collapsed-mobile" open/);
  assert.match(source, /className="pro-control-row pro-range-control"/);
  assert.match(source, /<output htmlFor="pro-copies">/);
  assert.match(styles, /\.pro-accordion > summary::after/);
  assert.match(source, /pro-slot-list/);
  assert.match(source, /data-slot-state/);
  assert.match(source, /applyCreatorResource/);
  assert.match(source, /applyScenario/);
  assert.match(source, /尺寸/);
  assert.match(source, /imageSize/);
  assert.match(source, /qualityProfile/);
  assert.match(source, /productionIntent/);
  assert.match(source, /seedHint/);
  assert.match(source, /重试失败任务/);
  assert.match(source, /selectedSlotId/);
  assert.match(source, /openResultOnCanvas/);
  assert.match(source, /sendResultToAssets/);
  assert.match(source, /MAX_REFERENCE_IMAGES/);
  assert.match(source, /canvasZoom/);
  assert.match(source, /data-canvas-tool/);
  assert.match(source, /pro-topbar-chips/);
  assert.match(source, /pro-zoom-toggle/);
  assert.match(source, /pro-canvas-meta/);
  assert.match(source, /is-selected/);
  assert.match(source, /设为参考/);
  assert.match(source, /打开/);
  assert.match(source, /返回普通模式/);
  assert.match(source, /生成（⌘ Enter）/);
  [
    "Canvas",
    "Viewer",
    "Launchpad",
    "Prompt Lab",
    "Image Prompt",
    "Control Layers",
    "Production Profile",
    "Queue",
    "Unified Canvas",
    "Canvas Tools",
    "Run",
    "Boards",
    "Layers",
    "History",
    "Board & Gallery Management",
    "Provenance",
    "Queue Inspector",
    "Slots",
    "Running",
    "Done",
    "Failed",
    "Fallback used",
    "Workflow Plan",
    "Recent Runs",
    "PNG Info",
    "JSON Recall",
    "Prompt Library",
    "Estimated tokens",
    "Retry failed slots",
    "Annotate",
    "Tour",
    "Gallery",
  ].forEach((label) => assert.doesNotMatch(source, new RegExp(`>${label}<|title="${label}"|aria-label="${label}"`)));
  assert.match(pkg, /"@atlaskit\/pragmatic-drag-and-drop"/);
  assert.match(pkg, /"driver\.js"/);
  assert.match(source, /draggable\(/);
  assert.doesNotMatch(source, /SuggestionList/);
  assert.match(source, /CreatorResourcePanel/);
  assert.match(source, /concurrency/);
  assert.match(source, /contextPrompt/);
  assert.match(playground, /dynamic\(\(\) => import\("@\/components\/pro-workstation\/InvokeInspiredWorkstation"\)/);
  assert.match(playground, /showProfessionalMode/);
  assert.match(playground, /recentWorkflows=\{recentWorkflows\}/);
  // Entry point now lives in the prompt card's action row as a toggle.
  assert.match(playground, /onToggleProfessionalMode=\{openProfessionalMode\}/);
  assert.match(playground, /regionalPrompts: config\.regionalPrompts/);
});

test("professional workstation guides beginners with a three-step layered flow", () => {
  const source = read("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");

  // 左栏三步 + 右栏三面板，每个面板自带一行说明
  assert.match(source, /label: "提示词"/);
  assert.match(source, /label: "参考图"/);
  assert.match(source, /label: "参数"/);
  assert.match(source, /LEFT_PANEL_TABS/);
  assert.match(source, /INSPECTOR_TABS/);
  assert.match(source, /pro-panel-hint/);
  assert.match(source, /pro-section-note/);
  assert.match(source, /描述画面，选择模板和风格。/);
  assert.match(source, /添加产品、人物或风格参考。/);
  assert.match(source, /设置模型、尺寸、数量和高级参数。/);
  assert.match(source, /队列/);
  assert.match(source, /图库/);
  assert.match(source, /历史/);
  assert.match(source, /成片墙/);

  // driver.js 交互式引导：首次自动播放 + 顶栏可重播
  assert.match(source, /from "driver\.js"/);
  assert.match(source, /driver\.js\/dist\/driver\.css/);
  assert.match(source, /startTour/);
  assert.match(source, /TOUR_STORAGE_KEY/);
  assert.match(source, /localStorage\.setItem\(TOUR_STORAGE_KEY/);
  assert.doesNotMatch(source, /setTimeout\(\(\) => startTour\(\)/);
  assert.match(source, /播放引导/);
  assert.match(source, /三步生成/);
  assert.match(source, /画面描述/);
  assert.match(source, /第 \{\{current\}\} \/ \{\{total\}\} 步/);
  assert.match(source, /下一步/);
  assert.match(source, /onHighlightStarted/);
  assert.match(source, /pro-tour-popover/);
});

test("professional workstation has no decorative controls", () => {
  const source = read("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const workflowLib = read("src/lib/generation-workflow.ts");
  const recallLib = read("src/lib/workflow-recall.ts");
  const types = read("src/lib/image-types.ts");

  // 构图要求真实写入生成请求，并可由 JSON / 历史召回；不再伪装成带强度的区域蒙版
  assert.match(source, /regionalPrompts/);
  assert.match(source, /addRegionalPrompt/);
  assert.match(source, /updateRegionalPrompt/);
  assert.match(source, /removeRegionalPrompt/);
  assert.match(source, /restoreRegionalPrompts/);
  assert.match(source, /构图要求/);
  assert.doesNotMatch(readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx"), /局部要求/);
  assert.doesNotMatch(source, /pro-regional-weight/);
  assert.match(types, /RegionalPromptMetadata/);
  assert.match(workflowLib, /normalizeRegionalPrompts/);
  assert.match(workflowLib, /Regional requirements/);
  assert.match(recallLib, /regionalPrompts/);

  // 参考图强度真实进入 workflow 元数据与最终提示词
  assert.match(source, /updateReferenceStrength/);
  assert.match(source, /强度/);
  assert.match(types, /strength\?: number/);
  assert.match(workflowLib, /strength/);
  assert.match(workflowLib, /influence/);

  // 画布标注是真实的绘制层，可合成原图导出为参考图
  assert.match(source, /annotationCanvasRef/);
  assert.match(source, /handleAnnotationPointerDown/);
  assert.match(source, /handleAnnotationPointerMove/);
  assert.match(source, /clearAnnotation/);
  assert.match(source, /exportAnnotationToReference/);
  assert.match(source, /destination-out/);
  assert.match(source, /设为参考/);
  assert.match(source, /标注笔/);
  assert.match(source, /pro-annotate-layer/);
  assert.match(source, /toBlob/);

  // 装饰性的旧三类图层与启动台已删除
  assert.doesNotMatch(source, /rasterLayers/);
  assert.doesNotMatch(source, /addRasterLayer/);
  assert.doesNotMatch(source, /启动台/);
});

test("professional workstation ships an application layer for real ad workflows", () => {
  const source = read("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const styleLib = read("src/lib/style-library.ts");
  const scenarioLib = read("src/lib/scenario-templates.ts");
  const boardsLib = read("src/lib/boards-store.ts");
  const brandLib = read("src/lib/brand-kit.ts");
  const formatsLib = read("src/lib/ad-formats.ts");
  const zipLib = read("src/lib/export-zip.ts");
  const recallLib = read("src/lib/workflow-recall.ts");
  const hook = read("src/hooks/use-image-generation.ts");
  const pkg = read("package.json");

  // 开源模板库（不造轮子）：106 种风格逐字 vendored 自 MIT 项目
  assert.match(styleLib, /twri\/sdxl_prompt_styler/);
  assert.match(styleLib, /MIT/);
  assert.match(styleLib, /\{prompt\}/);
  assert.ok((styleLib.match(/id: "/g) ?? []).length >= 106, "风格库应有至少 106 条");
  assert.match(source, /STYLE_CATEGORIES/);
  assert.match(source, /applyStyleToPrompt/);
  assert.match(source, /mergeStyleNegative/);
  assert.match(source, /风格/);

  // 场景模板：填好项目信息 / 避免内容 / 风格 / 尺寸（冷启动核心）
  assert.match(scenarioLib, /SCENARIO_TEMPLATES/);
  assert.ok((scenarioLib.match(/contextPrompt:/g) ?? []).length >= 14, "场景模板应有至少 14 条");
  assert.match(source, /applyScenario/);
  assert.match(read("src/components/pro-workstation/CreatorResourcePanel.tsx"), /场景模板/);

  // 重叠入口已收敛：提示词页不再单独提供预设、场景和灵感模块
  const displayed = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  assert.doesNotMatch(displayed, />\s*预设\s*</);
  assert.doesNotMatch(displayed, />\s*灵感\s*</);
  assert.match(displayed, /创作模板/);
  assert.match(displayed, /更多要求/);

  // 成片文件夹：IndexedDB 持久化 + 星标评审 + 移动 + 删除 + ZIP 导出（B 端资产管理）
  assert.match(boardsLib, /idb-keyval/);
  assert.match(boardsLib, /DEFAULT_BOARD_NAME/);
  assert.match(zipLib, /jszip/i);
  assert.match(source, /saveResultToBoard/);
  assert.match(source, /存入文件夹/);
  assert.match(source, /handleExportBoard/);
  assert.match(source, /导出打包文件/);
  assert.match(source, /handleToggleStar/);
  assert.match(source, /handleMoveShot/);
  assert.match(source, /renderBoardsPanel/);

  // 品牌信息：本机持久化并在生成时注入上下文
  assert.match(brandLib, /buildBrandContext/);
  assert.match(source, /品牌/);
  assert.match(source, /saveBrandKit/);
  assert.match(source, /buildBrandContext/);

  // 多尺寸投放：任务轮替分配，一次出齐方 / 横 / 竖
  assert.match(formatsLib, /sizeForSlot/);
  assert.match(source, /toggleImageSize/);
  assert.match(source, /imageSizes/);
  assert.match(hook, /workflowForSlot/);
  assert.match(hook, /imageSizes/);
  assert.match(recallLib, /imageSizes/);
  assert.match(recallLib, /styleTemplate/);

  assert.match(pkg, /"idb-keyval"/);
  assert.match(pkg, /"jszip"/);
});

test("unified template count stays in sync with both vendored data files", () => {
  // 标题数字不应把两份数据拉进入场 chunk，因此在父组件写死，并在这里校验总数。
  const source = read("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const templateCount = Number(source.match(/const CREATIVE_TEMPLATE_COUNT = (\d+)/)?.[1]);

  assert.equal(templateCount, SCENARIO_TEMPLATES.length + CREATOR_RESOURCES.length, "创作模板总数与两份数据源不一致");
  assert.ok(SCENARIO_TEMPLATES.length >= 14, "场景模板应有至少 14 条");
  assert.ok(CREATOR_RESOURCES.length >= 28, "创作资源应有至少 28 条");
  assert.ok(
    CREATOR_RESOURCES.filter((resource) => resource.modelId === "gpt-image-2").length >= 14,
    "GPT Image 2 资源应有至少 14 条",
  );
  assert.ok(
    CREATOR_RESOURCES.filter((resource) => resource.modelId === "gemini-3.1-flash-image").length >= 14,
    "Nano Banana Pro 资源应有至少 14 条",
  );
});

test("professional workstation stays fast on low-end hardware", () => {
  const source = read("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const playground = read("src/components/ImagePlayground.tsx");
  const zipLib = read("src/lib/export-zip.ts");
  const cacheLib = read("src/lib/generation-cache.ts");
  const imageSrcLib = read("src/components/image-src.ts");
  const creatorPanel = read("src/components/pro-workstation/CreatorResourcePanel.tsx");

  // 重子树有 memo 边界，键击不再重渲染整棵树
  assert.match(source, /useEventCallback/);
  assert.match(creatorPanel, /memo\(function CreatorResourcePanel/);
  assert.match(source, /memo\(function StyleGrid/);
  assert.match(source, /memo\(function QueueSlotList/);
  assert.match(source, /memo\(function BoardsPanel/);
  assert.match(source, /memo\(function DraggableReferenceTile/);
  assert.match(source, /useMemo/);

  // base64 data URL 按对象身份缓存，不再每次渲染重新分配多 MB 字符串。
  // 缓存已抽到 components/image-src.ts，普通模式与专业模式共用同一个入口。
  assert.match(imageSrcLib, /resultSrcCache/);
  assert.match(imageSrcLib, /WeakMap<ImageResult, string>/);
  assert.match(source, /import \{ resultSrc \} from "@\/components\/image-src"/);
  assert.doesNotMatch(source, /`data:image\/png;base64,/);

  // 重依赖按需加载：jszip 仅在导出时、driver.js 仅在引导时
  assert.match(zipLib, /await import\("jszip"\)/);
  assert.doesNotMatch(zipLib, /^import JSZip/m);
  assert.match(source, /await import\("driver\.js"\)/);
  assert.match(source, /import type \{ Driver \} from "driver\.js"/);

  // 工作站专用 CSS 随懒加载 chunk 下发，不阻塞首页首屏
  assert.match(playground, /dynamic\(\(\) => import\("@\/components\/pro-workstation\/InvokeInspiredWorkstation"\)/);
  assert.doesNotMatch(playground, /import "\.\/pro-workstation\/workstation\.css"/);

  // 提示词数据只跟着面板 chunk 走，不进专业模式入场 chunk：
  // 数据文件的 import 必须只出现在面板文件里，入场文件只能拿类型和 dynamic()。
  const sourceCode = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  assert.match(source, /dynamic\(\(\) => import\("\.\/CreatorResourcePanel"\)/);
  assert.match(creatorPanel, /SCENARIO_TEMPLATES, type ScenarioTemplate/);
  assert.match(creatorPanel, /CREATOR_RESOURCES,/);
  assert.match(creatorPanel, /from "@\/lib\/creator-resource-library"/);
  assert.match(sourceCode, /import type \{ ScenarioTemplate \} from "@\/lib\/scenario-templates"/);
  assert.match(sourceCode, /import type \{ CreatorResource \} from "@\/lib\/creator-resource-library"/);
  assert.doesNotMatch(sourceCode, /SCENARIO_TEMPLATES/);
  assert.doesNotMatch(sourceCode, /CREATOR_RESOURCES/);
  // 标题总数写死，避免为了一个数字把两份数据拉回入场 chunk。
  assert.match(sourceCode, /const CREATIVE_TEMPLATE_COUNT = 46/);
  // 统一模板面板默认展开，占位必须撑住真实高度（列表 max-height 21rem），否则 chunk 落地会跳版
  assert.match(read("src/components/pro-workstation/workstation.css"), /\.pro-resource-list \{[^}]*max-height: 21rem/);
  assert.match(sourceCode, /className="pro-resource-list" style=\{\{ minHeight: "21rem" \}\}/);

  // base64 不写入 localStorage（生成结束时的主线程卡顿来源）
  assert.match(cacheLib, /image: null/);

  // 快捷键走稳定 ref 的原生 keydown，不再随键击重绑
  assert.match(source, /runRef/);
  assert.match(source, /metaKey/);
  assert.doesNotMatch(source, /from "react-hotkeys-hook"/);
  assert.doesNotMatch(source, /from "react-virtuoso"/);
});

test("professional workstation keeps a compact single-screen liquid glass layout", () => {
  const globals = read("src/app/globals.css");
  const styles = read("src/components/pro-workstation/workstation.css");

  assert.match(globals, /\.pro-app-shell \{[^}]*height: 100svh/);
  assert.match(globals, /\.pro-app-shell \{[^}]*overflow: hidden/);
  assert.doesNotMatch(globals, /\.pro-studio-shell/);
  assert.match(styles, /\.pro-app-shell \.pro-canvas-stage \{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto/);
  assert.match(styles, /--pro-spring: cubic-bezier\(0\.34, 1\.56, 0\.64, 1\)/);
  assert.match(styles, /\.pro-glass-panel \{[^}]*backdrop-filter: blur\(40px\) saturate\(1\.8\) brightness\(1\.08\)/);
  // 顶栏是常驻合成层，模糊半径已收敛到 28px（与 globals.css 一致）；
  // saturate(2) 保留，材质观感不变。回退到 >28px 会重新拖慢滚动合成。
  assert.match(styles, /\.pro-studio-topbar \{[^}]*backdrop-filter: blur\(28px\) saturate\(2\)/);
  const styleRules = readCode("src/components/pro-workstation/workstation.css");
  assert.doesNotMatch(styleRules, /backdrop-filter: blur\(48px\)/);
  assert.doesNotMatch(styleRules, /backdrop-filter: blur\(32px\)/);
  assert.match(styles, /\.pro-studio-topbar::before,\r?\n\.pro-glass-panel::before/);
  assert.match(styles, /\.pro-panel-hint/);
  assert.match(styles, /\.pro-section-note/);
  assert.match(styles, /\.pro-topbar-chips/);
  assert.match(styles, /\.pro-canvas-dock/);
  assert.match(styles, /\.pro-dock-actions/);
  assert.match(styles, /\.pro-zoom-toggle/);
  assert.match(styles, /\.pro-canvas-meta/);
  assert.match(styles, /\.pro-canvas-actual/);
  assert.match(styles, /\.pro-canvas-notice/);
  assert.match(styles, /\.pro-annotate-layer/);
  assert.match(styles, /\.pro-regional-row/);
  assert.match(styles, /\.pro-reference-tile/);
  assert.match(styles, /\.pro-chip-grid/);
  assert.match(styles, /\.pro-style-grid/);
  assert.match(styles, /\.pro-size-options/);
  assert.match(styles, /\.pro-brand-form/);
  assert.match(styles, /\.pro-board-chips/);
  assert.match(styles, /\.pro-shot-grid/);
  assert.match(styles, /\.pro-gallery-card\.is-selected/);
  assert.match(styles, /\.pro-canvas-preview\[data-canvas-tool="annotate"\]/);
  assert.match(styles, /\.driver-popover\.pro-tour-popover/);
  assert.doesNotMatch(styles, /\.pro-command-rail/);
  assert.doesNotMatch(styles, /\.pro-launchpad-grid/);
});

test("professional workstation exposes one complete work surface at a time on mobile", () => {
  const source = read("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const styles = read("src/components/pro-workstation/workstation.css");

  assert.match(source, /type MobilePanel = "create" \| "settings" \| "canvas" \| "output"/);
  assert.match(source, /const \[mobilePanel, setMobilePanel\] = useState<MobilePanel>\("create"\)/);
  assert.match(source, /className="pro-mobile-nav"/);
  assert.match(source, /\{ id: "settings", label: "参数" \}/);
  assert.match(source, /activateMobilePanel/);
  assert.doesNotMatch(source, /className="pro-mobile-workspace-mode"/);
  assert.match(source, /className="pro-action-label"/);
  assert.match(source, /className="pro-topbar-tool/);
  assert.match(source, /className="pro-title-mobile"/);
  assert.match(source, /className="pro-run-count"/);
  assert.match(source, /const studioBodyRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(source, /studioBodyRef\.current\.scrollTop = 0/);
  assert.match(source, /ref=\{studioBodyRef\}/);
  // 模型选择器已从「参数」tab 的手风琴里搬到提示词上方，与提示词、运行条同一列视线。
  assert.match(source, /className="pro-model-row" id="pro-tour-model"/);
  assert.match(source, /data-mobile-panel=\{mobilePanel\}/);
  assert.match(source, /setMobilePanel\("output"\)/);
  assert.match(source, /setInspectorTab\("queue"\)/);
  assert.match(source, /className="pro-inline-panel-link"/);
  assert.match(source, /onClick=\{\(\) => setLeftPanelTab\("prompt"\)\}/);
  assert.match(source, /leftPanelTab === "assets"[\s\S]*?<ReferenceImageUpload value=\{referenceImages\} onChange=\{onReferenceImagesChange\} compact onWorkflowDetected=\{restoreProvenanceConfigFromPng\} \/>/);
  // 画布 tab 不再因为「还没有成片」被禁用：唯一能看到标注工具的入口不该锁着。
  assert.doesNotMatch(source, /panel\.id === "canvas" && !visibleResult/);
  assert.match(source, /尚未输入/);
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*\.pro-studio-body \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /\.pro-side-tabs \{\s*display: none/);
  assert.match(styles, /\.pro-studio-body::-webkit-scrollbar/);
  assert.match(styles, /\.pro-panel-stack\s*\{[^}]*min-width: 0/);
  assert.match(styles, /\.pro-app-shell \.pro-glass-panel\s*\{[^}]*backdrop-filter: none/);
  assert.match(styles, /#pro-tour-run:disabled\s*\{[^}]*color: hsl\(var\(--foreground\) \/ 0\.45\)/);
  assert.match(styles, /\.pro-app-shell textarea/);
  assert.match(styles, /\.pro-app-shell input:not\(\[type="range"\]\)/);
  assert.match(styles, /\.pro-app-shell select/);
  assert.match(styles, /data-mobile-panel="settings"\] \.pro-canvas-stage/);
  assert.match(styles, /\.pro-control-row strong \{\s*display: none/);
  assert.doesNotMatch(source, /modelPriceLabel/);
  assert.doesNotMatch(source, /<strong>\{durationSeconds/);
  assert.doesNotMatch(source, /<strong>\{generateAudio/);
  assert.doesNotMatch(source, /<strong>\{qualityProfileLabel/);
  assert.doesNotMatch(source, /<strong>\{productionIntentLabel/);
  assert.doesNotMatch(styles, /\.pro-model-control strong/);
  assert.doesNotMatch(styles, /\.pro-model-control select/);
  assert.match(styles, /\.pro-model-control \[data-model-picker-trigger\] \{\s*width: 100%;\s*max-width: 100%;/);
  assert.match(styles, /\.pro-app-shell \.pro-canvas-stage \{\s*grid-template-rows: auto minmax\(320px, 1fr\) auto/);
  assert.match(styles, /data-mobile-panel="create"\] \.pro-canvas-stage/);
  assert.match(styles, /data-mobile-panel="output"\] \.pro-left-panel/);
  assert.doesNotMatch(styles, /\.pro-run-count\s*\{\s*display:\s*none/);
});

test("professional workstation keeps mobile empty states honest and actionable", () => {
  const source = read("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const styles = read("src/components/pro-workstation/workstation.css");

  assert.match(source, /type SlotState = "done" \| "failed" \| "running" \| "queued" \| "idle"/);
  assert.match(source, /idle: "待生成"/);
  assert.match(source, /hasAnnotation && \(/);
  assert.match(source, /visibleResult && \(/);
  assert.match(styles, /#pro-tour-run:disabled/);
});

test("professional workstation never exposes internal generation channels", () => {
  const workstation = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const historyPanel = readCode("src/components/pro-workstation/HistoryInspectorPanel.tsx");
  const workflow = read("src/lib/generation-workflow.ts");

  assert.doesNotMatch(workstation, /endpointLabel|ENDPOINT_LABELS|fallbackSlots|主渠道|备用渠道|等待调度/);
  assert.doesNotMatch(historyPanel, /endpointLabel/);
  assert.match(workstation, /formatPublicGenerationSummary/);
  assert.match(workflow, /generateAudio/);
});

test("LoRA exploration enlarges readable cards inside a bounded replacement page", () => {
  const source = readCode("src/components/pro-workstation/LoraLibraryPanel.tsx");
  const workstation = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const styles = read("src/components/pro-workstation/workstation.css");

  assert.match(source, /const PAGE_SIZE = 6/);
  assert.match(source, /setItems\(data\.items \?\? \[\]\)/);
  assert.match(source, /firstItemRef\.current\?\.focus/);
  assert.match(source, /scrollIntoView/);
  assert.match(source, /w-full min-w-0 max-w-full/);
  assert.match(source, /\[contain:inline-size\]/);
  assert.match(source, /pro-lora-card-title/);
  assert.match(source, /pro-lora-selected-title/);
  assert.match(source, /text-ios-subhead/);
  assert.match(source, /min-h-11/);
  assert.match(source, /h-10 w-10/);
  assert.doesNotMatch(source, /pro-lora-card-title[^\n]*truncate/);
  assert.match(styles, /\.pro-lora-card-grid\s*\{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /-webkit-line-clamp: 2/);
  assert.match(workstation, /waitForSelector\("#pro-tour-lora", 2500\)/);
  assert.match(workstation, /scrollIntoView\(\{ block: "center", inline: "nearest" \}\)/);
  assert.doesNotMatch(source, /loadMore|loadingMore|加载更多|\[\.\.\.current,/);
});

test("desktop workstation switches between preparation rail and expanded output", () => {
  const workstation = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const styles = read("src/components/pro-workstation/workstation.css");

  assert.match(workstation, /const \[inspectorExpanded, setInspectorExpanded\] = useState\(false\)/);
  assert.match(workstation, /data-explorer-focus=\{loraPanelOpen \? "lora" : undefined\}/);
  assert.match(workstation, /data-inspector-state=\{inspectorExpanded \? "expanded" : "rail"\}/);
  assert.match(workstation, /pro-inspector-tab-icon/);
  assert.match(workstation, /pro-inspector-tab-label/);
  /*
    右栏收放必须是显式的。
    旧版靠左栏的 onClickCapture：点到左栏任意按钮就把右栏收成 72px 轨道，
    中栏跟着横跳 —— 用户猜不到这个手势，也找不回展开的把手。
    现在断言那个隐式手势已经消失，且存在一个带 aria-expanded 的收放按钮。
  */
  assert.doesNotMatch(workstation, /onClickCapture=\{\(event\) => \{[\s\S]*?closest\("button"\)[\s\S]*?setInspectorExpanded\(false\)/);
  assert.match(workstation, /className="pro-inspector-collapse"[\s\S]*?aria-expanded=\{inspectorExpanded\}/);
  assert.match(workstation, /setInspectorExpanded\(\(current\) => !current\)/);
  assert.match(workstation, /const run = \(requestedCopies = copies\)[\s\S]*?setInspectorExpanded\(true\)/);
  assert.match(workstation, /setInspectorTab\(tab\.id\);[\s\S]*?setInspectorExpanded\(true\);[\s\S]*?setLoraPanelOpen\(false\);/);
  assert.match(styles, /data-inspector-state="rail"[\s\S]*?minmax\(360px, 1fr\)[\s\S]*?72px/);
  assert.match(styles, /data-inspector-state="expanded"[\s\S]*?minmax\(320px, 1fr\)[\s\S]*?minmax\(220px, var\(--pro-right-w, 320px\)\)/);
  assert.match(styles, /data-inspector-state="rail"\]\[data-explorer-focus="lora"\][\s\S]*?clamp\(520px, 43vw, 620px\) minmax\(320px, 1fr\) 72px/);
  assert.match(styles, /data-explorer-focus="lora"[\s\S]*?repeat\(auto-fit, minmax\(170px, 1fr\)\)/);
  // 收放按钮豁免于收起态的 display:none，否则收起后没有把手能展开回来。
  assert.match(styles, /pro-inspector > :not\(\.pro-inspector-tabs, \.pro-inspector-collapse\)/);
  assert.match(styles, /data-inspector-state="rail"[\s\S]*?pro-inspector-tab-label,[\s\S]*?display: none/);
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*?\.pro-app-shell \.pro-studio-body\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
});

test("mobile model picker uses one viewport-bounded flat list", () => {
  const source = readCode("src/components/ModelPicker.tsx");

  assert.match(source, /data-model-picker-mobile/);
  assert.match(source, /data-model-picker-mobile-vendor/);
  assert.match(source, /w-\[calc\(100vw-1\.5rem\)\] max-w-\[22rem\] overflow-x-hidden/);
  assert.match(source, /min-w-0 flex-1 truncate font-medium/);
  assert.match(source, /lg:hidden/);
  assert.match(source, /hidden lg:block/);
});

test("reference assets can import saved folder images without duplicates", () => {
  const source = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");

  assert.match(source, /从文件夹导入/);
  assert.match(source, /handleImportShotAsReference/);
  assert.match(source, /getShotBlob\(shot\.id\)/);
  assert.match(source, /const referenceId = `shot-\$\{shot\.id\}`/);
  assert.match(source, /referenceImages\.length >= MAX_REFERENCE_IMAGES/);
  assert.match(source, /这张图片已经在参考图中/);
});

test("all guided tours support desktop A and D navigation", () => {
  const modelPicker = read("src/components/ModelPicker.tsx");
  const workstation = read("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const keyboard = read("src/lib/tour-keyboard.ts");

  assert.equal((modelPicker.match(/bindDesktopTourKeyboard\(tour\)/g) ?? []).length, 1);
  assert.equal((workstation.match(/bindDesktopTourKeyboard\(tour\)/g) ?? []).length, 2);
  assert.match(keyboard, /\(min-width: 1024px\)/);
  assert.match(keyboard, /key !== "a" && key !== "d"/);
  assert.match(keyboard, /input, textarea, select/);
  assert.match(modelPicker, /DESKTOP_TOUR_KEY_HINT/);
  assert.match(modelPicker, /popover\.description\.appendChild\(keyboardHint\)/);
  assert.equal((workstation.match(/DESKTOP_TOUR_KEY_HINT/g) ?? []).length, 3);
});

/**
 * 写提示词 → 选模型 → 生成，三件事必须在同一列视线里。
 *
 * 这是用户原话「打提示词和生图的区域和牛郎织女一样远，打提示词和选模型区域不同」
 * 对应的结构约束：ModelPicker 常驻左栏顶部而不是藏在第三个 tab 的手风琴里，
 * 运行条吸底在左栏内。任何把它们重新拆开的改动都应该让这条测试红掉。
 */
test("prompt, model and run controls stay in one column of sight", () => {
  const workstation = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");

  assert.match(workstation, /className="pro-model-row" id="pro-tour-model"/);
  assert.match(workstation, /<div className="pro-model-row"[\s\S]{0,400}?<ModelPicker/);
  assert.match(workstation, /className="pro-run-bar"/);
  // 三者同属左栏且顺序为 模型 → 提示词 → 运行条。把任何一个搬去别的栏/别的 tab
  // 都会让这条红掉 —— 这正是「打提示词和生图像牛郎织女」的那个问题。
  assert.match(
    workstation,
    /className="pro-left-panel[\s\S]*?pro-model-row[\s\S]*?id="pro-prompt-input"[\s\S]*?className="pro-run-bar"[\s\S]*?<\/aside>/,
  );
  // 参数 tab 里不该再出现第二个 ModelPicker：两个实例共用 modelMenuOpen 会互相打开。
  assert.equal((workstation.match(/<ModelPicker/g) ?? []).length, 1);
});

test("panel resize handles are keyboard operable and resettable", () => {
  const workstation = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");

  assert.equal((workstation.match(/role="separator"/g) ?? []).length, 2);
  assert.match(workstation, /aria-orientation="vertical"/);
  assert.match(workstation, /aria-valuenow=\{panelWidths\.(left|right)\}/);
  assert.match(workstation, /const nudgePanel = useEventCallback/);
  assert.match(workstation, /const resetPanel = useEventCallback/);
  assert.match(workstation, /const handleResizeKeyDown = useEventCallback/);
  assert.match(workstation, /event\.shiftKey \? 96 : 24/);
  assert.match(workstation, /onDoubleClick=\{\(\) => resetPanel\("(left|right)"\)\}/);
});

test("annotations survive layout changes and support brush sizes with undo", () => {
  const workstation = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const styles = read("src/components/pro-workstation/workstation.css");
  const commands = read("src/lib/workstation-commands.ts");

  assert.match(workstation, /const BRUSH_SIZES/);
  assert.match(workstation, /const repaintAnnotations = /);
  assert.match(workstation, /const undoAnnotation = useEventCallback/);
  assert.match(workstation, /strokesRef\.current\.slice\(0, -1\)/);
  // 重绘按 canvas 宽度比例换算，面板拖宽后旧笔迹不会错位或被清空。
  assert.match(workstation, /canvas\.width \/ stroke\.canvasWidth/);
  assert.match(styles, /\.pro-brush-strip/);
  assert.match(commands, /"undo_annotation"/);
  // 输入框里的 Ctrl+Z 必须留给原生文本撤销。
  assert.match(commands, /key === "z"[\s\S]{0,120}?!input\.editable/);
  // 快捷键必须有对应的执行分支，否则按下去 preventDefault 生效、功能却什么都不做。
  assert.match(workstation, /commandId === "undo_annotation"/);
  assert.match(workstation, /commandId === "download_result"/);
});

test("actual-size canvas is a real zoom and pan viewer", () => {
  const workstation = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const styles = read("src/components/pro-workstation/workstation.css");

  assert.match(workstation, /const zoomAtPointer = useEventCallback/);
  assert.match(workstation, /Math\.min\(8, Math\.max\(0\.25, zoomScale \* factor\)\)/);
  // React 的 onWheel 是被动监听，preventDefault 会被忽略，必须手动注册。
  assert.match(workstation, /addEventListener\("wheel", onWheel, \{ passive: false \}\)/);
  assert.match(workstation, /data-panning=\{isPanning \? "true" : undefined\}/);
  assert.match(workstation, /onDoubleClick=\{resetZoom\}/);
  assert.match(styles, /\.pro-canvas-actual\[data-panning="true"\]\s*\{[\s\S]*?cursor: grabbing/);
});

test("generation shows progress and ETA instead of a bare spinner", () => {
  const workstation = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const styles = read("src/components/pro-workstation/workstation.css");

  assert.match(workstation, /const runProgress = /);
  assert.match(workstation, /const runEtaLabel = /);
  assert.match(workstation, /setRunStartedAt\(Date\.now\(\)\)/);
  assert.match(workstation, /role="progressbar"/);
  assert.match(workstation, /pro-canvas-skeleton/);
  assert.match(workstation, /已落地/);
  assert.match(styles, /\.pro-run-progress-track/);
  assert.match(styles, /\.pro-mobile-progress/);
});

test("failed queue rows retry individually", () => {
  const workstation = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const styles = read("src/components/pro-workstation/workstation.css");

  assert.match(workstation, /const retrySlot = useEventCallback/);
  assert.match(workstation, /onRetry=\{retrySlot\}/);
  assert.match(workstation, /className="pro-slot-retry"/);
  // 重试钮必须是行按钮的兄弟节点：嵌套 <button> 会被浏览器拆开。
  assert.match(workstation, /className="pro-slot-item"[\s\S]*?className="pro-slot-row"/);
  assert.match(styles, /\.pro-slot-retry/);
});

test("both tablists follow the roving tabindex pattern", () => {
  const workstation = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");

  assert.equal((workstation.match(/role="tabpanel"/g) ?? []).length, 6);
  assert.match(workstation, /aria-controls=\{`pro-left-panel-\$\{tab\.id\}`\}/);
  assert.match(workstation, /tabIndex=\{leftPanelTab === tab\.id \? 0 : -1\}/);
  assert.match(workstation, /aria-controls=\{`pro-inspector-panel-\$\{tab\.id\}`\}/);
  assert.match(workstation, /tabIndex=\{inspectorTab === tab\.id \? 0 : -1\}/);
  assert.match(workstation, /aria-labelledby="pro-left-tab-/);
  assert.match(workstation, /aria-labelledby="pro-inspector-tab-/);
});

test("canvas never silently implies the image matches current settings", () => {
  const workstation = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const styles = read("src/components/pro-workstation/workstation.css");

  assert.match(workstation, /const staleConfigFields: string\[\] = \[\]/);
  assert.match(workstation, /这张图不是当前设置的结果/);
  assert.match(workstation, /const restoreVisibleResultConfig = /);
  assert.match(workstation, /改回这张图的设置/);
  assert.match(styles, /\.pro-canvas-stale/);
  // 漂移提示不能挂在默认半透明的信息条里。
  assert.doesNotMatch(styles, /\.pro-canvas-stale\s*\{[^}]*opacity: 0\.32/);
});

test("canvas keeps the rest of the batch one click away", () => {
  const workstation = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const styles = read("src/components/pro-workstation/workstation.css");

  assert.match(workstation, /className="pro-film-strip" role="listbox"/);
  assert.match(workstation, /workspaceMode === "canvas" && viewableResults\.length > 1/);
  assert.match(workstation, /aria-selected=\{index === visibleResultIndex\}/);
  assert.match(styles, /\.pro-film-strip/);
  // 缩略条占独立一行，不能盖在画布上。
  assert.match(styles, /\.pro-canvas-stage\s*\{[\s\S]*?grid-template-rows: auto minmax\(240px, 1fr\) auto auto/);
});

test("video results and dropped selections do not desync the queue", () => {
  const workstation = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");

  // 本地槽位判定必须算上 videoUrl，否则影片生成成功却显示失败。
  assert.match(workstation, /hasResult = !!\(image\?\.image \|\| image\?\.imageUrl \|\| image\?\.videoUrl\)/);
  // selectedSlotId 指向已被挤掉的结果时要收敛到实际显示的那张。
  assert.match(workstation, /setSelectedSlotId\(fallback \? \(fallback\.resultId \?\? fallback\.slotId \?\? null\) : null\)/);
  // 不能把 resultKey 放进依赖数组：它每次渲染都是新函数，会让这个效应每帧都跑。
  assert.match(workstation, /\}, \[selectedSlotId, viewableResults\]\)/);
});

test("destructive model switches and dead history actions are handled", () => {
  const workstation = readCode("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");

  assert.match(workstation, /const handleWorkstationModelChange = useEventCallback/);
  assert.match(workstation, /onUseAsReference=\{useHistoryEntryAsReference\}/);
  assert.match(workstation, /const useHistoryEntryAsReference = useEventCallback/);
  // 手风琴开合状态要跨 tab 切换与刷新留存。
  assert.match(workstation, /open=\{sectionOpen/);
  assert.match(workstation, /const toggleSection = /);
  // 顶栏计数是可点的按钮，不是死文字。
  assert.match(workstation, /executeCommand\("open_gallery"\)/);
  assert.match(workstation, /executeCommand\("open_queue"\)/);
});

test("downloaded PNG embeds the workflow and re-import restores it", () => {
  const source = read("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");
  const upload = read("src/components/ReferenceImageUpload.tsx");
  const pngLib = read("src/lib/workflow-png.ts");

  // 纯函数契约：嵌入与提取必须在同一 lib 里成对存在。
  assert.match(pngLib, /export function embedWorkflowIntoPng/);
  assert.match(pngLib, /export function extractWorkflowFromPng/);
  assert.match(pngLib, /WORKFLOW_PNG_MAGIC/);
  assert.match(pngLib, /WORKFLOW_PNG_VERSION/);

  // 下载侧：工作台下载成片时把这张成片的工作流嵌入 PNG 檔尾。
  assert.match(source, /import \{ embedWorkflowIntoPng \} from "@\/lib\/workflow-png"/);
  assert.match(source, /buildProvenanceConfig\(image\)/);
  assert.match(source, /embedWorkflowIntoPng\(/);
  assert.match(source, /已复制这张成片的配置/);

  // 还原侧：拖入/选中的 PNG 若内嵌工作流，由 ReferenceImageUpload 探测并交给工作台回填。
  assert.match(upload, /onWorkflowDetected\?:/);
  assert.match(upload, /extractWorkflowFromPng\(new Uint8Array\(await file\.arrayBuffer\(\)\)\)/);
  assert.match(source, /onWorkflowDetected=\{restoreProvenanceConfigFromPng\}/);
  assert.match(source, /const restoreProvenanceConfigFromPng = useEventCallback/);
  assert.match(source, /applyWorkflowRecallConfig/);
  // 还原沿用 workflow-recall 的解析路径，并补回嵌入时写下的模型。
  assert.match(source, /parseWorkflowRecallConfig\(workflowJson\)/);
  assert.match(source, /onModelChange\(embeddedModelId\)/);
  assert.match(source, /已还原 PNG 内嵌的工作流/);
});
