import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { del, get, list, put } from "@/lib/blob-backend";
import type { AdminPool } from "./admin-pools";

const STORE_PREFIX = "admin/image-pools.v1";
/**
 * Managed pools change at human pace (an admin saving /admin), but the generation
 * route read them on *every* request — list() + get() = two Blob round-trips per
 * image, so a single `copies: 8` click cost sixteen. Cache them in module scope.
 *
 * Kept deliberately short: /admin has to stay honest about what production is
 * actually routing through, and this is the window where another warm lambda can
 * still be serving the previous config.
 */
const POOL_CACHE_TTL_MS = 15_000;
/** Superseded configs kept on write, so a reader holding a slightly stale URL still resolves. */
const POOL_BLOB_GENERATIONS_KEPT = 3;

let memoryPools: AdminPool[] = [];
let poolCache: { pools: AdminPool[]; expiresAt: number } | null = null;

interface EncryptedPayload {
  version: 1;
  iv: string;
  tag: string;
  data: string;
}

function encryptionKey(): Buffer {
  const secret = process.env.ADMIN_POOL_ENCRYPTION_KEY?.trim();
  if (!secret) throw new Error("ADMIN_POOL_ENCRYPTION_KEY is not configured.");
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptAdminPools(pools: AdminPool[]): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(pools), "utf8"), cipher.final()]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  } satisfies EncryptedPayload);
}

export function decryptAdminPools(value: string): AdminPool[] {
  const payload = JSON.parse(value) as EncryptedPayload;
  if (payload.version !== 1 || !payload.iv || !payload.tag || !payload.data) throw new Error("Invalid pool configuration.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8");
  const pools = JSON.parse(plain) as unknown;
  if (!Array.isArray(pools)) throw new Error("Invalid pool configuration.");
  return pools as AdminPool[];
}

type PoolBlobRef = { url: string; pathname: string; uploadedAt: Date };

/**
 * Every saved config lives at its own timestamped pathname. The previous
 * implementation read them with `list({ limit: 100 })` and ignored `hasMore`, and
 * Blob pages by pathname — so once this prefix held more than 100 saves the newest
 * config fell off page one and admin edits silently stopped taking effect. Walk
 * every page.
 */
async function listPoolBlobs(): Promise<PoolBlobRef[]> {
  const blobs: PoolBlobRef[] = [];
  let cursor: string | undefined;

  do {
    const page = await list({ prefix: STORE_PREFIX, cursor });
    for (const blob of page.blobs) {
      blobs.push({ url: blob.url, pathname: blob.pathname, uploadedAt: blob.uploadedAt });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return blobs;
}

function newestFirst(blobs: PoolBlobRef[]): PoolBlobRef[] {
  return [...blobs].sort((a, b) =>
    b.uploadedAt.getTime() - a.uploadedAt.getTime() || b.pathname.localeCompare(a.pathname)
  );
}

async function fetchAdminPools(): Promise<AdminPool[]> {
  const latest = newestFirst(await listPoolBlobs())[0];
  if (!latest) return [];
  const blob = await get(latest.url, { access: "public" });
  if (!blob || blob.statusCode !== 200) return [];
  return decryptAdminPools(await new Response(blob.stream).text());
}

export function invalidateAdminPoolCache(): void {
  poolCache = null;
}

export async function readAdminPools(): Promise<AdminPool[]> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return [...memoryPools];

  const now = Date.now();
  if (poolCache && poolCache.expiresAt > now) return [...poolCache.pools];

  const pools = await fetchAdminPools();
  poolCache = { pools, expiresAt: now + POOL_CACHE_TTL_MS };
  return [...pools];
}

export async function writeAdminPools(pools: AdminPool[]): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    if (process.env.NODE_ENV === "production") throw new Error("BLOB_READ_WRITE_TOKEN is not configured.");
    memoryPools = pools;
    invalidateAdminPoolCache();
    return;
  }

  const previous = await listPoolBlobs().catch(() => [] as PoolBlobRef[]);
  const pathname = `${STORE_PREFIX}-${Date.now()}-${randomBytes(4).toString("hex")}.enc.json`;
  await put(pathname, encryptAdminPools(pools), {
    access: "public",
    contentType: "application/json",
    // Floor is 60s, so a fixed overwritten pathname would serve stale config for up
    // to a minute. A fresh pathname per save keeps reads immediately correct.
    cacheControlMaxAge: 60,
  });
  invalidateAdminPoolCache();

  // Nothing ever deleted these before, so the prefix grew without bound.
  const stale = newestFirst(previous).slice(POOL_BLOB_GENERATIONS_KEPT - 1);
  if (stale.length > 0) {
    await del(stale.map((blob) => blob.url)).catch((error) => {
      console.error("[admin-pools] Failed to prune superseded pool configs.", error);
    });
  }
}

export async function getRuntimeGatewayPools(): Promise<AdminPool[]> {
  try {
    return await readAdminPools();
  } catch (error) {
    console.error("[admin-pools] Failed to read managed pools; using environment endpoints.", error);
    return [];
  }
}
