// 兩段式上傳（D36）的**瀏覽器端薄客戶端**。
//
// 流程（與伺服器端 `two-phase-upload.ts` 同一份契約，不另立第二套簽名邏輯）：
//   sign   POST /api/uploads/sign   → 只送 metadata，拿 { objectKey, uploadUrl, method, clientToken, maxBytes, headers? }
//   PUT    credential.uploadUrl     → 帶 credential.headers 直傳物件存儲（本站不經手位元組）
//   commit POST /api/uploads/commit → { objectKey } 回寫入庫（伺服器親自驗 sha256）
//
// 三條硬規矩：
//   1. 有效上限**一律取回應的 `maxBytes`**（VPS presign 實際回 100MB，不是本檔或
//      `two-phase-upload.ts` 的 512MB 常數）——上傳前先預檢，超限即拋具名錯誤。
//   2. 同一次 `uploadDirect` 內部的 PUT 重試**沿用同一個 objectKey**：重跑 sign 時
//      以官方協議體 `{type:"blob.generate-client-token", payload:{pathname}}` 帶回上次
//      的 objectKey，讓伺服器端 commit 的 `alreadyCommitted` 冪等成立。
//   3. 每個本站請求帶 `X-Request-Id`。

import { GENERATION_TRACE_ID_HEADER } from "./generation-request-headers";

/** 具名錯誤：呼叫端可依 `code` 分流（例如超限顯示人話、其餘顯示通用失敗）。 */
export class DirectUploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DirectUploadError";
  }
}

/** `file.size > maxBytes` 的固定錯誤碼（呼叫端不必猜訊息文字）。 */
export const UPLOAD_TOO_LARGE_CODE = "upload_too_large";
/** 目前後端（Vercel Blob）直傳不走「帶 headers 的 PUT」協議，本薄客戶端不支援。 */
export const UNSUPPORTED_BACKEND_CODE = "direct_upload_backend_unsupported";
export const PUT_FAILED_CODE = "upload_put_failed";

/**
 * 本站請求統一帶的 trace header 名。單一真源＝`generation-request-headers.ts`
 * 的 `GENERATION_TRACE_ID_HEADER`（它再往上收斂到 `request-trace.ts` 的
 * `TRACE_ID_HEADER`），本檔不另立第二個字串。
 *
 * 為什麼現在可以安全 import：`request-trace.ts` 現場已改用
 * `globalThis.crypto.randomUUID`，**零 import、不再拉 `node:crypto`**；
 * `generation-request-headers.ts` 也只 import 它，故整條鏈對 client bundle 安全。
 * （舊註解說「靜態 import node:crypto 會炸」的理由已不成立。）
 */
const TRACE_HEADER = GENERATION_TRACE_ID_HEADER;
/** 與 `request-trace.ts` 同源的路徑；沿用同一組端點。 */
const SIGN_PATH = "/api/uploads/sign";
const COMMIT_PATH = "/api/uploads/commit";

/** sign 端點回應（＝ `DirectUploadCredential` 展開成 JSON）。 */
interface CredentialResponse {
  backend?: string;
  objectKey?: unknown;
  uploadUrl?: unknown;
  method?: unknown;
  clientToken?: unknown;
  contentType?: unknown;
  maxBytes?: unknown;
  downloadUrl?: unknown;
  headers?: unknown;
  success?: unknown;
  error?: unknown;
  code?: unknown;
}

/** commit 端點回應（route 展開 `CommitUploadResult`）。 */
interface CommitResponse {
  success?: unknown;
  alreadyCommitted?: unknown;
  record?: { url?: unknown } | null;
  error?: unknown;
  code?: unknown;
}

interface ResolvedCredential {
  backend: string;
  objectKey: string;
  uploadUrl: string;
  clientToken: string;
  contentType: string;
  maxBytes: number;
  downloadUrl: string | null;
  headers: Record<string, string>;
}

export interface UploadDirectResult {
  objectKey: string;
  downloadUrl: string;
  alreadyCommitted: boolean;
}

