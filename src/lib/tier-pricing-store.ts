// tier-pricing 的 Blob-backed 持久化：代理/分销价目（分层价目）的「改价不用重新部署」
// 开关。储存纪律完全照 pricing-overrides.ts——不可变时间戳路径名、走页读、15s 快取、
// last-known-good + 负向退避——所以 Blob 故障永远不会卡住一张生成请求，价目（非机密）
// 是纯 JSON。
//
// sanitization 不在这里重implement：进出皆走 tier-pricing 核心的
// normalizeTierPricingDocument。依赖方向：tier-pricing-store → tier-pricing（核心纯层）
// → generation-model-catalog。

import { randomBytes } from "node:crypto";
import { del, get, list, put } from "@/lib/blob-backend";
import {
  emptyTierPricingDocument,
  normalizeTierPricingDocument,
  type TierPricingDocument,
} from "./tier-pricing";

const TIER_BLOB_TIMEOUT_MS = 3_000;
const FAILURE_BACKOFF_MS = 5_000;
let lastReadFailureAt = 0;

export const TIER_STORE_PREFIX = "admin/tier-pricing.v1";
const TIER_CACHE_TTL_MS = 15_000;
const TIER_BLOB_GENERATIONS_KEPT = 3;

let memoryDoc: TierPricingDocument = emptyTierPricingDocument();
let tierCache: { doc: TierPricingDocument; version: string | null; expiresAt: number } | null = null;
let lastKnownGoodDoc: TierPricingDocument = emptyTierPricingDocument();

type TierBlobRef = { url: string; pathname: string; uploadedAt: Date };

async function listTierBlobs(): Promise<TierBlobRef[]> {
  const blobs: TierBlobRef[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: TIER_STORE_PREFIX, cursor, abortSignal: AbortSignal.timeout(TIER_BLOB_TIMEOUT_MS) });
    for (const blob of page.blobs) blobs.push({ url: blob.url, pathname: blob.pathname, uploadedAt: blob.uploadedAt });
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

function newestFirst(blobs: TierBlobRef[]): TierBlobRef[] {
  return [...blobs].sort(
    (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime() || b.pathname.localeCompare(a.pathname),
  );
}

async function fetchTierPricingDocument(): Promise<{ doc: TierPricingDocument; version: string | null }> {
  const latest = newestFirst(await listTierBlobs())[0];
  if (!latest) return { doc: emptyTierPricingDocument(), version: null };
  const blob = await get(latest.url, { access: "public", abortSignal: AbortSignal.timeout(TIER_BLOB_TIMEOUT_MS) });
  if (!blob || blob.statusCode !== 200) {
    throw new Error(`Failed to fetch tier pricing blob (${latest.pathname}).`);
  }
  const raw = JSON.parse(await new Response(blob.stream).text()) as unknown;
  return { doc: normalizeTierPricingDocument(raw), version: latest.pathname };
}

export function invalidateTierPricingCache(): void {
  tierCache = null;
}

export async function readTierPricingDocument(options?: { fresh?: boolean }): Promise<{ doc: TierPricingDocument; version: string | null }> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return { doc: { tiers: { ...memoryDoc.tiers }, assignments: { ...memoryDoc.assignments } }, version: null };
  }

  const now = Date.now();
  if (!options?.fresh && tierCache && tierCache.expiresAt > now) {
    return { doc: tierCache.doc, version: tierCache.version };
  }

  const { doc, version } = await fetchTierPricingDocument();
  tierCache = { doc, version, expiresAt: now + TIER_CACHE_TTL_MS };
  lastKnownGoodDoc = doc;
  return { doc, version };
}

export async function writeTierPricingDocument(doc: TierPricingDocument): Promise<{ version: string }> {
  const normalized = normalizeTierPricingDocument(doc);

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    if (process.env.NODE_ENV === "production") throw new Error("BLOB_READ_WRITE_TOKEN is not configured.");
    memoryDoc = normalized;
    invalidateTierPricingCache();
    return { version: "memory" };
  }

  const previous = await listTierBlobs().catch(() => [] as TierBlobRef[]);
  const pathname = `${TIER_STORE_PREFIX}-${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  await put(pathname, JSON.stringify(normalized), {
    abortSignal: AbortSignal.timeout(TIER_BLOB_TIMEOUT_MS),
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  invalidateTierPricingCache();

  const stale = newestFirst(previous).slice(TIER_BLOB_GENERATIONS_KEPT - 1);
  if (stale.length > 0) {
    await del(stale.map((blob) => blob.url)).catch((error) => {
      console.error("[tier-pricing] Failed to prune superseded tier pricing configs.", error);
    });
  }

  return { version: pathname };
}

/**
 * 永不抛错。读取失败时服务 last-known-good（只有从未读取成功的冷实例会拿到空文件——
 * 空 = 全部回落基准价）。Blob 故障不会把已设好的 tier 价静默改回基准价。
 */
export async function getRuntimeTierPricingDocument(): Promise<TierPricingDocument> {
  if (Date.now() - lastReadFailureAt < FAILURE_BACKOFF_MS) {
    return lastKnownGoodDoc;
  }
  try {
    const { doc } = await readTierPricingDocument();
    return doc;
  } catch (error) {
    lastReadFailureAt = Date.now();
    console.error("[tier-pricing] Failed to read tier pricing; serving last-known-good document.", error);
    return lastKnownGoodDoc;
  }
}