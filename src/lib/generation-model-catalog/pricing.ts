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
  if (!hasRateTable) return 0; // fixedCoins 简化定价的模型没有 credit 表
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
  // 有解析度/时长费率表 → 表主导（按解析度/时长浮动）；fixedCoins 只是无表模型的
  // 简化定价。避免 admin 曾设的 fixedCoins 覆写遮蔽改为表定价的模型（如 pixai-upscale）。
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
