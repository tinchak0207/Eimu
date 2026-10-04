// 两段式上传（Dramagic 对称差 D36）的共用轮子。
//
//   第一段：POST /api/uploads/sign    → 只收 metadata，回 { uploadUrl, clientToken, objectKey, expiresInMs }
//   第二段：POST /api/uploads/commit  → 把 objectKey 回写进拥有者纪录（＋同步入资产库）才算入库
//
// 对称差原文口径（Dramagic 全站 269–272 / 286 / 303 行）：
//   `UploadFileUrl{Type,Target:"temp",Suffix,ProjectId}` → `{Url, TosKey, Expires:3600, DownloadTosUrl}`
//   ⇒ 先取 1 小时签名 PUT URL，再「直传物件存储」；上传完要 `UpdateImageImage{ImageId, TosKey}` 才算入库。
//
// 本档后端选择**不另立第二套判断**，直接复用 `blob-backend.ts`（单一真源）：
//   * Vercel Blob（BLOB_READ_WRITE_TOKEN）→ 走 `@vercel/blob/client` 的 `handleUpload` 签发客户端
//     token，客户端拿 token 直接 PUT 到 Vercel Blob 的 API 主机（`vercel.com/api/blob`），
//     位元组不经过本站伺服器。
//   * VPS `image-data-api`（IMAGE_DATA_BASE_URL + IMAGE_DATA_API_KEY）→ **无法签发**：该服务的
//     `PUT /api/blob/:path(*)` 只认静态母钥 `x-image-data-key`，没有任何 per-upload 的
//     presign/短效签名端点（VPS `/opt/image-data-api/server.js` 实查，端点全集＝
//     list/get/put/delete/files）。把母钥下发浏览器＝泄漏后端主凭证 ⇒ 诚实回具名错误码
//     `vps_blob_direct_upload_unsupported`，不假装成功、也不用「本站中转」冒充直传。

import { createHash, randomBytes } from "node:crypto";
import { handleUpload } from "@vercel/blob/client";
import { get, useVpsBlobBackend } from "@/lib/blob-backend";
import { sanitizeBlobSegment } from "@/lib/history-types";
import { saveAssetPack, listAssetPacks } from "@/lib/asset-pack-store";
import type { AssetPack } from "@/lib/asset-pack-store";
import {
  listUploadedObjects,
  upsertUploadedObject,
} from "@/lib/upload-record-store";
import type { UploadedObjectRecord } from "@/lib/upload-record-store";

export type { UploadedObjectRecord };

/** 签名有效期（对齐 Dramagic `Expires:3600`）。 */
export const UPLOAD_SIGN_TTL_MS = 60 * 60 * 1000;

/** 单档上限（视频素材留裕度；超过即拒，不静默截断）。 */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/** 物件键命名空间（与 asset-packs/ 、generation/ 分开，互不干扰）。 */
export const UPLOAD_OBJECT_KEY_PREFIX = "uploads";

/** 内容型别白名单：媒体档＋3D 模型，不收 `application/octet-stream`（逼呼叫端讲清楚是什么）。 */
export const ALLOWED_UPLOAD_CONTENT_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
  "audio/aac",
  // 3D 模型（画布 3D 场景卡导入；实际呼叫端只送 .glb/.gltf，见
  // `src/lib/canvas/scene-3d-import.ts` 的 SCENE_3D_EXTENSIONS）。型别是标准 IANA 注册。
  "model/gltf-binary",
  "model/gltf+json",
];

/** 第一段直传凭证的后端判定结果。 */
export type DirectUploadBackend = "vercel-blob" | "vps-blob" | "unconfigured";

/** 两段式上传的具名错误（route 直接把它转成错误体，不吞）。 */
export class UploadSignError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UploadSignError";
  }
}

/**
 * 后端判定：**不抄第二份 env 判断**，VPS 走 `blob-backend` 的既有选择器。
 * Vercel 分支必须显式看到 BLOB_READ_WRITE_TOKEN——只有它才能签发直传凭证。
 */
export function resolveDirectUploadBackend(
  env: Record<string, string | undefined> = process.env,
): DirectUploadBackend {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- 非 hook：blob-backend 同步选择器（见 blob-backend.ts）
  if (useVpsBlobBackend()) return "vps-blob";
  if (env.BLOB_READ_WRITE_TOKEN?.trim()) return "vercel-blob";
  return "unconfigured";
}

