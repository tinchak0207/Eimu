// 云端素材库（Blob 持久化）。
//
// 沿用 project-store.ts 的模式：每次写入落到新路径 + 修剪旧世代，
// 避免 Blob cacheControlMaxAge 60s 下限造成的「刚存读不到」；单用户写入串行。
// 与画布专案分开命名空间（canvas-assets/），互不影响。
import { randomBytes } from "node:crypto";
import { del, ensureBlobBackendWritable, get, list, put } from "@/lib/blob-backend";
import { sanitizeBlobSegment } from "@/lib/history-types";

const ASSET_SCHEMA_VERSION = 1;
const INDEX_GENERATIONS_KEPT = 2;
const INDEX_CACHE_TTL_MS = 3_000;

/** 每用户素材上限（超出时 saveCanvasAsset 拒绝，不做静默截断）。 */
export const MAX_ASSETS_PER_USER = 500;
/** image 素材 dataURL 上限（base64 dataURL 为 ASCII，字串长度即约等于字节数）。 */
export const MAX_IMAGE_DATA_URL_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_TAGS_PER_ASSET = 20;
const MAX_TAG_LENGTH = 50;

export interface CanvasAsset {
  id: string;
  kind: "text" | "image";
  title: string;
  /** text 素材正文。 */
  content?: string;
  /** image 素材 URL（https 或 dataURL）。 */
  imageUrl?: string;
  tags: string[];
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/** 素材数达上限时抛出（API 层转 400，诚实拒绝）。 */
export class CanvasAssetLimitError extends Error {
  constructor() {
    super(`素材数量已达上限 ${MAX_ASSETS_PER_USER} 条`);
    this.name = "CanvasAssetLimitError";
  }
}

const memoryStore = new Map<number, CanvasAsset[]>();
const indexCache = new Map<number, { assets: CanvasAsset[]; expiresAt: number }>();
const writeQueues = new Map<number, Promise<unknown>>();

function userPrefix(userId: number): string {
  return `canvas-assets/${sanitizeBlobSegment(String(userId), "0")}`;
}

function indexPrefix(userId: number): string {
  return `${userPrefix(userId)}/index-`;
}

function enqueue<T>(userId: number, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(userId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  writeQueues.set(userId, next.catch(() => undefined));
  return next;
}

type BlobRef = { url: string; pathname: string; uploadedAt: Date };

async function listIndexBlobs(userId: number): Promise<BlobRef[]> {
  const blobs: BlobRef[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: indexPrefix(userId), cursor });
    for (const blob of page.blobs) {
      blobs.push({ url: blob.url, pathname: blob.pathname, uploadedAt: blob.uploadedAt });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
}

/**
 * 纯函式：把不可信 payload 正规化为 CanvasAsset。
 * 验 id/kind/title；tags 阵列化 + 去重 + 截断；标题截 200；
 * image 素材必须带 https 或 dataURL，dataURL 超 2MB 诚实拒绝。
 * 不合法回 null。
 */
export function normalizeAsset(payload: unknown): CanvasAsset | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<CanvasAsset>;
  if (typeof p.id !== "string" || !p.id.trim()) return null;
  if (p.kind !== "text" && p.kind !== "image") return null;
  if (typeof p.title !== "string" || !p.title.trim()) return null;

  const imageUrl = typeof p.imageUrl === "string" ? p.imageUrl.trim() : "";
  if (p.kind === "image") {
    if (!imageUrl.startsWith("https://") && !imageUrl.startsWith("data:")) return null;
    if (imageUrl.startsWith("data:") && imageUrl.length > MAX_IMAGE_DATA_URL_BYTES) return null;
  }

  const seen = new Set<string>();
  const tags: string[] = [];
  if (Array.isArray(p.tags)) {
    for (const raw of p.tags) {
      if (typeof raw !== "string") continue;
      const tag = raw.trim().slice(0, MAX_TAG_LENGTH);
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
      if (tags.length >= MAX_TAGS_PER_ASSET) break;
    }
  }

  const now = new Date().toISOString();
  const note = typeof p.note === "string" ? p.note.trim() : "";
  return {
    id: p.id.trim(),
    kind: p.kind,
    title: p.title.trim().slice(0, MAX_TITLE_LENGTH),
    ...(p.kind === "text" ? { content: typeof p.content === "string" ? p.content : "" } : {}),
    ...(p.kind === "image" ? { imageUrl } : {}),
    tags,
    ...(note ? { note } : {}),
    createdAt: typeof p.createdAt === "string" ? p.createdAt : now,
    updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : now,
  };
}

function parseDocument(payload: unknown): CanvasAsset[] {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { assets?: unknown } | null)?.assets)
      ? (payload as { assets: CanvasAsset[] }).assets
      : [];
  return raw.flatMap((item) => {
    const normalized = normalizeAsset(item);
    return normalized ? [normalized] : [];
  });
}

