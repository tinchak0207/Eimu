export type MediaKind = "image" | "video" | "audio";

/**
 * 影片生成型別（P1-3 生成式後期；值逐字對齊上游 `AvailableGenerationType` 的
 * `extend_video`／`edit_video`，`generate` 為我方代表普通生成的基準值）。
 * 這是「模型能做什麼」的能力宣告欄位真源——缺省＝只支援 `generate`，
 * **不推導不升格**（見 generation-core/video-post-production.ts 檔頭）。
 */
export type VideoGenerationType = "generate" | "extend_video" | "edit_video";
/**
 * 超分檔位（P1-4／對稱差 D10「一鍵超分到 4K」）。值與 `ImageResolution` 同形，
 * 但語義不同：這是**超分產品線的目標檔位**（長邊門檻 1k=1024／2k=2048／4k=3840）。
 * 真源＝`generation-core/upscale-tier.ts` 的 `UPSCALE_TIER_CONTRACTS`（含每個檔位送
 * bridge 的 `(size, factor)` 與由真實比例表算出的長邊保證）；本欄位只做**能力宣告**，
 * 缺省＝該模型不支援超分。宣告 4K ≠ 一定能出 4K：4K 的上游 factor 語義未校準，
 * 提交端 fail-closed（`upscale_4k_upstream_unverified`），`/v1/models` 只外露可提交檔位。
 */
export type UpscaleTier = "1k" | "2k" | "4k";
export type AspectRatio =
  | "1:1"
  | "1:8"
  | "1:4"
  | "5:4"
  | "9:16"
  | "9:21"
  | "21:9"
  | "4:1"
  | "16:9"
  | "4:3"
  | "3:2"
  | "4:5"
  | "3:4"
  | "8:1"
  | "2:3";
/**
 * AspectRatio 的运行时清单（与上方 union 一一对应）。union 是编译期形状，这份是
 * 运行时枚举的 owner——API 校验、生成品质门一律引用这里，不另立第二套枚举。
 */
export const ASPECT_RATIO_VALUES = [
  "1:1",
  "1:8",
  "1:4",
  "5:4",
  "9:16",
  "9:21",
  "21:9",
  "4:1",
  "16:9",
  "4:3",
  "3:2",
  "4:5",
  "3:4",
  "8:1",
  "2:3",
] as const satisfies readonly AspectRatio[];
export type ImageResolution = "1k" | "2k" | "4k";
export type VideoResolution = "360p" | "480p" | "540p" | "720p" | "1080p" | "4k";
export type OutputResolution = ImageResolution | VideoResolution;

export type ImageCreditTable = Partial<Record<ImageResolution, number>>;
export type VideoCreditTable = Partial<Record<VideoResolution, number>>;

/**
 * 定價精度單點（幣單位的小數位數）。全站定價的舍入/下限/顯示/輸入 step 都由
 * 以下三個常數派生——改大即支援更細定價（如 5 = 0.00001 幣，限免場景），
 * 不需要改任何其他檔案。credit 是幣 × 10 的內部單位，精度多一位小數。
 */
export const PRICING_DECIMALS = 5;
export const PRICING_COIN_STEP = 1 / 10 ** PRICING_DECIMALS;
export const PRICING_CREDIT_STEP = PRICING_COIN_STEP * 10;

/** 模型卡「一键带入」建议参数：只描述生成表单已有的字段，消费端挂既有表单填充路径。 */
export interface ModelUsageTipParams {
  aspectRatio?: AspectRatio;
  outputResolution?: OutputResolution;
  durationSeconds?: number;
  generateAudio?: boolean;
}

/** 一条模型使用建议；带 params 时模型卡会渲染「一键带入」动作。 */
export interface ModelUsageTip {
  text: string;
  params?: ModelUsageTipParams;
}

/**
 * 模型卡三字段（吞併決策清單主線四首件）：擅长 / 已知缺陷 / 建议。
 * 全部可选——缺值时模型卡优雅降级，不出现空区块。内容必须可溯源
 * （reddit-use-cases 语料 / 实测指南 / 可靠公开结论），宁缺勿滥。
 */
export interface ModelKnowledge {
  strengths?: readonly string[];
  knownDefects?: readonly string[];
  usageTips?: readonly ModelUsageTip[];
}

