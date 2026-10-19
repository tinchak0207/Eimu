// REQ-B2 团队资产空间：作用域层的持久化（Blob）。
//
// 存储选型：**逐字沿用作业系统既有的 Blob 世代模式**（character-card-store.ts /
// asset-pack-store.ts / canvas/project-store.ts 同一套轮子）——每用户一份 index 文件、
// 每次写入落到新路径 + 修剪旧世代（规避 Blob cacheControlMaxAge 60s 下限造成的
// 「刚存读不到」）、单用户写入串行（write queue）、无 Blob 时记忆体降级。
// 本档只存两种**连结记录**（显式分享授权 / 项目挂用），不存资产本体：
// 资产本体仍是 asset-pack-store 与 character-card-store 那两套表示（禁另造格式）。
import { randomBytes } from "node:crypto";
import { del, ensureBlobBackendWritable, get, list, put } from "@/lib/blob-backend";
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

/** 每用户分享授权上限（超出时 grantAssetShare 拒绝，不做静默截断）。 */
export const MAX_SHARES_PER_USER = 200;
/** 每用户挂用记录上限（同上，拒绝而非静默丢）。 */
export const MAX_MOUNTS_PER_USER = 500;

/** 分享授权数达上限时抛出（API 层转 400，诚实拒绝）。 */
export class AssetShareLimitError extends Error {
  constructor() {
    super(`资产分享记录已达上限 ${MAX_SHARES_PER_USER} 条`);
    this.name = "AssetShareLimitError";
  }
}

/** 挂用记录数达上限时抛出（API 层转 400，诚实拒绝）。 */
export class AssetMountLimitError extends Error {
  constructor() {
    super(`项目资产挂用记录已达上限 ${MAX_MOUNTS_PER_USER} 条`);
    this.name = "AssetMountLimitError";
  }
}

/**
 * 确定性键碰撞（同键不同三元组）时抛出——API 层转 409。
 * 正常呼叫无法产生碰撞（键段单射 + id 边界拒绝分隔符），此为防御性闸：
 * **碰撞绝不得冒充幂等重放回 `success:true`**（旧版就是这样把别名挂用静默吞掉）。
 */
export class AssetMountConflictError extends Error {
  constructor() {
    super("资产挂用键冲突：同一确定性键对应了不同的资产");
    this.name = "AssetMountConflictError";
  }
}

/** 分享授权键碰撞（同上，API 层转 409）。 */
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

/** 命名空间：asset-scope/{userId}/{shares|mounts}/index-*。 */
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
  if (!ensureBlobBackendWritable("asset-scope-store.readRows")) return [...((memoryStore.get(key) ?? []) as T[])];
  const cached = indexCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return [...(cached.rows as T[])];
  const rows = (await fetchRows(userId, collection)) as T[];
  indexCache.set(key, { rows, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  return [...rows];
}

async function writeRows(userId: number, collection: Collection, rows: unknown[]): Promise<void> {
  const key = memoryKey(userId, collection);
  if (!ensureBlobBackendWritable("asset-scope-store.writeRows")) {
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
      console.error("[asset-scope] 清理旧索引失败。", error);
    });
  }
}

// ─────────────────────────────────────────── 对外接口

/** 读当前用户的全部分享授权（含已撤销；呼叫端自行过 isAssetShareActive）。 */
export async function listAssetShares(userId: number): Promise<AssetShareRecord[]> {
  return readRows<AssetShareRecord>(userId, "shares");
}

/** 读当前用户的全部挂用记录（跨项目；列表时按 projectId 过滤）。 */
export async function listAssetMounts(userId: number): Promise<AssetMountRecord[]> {
  return readRows<AssetMountRecord>(userId, "mounts");
}

/**
 * 显式分享（幂等 upsert by 确定性 id）：同一次分享重放 → created:false，不新增第二笔。
 * 呼叫端必须先过 decideAssetShareGrant（本函式只管落盘语义，不管权限裁决）。
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
    // 已生效的同键重放：什么都不写（零副作用）；新键或撤销后复活才落盘。
    const wasRevoked = current.some((s) => s.id === applied.share.id && s.revokedAt !== undefined);
    if (applied.created || wasRevoked) await writeRows(userId, "shares", applied.shares);
    return { share: applied.share, created: applied.created };
  });
}

/** 撤销分享授权（按确定性 id）。回是否真的撤销了。 */
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
 * 项目挂用（幂等 upsert by 确定性 id）：同键重挂 → created:false，
 * 记录与 idempotencyRef 逐位不变（跨项目复用不双扣的落点）。
 *
 * `cardCopyIds`（D1）：本次挂用**实际锁进 cardIds 的卡副本清单**。新建时落盘；
 * 同键重放时取联集，清单没变则完全不写（幂等重放零副作用）。
 * 落盘的理由：解除挂用时要解锁「当时真的锁过的副本」，事后再推导（来源条目/本地包副本
 * 都可能已变）会漏解 → 「已解除但仍被注入」且永不自我修复。
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

/** 解除挂用（按 projectId + 三元组推导的确定性 id）。回是否真的移除了。 */
export async function unmountAsset(
  userId: number,
  input: { projectId: string; assetKind: AssetKind; assetId: string },
): Promise<boolean> {
  // 先过清洗收口：非法/超长/含分隔符的 id 不可能命中任何键，直接回 false（不再用未清洗的字串拼键）。
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

/** 仅测试：重置进程内状态。 */
export function __resetAssetScopeStoreForTests(): void {
  memoryStore.clear();
  indexCache.clear();
  writeQueues.clear();
}
