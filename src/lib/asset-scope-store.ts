// REQ-B2 團隊資產空間：作用域層的持久化（Blob）。
//
// 存儲選型：**逐字沿用作業系統既有的 Blob 世代模式**（character-card-store.ts /
// asset-pack-store.ts / canvas/project-store.ts 同一套輪子）——每用戶一份 index 文件、
// 每次寫入落到新路徑 + 修剪舊世代（規避 Blob cacheControlMaxAge 60s 下限造成的
// 「剛存讀不到」）、單用戶寫入串行（write queue）、無 Blob 時記憶體降級。
// 本檔只存兩種**連結記錄**（顯式分享授權 / 項目掛用），不存資產本體：
// 資產本體仍是 asset-pack-store 與 character-card-store 那兩套表示（禁另造格式）。
import { randomBytes } from "node:crypto";
import { del, get, list, put } from "@/lib/blob-backend";
import { sanitizeBlobSegment } from "@/lib/history-types";
import {
  applyAssetMount,
  applyAssetShareGrant,
  applyAssetShareRevoke,
  applyAssetUnmount,
  normalizeAssetMount,
  normalizeAssetShare,
} from "./asset-scope";
import type { AssetKind, AssetMountRecord, AssetShareRecord } from "./asset-scope";

const SCOPE_SCHEMA_VERSION = 1;
const INDEX_GENERATIONS_KEPT = 2;
const INDEX_CACHE_TTL_MS = 3_000;

/** 每用戶分享授權上限（超出時 grantAssetShare 拒絕，不做靜默截斷）。 */
export const MAX_SHARES_PER_USER = 200;
/** 每用戶掛用記錄上限（同上，拒絕而非靜默丟）。 */
export const MAX_MOUNTS_PER_USER = 500;

/** 分享授權數達上限時拋出（API 層轉 400，誠實拒絕）。 */
export class AssetShareLimitError extends Error {
  constructor() {
    super(`资产分享记录已达上限 ${MAX_SHARES_PER_USER} 条`);
    this.name = "AssetShareLimitError";
  }
}

/** 掛用記錄數達上限時拋出（API 層轉 400，誠實拒絕）。 */
export class AssetMountLimitError extends Error {
  constructor() {
    super(`项目资产挂用记录已达上限 ${MAX_MOUNTS_PER_USER} 条`);
    this.name = "AssetMountLimitError";
  }
}

/**
 * 確定性鍵碰撞（同鍵不同三元組）時拋出——API 層轉 409。
 * 正常呼叫無法產生碰撞（鍵段單射 + id 邊界拒絕分隔符），此為防禦性閘：
 * **碰撞絕不得冒充冪等重放回 `success:true`**（舊版就是這樣把別名掛用靜默吞掉）。
 */
export class AssetMountConflictError extends Error {
  constructor() {
    super("资产挂用键冲突：同一确定性键对应了不同的资产");
    this.name = "AssetMountConflictError";
  }
}

/** 分享授權鍵碰撞（同上，API 層轉 409）。 */
export class AssetShareConflictError extends Error {
  constructor() {
    super("资产分享键冲突：同一确定性键对应了不同的授权三元组");
    this.name = "AssetShareConflictError";
  }
}

type Collection = "shares" | "mounts";

const memoryStore = new Map<string, unknown[]>();
const indexCache = new Map<string, { rows: unknown[]; expiresAt: number }>();
const writeQueues = new Map<string, Promise<unknown>>();

