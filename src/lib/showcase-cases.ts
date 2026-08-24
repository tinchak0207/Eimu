import type { StylePreset } from "@/lib/prompt-enhancer";
import type { WorkflowRecallConfig } from "@/lib/workflow-recall";

/**
 * 案例配方（契约扩展点，2026-08-25 配方资产总线）。
 *
 * 结构与工作站 buildProvenanceConfig 的输出同构：以 workflow-recall 的
 * WorkflowRecallConfig（六槽 prompt / negative / 尺寸 / preset / 区域 prompt /
 * seed 等既有字段）为基底，加法式补上快照里本来就有的模型与版本字段。
 * 「用此工作流打开」直接 JSON.stringify 后走 parseWorkflowRecallConfig 的
 * 同一条载入管线（与 PNG 内嵌工作流 / R 键一致），不另起 schema。
 */
export interface ShowcaseRecipe extends WorkflowRecallConfig {
  schemaVersion?: number;
  modelId?: string;
  workflowPresetLabel?: string;
  promptHint?: string;
  negativeHint?: string;
}

export interface ShowcaseCase {
  id: string;
  title: string;
  category: string;
  style: StylePreset;
  prompt: string;
  resultNote: string;
  gradient: string;
  image?: string;
  /** 该案例在转盘上居中时，舞台背后那层环境光的主色（hex）。取自 gradient 里
      最饱和的那一档 —— 转到谁，背景就被谁染一下，像 Apple TV 的海报底光。 */
  glow: string;
  /** 案例来源：官方精选（缺省）或用户从历史发布（community）。 */
  source?: "official" | "community";
  /** 完整配方快照。缺失时案例优雅降级为纯展示（不出现「用此工作流打开」）。 */
  recipe?: ShowcaseRecipe;
}

const GPT_IMAGE_MODEL = "gpt-image-2";

