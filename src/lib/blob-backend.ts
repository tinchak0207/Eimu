/**
 * Storage backend selector: VPS image-data-api when configured, otherwise
 * Vercel Blob. Modules import { list, get, put, del } from this module so the
 * swap is a single env-config decision.
 */
import * as vercelBlob from "@vercel/blob";
import * as vpsBlob from "./vps-blob-adapter";

export function useVpsBlobBackend(): boolean {
  return vpsBlob.isVpsBlobBackend();
}

/**
 * 記憶體降級的顯式 opt-in 環境變數名（單一真源，勿在各 store 另寫一份）。
 * 非生產環境預設允許降級；生產環境必須顯式設為 "true" 才允許。
 */
export const BLOB_ALLOW_MEMORY_FALLBACK_ENV = "BLOB_ALLOW_MEMORY_FALLBACK";

/**
 * 任一物件儲存後端可用即 true：
 * - VPS `image-data-api`（IMAGE_DATA_BASE_URL + IMAGE_DATA_API_KEY）
 * - Vercel Blob（BLOB_READ_WRITE_TOKEN）
 *
 * 注意：只看 BLOB_READ_WRITE_TOKEN 是舊病灶——生產切到 VPS 後端時 token 為空，
 * 舊判斷式會誤判「無後端」而讓呼叫端靜默落進程內記憶體。
 */
export function blobBackendConfigured(): boolean {
  return useVpsBlobBackend() || Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
}

/**
 * 後端不可用時是否允許降級到進程內記憶體。
 * 非生產（本地開發／測試）預設允許，免基建；生產一律不允許，除非顯式 opt-in。
 */
export function blobMemoryFallbackAllowed(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env[BLOB_ALLOW_MEMORY_FALLBACK_ENV] === "true"
  );
}

/** 物件儲存後端未設定且不允許記憶體降級時拋出——寫入/讀取誠實失敗，不冒充成功。 */
export class BlobBackendUnconfiguredError extends Error {
  constructor(context: string) {
    super(
      `[${context}] 物件儲存後端未設定：此操作不會被持久化。` +
        `請設定 IMAGE_DATA_BASE_URL + IMAGE_DATA_API_KEY（VPS image-data-api），` +
        `或設定 BLOB_READ_WRITE_TOKEN（Vercel Blob）。` +
        `非生產環境若確實要落進程內記憶體（實例冷啟動即失），顯式設 ${BLOB_ALLOW_MEMORY_FALLBACK_ENV}=true。`,
    );
    this.name = "BlobBackendUnconfiguredError";
  }
}

/**
 * 寫入/讀取前的後端門禁（單一真源，各 store 共用）：
 * - 後端可用 → true（走 blob）。
 * - 後端不可用但允許記憶體降級 → false（呼叫端走記憶體）。
 * - 後端不可用且不允許降級 → throw（禁止靜默降級：Vercel 每個實例各有記憶體，冷啟動即消失）。
 */
export function ensureBlobBackendWritable(context: string): boolean {
  if (blobBackendConfigured()) return true;
  if (blobMemoryFallbackAllowed()) return false;
  throw new BlobBackendUnconfiguredError(context);
}

// 服務端衛生：blob 讀寫統一 10s 硬超時，避免上游掛起把請求佔死。
// put 屬寫入且冪等性未知 → 超時不重試，AbortError 依現行錯誤路徑照拋。
// 呼叫方已傳入 abortSignal 時合併兩者（任一觸發即中止）；不支援 AbortSignal.any 時保留呼叫方信號。
const BLOB_TIMEOUT_MS = 10_000;
function blobTimeoutSignal(existing?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(BLOB_TIMEOUT_MS);
  if (!existing) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([existing, timeout]) : existing;
}

export const list = (async (options: Parameters<typeof vercelBlob.list>[0]) => {
  const merged = { ...options, abortSignal: blobTimeoutSignal(options?.abortSignal) } as Parameters<typeof vercelBlob.list>[0];
  return useVpsBlobBackend() ? vpsBlob.list(merged) : vercelBlob.list(merged);
}) as unknown as typeof vercelBlob.list;

export const get = (async (urlOrPathname: string, options?: Parameters<typeof vercelBlob.get>[1]) =>
  useVpsBlobBackend()
    ? vpsBlob.get(urlOrPathname, options ?? {})
    : vercelBlob.get(urlOrPathname, options ?? ({} as Parameters<typeof vercelBlob.get>[1]))) as unknown as typeof vercelBlob.get;

export const put = (async (pathname: string, body: Parameters<typeof vercelBlob.put>[1], options?: Parameters<typeof vercelBlob.put>[2]) => {
  const merged = { ...options, abortSignal: blobTimeoutSignal(options?.abortSignal) } as Parameters<typeof vercelBlob.put>[2];
  return useVpsBlobBackend()
    ? vpsBlob.put(pathname, body as unknown as Parameters<typeof vpsBlob.put>[1], merged)
    : vercelBlob.put(pathname, body, merged);
}) as unknown as typeof vercelBlob.put;

export const del = (async (urls: string[], options?: Parameters<typeof vercelBlob.del>[1]) =>
  useVpsBlobBackend() ? vpsBlob.del(urls, options) : vercelBlob.del(urls, options)) as unknown as typeof vercelBlob.del;
