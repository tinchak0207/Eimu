import zlib from "node:zlib";

/**
 * Filmera 渠道图片去水印清洗模块（纯 JS，无原生依赖）。
 *
 * 事实（实测 1280x720 样图）：
 * - 水印位于右下角，半透明浅色 "filmera.ai" 文字。
 * - bbox（相对右下角）：x from w-167 to w-43，y from h-65 to h-47（约 124x18）。
 * - 媒体 URL host 为 media.filmera.ai，RGBA PNG。
 *
 * 失败安全：任何下载/解码/编码异常都 fallback 返回原图 buffer，绝不挡出图。
 */

/** 水印 bbox（相对右下角的偏移，负值表示从右/下边缘往回量）。 */
const WATERMARK_RIGHT_OFFSET_START = 167;
const WATERMARK_RIGHT_OFFSET_END = 43;
const WATERMARK_BOTTOM_OFFSET_START = 65;
const WATERMARK_BOTTOM_OFFSET_END = 47;
/** 修复区外扩像素，避免边缘残影。 */
const PATCH_EXPAND_PX = 4;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isFilmeraMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === "media.filmera.ai" || host.endsWith(".media.filmera.ai");
  } catch {
    return false;
  }
}

export interface CleanedMedia {
  buffer: Buffer;
  contentType: string;
}

