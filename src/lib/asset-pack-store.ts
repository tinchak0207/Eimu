// 資產包真源（Blob 持久化）。
//
// 沿用 project-store.ts 的模式：每次寫入落到新路徑 + 修剪舊世代，
// 避免 Blob cacheControlMaxAge 60s 下限造成的「剛存讀不到」；單用戶寫入串行。
// 與畫布素材庫分開命名空間（asset-packs/），互不影響。
import { randomBytes } from "node:crypto";
import { del, get, list, put } from "@/lib/blob-backend";
import { sanitizeBlobSegment } from "@/lib/history-types";

const PACK_SCHEMA_VERSION = 1;
const INDEX_GENERATIONS_KEPT = 2;
const INDEX_CACHE_TTL_MS = 3_000;

/** 每用戶資產包上限（超出時 saveAssetPack 拒絕，不做靜默截斷）。 */
export const MAX_PACKS_PER_USER = 100;
/** 每包 item 上限（超出時 normalizeAssetPack 截斷）。 */
export const MAX_ITEMS_PER_PACK = 50;
/** digest 語義摘要上限（模型注入用）。 */
export const MAX_DIGEST_LENGTH = 500;
const MAX_TITLE_LENGTH = 200;
const MAX_TAGS_PER_PACK = 20;
const MAX_TAG_LENGTH = 50;
const MAX_NOTE_LENGTH = 200;

export type AssetPackItemKind = "prompt" | "reference" | "lora" | "recipe" | "image";

export interface AssetPackItem {
  kind: AssetPackItemKind;
  title: string;
  /** prompt / recipe 用：提示詞或六槽配方文本。 */
  content?: string;
  /** reference / image 用：既有 URL（不複製位元組）。 */
  imageUrl?: string;
  /** lora 用。 */
  loraVersionId?: string;
  loraWeight?: number;
  /** recipe 用：該配方對應的模型/size/lora 清單。 */
  modelId?: string;
  size?: string;
  loraModelVersionIds?: string[];
  /** 來源標記。 */
  source?: { type: "history" | "canvas" | "chat" | "workflow" | "manual"; id: string; sessionId?: string };
  note?: string;
  createdAt?: string;
}

export interface AssetPack {
  id: string;
  title: string;
  /** 語義摘要（≤500 字，模型注入用）。 */
  digest?: string;
  items: AssetPackItem[];
  active?: boolean;
  tags: string[];
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/** 資產包數達上限時拋出（API 層轉 400，誠實拒絕）。 */
export class AssetPackLimitError extends Error {
  constructor() {
    super(`资产包数量已达上限 ${MAX_PACKS_PER_USER} 个`);
    this.name = "AssetPackLimitError";
  }
}

const memoryStore = new Map<number, AssetPack[]>();
const indexCache = new Map<number, { packs: AssetPack[]; expiresAt: number }>();
const writeQueues = new Map<number, Promise<unknown>>();

function hasBlobStore(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function userPrefix(userId: number): string {
  return `asset-packs/${sanitizeBlobSegment(String(userId), "0")}`;
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

const ITEM_KINDS: readonly AssetPackItemKind[] = ["prompt", "reference", "lora", "recipe", "image"];

/**
 * 純函式：把不可信 item payload 正規化為 AssetPackItem。
 * 驗 kind/title；content/imageUrl 按 kind 才收；loraVersionId 僅 lora；
 * recipe 收 modelId/size/loraModelVersionIds；source 白名單 type + 必填 id。
 * 不合法回 null。
 */
function normalizeItem(payload: unknown): AssetPackItem | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<AssetPackItem>;
  const kind = p.kind;
  if (!kind || !ITEM_KINDS.includes(kind)) return null;
  if (typeof p.title !== "string" || !p.title.trim()) return null;

  const item: AssetPackItem = {
    kind,
    title: p.title.trim().slice(0, MAX_TITLE_LENGTH),
  };

  if (kind === "prompt" || kind === "recipe") {
    if (typeof p.content === "string") item.content = p.content;
  }
  if (kind === "reference" || kind === "image") {
    if (typeof p.imageUrl === "string" && p.imageUrl.trim()) item.imageUrl = p.imageUrl.trim();
  }
  if (kind === "lora") {
    if (typeof p.loraVersionId === "string" && p.loraVersionId.trim()) item.loraVersionId = p.loraVersionId.trim();
    if (typeof p.loraWeight === "number" && Number.isFinite(p.loraWeight)) item.loraWeight = p.loraWeight;
  }
  if (kind === "recipe") {
    if (typeof p.modelId === "string" && p.modelId.trim()) item.modelId = p.modelId.trim();
    if (typeof p.size === "string" && p.size.trim()) item.size = p.size.trim();
    if (Array.isArray(p.loraModelVersionIds)) {
      const ids = p.loraModelVersionIds.filter((v): v is string => typeof v === "string");
      if (ids.length) item.loraModelVersionIds = ids;
    }
  }
  if (p.source && typeof p.source === "object") {
    const s = p.source as { type?: unknown; id?: unknown; sessionId?: unknown };
    if (
      (s.type === "history" ||
        s.type === "canvas" ||
        s.type === "chat" ||
        s.type === "workflow" ||
        s.type === "manual") &&
      typeof s.id === "string"
    ) {
      item.source = {
        type: s.type,
        id: s.id,
        ...(typeof s.sessionId === "string" ? { sessionId: s.sessionId } : {}),
      };
    }
  }
  if (typeof p.note === "string" && p.note.trim()) item.note = p.note.trim();
  if (typeof p.createdAt === "string") item.createdAt = p.createdAt;
  return item;
}

/**
 * 純函式：把不可信 payload 正規化為 AssetPack。
 * 驗 id/title；items 逐項 normalizeItem（非法項 drop、超出 MAX_ITEMS_PER_PACK 截斷）；
 * tags 陣列化 + 去重 + 截斷；標題截 200；digest 截 500；note 截 200；
 * active 只收 boolean（僅 true 寫入）。不合法回 null。
 */
export function normalizeAssetPack(payload: unknown): AssetPack | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<AssetPack>;
  if (typeof p.id !== "string" || !p.id.trim()) return null;
  if (typeof p.title !== "string" || !p.title.trim()) return null;

  const items: AssetPackItem[] = [];
  if (Array.isArray(p.items)) {
    for (const raw of p.items) {
      const item = normalizeItem(raw);
      if (!item) continue;
      items.push(item);
      if (items.length >= MAX_ITEMS_PER_PACK) break;
    }
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
      if (tags.length >= MAX_TAGS_PER_PACK) break;
    }
  }

