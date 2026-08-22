import { generationModel } from "./capabilities";
import { PRICING_DECIMALS, PRICING_COIN_STEP } from "./types";
import type { ImageResolution, VideoResolution, OutputResolution } from "./types";

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