/**
 * 直传目标主机（供回报/取证用，非我方网域）。
 * 与 `@vercel/blob` 的 `getApiUrl()` 同源：`VERCEL_BLOB_API_URL` →
 * `NEXT_PUBLIC_VERCEL_BLOB_API_URL` → 预设 `https://vercel.com/api/blob`。
 */
export function directUploadTarget(
  env: NodeJS.ProcessEnv = process.env,
): { endpoint: string; host: string } {
  const base =
    env.VERCEL_BLOB_API_URL?.trim() ||
    env.NEXT_PUBLIC_VERCEL_BLOB_API_URL?.trim() ||
    "https://vercel.com/api/blob";
  let host = base;
  try {
    host = new URL(base).host;
  } catch {
    // 非法 URL 原样带出，让回报看得见坏值。
  }
  return { endpoint: base, host };
}

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "model/gltf-binary": "glb",
  "model/gltf+json": "gltf",
};

/**
 * 已知 3D 副档名 → 内容型别。**只在** contentType 为空或 `application/octet-stream` 时当推导依据：
 * 浏览器对 .glb/.gltf 常回空 type 或 octet-stream（尤其非 Chromium 内建映射时），此时靠副档名补正。
 * **不**对影像／影片放行 octet-stream —— 白名单「逼呼叫端讲清楚」的意图只对 3D 开这个有界缺口。
 */
const CONTENT_TYPE_BY_3D_EXTENSION: Record<string, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
};

function contentTypeFrom3DExtension(filename?: string): string | null {
  const name = typeof filename === "string" ? filename.trim().toLowerCase() : "";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return CONTENT_TYPE_BY_3D_EXTENSION[name.slice(dot + 1)] ?? null;
}

function fail(status: number, code: string, message: string): never {
  throw new UploadSignError(status, code, message);
}

/**
 * 内容型别必须在白名单内（`; charset=` 等参数先剥掉）。
 *
 * `filename` 为**可选**：仅当 `contentType` 为空或 `application/octet-stream` 时，
 * 用来对**已知 3D 副档名**（.glb/.gltf）推导正确型别。其他情况一律走白名单，
 * 不把 octet-stream 全域放行。
 */
export function normalizeUploadContentType(raw: unknown, filename?: string): string {
  const value = typeof raw === "string" ? raw.trim().toLowerCase().split(";")[0].trim() : "";
  if (!value || value === "application/octet-stream") {
    const implied = contentTypeFrom3DExtension(filename);
    if (implied) return implied;
  }
  if (!value) fail(400, "missing_content_type", "contentType 必填（例如 image/png、video/mp4）。");
  if (!ALLOWED_UPLOAD_CONTENT_TYPES.includes(value)) {
    fail(415, "unsupported_content_type", `不支援的内容型别 ${value}（可用：${ALLOWED_UPLOAD_CONTENT_TYPES.join(" / ")}）。`);
  }
  return value;
}

/** `uploads/<userId>/<YYYYMMDD>/<8hex>-<name>.<ext>`（owner 前缀是回写时的授权依据）。 */
export function buildUploadObjectKey(input: {
  userId: number;
  filename?: string;
  contentType: string;
  now?: Date;
  token?: string;
}): string {
  if (!Number.isFinite(input.userId)) fail(401, "invalid_user", "使用者身分无效。");
  const contentType = normalizeUploadContentType(input.contentType, input.filename);
  const ext = EXTENSION_BY_CONTENT_TYPE[contentType] ?? "bin";
  const rawName = typeof input.filename === "string" ? input.filename.trim() : "";
  const base = sanitizeBlobSegment(rawName.replace(/\.[A-Za-z0-9]{1,8}$/, ""), "upload").slice(0, 48);
  const now = input.now ?? new Date();
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const token = (input.token ?? randomBytes(4).toString("hex")).replace(/[^a-f0-9]/gi, "").slice(0, 8) || "00000000";
  return `${UPLOAD_OBJECT_KEY_PREFIX}/${input.userId}/${day}/${token}-${base}.${ext}`;
}

/**
 * 回写授权：objectKey 必须落在呼叫者自己的 `uploads/<userId>/` 前缀下。
 * 任何越界（他人前缀 / `..` / 反斜线 / 绝对路径 / 超长）一律 403，不退回、不猜。
 */
