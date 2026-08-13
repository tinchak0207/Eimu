import { useCallback, useRef } from "react";
import type { ReferenceImageRole } from "@/lib/image-types";
import { adSizeOptionsForRatios, type AdSizeOption } from "@/lib/ad-formats";
import { generationCapabilities } from "@/lib/generation-model-catalog";
import { imageGenerationCoins } from "@/lib/provider-config";
import { WORKSTATION_SOURCES } from "./workstation-sources";

export const INVOKE_AI_WORKSTATION_SOURCE = {
  ...WORKSTATION_SOURCES[0],
  patterns: WORKSTATION_SOURCES[0].capabilities,
};

export interface WorkstationPreset {
  id: string;
  label: string;
  note: string;
  promptHint: string;
  negativeHint: string;
  defaultRole: ReferenceImageRole;
  estimatedCredits: number;
}

export type WorkspaceMode = "canvas" | "viewer";
export type MobilePanel = "create" | "settings" | "canvas" | "output";
export type LeftPanelTab = "prompt" | "assets" | "settings";
export type InspectorTab = "queue" | "gallery" | "history";
export type CanvasTool = "select" | "annotate" | "erase";
export type GalleryMode = "images" | "assets" | "boards";
export type SlotState = "done" | "failed" | "running" | "queued" | "idle";

export interface RegionalPromptItem {
  id: string;
  text: string;
  enabled: boolean;
}

export interface TemplateStateSnapshot {
  modelId: string;
  prompt: string;
  contextPrompt: string;
  negativePrompt: string;
  workflowPreset: string;
  productionIntent: string;
  imageSizes: string[];
  qualityProfile: string;
  copies: number;
  styleTemplateId: string | null;
  styleCategory: string;
  scenarioId: string | null;
}

export const WORKFLOW_PRESETS: WorkstationPreset[] = [
  {
    id: "product-shot",
    label: "商品主图",
    note: "产品清晰、标签可读、背景干净",
    promptHint: "高端电商商品主图，干净棚拍布光，包装文字清晰可读，真实阴影，背景简洁",
    negativeHint: "标签扭曲，商标破损，水印，低清晰度，背景杂乱",
    defaultRole: "product",
    estimatedCredits: 2,
  },
  {
    id: "character-consistency",
    label: "人物一致",
    note: "保留人物身份、服装和面部特征",
    promptHint: "保持同一角色身份，同一面部结构，同一服装细节，影视级静帧质感",
    negativeHint: "面部漂移，眼睛不对称，服装变化，多余手指，塑料皮肤",
    defaultRole: "character",
    estimatedCredits: 3,
  },
  {
    id: "poster-variants",
    label: "版式参考",
    note: "适合批量出封面、banner 和社媒图",
    promptHint: "活动主视觉，焦点明确，留有干净文案空间，高级版式，适合批量扩展变体",
    negativeHint: "构图拥挤，文字不可读，层级混乱，对比浑浊",
    defaultRole: "composition",
    estimatedCredits: 4,
  },
  {
    id: "style-transfer",
    label: "风格参考",
    note: "把参考图风格转移到新构图",
    promptHint: "保留参考图的风格语言、色彩分级、光影节奏和材质纹理",
    negativeHint: "风格不一致，纹理过度处理，低保真，噪点伪影",
    defaultRole: "style",
    estimatedCredits: 2,
  },
];

export const REFERENCE_IMAGE_ROLES: Array<{ id: ReferenceImageRole; label: string }> = [
  { id: "general", label: "通用" },
  { id: "style", label: "风格" },
  { id: "character", label: "角色" },
  { id: "composition", label: "构图" },
  { id: "product", label: "产品" },
  { id: "face", label: "脸部" },
];

/**
 * 质量档位按模型能力与真实价格生成。
 *
 * 旧版是三个硬编码档位（草稿 / 均衡 / 印刷高清 · 2 币/张），其中：
 * - draft 与 balanced 在所有消费点都走 `qualityProfile === "print" ? "quality" : "fast"`
 *   同一分支，同解析度同价格 —— 三选一里有两个是空选项；
 * - 「2 币/张」写死在文案里，对 Nano Banana Pro（4 币）、PixAI（3 币）都是错的；
 * - PixAI 全系 `resolutions: ["1k"]`，投影出的 qualityModes 只有 ["fast"]，
 *   「印刷高清」在这些模型下既拿不到 2K 也不是 2 币，却仍然可选。
 * 现在只暴露模型真的支持的档位，价格现算。
 */
