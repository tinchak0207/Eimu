// 伺服器端版位裁切執行（**server-only**）。
//
// 為什麼獨立一檔：sharp 是 Node 原生模組（`node:events` 進 browser bundle 會讓
// webpack 直接炸，見 dag-png-server.ts 的同一段教訓）。本檔只給 route / worker
// import，純幾何層（./format-crops.ts）保持零依賴、可被任何地方 import。
//
// 職責邊界：本檔只做「Buffer + 裁切框 → 新 Buffer」。裁切框怎麼算由
// ./format-crops.ts 決定，clamp 由 ./image-edit.ts 的 clampCropRect 決定。

import sharp from "sharp";
import { clampCropRect, type PixelRect } from "./image-edit";

export interface SourceImageInfo {
  width: number;
  height: number;
  /** true＝EXIF 帶 90/270 旋轉，寬高已按自動旋轉後的口徑回報。 */
  autoOriented: boolean;
}

/** EXIF orientation 5~8 表示需旋轉 90/270，寬高要互換。 */
function swapsAxes(orientation: number | undefined): boolean {
  return typeof orientation === "number" && orientation >= 5 && orientation <= 8;
}

/**
 * 讀源圖尺寸（自動旋轉後口徑）。回報的寬高與 cropImage 的 `.rotate()` 輸出同坐標系，
 * 兩者混用不會錯位。
 */
export async function readSourceImageInfo(buffer: Buffer): Promise<SourceImageInfo> {
  const meta = await sharp(buffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const autoOriented = swapsAxes(meta.orientation);
  return autoOriented ? { width: height, height: width, autoOriented } : { width, height, autoOriented };
}

export interface CropImageOptions {
  /** 輸出格式，預設 webp（13 版位批量出圖時體積可控）。 */
  format?: "webp" | "png";
  /** webp 品質，預設 82。 */
  quality?: number;
}

/**
 * 依裁切框裁出圖片。rect 以源圖像素座標計，內部先 clamp 再 extract，
 * 並以 `.rotate()` 套用 EXIF 自動旋轉（與 readSourceImageInfo 同口徑）。
 */
export async function cropImage(
  buffer: Buffer,
  rect: PixelRect,
  options: CropImageOptions = {},
): Promise<Buffer> {
  const info = await readSourceImageInfo(buffer);
  const safe = clampCropRect(rect, info.width, info.height);
  const pipeline = sharp(buffer)
    .rotate()
    .extract({ left: safe.x, top: safe.y, width: safe.width, height: safe.height });
  return options.format === "png"
    ? pipeline.png().toBuffer()
    : pipeline.webp({ quality: options.quality ?? 82 }).toBuffer();
}
