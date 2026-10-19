import type { DeliverableKind } from "../deliverable-kind";

/**
 * 模型能产出的媒体种类（catalog 侧的种类栏位）。
 *
 * 值域**由交付物种类注册表推导**（`src/lib/deliverable-kind.ts` 的 DELIVERABLE_KINDS），
 * 不再手写字串联集——新增一种交付物只在注册表加一行，这里自动跟上，编译期即保证对齐。
 * 保留 `MediaKind` 这个名字是因为有多个消费者（model-status-probe 等）以它为型别名；
 * 改名只会制造无谓爆炸半径。
 */
export type MediaKind = DeliverableKind;

/**
 * 影片生成型别（P1-3 生成式后期；值逐字对齐上游 `AvailableGenerationType` 的
 * `extend_video`／`edit_video`，`generate` 为我方代表普通生成的基准值）。
 * 这是「模型能做什么」的能力宣告栏位真源——缺省＝只支援 `generate`，
 * **不推导不升格**（见 generation-core/video-post-production.ts 档头）。
 */
export type VideoGenerationType = "generate" | "extend_video" | "edit_video";
/**
 * 超分档位（P1-4／对称差 D10「一键超分到 4K」）。值与 `ImageResolution` 同形，
 * 但语义不同：这是**超分产品线的目标档位**（长边门槛 1k=1024／2k=2048／4k=3840）。
 * 真源＝`generation-core/upscale-tier.ts` 的 `UPSCALE_TIER_CONTRACTS`（含每个档位送
 * bridge 的 `(size, factor)` 与由真实比例表算出的长边保证）；本栏位只做**能力宣告**，
 * 缺省＝该模型不支援超分。宣告 4K ≠ 一定能出 4K：4K 的上游 factor 语义未校准，
 * 提交端 fail-closed（`upscale_4k_upstream_unverified`），`/v1/models` 只外露可提交档位。
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
 * 定价精度单点（币单位的小数位数）。全站定价的舍入/下限/显示/输入 step 都由
 * 以下三个常数派生——改大即支援更细定价（如 5 = 0.00001 币，限免场景），
 * 不需要改任何其他档案。credit 是币 × 10 的内部单位，精度多一位小数。
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
 * 模型卡三字段（吞并决策清单主线四首件）：擅长 / 已知缺陷 / 建议。
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
  /** 模型所属厂商/平台，模型选单的一级目录按此分组。 */
  vendor: string;
  /** AV 成片链路的提交端点与能力探测路由键（tts/avatar/lipsync）；一般模型无此栏位。 */
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
   * 可用的影片生成型别（P1-3）：只有 Seedance-2.5 族带 extend_video／edit_video
   * （对称差 D22，上游 ListModelCapabilities 实测）。缺省 ⇒ 只支援 `generate`。
   * 非 video 模型不得宣告本栏位。
   */
  videoGenerationTypes?: readonly VideoGenerationType[];
  /**
   * 超分档位**能力宣告面**（P1-4）：产品线上有哪些档位，含尚未校准者（如 4K）。
   * 宣告 ≠ 可提交：提交闸门用 `declaredUpscaleTiers` 判「这个档位是否为本模型所有」，
   * 再用 `servableUpscaleTiers` 判「此刻能否提交」（4K 在 factor 真单校准前 fail-closed，
   * env `UPSCALE_4K_UPSTREAM`）。`/v1/models`（`generationCapabilities`）只外露可提交者，
   * 所以对外不会出现一个提交时必被具名拒收的档位。
   * 缺省 ⇒ 该模型不支援超分（不输出空能力宣称）。
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
  /**
   * 每次请求可带的参考图上限（对称差 D23）。只有 `referenceImages === true` 的模型
   * 外露本栏位；不收参考图的模型**省略**（不输出空能力宣称）。
   * 数字真源＝执行端常数（`generation-core/request-limits.ts` 的
   * `MAX_REQUEST_REFERENCE_IMAGES`，即 `/v1/images/generations` 的
   * `invalid_reference_images` 闸）——宣告值与真的挡人的值同一颗，不另存第二份。
   * 宣告 ≠ 一定能提交：这是全站共同上限，模型／上游仍可能有更严格的限制。
   */
  maxReferenceImages?: number;
  /**
   * 每次请求可出的张数／段数上限（对称差 D23：对手 `ListModelCapabilities` 逐模型揭露批次数，
   * 我方旧版 `/v1/models` 完全没有）。每个模型都有值（图／视频同尺）。
   * 数字真源＝执行端常数（`generation-core/request-limits.ts` 的
   * `MAX_REQUEST_BATCH_COUNT`，即 `/v1/images|videos/generations` 的 `n` 闸，
   * 超限 → 400 `invalid_n`）。宣告 ≠ 一定能提交：它是全站共同上限。
   */
  maxBatchCount: number;
  audio: boolean;
  lora: boolean;
  /**
   * 影片生成型别（P1-3）：`["generate"]` 为基准；Seedance-2.5 族多出
   * `extend_video`（续片）／`edit_video`（局部改片）。`/v1/models` 的
   * `x_capabilities` 直接外露此栏位，聚合平台据此决定是否上架后期能力。
   */
  videoGenerationTypes?: readonly VideoGenerationType[];
  /**
   * 超分档位（P1-4）：`/v1/models` 的 `x_capabilities` 直接外露此栏位，
   * 前端／聚合平台据此决定要不要上架「一键超分到 4K」的档位选单。
   * 内容＝catalog 宣告档位 ∩ 上游语义已校准（见 capabilities.ts 的 modelUpscaleTiers）。
   */
  upscaleTiers?: readonly UpscaleTier[];
  qualityModes: readonly ("fast" | "quality")[];
  defaultAspectRatio: AspectRatio;
  defaultResolution: OutputResolution;
  defaultDuration?: number;
  defaultAudio: boolean;
  /**
   * 提交端 prompt 字元硬上限（POST /v1/videos/generations 的 prompt_too_long 闸，
   * 全域 4000）。暴露给聚合平台/agent 做提交前预检，免提交后才 400。
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
// seedance 2.0 mini（上游 miaowu seedance-2.0-mini，2026-10-13）：上游 video_api.ratios
// 只有 1:1/16:9/9:16/4:3/3:4（**无 21:9**，比 SEEDANCE_VIDEO_RATIOS 少一档），故单列，
// 免得选到 21:9 必然被上游 400 拒单。
export const SEEDANCE_20_MINI_VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
export const IMAGE_RESOLUTIONS = ["1k", "2k", "4k"] as const;
export const SEEDANCE_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
// 2026-09-05 项目负责人裁定：Seedance 全系只卖 ≥10 秒（10 秒以下亏本）。
// 2026-10-12 实测：miaowuai（上游 minimax-h3-max）720p 时长下限是 **5 秒**——传 4 秒被上游
// 400 拒单（「生成时长 4 秒超出范围，分辨率 720p 支持 5～15 秒」，job 60f6da1a…）。本表若
// 继续供 4 秒，等于让 agent 选到一个必然失败的值 ⇒ MiniMax H3 另立收窄档位。
export const MINIMAX_H3_DURATIONS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
export const SEEDANCE_20_DURATIONS = [10, 11, 12, 13, 14, 15] as const;
// agnes 免费视频档（agnes-video-2.5-flash，2026-10-13）：上游规格无公开文档，按真单探针
// 收窄到已验证/已过校验的两档——5s（免费档 200 queued 实测）、10s（上游校验通过、到队列闸）。
// 未校准更多档位前不外露，免得 agent 选到必被上游拒的秒数。
export const AGNES_VIDEO_DURATIONS = [5, 10] as const;
// seedance 2.5 时长档位（上游 sd4-seedance-2.5-480p / 720p，售卖下限 10s）
export const SEEDANCE_25_480P_DURATIONS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30] as const;
export const SEEDANCE_25_720P_DURATIONS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29] as const;
// drama 渠道 sd25-30s：30 秒固定档，唯一时长
export const SEEDANCE_25_30S_DURATIONS = [30] as const;