export function assertUploadObjectKeyOwnedBy(objectKey: unknown, userId: number): string {
  const value = typeof objectKey === "string" ? objectKey.trim() : "";
  if (!value) fail(400, "missing_object_key", "objectKey 必填。");
  if (value.length > 512) fail(400, "object_key_too_long", "objectKey 过长（上限 512）。");
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    fail(400, "invalid_object_key", "objectKey 形状非法。");
  }
  const segments = value.split("/");
  if (segments.some((s) => !s || s === "." || s === "..")) {
    fail(400, "invalid_object_key", "objectKey 形状非法（不得含空段或 . / ..）。");
  }
  const prefix = `${UPLOAD_OBJECT_KEY_PREFIX}/${userId}/`;
  if (!value.startsWith(prefix)) {
    fail(403, "object_key_not_owned", "objectKey 不属于目前使用者。");
  }
  return value;
}

/** 物件的公网读取 URL（Vercel Blob 由 storeId 推；VPS 由 IMAGE_DATA_BASE_URL 推）。 */
export function publicObjectUrl(objectKey: string): string | null {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- 非 hook：blob-backend 同步选择器（见 blob-backend.ts）
  if (useVpsBlobBackend()) {
    const base = process.env.IMAGE_DATA_BASE_URL?.trim().replace(/\/+$/, "");
    return base ? `${base}/files/${objectKey}` : null;
  }
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  const storeId = token ? token.split("_")[3] ?? "" : "";
  return storeId ? `https://${storeId}.public.blob.vercel-storage.com/${objectKey}` : null;
}

export interface DirectUploadCredential {
  backend: DirectUploadBackend;
  objectKey: string;
  /** 客户端直传用的方法/端点（目标主机＝物件存储，非本站）。 */
  method: "PUT";
  uploadUrl: string;
  /** `@vercel/blob/client` 的客户端 token（带 store id 与 pathname 绑定、含到期时间）。 */
  clientToken: string;
  access: "public";
  contentType: string;
  maxBytes: number;
  expiresInMs: number;
  expiresAt: string;
  /** 直传完成后该物件的公网 URL（仅供提示；入库与否看第二段）。 */
  downloadUrl: string | null;
  /** 官方 `@vercel/blob/client` 协议的事件型别（客户端 `upload()` 需要）。 */
  type: "blob.generate-client-token";
  /**
   * VPS 后端直传要带的标头（x-upload-ticket / -path / -expires / x-content-type）。
   * 客户端据 `backend` 分流：`vps-blob` ⇒ `fetch(uploadUrl,{method:"PUT",headers,body})`；
   * `vercel-blob` ⇒ `@vercel/blob/client` 的 `upload()`（用 clientToken，不读本栏）。
   */
  headers?: Record<string, string>;
}

/**
 * VPS 后端（image-data-api）的第一段：取短效签名直传凭证。
 *
 * 母钥 `IMAGE_DATA_API_KEY` **只在本函式内使用、永不下发浏览器**；下发的是
 * HMAC(pathname + expires) 签名，只能对「这一个 pathname」在有效期内 PUT 一次。
 * 端点 `POST /api/blob/presign` 是 2026-09-29 为两段式上传新增的（旧部署没有 ⇒
 * 回 404/405 ⇒ 转译成原本的具名错误 `vps_blob_direct_upload_unsupported`，不假装成功）。
 * `maxBytes` 取签名端点回报的真实上限（VPS 管线 ≠ Vercel 上限），不沿用本档常数。
 */
