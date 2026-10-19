import { randomBytes } from "node:crypto";
import { del, get, list, put } from "@/lib/blob-backend";

/**
 * Blob-backed persistence for channel overrides: the admin's "disable / reorder a
 * channel without redeploying" switchboard. Contents are non-secret (enabled flag
 * and priority only), stored as plain JSON.
 */

export interface ChannelOverride {
  enabled?: boolean;
  priority?: number;
}

export type ChannelOverrides = Record<string, ChannelOverride>;

// @vercel/blob 预设重试 10 次、指数退避可达 ~17 分钟——热路径上的 overrides 读取
// 若无硬超时，Blob 故障会把「每一个」生成请求 wedge 到 maxDuration 硬杀，比它要
// 防的问题更糟。超时即走 last-known-good 兜底。
const OVERRIDES_BLOB_TIMEOUT_MS = 3_000;
// 故障期间的负向快取：读取失败后短暂直接服务 last-known-good，避免故障风暴中
// 每个请求都重撞一次 Blob。
const FAILURE_BACKOFF_MS = 5_000;
let lastReadFailureAt = 0;

const STORE_PREFIX = "admin/channel-overrides.v1";
/**
 * Overrides change at human pace but are read on the hot generation path. Cache in
 * module scope, kept short so a warm lambda notices an admin toggle quickly.
 */
const OVERRIDE_CACHE_TTL_MS = 15_000;
/** Superseded configs kept on write, so a reader holding a slightly stale ref still resolves. */
const OVERRIDE_BLOB_GENERATIONS_KEPT = 3;

let memoryOverrides: ChannelOverrides = {};
let overrideCache: { overrides: ChannelOverrides; version: string | null; expiresAt: number } | null = null;
/**
 * Last-known-good backstop: the most recent overrides that were *successfully*
 * read. Never cleared by the TTL and never replaced by a failed read.
 *
 * Honest scope of this protection: it is per-instance. A *warm* lambda that has
 * read the overrides once will keep honouring an admin's channel disable through
 * a Blob outage. A *cold* instance that has never read successfully falls back
 * to `{}` — env defaults — which re-enables disabled channels on that instance
 * for the duration of the outage. True cross-instance fail-closed would need a
 * second durable store; blocking generation entirely on a telemetry-tier
 * dependency was judged worse than this residual window.
 */
let lastKnownGoodOverrides: ChannelOverrides = {};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Sanitizes untrusted input (blob contents, PATCH bodies) down to the schema:
 * `enabled` must be a boolean, `priority` an integer in [0, 99]; entries with
 * neither valid field are dropped. Keys are intentionally not validated against
 * the channel registry — that is the admin route's job.
 */
export function normalizeChannelOverrides(raw: unknown): ChannelOverrides {
  if (!isPlainObject(raw)) return {};

  const overrides: ChannelOverrides = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) continue;

    const entry: ChannelOverride = {};
    if (typeof value.enabled === "boolean") entry.enabled = value.enabled;
    const priority = value.priority;
    if (typeof priority === "number" && Number.isInteger(priority) && priority >= 0 && priority <= 99) {
      entry.priority = priority;
    }
    if (entry.enabled === undefined && entry.priority === undefined) continue;

    // defineProperty instead of assignment: JSON.parse can hand us an own
    // "__proto__" key, and `overrides[key] = entry` would set the prototype
    // instead of an own property.
    Object.defineProperty(overrides, key, { value: entry, enumerable: true, writable: true, configurable: true });
  }
  return overrides;
}

type OverrideBlobRef = { url: string; pathname: string; uploadedAt: Date };

/**
 * Walk every page. `list({ limit: 100 })` without following `hasMore` is how
 * admin-pool-store historically broke: Blob pages by pathname, so once the prefix
 * held more than one page the newest config fell off page one and admin edits
 * silently stopped taking effect.
 */
