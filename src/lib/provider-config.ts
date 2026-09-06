export type ProviderKey = "image_tinchak";
export type ModelMode = "fast" | "quality";

import {
  ADOBE_FIREFLY_MODEL_ID,
  DEFAULT_IMAGE_MODEL_ID,
  NANO_BANANA_2_MODEL_ID,
  NANO_BANANA_MODEL_ID,
  NANO_BANANA_PRO_MODEL_ID,
  PIXAI_TSUBAKI2_MODEL_ID,
  SUPPORTED_GENERATION_MODEL_IDS,
} from "./image-model-ids.js";
import {
  defaultOutputResolution,
  generationCoins,
  generationModel,
  isSupportedImageModel,
  modelBaseName,
  modelPriceLabel,
  modelPromotionTag,
  type OutputResolution,
} from "./generation-model-catalog";

export {
  ADOBE_FIREFLY_MODEL_ID,
  DEFAULT_IMAGE_MODEL_ID,
  NANO_BANANA_2_MODEL_ID,
  NANO_BANANA_MODEL_ID,
  NANO_BANANA_PRO_MODEL_ID,
  PIXAI_TSUBAKI2_MODEL_ID,
  isSupportedImageModel,
  modelBaseName,
  modelPromotionTag,
};

export function modelDisplayName(modelId: string, mode: ModelMode = "fast"): string {
  const model = generationModel(modelId);
  if (!model) return modelId;
  const resolution = mode === "quality"
    ? model.resolutions.includes("2k") ? "2k" : model.defaultResolution
    : model.resolutions.includes("1k") ? "1k" : model.defaultResolution;
  return `${model.displayName} · ${modelPriceLabel(modelId, { resolution })}`;
}

export function imageGenerationCoins(
  modelId: string,
  mode: ModelMode = "fast",
  outputResolution?: OutputResolution,
): number {
  const model = generationModel(modelId);
  const resolution = outputResolution ?? (mode === "quality"
    ? model?.resolutions.includes("2k") ? "2k" : defaultOutputResolution(modelId)
    : model?.resolutions.includes("1k") ? "1k" : defaultOutputResolution(modelId));
  return generationCoins(modelId, { resolution });
}

export function resolveUpstreamModelId(requestedModelId: string, endpointModelId?: string): string {
  return requestedModelId === DEFAULT_IMAGE_MODEL_ID && endpointModelId ? endpointModelId : requestedModelId;
}

export const PROVIDERS = {
  image_tinchak: {
    displayName: "图像工作室",
    iconPath: "/provider-icons/openai.svg",
    color: "from-slate-200 to-white",
    models: SUPPORTED_GENERATION_MODEL_IDS,
  },
} satisfies Record<
  ProviderKey,
  {
    displayName: string;
    iconPath: string;
    color: string;
    models: string[];
  }
>;

export const MODEL_CONFIGS: Record<ModelMode, Record<ProviderKey, string>> = {
  fast: {
    image_tinchak: DEFAULT_IMAGE_MODEL_ID,
  },
  quality: {
    image_tinchak: DEFAULT_IMAGE_MODEL_ID,
  },
};

export const PROVIDER_ORDER: ProviderKey[] = ["image_tinchak"];

export const initializeProviderRecord = <T>(defaultValue?: T) =>
  Object.fromEntries(PROVIDER_ORDER.map((key) => [key, defaultValue])) as Record<
    ProviderKey,
    T
  >;
