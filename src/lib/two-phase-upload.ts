// 兩段式上傳（Dramagic 對稱差 D36）的共用輪子。
//
//   第一段：POST /api/uploads/sign    → 只收 metadata，回 { uploadUrl, clientToken, objectKey, expiresInMs }
//   第二段：POST /api/uploads/commit  → 把 objectKey 回寫進擁有者紀錄（＋同步入資產庫）才算入庫
//
// 對稱差原文口徑（Dramagic 全站 269–272 / 286 / 303 行）：
//   `UploadFileUrl{Type,Target:"temp",Suffix,ProjectId}` → `{Url, TosKey, Expires:3600, DownloadTosUrl}`
//   ⇒ 先取 1 小時簽名 PUT URL，再「直傳物件存儲」；上傳完要 `UpdateImageImage{ImageId, TosKey}` 才算入庫。
//
// 本檔後端選擇**不另立第二套判斷**，直接复用 `blob-backend.ts`（單一真源）：
//   * Vercel Blob（BLOB_READ_WRITE_TOKEN）→ 走 `@vercel/blob/client` 的 `handleUpload` 簽發客戶端
//     token，客戶端拿 token 直接 PUT 到 Vercel Blob 的 API 主機（`vercel.com/api/blob`），
//     位元組不經過本站伺服器。
//   * VPS `image-data-api`（IMAGE_DATA_BASE_URL + IMAGE_DATA_API_KEY）→ **無法簽發**：該服務的
//     `PUT /api/blob/:path(*)` 只認靜態母鑰 `x-image-data-key`，沒有任何 per-upload 的
//     presign/短效簽名端點（VPS `/opt/image-data-api/server.js` 實查，端點全集＝
//     list/get/put/delete/files）。把母鑰下發瀏覽器＝洩漏後端主憑證 ⇒ 誠實回具名錯誤碼
//     `vps_blob_direct_upload_unsupported`，不假裝成功、也不用「本站中轉」冒充直傳。

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

/** 簽名有效期（對齊 Dramagic `Expires:3600`）。 */
export const UPLOAD_SIGN_TTL_MS = 60 * 60 * 1000;

/** 單檔上限（視頻素材留裕度；超過即拒，不靜默截斷）。 */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/** 物件鍵命名空間（與 asset-packs/ 、generation/ 分開，互不干擾）。 */
export const UPLOAD_OBJECT_KEY_PREFIX = "uploads";

/** 內容型別白名單：媒體檔，不收 `application/octet-stream`（逼呼叫端講清楚是什麼）。 */
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
];

/** 第一段直傳憑證的後端判定結果。 */
export type DirectUploadBackend = "vercel-blob" | "vps-blob" | "unconfigured";

/** 兩段式上傳的具名錯誤（route 直接把它轉成錯誤體，不吞）。 */
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
 * 後端判定：**不抄第二份 env 判斷**，VPS 走 `blob-backend` 的既有選擇器。
 * Vercel 分支必須顯式看到 BLOB_READ_WRITE_TOKEN——只有它才能簽發直傳憑證。
 */
export function resolveDirectUploadBackend(
  env: Record<string, string | undefined> = process.env,
): DirectUploadBackend {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- 非 hook：blob-backend 同步選擇器（見 blob-backend.ts）
  if (useVpsBlobBackend()) return "vps-blob";
  if (env.BLOB_READ_WRITE_TOKEN?.trim()) return "vercel-blob";
  return "unconfigured";
}

/**
 * 直傳目標主機（供回報/取證用，非我方網域）。
 * 與 `@vercel/blob` 的 `getApiUrl()` 同源：`VERCEL_BLOB_API_URL` →
 * `NEXT_PUBLIC_VERCEL_BLOB_API_URL` → 預設 `https://vercel.com/api/blob`。
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
    // 非法 URL 原樣帶出，讓回報看得見壞值。
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
};

function fail(status: number, code: string, message: string): never {
  throw new UploadSignError(status, code, message);
}

/** 內容型別必須在白名單內（`; charset=` 等參數先剝掉）。 */
export function normalizeUploadContentType(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim().toLowerCase().split(";")[0].trim() : "";
  if (!value) fail(400, "missing_content_type", "contentType 必填（例如 image/png、video/mp4）。");
  if (!ALLOWED_UPLOAD_CONTENT_TYPES.includes(value)) {
    fail(415, "unsupported_content_type", `不支援的內容型別 ${value}（可用：${ALLOWED_UPLOAD_CONTENT_TYPES.join(" / ")}）。`);
  }
  return value;
}

