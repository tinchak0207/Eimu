// 一稿多版位几何层（2026-09-27）：一次生成，自动出满 13 个版位。
//
// 分层：本档是**纯函式**——只吃数字，不碰 document / Image / fetch，
// node 测试（vitest / tsx --test）可直接跑。像素真正落地由呼叫端负责
// （伺服器端见 ./format-crops-exec，浏览器端见 ./image-edit 的 cropToDataUrl）。
//
// 轮子：
//   - 版位真源 = ../ad-formats 的 AD_SIZE_OPTIONS / AdSizeOption / ratioOfSizeId
//     （禁第二套版位表；id 就是 imageSizeForAspectRatio 的反函数）。
//   - 裁剪几何真源 = ./image-edit 的 PixelRect / clampCropRect（不重写裁剪工具）。
//
// 判定：目标比例相对源图的损失面积 ≤ MAX_CROP_LOSS 走内接裁切（crop），
// 超过就走扩图补边（outpaint）。目标比例以版位 **id 的像素宽高**为准，
// 不用 label 的近似写法——例：1792x1024 的 label 写「16:9」，实为 7:4（1.75）；
// 1024x1792 的 label 写「9:16」，实为 4:7。出图要对齐的是 id 的像素，
// 不是 label 的行销说法。

import { AD_SIZE_OPTIONS, ratioOfSizeId, type AdSizeOption } from "../ad-formats";
import { clampCropRect, type PixelRect } from "./image-edit";

/**
 * 内接裁切可接受的损失面积比上限（25%）。
 *
 * 超过就改走 outpaint：裁切是零成本但有损，扩图有成本但保住原图。
 * 25% 的现实校准（1024×1024 源图）：
 *   5:4 / 4:5 → 损失 20.0% → crop
 *   4:3 / 3:4 → 损失 25.0% → crop（含边界）
 *   3:2 / 2:3 → 损失 33.3% → outpaint
 *   16:9 id（7:4）/ 9:16 id（4:7）→ 损失 42.9% → outpaint
 *   21:9 id（7:3）/ 4:1 → 损失 57.1% / 75.0% → outpaint
 */
export const MAX_CROP_LOSS = 0.25;

/** 扩图需延展的四边像素数（以源图像素尺度计，非目标缩放后尺度）。 */
export interface OutpaintEdges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** crop＝内接裁切；outpaint＝扩图补边；rejected＝明确拒绝（不丢例外）。 */
export type FormatCropMode = "crop" | "outpaint" | "rejected";

export interface FormatCropPlan {
  /** 版位 id（同 AD_SIZE_OPTIONS 的 id）。 */
  id: string;
  label: string;
  /** 版位 id 的约简比例（ratioOfSizeId），非 label 的近似写法。 */
  ratio: string;
  mode: FormatCropMode;
  /** crop 时为置中且像素对齐的裁切框；outpaint / rejected 时为 null。 */
  cropRect: PixelRect | null;
  /** outpaint 时为四边延展像素；crop / rejected 时为 null。 */
  outpaintEdges: OutpaintEdges | null;
  /** 裁掉的面积比（0~1）；outpaint 不裁任何面积故为 0。 */
  lossRatio: number;
  /** 执行后成图尺寸：crop＝裁切框尺寸；outpaint＝源图＋延展；rejected＝0。 */
  outputWidth: number;
  outputHeight: number;
  /** rejected 的原因码。 */
  reason?: string;
}

export interface FormatCropsSummary {
  sourceWidth: number;
  sourceHeight: number;
  /** 源图约简比例；源图尺寸未知时为 ""。 */
  sourceRatio: string;
  cropCount: number;
  outpaintCount: number;
  rejectedCount: number;
  plans: FormatCropPlan[];
}

