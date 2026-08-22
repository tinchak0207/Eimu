export type MediaKind = "image" | "video" | "audio";
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

export interface GenerationModelDefinition {
  id: string;
  displayName: string;
  kind: MediaKind;
  popularity: number;
  /** 模型所屬廠商/平台，模型選單的一級目錄按此分組。 */
  vendor: string;
  /** AV 成片鏈路的提交端點與能力探測路由鍵（tts/avatar/lipsync）；一般模型無此欄位。 */
  pipeline?: "tts" | "avatar" | "lipsync";
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
  qualityModes: readonly ("fast" | "quality")[];
  defaultAspectRatio: AspectRatio;
  defaultResolution: OutputResolution;
  defaultDuration?: number;
  defaultAudio: boolean;
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