export const SHOWCASE_CASES: ShowcaseCase[] = [
  {
    id: "global-skincare-branding",
    title: "当下审美，此刻同步。",
    category: "品牌营销",
    style: "product",
    prompt: "参考 2026 年夏季 Instagram 上最流行的极简主义护肤品拍摄风格，为这款精华液生成一张广告图。要有流动的液体质感、柔和的自然光，以及符合当下潮流的莫兰迪配色。",
    resultNote: "实时参考最新视觉趋势，让每一张护肤大片，\n都拥有恰到好处的当代感。",
    gradient: "from-[#F5F5F5] via-[#E0E0E0] to-[#CFD8DC]",
    image: "/showcase/showcase1.webp",
    glow: "#8FA9B8",
    recipe: {
      schemaVersion: 2,
      modelId: GPT_IMAGE_MODEL,
      workflowPreset: "product-shot",
      workflowPresetLabel: "商品主图",
      productionIntent: "campaign",
      imageSizes: ["1024x1024"],
      qualityProfile: "balanced",
      negativePrompt: "塑料质感，杂乱反光，配色过饱和，水印",
      copies: 1,
    },
  },
  {
    id: "readable-craft-beer-label",
    title: "每一个字，都清清楚楚。",
    category: "包装设计",
    style: "product",
    prompt: "一瓶放在潮湿木质吧台上的精酿啤酒，标签上清晰显示：‘Midnight Forest’，下方小字标注‘IPA - 6.5% ALC’。要有冰镇的冷凝水珠和电影感的侧光。",
    resultNote: "从品牌名称到成分信息，文字准确呈现。\n看见的，就是可以继续设计的。",
    gradient: "from-[#1B1B1B] via-[#3A3A3A] to-[#2E7D32]",
    image: "/showcase/showcase2.webp",
    glow: "#2E7D32",
    recipe: {
      schemaVersion: 2,
      modelId: GPT_IMAGE_MODEL,
      workflowPreset: "product-shot",
      workflowPresetLabel: "商品主图",
      productionIntent: "ecommerce",
      imageSizes: ["1024x1024"],
      qualityProfile: "print",
      negativePrompt: "标签文字扭曲，拼写错误，水印，模糊",
      copies: 1,
    },
  },
  {
    id: "tech-event-poster-dual-lang",
    title: "两种语言，一套好版式。",
    category: "活动视觉",
    style: "poster",
    prompt: "2026 科技创新峰会海报。背景是半透明的量子计算网格，中央文字：‘The Future is Now / 未来已来’。字体要求现代感、高对比度，有足够的留白区域。",
    resultNote: "中英文自然共存，层级、间距与节奏一次到位。\n活动主视觉，从第一版就足够完整。",
    gradient: "from-[#000428] via-[#004e92] to-[#00d2ff]",
    image: "/showcase/showcase3.webp",
    glow: "#0A84FF",
    recipe: {
      schemaVersion: 2,
      modelId: GPT_IMAGE_MODEL,
      workflowPreset: "poster-variants",
      workflowPresetLabel: "版式参考",
      productionIntent: "campaign",
      imageSizes: ["1024x1536"],
      qualityProfile: "balanced",
      negativePrompt: "文字乱码，构图拥挤，层级混乱，低对比",
      copies: 1,
    },
  },
  {
    id: "cinematic-steampunk-train",
    title: "复杂空间，也有秩序。",
    category: "概念设计",
    style: "poster",
    prompt: "一个巨大的维多利亚风格火车站，一辆蒸汽火车正破雾驶来。复杂的钢结构穹顶透视要完全准确，阳光透过彩色玻璃窗斜射下来，形成清晰的丁达尔光瀑，地面的积水倒影出火车头的金属细节。",
    resultNote: "宏大的建筑、交错的结构与层叠的光线，\n都被准确安放在同一个空间里。",
    gradient: "from-[#1a1c23] via-[#8B7355] to-[#EEDC82]",
    image: "/showcase/showcase4.webp",
    glow: "#C68B3C",
    recipe: {
      schemaVersion: 2,
      modelId: GPT_IMAGE_MODEL,
      workflowPreset: "poster-variants",
      workflowPresetLabel: "版式参考",
      productionIntent: "general",
      imageSizes: ["1536x1024"],
      qualityProfile: "balanced",
      negativePrompt: "透视错误，结构崩坏，光线方向矛盾",
      copies: 1,
    },
  },
  {
    id: "interior-trend-lookup",
    title: "先看见，再决定。",
    category: "室内设计",
    style: "product",
    prompt: "根据 2026 年米兰家具展最新的‘静谧主义’（Quiet Luxury）室内设计趋势，生成一个光影斑驳的客厅。要有侘寂风的纹理质感，家具比例要严格符合人体工学。",
    resultNote: "从空间比例到材质氛围，快速呈现完整构想。\n让灵感在落地之前，先成为画面。",
    gradient: "from-[#EADEDB] via-[#BC948B] to-[#8E5E53]",
    image: "/showcase/showcase5.webp",
    glow: "#B98A7C",
    recipe: {
      schemaVersion: 2,
      modelId: GPT_IMAGE_MODEL,
      workflowPreset: "product-shot",
      workflowPresetLabel: "商品主图",
      productionIntent: "general",
      imageSizes: ["1536x1024"],
      qualityProfile: "balanced",
      negativePrompt: "比例失真，材质廉价，光线平淡",
      copies: 1,
    },
  },
  {
    id: "streetwear-drop-teaser",
    title: "像胶片。更像你的品牌。",
    category: "社媒运营",
    style: "street",
    prompt: "模拟徕卡 M11 的直出色彩，拍摄一张街头卫衣特写。要有浓郁的胶片颗粒感，模特在过马路时的动态模糊，背景是东京涩谷的雨夜霓虹。",
    resultNote: "自然颗粒、真实光感与随手拍般的松弛质感，\n为新品带来更有温度的第一印象。",
    gradient: "from-[#833ab4] via-[#fd1d1d] to-[#fcb045]",
    image: "/showcase/showcase6.webp",
    glow: "#C0399B",
    recipe: {
      schemaVersion: 2,
      modelId: GPT_IMAGE_MODEL,
      workflowPreset: "style-transfer",
      workflowPresetLabel: "风格参考",
      productionIntent: "social",
      imageSizes: ["1024x1536"],
      qualityProfile: "balanced",
      negativePrompt: "数码平滑，过度锐化，色彩断层",
      copies: 1,
    },
  },
];
