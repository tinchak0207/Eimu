import {
  ADOBE_FIREFLY_FILL_MODEL_ID,
  ADOBE_FIREFLY_MODEL_ID,
  ADOBE_FIREFLY_VIDEO_MODEL_ID,
  DEFAULT_IMAGE_MODEL_ID,
  FLUX_11_PRO_MODEL_ID,
  FLUX_11_ULTRA_MODEL_ID,
  FLUX_2_MODEL_ID,
  FLUX_2_PRO_MODEL_ID,
  FLUX_KONTEXT_MAX_MODEL_ID,
  FLUX_KONTEXT_PRO_MODEL_ID,
  GPT_IMAGE_15_MODEL_ID,
  GPT_IMAGE_MODEL_ID,
  KLING_25_TURBO_MODEL_ID,
  KLING_30_MODEL_ID,
  KLING_30_OMNI_MODEL_ID,
  LUMA_RAY2_FLASH_MODEL_ID,
  LUMA_RAY2_MODEL_ID,
  LUMA_RAY3_HDR_MODEL_ID,
  LUMA_RAY3_MODEL_ID,
  LUMA_RAY314_HDR_MODEL_ID,
  LUMA_RAY314_MODEL_ID,
  NANO_BANANA_2_MODEL_ID,
  NANO_BANANA_MODEL_ID,
  NANO_BANANA_PRO_MODEL_ID,
  PIXAI_HARUKA_V2_MODEL_ID,
  PIXAI_HOSHINO_V2_MODEL_ID,
  PIXAI_EDIT_MODEL_ID,
  PIXAI_TEMPLATE_MODEL_ID,
  PIXAI_REFERENCE_PRO_MODEL_ID,
  PIXAI_TSUBAKI2_MODEL_ID,
  PIXAI_TSUBAKI_V11_MODEL_ID,
  PIXAI_UPSCALE_MODEL_ID,
  RUNWAY_GEN4_IMAGE_MODEL_ID,
  RUNWAY_GEN4_VIDEO_MODEL_ID,
  RUNWAY_GEN45_VIDEO_MODEL_ID,
  SEEDANCE_20_FAST_MODEL_ID,
  SEEDANCE_20_MODEL_ID,
  SUPPORTED_GENERATION_MODEL_IDS,
  SUPPORTED_IMAGE_MODEL_IDS,
  SUPPORTED_VIDEO_MODEL_IDS,
  VEO_31_FAST_MODEL_ID,
  VEO_31_MODEL_ID,
} from "./image-model-ids.js";

export type MediaKind = "image" | "video";
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

type ImageCreditTable = Partial<Record<ImageResolution, number>>;
type VideoCreditTable = Partial<Record<VideoResolution, number>>;

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

const COMMON_IMAGE_RATIOS = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
const EXTENDED_GEMINI_RATIOS = [...COMMON_IMAGE_RATIOS, "1:8", "8:1", "1:4", "4:1"] as const;
const FLUX_RATIOS = ["1:1", "4:3", "3:4", "9:16", "16:9"] as const;
const VIDEO_RATIOS = ["16:9", "9:16", "1:1"] as const;
const WIDE_VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21"] as const;
const RUNWAY_VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
const SEEDANCE_VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
const IMAGE_RESOLUTIONS = ["1k", "2k", "4k"] as const;
const SEEDANCE_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;

