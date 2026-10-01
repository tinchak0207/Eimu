import zlib from "node:zlib";

/**
 * Filmera 渠道圖片去水印清洗模塊（純 JS，無原生依賴）。
 *
 * 事實（實測 1280x720 樣圖）：
 * - 水印位於右下角，半透明淺色 "filmera.ai" 文字。
 * - bbox（相對右下角）：x from w-167 to w-43，y from h-65 to h-47（約 124x18）。
 * - 媒體 URL host 為 media.filmera.ai，RGBA PNG。
 *
 * 失敗安全：任何下載/解碼/編碼異常都 fallback 返回原圖 buffer，絕不擋出圖。
 */

/** 水印 bbox（相對右下角的偏移，負值表示從右/下邊緣往回量）。 */
const WATERMARK_RIGHT_OFFSET_START = 167;
const WATERMARK_RIGHT_OFFSET_END = 43;
const WATERMARK_BOTTOM_OFFSET_START = 65;
const WATERMARK_BOTTOM_OFFSET_END = 47;
/** 修復區外擴像素，避免邊緣殘影。 */
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
  // 下載原圖；任何失敗直接拋給上層 fallback 路徑（本函數內 catch）。
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
    // 下載失敗時無原圖 buffer 可返回，rethrow 讓調用方直接沿用原始 media URL
    // （接入方 try/catch 後回退原 URL，即「絕不擋出圖」）。
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
// 純 JS PNG 編解碼（僅支援 8-bit RGB / RGBA，非交錯）
// ---------------------------------------------------------------------------

interface PngImage {
  width: number;
  height: number;
  channels: number; // 3 (RGB) 或 4 (RGBA)
  /** 像素數據，逐行存儲，length = width * height * channels */
  data: Buffer;
}

// PNG CRC32 表（IEEE 802.3，反射多項式 0xEDB88320），模組級預先建好
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
  // filter 0（None）逐行編碼，最簡可靠
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
// 水印修復
// ---------------------------------------------------------------------------

function cleanPngBuffer(input: Buffer): Buffer {
  const image = decodePng(input);
  const { width, height, channels, data } = image;
  const stride = width * channels;

  // 嚴格水印 bbox（相對右下角），clamp 到圖內
  const bx0 = Math.max(0, width - WATERMARK_RIGHT_OFFSET_START);
  const bx1 = Math.min(width - 1, width - WATERMARK_RIGHT_OFFSET_END);
  const by0 = Math.max(0, height - WATERMARK_BOTTOM_OFFSET_START);
  const by1 = Math.min(height - 1, height - WATERMARK_BOTTOM_OFFSET_END);
  if (bx1 <= bx0 || by1 <= by0) return encodePng(image); // 圖太小，無水印區

  // 修復區 = bbox 外擴 4px（吃掉抗鋸齒邊緣殘影）
  const px0 = Math.max(0, bx0 - PATCH_EXPAND_PX);
  const px1 = Math.min(width - 1, bx1 + PATCH_EXPAND_PX);
  const py0 = Math.max(0, by0 - PATCH_EXPAND_PX);
  const py1 = Math.min(height - 1, by1 + PATCH_EXPAND_PX);

  const patched = Buffer.from(data);
  // 水印是抗鋸齒文字：實心筆畫 alpha≈1.0（純白），反混合 (c-a*255)/(1-a) 對其
  // 無效（信息已丟失），固定 alpha 反推會放大噪聲。實測（1280x720 真圖）：
  // 純插值填充行均值極差 19 vs 反混合 115。直接用邊緣雙線性插值填充整個修復區。
  bilinearFill(patched, data, stride, channels, width, height, px0, py0, px1, py1);

  return encodePng({ width, height, channels, data: patched });
}

/**
 * 用修復區四邊外側像素做雙線性插值填充內部。
 * 從 source（原始像素快照）取樣、寫入 target，避免讀寫同一 buffer 互相污染。
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

// 匯出內部函數僅供測試使用（不屬於對外穩定接口）。
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