export async function cleanFilmeraWatermark(
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<CleanedMedia> {
  // 下载原图；任何失败直接抛给上层 fallback 路径（本函数内 catch）。
  let raw: Buffer;
  try {
    const response = await fetch(sourceUrl, { signal });
    if (!response.ok) {
      throw new Error(`filmera media download failed: HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    raw = Buffer.from(arrayBuffer);
  } catch (error) {
    console.warn(
      `[filmera-cleaner] download failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    // 下载失败时无原图 buffer 可返回，rethrow 让调用方直接沿用原始 media URL
    // （接入方 try/catch 后回退原 URL，即「绝不挡出图」）。
    throw error instanceof Error ? error : new Error(String(error));
  }

  try {
    const cleaned = cleanPngBuffer(raw);
    return { buffer: cleaned, contentType: "image/png" };
  } catch (error) {
    console.warn(
      `[filmera-cleaner] clean failed, returning original: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { buffer: raw, contentType: "image/png" };
  }
}

// ---------------------------------------------------------------------------
// 纯 JS PNG 编解码（仅支援 8-bit RGB / RGBA，非交错）
// ---------------------------------------------------------------------------

interface PngImage {
  width: number;
  height: number;
  channels: number; // 3 (RGB) 或 4 (RGBA)
  /** 像素数据，逐行存储，length = width * height * channels */
  data: Buffer;
}

// PNG CRC32 表（IEEE 802.3，反射多项式 0xEDB88320），模组级预先建好
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer, seed = 0): number {
  let crc = seed ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(input: Buffer): PngImage {
  if (input.length < 8 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Buffer[] = [];
  while (offset + 8 <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.subarray(offset + 4, offset + 8).toString("ascii");
    const data = input.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (width <= 0 || height <= 0) throw new Error("invalid PNG dimensions");
  if (bitDepth !== 8) throw new Error(`unsupported bit depth: ${bitDepth}`);
  if (interlace !== 0) throw new Error("interlaced PNG not supported");
  let channels: number;
  switch (colorType) {
    case 2:
      channels = 3;
      break; // RGB
    case 6:
      channels = 4;
      break; // RGBA
    default:
      throw new Error(`unsupported color type: ${colorType}`);
  }

  const rawCompressed = Buffer.concat(idatChunks);
  const rawPixels = zlib.inflateSync(rawCompressed);
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  // unfilter：filter 0-4
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = rawPixels[pos++];
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const byte = rawPixels[pos++];
      const left = x >= channels ? data[rowStart + x - channels] : 0;
      const up = y > 0 ? data[prevStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? data[prevStart + x - channels] : 0;
      switch (filter) {
        case 0:
          data[rowStart + x] = byte;
          break;
        case 1:
          data[rowStart + x] = (byte + left) & 0xff;
          break;
        case 2:
          data[rowStart + x] = (byte + up) & 0xff;
          break;
        case 3:
          data[rowStart + x] = (byte + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          data[rowStart + x] = (byte + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`unknown filter: ${filter}`);
      }
    }
  }
  return { width, height, channels, data };
}

function encodePng(image: PngImage): Buffer {
  const { width, height, channels, data } = image;
  const stride = width * channels;
  // filter 0（None）逐行编码，最简可靠
  const rawPixels = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rawRow = y * (stride + 1);
    rawPixels[rawRow] = 0;
    data.copy(rawPixels, rawRow + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(rawPixels, { level: 6 });

  const chunks: Buffer[] = [PNG_SIGNATURE];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // color type
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  chunks.push(makeChunk("IHDR", ihdr));
  chunks.push(makeChunk("IDAT", compressed));
  chunks.push(makeChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function makeChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  const crcInput = Buffer.concat([Buffer.from(type, "ascii"), data]);
  chunk.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return chunk;
}

// ---------------------------------------------------------------------------
// 水印修复
// ---------------------------------------------------------------------------

function cleanPngBuffer(input: Buffer): Buffer {
  const image = decodePng(input);
  const { width, height, channels, data } = image;
  const stride = width * channels;

  // 严格水印 bbox（相对右下角），clamp 到图内
  const bx0 = Math.max(0, width - WATERMARK_RIGHT_OFFSET_START);
  const bx1 = Math.min(width - 1, width - WATERMARK_RIGHT_OFFSET_END);
  const by0 = Math.max(0, height - WATERMARK_BOTTOM_OFFSET_START);
  const by1 = Math.min(height - 1, height - WATERMARK_BOTTOM_OFFSET_END);
  if (bx1 <= bx0 || by1 <= by0) return encodePng(image); // 图太小，无水印区

  // 修复区 = bbox 外扩 4px（吃掉抗锯齿边缘残影）
  const px0 = Math.max(0, bx0 - PATCH_EXPAND_PX);
  const px1 = Math.min(width - 1, bx1 + PATCH_EXPAND_PX);
  const py0 = Math.max(0, by0 - PATCH_EXPAND_PX);
  const py1 = Math.min(height - 1, by1 + PATCH_EXPAND_PX);

  const patched = Buffer.from(data);
  // 水印是抗锯齿文字：实心笔画 alpha≈1.0（纯白），反混合 (c-a*255)/(1-a) 对其
  // 无效（信息已丢失），固定 alpha 反推会放大噪声。实测（1280x720 真图）：
  // 纯插值填充行均值极差 19 vs 反混合 115。直接用边缘双线性插值填充整个修复区。
  bilinearFill(patched, data, stride, channels, width, height, px0, py0, px1, py1);

  return encodePng({ width, height, channels, data: patched });
}

/**
 * 用修复区四边外侧像素做双线性插值填充内部。
 * 从 source（原始像素快照）取样、写入 target，避免读写同一 buffer 互相污染。
 */
function bilinearFill(
  target: Buffer,
  source: Buffer,
  stride: number,
  channels: number,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const sample = (x: number, y: number, ch: number): number => {
    const cx = Math.max(0, Math.min(width - 1, x));
    const cy = Math.max(0, Math.min(height - 1, y));
    return source[cy * stride + cx * channels + ch];
  };
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const tx = w > 1 ? (x - x0) / (w - 1) : 0;
      const ty = h > 1 ? (y - y0) / (h - 1) : 0;
      const idx = y * stride + x * channels;
      for (let ch = 0; ch < 3; ch++) {
        const top = sample(x, y0 - 1, ch);
        const bottom = sample(x, y1 + 1, ch);
        const left = sample(x0 - 1, y, ch);
        const right = sample(x1 + 1, y, ch);
        const vert = top + (bottom - top) * ty;
        const horiz = left + (right - left) * tx;
        target[idx + ch] = Math.max(0, Math.min(255, Math.round((vert + horiz) / 2)));
      }
      if (channels === 4) {
        target[idx + 3] = sample(x, y, 3);
      }
    }
  }
}

// 汇出内部函数仅供测试使用（不属于对外稳定接口）。
export const __internals = {
  decodePng,
  encodePng,
  cleanPngBuffer,
  WATERMARK_RIGHT_OFFSET_START,
  WATERMARK_RIGHT_OFFSET_END,
  WATERMARK_BOTTOM_OFFSET_START,
  WATERMARK_BOTTOM_OFFSET_END,
  PATCH_EXPAND_PX,
};