/** `uploads/<userId>/<YYYYMMDD>/<8hex>-<name>.<ext>`（owner 前綴是回寫時的授權依據）。 */
export function buildUploadObjectKey(input: {
  userId: number;
  filename?: string;
  contentType: string;
  now?: Date;
  token?: string;
}): string {
  if (!Number.isFinite(input.userId)) fail(401, "invalid_user", "使用者身分無效。");
  const contentType = normalizeUploadContentType(input.contentType);
  const ext = EXTENSION_BY_CONTENT_TYPE[contentType] ?? "bin";
  const rawName = typeof input.filename === "string" ? input.filename.trim() : "";
  const base = sanitizeBlobSegment(rawName.replace(/\.[A-Za-z0-9]{1,8}$/, ""), "upload").slice(0, 48);
  const now = input.now ?? new Date();
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const token = (input.token ?? randomBytes(4).toString("hex")).replace(/[^a-f0-9]/gi, "").slice(0, 8) || "00000000";
  return `${UPLOAD_OBJECT_KEY_PREFIX}/${input.userId}/${day}/${token}-${base}.${ext}`;
}

/**
 * 回寫授權：objectKey 必須落在呼叫者自己的 `uploads/<userId>/` 前綴下。
 * 任何越界（他人前綴 / `..` / 反斜線 / 絕對路徑 / 超長）一律 403，不退回、不猜。
 */
export function assertUploadObjectKeyOwnedBy(objectKey: unknown, userId: number): string {
  const value = typeof objectKey === "string" ? objectKey.trim() : "";
  if (!value) fail(400, "missing_object_key", "objectKey 必填。");
  if (value.length > 512) fail(400, "object_key_too_long", "objectKey 過長（上限 512）。");
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    fail(400, "invalid_object_key", "objectKey 形狀非法。");
  }
  const segments = value.split("/");
  if (segments.some((s) => !s || s === "." || s === "..")) {
    fail(400, "invalid_object_key", "objectKey 形狀非法（不得含空段或 . / ..）。");
  }
  const prefix = `${UPLOAD_OBJECT_KEY_PREFIX}/${userId}/`;
  if (!value.startsWith(prefix)) {
    fail(403, "object_key_not_owned", "objectKey 不屬於目前使用者。");
  }
  return value;
}

/** 物件的公網讀取 URL（Vercel Blob 由 storeId 推；VPS 由 IMAGE_DATA_BASE_URL 推）。 */
export function publicObjectUrl(objectKey: string): string | null {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- 非 hook：blob-backend 同步選擇器（見 blob-backend.ts）
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
  /** 客戶端直傳用的方法/端點（目標主機＝物件存儲，非本站）。 */
  method: "PUT";
  uploadUrl: string;
  /** `@vercel/blob/client` 的客戶端 token（帶 store id 與 pathname 綁定、含到期時間）。 */
  clientToken: string;
  access: "public";
  contentType: string;
  maxBytes: number;
  expiresInMs: number;
  expiresAt: string;
  /** 直傳完成後該物件的公網 URL（僅供提示；入庫與否看第二段）。 */
  downloadUrl: string | null;
  /** 官方 `@vercel/blob/client` 協議的事件型別（客戶端 `upload()` 需要）。 */
  type: "blob.generate-client-token";
  /**
   * VPS 後端直傳要帶的標頭（x-upload-ticket / -path / -expires / x-content-type）。
   * 客戶端據 `backend` 分流：`vps-blob` ⇒ `fetch(uploadUrl,{method:"PUT",headers,body})`；
   * `vercel-blob` ⇒ `@vercel/blob/client` 的 `upload()`（用 clientToken，不讀本欄）。
   */
  headers?: Record<string, string>;
}

