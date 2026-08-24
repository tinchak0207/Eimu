import { GENERATION_MODEL_CATALOG } from "./catalog";
import { currentEffectiveCatalog } from "./pricing-overrides";
import type { AspectRatio, OutputResolution, GenerationModelDefinition, GenerationCapabilityProjection, GenerationConfigInput, GenerationConfigNormalization, ModelKnowledge } from "./types";

/** 某模型的基準（未覆寫）定義，admin UI 要顯示基準價。 */
export function baseGenerationModel(modelId: string): GenerationModelDefinition | null {
  return GENERATION_MODEL_CATALOG[modelId] ?? null;
}

export function generationModel(modelId: string): GenerationModelDefinition | null {
  return currentEffectiveCatalog()[modelId] ?? GENERATION_MODEL_CATALOG[modelId] ?? null;
}

/**
 * 模型卡三字段（擅长/已知缺陷/建议）。无数据的模型返回 null——UI 侧据此
 * 优雅降级，不渲染能力卡入口。走 generationModel() 同一条解析路径，
 * pricing 覆写后的条目同样带 knowledge。
 */
export function modelKnowledge(modelId: string): ModelKnowledge | null {
  return generationModel(modelId)?.knowledge ?? null;
}

/**
 * 寬容的 model id 解析：精確命中優先；未命中時把空格/底線/點/大小寫歸一成連字號再比對。
 * 修的是「workflow 節點或 agent 傳了顯示名風格 id（如 `seedance 2.0`）被 400 擋下」的問題——
 * 同一個模型不該因為分隔符寫法不同而報「不支持的模型」。找不到對應時回 null（調用方照舊走原 id 報錯）。
 */
export function resolveGenerationModelId(modelId: string): string | null {
  const raw = modelId.trim();
  if (!raw) return null;
  if (generationModel(raw)) return raw;
  const normalize = (s: string) => s.trim().toLowerCase().replace(/[\s_.]+/g, "-");
  const wanted = normalize(raw);
  if (!wanted) return null;
  const candidates = new Set([...Object.keys(currentEffectiveCatalog()), ...Object.keys(GENERATION_MODEL_CATALOG)]);
  for (const candidate of candidates) {
    if (normalize(candidate) === wanted) return candidate;
  }
  return null;
}

export function generationCapabilities(modelId: string): GenerationCapabilityProjection | null {
  const model = currentEffectiveCatalog()[modelId] ?? GENERATION_MODEL_CATALOG[modelId];
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

/** AV 成片鏈路的管道種類（提交端點與能力探測的路由鍵）。 */
export type AvPipelineKind = "tts" | "avatar" | "lipsync";

/** 模型所屬的 AV 管道；非 AV 模型回 null。 */
export function generationPipeline(modelId: string): AvPipelineKind | null {
  return generationModel(modelId)?.pipeline ?? null;
}

export function isSupportedAvModel(modelId: string): boolean {
  return generationPipeline(modelId) !== null;
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