function hasBlobStore(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/** 命名空間：asset-scope/{userId}/{shares|mounts}/index-*。 */
function collectionPrefix(userId: number, collection: Collection): string {
  return `asset-scope/${sanitizeBlobSegment(String(userId), "0")}/${collection}`;
}

function indexPrefix(userId: number, collection: Collection): string {
  return `${collectionPrefix(userId, collection)}/index-`;
}

function memoryKey(userId: number, collection: Collection): string {
  return `${userId}:${collection}`;
}

function enqueue<T>(queueKey: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(queueKey) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  writeQueues.set(queueKey, next.catch(() => undefined));
  return next;
}

type BlobRef = { url: string; pathname: string; uploadedAt: Date };

async function listIndexBlobs(userId: number, collection: Collection): Promise<BlobRef[]> {
  const blobs: BlobRef[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: indexPrefix(userId, collection), cursor });
    for (const blob of page.blobs) {
      blobs.push({ url: blob.url, pathname: blob.pathname, uploadedAt: blob.uploadedAt });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
}

function parseDocument(collection: Collection, payload: unknown): unknown[] {
  const key = collection;
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as Record<string, unknown> | null)?.[key])
      ? ((payload as Record<string, unknown>)[key] as unknown[])
      : [];
  const normalize = collection === "shares" ? normalizeAssetShare : normalizeAssetMount;
  return raw.flatMap((item) => {
    const normalized = normalize(item);
    return normalized ? [normalized] : [];
  });
}

async function readBlobDocument(urlOrPath: string, collection: Collection): Promise<unknown[]> {
  try {
    const blob = await get(urlOrPath, { access: "public" });
    if (!blob || blob.statusCode !== 200) return [];
    const text = await new Response(blob.stream).text();
    if (!text) return [];
    return parseDocument(collection, JSON.parse(text) as unknown);
  } catch {
    return [];
  }
}

async function fetchRows(userId: number, collection: Collection): Promise<unknown[]> {
  const blobs = await listIndexBlobs(userId, collection);
  if (blobs.length) return readBlobDocument(blobs[0].url, collection);
  return [];
}