export async function issueVpsBlobDirectUploadCredential(input: {
  objectKey: string;
  contentType: string;
  /** 测试注入点。 */
  fetchFn?: typeof fetch;
}): Promise<DirectUploadCredential> {
  const base = process.env.IMAGE_DATA_BASE_URL?.trim().replace(/\/+$/, "");
  const key = process.env.IMAGE_DATA_API_KEY?.trim();
  if (!base || !key) fail(503, "blob_backend_unconfigured", "缺少 IMAGE_DATA_BASE_URL 或 IMAGE_DATA_API_KEY。");

  const call = input.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await call(`${base}/api/blob/presign`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-image-data-key": key },
      body: JSON.stringify({
        pathname: input.objectKey,
        contentType: input.contentType,
        expiresInMs: UPLOAD_SIGN_TTL_MS,
      }),
    });
  } catch {
    fail(502, "presign_unreachable", "物件存储的签名端点连线失败，请稍后再试。");
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 405) {
      fail(
        501,
        "vps_blob_direct_upload_unsupported",
        "目前物件储存后端是 VPS image-data-api，但该部署没有签名端点（POST /api/blob/presign）。" +
          "需先部署带签名端点的 image-data-api 才能开通两段式直传。",
      );
    }
    fail(502, "presign_failed", `物件存储拒绝签发直传凭证（HTTP ${response.status}）。`);
  }

  const body = (await response.json()) as {
    url?: unknown;
    ticket?: unknown;
    headers?: unknown;
    contentType?: unknown;
    expiresAt?: unknown;
    expiresInMs?: unknown;
    maxBytes?: unknown;
  };
  const uploadUrl = typeof body.url === "string" ? body.url : "";
  const ticket = typeof body.ticket === "string" ? body.ticket : "";
  if (!uploadUrl || !ticket) fail(502, "presign_malformed", "物件存储回传的直传凭证形状不完整。");
  const headers =
    body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)
      ? (body.headers as Record<string, string>)
      : { "x-upload-ticket": ticket, "x-upload-path": input.objectKey };
  const expiresInMs =
    typeof body.expiresInMs === "number" && Number.isFinite(body.expiresInMs) && body.expiresInMs > 0
      ? body.expiresInMs
      : UPLOAD_SIGN_TTL_MS;
  const maxBytes =
    typeof body.maxBytes === "number" && Number.isFinite(body.maxBytes) && body.maxBytes > 0
      ? Math.min(body.maxBytes, MAX_UPLOAD_BYTES)
      : MAX_UPLOAD_BYTES;

  return {
    type: "blob.generate-client-token",
    backend: "vps-blob",
    objectKey: input.objectKey,
    method: "PUT",
    uploadUrl,
    clientToken: ticket,
    access: "public",
    contentType: input.contentType,
    maxBytes,
    expiresInMs,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : new Date(Date.now() + expiresInMs).toISOString(),
    downloadUrl: publicObjectUrl(input.objectKey),
    headers,
  };
}

/**
 * 第一段：签发直传凭证。**呼叫端保证请求体不含档案位元组**（本函式也只吃 metadata）。
 *
 * 两种后端都走同一套契约：VPS ⇒ `issueVpsBlobDirectUploadCredential`（短效签名）；
 * Vercel Blob ⇒ `handleUpload` 的 client token。
 */
