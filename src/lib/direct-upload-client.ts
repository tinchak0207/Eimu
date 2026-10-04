// 两段式上传（D36）的**浏览器端薄客户端**。
//
// 流程（与伺服器端 `two-phase-upload.ts` 同一份契约，不另立第二套签名逻辑）：
//   sign   POST /api/uploads/sign   → 只送 metadata，拿 { objectKey, uploadUrl, method, clientToken, maxBytes, headers? }
//   PUT    credential.uploadUrl     → 带 credential.headers 直传物件存储（本站不经手位元组）
//   commit POST /api/uploads/commit → { objectKey } 回写入库（伺服器亲自验 sha256）
//
// 三条硬规矩：
//   1. 有效上限**一律取回应的 `maxBytes`**（VPS presign 实际回 100MB，不是本档或
//      `two-phase-upload.ts` 的 512MB 常数）——上传前先预检，超限即抛具名错误。
//   2. 同一次 `uploadDirect` 内部的 PUT 重试**沿用同一个 objectKey**：重跑 sign 时
//      以官方协议体 `{type:"blob.generate-client-token", payload:{pathname}}` 带回上次
//      的 objectKey，让伺服器端 commit 的 `alreadyCommitted` 幂等成立。
//   3. 每个本站请求带 `X-Request-Id`。

import { GENERATION_TRACE_ID_HEADER } from "./generation-request-headers";

/** 具名错误：呼叫端可依 `code` 分流（例如超限显示人话、其余显示通用失败）。 */
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

/** `file.size > maxBytes` 的固定错误码（呼叫端不必猜讯息文字）。 */
export const UPLOAD_TOO_LARGE_CODE = "upload_too_large";
/** 目前后端（Vercel Blob）直传不走「带 headers 的 PUT」协议，本薄客户端不支援。 */
export const UNSUPPORTED_BACKEND_CODE = "direct_upload_backend_unsupported";
export const PUT_FAILED_CODE = "upload_put_failed";

/**
 * 本站请求统一带的 trace header 名。单一真源＝`generation-request-headers.ts`
 * 的 `GENERATION_TRACE_ID_HEADER`（它再往上收敛到 `request-trace.ts` 的
 * `TRACE_ID_HEADER`），本档不另立第二个字串。
 *
 * 为什么现在可以安全 import：`request-trace.ts` 现场已改用
 * `globalThis.crypto.randomUUID`，**零 import、不再拉 `node:crypto`**；
 * `generation-request-headers.ts` 也只 import 它，故整条链对 client bundle 安全。
 * （旧注解说「静态 import node:crypto 会炸」的理由已不成立。）
 */
const TRACE_HEADER = GENERATION_TRACE_ID_HEADER;
/** 与 `request-trace.ts` 同源的路径；沿用同一组端点。 */
const SIGN_PATH = "/api/uploads/sign";
const COMMIT_PATH = "/api/uploads/commit";

/** sign 端点回应（＝ `DirectUploadCredential` 展开成 JSON）。 */
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

/** commit 端点回应（route 展开 `CommitUploadResult`）。 */
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
  /** 入库标题（commit 端第二段的 `title`）。 */
  title?: string;
  /** 粗粒度进度回报（0→1）。VPS 直传无法逐块回报，仅在送出前后各回一次。 */
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
  /** 测试注入点：取代全域 fetch（sign／PUT／commit 全走它）。 */
  fetchFn?: typeof fetch;
  /** 鉴权标头（例如 `Authorization: Bearer <token>`、`x-user-id`）。省略时靠同源 cookie。 */
  headers?: Record<string, string>;
  /** PUT 失败后的重试次数（预设 1＝初次＋重试一次），重试沿用同一 objectKey。 */
  putRetries?: number;
}

/** 浏览器安全的 trace id：与 `request-trace` 同一形状（alnum + `. _ -`，8–128 字）。 */
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
 * 送 sign 请求取凭证。`objectKey` 非空 ⇒ 走官方协议体把上次的 objectKey 带回，
 * 让重试落在**同一个**物件键上（commit 幂等的必要条件）。
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

  // `input.fetchFn(...)` 是**方法呼叫**，会把 `this` 绑成 `input`；浏览器原生 fetch 要求
  // receiver 是 global，否则在发出任何请求前就抛 `Illegal invocation`（Node undici 不看
  // receiver，故单元测试抓不到）。先取出成裸变数再呼叫，receiver 回归 `undefined`。
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
    const message = typeof json?.error === "string" && json.error ? json.error : `取得直传凭证失败（HTTP ${response.status}）。`;
    throw new DirectUploadError(code, message, response.status);
  }
  if (typeof json.objectKey !== "string" || !json.objectKey || typeof json.uploadUrl !== "string" || !json.uploadUrl) {
    throw new DirectUploadError("sign_malformed", "直传凭证形状不完整（缺 objectKey 或 uploadUrl）。");
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
 * 直传一段。VPS 后端凭证带 `headers`（x-upload-ticket 等）⇒ 直接 PUT；
 * Vercel Blob 后端不走此协议（要用官方 SDK）⇒ 具名错误，不假装成功。
 */
async function putObject(credential: ResolvedCredential, file: Blob | File, opts: UploadDirectOptions, fetchFn: typeof fetch): Promise<void> {
  if (credential.backend !== "vps-blob" && Object.keys(credential.headers).length === 0) {
    throw new DirectUploadError(
      UNSUPPORTED_BACKEND_CODE,
      "目前物件储存后端不支援浏览器直传（仅 VPS 签名 PUT 后端支援）。",
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
    throw new DirectUploadError(PUT_FAILED_CODE, `直传物件存储失败（HTTP ${response.status}）。`, response.status);
  }
  opts.onProgress?.(1);
}

/** 第二段：把 objectKey 回写入库。 */
async function commitObject(input: {
  objectKey: string;
  title?: string;
  downloadUrl: string | null;
  fetchFn: typeof fetch;
  authHeaders: Record<string, string>;
  traceId: string;
  signal?: AbortSignal;
}): Promise<UploadDirectResult> {
  // 同 `requestCredential`：取出成裸变数，避免把 fetch 当 `input` 的方法呼叫。
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
    const message = typeof json?.error === "string" && json.error ? json.error : `回写入库失败（HTTP ${response.status}）。`;
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
 * sign → PUT（带 `credential.headers`）→ commit。
 *
 * 重试语义：PUT 失败时重跑 sign 并**带回上一次的 objectKey**（官方协议体），使位元组
 * 落在同一物件键；commit 失败时只重试 commit（物件已存在，不重复上传）。
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

    // 有效上限＝伺服器回报的 maxBytes（不写死常数）。
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
  if (!credential || !objectKey) throw new DirectUploadError("upload_failed", "直传未完成。");

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
