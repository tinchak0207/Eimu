// external-channels 的 Blob-backed 持久化：B 端自定义上游的「改配置不用重新部署」
// 开关。储存纪律完全照 pricing-overrides.ts / tier-pricing-store.ts——不可变时间戳
// 路径名、走页读、15s 快取、last-known-good + 负向退避——所以 Blob 故障永远不会卡住
// 一张生成请求。**原始 credential 永不落 Blob**：channel 只存 credentialRef（环境变数名）。

import { randomBytes } from "node:crypto";
import { del, get, list, put } from "@/lib/blob-backend";
import {
  emptyExternalChannelDocument,
  normalizeExternalChannelDocument,
  type ExternalChannelDocument,
} from "./external-channels";

const CHANNEL_BLOB_TIMEOUT_MS = 3_000;
const FAILURE_BACKOFF_MS = 5_000;
let lastReadFailureAt = 0;

export const EXTERNAL_CHANNELS_STORE_PREFIX = "admin/external-channels.v1";
const CHANNEL_CACHE_TTL_MS = 15_000;
const CHANNEL_BLOB_GENERATIONS_KEPT = 3;

let memoryDoc: ExternalChannelDocument = emptyExternalChannelDocument();
let channelCache: { doc: ExternalChannelDocument; version: string | null; expiresAt: number } | null = null;
let lastKnownGoodDoc: ExternalChannelDocument = emptyExternalChannelDocument();

type ChannelBlobRef = { url: string; pathname: string; uploadedAt: Date };

async function listChannelBlobs(): Promise<ChannelBlobRef[]> {
  const blobs: ChannelBlobRef[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: EXTERNAL_CHANNELS_STORE_PREFIX, cursor, abortSignal: AbortSignal.timeout(CHANNEL_BLOB_TIMEOUT_MS) });
    for (const blob of page.blobs) blobs.push({ url: blob.url, pathname: blob.pathname, uploadedAt: blob.uploadedAt });
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

function newestFirst(blobs: ChannelBlobRef[]): ChannelBlobRef[] {
  return [...blobs].sort(
    (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime() || b.pathname.localeCompare(a.pathname),
  );
}

async function fetchExternalChannelDocument(): Promise<{ doc: ExternalChannelDocument; version: string | null }> {
  const latest = newestFirst(await listChannelBlobs())[0];
  if (!latest) return { doc: emptyExternalChannelDocument(), version: null };
  const blob = await get(latest.url, { access: "public", abortSignal: AbortSignal.timeout(CHANNEL_BLOB_TIMEOUT_MS) });
  if (!blob || blob.statusCode !== 200) {
    throw new Error(`Failed to fetch external channels blob (${latest.pathname}).`);
  }
  const raw = JSON.parse(await new Response(blob.stream).text()) as unknown;
  return { doc: normalizeExternalChannelDocument(raw), version: latest.pathname };
}

export function invalidateExternalChannelCache(): void {
  channelCache = null;
}

export async function readExternalChannelDocument(options?: { fresh?: boolean }): Promise<{ doc: ExternalChannelDocument; version: string | null }> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return { doc: { channels: [...memoryDoc.channels] }, version: null };
  }

  const now = Date.now();
  if (!options?.fresh && channelCache && channelCache.expiresAt > now) {
    return { doc: channelCache.doc, version: channelCache.version };
  }

  const { doc, version } = await fetchExternalChannelDocument();
  channelCache = { doc, version, expiresAt: now + CHANNEL_CACHE_TTL_MS };
  lastKnownGoodDoc = doc;
  return { doc, version };
}

export async function writeExternalChannelDocument(doc: ExternalChannelDocument): Promise<{ version: string }> {
  const normalized = normalizeExternalChannelDocument(doc);

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    if (process.env.NODE_ENV === "production") throw new Error("BLOB_READ_WRITE_TOKEN is not configured.");
    memoryDoc = normalized;
    invalidateExternalChannelCache();
    return { version: "memory" };
  }

  const previous = await listChannelBlobs().catch(() => [] as ChannelBlobRef[]);
  const pathname = `${EXTERNAL_CHANNELS_STORE_PREFIX}-${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  await put(pathname, JSON.stringify(normalized), {
    abortSignal: AbortSignal.timeout(CHANNEL_BLOB_TIMEOUT_MS),
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  invalidateExternalChannelCache();

  const stale = newestFirst(previous).slice(CHANNEL_BLOB_GENERATIONS_KEPT - 1);
  if (stale.length > 0) {
    await del(stale.map((blob) => blob.url)).catch((error) => {
      console.error("[external-channels] Failed to prune superseded external channel configs.", error);
    });
  }

  return { version: pathname };
}

/**
 * 永不抛错。读取失败时服务 last-known-good（只有从未读取成功的冷实例会拿到空文件）。
 * Blob 故障不会把已设好的外部上游静默移除。
 */
export async function getRuntimeExternalChannelDocument(): Promise<ExternalChannelDocument> {
  if (Date.now() - lastReadFailureAt < FAILURE_BACKOFF_MS) {
    return lastKnownGoodDoc;
  }
  try {
    const { doc } = await readExternalChannelDocument();
    return doc;
  } catch (error) {
    lastReadFailureAt = Date.now();
    console.error("[external-channels] Failed to read external channels; serving last-known-good document.", error);
    return lastKnownGoodDoc;
  }
}
