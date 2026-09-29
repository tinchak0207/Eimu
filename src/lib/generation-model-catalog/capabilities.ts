import { GENERATION_MODEL_CATALOG } from "./catalog";
import { currentEffectiveCatalog } from "./pricing-overrides";
import { servableUpscaleTiers } from "../generation-core/upscale-tier";
// 數量上限的唯一真源（葉模組，零 import）：能力投射與執行端閘門吃同一顆常數。
// **不得**改從 route 或 biz-image-references 取——那兩者會把 node:/DB 拖進 client bundle。
import { MAX_REQUEST_BATCH_COUNT, MAX_REQUEST_REFERENCE_IMAGES } from "../generation-core/request-limits";
import type { AspectRatio, OutputResolution, GenerationModelDefinition, GenerationCapabilityProjection, GenerationConfigInput, GenerationConfigNormalization, ModelKnowledge, VideoGenerationType, UpscaleTier } from "./types";

/**
 * 視頻提交端 prompt 字元硬上限（POST /v1/videos/generations 的 prompt_too_long 閘）。
 * 與 route.ts 的 MAX_PROMPT_LENGTH 同值——上游 2026-09-19 實測：4000→202、4001→400。
 * 投射到 x_capabilities.promptCharLimit 讓 agent/聚合平台提交前預檢。
 */
export const VIDEO_PROMPT_CHAR_LIMIT = 4000;

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
    // 能力契約（對稱差 D23／P1-7）：揭露「實際會擋人的數字」。
    // 參考圖張數只在模型真的收參考圖時給（不收的模型省略 ⇒ 不輸出空能力宣稱）；
    // 批次數每個模型都給。兩者皆直接取自執行端常數，能力宣告與提交閘門同源。
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
    // 影片生成型別（P1-3）：video 模型恆有值（缺省＝只有普通生成），
    // 非 video 模型不外露——那會變成無意義的空能力宣稱。
    ...(model.kind === "video" ? { videoGenerationTypes: model.videoGenerationTypes ?? (["generate"] as const) } : {}),
    ...(model.kind === "video" ? { promptCharLimit: VIDEO_PROMPT_CHAR_LIMIT } : {}),
    // 超分檔位（P1-4）：只在模型真的宣告超分鏈路時外露，且只外露**可提交**檔位
    // （4K 未校準前不在此列）——不輸出空能力宣稱，也不宣告會被拒收的檔位。
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
 * 影片生成型別能力查詢（P1-3 生成式後期）。真源＝catalog 宣告；
 * 未宣告 ⇒ `["generate"]`（**不升格**：能力宣告缺一即不許提交）。
 * 消費端：generation-core/video-post-production.ts 的能力閘門。
 */
export function modelVideoGenerationTypes(modelId: string): readonly VideoGenerationType[] {
  return generationModel(modelId)?.videoGenerationTypes ?? ["generate"];
}

export function supportsVideoGenerationType(modelId: string, type: VideoGenerationType): boolean {
  return modelVideoGenerationTypes(modelId).includes(type);
}

/**
 * 超分檔位能力查詢（P1-4）。真源＝catalog 宣告；未宣告 ⇒ 空陣列
 * （**不升格**：能力宣告缺一即不許提交，見 generation-core/upscale-tier.ts）。
 * 回傳值＝宣告檔位 ∩ 上游可提交檔位（4K 在 factor 真單校準前不在內）。
 */
export function modelUpscaleTiers(modelId: string): readonly UpscaleTier[] {
  const declared = generationModel(modelId)?.upscaleTiers ?? [];
  return servableUpscaleTiers(declared);
}

/** 該模型此刻宣告的超分檔位（未經可用性過濾）——呼叫端拿去跑提交閘門用。 */
export function declaredUpscaleTiers(modelId: string): readonly UpscaleTier[] {
  return generationModel(modelId)?.upscaleTiers ?? [];
}

export function supportsUpscaleTier(modelId: string, tier: UpscaleTier): boolean {
  return modelUpscaleTiers(modelId).includes(tier);
}

/** 一鍵超分的預設檔位＝該模型最高可提交檔位；不支援超分回 null。 */
export function defaultUpscaleTierFor(modelId: string): UpscaleTier | null {
  const tiers = modelUpscaleTiers(modelId);
  return tiers.length ? tiers[tiers.length - 1] : null;
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