const SIZE_ID_PATTERN = /^(\d+)x(\d+)$/;

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** "1024x1280" → { width: 1024, height: 1280 }；不合法回 null。 */
function parseSizeId(sizeId: string): { width: number; height: number } | null {
  const matched = SIZE_ID_PATTERN.exec(sizeId ?? "");
  if (!matched) return null;
  const width = Number(matched[1]);
  const height = Number(matched[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function isKnownSource(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

function rejectedPlan(option: AdSizeOption, reason: string): FormatCropPlan {
  return {
    id: option.id,
    label: option.label,
    ratio: ratioOfSizeId(option.id),
    mode: "rejected",
    cropRect: null,
    outpaintEdges: null,
    lossRatio: 0,
    outputWidth: 0,
    outputHeight: 0,
    reason,
  };
}

function planOne(
  sourceWidth: number,
  sourceHeight: number,
  option: AdSizeOption,
  target: { width: number; height: number },
): FormatCropPlan {
  const base = { id: option.id, label: option.label, ratio: ratioOfSizeId(option.id) };
  const targetRatio = target.width / target.height;
  const sourceRatio = sourceWidth / sourceHeight;

  // 比例相同：整张原图就是该版位，零损失零裁切。
  if (Math.abs(targetRatio - sourceRatio) < 1e-9) {
    return {
      ...base,
      mode: "crop",
      cropRect: { x: 0, y: 0, width: sourceWidth, height: sourceHeight },
      outpaintEdges: null,
      lossRatio: 0,
      outputWidth: sourceWidth,
      outputHeight: sourceHeight,
    };
  }

  // 内接最大矩形：目标更窄 → 左右裁；目标更宽 → 上下裁。
  let cropWidth: number;
  let cropHeight: number;
  if (targetRatio < sourceRatio) {
    cropHeight = sourceHeight;
    cropWidth = Math.min(sourceWidth, Math.max(1, Math.round(sourceHeight * targetRatio)));
  } else {
    cropWidth = sourceWidth;
    cropHeight = Math.min(sourceHeight, Math.max(1, Math.round(sourceWidth / targetRatio)));
  }

  const lossRatio = round6(1 - (cropWidth * cropHeight) / (sourceWidth * sourceHeight));

  if (lossRatio <= MAX_CROP_LOSS + 1e-9) {
    // 置中：两侧余量差 ≤1px（奇数余量时左/上少 1px）。clampCropRect 保证整数、
    // 不越界、最小边长 ≥8px。
    const rect = clampCropRect(
      {
        x: Math.floor((sourceWidth - cropWidth) / 2),
        y: Math.floor((sourceHeight - cropHeight) / 2),
        width: cropWidth,
        height: cropHeight,
      },
      sourceWidth,
      sourceHeight,
    );
    return {
      ...base,
      mode: "crop",
      cropRect: rect,
      outpaintEdges: null,
      lossRatio,
      outputWidth: rect.width,
      outputHeight: rect.height,
    };
  }

  // 扩图：原图整张保留（不裁不缩），只把不足的那一维补到目标比例。
  if (targetRatio > sourceRatio) {
    const requiredWidth = Math.max(sourceWidth, Math.round(sourceHeight * targetRatio));
    const extra = requiredWidth - sourceWidth;
    const left = Math.floor(extra / 2);
    const right = extra - left;
    return {
      ...base,
      mode: "outpaint",
      cropRect: null,
      outpaintEdges: { top: 0, right, bottom: 0, left },
      lossRatio: 0,
      outputWidth: sourceWidth + extra,
      outputHeight: sourceHeight,
    };
  }
  const requiredHeight = Math.max(sourceHeight, Math.round(sourceWidth / targetRatio));
  const extra = requiredHeight - sourceHeight;
  const top = Math.floor(extra / 2);
  const bottom = extra - top;
  return {
    ...base,
    mode: "outpaint",
    cropRect: null,
    outpaintEdges: { top, right: 0, bottom, left: 0 },
    lossRatio: 0,
    outputWidth: sourceWidth,
    outputHeight: sourceHeight + extra,
  };
}

/**
 * 源图 + 目标版位清单 → 逐版位 plan。
 *
 * 边界（皆不丢例外）：
 *   - 源图尺寸未知（0 / 负数 / NaN / Infinity）→ 每个版位回 mode:"rejected"、
 *     reason:"unknown_source_size"（维持与 targets 同长度，呼叫端可逐项对位）。
 *   - targets 空清单 / 非阵列 → 回空阵列。
 *   - 版位 id 解析不出宽高 → mode:"rejected"、reason:"unparsable_size_id"。
 *   - 极端比例（1:4 从 16:9 源）→ 照算 outpaint 边界，属合法输出不是错误。
 */
export function planFormatCrops(
  sourceWidth: number,
  sourceHeight: number,
  targets: readonly AdSizeOption[] = AD_SIZE_OPTIONS,
): FormatCropPlan[] {
  const list = Array.isArray(targets) ? targets : [];
  const width = Math.round(Number(sourceWidth));
  const height = Math.round(Number(sourceHeight));
  if (!isKnownSource(width, height)) {
    return list.map((option) => rejectedPlan(option, "unknown_source_size"));
  }
  return list.map((option) => {
    const target = parseSizeId(option.id);
    return target ? planOne(width, height, option, target) : rejectedPlan(option, "unparsable_size_id");
  });
}

/** planFormatCrops ＋ 计数摘要（API 回应直接用）。 */
export function summarizeFormatCrops(
  sourceWidth: number,
  sourceHeight: number,
  targets: readonly AdSizeOption[] = AD_SIZE_OPTIONS,
): FormatCropsSummary {
  const plans = planFormatCrops(sourceWidth, sourceHeight, targets);
  const width = Math.round(Number(sourceWidth));
  const height = Math.round(Number(sourceHeight));
  return {
    sourceWidth: isKnownSource(width, height) ? width : 0,
    sourceHeight: isKnownSource(width, height) ? height : 0,
    sourceRatio: isKnownSource(width, height) ? ratioOfSizeId(`${width}x${height}`) : "",
    cropCount: plans.filter((plan) => plan.mode === "crop").length,
    outpaintCount: plans.filter((plan) => plan.mode === "outpaint").length,
    rejectedCount: plans.filter((plan) => plan.mode === "rejected").length,
    plans,
  };
}
