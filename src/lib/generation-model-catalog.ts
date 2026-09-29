// Barrel：原 1331 行巨档已拆为 ./generation-model-catalog/ 六模组（types / catalog /
// pricing-overrides / capabilities / pricing / resolution）。本档保留原路径作纯
// re-export，匯出面（57 个 export）与全部 importer 不变。
// 依据: docs/plans/2026-08-22-large-file-refactor.md Task 2。

export type { MediaKind, AspectRatio, ImageResolution, VideoResolution, OutputResolution, VideoGenerationType, GenerationModelDefinition, GenerationCapabilityProjection, GenerationConfigInput, NormalizedGenerationConfig, GenerationConfigNormalization, ModelKnowledge, ModelUsageTip, ModelUsageTipParams } from "./generation-model-catalog/types";
export { PRICING_DECIMALS, PRICING_COIN_STEP, PRICING_CREDIT_STEP, ASPECT_RATIO_VALUES } from "./generation-model-catalog/types";
export { GENERATION_MODEL_CATALOG, IMAGE_MODEL_IDS, VIDEO_MODEL_IDS, GENERATION_MODEL_IDS } from "./generation-model-catalog/catalog";
export type { ModelPricingOverride, ModelPricingOverrides } from "./generation-model-catalog/pricing-overrides";
export { normalizeModelPricingOverrides, applyModelPricingOverrides, activeModelPricingOverrides, modelPricingRevision, subscribeModelPricing } from "./generation-model-catalog/pricing-overrides";
export type { AvPipelineKind } from "./generation-model-catalog/capabilities";
export { baseGenerationModel, generationModel, modelKnowledge, resolveGenerationModelId, generationCapabilities, normalizeGenerationConfig, isSupportedGenerationModel, isSupportedImageModel, isSupportedVideoModel, generationPipeline, isSupportedAvModel, modelBaseName, modelPromotionTag, modelAspectRatios, modelResolutions, modelDurations, modelSupportsAudio, modelVideoGenerationTypes, supportsVideoGenerationType, defaultGenerateAudio, defaultAspectRatio, defaultOutputResolution, defaultDuration, resolutionLabel } from "./generation-model-catalog/capabilities";
export type { GenerationPriceOptions } from "./generation-model-catalog/pricing";
export { generationCredits, generationCoins, modelPriceLabel } from "./generation-model-catalog/pricing";
export { resolveSupportedAspectRatio, resolveSupportedResolution, resolveSupportedDuration, aspectRatioFromImageSize, resolutionFromImageSize, SUPPORTED_IMAGE_SIZES, imageSizeForAspectRatio } from "./generation-model-catalog/resolution";
