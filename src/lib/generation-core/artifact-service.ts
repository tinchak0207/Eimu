// 产物（artifact）校验与落库。
//
// 现状：`server-history-store.ts` 的 `persistGeneratedImage` 只检查字节数非空、
// 未超过体积上限，就把字节原样写进 Vercel Blob 并回给付费用户 —— 没有魔数校验、
// 没有哈希、没有尺寸探测、也没有"能否被正常解码"的检查。垃圾字节、错误格式、
// 或者体积没超但内容损坏的图片都能"成功"落地。
//
// 这个模块提供三件事：
//   1. validateImageBuffer  —— 对字节做魔数嗅探 + 头部尺寸探测 + sha256，从不抛出
//      （除非传入 null/undefined，那是调用者的编程错误）。
//   2. recordArtifact       —— 把校验结果写进 Postgres 的 artifact 表（control-plane
//      骨架的一部分，目前还没有生产路由调用它，因为还没有 job_id 可挂）。
//   3. validateAndDescribeBase64Image —— 组合 base64 解码 + 上面的校验，供
//      server-history-store.ts 在写 Blob 之前调用。
//
// PNG/JPEG/WEBP 的尺寸都能从头几十字节里读出来，不需要引入解码库：
//   - PNG：签名后紧跟 IHDR chunk，宽高是固定偏移的两个大端 uint32。
//   - JPEG：从 SOI 开始扫 marker，找到 SOF0/SOF2（等 SOFn）读高度/宽度。
//   - WEBP：RIFF 容器里的 VP8 / VP8L / VP8X chunk，各自有自己的打包格式。

import { createHash, randomUUID } from "node:crypto";
import { put } from "@/lib/blob-backend";
import { getGenerationSql, type GenerationSql } from "./database";

export type ArtifactRole = "reference" | "output";

export interface ValidatedImage {
  mimeType: string;
  width: number;
  height: number;
  sha256: string;
}

export type ValidateImageResult = ValidatedImage | { error: string };

export interface RecordArtifactInput {
  jobId: string;
  attemptId?: string | null;
  role: ArtifactRole;
  objectKey?: string | null;
  deliveryUrl?: string | null;
  outputIndex?: number | null;
  validated: ValidatedImage;
  byteSize: number;
  retentionExpiresAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export type ValidateBase64ImageResult =
  | (ValidatedImage & { buffer: Buffer; byteSize: number })
  | { error: string };

export interface PersistedOutputArtifact {
  id: string;
  objectKey: string;
  deliveryUrl: string;
  validated: ValidatedImage;
  byteSize: number;
}

export interface PersistedReferenceInput {
  objectKey: string;
  deliveryUrl: string;
  mimeType: string;
  name: string;
}

// ─────────────────────────────────────────────────────────── 魔数与尺寸探测

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR = Buffer.from("IHDR", "ascii");
const WEBP_RIFF = Buffer.from("RIFF", "ascii");
const WEBP_TAG = Buffer.from("WEBP", "ascii");

function readUInt32BESafe(buffer: Buffer, offset: number): number | null {
  if (offset < 0 || offset + 4 > buffer.length) return null;
  return buffer.readUInt32BE(offset);
}

function readUInt16BESafe(buffer: Buffer, offset: number): number | null {
  if (offset < 0 || offset + 2 > buffer.length) return null;
  return buffer.readUInt16BE(offset);
}

function readUInt24LESafe(buffer: Buffer, offset: number): number | null {
  if (offset < 0 || offset + 3 > buffer.length) return null;
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

/** PNG：签名(8) + chunk length(4) + "IHDR"(4) + width(4) + height(4)，全部大端。 */
function readPngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (!buffer.subarray(12, 16).equals(PNG_IHDR)) return null;
  const width = readUInt32BESafe(buffer, 16);
  const height = readUInt32BESafe(buffer, 20);
  if (!width || !height) return null;
  return { width, height };
}

/** JPEG 的 SOF 系列 marker（基线/渐进式帧头），不含 DHT(C4)/JPG(C8)/DAC(CC)。 */
function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** JPEG：从 SOI 之后逐个 marker 扫描，直到 SOF，读其中的 height/width。 */
function readJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  let pos = 2; // 跳过 FFD8
  while (pos + 4 <= buffer.length) {
    if (buffer[pos] !== 0xff) return null;
    const marker = buffer[pos + 1];
    pos += 2;

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      // 无 payload 的 marker（SOI/TEM/RSTn），继续找下一个。
      continue;
    }
    if (marker === 0xd9) return null; // EOI 之前都没找到 SOF：不是合法/完整的 JPEG 帧。