export async function issueDirectUploadCredential(input: {
  userId: number;
  filename?: string;
  contentType: string;
  size?: number;
  /** 官方协议由客户端指定 pathname 时带入——仍必须通过 owner 前缀检查。 */
  pathname?: string;
  /** `handleUpload` 需要原始 Request 以解析（不设 callback，回写走第二段）。 */
  request: Request;
  /** 测试注入点。 */
  handleUploadFn?: typeof handleUpload;
  /** 测试注入点（VPS 分支打签名端点用）。 */
  fetchFn?: typeof fetch;
}): Promise<DirectUploadCredential> {
  const backend = resolveDirectUploadBackend();
  if (backend === "unconfigured") {
    fail(
      503,
      "blob_backend_unconfigured",
      "物件储存后端未设定：请设 BLOB_READ_WRITE_TOKEN（Vercel Blob）或 IMAGE_DATA_BASE_URL + IMAGE_DATA_API_KEY（VPS）。",
    );
  }

  const contentType = normalizeUploadContentType(input.contentType, input.filename);
  if (typeof input.size === "number" && Number.isFinite(input.size)) {
    if (input.size <= 0) fail(400, "invalid_size", "size 必须大于 0。");
    if (input.size > MAX_UPLOAD_BYTES) {
      fail(413, "upload_too_large", `档案过大（${input.size} bytes > 上限 ${MAX_UPLOAD_BYTES}）。`);
    }
  }

  const objectKey = input.pathname
    ? assertUploadObjectKeyOwnedBy(input.pathname, input.userId)
    : buildUploadObjectKey({
        userId: input.userId,
        filename: input.filename,
        contentType,
      });

  // VPS 后端：向 image-data-api 取短效签名（母钥不出站），凭证形状与 Vercel 分支分岔。
  if (backend === "vps-blob") {
    return issueVpsBlobDirectUploadCredential({
      objectKey,
      contentType,
      ...(input.fetchFn === undefined ? {} : { fetchFn: input.fetchFn }),
    });
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) fail(503, "blob_backend_unconfigured", "缺少 BLOB_READ_WRITE_TOKEN，无法签发直传凭证。");

  const validUntil = Date.now() + UPLOAD_SIGN_TTL_MS;
  const call = input.handleUploadFn ?? handleUpload;
  const result = await call({
    token,
    request: input.request,
    // 官方协议的请求体（本函式在 metadata 形状下就地合成同一份，两个入口共用一套策略）。
    body: {
      type: "blob.generate-client-token",
      payload: { pathname: objectKey, clientPayload: null, multipart: false },
    },
    // 不设 onUploadCompleted：入库是**第二段**（/api/uploads/commit）的职责，
    // 不依赖 Vercel Blob 的 webhook 回呼（本地开发也打不进来）。
    onBeforeGenerateToken: async () => ({
      allowedContentTypes: [...ALLOWED_UPLOAD_CONTENT_TYPES],
      maximumSizeInBytes: MAX_UPLOAD_BYTES,
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 31_536_000,
      validUntil,
    }),
  });

  if (result.type !== "blob.generate-client-token") {
    fail(500, "unexpected_upload_event", "签发直传凭证时收到非预期的事件型别。");
  }

  const target = directUploadTarget();
  return {
    type: "blob.generate-client-token",
    backend,
    objectKey,
    method: "PUT",
    uploadUrl: target.endpoint,
    clientToken: result.clientToken,
    access: "public",
    contentType,
    maxBytes: MAX_UPLOAD_BYTES,
    expiresInMs: UPLOAD_SIGN_TTL_MS,
    expiresAt: new Date(validUntil).toISOString(),
    downloadUrl: publicObjectUrl(objectKey),
  };
}

// ─────────────────────────────────────────── 第二段：回写 key 入库

/** 同步入资产库用的固定包 id（每人一个「上传资产」包，新项在前）。 */
export const UPLOAD_ASSET_PACK_ID = "uploaded-assets";
export const UPLOAD_ASSET_PACK_TITLE = "上传资产";

interface ResolvedObject {
  url: string;
  size: number;
  contentType: string | null;
  stream: ReadableStream<Uint8Array> | null;
}

/**
 * 把 `blob-backend.get()` 的两种后端回传形状（Vercel 的 `{statusCode,stream,blob}` /
 * VPS 的 `{url,size,statusCode,stream}`）收敛成一个。取不到回 null（呼叫端诚实 404）。
 * **只取一次**：回传的 stream 交给呼叫端串流算杂凑，不重复下载。
 */
async function resolveStoredObject(objectKey: string): Promise<ResolvedObject | null> {
  const raw = (await get(objectKey, { access: "public" })) as unknown;
  if (!raw || typeof raw !== "object") return null;
  const record = raw as {
    statusCode?: number;
    stream?: ReadableStream<Uint8Array> | null;
    url?: string;
    size?: number;
    blob?: { url?: string; size?: number; contentType?: string };
  };
  const statusCode = typeof record.statusCode === "number" ? record.statusCode : 200;
  if (statusCode !== 200) return null;
  return {
    url: record.blob?.url ?? record.url ?? publicObjectUrl(objectKey) ?? "",
    size: Number(record.blob?.size ?? record.size ?? 0),
    contentType: record.blob?.contentType ?? null,
    stream: record.stream ?? null,
  };
}

/** 串流杂凑：O(1) 记忆体，不把大档整包读进 buffer。 */
async function hashStream(stream: ReadableStream<Uint8Array> | null): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  if (stream) {
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
      hash.update(buf);
      bytes += buf.length;
    }
  }
  return { sha256: hash.digest("hex"), bytes };
}

export interface CommitUploadResult {
  record: UploadedObjectRecord;
  /** 同步入库的资产包（＝消费路径：GET /api/assets 可见）。 */
  assetPackId: string;
  assetPackTitle: string;
  /** 这次 commit 前该 objectKey 是否已在拥有者纪录内（幂等）。 */
  alreadyCommitted: boolean;
}