export interface GenerationModelDefinition {
  id: string;
  displayName: string;
  kind: MediaKind;
  popularity: number;
  /** 模型所屬廠商/平台，模型選單的一級目錄按此分組。 */
  vendor: string;
  /** AV 成片鏈路的提交端點與能力探測路由鍵（tts/avatar/lipsync）；一般模型無此欄位。 */
  pipeline?: "tts" | "avatar" | "lipsync";
  /** 模型卡三字段（擅长/已知缺陷/建议）。可选——无数据的模型不渲染能力卡。 */
  knowledge?: ModelKnowledge;
  promotionTag?: string;
  aspectRatios: readonly AspectRatio[];
  resolutions: readonly OutputResolution[];
  defaultAspectRatio: AspectRatio;
  defaultResolution: OutputResolution;
  durations?: readonly number[];
  defaultDuration?: number;
  imageCredits?: ImageCreditTable;
  videoCreditsPerSecond?: VideoCreditTable;
  videoCreditsWithAudioPerSecond?: VideoCreditTable;
  fixedCoins?: number;
  referenceImages: boolean;
  /**
   * 可用的影片生成型別（P1-3）：只有 Seedance-2.5 族帶 extend_video／edit_video
   * （對稱差 D22，上游 ListModelCapabilities 實測）。缺省 ⇒ 只支援 `generate`。
   * 非 video 模型不得宣告本欄位。
   */
  videoGenerationTypes?: readonly VideoGenerationType[];
  /**
   * 超分檔位**能力宣告面**（P1-4）：產品線上有哪些檔位，含尚未校準者（如 4K）。
   * 宣告 ≠ 可提交：提交閘門用 `declaredUpscaleTiers` 判「這個檔位是否為本模型所有」，
   * 再用 `servableUpscaleTiers` 判「此刻能否提交」（4K 在 factor 真單校準前 fail-closed，
   * env `UPSCALE_4K_UPSTREAM`）。`/v1/models`（`generationCapabilities`）只外露可提交者，
   * 所以對外不會出現一個提交時必被具名拒收的檔位。
   * 缺省 ⇒ 該模型不支援超分（不輸出空能力宣稱）。
   */
  upscaleTiers?: readonly UpscaleTier[];
  /** LoRA is currently a PixAI-only single-selection capability. */
  supportsLora?: boolean;
  supportsAudio?: boolean;
  defaultAudio?: boolean;
}

export interface GenerationCapabilityProjection {
  modelId: string;
  mediaType: MediaKind;
  aspectRatios: readonly AspectRatio[];
  resolutions: readonly OutputResolution[];
  durations: readonly number[];
  referenceImages: boolean;
  audio: boolean;
  lora: boolean;
  /**
   * 影片生成型別（P1-3）：`["generate"]` 為基準；Seedance-2.5 族多出
   * `extend_video`（續片）／`edit_video`（局部改片）。`/v1/models` 的
   * `x_capabilities` 直接外露此欄位，聚合平台據此決定是否上架後期能力。
   */
  videoGenerationTypes?: readonly VideoGenerationType[];
  /**
   * 超分檔位（P1-4）：`/v1/models` 的 `x_capabilities` 直接外露此欄位，
   * 前端／聚合平台據此決定要不要上架「一鍵超分到 4K」的檔位選單。
   * 內容＝catalog 宣告檔位 ∩ 上游語義已校準（見 capabilities.ts 的 modelUpscaleTiers）。
   */
  upscaleTiers?: readonly UpscaleTier[];
  qualityModes: readonly ("fast" | "quality")[];
  defaultAspectRatio: AspectRatio;
  defaultResolution: OutputResolution;
  defaultDuration?: number;
  defaultAudio: boolean;
  /**
   * 提交端 prompt 字元硬上限（POST /v1/videos/generations 的 prompt_too_long 閘，
   * 全域 4000）。暴露給聚合平台/agent 做提交前預檢，免提交後才 400。
   */
  promptCharLimit?: number;
}

export interface GenerationConfigInput {
  aspectRatio?: string;
  outputResolution?: string;
  durationSeconds?: number;
  generateAudio?: boolean;
  qualityMode?: string;
  referenceCount?: number;
  loraModelVersionIds?: string[];
}

export interface NormalizedGenerationConfig {
  modelId: string;
  mediaType: MediaKind;
  aspectRatio: AspectRatio;
  outputResolution: OutputResolution;
  qualityMode: "fast" | "quality";
  durationSeconds?: number;
  generateAudio?: boolean;
  referenceCount: number;
  loraModelVersionIds: string[];
}

export interface GenerationConfigNormalization {
  config: NormalizedGenerationConfig;
  clearedFields: Array<"aspectRatio" | "outputResolution" | "durationSeconds" | "generateAudio" | "referenceImages" | "loraModelVersionIds" | "qualityMode">;
}

export const COMMON_IMAGE_RATIOS = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
export const EXTENDED_GEMINI_RATIOS = [...COMMON_IMAGE_RATIOS, "1:8", "8:1", "1:4", "4:1"] as const;
export const FLUX_RATIOS = ["1:1", "4:3", "3:4", "9:16", "16:9"] as const;
export const VIDEO_RATIOS = ["16:9", "9:16", "1:1"] as const;
export const WIDE_VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21"] as const;
export const RUNWAY_VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
export const SEEDANCE_VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
export const IMAGE_RESOLUTIONS = ["1k", "2k", "4k"] as const;
export const SEEDANCE_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
// 2026-09-05 暴君裁定：Seedance 全系只卖 ≥10 秒（10 秒以下亏本）。
// SEEDANCE_DURATIONS 保留给非 Seedance 模型（MiniMax H3）沿用。
export const SEEDANCE_20_DURATIONS = [10, 11, 12, 13, 14, 15] as const;
// seedance 2.5 时长档位（上游 sd4-seedance-2.5-480p / 720p，售卖下限 10s）
export const SEEDANCE_25_480P_DURATIONS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30] as const;
export const SEEDANCE_25_720P_DURATIONS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29] as const;
// drama 渠道 sd25-30s：30 秒固定档，唯一时长
export const SEEDANCE_25_30S_DURATIONS = [30] as const;
