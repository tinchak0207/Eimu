import { randomBytes } from "node:crypto";
import { del, get, list, put } from "@/lib/blob-backend";
import {
  normalizeModelPricingOverrides,
  type ModelPricingOverrides,
} from "./generation-model-catalog";

/**
 * Blob-backed persistence for admin model pricing overrides: the "change a model's
 * price without redeploying" switchboard. Storage discipline mirrors
 * channel-overrides exactly — immutable timestamped pathnames, page-walking reads,
 * 15s cache, last-known-good + negative backoff — so a Blob outage can never wedge
 * a generation request, and pricing data (non-secret) is plain JSON.
 *
 * Sanitization is deliberately NOT re-implemented here: everything passes through
 * the catalog's `normalizeModelPricingOverrides`. Dependency direction is
 * pricing-overrides → catalog only (catalog is imported by the client bundle and
 * must never touch Blob).
 */

const PRICING_BLOB_TIMEOUT_MS = 3_000;
const FAILURE_BACKOFF_MS = 5_000;
let lastReadFailureAt = 0;

const STORE_PREFIX = "admin/model-pricing-overrides.v1";
/**
 * Pricing changes at human pace but are read on the hot generation path. Cache in
 * module scope, kept short so a warm lambda notices an admin price edit quickly.
 */
const PRICING_CACHE_TTL_MS = 15_000;
/** Superseded configs kept on write, so a reader holding a slightly stale ref still resolves. */
const PRICING_BLOB_GENERATIONS_KEPT = 3;

let memoryOverrides: ModelPricingOverrides = {};
let pricingCache: { overrides: ModelPricingOverrides; version: string | null; expiresAt: number } | null = null;
/**
 * Last-known-good backstop: the most recent overrides that were *successfully*
 * read. Never cleared by the TTL and never replaced by a failed read. A warm
 * instance that has synced once keeps the admin's price through a Blob outage; a
 * cold instance that never read falls back to `{}` — the base catalog prices.
 */
let lastKnownGoodOverrides: ModelPricingOverrides = {};

type OverrideBlobRef = { url: string; pathname: string; uploadedAt: Date };

/**
 * Walk every page. `list({ limit: 100 })` without following `hasMore` breaks once
 * the prefix holds more than one page — Blob pages by pathname, so the newest
 * config falls off page one and admin edits silently stop taking effect.
 */
async function listPricingBlobs(): Promise<OverrideBlobRef[]> {
  const blobs: OverrideBlobRef[] = [];
  let cursor: string | undefined;

  do {
    const page = await list({ prefix: STORE_PREFIX, cursor, abortSignal: AbortSignal.timeout(PRICING_BLOB_TIMEOUT_MS) });
    for (const blob of page.blobs) {
      blobs.push({ url: blob.url, pathname: blob.pathname, uploadedAt: blob.uploadedAt });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return blobs;
}

function newestFirst(blobs: OverrideBlobRef[]): OverrideBlobRef[] {
  return [...blobs].sort((a, b) =>
    b.uploadedAt.getTime() - a.uploadedAt.getTime() || b.pathname.localeCompare(a.pathname)
  );
}

async function fetchModelPricingOverrides(): Promise<{ overrides: ModelPricingOverrides; version: string | null }> {
  const latest = newestFirst(await listPricingBlobs())[0];
  if (!latest) return { overrides: {}, version: null };
  const blob = await get(latest.url, { access: "public", abortSignal: AbortSignal.timeout(PRICING_BLOB_TIMEOUT_MS) });
  if (!blob || blob.statusCode !== 200) {
    // A listed-but-unreadable blob is a *failure*, not "no overrides" — treating
    // it as empty would silently revert to base prices. Let callers fail closed.
    throw new Error(`Failed to fetch model pricing overrides blob (${latest.pathname}).`);
  }
  const raw = JSON.parse(await new Response(blob.stream).text()) as unknown;
  return { overrides: normalizeModelPricingOverrides(raw), version: latest.pathname };
}

export function invalidateModelPricingOverridesCache(): void {
  pricingCache = null;
}

/**
 * `version` is the pathname of the blob the overrides came from (null when none
 * exist yet, or in memory mode). `fresh: true` bypasses the 15s cache — required
 * for the PATCH route's optimistic-concurrency read.
 */
export async function readModelPricingOverrides(options?: { fresh?: boolean }): Promise<{ overrides: ModelPricingOverrides; version: string | null }> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return { overrides: { ...memoryOverrides }, version: null };
  }

  const now = Date.now();
  if (!options?.fresh && pricingCache && pricingCache.expiresAt > now) {
    return { overrides: { ...pricingCache.overrides }, version: pricingCache.version };
  }

  const { overrides, version } = await fetchModelPricingOverrides();
  pricingCache = { overrides, version, expiresAt: now + PRICING_CACHE_TTL_MS };
  lastKnownGoodOverrides = overrides;
  return { overrides: { ...overrides }, version };
}

export async function writeModelPricingOverrides(overrides: ModelPricingOverrides): Promise<{ version: string }> {
  const normalized = normalizeModelPricingOverrides(overrides);

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    if (process.env.NODE_ENV === "production") throw new Error("BLOB_READ_WRITE_TOKEN is not configured.");
    memoryOverrides = normalized;
    invalidateModelPricingOverridesCache();
    return { version: "memory" };
  }

  const previous = await listPricingBlobs().catch(() => [] as OverrideBlobRef[]);
  const pathname = `${STORE_PREFIX}-${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  await put(pathname, JSON.stringify(normalized), {
    abortSignal: AbortSignal.timeout(PRICING_BLOB_TIMEOUT_MS),
    access: "public",
    contentType: "application/json",
    // Floor is 60s, so a fixed overwritten pathname would serve stale pricing for up
    // to a minute. A fresh pathname per save keeps reads immediately correct.
    cacheControlMaxAge: 60,
  });
  invalidateModelPricingOverridesCache();

  const stale = newestFirst(previous).slice(PRICING_BLOB_GENERATIONS_KEPT - 1);
  if (stale.length > 0) {
    await del(stale.map((blob) => blob.url)).catch((error) => {
      console.error("[pricing-overrides] Failed to prune superseded pricing override configs.", error);
    });
  }

  return { version: pathname };
}

/**
 * Never throws. On read failure serves the last-known-good overrides (empty only
 * if no read has ever succeeded) so a Blob outage cannot silently revert a model
 * to its base price after the admin changed it.
 */
export async function getRuntimeModelPricingOverrides(): Promise<ModelPricingOverrides> {
  // Negative cache: during a Blob outage every sync would otherwise re-run the
  // failing list/get (bounded at PRICING_BLOB_TIMEOUT_MS each) before reaching the
  // backstop. Serve last-known-good directly for a short window instead.
  if (Date.now() - lastReadFailureAt < FAILURE_BACKOFF_MS) {
    return { ...lastKnownGoodOverrides };
  }
  try {
    const { overrides } = await readModelPricingOverrides();
    return overrides;
  } catch (error) {
    lastReadFailureAt = Date.now();
    console.error("[pricing-overrides] Failed to read model pricing overrides; serving last-known-good overrides.", error);
    return { ...lastKnownGoodOverrides };
  }
}