    const length = readUInt16BESafe(buffer, pos);
    if (length === null || length < 2 || pos + length > buffer.length) return null;

    if (isSofMarker(marker)) {
      const height = readUInt16BESafe(buffer, pos + 3);
      const width = readUInt16BESafe(buffer, pos + 5);
      if (!height || !width) return null;
      return { width, height };
    }

    pos += length;
  }
  return null;
}

/** WEBP：RIFF 容器 + VP8/VP8L/VP8X 子 chunk，三种子格式各自的打包尺寸字段不同。 */
function readWebpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30) return null;
  if (!buffer.subarray(0, 4).equals(WEBP_RIFF) || !buffer.subarray(8, 12).equals(WEBP_TAG)) return null;

  const fourCc = buffer.subarray(12, 16).toString("ascii");
  const dataOffset = 20;

  if (fourCc === "VP8 ") {
    // 3 字节 frame tag + 3 字节起始码(0x9d 0x01 0x2a) + 2x2 字节 14bit 宽高。
    if (buffer[dataOffset + 3] !== 0x9d || buffer[dataOffset + 4] !== 0x01 || buffer[dataOffset + 5] !== 0x2a) {
      return null;
    }
    const rawWidth = readUInt16BESafe(buffer, dataOffset + 6);
    const rawHeight = readUInt16BESafe(buffer, dataOffset + 8);
    if (rawWidth === null || rawHeight === null) return null;
    // 小端存储，取低 14 位。
    const width = ((buffer[dataOffset + 7] << 8) | buffer[dataOffset + 6]) & 0x3fff;
    const height = ((buffer[dataOffset + 9] << 8) | buffer[dataOffset + 8]) & 0x3fff;
    if (!width || !height) return null;
    return { width, height };
  }

  if (fourCc === "VP8L") {
    if (buffer[dataOffset] !== 0x2f) return null; // VP8L 签名字节
    if (dataOffset + 5 > buffer.length) return null;
    const b1 = buffer[dataOffset + 1];
    const b2 = buffer[dataOffset + 2];
    const b3 = buffer[dataOffset + 3];
    const b4 = buffer[dataOffset + 4];
    const bits = b1 | (b2 << 8) | (b3 << 16) | (b4 << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    if (!width || !height) return null;
    return { width, height };
  }

  if (fourCc === "VP8X") {
    // flags(1) + reserved(3) + canvas width-1(3, LE) + canvas height-1(3, LE)。
    const width = readUInt24LESafe(buffer, dataOffset + 4);
    const height = readUInt24LESafe(buffer, dataOffset + 7);
    if (width === null || height === null) return null;
    return { width: width + 1, height: height + 1 };
  }

  return null;
}

function detectMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).equals(WEBP_RIFF) &&
    buffer.subarray(8, 12).equals(WEBP_TAG)
  ) {
    return "image/webp";
  }
  return null;
}

function detectVideoMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return "video/webm";
  return null;
}

/**
 * 音頻魔數嗅探（AV 成片鏈路的 TTS 輸出）：
 *   - mp3：ID3 標頭或 MPEG 幀同步（0xFF Ex/Fx）。
 *   - wav：RIFF 容器 + "WAVE"。
 *   - ogg："OggS" 頁首。
 *   - m4a：MP4 容器的 "ftyp" at offset 4。
 */
