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
