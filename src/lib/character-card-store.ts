// 角色/场景卡云端持久化（Blob）。
//
// 存储选型：对齐 canvas/project-store.ts 的既有模式——每用户一份 index 文件、
// 每次写入落到新路径 + 修剪旧世代（避免 Blob cacheControlMaxAge 60s 下限造成
// 「刚存读不到」）、单用户写入串行（write queue）、无 Blob 时记忆体降级。
// 冷启动量小（每用户上限 100 张卡），不建 SQL/新基建。
import { createHash, randomBytes } from "node:crypto";
import { del, ensureBlobBackendWritable, get, list, put } from "@/lib/blob-backend";
import { sanitizeBlobSegment } from "@/lib/history-types";
import { normalizeCharacterCard } from "./character-cards";
import type { CharacterCard, CharacterCardDisguise, CharacterCardReferenceImage } from "./character-cards";

const CARD_SCHEMA_VERSION = 1;
const MAX_REFERENCE_DATA_URL_BYTES = 4 * 1024 * 1024;

export class CharacterCardPersistError extends Error {
  constructor(message = "参考图无法转存，未保存角色卡。") {
    super(message);
    this.name = "CharacterCardPersistError";
  }
}
const INDEX_GENERATIONS_KEPT = 2;
/** 每用户卡片上限（写入时截尾；REQ-B2b 挂用建副本前先验容量，超限诚实拒绝而非静默丢卡）。 */
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

function sniffImageMime(buffer: Buffer): { mimeType: string; extension: string } | null {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return null;
}

async function materializeReferenceUrl(userId: number, cardId: string, slot: string, url: string): Promise<string> {
  if (!url.startsWith("data:image/")) return url;
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(url);
  if (!match) throw new CharacterCardPersistError();
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length === 0 || buffer.length > MAX_REFERENCE_DATA_URL_BYTES) throw new CharacterCardPersistError();
  const sniffed = sniffImageMime(buffer);
  if (!sniffed) throw new CharacterCardPersistError();
  if (!ensureBlobBackendWritable("character-card-store.reference")) throw new CharacterCardPersistError();
  const digest = createHash("sha256").update(`${userId}|${cardId}|${slot}|`).update(buffer).digest("hex");
  const pathname = `${userPrefix(userId)}/refs/${digest}.${sniffed.extension}`;
  try {
    const blob = await put(pathname, buffer, {
      access: "public",
      contentType: sniffed.mimeType,
      cacheControlMaxAge: 31_536_000,
    });
    if (!blob.url || blob.url.startsWith("data:")) throw new CharacterCardPersistError();
    return blob.url;
  } catch (error) {
    if (error instanceof CharacterCardPersistError) throw error;
    throw new CharacterCardPersistError();
  }
}

async function materializeReferences(
  userId: number,
  cardId: string,
  slot: string,
  references: CharacterCardReferenceImage[],
): Promise<CharacterCardReferenceImage[]> {
  const next: CharacterCardReferenceImage[] = [];
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    next.push({
      ...reference,
      url: await materializeReferenceUrl(userId, cardId, `${slot}-${index}`, reference.url),
    });
  }
  return next;
}

async function materializeCard(userId: number, card: CharacterCard): Promise<CharacterCard> {
  const references = await materializeReferences(userId, card.id, "ref", card.references);
  let disguises: CharacterCardDisguise[] | undefined;
  if (card.disguises?.length) {
    disguises = [];
    for (let index = 0; index < card.disguises.length; index += 1) {
      const disguise = card.disguises[index];
      disguises.push({
        ...disguise,
        references: await materializeReferences(userId, card.id, `disguise-${index}`, disguise.references),
      });
    }
  }
  const stored: CharacterCard = disguises ? { ...card, references, disguises } : { ...card, references };
  if (JSON.stringify(stored).includes("data:image/")) throw new CharacterCardPersistError();
  return stored;
}

function dropInlineImages(cards: CharacterCard[]): CharacterCard[] {
  const cleanUrl = (url: string) => (url.startsWith("data:image/") ? "" : url);
  return cards.map((card) => {
    const references = card.references.map((reference) => ({ ...reference, url: cleanUrl(reference.url) }));
    const disguises = card.disguises?.map((disguise) => ({
      ...disguise,
      prompt: disguise.prompt?.includes("data:image/") ? "" : disguise.prompt,
      references: disguise.references.map((reference) => ({ ...reference, url: cleanUrl(reference.url) })),
    }));
    const prompt = card.prompt.includes("data:image/") ? "" : card.prompt;
    return disguises ? { ...card, prompt, references, disguises } : { ...card, prompt, references };
  });
}

async function writeCards(userId: number, cards: CharacterCard[]): Promise<void> {
  const capped = dropInlineImages(cards).slice(0, MAX_CARDS_PER_USER);
  if (JSON.stringify(capped).includes("data:image/")) throw new CharacterCardPersistError();
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
      console.error("[character-cards] 清理旧索引失败。", error);
    });
  }
}

// ─────────────────────────────────────────── 对外接口

/** 读全部卡（updatedAt 由新到旧）。 */
export async function listCharacterCards(userId: number): Promise<CharacterCard[]> {
  const cards = await readCards(userId);
  return cards.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** 储存/覆盖一张卡（upsert by id）。非法卡静默丢弃。data:image 必须先转成对象存储 URL。 */
export async function saveCharacterCard(userId: number, card: CharacterCard): Promise<CharacterCard | null> {
  const normalized = normalizeCharacterCard(card);
  if (!normalized) return null;
  return enqueue(userId, async () => {
    const stored = await materializeCard(userId, normalized);
    const current = await readCards(userId);
    const next = [stored, ...current.filter((c) => c.id !== stored.id)];
    await writeCards(userId, next.slice(0, MAX_CARDS_PER_USER));
    return stored;
  });
}

/** 删除若干卡。返回实际删除数。 */
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

/** 仅测试：重置进程内状态。 */
export function __resetCharacterCardStoreForTests(): void {
  memoryStore.clear();
  indexCache.clear();
  writeQueues.clear();
}
