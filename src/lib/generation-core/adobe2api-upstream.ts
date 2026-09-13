import {
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
  GPT_IMAGE_25_FLARE_MODEL_ID,
  GPT_IMAGE_25_SUNBURST_MODEL_ID,
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
  RUNWAY_GEN4_IMAGE_MODEL_ID,
  RUNWAY_GEN4_VIDEO_MODEL_ID,
  RUNWAY_GEN45_VIDEO_MODEL_ID,
  SEEDANCE_20_FAST_MODEL_ID,
  SEEDANCE_20_MODEL_ID,
  VEO_31_FAST_MODEL_ID,
  VEO_31_MODEL_ID,
} from "../image-model-ids.js";
import {
  generationModel,
  type AspectRatio,
  type OutputResolution,
} from "../generation-model-catalog";

type ModelMode = "fast" | "quality";

const ADOBE2API_PREFIX: Record<string, string> = {
  [DEFAULT_IMAGE_MODEL_ID]: "firefly-gpt-image",
  [NANO_BANANA_2_MODEL_ID]: "firefly-nano-banana2",
  [ADOBE_FIREFLY_MODEL_ID]: "firefly-image5",
  [NANO_BANANA_PRO_MODEL_ID]: "firefly-nano-banana-pro",
  [GPT_IMAGE_15_MODEL_ID]: "firefly-gpt-image-15",
  [GPT_IMAGE_25_FLARE_MODEL_ID]: "firefly-gpt-image-25-flare",
  [GPT_IMAGE_25_SUNBURST_MODEL_ID]: "firefly-gpt-image-25-prism",
  [NANO_BANANA_MODEL_ID]: "firefly-nano-banana",
  [FLUX_2_PRO_MODEL_ID]: "firefly-flux2-pro",
  [FLUX_2_MODEL_ID]: "firefly-flux2",
  [GPT_IMAGE_MODEL_ID]: "firefly-gpt-4o-image",
  [FLUX_KONTEXT_MAX_MODEL_ID]: "firefly-flux-kontext-max",
  [FLUX_KONTEXT_PRO_MODEL_ID]: "firefly-flux-kontext-pro",
  [FLUX_11_ULTRA_MODEL_ID]: "firefly-flux11-ultra",
  [FLUX_11_PRO_MODEL_ID]: "firefly-flux11-pro",
  [RUNWAY_GEN4_IMAGE_MODEL_ID]: "firefly-runway-gen4-image",
  [VEO_31_FAST_MODEL_ID]: "firefly-veo31-fast",
  [KLING_30_MODEL_ID]: "firefly-kling3",
  [KLING_30_OMNI_MODEL_ID]: "firefly-kling-o3",
  [SEEDANCE_20_FAST_MODEL_ID]: "firefly-seedance2-fast",
  [SEEDANCE_20_MODEL_ID]: "firefly-seedance2",
  [VEO_31_MODEL_ID]: "firefly-veo31",
  [RUNWAY_GEN45_VIDEO_MODEL_ID]: "firefly-runway-gen45",
  [ADOBE_FIREFLY_VIDEO_MODEL_ID]: "firefly-video",
  [LUMA_RAY314_MODEL_ID]: "firefly-luma-ray314",
  [RUNWAY_GEN4_VIDEO_MODEL_ID]: "firefly-runway-gen4",
  [LUMA_RAY3_MODEL_ID]: "firefly-luma-ray3",
  [LUMA_RAY314_HDR_MODEL_ID]: "firefly-luma-ray314-hdr",
  [LUMA_RAY2_FLASH_MODEL_ID]: "firefly-luma-ray2-flash",
  [LUMA_RAY2_MODEL_ID]: "firefly-luma-ray2",
  [LUMA_RAY3_HDR_MODEL_ID]: "firefly-luma-ray3-hdr",
  [KLING_25_TURBO_MODEL_ID]: "firefly-kling25",
};

export function isAdobe2ApiModel(modelId: string): boolean {
  return Object.prototype.hasOwnProperty.call(ADOBE2API_PREFIX, modelId);
}

export function resolveAdobe2ApiImageModelId(
  modelId: string,
  aspectRatio: AspectRatio,
  resolution: OutputResolution,
): string | null {
  const model = generationModel(modelId);
  const prefix = ADOBE2API_PREFIX[modelId];
  if (!model || model.kind !== "image" || !prefix) return null;
  if (!model.aspectRatios.includes(aspectRatio) || !model.resolutions.includes(resolution)) return null;
  return `${prefix}-${resolution}-${aspectRatio.replace(":", "x")}`;
}

export function resolveAdobe2ApiVideoModelId(
  modelId: string,
  aspectRatio: AspectRatio,
  resolution: OutputResolution,
  durationSeconds: number,
): string | null {
  const model = generationModel(modelId);
  const prefix = ADOBE2API_PREFIX[modelId];
  if (!model || model.kind !== "video" || !prefix) return null;
  if (!model.aspectRatios.includes(aspectRatio) || !model.resolutions.includes(resolution)) return null;
  if (!model.durations?.includes(durationSeconds)) return null;
  return `${prefix}-${durationSeconds}s-${aspectRatio.replace(":", "x")}-${resolution}`;
}

const ASPECT_RATIO_BY_SIZE: Record<string, AspectRatio> = {
  "1024x1024": "1:1",
  "1536x1024": "3:2",
  "1024x1536": "2:3",
  "1792x1024": "16:9",
  "1024x1792": "9:16",
};

export function resolveAdobe2ApiModelId(
  modelId: string,
  aspectRatioOrImageSize: string,
  modeOrResolution: ModelMode | OutputResolution,
): string | null {
  const aspectRatio = aspectRatioOrImageSize.includes(":")
    ? aspectRatioOrImageSize as AspectRatio
    : (ASPECT_RATIO_BY_SIZE[aspectRatioOrImageSize] ?? "1:1");
  const resolution: OutputResolution = modeOrResolution === "fast"
    ? "1k"
    : modeOrResolution === "quality"
      ? "2k"
      : modeOrResolution;
  return resolveAdobe2ApiImageModelId(modelId, aspectRatio, resolution);
}
