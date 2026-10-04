// 伺服器端版位裁切执行（**server-only**）。
//
// 为什么独立一档：sharp 是 Node 原生模组（`node:events` 进 browser bundle 会让
// webpack 直接炸，见 dag-png-server.ts 的同一段教训）。本档只给 route / worker
// import，纯几何层（./format-crops.ts）保持零依赖、可被任何地方 import。
//
// 职责边界：本档只做「Buffer + 裁切框 → 新 Buffer」。裁切框怎么算由
// ./format-crops.ts 决定，clamp 由 ./image-edit.ts 的 clampCropRect 决定。

import sharp from "sharp";
import { clampCropRect, type PixelRect } from "./image-edit";

export interface SourceImageInfo {
  width: number;
  height: number;
  /** true＝EXIF 带 90/270 旋转，宽高已按自动旋转后的口径回报。 */
  autoOriented: boolean;
}

/** EXIF orientation 5~8 表示需旋转 90/270，宽高要互换。 */
function swapsAxes(orientation: number | undefined): boolean {
  return typeof orientation === "number" && orientation >= 5 && orientation <= 8;
}

/**
 * 读源图尺寸（自动旋转后口径）。回报的宽高与 cropImage 的 `.rotate()` 输出同坐标系，
 * 两者混用不会错位。
 */
export async function readSourceImageInfo(buffer: Buffer): Promise<SourceImageInfo> {
  const meta = await sharp(buffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const autoOriented = swapsAxes(meta.orientation);
  return autoOriented ? { width: height, height: width, autoOriented } : { width, height, autoOriented };
}

export interface CropImageOptions {
  /** 输出格式，预设 webp（13 版位批量出图时体积可控）。 */
  format?: "webp" | "png";
  /** webp 品质，预设 82。 */
  quality?: number;
}

/**
 * 依裁切框裁出图片。rect 以源图像素座标计，内部先 clamp 再 extract，
 * 并以 `.rotate()` 套用 EXIF 自动旋转（与 readSourceImageInfo 同口径）。
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