async function listOverrideBlobs(): Promise<OverrideBlobRef[]> {
  const blobs: OverrideBlobRef[] = [];
  let cursor: string | undefined;

  do {
    const page = await list({ prefix: STORE_PREFIX, cursor, abortSignal: AbortSignal.timeout(OVERRIDES_BLOB_TIMEOUT_MS) });
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

async function fetchChannelOverrides(): Promise<{ overrides: ChannelOverrides; version: string | null }> {
  const latest = newestFirst(await listOverrideBlobs())[0];
  if (!latest) return { overrides: {}, version: null };
  const blob = await get(latest.url, { access: "public", abortSignal: AbortSignal.timeout(OVERRIDES_BLOB_TIMEOUT_MS) });
  if (!blob || blob.statusCode !== 200) {
    // A listed-but-unreadable blob is a *failure*, not "no overrides" — treating
    // it as empty would resurrect disabled channels. Let callers fail closed.
    throw new Error(`Failed to fetch channel overrides blob (${latest.pathname}).`);
  }
  const raw = JSON.parse(await new Response(blob.stream).text()) as unknown;
  return { overrides: normalizeChannelOverrides(raw), version: latest.pathname };
}

export function invalidateChannelOverridesCache(): void {
  overrideCache = null;
}

/**
 * `version` is the pathname of the blob the overrides came from (null when none
 * exist yet, or in memory mode). `fresh: true` bypasses the 15s cache — required
 * for the PATCH route's optimistic-concurrency read.
 */
export async function readChannelOverrides(options?: { fresh?: boolean }): Promise<{ overrides: ChannelOverrides; version: string | null }> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return { overrides: { ...memoryOverrides }, version: null };
  }

  const now = Date.now();
  if (!options?.fresh && overrideCache && overrideCache.expiresAt > now) {
    return { overrides: { ...overrideCache.overrides }, version: overrideCache.version };
  }

  const { overrides, version } = await fetchChannelOverrides();
  overrideCache = { overrides, version, expiresAt: now + OVERRIDE_CACHE_TTL_MS };
  lastKnownGoodOverrides = overrides;
  return { overrides: { ...overrides }, version };
}

export async function writeChannelOverrides(overrides: ChannelOverrides): Promise<{ version: string }> {
  const normalized = normalizeChannelOverrides(overrides);

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    if (process.env.NODE_ENV === "production") throw new Error("BLOB_READ_WRITE_TOKEN is not configured.");
    memoryOverrides = normalized;
    invalidateChannelOverridesCache();
    return { version: "memory" };
  }

  const previous = await listOverrideBlobs().catch(() => [] as OverrideBlobRef[]);
  const pathname = `${STORE_PREFIX}-${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  await put(pathname, JSON.stringify(normalized), {
    abortSignal: AbortSignal.timeout(OVERRIDES_BLOB_TIMEOUT_MS),
    access: "public",
    contentType: "application/json",
    // Floor is 60s, so a fixed overwritten pathname would serve stale config for up
    // to a minute. A fresh pathname per save keeps reads immediately correct.
    cacheControlMaxAge: 60,
  });
  invalidateChannelOverridesCache();

  const stale = newestFirst(previous).slice(OVERRIDE_BLOB_GENERATIONS_KEPT - 1);
  if (stale.length > 0) {
    await del(stale.map((blob) => blob.url)).catch((error) => {
      console.error("[channel-overrides] Failed to prune superseded override configs.", error);
    });
  }

  return { version: pathname };
}

/**
 * Never throws. On read failure serves the last-known-good overrides (empty only
 * if no read has ever succeeded) so a Blob outage cannot silently re-enable a
 * channel the admin turned off.
 */
export async function getRuntimeChannelOverrides(): Promise<ChannelOverrides> {
  // Negative cache: during a Blob outage every generation request would otherwise
  // re-run the failing list/get (bounded at OVERRIDES_BLOB_TIMEOUT_MS each) before
  // reaching the backstop. Serve last-known-good directly for a short window instead.
  if (Date.now() - lastReadFailureAt < FAILURE_BACKOFF_MS) {
    return { ...lastKnownGoodOverrides };
  }
  try {
    const { overrides } = await readChannelOverrides();
    return overrides;
  } catch (error) {
    lastReadFailureAt = Date.now();
    console.error("[channel-overrides] Failed to read channel overrides; serving last-known-good overrides.", error);
    return { ...lastKnownGoodOverrides };
  }
}