export interface UploadDirectOptions {
  /** 入庫標題（commit 端第二段的 `title`）。 */
  title?: string;
  /** 粗粒度進度回報（0→1）。VPS 直傳無法逐塊回報，僅在送出前後各回一次。 */
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
  /** 測試注入點：取代全域 fetch（sign／PUT／commit 全走它）。 */
  fetchFn?: typeof fetch;
  /** 鑑權標頭（例如 `Authorization: Bearer <token>`、`x-user-id`）。省略時靠同源 cookie。 */
  headers?: Record<string, string>;
  /** PUT 失敗後的重試次數（預設 1＝初次＋重試一次），重試沿用同一 objectKey。 */
  putRetries?: number;
}

/** 瀏覽器安全的 trace id：與 `request-trace` 同一形狀（alnum + `. _ -`，8–128 字）。 */
function mintTraceId(): string {
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function contentTypeOf(file: Blob | File): string {
  const type = typeof (file as Blob).type === "string" ? (file as Blob).type.trim().toLowerCase() : "";
  return type || "application/octet-stream";
}

function filenameOf(file: Blob | File): string {
  const name = (file as File).name;
  return typeof name === "string" && name.trim() ? name.trim() : "upload";
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 送 sign 請求取憑證。`objectKey` 非空 ⇒ 走官方協議體把上次的 objectKey 帶回，
 * 讓重試落在**同一個**物件鍵上（commit 冪等的必要條件）。
 */
async function requestCredential(input: {
  objectKey: string | null;
  filename: string;
  contentType: string;
  size: number;
  fetchFn: typeof fetch;
  authHeaders: Record<string, string>;
  traceId: string;
  signal?: AbortSignal;
}): Promise<ResolvedCredential> {
  const body = input.objectKey
    ? { type: "blob.generate-client-token", payload: { pathname: input.objectKey }, contentType: input.contentType }
    : { filename: input.filename, contentType: input.contentType, size: input.size };

  // `input.fetchFn(...)` 是**方法呼叫**，會把 `this` 綁成 `input`；瀏覽器原生 fetch 要求
  // receiver 是 global，否則在發出任何請求前就拋 `Illegal invocation`（Node undici 不看
  // receiver，故單元測試抓不到）。先取出成裸變數再呼叫，receiver 回歸 `undefined`。
  const callFetch = input.fetchFn;
  const response = await callFetch(SIGN_PATH, {
    method: "POST",
    headers: { ...input.authHeaders, "content-type": "application/json", [TRACE_HEADER]: input.traceId },
    body: JSON.stringify(body),
    signal: input.signal,
  });
  const json = (await readJson(response)) as CredentialResponse | null;
  if (!response.ok || !json || json.success === false) {
    const code = typeof json?.code === "string" ? json.code : "sign_failed";
    const message = typeof json?.error === "string" && json.error ? json.error : `取得直傳憑證失敗（HTTP ${response.status}）。`;
    throw new DirectUploadError(code, message, response.status);
  }
  if (typeof json.objectKey !== "string" || !json.objectKey || typeof json.uploadUrl !== "string" || !json.uploadUrl) {
    throw new DirectUploadError("sign_malformed", "直傳憑證形狀不完整（缺 objectKey 或 uploadUrl）。");
  }
  const headers =
    json.headers && typeof json.headers === "object" && !Array.isArray(json.headers)
      ? (json.headers as Record<string, string>)
      : {};
  const maxBytes =
    typeof json.maxBytes === "number" && Number.isFinite(json.maxBytes) && json.maxBytes > 0 ? json.maxBytes : Number.POSITIVE_INFINITY;
  return {
    backend: typeof json.backend === "string" ? json.backend : "vps-blob",
    objectKey: json.objectKey,
    uploadUrl: json.uploadUrl,
    clientToken: typeof json.clientToken === "string" ? json.clientToken : "",
    contentType: typeof json.contentType === "string" ? json.contentType : input.contentType,
    maxBytes,
    downloadUrl: typeof json.downloadUrl === "string" ? json.downloadUrl : null,
    headers,
  };
}

/**
 * 直傳一段。VPS 後端憑證帶 `headers`（x-upload-ticket 等）⇒ 直接 PUT；
 * Vercel Blob 後端不走此協議（要用官方 SDK）⇒ 具名錯誤，不假裝成功。
 */
async function putObject(credential: ResolvedCredential, file: Blob | File, opts: UploadDirectOptions, fetchFn: typeof fetch): Promise<void> {
  if (credential.backend !== "vps-blob" && Object.keys(credential.headers).length === 0) {
    throw new DirectUploadError(
      UNSUPPORTED_BACKEND_CODE,
      "目前物件儲存後端不支援瀏覽器直傳（僅 VPS 簽名 PUT 後端支援）。",
    );
  }
  opts.onProgress?.(0);
  const response = await fetchFn(credential.uploadUrl, {
    method: "PUT",
    headers: { ...credential.headers, "content-type": credential.contentType },
    body: file,
    signal: opts.signal,
  });
  if (!response.ok) {
    throw new DirectUploadError(PUT_FAILED_CODE, `直傳物件存儲失敗（HTTP ${response.status}）。`, response.status);
  }
  opts.onProgress?.(1);
}

/** 第二段：把 objectKey 回寫入庫。 */
async function commitObject(input: {
  objectKey: string;
  title?: string;
  downloadUrl: string | null;
  fetchFn: typeof fetch;
  authHeaders: Record<string, string>;
  traceId: string;
  signal?: AbortSignal;
}): Promise<UploadDirectResult> {
  // 同 `requestCredential`：取出成裸變數，避免把 fetch 當 `input` 的方法呼叫。
  const callFetch = input.fetchFn;
  const response = await callFetch(COMMIT_PATH, {
    method: "POST",
    headers: { ...input.authHeaders, "content-type": "application/json", [TRACE_HEADER]: input.traceId },
    body: JSON.stringify(input.title ? { objectKey: input.objectKey, title: input.title } : { objectKey: input.objectKey }),
    signal: input.signal,
  });
  const json = (await readJson(response)) as CommitResponse | null;
  if (!response.ok || !json || json.success === false) {
    const code = typeof json?.code === "string" ? json.code : "commit_failed";
    const message = typeof json?.error === "string" && json.error ? json.error : `回寫入庫失敗（HTTP ${response.status}）。`;
    throw new DirectUploadError(code, message, response.status);
  }
  const recordUrl = json.record && typeof json.record.url === "string" ? json.record.url : null;
  return {
    objectKey: input.objectKey,
    downloadUrl: recordUrl ?? input.downloadUrl ?? "",
    alreadyCommitted: Boolean(json.alreadyCommitted),
  };
}

/**
 * sign → PUT（帶 `credential.headers`）→ commit。
 *
 * 重試語義：PUT 失敗時重跑 sign 並**帶回上一次的 objectKey**（官方協議體），使位元組
 * 落在同一物件鍵；commit 失敗時只重試 commit（物件已存在，不重複上傳）。
 */
export async function uploadDirect(file: Blob | File, opts: UploadDirectOptions = {}): Promise<UploadDirectResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const authHeaders = opts.headers ?? {};
  const traceId = mintTraceId();
  const contentType = contentTypeOf(file);
  const filename = filenameOf(file);
  const maxPutAttempts = 1 + Math.max(0, opts.putRetries ?? 1);

  let objectKey: string | null = null;
  let credential: ResolvedCredential | null = null;
  let lastPutError: unknown = null;

  for (let attempt = 0; attempt < maxPutAttempts; attempt += 1) {
    credential = await requestCredential({ objectKey, filename, contentType, size: file.size, fetchFn, authHeaders, traceId, signal: opts.signal });
    objectKey = credential.objectKey;

    // 有效上限＝伺服器回報的 maxBytes（不寫死常數）。
    if (file.size > credential.maxBytes) {
      throw new DirectUploadError(
        UPLOAD_TOO_LARGE_CODE,
        `文件过大：${file.size} 字节，超过上限 ${credential.maxBytes} 字节。`,
        413,
      );
    }

    try {
      await putObject(credential, file, opts, fetchFn);
      lastPutError = null;
      break;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      lastPutError = error;
    }
  }
  if (lastPutError) throw lastPutError;
  if (!credential || !objectKey) throw new DirectUploadError("upload_failed", "直傳未完成。");

  let lastCommitError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await commitObject({ objectKey, title: opts.title, downloadUrl: credential.downloadUrl, fetchFn, authHeaders, traceId, signal: opts.signal });
    } catch (error) {
      lastCommitError = error;
    }
  }
  throw lastCommitError;
}