  const now = new Date().toISOString();
  const note = typeof p.note === "string" ? p.note.trim().slice(0, MAX_NOTE_LENGTH) : "";
  const digest = typeof p.digest === "string" ? p.digest.trim().slice(0, MAX_DIGEST_LENGTH) : "";
  return {
    id: p.id.trim(),
    title: p.title.trim().slice(0, MAX_TITLE_LENGTH),
    ...(digest ? { digest } : {}),
    items,
    ...(p.active === true ? { active: true } : {}),
    tags,
    ...(note ? { note } : {}),
    createdAt: typeof p.createdAt === "string" ? p.createdAt : now,
    updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : now,
  };
}

function parseDocument(payload: unknown): AssetPack[] {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { packs?: unknown } | null)?.packs)
      ? (payload as { packs: AssetPack[] }).packs
      : [];
  return raw.flatMap((item) => {
    const normalized = normalizeAssetPack(item);
    return normalized ? [normalized] : [];
  });
}

async function readBlobDocument(urlOrPath: string): Promise<AssetPack[]> {
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

async function fetchPacks(userId: number): Promise<AssetPack[]> {
  const blobs = await listIndexBlobs(userId);
  if (blobs.length) return readBlobDocument(blobs[0].url);
  return [];
}

async function readPacks(userId: number): Promise<AssetPack[]> {
  if (!hasBlobStore()) return [...(memoryStore.get(userId) ?? [])];
  const cached = indexCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return [...cached.packs];
  const packs = await fetchPacks(userId);
  indexCache.set(userId, { packs, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  return [...packs];
}

async function writePacks(userId: number, packs: AssetPack[]): Promise<void> {
  // 上限在 saveAssetPack 拒絕，這裡只排序（newest 優先），不靜默丟資料。
  const sorted = [...packs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  if (!hasBlobStore()) {
    memoryStore.set(userId, sorted);
    indexCache.delete(userId);
    return;
  }
  const previous = await listIndexBlobs(userId).catch(() => [] as BlobRef[]);
  const document = { schemaVersion: PACK_SCHEMA_VERSION, packs: sorted };
  const pathname = `${indexPrefix(userId)}${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  await put(pathname, JSON.stringify(document), {
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  indexCache.set(userId, { packs: sorted, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  const stale = previous.slice(INDEX_GENERATIONS_KEPT - 1);
  if (stale.length) {
    await del(stale.map((b) => b.url)).catch((error) => {
      console.error("[asset-packs] 清理舊索引失敗。", error);
    });
  }
}

// ─────────────────────────────────────────── 對外接口

/** 讀全部資產包（newest 優先）。 */
export async function listAssetPacks(userId: number): Promise<AssetPack[]> {
  return readPacks(userId);
}

/** 讀 active===true 的資產包；無則回 null（單一 active 鐵律）。 */
export async function getActiveAssetPack(userId: number): Promise<AssetPack | null> {
  const packs = await readPacks(userId);
  return packs.find((p) => p.active === true) ?? null;
}

/**
 * 儲存/覆蓋一個資產包（upsert by id）。
 * 不合法拋錯（呼叫端應先 normalizeAssetPack 驗證）；新增超過上限拋 AssetPackLimitError。
 * 若新包 active===true，則把同用戶其它包的 active 清掉（單一 active 鐵律）。
 */
export async function saveAssetPack(userId: number, pack: AssetPack): Promise<void> {
  const normalized = normalizeAssetPack(pack);
  if (!normalized) throw new Error("invalid asset pack");
  await enqueue(userId, async () => {
    const current = await readPacks(userId);
    const exists = current.some((p) => p.id === normalized.id);
    if (!exists && current.length >= MAX_PACKS_PER_USER) throw new AssetPackLimitError();
    let next = current.filter((p) => p.id !== normalized.id);
    if (normalized.active === true) {
      next = next.map((p) => (p.active === true ? { ...p, active: undefined } : p));
    }
    await writePacks(userId, [normalized, ...next]);
  });
}

/** 刪除若干資產包（不存在的 id 忽略）。 */
export async function deleteAssetPacks(userId: number, ids: string[]): Promise<void> {
  const targets = new Set(ids.filter(Boolean));
  if (!targets.size) return;
  await enqueue(userId, async () => {
    const current = await readPacks(userId);
    const next = current.filter((p) => !targets.has(p.id));
    if (next.length === current.length) return;
    await writePacks(userId, next);
  });
}

/** 僅測試：重置進程內狀態。 */
export function __resetAssetPackStoreForTests(): void {
  memoryStore.clear();
  indexCache.clear();
  writeQueues.clear();
}