export const GENERATION_MODEL_CATALOG: Record<string, GenerationModelDefinition> = {
  [DEFAULT_IMAGE_MODEL_ID]: {
    id: DEFAULT_IMAGE_MODEL_ID,
    displayName: "GPT Image 2",
    kind: "image",
    popularity: 100,
    vendor: "OpenAI",
    aspectRatios: COMMON_IMAGE_RATIOS,
    resolutions: IMAGE_RESOLUTIONS,
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 10, "2k": 20, "4k": 80 },
    referenceImages: true,
  },
  [NANO_BANANA_2_MODEL_ID]: {
    id: NANO_BANANA_2_MODEL_ID,
    displayName: "Nano Banana 2",
    kind: "image",
    popularity: 99,
    vendor: "Google",
    aspectRatios: EXTENDED_GEMINI_RATIOS,
    resolutions: IMAGE_RESOLUTIONS,
    defaultAspectRatio: "1:1",
    defaultResolution: "2k",
    imageCredits: { "1k": 20, "2k": 20, "4k": 30 },
    referenceImages: true,
  },
  [ADOBE_FIREFLY_MODEL_ID]: {
    id: ADOBE_FIREFLY_MODEL_ID,
    displayName: "Adobe Firefly Image 5",
    kind: "image",
    popularity: 98,
    vendor: "Adobe",
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    resolutions: ["1k", "2k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 10, "2k": 10 },
    referenceImages: false,
  },
  [ADOBE_FIREFLY_FILL_MODEL_ID]: {
    id: ADOBE_FIREFLY_FILL_MODEL_ID,
    displayName: "智能扩图 (Adobe Fill)",
    kind: "image",
    popularity: 50,
    vendor: "Adobe",
    aspectRatios: ["1:1"],
    resolutions: ["1k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 10 },
    referenceImages: true,
  },
  [PIXAI_EDIT_MODEL_ID]: {
    id: PIXAI_EDIT_MODEL_ID,
    displayName: "改图 (Image Edit)",
    kind: "image",
    popularity: 50,
    vendor: "PixAI",
    aspectRatios: ["1:1"],
    resolutions: ["1k", "2k", "4k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 30, "2k": 60, "4k": 120 },
    referenceImages: true,
  },
  [PIXAI_UPSCALE_MODEL_ID]: {
    id: PIXAI_UPSCALE_MODEL_ID,
    displayName: "图像放大 (2x Upscale)",
    kind: "image",
    popularity: 50,
    vendor: "PixAI",
    aspectRatios: ["1:1"],
    resolutions: ["1k", "2k", "4k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 10, "2k": 20, "4k": 40 },
    referenceImages: true,
  },
  // 模板生成的定價鍵。2026-08-05 之前 /v1/template-generations 用路由內硬編碼的
  // 5/8 幣且從未扣費；建鍵後定價與 admin 覆寫層同源，與 edit/upscale 一致。
  // 費率沿用原硬編碼比例（5/8 幣 → 50/80 credits），4k 按 2k 翻倍。
  [PIXAI_TEMPLATE_MODEL_ID]: {
    id: PIXAI_TEMPLATE_MODEL_ID,
    displayName: "模板生成 (Template)",
    kind: "image",
    popularity: 50,
    vendor: "PixAI",
    aspectRatios: ["1:1"],
    resolutions: ["1k", "2k", "4k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 50, "2k": 80, "4k": 160 },
    referenceImages: true,
  },
  [NANO_BANANA_PRO_MODEL_ID]: {
    id: NANO_BANANA_PRO_MODEL_ID,
    displayName: "Nano Banana Pro",
    kind: "image",
    popularity: 97,
    vendor: "Google",
    aspectRatios: COMMON_IMAGE_RATIOS,
    resolutions: IMAGE_RESOLUTIONS,
    defaultAspectRatio: "1:1",
    defaultResolution: "2k",
    imageCredits: { "1k": 40, "2k": 40, "4k": 40 },
    referenceImages: true,
  },
  [GPT_IMAGE_15_MODEL_ID]: {
    id: GPT_IMAGE_15_MODEL_ID,
    displayName: "GPT Image 1.5",
    kind: "image",
    popularity: 96,
    vendor: "OpenAI",
    aspectRatios: ["1:1", "3:2", "2:3"],
    resolutions: ["1k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 20 },
    referenceImages: true,
  },
  [NANO_BANANA_MODEL_ID]: {
    id: NANO_BANANA_MODEL_ID,
    displayName: "Nano Banana",
    kind: "image",
    popularity: 95,
    vendor: "Google",
    aspectRatios: COMMON_IMAGE_RATIOS,
    resolutions: ["1k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 10 },
    referenceImages: true,
  },
  [FLUX_2_PRO_MODEL_ID]: {
    id: FLUX_2_PRO_MODEL_ID,
    displayName: "FLUX.2 Pro",
    kind: "image",
    popularity: 94,
    vendor: "FLUX",
    aspectRatios: FLUX_RATIOS,
    resolutions: ["1k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 20 },
    referenceImages: true,
  },
  [FLUX_2_MODEL_ID]: {
    id: FLUX_2_MODEL_ID,
    displayName: "FLUX.2",
    kind: "image",
    popularity: 93,
    vendor: "FLUX",
    aspectRatios: FLUX_RATIOS,
    resolutions: ["1k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 20 },
    referenceImages: true,
  },
  [GPT_IMAGE_MODEL_ID]: {
    id: GPT_IMAGE_MODEL_ID,
    displayName: "GPT Image",
    kind: "image",
    popularity: 92,
    vendor: "OpenAI",
    aspectRatios: ["1:1", "3:2", "2:3"],
    resolutions: ["1k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 60 },
    referenceImages: true,
  },
  [FLUX_KONTEXT_MAX_MODEL_ID]: {
    id: FLUX_KONTEXT_MAX_MODEL_ID,
    displayName: "FLUX Kontext Max",
    kind: "image",
    popularity: 91,
    vendor: "FLUX",
    aspectRatios: FLUX_RATIOS,
    resolutions: ["1k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 10 },
    referenceImages: true,
  },
  [FLUX_KONTEXT_PRO_MODEL_ID]: {
    id: FLUX_KONTEXT_PRO_MODEL_ID,
    displayName: "FLUX Kontext Pro",
    kind: "image",
    popularity: 90,
    vendor: "FLUX",
    aspectRatios: FLUX_RATIOS,
    resolutions: ["1k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 10 },
    referenceImages: true,
  },
  [FLUX_11_ULTRA_MODEL_ID]: {
    id: FLUX_11_ULTRA_MODEL_ID,
    displayName: "FLUX 1.1 Pro Ultra",
    kind: "image",
    popularity: 89,
    vendor: "FLUX",
    aspectRatios: FLUX_RATIOS,
    resolutions: ["1k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 20 },
    referenceImages: true,
  },
  [FLUX_11_PRO_MODEL_ID]: {
    id: FLUX_11_PRO_MODEL_ID,
    displayName: "FLUX 1.1 Pro",
    kind: "image",
    popularity: 88,
    vendor: "FLUX",
    aspectRatios: FLUX_RATIOS,
    resolutions: ["1k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 10 },
    referenceImages: true,
  },
  [RUNWAY_GEN4_IMAGE_MODEL_ID]: {
    id: RUNWAY_GEN4_IMAGE_MODEL_ID,
    displayName: "Runway Gen-4 Image",
    kind: "image",
    popularity: 87,
    vendor: "Runway",
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"],
    resolutions: ["1k", "2k"],
    defaultAspectRatio: "16:9",
    defaultResolution: "1k",
    imageCredits: { "1k": 20, "2k": 40 },
    referenceImages: true,
  },

  [PIXAI_TSUBAKI2_MODEL_ID]: {
    id: PIXAI_TSUBAKI2_MODEL_ID,
    displayName: "PixAI Tsubaki.2",
    kind: "image",
    vendor: "PixAI",
    popularity: 1000,
    promotionTag: "推荐",
    aspectRatios: ["1:1", "3:2", "2:3", "3:4", "4:3", "9:16", "16:9"],
    resolutions: ["1k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 30 },
    referenceImages: false,
  },
  [PIXAI_HARUKA_V2_MODEL_ID]: {
    id: PIXAI_HARUKA_V2_MODEL_ID,
    displayName: "PixAI Haruka v2",
    kind: "image",
    vendor: "PixAI",
    popularity: 94,
    promotionTag: "PixAI",
    aspectRatios: ["1:1", "3:2", "2:3", "3:4", "4:3", "9:16", "16:9"],
    resolutions: ["1k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 20 },
    referenceImages: false,
  },
  [PIXAI_REFERENCE_PRO_MODEL_ID]: {
    id: PIXAI_REFERENCE_PRO_MODEL_ID,
    displayName: "PixAI Reference Pro",
    kind: "image",
    vendor: "PixAI",
    popularity: 95,
    promotionTag: "PixAI",
    aspectRatios: ["1:1", "3:2", "2:3", "3:4", "4:3", "9:16", "16:9"],
    resolutions: ["1k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 40 },
    referenceImages: true,
  },
  [PIXAI_TSUBAKI_V11_MODEL_ID]: {
    id: PIXAI_TSUBAKI_V11_MODEL_ID,
    displayName: "PixAI Tsubaki v1.1",
    kind: "image",
    vendor: "PixAI",
    popularity: 93,
    promotionTag: "PixAI",
    aspectRatios: ["1:1", "3:2", "2:3", "3:4", "4:3", "9:16", "16:9"],
    resolutions: ["1k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 25 },
    referenceImages: false,
  },
  [PIXAI_HOSHINO_V2_MODEL_ID]: {
    id: PIXAI_HOSHINO_V2_MODEL_ID,
    displayName: "PixAI Hoshino v2",
    kind: "image",
    vendor: "PixAI",
    popularity: 92,
    promotionTag: "PixAI",
    aspectRatios: ["1:1", "3:2", "2:3", "3:4", "4:3", "9:16", "16:9"],
    resolutions: ["1k"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1k",
    imageCredits: { "1k": 20 },
    referenceImages: false,
  },

  [VEO_31_FAST_MODEL_ID]: {
    id: VEO_31_FAST_MODEL_ID,
    displayName: "Google Veo 3.1 Fast",
    kind: "video",
    popularity: 100,
    vendor: "Google",
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["720p", "1080p"],
    defaultAspectRatio: "16:9",
    defaultResolution: "720p",
    durations: [4, 6, 8],
    defaultDuration: 4,
    videoCreditsPerSecond: { "720p": 10, "1080p": 10 },
    referenceImages: true,
    supportsAudio: true,
    defaultAudio: false,
  },
  [KLING_30_MODEL_ID]: {
    id: KLING_30_MODEL_ID,
    displayName: "Kling 3.0",
    kind: "video",
    popularity: 99,
    vendor: "Kling",
    aspectRatios: VIDEO_RATIOS,
    resolutions: ["720p", "1080p"],
    defaultAspectRatio: "16:9",
    defaultResolution: "720p",
    durations: [5, 10, 15],
    defaultDuration: 5,
    videoCreditsPerSecond: { "720p": 20, "1080p": 25 },
    videoCreditsWithAudioPerSecond: { "720p": 25, "1080p": 35 },
    referenceImages: true,
    supportsAudio: true,
    defaultAudio: false,
  },
  [KLING_30_OMNI_MODEL_ID]: {
    id: KLING_30_OMNI_MODEL_ID,
    displayName: "Kling 3.0 Omni",
    kind: "video",
    popularity: 98,
    vendor: "Kling",
    aspectRatios: VIDEO_RATIOS,
    resolutions: ["720p", "1080p"],
    defaultAspectRatio: "16:9",
    defaultResolution: "1080p",
    durations: [5, 10, 15],
    defaultDuration: 5,
    videoCreditsPerSecond: { "720p": 20, "1080p": 25 },
    videoCreditsWithAudioPerSecond: { "720p": 25, "1080p": 35 },
    referenceImages: true,
    supportsAudio: true,
    defaultAudio: false,
  },
  [SEEDANCE_20_FAST_MODEL_ID]: {
    id: SEEDANCE_20_FAST_MODEL_ID,
    displayName: "Dreamina Seedance 2.0 Fast",
    kind: "video",
    popularity: 97,
    vendor: "Dreamina",
    aspectRatios: SEEDANCE_VIDEO_RATIOS,
    resolutions: ["480p", "720p"],
    defaultAspectRatio: "16:9",
    defaultResolution: "720p",
    durations: SEEDANCE_DURATIONS,
    defaultDuration: 5,
    videoCreditsPerSecond: { "480p": 30, "720p": 50 },
    referenceImages: true,
    supportsAudio: true,
    defaultAudio: false,
  },
  [SEEDANCE_20_MODEL_ID]: {
    id: SEEDANCE_20_MODEL_ID,
    displayName: "Dreamina Seedance 2.0",
    kind: "video",
    popularity: 96,
    vendor: "Dreamina",
    aspectRatios: SEEDANCE_VIDEO_RATIOS,
    resolutions: ["480p", "720p", "1080p"],
    defaultAspectRatio: "16:9",
    defaultResolution: "720p",
    durations: SEEDANCE_DURATIONS,
    defaultDuration: 5,
    videoCreditsPerSecond: { "480p": 40, "720p": 90, "1080p": 180 },
    referenceImages: true,
    supportsAudio: true,
    defaultAudio: false,
  },
  [VEO_31_MODEL_ID]: {
    id: VEO_31_MODEL_ID,
    displayName: "Google Veo 3.1",
    kind: "video",
    popularity: 95,
    vendor: "Google",
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["720p", "1080p"],
    defaultAspectRatio: "16:9",
    defaultResolution: "1080p",
    durations: [4, 6, 8],
    defaultDuration: 4,
    videoCreditsPerSecond: { "720p": 50, "1080p": 50 },
    referenceImages: true,
    supportsAudio: true,
    defaultAudio: true,
  },
  [RUNWAY_GEN45_VIDEO_MODEL_ID]: {
    id: RUNWAY_GEN45_VIDEO_MODEL_ID,
    displayName: "Runway Gen-4.5",
    kind: "video",
    popularity: 94,
    vendor: "Runway",
    aspectRatios: RUNWAY_VIDEO_RATIOS,
    resolutions: ["720p"],
    defaultAspectRatio: "16:9",
    defaultResolution: "720p",
    durations: [5, 8, 10],
    defaultDuration: 5,
    videoCreditsPerSecond: { "720p": 35 },
    referenceImages: true,
  },
  [ADOBE_FIREFLY_VIDEO_MODEL_ID]: {
    id: ADOBE_FIREFLY_VIDEO_MODEL_ID,
    displayName: "Adobe Firefly Video",
    kind: "video",
    popularity: 93,
    vendor: "Adobe",
    aspectRatios: VIDEO_RATIOS,
    resolutions: ["540p", "720p", "1080p"],
    defaultAspectRatio: "16:9",
    defaultResolution: "720p",
    durations: [5],
    defaultDuration: 5,
    videoCreditsPerSecond: { "540p": 20, "720p": 50, "1080p": 100 },
    referenceImages: true,
  },
  [LUMA_RAY314_MODEL_ID]: {
    id: LUMA_RAY314_MODEL_ID,
    displayName: "Luma AI Ray3.14",
    kind: "video",
    popularity: 92,
    vendor: "Luma",
    aspectRatios: WIDE_VIDEO_RATIOS,
    resolutions: ["720p", "1080p", "4k"],
    defaultAspectRatio: "16:9",
    defaultResolution: "720p",
    durations: [5, 10],
    defaultDuration: 5,
    videoCreditsPerSecond: { "720p": 40, "1080p": 80, "4k": 100 },
    referenceImages: true,
  },
  [RUNWAY_GEN4_VIDEO_MODEL_ID]: {
    id: RUNWAY_GEN4_VIDEO_MODEL_ID,
    displayName: "Runway Gen-4",
    kind: "video",
    popularity: 91,
    vendor: "Runway",
    aspectRatios: RUNWAY_VIDEO_RATIOS,
    resolutions: ["720p"],
    defaultAspectRatio: "16:9",
    defaultResolution: "720p",
    durations: [5, 10],
    defaultDuration: 5,
    videoCreditsPerSecond: { "720p": 20 },
    referenceImages: true,
  },
  [LUMA_RAY3_MODEL_ID]: {
    id: LUMA_RAY3_MODEL_ID,
    displayName: "Luma AI Ray3",
    kind: "video",
    popularity: 90,
    vendor: "Luma",
    aspectRatios: WIDE_VIDEO_RATIOS,
    resolutions: ["360p", "540p", "720p", "1080p", "4k"],
    defaultAspectRatio: "16:9",
    defaultResolution: "720p",
    durations: [5, 10],
    defaultDuration: 5,
    videoCreditsPerSecond: { "360p": 25, "540p": 75, "720p": 100, "1080p": 125, "4k": 150 },
    referenceImages: true,
  },
  [LUMA_RAY314_HDR_MODEL_ID]: {
    id: LUMA_RAY314_HDR_MODEL_ID,
    displayName: "Luma AI Ray3.14 HDR",
    kind: "video",
    popularity: 89,
    vendor: "Luma",
    aspectRatios: WIDE_VIDEO_RATIOS,
    resolutions: ["720p", "1080p", "4k"],
    defaultAspectRatio: "16:9",
    defaultResolution: "720p",
    durations: [5],
    defaultDuration: 5,
    videoCreditsPerSecond: { "720p": 120, "1080p": 240, "4k": 275 },
    referenceImages: true,
  },
  [LUMA_RAY2_FLASH_MODEL_ID]: {
    id: LUMA_RAY2_FLASH_MODEL_ID,
    displayName: "Luma AI Ray2 Flash",
    kind: "video",
    popularity: 88,
    vendor: "Luma",
    aspectRatios: WIDE_VIDEO_RATIOS,
    resolutions: ["540p", "720p", "1080p", "4k"],
    defaultAspectRatio: "16:9",
    defaultResolution: "720p",
    durations: [5, 9],
    defaultDuration: 5,
    videoCreditsPerSecond: { "540p": 10, "720p": 25, "1080p": 50, "4k": 75 },
    referenceImages: true,
  },
  [LUMA_RAY2_MODEL_ID]: {
    id: LUMA_RAY2_MODEL_ID,
    displayName: "Luma AI Ray2",
    kind: "video",
    popularity: 87,
    vendor: "Luma",
    aspectRatios: WIDE_VIDEO_RATIOS,
    resolutions: ["540p", "720p", "1080p", "4k"],
    defaultAspectRatio: "16:9",
    defaultResolution: "720p",
    durations: [5, 9],
    defaultDuration: 5,
    videoCreditsPerSecond: { "540p": 20, "720p": 50, "1080p": 100, "4k": 150 },
    referenceImages: true,
  },
  [LUMA_RAY3_HDR_MODEL_ID]: {
    id: LUMA_RAY3_HDR_MODEL_ID,
    displayName: "Luma AI Ray3 HDR",
    kind: "video",
    popularity: 86,
    vendor: "Luma",
    aspectRatios: WIDE_VIDEO_RATIOS,
    resolutions: ["360p", "540p", "720p", "1080p", "4k"],
    defaultAspectRatio: "16:9",
    defaultResolution: "720p",
    durations: [5],
    defaultDuration: 5,
    videoCreditsPerSecond: { "360p": 75, "540p": 225, "720p": 300, "1080p": 375, "4k": 450 },
    referenceImages: true,
  },
  [KLING_25_TURBO_MODEL_ID]: {
    id: KLING_25_TURBO_MODEL_ID,
    displayName: "Kling 2.5 Turbo",
    kind: "video",
    popularity: 85,
    vendor: "Kling",
    aspectRatios: VIDEO_RATIOS,
    resolutions: ["1080p"],
    defaultAspectRatio: "16:9",
    defaultResolution: "1080p",
    durations: [5, 10],
    defaultDuration: 5,
    videoCreditsPerSecond: { "1080p": 15 },
    referenceImages: true,
  },
};

export const IMAGE_MODEL_IDS = SUPPORTED_IMAGE_MODEL_IDS as readonly string[];
export const VIDEO_MODEL_IDS = SUPPORTED_VIDEO_MODEL_IDS as readonly string[];
export const GENERATION_MODEL_IDS = SUPPORTED_GENERATION_MODEL_IDS as readonly string[];

/**
 * 模型定價覆寫（全局配置）。
 *
 * 這是模組級的**全局可變狀態**，不是 per-request 快取：與 channel-overrides 的
 * 快取同性質，同實例併發請求共用同一份 effectiveCatalog 是刻意的。管理員在
 * /admin 改價後，服務端透過 pricing-runtime 的 syncModelPricing() 把覆寫灌進這裡；
 * 後端計費直接讀 generationCredits()/generationCoins() 立刻按新價走，前端以
 * usePricingRevision() 訂閱 revision 即時重繪，不需重新部署。
 */
export interface ModelPricingOverride {
  /** 僅對 kind === "image" 生效：各解析度的單張圖 credit。 */
  imageCredits?: ImageCreditTable;
  /** 僅對 kind === "video" 生效：每秒 video credit（無音軌）。 */
  videoCreditsPerSecond?: VideoCreditTable;
  /** 僅對 kind === "video" 生效：每秒 video credit（含音軌）。 */
  videoCreditsWithAudioPerSecond?: VideoCreditTable;
  /** 固定幣價（不隨解析度/時長變化）。不允許 0 或負數——0 幣會讓扣費為零。 */
  fixedCoins?: number;
}

export type ModelPricingOverrides = Record<string, ModelPricingOverride>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 清洗任何不可信輸入（Blob 內容 / PATCH body）到覆寫 schema。規則嚴格、越界
 * 直接丟棄該欄位而非報錯：未知 modelId、不存在於該模型 resolutions 的解析度、
 * 非整數或超出 [1, 1_000_000] 的 credit、錯位欄位（image 模型塞 video 欄位、
 * video 模型塞 image 欄位）、非法 fixedCoins——全部靜默丟棄；清洗後為空的模型
 * 條目不輸出。
 */
export function normalizeModelPricingOverrides(raw: unknown): ModelPricingOverrides {
  if (!isPlainObject(raw)) return {};

  const overrides: ModelPricingOverrides = {};
  for (const [modelId, value] of Object.entries(raw)) {
    const base = GENERATION_MODEL_CATALOG[modelId];
    if (!base || !isPlainObject(value)) continue;

    const entry: ModelPricingOverride = {};
    const allowedResolutions = base.resolutions as readonly string[];

    if (base.kind === "image") {
      const imageCredits = sanitizeCreditTable(value.imageCredits, allowedResolutions);
      if (Object.keys(imageCredits).length > 0) entry.imageCredits = imageCredits as ImageCreditTable;
    } else {
      const videoCreditsPerSecond = sanitizeCreditTable(value.videoCreditsPerSecond, allowedResolutions);
      if (Object.keys(videoCreditsPerSecond).length > 0) entry.videoCreditsPerSecond = videoCreditsPerSecond as VideoCreditTable;
      const videoCreditsWithAudio = sanitizeCreditTable(value.videoCreditsWithAudioPerSecond, allowedResolutions);
      if (Object.keys(videoCreditsWithAudio).length > 0) entry.videoCreditsWithAudioPerSecond = videoCreditsWithAudio as VideoCreditTable;
    }

    const fixedCoins = value.fixedCoins;
    if (typeof fixedCoins === "number" && Number.isFinite(fixedCoins) && fixedCoins >= PRICING_COIN_STEP && fixedCoins <= 100_000) {
      entry.fixedCoins = Math.round(fixedCoins * 10 ** PRICING_DECIMALS) / 10 ** PRICING_DECIMALS;
    }

    if (Object.keys(entry).length === 0) continue;
    // defineProperty instead of assignment：JSON.parse 可能給我們 own "__proto__" key，
    // 用 `overrides[key] = entry` 會設定原型而非 own property。
    Object.defineProperty(overrides, modelId, { value: entry, enumerable: true, writable: true, configurable: true });
  }
  return overrides;
}

/**
 * credit 表清洗：鍵必須在 allowedKeys（該模型真實 resolutions）內，值必須是
 * [PRICING_CREDIT_STEP, 1_000_000] 的有限數，按 PRICING_DECIMALS 派生精度舍入
 * （credit 小數位 = PRICING_DECIMALS - 1，與 admin UI 的輸入縮放一致，覆蓋限免級小數定價）。
 */
function sanitizeCreditTable(raw: unknown, allowedKeys: readonly string[]): Record<string, number> {
  if (!isPlainObject(raw)) return {};
  const table: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowedKeys.includes(key)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < PRICING_CREDIT_STEP || value > 1_000_000) continue;
    const creditScale = 10 ** (PRICING_DECIMALS - 1);
    table[key] = Math.round(value * creditScale) / creditScale;
  }
  return table;
}

// 全局配置：模組級可變狀態，同實例併發請求共用一份是刻意的（與 channel-overrides 快取同性質）。
let effectiveCatalog: Record<string, GenerationModelDefinition> = GENERATION_MODEL_CATALOG;
let activeOverrides: ModelPricingOverrides = {};
let pricingRevision = 0;
const pricingListeners = new Set<() => void>();

/** 「基準 + 覆寫」淺合併，只合併四個定價欄位；credit 表 per-key 合併。 */
function mergePricingOverride(base: GenerationModelDefinition, override: ModelPricingOverride): GenerationModelDefinition {
  const merged: GenerationModelDefinition = { ...base };
  if (override.imageCredits !== undefined) {
    merged.imageCredits = { ...(base.imageCredits ?? {}), ...override.imageCredits };
  }
  if (override.videoCreditsPerSecond !== undefined) {
    merged.videoCreditsPerSecond = { ...(base.videoCreditsPerSecond ?? {}), ...override.videoCreditsPerSecond };
  }
  if (override.videoCreditsWithAudioPerSecond !== undefined) {
    merged.videoCreditsWithAudioPerSecond = {
      ...(base.videoCreditsWithAudioPerSecond ?? {}),
      ...override.videoCreditsWithAudioPerSecond,
    };
  }
  if (override.fixedCoins !== undefined) {
    merged.fixedCoins = override.fixedCoins;
  }
  return merged;
}

function buildEffectiveCatalog(overrides: ModelPricingOverrides): Record<string, GenerationModelDefinition> {
  if (Object.keys(overrides).length === 0) return GENERATION_MODEL_CATALOG;
  const catalog: Record<string, GenerationModelDefinition> = {};
  for (const [modelId, base] of Object.entries(GENERATION_MODEL_CATALOG)) {
    const override = overrides[modelId];
    catalog[modelId] = override ? mergePricingOverride(base, override) : base;
  }
  return catalog;
}

/**
 * 覆寫生效：重算有效目錄、bump revision、通知訂閱者。傳 {} 即回到基準價。
 * 只合併定價欄位，能力面（aspectRatios/resolutions/popularity 等）一律取基準。
 */
export function applyModelPricingOverrides(raw: unknown): void {
  const normalized = normalizeModelPricingOverrides(raw);
  activeOverrides = normalized;
  effectiveCatalog = buildEffectiveCatalog(normalized);
  pricingRevision += 1;
  for (const listener of [...pricingListeners]) listener();
}

/** 當前生效的覆寫表（防禦性複製，避免呼叫端污染內部狀態）。 */
export function activeModelPricingOverrides(): ModelPricingOverrides {
  const copy: ModelPricingOverrides = {};
  for (const [modelId, entry] of Object.entries(activeOverrides)) {
    copy[modelId] = { ...entry };
  }
  return copy;
}

/** 單調遞增的覆寫版本號；前端 useSyncExternalStore 的 snapshot。 */
export function modelPricingRevision(): number {
  return pricingRevision;
}

export function subscribeModelPricing(listener: () => void): () => void {
  pricingListeners.add(listener);
  return () => {
    pricingListeners.delete(listener);
  };
}

/** 某模型的基準（未覆寫）定義，admin UI 要顯示基準價。 */
export function baseGenerationModel(modelId: string): GenerationModelDefinition | null {
  return GENERATION_MODEL_CATALOG[modelId] ?? null;
}

export function generationModel(modelId: string): GenerationModelDefinition | null {
  return effectiveCatalog[modelId] ?? null;
}

export function generationCapabilities(modelId: string): GenerationCapabilityProjection | null {
  const model = generationModel(modelId);
  if (!model) return null;
  return {
    modelId: model.id,
    mediaType: model.kind,
    aspectRatios: model.aspectRatios,
    resolutions: model.resolutions,
    durations: model.durations ?? [],
    referenceImages: model.referenceImages,
    audio: model.supportsAudio === true,
    lora: model.supportsLora === true || model.vendor === "PixAI",
    qualityModes: model.kind === "image" && model.resolutions.some((resolution) => resolution === "2k" || resolution === "4k")
      ? ["fast", "quality"]
      : ["fast"],
    defaultAspectRatio: model.defaultAspectRatio,
    defaultResolution: model.defaultResolution,
    ...(model.defaultDuration !== undefined ? { defaultDuration: model.defaultDuration } : {}),
    defaultAudio: model.defaultAudio === true,
  };
}

/**
 * One capability contract for client controls, request payloads, and pricing.
 * Unsupported values are replaced by catalog defaults and unsupported fields
 * are removed instead of being left hidden in component state.
 */
export function normalizeGenerationConfig(
  modelId: string,
  input: GenerationConfigInput = {},
): GenerationConfigNormalization {
  const capabilities = generationCapabilities(modelId);
  if (!capabilities) throw new Error(`Unsupported generation model: ${modelId}`);

  const clearedFields: GenerationConfigNormalization["clearedFields"] = [];
  const aspectRatio = capabilities.aspectRatios.includes(input.aspectRatio as AspectRatio)
    ? input.aspectRatio as AspectRatio
    : capabilities.defaultAspectRatio;
  if (input.aspectRatio !== undefined && input.aspectRatio !== aspectRatio) clearedFields.push("aspectRatio");

  const outputResolution = capabilities.resolutions.includes(input.outputResolution as OutputResolution)
    ? input.outputResolution as OutputResolution
    : capabilities.defaultResolution;
  if (input.outputResolution !== undefined && input.outputResolution !== outputResolution) clearedFields.push("outputResolution");

  const qualityMode = capabilities.qualityModes.includes(input.qualityMode as "fast" | "quality")
    ? input.qualityMode as "fast" | "quality"
    : outputResolution === "2k" || outputResolution === "4k"
      ? "quality"
      : "fast";
  if (input.qualityMode !== undefined && input.qualityMode !== qualityMode) clearedFields.push("qualityMode");

  const durationSeconds = capabilities.mediaType === "video"
    ? (capabilities.durations.includes(Number(input.durationSeconds))
        ? Number(input.durationSeconds)
        : capabilities.defaultDuration ?? capabilities.durations[0])
    : undefined;
  if (input.durationSeconds !== undefined && input.durationSeconds !== durationSeconds) clearedFields.push("durationSeconds");

  const generateAudio = capabilities.mediaType === "video" && capabilities.audio
    ? input.generateAudio ?? capabilities.defaultAudio
    : undefined;
  if (input.generateAudio !== undefined && input.generateAudio !== generateAudio) clearedFields.push("generateAudio");

  const referenceCount = capabilities.referenceImages
    ? Math.max(0, Math.min(8, Math.floor(Number(input.referenceCount) || 0)))
    : 0;
  if (!capabilities.referenceImages && Number(input.referenceCount) > 0) clearedFields.push("referenceImages");

  const loraModelVersionIds = capabilities.lora
    ? [...new Set((input.loraModelVersionIds ?? []).map(String).map((value) => value.trim()).filter(Boolean))].slice(0, 1)
    : [];
  if (!capabilities.lora && (input.loraModelVersionIds?.length ?? 0) > 0) clearedFields.push("loraModelVersionIds");

  return {
    config: {
      modelId,
      mediaType: capabilities.mediaType,
      aspectRatio,
      outputResolution,
      qualityMode,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(generateAudio !== undefined ? { generateAudio } : {}),
      referenceCount,
      loraModelVersionIds,
    },
    clearedFields: [...new Set(clearedFields)],
  };
}

export function isSupportedGenerationModel(modelId: string): boolean {
  return Boolean(generationModel(modelId));
}

export function isSupportedImageModel(modelId: string): boolean {
  return generationModel(modelId)?.kind === "image";
}

export function isSupportedVideoModel(modelId: string): boolean {
  return generationModel(modelId)?.kind === "video";
}

export function modelBaseName(modelId: string): string {
  return generationModel(modelId)?.displayName ?? modelId;
}

export function modelPromotionTag(modelId: string): string | undefined {
  return generationModel(modelId)?.promotionTag;
}

export function modelAspectRatios(modelId: string): readonly AspectRatio[] {
  return generationModel(modelId)?.aspectRatios ?? ["1:1"];
}

export function modelResolutions(modelId: string): readonly OutputResolution[] {
  return generationModel(modelId)?.resolutions ?? ["1k"];
}

export function modelDurations(modelId: string): readonly number[] {
  return generationModel(modelId)?.durations ?? [];
}

export function modelSupportsAudio(modelId: string): boolean {
  return generationModel(modelId)?.supportsAudio === true;
}

export function defaultGenerateAudio(modelId: string): boolean {
  return generationModel(modelId)?.defaultAudio === true;
}

export function defaultAspectRatio(modelId: string): AspectRatio {
  return generationModel(modelId)?.defaultAspectRatio ?? "1:1";
}

export function defaultOutputResolution(modelId: string): OutputResolution {
  return generationModel(modelId)?.defaultResolution ?? "1k";
}

export function defaultDuration(modelId: string): number | undefined {
  return generationModel(modelId)?.defaultDuration;
}

export function resolutionLabel(resolution: OutputResolution): string {
  if (resolution === "1k") return "1K 标准";
  if (resolution === "2k") return "2K 高清";
  if (resolution === "4k") return "4K 超清";
  if (resolution === "360p") return "360p 流畅";
  if (resolution === "480p") return "480p 标清";
  if (resolution === "540p") return "540p 标准";
  if (resolution === "720p") return "720p 高清";
  return "1080p 全高清";
}

export interface GenerationPriceOptions {
  resolution?: OutputResolution;
  durationSeconds?: number;
  generateAudio?: boolean;
}

export function generationCredits(
  modelId: string,
  options: GenerationPriceOptions = {},
): number {
  const model = generationModel(modelId);
  if (!model) return 0;
  const hasRateTable =
    (model.kind === "image" && model.imageCredits !== undefined) ||
    (model.kind === "video" &&
      (model.videoCreditsPerSecond !== undefined || model.videoCreditsWithAudioPerSecond !== undefined));
  if (!hasRateTable) return 0; // fixedCoins 簡化定價的模型沒有 credit 表
  const resolution = options.resolution ?? model.defaultResolution;
  if (model.kind === "image") {
    return model.imageCredits?.[resolution as ImageResolution] ?? 0;
  }
  const duration = options.durationSeconds ?? model.defaultDuration ?? 1;
  const rates = options.generateAudio && model.videoCreditsWithAudioPerSecond
    ? model.videoCreditsWithAudioPerSecond
    : model.videoCreditsPerSecond;
  return (rates?.[resolution as VideoResolution] ?? 0) * duration;
}

export function generationCoins(
  modelId: string,
  options: GenerationPriceOptions = {},
): number {
  const model = generationModel(modelId);
  if (!model) return 1;
  // 有解析度/時長費率表 → 表主導（按解析度/時長浮動）；fixedCoins 只是無表模型的
  // 簡化定價。避免 admin 曾設的 fixedCoins 覆寫遮蔽改為表定價的模型（如 pixai-upscale）。
  const hasRateTable =
    (model.kind === "image" && model.imageCredits !== undefined) ||
    (model.kind === "video" &&
      (model.videoCreditsPerSecond !== undefined || model.videoCreditsWithAudioPerSecond !== undefined));
  if (!hasRateTable && model.fixedCoins !== undefined) return model.fixedCoins;
  const rawCoins = generationCredits(modelId, options) / 10;
  const scale = 10 ** PRICING_DECIMALS;
  return Math.max(PRICING_COIN_STEP, Math.round(rawCoins * scale) / scale);
}

export function modelPriceLabel(
  modelId: string,
  options: GenerationPriceOptions = {},
): string {
  const model = generationModel(modelId);
  if (model?.kind === "video") {
    const coinsPerSecond = generationCoins(modelId, {
      ...options,
      durationSeconds: 1,
    });
    return `${coinsPerSecond} 币/秒`;
  }
  return `${generationCoins(modelId, options)} 币/张`;
}

export function resolveSupportedAspectRatio(
  modelId: string,
  requested?: string,
): AspectRatio {
  const model = generationModel(modelId);
  const ratios = model?.aspectRatios ?? ["1:1"];
  return ratios.includes(requested as AspectRatio)
    ? requested as AspectRatio
    : model?.defaultAspectRatio ?? "1:1";
}

export function resolveSupportedResolution(
  modelId: string,
  requested?: string,
): OutputResolution {
  const model = generationModel(modelId);
  const resolutions = model?.resolutions ?? ["1k"];
  return resolutions.includes(requested as OutputResolution)
    ? requested as OutputResolution
    : model?.defaultResolution ?? "1k";
}

export function resolveSupportedDuration(
  modelId: string,
  requested?: number,
): number | undefined {
  const model = generationModel(modelId);
  if (!model?.durations?.length) return undefined;
  return model.durations.includes(Number(requested))
    ? Number(requested)
    : model.defaultDuration ?? model.durations[0];
}

export function aspectRatioFromImageSize(size?: string): AspectRatio {
  const [width, height] = String(size ?? "").split("x").map(Number);
  if (!width || !height) return "1:1";
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}` as AspectRatio;
}

/**
 * 把 "WxH" 尺寸歸類到 1k/2k/4k（改圖/放大等按解析度浮動定價用，前後端共用）：
 * 最大邊 ≤ 1536 → 1k（含 1024x1024、1536x1024、768x1365 等 1K 級輸出），
 * ≤ 3072 → 2k，其餘 4k。非法/缺省回 1k。
 */
export function resolutionFromImageSize(size?: string): ImageResolution {
  const [width, height] = String(size ?? "").split("x").map(Number);
  const maxDim = Math.max(width || 0, height || 0);
  if (maxDim <= 0) return "1k";
  if (maxDim <= 1536) return "1k";
  if (maxDim <= 3072) return "2k";
  return "4k";
}

const IMAGE_SIZE_BY_ASPECT_RATIO: Partial<Record<AspectRatio, string>> = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "16:9": "1792x1024",
  "9:16": "1024x1792",
  "4:3": "1365x1024",
  "3:4": "1024x1365",
  "4:5": "1024x1280",
  "5:4": "1280x1024",
  "21:9": "1792x768",
  "9:21": "768x1792",
  "1:4": "512x2048",
  "4:1": "2048x512",
  "1:8": "384x3072",
  "8:1": "3072x384",
};

/**
 * 所有可作为 workflow.imageSize 落库的尺寸。
 *
 * 之前 generation-workflow.ts 里硬编码了 3 个尺寸的白名单，任何非 1:1 / 3:2 / 2:3
 * 的画幅在写入 workflow 元数据时会被静默丢弃 —— 于是「重试」「回填参数」拿回来的
 * 是 1024x1024，用户改过的画幅无声消失。这里导出唯一真源，白名单从它派生。
 */
export const SUPPORTED_IMAGE_SIZES: string[] = Array.from(
  new Set(Object.values(IMAGE_SIZE_BY_ASPECT_RATIO)),
);

export function imageSizeForAspectRatio(ratio: AspectRatio): string {
  return IMAGE_SIZE_BY_ASPECT_RATIO[ratio] ?? "1024x1024";
}