async function readRows<T>(userId: number, collection: Collection): Promise<T[]> {
  const key = memoryKey(userId, collection);
  if (!hasBlobStore()) return [...((memoryStore.get(key) ?? []) as T[])];
  const cached = indexCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return [...(cached.rows as T[])];
  const rows = (await fetchRows(userId, collection)) as T[];
  indexCache.set(key, { rows, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  return [...rows];
}

async function writeRows(userId: number, collection: Collection, rows: unknown[]): Promise<void> {
  const key = memoryKey(userId, collection);
  if (!hasBlobStore()) {
    memoryStore.set(key, rows);
    indexCache.delete(key);
    return;
  }
  const previous = await listIndexBlobs(userId, collection).catch(() => [] as BlobRef[]);
  const pathname = `${indexPrefix(userId, collection)}${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  await put(pathname, JSON.stringify({ schemaVersion: SCOPE_SCHEMA_VERSION, [collection]: rows }), {
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  indexCache.set(key, { rows, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  const stale = previous.slice(INDEX_GENERATIONS_KEPT - 1);
  if (stale.length) {
    await del(stale.map((b) => b.url)).catch((error) => {
      console.error("[asset-scope] 清理舊索引失敗。", error);
    });
  }
}

// ─────────────────────────────────────────── 對外接口

/** 讀當前用戶的全部分享授權（含已撤銷；呼叫端自行過 isAssetShareActive）。 */
export async function listAssetShares(userId: number): Promise<AssetShareRecord[]> {
  return readRows<AssetShareRecord>(userId, "shares");
}

/** 讀當前用戶的全部掛用記錄（跨項目；列表時按 projectId 過濾）。 */
export async function listAssetMounts(userId: number): Promise<AssetMountRecord[]> {
  return readRows<AssetMountRecord>(userId, "mounts");
}

/**
 * 顯式分享（冪等 upsert by 確定性 id）：同一次分享重放 → created:false，不新增第二筆。
 * 呼叫端必須先過 decideAssetShareGrant（本函式只管落盤語義，不管權限裁決）。
 */
export async function grantAssetShare(
  userId: number,
  input: { assetKind: AssetKind; assetId: string; fromProjectId: string; toProjectId: string; now?: string },
): Promise<{ share: AssetShareRecord; created: boolean }> {
  const normalized = normalizeAssetShare({
    assetKind: input.assetKind,
    assetId: input.assetId,
    fromProjectId: input.fromProjectId,
    toProjectId: input.toProjectId,
    createdAt: input.now ?? new Date().toISOString(),
  });
  if (!normalized) throw new Error("invalid asset share");
  return enqueue(`${userId}:shares`, async () => {
    const current = await readRows<AssetShareRecord>(userId, "shares");
    const applied = applyAssetShareGrant(current, input);
    if (applied.conflict) throw new AssetShareConflictError();
    if (applied.created && current.length >= MAX_SHARES_PER_USER) throw new AssetShareLimitError();
    // 已生效的同鍵重放：什麼都不寫（零副作用）；新鍵或撤銷後復活才落盤。
    const wasRevoked = current.some((s) => s.id === applied.share.id && s.revokedAt !== undefined);
    if (applied.created || wasRevoked) await writeRows(userId, "shares", applied.shares);
    return { share: applied.share, created: applied.created };
  });
}

/** 撤銷分享授權（按確定性 id）。回是否真的撤銷了。 */
export async function revokeAssetShare(userId: number, shareId: string): Promise<boolean> {
  if (!shareId.trim()) return false;
  return enqueue(`${userId}:shares`, async () => {
    const current = await readRows<AssetShareRecord>(userId, "shares");
    const applied = applyAssetShareRevoke(current, shareId.trim());
    if (!applied.revoked) return false;
    await writeRows(userId, "shares", applied.shares);
    return true;
  });
}

/**
 * 項目掛用（冪等 upsert by 確定性 id）：同鍵重掛 → created:false，
 * 記錄與 idempotencyRef 逐位不變（跨項目復用不雙扣的落點）。
 *
 * `cardCopyIds`（D1）：本次掛用**實際鎖進 cardIds 的卡副本清單**。新建時落盤；
 * 同鍵重放時取聯集，清單沒變則完全不寫（冪等重放零副作用）。
 * 落盤的理由：解除掛用時要解鎖「當時真的鎖過的副本」，事後再推導（來源條目/本地包副本
 * 都可能已變）會漏解 → 「已解除但仍被注入」且永不自我修復。
 */
export async function mountAsset(
  userId: number,
  input: {
    projectId: string;
    assetKind: AssetKind;
    assetId: string;
    now?: string;
    cardCopyIds?: readonly string[];
  },
): Promise<{ mount: AssetMountRecord; created: boolean }> {
  const normalized = normalizeAssetMount({
    projectId: input.projectId,
    assetKind: input.assetKind,
    assetId: input.assetId,
    mountedAt: input.now ?? new Date().toISOString(),
    ...(input.cardCopyIds ? { cardCopyIds: [...input.cardCopyIds] } : {}),
  });
  if (!normalized) throw new Error("invalid asset mount");
  return enqueue(`${userId}:mounts`, async () => {
    const current = await readRows<AssetMountRecord>(userId, "mounts");
    const applied = applyAssetMount(current, input);
    if (applied.conflict) throw new AssetMountConflictError();
    if (applied.created && current.length >= MAX_MOUNTS_PER_USER) throw new AssetMountLimitError();
    if (applied.created || applied.updated) await writeRows(userId, "mounts", applied.mounts);
    return { mount: applied.mount, created: applied.created };
  });
}

/** 解除掛用（按 projectId + 三元組推導的確定性 id）。回是否真的移除了。 */
export async function unmountAsset(
  userId: number,
  input: { projectId: string; assetKind: AssetKind; assetId: string },
): Promise<boolean> {
  // 先過清洗收口：非法/超長/含分隔符的 id 不可能命中任何鍵，直接回 false（不再用未清洗的字串拼鍵）。
  const normalized = normalizeAssetMount({
    projectId: input.projectId,
    assetKind: input.assetKind,
    assetId: input.assetId,
  });
  if (!normalized) return false;
  return enqueue(`${userId}:mounts`, async () => {
    const current = await readRows<AssetMountRecord>(userId, "mounts");
    const applied = applyAssetUnmount(current, normalized.id);
    if (!applied.removed) return false;
    await writeRows(userId, "mounts", applied.mounts);
    return true;
  });
}

/** 僅測試：重置進程內狀態。 */
export function __resetAssetScopeStoreForTests(): void {
  memoryStore.clear();
  indexCache.clear();
  writeQueues.clear();
}
