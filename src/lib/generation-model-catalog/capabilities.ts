import { GENERATION_MODEL_CATALOG } from "./catalog";
import { currentEffectiveCatalog } from "./pricing-overrides";
import { servableUpscaleTiers } from "../generation-core/upscale-tier";
// 数量上限的唯一真源（叶模组，零 import）：能力投射与执行端闸门吃同一颗常数。
// **不得**改从 route 或 biz-image-references 取——那两者会把 node:/DB 拖进 client bundle。
import { MAX_REQUEST_BATCH_COUNT, MAX_REQUEST_REFERENCE_IMAGES } from "../generation-core/request-limits";
import type { AspectRatio, OutputResolution, GenerationModelDefinition, GenerationCapabilityProjection, GenerationConfigInput, GenerationConfigNormalization, ModelKnowledge, VideoGenerationType, UpscaleTier } from "./types";

/**
 * 视频提交端 prompt 字元硬上限（POST /v1/videos/generations 的 prompt_too_long 闸）。
 * 与 route.ts 的 MAX_PROMPT_LENGTH 同值——上游 2026-09-19 实测：4000→202、4001→400。
 * 投射到 x_capabilities.promptCharLimit 让 agent/聚合平台提交前预检。
 */
export const VIDEO_PROMPT_CHAR_LIMIT = 4000;

/** 某模型的基准（未覆写）定义，admin UI 要显示基准价。 */
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
 * 宽容的 model id 解析：精确命中优先；未命中时把空格/底线/点/大小写归一成连字号再比对。
 * 修的是「workflow 节点或 agent 传了显示名风格 id（如 `seedance 2.0`）被 400 挡下」的问题——
 * 同一个模型不该因为分隔符写法不同而报「不支持的模型」。找不到对应时回 null（调用方照旧走原 id 报错）。
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
    // 能力契约（对称差 D23／P1-7）：揭露「实际会挡人的数字」。
    // 参考图张数只在模型真的收参考图时给（不收的模型省略 ⇒ 不输出空能力宣称）；
    // 批次数每个模型都给。两者皆直接取自执行端常数，能力宣告与提交闸门同源。
    maxBatchCount: MAX_REQUEST_BATCH_COUNT,
    ...(model.referenceImages ? { maxReferenceImages: MAX_REQUEST_REFERENCE_IMAGES } : {}),
    audio: model.supportsAudio === true,
    lora: model.supportsLora === true || model.vendor === "PixAI",
    qualityModes: model.kind === "image" && model.resolutions.some((resolution) => resolution === "2k" || resolution === "4k")
      ? ["fast", "quality"]
      : ["fast"],
    defaultAspectRatio: model.defaultAspectRatio,
    defaultResolution: model.defaultResolution,
    ...(model.defaultDuration !== undefined ? { defaultDuration: model.defaultDuration } : {}),
    defaultAudio: model.defaultAudio === true,
    // 影片生成型别（P1-3）：video 模型恒有值（缺省＝只有普通生成），
    // 非 video 模型不外露——那会变成无意义的空能力宣称。
    ...(model.kind === "video" ? { videoGenerationTypes: model.videoGenerationTypes ?? (["generate"] as const) } : {}),
    ...(model.kind === "video" ? { promptCharLimit: VIDEO_PROMPT_CHAR_LIMIT } : {}),
    // 超分档位（P1-4）：只在模型真的宣告超分链路时外露，且只外露**可提交**档位
    // （4K 未校准前不在此列）——不输出空能力宣称，也不宣告会被拒收的档位。
    ...(model.upscaleTiers?.length ? { upscaleTiers: servableUpscaleTiers(model.upscaleTiers) } : {}),
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

/**
 * 影片生成型别能力查询（P1-3 生成式后期）。真源＝catalog 宣告；
 * 未宣告 ⇒ `["generate"]`（**不升格**：能力宣告缺一即不许提交）。
 * 消费端：generation-core/video-post-production.ts 的能力闸门。
 */
export function modelVideoGenerationTypes(modelId: string): readonly VideoGenerationType[] {
  return generationModel(modelId)?.videoGenerationTypes ?? ["generate"];
}

export function supportsVideoGenerationType(modelId: string, type: VideoGenerationType): boolean {
  return modelVideoGenerationTypes(modelId).includes(type);
}

/**
 * 超分档位能力查询（P1-4）。真源＝catalog 宣告；未宣告 ⇒ 空阵列
 * （**不升格**：能力宣告缺一即不许提交，见 generation-core/upscale-tier.ts）。
 * 回传值＝宣告档位 ∩ 上游可提交档位（4K 在 factor 真单校准前不在内）。
 */
export function modelUpscaleTiers(modelId: string): readonly UpscaleTier[] {
  const declared = generationModel(modelId)?.upscaleTiers ?? [];
  return servableUpscaleTiers(declared);
}

/** 该模型此刻宣告的超分档位（未经可用性过滤）——呼叫端拿去跑提交闸门用。 */
export function declaredUpscaleTiers(modelId: string): readonly UpscaleTier[] {
  return generationModel(modelId)?.upscaleTiers ?? [];
}

export function supportsUpscaleTier(modelId: string, tier: UpscaleTier): boolean {
  return modelUpscaleTiers(modelId).includes(tier);
}

/** 一键超分的预设档位＝该模型最高可提交档位；不支援超分回 null。 */
export function defaultUpscaleTierFor(modelId: string): UpscaleTier | null {
  const tiers = modelUpscaleTiers(modelId);
  return tiers.length ? tiers[tiers.length - 1] : null;
}

/** AV 成片链路的管道种类（提交端点与能力探测的路由键）。 */
export type AvPipelineKind = "tts" | "avatar" | "lipsync";

/** 模型所属的 AV 管道；非 AV 模型回 null。 */
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