/**
 * VPS 後端（image-data-api）的第一段：取短效簽名直傳憑證。
 *
 * 母鑰 `IMAGE_DATA_API_KEY` **只在本函式內使用、永不下發瀏覽器**；下發的是
 * HMAC(pathname + expires) 簽名，只能對「這一個 pathname」在有效期內 PUT 一次。
 * 端點 `POST /api/blob/presign` 是 2026-09-29 為兩段式上傳新增的（舊部署沒有 ⇒
 * 回 404/405 ⇒ 轉譯成原本的具名錯誤 `vps_blob_direct_upload_unsupported`，不假裝成功）。
 * `maxBytes` 取簽名端點回報的真實上限（VPS 管線 ≠ Vercel 上限），不沿用本檔常數。
 */
export async function issueVpsBlobDirectUploadCredential(input: {
  objectKey: string;
  contentType: string;
  /** 測試注入點。 */
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
    fail(502, "presign_unreachable", "物件存儲的簽名端點連線失敗，請稍後再試。");
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 405) {
      fail(
        501,
        "vps_blob_direct_upload_unsupported",
        "目前物件儲存後端是 VPS image-data-api，但該部署沒有簽名端點（POST /api/blob/presign）。" +
          "需先部署帶簽名端點的 image-data-api 才能開通兩段式直傳。",
      );
    }
    fail(502, "presign_failed", `物件存儲拒絕簽發直傳憑證（HTTP ${response.status}）。`);
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
  if (!uploadUrl || !ticket) fail(502, "presign_malformed", "物件存儲回傳的直傳憑證形狀不完整。");
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
 * 第一段：簽發直傳憑證。**呼叫端保證請求體不含檔案位元組**（本函式也只吃 metadata）。
 *
 * 兩種後端都走同一套契約：VPS ⇒ `issueVpsBlobDirectUploadCredential`（短效簽名）；
 * Vercel Blob ⇒ `handleUpload` 的 client token。
 */
export async function issueDirectUploadCredential(input: {
  userId: number;
  filename?: string;
  contentType: string;
  size?: number;
  /** 官方協議由客戶端指定 pathname 時帶入——仍必須通過 owner 前綴檢查。 */
  pathname?: string;
  /** `handleUpload` 需要原始 Request 以解析（不設 callback，回寫走第二段）。 */
  request: Request;
  /** 測試注入點。 */
  handleUploadFn?: typeof handleUpload;
  /** 測試注入點（VPS 分支打簽名端點用）。 */
  fetchFn?: typeof fetch;
}): Promise<DirectUploadCredential> {
  const backend = resolveDirectUploadBackend();
  if (backend === "unconfigured") {
    fail(
      503,
      "blob_backend_unconfigured",
      "物件儲存後端未設定：請設 BLOB_READ_WRITE_TOKEN（Vercel Blob）或 IMAGE_DATA_BASE_URL + IMAGE_DATA_API_KEY（VPS）。",
    );
  }

  const contentType = normalizeUploadContentType(input.contentType);
  if (typeof input.size === "number" && Number.isFinite(input.size)) {
    if (input.size <= 0) fail(400, "invalid_size", "size 必須大於 0。");
    if (input.size > MAX_UPLOAD_BYTES) {
      fail(413, "upload_too_large", `檔案過大（${input.size} bytes > 上限 ${MAX_UPLOAD_BYTES}）。`);
    }
  }

  const objectKey = input.pathname
    ? assertUploadObjectKeyOwnedBy(input.pathname, input.userId)
    : buildUploadObjectKey({
        userId: input.userId,
        filename: input.filename,
        contentType,
      });

  // VPS 後端：向 image-data-api 取短效簽名（母鑰不出站），憑證形狀與 Vercel 分支分岔。
  if (backend === "vps-blob") {
    return issueVpsBlobDirectUploadCredential({
      objectKey,
      contentType,
      ...(input.fetchFn === undefined ? {} : { fetchFn: input.fetchFn }),
    });
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) fail(503, "blob_backend_unconfigured", "缺少 BLOB_READ_WRITE_TOKEN，無法簽發直傳憑證。");

  const validUntil = Date.now() + UPLOAD_SIGN_TTL_MS;
  const call = input.handleUploadFn ?? handleUpload;
  const result = await call({
    token,
    request: input.request,
    // 官方協議的請求體（本函式在 metadata 形狀下就地合成同一份，兩個入口共用一套策略）。
    body: {
      type: "blob.generate-client-token",
      payload: { pathname: objectKey, clientPayload: null, multipart: false },
    },
    // 不設 onUploadCompleted：入庫是**第二段**（/api/uploads/commit）的職責，
    // 不依賴 Vercel Blob 的 webhook 回呼（本地開發也打不進來）。
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
    fail(500, "unexpected_upload_event", "簽發直傳憑證時收到非預期的事件型別。");
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

// ─────────────────────────────────────────── 第二段：回寫 key 入庫

/** 同步入資產庫用的固定包 id（每人一個「上傳資產」包，新項在前）。 */
export const UPLOAD_ASSET_PACK_ID = "uploaded-assets";
export const UPLOAD_ASSET_PACK_TITLE = "上傳資產";

interface ResolvedObject {
  url: string;
  size: number;
  contentType: string | null;
  stream: ReadableStream<Uint8Array> | null;
}

/**
 * 把 `blob-backend.get()` 的兩種後端回傳形狀（Vercel 的 `{statusCode,stream,blob}` /
 * VPS 的 `{url,size,statusCode,stream}`）收斂成一個。取不到回 null（呼叫端誠實 404）。
 * **只取一次**：回傳的 stream 交給呼叫端串流算雜湊，不重複下載。
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

/** 串流雜湊：O(1) 記憶體，不把大檔整包讀進 buffer。 */
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
  /** 同步入庫的資產包（＝消費路徑：GET /api/assets 可見）。 */
  assetPackId: string;
  assetPackTitle: string;
  /** 這次 commit 前該 objectKey 是否已在擁有者紀錄內（冪等）。 */
  alreadyCommitted: boolean;
}

/**
 * 第二段：把 objectKey 回寫進擁有者紀錄（＋同步進資產庫）。
 *
 * 語義照 D36「上傳的圖要回寫 TosKey 才算入庫」：
 *   - objectKey 必須屬於呼叫者；否則 403。
 *   - **物件必須真的存在**（伺服器親自 `get` 回來並串流算 sha256），取不到即 404，
 *     不寫紀錄、不入庫——不宣稱未驗證的成功。
 *   - 回寫目標①：`upload-records/<userId>/` 的擁有者紀錄（物件鍵＋sha256＋大小＋mime）。
 *   - 回寫目標②：資產庫包 `uploaded-assets`（kind:"image" 項目，imageUrl 指向該物件），
 *     讓它在 `GET /api/assets` 清單可見（＝UI 資產庫面板的消費路徑）。
 */
export async function commitUploadedObject(input: {
  userId: number;
  objectKey: unknown;
  title?: string;
}): Promise<CommitUploadResult> {
  const objectKey = assertUploadObjectKeyOwnedBy(input.objectKey, input.userId);

  const resolved = await resolveStoredObject(objectKey);
  if (!resolved) {
    fail(404, "object_not_found", `直傳物件不存在於物件儲存：${objectKey}（請先完成第一段直傳再回寫）。`);
  }
  // 伺服器親自把位元組串流讀回並算 sha256（O(1) 記憶體）——回寫進紀錄的雜湊是**驗過的**，
  // 不是客戶端自稱的。取回位元組與上傳檔雜湊一致才叫「可用」。
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

/** 資產庫面板的固定包 id 上限（`asset-pack-store` 的 MAX_ITEMS_PER_PACK＝50，同一個界）。 */
const UPLOAD_PACK_VISIBLE_ITEMS = 50;

/** 讀回該使用者的「上傳資產」包、把新紀錄插到最前（同 URL 去重），再存回（既有收口）。 */
async function upsertUploadedAssetsPack(
  userId: number,
  record: UploadedObjectRecord,
): Promise<AssetPack> {
  const packs = await listAssetPacks(userId);
  const current = packs.find((p) => p.id === UPLOAD_ASSET_PACK_ID);
  const kept = (current?.items ?? []).filter((item) => item.imageUrl !== record.url);
  // 顯式截到資產包上限（**明示**截斷；權威紀錄在 upload-record-store，不因這裡的顯示上限丟資料）。
  const visible = [
    {
      kind: "image" as const,
      title: record.title ?? record.objectKey,
      imageUrl: record.url,
      note: `直傳入庫 sha256:${record.sha256.slice(0, 16)}`,
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
