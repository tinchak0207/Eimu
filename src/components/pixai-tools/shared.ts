"use client";

/**
 * 改图 / 高清放大的共享工具：统一图片来源（上传文件 / 历史图），
 * 并封装 /v1/uploads、/v1/images/edits、/v1/upscale 三个端点的调用。
 *
 * 设计原则（与 ImageStudio C 端一致）：
 *  - 图片来源一律统一成 `{ base64, mimeType }`，生成时才调 /v1/uploads 换 mediaId，
 *  - 所有请求带 `Authorization: Bearer {token}`。
 */

export type PixaiInputKind = "file" | "base64" | "dataUrl" | "httpUrl";

export interface PixaiImageSource {
  kind: PixaiInputKind;
  /** kind === "file" 时的原始 File。 */
  file?: File;
  /** kind === "base64" 时是裸 base64（不含 data: 前缀）。 */
  base64?: string;
  /** kind === "dataUrl" / "httpUrl" 时的 url。 */
  url?: string;
  mimeType?: string;
}

export interface PickedImage {
  /** 生成时需要的图片来源描述。 */
  source: PixaiImageSource;
  /** 本地/远程预览 url。上传文件是 URL.createObjectURL，历史图是原 url。 */
  previewUrl: string;
  label: string;
}

export interface PixaiSourcePayload {
  base64: string;
  mimeType: string;
}

/** 前端文件大小上限与下限。 */
export const PIXAI_MAX_BYTES = 20_000_000;
export const PIXAI_MIN_BYTES = 4_000;

/** 上传 / 生成失败时抛出的错误，UI 端统一用 message 展示。 */
export class PixaiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "PixaiError";
    this.status = status;
  }
}

async function assertOk(res: Response): Promise<unknown> {
  if (res.ok) return null;
  const body = await res.json().catch(() => null);
  const msg =
    body?.message ||
    body?.error?.message ||
    (Array.isArray(body?.data)
      ? body.data.map((d: { message?: string }) => d.message).filter(Boolean).join("；")
      : "") ||
    `请求失败（HTTP ${res.status}）`;
  throw new PixaiError(String(msg), res.status);
}

/** 从 http URL 取回图片字节，转 base64（历史图是 http URL 时的路径）。 */
async function urlToPayload(url: string): Promise<PixaiSourcePayload> {
  const res = await fetch(url);
  if (!res.ok) throw new PixaiError("读取图片失败，请换个来源。");
  const blob = await res.blob();
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);
  if (base64.length < PIXAI_MIN_BYTES) throw new PixaiError("图片过小，无法处理（需大于 4KB）。");
  return { base64, mimeType: blob.type || "image/png" };
}

function fileToPayload(file: File): Promise<PixaiSourcePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const meta = /^data:([^;]+);base64,(.*)$/.exec(result);
      try {
        resolve({
          base64: meta?.[2] ?? result,
          mimeType: meta?.[1] ?? file.type ?? "image/png",
        });
      } catch {
        reject(new PixaiError("图片读取失败。"));
      }
    };
    reader.onerror = () => reject(new PixaiError("图片读取失败。"));
    reader.readAsDataURL(file);
  });
}

/** 把任意图片来源归一化为 base64 + mimeType。 */
export async function resolveToPayload(source: PixaiImageSource): Promise<PixaiSourcePayload> {
  if (source.kind === "file" && source.file) {
    if (source.file.size > PIXAI_MAX_BYTES) throw new PixaiError("图片不能超过 20MB。");
    if (source.file.size < PIXAI_MIN_BYTES) throw new PixaiError("图片过小（需大于 4KB），PixAI 拒绝。");
    return fileToPayload(source.file);
  }
  if (source.kind === "base64" && source.base64) {
    return { base64: source.base64, mimeType: source.mimeType ?? "image/png" };
  }
  if (source.kind === "dataUrl" && source.url) {
    const meta = /^data:([^;]+);base64,(.*)$/.exec(source.url);
    if (!meta) throw new PixaiError("无法解析数据图片。");
    return { base64: meta[2], mimeType: meta[1] ?? "image/png" };
  }
  if (source.kind === "httpUrl" && source.url) {
    return urlToPayload(source.url);
  }
  throw new PixaiError("缺少图片来源。");
}

/** 上传更晚 60s（实测 ~1s 同步；留缓冲处理大图）。 */
const UPLOAD_TIMEOUT_MS = 60_000;
/** 改图 / 放大同步阻塞（实测 ~10s / ~22s），对齐 bridge deadline 240s。 */
const GENERATE_TIMEOUT_MS = 240_000;

/** 上传 base64 到 /api/pixai/upload，返回 mediaId。 */
export async function uploadMedia(payload: PixaiSourcePayload, token: string, userId: number): Promise<string> {
  const res = await fetch("/api/pixai/upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-User-Id": String(userId),
    },
    body: JSON.stringify({ data: payload.base64, mimeType: payload.mimeType }),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  await assertOk(res);
  const body = (await res.json().catch(() => null)) as { mediaId?: string } | null;
  const mediaId = typeof body?.mediaId === "string" ? body.mediaId : "";
  if (!mediaId) throw new PixaiError("上传失败：未返回 mediaId。");
  return mediaId;
}

/** 改图 → /api/pixai/edit，返回成图 URL（或 base64 data URL）。 */
export async function runEdit(args: {
  mediaId: string;
  prompt: string;
  size: string;
  token: string;
  userId: number;
}): Promise<string> {
  const res = await fetch("/api/pixai/edit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.token}`,
      "X-User-Id": String(args.userId),
    },
    body: JSON.stringify({
      image: args.mediaId,
      prompt: args.prompt,
      size: args.size,
      n: 1,
    }),
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });
  await assertOk(res);
  const body = (await res.json().catch(() => null)) as
    | { data?: Array<{ url?: string; b64_json?: string }>; url?: string; images?: Array<{ url?: string; base64?: string }> }
    | null;
  const first = Array.isArray(body?.data) ? body.data[0] : undefined;
  const url = first?.url || first?.b64_json || body?.url || (Array.isArray(body?.images) ? body.images[0]?.url ?? body.images[0]?.base64 ?? "" : "");
  if (!url) throw new PixaiError("改图失败：未返回图片。");
  return url;
}

/** 高清放大 → /api/pixai/upscale，返回放大后图片 URL。size 为原图 "WxH"，用于解析度计费。 */
export async function runUpscale(args: {
  mediaId: string;
  factor?: number;
  size?: string;
  token: string;
  userId: number;
}): Promise<string> {
  const res = await fetch("/api/pixai/upscale", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.token}`,
      "X-User-Id": String(args.userId),
    },
    body: JSON.stringify({
      image: args.mediaId,
      factor: args.factor ?? 2,
      ...(args.size ? { size: args.size } : {}),
    }),
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });
  await assertOk(res);
  const body = (await res.json().catch(() => null)) as
    | { data?: Array<{ url?: string; b64_json?: string }>; url?: string; images?: Array<{ url?: string; base64?: string }> }
    | null;
  const first = Array.isArray(body?.data) ? body.data[0] : undefined;
  const url = first?.url || first?.b64_json || body?.url || (Array.isArray(body?.images) ? body.images[0]?.url ?? body.images[0]?.base64 ?? "" : "");
  if (!url) throw new PixaiError("放大失败：未返回图片。");
  return url;
}