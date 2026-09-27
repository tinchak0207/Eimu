// 一稿多版位幾何層（2026-09-27）：一次生成，自動出滿 13 個版位。
//
// 分層：本檔是**純函式**——只吃數字，不碰 document / Image / fetch，
// node 測試（vitest / tsx --test）可直接跑。像素真正落地由呼叫端負責
// （伺服器端見 ./format-crops-exec，瀏覽器端見 ./image-edit 的 cropToDataUrl）。
//
// 輪子：
//   - 版位真源 = ../ad-formats 的 AD_SIZE_OPTIONS / AdSizeOption / ratioOfSizeId
//     （禁第二套版位表；id 就是 imageSizeForAspectRatio 的反函數）。
//   - 裁剪幾何真源 = ./image-edit 的 PixelRect / clampCropRect（不重寫裁剪工具）。
//
// 判定：目標比例相對源圖的損失面積 ≤ MAX_CROP_LOSS 走內接裁切（crop），
// 超過就走擴圖補邊（outpaint）。目標比例以版位 **id 的像素寬高**為準，
// 不用 label 的近似寫法——例：1792x1024 的 label 寫「16:9」，實為 7:4（1.75）；
// 1024x1792 的 label 寫「9:16」，實為 4:7。出圖要對齊的是 id 的像素，
// 不是 label 的行銷說法。

import { AD_SIZE_OPTIONS, ratioOfSizeId, type AdSizeOption } from "../ad-formats";
import { clampCropRect, type PixelRect } from "./image-edit";

/**
 * 內接裁切可接受的損失面積比上限（25%）。
 *
 * 超過就改走 outpaint：裁切是零成本但有損，擴圖有成本但保住原圖。
 * 25% 的現實校準（1024×1024 源圖）：
 *   5:4 / 4:5 → 損失 20.0% → crop
 *   4:3 / 3:4 → 損失 25.0% → crop（含邊界）
 *   3:2 / 2:3 → 損失 33.3% → outpaint
 *   16:9 id（7:4）/ 9:16 id（4:7）→ 損失 42.9% → outpaint
 *   21:9 id（7:3）/ 4:1 → 損失 57.1% / 75.0% → outpaint
 */
export const MAX_CROP_LOSS = 0.25;

/** 擴圖需延展的四邊像素數（以源圖像素尺度計，非目標縮放後尺度）。 */
export interface OutpaintEdges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** crop＝內接裁切；outpaint＝擴圖補邊；rejected＝明確拒絕（不丟例外）。 */
export type FormatCropMode = "crop" | "outpaint" | "rejected";

export interface FormatCropPlan {
  /** 版位 id（同 AD_SIZE_OPTIONS 的 id）。 */
  id: string;
  label: string;
  /** 版位 id 的約簡比例（ratioOfSizeId），非 label 的近似寫法。 */
  ratio: string;
  mode: FormatCropMode;
  /** crop 時為置中且像素對齊的裁切框；outpaint / rejected 時為 null。 */
  cropRect: PixelRect | null;
  /** outpaint 時為四邊延展像素；crop / rejected 時為 null。 */
  outpaintEdges: OutpaintEdges | null;
  /** 裁掉的面積比（0~1）；outpaint 不裁任何面積故為 0。 */
  lossRatio: number;
  /** 執行後成圖尺寸：crop＝裁切框尺寸；outpaint＝源圖＋延展；rejected＝0。 */
  outputWidth: number;
  outputHeight: number;
  /** rejected 的原因碼。 */
  reason?: string;
}

export interface FormatCropsSummary {
  sourceWidth: number;
  sourceHeight: number;
  /** 源圖約簡比例；源圖尺寸未知時為 ""。 */
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

  // 比例相同：整張原圖就是該版位，零損失零裁切。
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

  // 內接最大矩形：目標更窄 → 左右裁；目標更寬 → 上下裁。
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
    // 置中：兩側餘量差 ≤1px（奇數餘量時左/上少 1px）。clampCropRect 保證整數、
    // 不越界、最小邊長 ≥8px。
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

  // 擴圖：原圖整張保留（不裁不縮），只把不足的那一維補到目標比例。
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
 * 源圖 + 目標版位清單 → 逐版位 plan。
 *
 * 邊界（皆不丟例外）：
 *   - 源圖尺寸未知（0 / 負數 / NaN / Infinity）→ 每個版位回 mode:"rejected"、
 *     reason:"unknown_source_size"（維持與 targets 同長度，呼叫端可逐項對位）。
 *   - targets 空清單 / 非陣列 → 回空陣列。
 *   - 版位 id 解析不出寬高 → mode:"rejected"、reason:"unparsable_size_id"。
 *   - 極端比例（1:4 從 16:9 源）→ 照算 outpaint 邊界，屬合法輸出不是錯誤。
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

/** planFormatCrops ＋ 計數摘要（API 回應直接用）。 */
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