export function detectAudioMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return "audio/mpeg";
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE") return "audio/wav";
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
  if (buffer.length >= 8 && buffer.subarray(4, 8).toString("ascii") === "ftyp") return "audio/mp4";
  return null;
}

export function validateOutputMediaBuffer(buffer: Buffer, kind: "image" | "video" | "audio"): ValidateImageResult {
  if (kind === "image") return validateImageBuffer(buffer);
  if (kind === "audio") {
    const mimeType = detectAudioMimeType(buffer);
    if (!mimeType) return { error: "Unsupported or malformed audio output; expected MP3/WAV/OGG/M4A." };
    return {
      mimeType,
      width: 0,
      height: 0,
      sha256: createHash("sha256").update(buffer).digest("hex"),
    };
  }
  const mimeType = detectVideoMimeType(buffer);
  if (!mimeType) return { error: "Unsupported or malformed video output; expected MP4 or WebM." };
  return {
    mimeType,
    width: 0,
    height: 0,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

/**
 * 嗅探魔数确认格式，从头部提取宽高，计算整段字节的 sha256。
 * 只有传入 null/undefined 这种编程错误时才抛异常；格式不认得、头部截断/损坏
 * 都通过 `{ error }` 返回，绝不抛出。
 */
export function validateImageBuffer(buffer: Buffer): ValidateImageResult {
  if (buffer == null) throw new TypeError("validateImageBuffer: buffer 不能为空。");

  const mimeType = detectMimeType(buffer);
  if (!mimeType) return { error: "不支持的图片格式（仅支持 PNG/JPEG/WEBP）。" };

  const dimensions =
    mimeType === "image/png"
      ? readPngDimensions(buffer)
      : mimeType === "image/jpeg"
        ? readJpegDimensions(buffer)
        : readWebpDimensions(buffer);

  if (!dimensions) return { error: "图片头信息损坏或不完整，无法读取尺寸。" };

  const sha256 = createHash("sha256").update(buffer).digest("hex");
  return { mimeType, width: dimensions.width, height: dimensions.height, sha256 };
}

/**
 * 解码 base64（可带 `data:...;base64,` 前缀），校验体积上限与图片合法性。
 * 返回值里带上已解码的 buffer，方便调用方直接拿去写 Blob，不必再解码一次。
 */
export function validateAndDescribeBase64Image(base64: string, maxBytes: number): ValidateBase64ImageResult {
  if (base64 == null) throw new TypeError("validateAndDescribeBase64Image: base64 不能为空。");

  const stripped = base64.replace(/^data:[^;,]*;base64,/, "");
  const buffer = Buffer.from(stripped, "base64");

  if (!buffer.length) return { error: "空图片数据。" };
  if (buffer.length > maxBytes) return { error: "图片超出可持久化的体积上限。" };

  const validated = validateImageBuffer(buffer);
  if ("error" in validated) return validated;

  return { ...validated, buffer, byteSize: buffer.length };
}

/**
 * 把校验结果写进 `artifact` 表。目前没有生产路由调用它 —— 现有的图片生成路由
 * 还没有 job_id 可挂（control plane 尚未接入实际生成流程），先保证函数本身可用、
 * 有测试覆盖，供未来接入时直接调用。
 */
export async function recordArtifact(
  input: RecordArtifactInput,
  sql: GenerationSql = getGenerationSql(),
): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO artifact (
      id, job_id, attempt_id, role, object_key, delivery_url, sha256, mime_type,
      byte_size, width, height, output_index, retention_expires_at, metadata_json
    ) VALUES (
      ${id}, ${input.jobId}, ${input.attemptId ?? null}, ${input.role},
      ${input.objectKey ?? null}, ${input.deliveryUrl ?? null}, ${input.validated.sha256},
      ${input.validated.mimeType}, ${input.byteSize}, ${input.validated.width}, ${input.validated.height},
      ${input.outputIndex ?? null}, ${input.retentionExpiresAt ?? null},
      ${sql.json(JSON.parse(JSON.stringify(input.metadata ?? {})) as never)}
    )
  `;
  return id;
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "video/mp4") return "mp4";
  if (mimeType === "video/webm") return "webm";
  if (mimeType === "audio/mpeg") return "mp3";
  if (mimeType === "audio/wav") return "wav";
  if (mimeType === "audio/ogg") return "ogg";
  if (mimeType === "audio/mp4") return "m4a";
  return "png";
}

async function outputBuffer(input: { base64: string | null; url: string | null }): Promise<Buffer> {
  if (input.base64) {
    const decoded = Buffer.from(input.base64.replace(/^data:[^;,]*;base64,/, ""), "base64");
    if (!decoded.length) throw new Error("Supplier returned an empty image result.");
    return decoded;
  }
  if (!input.url) throw new Error("Supplier returned an empty image result.");
  const response = await fetch(input.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Artifact download failed: HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 25 * 1024 * 1024) throw new Error("Artifact download failed: file exceeds 25 MiB.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error("Artifact download failed: empty or oversized response.");
  return bytes;
}

/** Validate first, then persist immutable output and the durable artifact row. */
export async function persistOutputArtifact(input: {
  jobId: string;
  attemptId: string;
  outputIndex: number;
  base64: string | null;
  url: string | null;
  endpointLabel: string;
  mediaKind?: "image" | "video" | "audio";
  retentionExpiresAt?: Date | null;
}, sql: GenerationSql = getGenerationSql()): Promise<PersistedOutputArtifact> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN is required to persist generation outputs.");
  const buffer = await outputBuffer(input);
  const validated = validateOutputMediaBuffer(buffer, input.mediaKind ?? "image");
  if ("error" in validated) throw new Error(`Malformed generation output: ${validated.error}`);
  const objectKey = `generation/jobs/${input.jobId}/${String(input.outputIndex).padStart(3, "0")}-${validated.sha256.slice(0, 12)}.${extensionForMimeType(validated.mimeType)}`;
  const blob = await put(objectKey, buffer, {
    access: "public",
    contentType: validated.mimeType,
    addRandomSuffix: false,
    cacheControlMaxAge: 31_536_000,
  });
  const id = await recordArtifact({
    jobId: input.jobId,
    attemptId: input.attemptId,
    role: "output",
    objectKey,
    deliveryUrl: blob.url,
    outputIndex: input.outputIndex,
    validated,
    byteSize: buffer.length,
    retentionExpiresAt: input.retentionExpiresAt ?? null,
    metadata: { endpointLabel: input.endpointLabel },
  }, sql);
  return { id, objectKey, deliveryUrl: blob.url, validated, byteSize: buffer.length };
}

/** Reference inputs are immutable Blob objects before task creation; the task then stores their public URLs. */
export async function persistReferenceInput(file: File): Promise<PersistedReferenceInput> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN is required to persist generation reference inputs.");
  const buffer = Buffer.from(await file.arrayBuffer());
  const validated = validateImageBuffer(buffer);
  if ("error" in validated) throw new Error(`Invalid reference image: ${validated.error}`);
  const objectKey = `generation/references/${randomUUID()}.${extensionForMimeType(validated.mimeType)}`;
  const blob = await put(objectKey, buffer, {
    access: "public",
    contentType: validated.mimeType,
    addRandomSuffix: false,
    cacheControlMaxAge: 86_400,
  });
  return {
    objectKey,
    deliveryUrl: blob.url,
    mimeType: validated.mimeType,
    name: file.name || `reference.${extensionForMimeType(validated.mimeType)}`,
  };
}