/**
 * 第二段：把 objectKey 回写进拥有者纪录（＋同步进资产库）。
 *
 * 语义照 D36「上传的图要回写 TosKey 才算入库」：
 *   - objectKey 必须属于呼叫者；否则 403。
 *   - **物件必须真的存在**（伺服器亲自 `get` 回来并串流算 sha256），取不到即 404，
 *     不写纪录、不入库——不宣称未验证的成功。
 *   - 回写目标①：`upload-records/<userId>/` 的拥有者纪录（物件键＋sha256＋大小＋mime）。
 *   - 回写目标②：资产库包 `uploaded-assets`（kind:"image" 项目，imageUrl 指向该物件），
 *     让它在 `GET /api/assets` 清单可见（＝UI 资产库面板的消费路径）。
 */
export async function commitUploadedObject(input: {
  userId: number;
  objectKey: unknown;
  title?: string;
}): Promise<CommitUploadResult> {
  const objectKey = assertUploadObjectKeyOwnedBy(input.objectKey, input.userId);

  const resolved = await resolveStoredObject(objectKey);
  if (!resolved) {
    fail(404, "object_not_found", `直传物件不存在于物件储存：${objectKey}（请先完成第一段直传再回写）。`);
  }
  // 伺服器亲自把位元组串流读回并算 sha256（O(1) 记忆体）——回写进纪录的杂凑是**验过的**，
  // 不是客户端自称的。取回位元组与上传档杂凑一致才叫「可用」。
  const hashed = await hashStream(resolved.stream);

  const existing = (await listUploadedObjects(input.userId)).find((r) => r.objectKey === objectKey);
  const now = new Date().toISOString();
  const record: UploadedObjectRecord = {
    id: existing?.id ?? `up-${objectKey.split("/").pop() ?? objectKey}`,
    objectKey,
    url: resolved.url,
    mimeType: resolved.contentType ?? mimeTypeFromExtension(objectKey),
    size: hashed.bytes > 0 ? hashed.bytes : resolved.size,
    sha256: hashed.sha256,
    title: input.title?.trim() || existing?.title || objectKey.split("/").pop() || objectKey,
    backend: resolveDirectUploadBackend(),
    createdAt: existing?.createdAt ?? now,
    committedAt: now,
  };
  await upsertUploadedObject(input.userId, record);

  const pack = await upsertUploadedAssetsPack(input.userId, record);
  return {
    record,
    assetPackId: pack.id,
    assetPackTitle: pack.title,
    alreadyCommitted: Boolean(existing),
  };
}

function mimeTypeFromExtension(objectKey: string): string {
  const ext = objectKey.split(".").pop()?.toLowerCase() ?? "";
  for (const [mime, known] of Object.entries(EXTENSION_BY_CONTENT_TYPE)) {
    if (known === ext) return mime;
  }
  return "application/octet-stream";
}

/** 资产库面板的固定包 id 上限（`asset-pack-store` 的 MAX_ITEMS_PER_PACK＝50，同一个界）。 */
const UPLOAD_PACK_VISIBLE_ITEMS = 50;

/** 读回该使用者的「上传资产」包、把新纪录插到最前（同 URL 去重），再存回（既有收口）。 */
async function upsertUploadedAssetsPack(
  userId: number,
  record: UploadedObjectRecord,
): Promise<AssetPack> {
  const packs = await listAssetPacks(userId);
  const current = packs.find((p) => p.id === UPLOAD_ASSET_PACK_ID);
  const kept = (current?.items ?? []).filter((item) => item.imageUrl !== record.url);
  // 显式截到资产包上限（**明示**截断；权威纪录在 upload-record-store，不因这里的显示上限丢资料）。
  const visible = [
    {
      kind: "image" as const,
      title: record.title ?? record.objectKey,
      imageUrl: record.url,
      note: `直传入库 sha256:${record.sha256.slice(0, 16)}`,
      createdAt: record.createdAt,
    },
    ...kept,
  ].slice(0, UPLOAD_PACK_VISIBLE_ITEMS);
  const now = new Date().toISOString();
  const next: AssetPack = {
    ...(current ?? {
      id: UPLOAD_ASSET_PACK_ID,
      title: UPLOAD_ASSET_PACK_TITLE,
      tags: [],
      createdAt: now,
      updatedAt: now,
    }),
    items: visible,
    updatedAt: now,
  };
  await saveAssetPack(userId, next);
  return next;
}
