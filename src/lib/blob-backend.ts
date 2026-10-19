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
 * 记忆体降级的显式 opt-in 环境变数名（单一真源，勿在各 store 另写一份）。
 * 非生产环境预设允许降级；生产环境必须显式设为 "true" 才允许。
 */
export const BLOB_ALLOW_MEMORY_FALLBACK_ENV = "BLOB_ALLOW_MEMORY_FALLBACK";

/**
 * 任一物件储存后端可用即 true：
 * - VPS `image-data-api`（IMAGE_DATA_BASE_URL + IMAGE_DATA_API_KEY）
 * - Vercel Blob（BLOB_READ_WRITE_TOKEN）
 *
 * 注意：只看 BLOB_READ_WRITE_TOKEN 是旧病灶——生产切到 VPS 后端时 token 为空，
 * 旧判断式会误判「无后端」而让呼叫端静默落进程内记忆体。
 */
export function blobBackendConfigured(): boolean {
  // `useVpsBlobBackend` 不是 React hook，是 blob-backend 的同步后端选择器，只因命名以 use
  // 开头被 react-hooks/rules-of-hooks 误判（同款豁免见 src/app/api/version/route.ts）。
  // 单源判断不可在此重抄一份，故就地豁免该规则。
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useVpsBlobBackend() || Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
}

/**
 * 后端不可用时是否允许降级到进程内记忆体。
 * 非生产（本地开发／测试）预设允许，免基建；生产一律不允许，除非显式 opt-in。
 */
export function blobMemoryFallbackAllowed(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env[BLOB_ALLOW_MEMORY_FALLBACK_ENV] === "true"
  );
}

/** 物件储存后端未设定且不允许记忆体降级时抛出——写入/读取诚实失败，不冒充成功。 */
export class BlobBackendUnconfiguredError extends Error {
  constructor(context: string) {
    super(
      `[${context}] 物件储存后端未设定：此操作不会被持久化。` +
        `请设定 IMAGE_DATA_BASE_URL + IMAGE_DATA_API_KEY（VPS image-data-api），` +
        `或设定 BLOB_READ_WRITE_TOKEN（Vercel Blob）。` +
        `非生产环境若确实要落进程内记忆体（实例冷启动即失），显式设 ${BLOB_ALLOW_MEMORY_FALLBACK_ENV}=true。`,
    );
    this.name = "BlobBackendUnconfiguredError";
  }
}

/**
 * 写入/读取前的后端门禁（单一真源，各 store 共用）：
 * - 后端可用 → true（走 blob）。
 * - 后端不可用但允许记忆体降级 → false（呼叫端走记忆体）。
 * - 后端不可用且不允许降级 → throw（禁止静默降级：Vercel 每个实例各有记忆体，冷启动即消失）。
 */
export function ensureBlobBackendWritable(context: string): boolean {
  if (blobBackendConfigured()) return true;
  if (blobMemoryFallbackAllowed()) return false;
  throw new BlobBackendUnconfiguredError(context);
}

// 服务端卫生：blob 读写统一 10s 硬超时，避免上游挂起把请求占死。
// put 属写入且幂等性未知 → 超时不重试，AbortError 依现行错误路径照抛。
// 呼叫方已传入 abortSignal 时合并两者（任一触发即中止）；不支援 AbortSignal.any 时保留呼叫方信号。
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