async function readBlobDocument(urlOrPath: string): Promise<CanvasAsset[]> {
  try {
    const blob = await get(urlOrPath, { access: "public" });
    if (!blob || blob.statusCode !== 200) return [];
    const text = await new Response(blob.stream).text();
    if (!text) return [];
    return parseDocument(JSON.parse(text) as unknown);
  } catch {
    return [];
  }
}

async function fetchAssets(userId: number): Promise<CanvasAsset[]> {
  const blobs = await listIndexBlobs(userId);
  if (blobs.length) return readBlobDocument(blobs[0].url);
  return [];
}

async function readAssets(userId: number): Promise<CanvasAsset[]> {
  if (!ensureBlobBackendWritable("canvas/asset-store.readAssets")) return [...(memoryStore.get(userId) ?? [])];
  const cached = indexCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return [...cached.assets];
  const assets = await fetchAssets(userId);
  indexCache.set(userId, { assets, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  return [...assets];
}

async function writeAssets(userId: number, assets: CanvasAsset[]): Promise<void> {
  // 上限在 saveCanvasAsset 拒绝，这里只排序（newest 优先），不静默丢资料。
  const sorted = [...assets].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  if (!ensureBlobBackendWritable("canvas/asset-store.writeAssets")) {
    memoryStore.set(userId, sorted);
    indexCache.delete(userId);
    return;
  }
  const previous = await listIndexBlobs(userId).catch(() => [] as BlobRef[]);
  const document = { schemaVersion: ASSET_SCHEMA_VERSION, assets: sorted };
  const pathname = `${indexPrefix(userId)}${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  await put(pathname, JSON.stringify(document), {
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  indexCache.set(userId, { assets: sorted, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  const stale = previous.slice(INDEX_GENERATIONS_KEPT - 1);
  if (stale.length) {
    await del(stale.map((b) => b.url)).catch((error) => {
      console.error("[canvas-assets] 清理旧索引失败。", error);
    });
  }
}

// ─────────────────────────────────────────── 对外接口

/** 读全部素材（newest 优先）。 */
export async function listCanvasAssets(userId: number): Promise<CanvasAsset[]> {
  return readAssets(userId);
}

/**
 * 储存/覆盖一条素材（upsert by id）。
 * 不合法抛错（呼叫端应先 normalizeAsset 验证）；新增超过上限抛 CanvasAssetLimitError。
 */
export async function saveCanvasAsset(userId: number, asset: CanvasAsset): Promise<void> {
  const normalized = normalizeAsset(asset);
  if (!normalized) throw new Error("invalid canvas asset");
  await enqueue(userId, async () => {
    const current = await readAssets(userId);
    const exists = current.some((a) => a.id === normalized.id);
    if (!exists && current.length >= MAX_ASSETS_PER_USER) throw new CanvasAssetLimitError();
    await writeAssets(userId, [normalized, ...current.filter((a) => a.id !== normalized.id)]);
  });
}

/** 删除若干素材（不存在的 id 忽略）。 */
export async function deleteCanvasAssets(userId: number, ids: string[]): Promise<void> {
  const targets = new Set(ids.filter(Boolean));
  if (!targets.size) return;
  await enqueue(userId, async () => {
    const current = await readAssets(userId);
    const next = current.filter((a) => !targets.has(a.id));
    if (next.length === current.length) return;
    await writeAssets(userId, next);
  });
}

/** 仅测试：重置进程内状态。 */
export function __resetCanvasAssetStoreForTests(): void {
  memoryStore.clear();
  indexCache.clear();
  writeQueues.clear();
}
