import { generationModel } from "./capabilities";
import type { AspectRatio, ImageResolution, OutputResolution } from "./types";

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