export function qualityProfileOptions(modelId: string) {
  const modes = generationCapabilities(modelId)?.qualityModes ?? ["fast"];
  const options = [
    { id: "balanced", label: `标准 1K · ${imageGenerationCoins(modelId, "fast")} 币/张` },
  ];
  if (modes.includes("quality")) {
    options.push({ id: "print", label: `高清 2K · ${imageGenerationCoins(modelId, "quality")} 币/张` });
  }
  return options;
}

/**
 * 版位列表 = 模型能力表里的比例集合。
 *
 * ad-formats.ts 刻意不 import 模型目录（保持纯数据、可单测），所以这里做模型 → 比例
 * 的桥接：以前专业模式硬编码 3 个版位，支持 14 种比例的模型在专业模式反而比普通模式少。
 */
export function adSizeOptionsForModel(modelId: string): AdSizeOption[] {
  return adSizeOptionsForRatios(generationCapabilities(modelId)?.aspectRatios);
}

/** 服务端 errorCode / errorMessage 翻成可行动的人话，并指出下一步该做什么。 */
export function failureHint(task?: { errorCode?: string; errorMessage?: string }): string {
  const raw = `${task?.errorCode ?? ""} ${task?.errorMessage ?? ""}`.toLowerCase();
  if (!raw.trim()) return "失败原因未回传，可直接重试";
  if (/moderat|safety|content_policy|审核|违规/.test(raw)) return "内容审核未通过 · 请改写提示词";
  if (/quota|insufficient|balance|余额|额度/.test(raw)) return "额度不足 · 请充值后重试";
  if (/timeout|timed out|超时/.test(raw)) return "模型超时 · 直接重试通常可成功";
  if (/rate|429|too many/.test(raw)) return "请求过于频繁 · 稍后重试";
  if (/network|econn|fetch failed|502|503|504/.test(raw)) return "上游网络故障 · 稍后重试";
  return task?.errorMessage?.slice(0, 60) || "生成失败，可直接重试";
}

export const PRODUCTION_INTENT_OPTIONS = [
  { id: "general", label: "通用" },
  { id: "ecommerce", label: "电商" },
  { id: "campaign", label: "活动" },
  { id: "character", label: "角色" },
  { id: "social", label: "社媒" },
];

export const WORKSPACE_MODES: Array<{ id: WorkspaceMode; label: string; title: string }> = [
  { id: "canvas", label: "画布", title: "画布" },
  { id: "viewer", label: "成片墙", title: "成片墙" },
];

export const MOBILE_PANELS: Array<{ id: MobilePanel; label: string }> = [
  { id: "create", label: "创作" },
  { id: "settings", label: "参数" },
  { id: "canvas", label: "画布" },
  { id: "output", label: "产出" },
];

export const CANVAS_TOOLS: Array<{ id: CanvasTool; label: string; hint: string }> = [
  { id: "select", label: "选择", hint: "选择成片或调整画布。" },
  { id: "annotate", label: "标注笔", hint: "在图上圈出要修改的区域。" },
  { id: "erase", label: "擦除", hint: "擦掉画错的标注。" },
];

/** 笔粗三档。旧版写死 6px：圈一只眼睛太粗，圈整个背景太细。 */
/** dot 是选择器上那颗圆点的直径，只用于视觉示意，不等于实际笔宽。 */
export const BRUSH_SIZES: Array<{ value: number; label: string; dot: number }> = [
  { value: 2, label: "细", dot: 4 },
  { value: 6, label: "中", dot: 8 },
  { value: 16, label: "粗", dot: 13 },
];

/**
 * 左栏三步：写什么 → 给什么参考 → 怎么出。
 * 一次加过第四个「模板」tab，但模板本身只是提示词的一种写法，
 * 不是独立的一步；它现在是「提示词」里的一节手风琴。
 */
export const LEFT_PANEL_TABS: Array<{ id: LeftPanelTab; label: string; hint: string }> = [
  { id: "prompt", label: "提示词", hint: "描述画面，选择模板和风格。" },
  { id: "assets", label: "参考图", hint: "添加产品、人物或风格参考。" },
  { id: "settings", label: "参数", hint: "设置模型、尺寸、数量和高级参数。" },
];

/** 存过的 tab id 可能是已经删掉的那个，读回来要先过滤，否则左栏整片空白。 */
export function normalizeLeftPanelTab(value: unknown): LeftPanelTab | undefined {
  return LEFT_PANEL_TABS.some((tab) => tab.id === value) ? (value as LeftPanelTab) : undefined;
}

export const INSPECTOR_TABS: Array<{ id: InspectorTab; label: string; hint: string }> = [
  { id: "queue", label: "队列", hint: "查看生成进度，失败任务可重试。" },
  { id: "gallery", label: "图库", hint: "查看成片、参考图和文件夹。" },
  { id: "history", label: "历史", hint: "恢复最近用过的设置。" },
];

