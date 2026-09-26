// 角色/場景卡雲端持久化（Blob）。
//
// 存儲選型：對齊 canvas/project-store.ts 的既有模式——每用戶一份 index 文件、
// 每次寫入落到新路徑 + 修剪舊世代（避免 Blob cacheControlMaxAge 60s 下限造成
// 「剛存讀不到」）、單用戶寫入串行（write queue）、無 Blob 時記憶體降級。
// 冷啟動量小（每用戶上限 100 張卡），不建 SQL/新基建。
import { randomBytes } from "node:crypto";
import { del, ensureBlobBackendWritable, get, list, put } from "@/lib/blob-backend";
import { sanitizeBlobSegment } from "@/lib/history-types";
import { normalizeCharacterCard } from "./character-cards";
import type { CharacterCard } from "./character-cards";

const CARD_SCHEMA_VERSION = 1;
const INDEX_GENERATIONS_KEPT = 2;
/** 每用戶卡片上限（寫入時截尾；REQ-B2b 掛用建副本前先驗容量，超限誠實拒絕而非靜默丟卡）。 */
export const MAX_CARDS_PER_USER = 100;
const INDEX_CACHE_TTL_MS = 3_000;

const memoryStore = new Map<number, CharacterCard[]>();
const indexCache = new Map<number, { cards: CharacterCard[]; expiresAt: number }>();
const writeQueues = new Map<number, Promise<unknown>>();

function userPrefix(userId: number): string {
  return `character-cards/${sanitizeBlobSegment(String(userId), "0")}`;
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

function parseDocument(payload: unknown): CharacterCard[] {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { cards?: unknown } | null)?.cards)
      ? (payload as { cards: CharacterCard[] }).cards
      : [];
  return raw.flatMap((item) => {
    const normalized = normalizeCharacterCard(item);
    return normalized ? [normalized] : [];
  });
}

async function readBlobDocument(urlOrPath: string): Promise<CharacterCard[]> {
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

async function fetchCards(userId: number): Promise<CharacterCard[]> {
  const blobs = await listIndexBlobs(userId);
  if (blobs.length) return readBlobDocument(blobs[0].url);
  return [];
}

async function readCards(userId: number): Promise<CharacterCard[]> {
  if (!ensureBlobBackendWritable("character-card-store.readCards")) return [...(memoryStore.get(userId) ?? [])];
  const cached = indexCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return [...cached.cards];
  const cards = await fetchCards(userId);
  indexCache.set(userId, { cards, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  return [...cards];
}

async function writeCards(userId: number, cards: CharacterCard[]): Promise<void> {
  const capped = [...cards].slice(0, MAX_CARDS_PER_USER);
  if (!ensureBlobBackendWritable("character-card-store.writeCards")) {
    memoryStore.set(userId, capped);
    indexCache.delete(userId);
    return;
  }
  const previous = await listIndexBlobs(userId).catch(() => [] as BlobRef[]);
  const document = { schemaVersion: CARD_SCHEMA_VERSION, cards: capped };
  const pathname = `${indexPrefix(userId)}${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  await put(pathname, JSON.stringify(document), {
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  indexCache.set(userId, { cards: capped, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  const stale = previous.slice(INDEX_GENERATIONS_KEPT - 1);
  if (stale.length) {
    await del(stale.map((b) => b.url)).catch((error) => {
      console.error("[character-cards] 清理舊索引失敗。", error);
    });
  }
}

// ─────────────────────────────────────────── 對外接口

/** 讀全部卡（updatedAt 由新到舊）。 */
export async function listCharacterCards(userId: number): Promise<CharacterCard[]> {
  const cards = await readCards(userId);
  return cards.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** 儲存/覆蓋一張卡（upsert by id）。非法卡靜默丟棄。 */
export async function saveCharacterCard(userId: number, card: CharacterCard): Promise<void> {
  const normalized = normalizeCharacterCard(card);
  if (!normalized) return;
  await enqueue(userId, async () => {
    const current = await readCards(userId);
    const next = [normalized, ...current.filter((c) => c.id !== normalized.id)];
    await writeCards(userId, next.slice(0, MAX_CARDS_PER_USER));
  });
}

/** 刪除若干卡。返回實際刪除數。 */
export async function deleteCharacterCards(userId: number, ids: string[]): Promise<number> {
  const targets = new Set(ids.filter(Boolean));
  if (!targets.size) return 0;
  return enqueue(userId, async () => {
    const current = await readCards(userId);
    const removed = current.filter((c) => targets.has(c.id));
    if (!removed.length) return 0;
    await writeCards(userId, current.filter((c) => !targets.has(c.id)));
    return removed.length;
  });
}

/** 僅測試：重置進程內狀態。 */
export function __resetCharacterCardStoreForTests(): void {
  memoryStore.clear();
  indexCache.clear();
  writeQueues.clear();
}