export const SLOT_STATE_LABELS: Record<SlotState, string> = {
  done: "已完成",
  failed: "失败",
  running: "进行中",
  queued: "排队中",
  idle: "待生成",
};

export const TOUR_STORAGE_KEY = "pro-workstation-tour-v2";
export const LORA_TOUR_STORAGE_KEY = "pro-lora-tour-v1";
export const LORA_TOUR_STEP_COUNT = 5;
export const ANNOTATION_CONTEXT_NOTE = "红色标注区域为需要重点修改的位置";
/** 布局偏好（分栏宽度、当前 tab、手风琴开合）。专业工具的用户有固定习惯，不该每次重建工作环境。 */
export const LAYOUT_PREFS_KEY = "pro-layout-prefs-v1";
/** 提示词草稿。刷新 / 误关页面 / 切模式都不该丢掉用户投入最多心力的产物。 */
export const DRAFT_STORAGE_KEY = "pro-draft-v1";

export interface LayoutPrefs {
  left?: number;
  right?: number;
  leftTab?: LeftPanelTab;
  inspectorTab?: InspectorTab;
  sections?: Record<string, boolean>;
}

export function readLayoutPrefs(): LayoutPrefs {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(LAYOUT_PREFS_KEY) ?? "{}") as LayoutPrefs;
  } catch {
    return {};
  }
}

export function writeLayoutPrefs(prefs: LayoutPrefs) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAYOUT_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 隐私模式下 localStorage 会抛，偏好丢失不影响主流程 */
  }
}

export interface PromptDraft {
  prompt?: string;
  contextPrompt?: string;
  negativePrompt?: string;
}

export function readPromptDraft(): PromptDraft {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.sessionStorage.getItem(DRAFT_STORAGE_KEY) ?? "{}") as PromptDraft;
  } catch {
    return {};
  }
}

export function writePromptDraft(draft: PromptDraft) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    /* 同上 */
  }
}

/**
 * 手风琴默认开合。旧版 8 个 details 硬编码 open，左栏一进站就是 950px+ 的滚动。
 *
 * 这里是唯一真相：sectionOpen 的初始值直接铺开它，不要再内联第二份 —— 之前两份
 * 各写一遍，这份的键还停在改名前的 `requirements`（实际已是 `more`），
 * 等于一份没人用的过期副本。
 */
export const DEFAULT_SECTION_OPEN: Record<string, boolean> = {
  resources: false,
  style: false,
  more: false,
  size: true,
  count: false,
  queue: true,
  gallery: true,
  history: true,
  recall: false,
  presets: false,
};

/**
 * 通知分级。
 *
 * 旧版 canvasNotice 是一个被 25 处以上共用的裸字符串，且永不清除：半小时前
 * 「已存入『预设』」还挂在标题栏，用户无法分辨新旧；成功、警告、失败三种语意
 * 共用同一个蓝色小胶囊，「标注保存失败」和「已复制配置」长得一模一样。
 */
export type NoticeLevel = "info" | "warn" | "error";
export interface CanvasNotice {
  text: string;
  level: NoticeLevel;
  /** 单调递增，用于让相同文案的连续两次通知也能重新触发自动清除计时。 */
  seq: number;
}

/**
 * 一笔标注。
 *
 * 旧版直接往 canvas 位图上画，于是：改栏宽 / 切「原图大小」都会让 canvas
 * 重新分配尺寸（`canvas.width = n` 即清空位图），用户圈好的三处要求无声蒸发；
 * 画错一笔的唯一低成本选项是整片清空。存成笔画数组后两者都能解决：尺寸变化
 * 按比例重绘，撤销只丢最后一笔。
 */
export interface AnnotationStroke {
  points: Array<{ x: number; y: number }>;
  width: number;
  mode: "draw" | "erase";
  /** 记录落笔时的画布尺寸，尺寸变化时按比例映射。 */
  canvasWidth: number;
  canvasHeight: number;
}

/** 始终调用最新闭包但保持引用稳定的事件回调（React.memo 子组件依赖此特性） */
export function useEventCallback<Args extends unknown[], Result>(fn: (...args: Args) => Result) {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: Args) => ref.current(...args), []);
}

/** 轮询等待选择器匹配的元素出现，超时也返回（调用方靠 fallback 锚点兜底）。 */
export function waitForSelector(selector: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (document.querySelector(selector)) return resolve();
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (document.querySelector(selector) || Date.now() - startedAt > timeoutMs) {
        window.clearInterval(timer);
        resolve();
      }
    }, 100);
  });
}

/** 14 个场景加 32 个模型配方。测试会和两份数据源校验，避免标题数字漂移。 */
export const CREATIVE_TEMPLATE_COUNT = 46;
