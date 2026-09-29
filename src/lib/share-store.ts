// 作品公開分享的存儲層。
//
// 位元組不搬：圖片本體仍在既有 artifact/blob owner（server-history-store 的
// persistGeneratedImage / persistUpstreamImageBytes）底下，這裡只存一張「指向它」的
// 記錄（URL ＋ 快照），所以不新增任何物件存儲。
//
// 存儲面沿用歷史存儲同一套模式（同一份 blob 後端選擇器 blob-backend，同一組
// 「新路徑 + 修剪舊世代」寫法、同一套記憶體降級語義）：
//   - 讀寫一律走 list/get/put/del，不自己拼 URL、不自己開後端。
//   - 生產（VPS image-data-api）讀的是 API 直連，撤銷即時生效；
//     Vercel Blob 後端因 CDN 快取最短 60 秒，撤銷最多 60 秒傳播（與歷史索引同款已知限制）。
//
// 預設不公開：沒有這張記錄，/p/<shareId> 就查無此頁；撤銷＝刪記錄，同一條路徑當場 404。

import { del, ensureBlobBackendWritable, get, list, put } from "./blob-backend";
import { sanitizeBlobSegment } from "./history-types";
import { generateShareId, isShareId } from "./share-id";
import {
  shareIndexItem,
  publicShareView,
  type PublicShareView,
  type ShareIndexItem,
  type ShareRecord,
  type ShareSnapshot,
} from "./share-remix";

export type { PublicShareView, ShareIndexItem, ShareRecord, ShareSnapshot } from "./share-remix";

export const SHARE_SCHEMA_VERSION = 1;

/** 单用户保留的分享上限；超出丢最旧（分享是增长入口，不该无限吃存储）。 */
export const MAX_SHARES_PER_USER = 200;

/** 索引世代保留数：读「最新一份」，旧世代写完再清（同历史存储做法）。 */
const INDEX_GENERATIONS_KEPT = 2;

const SHARE_ROOT = "shares";

/** 公開記錄路徑。shareId 由 generateShareId 產生，仍過一次清洗（路徑拼接不接受外部輸入）。 */
function recordPath(shareId: string): string {
  return `${SHARE_ROOT}/p/${sanitizeBlobSegment(shareId, "share")}.json`;
}

function indexPrefix(userId: number): string {
  return `${SHARE_ROOT}/by-user/${sanitizeBlobSegment(String(userId), "0")}/index-`;
}

function indexPath(userId: number): string {
  return `${indexPrefix(userId)}${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`;
}

// 記憶體降級（非生產或顯式 opt-in）：與 blob 後端同語義，只是不持久化。
const memoryRecords = new Map<string, ShareRecord>();
const memoryIndexes = new Map<number, ShareIndexItem[]>();

interface ShareIndexDocument {
  schemaVersion: number;
  shares: ShareIndexItem[];
}

function parseIndexDocument(payload: unknown): ShareIndexItem[] {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as ShareIndexDocument | null)?.shares)
      ? (payload as ShareIndexDocument).shares
      : [];
  return raw.flatMap((item): ShareIndexItem[] => {
    const value = item as Partial<ShareIndexItem> | null;
    if (!value || !isShareId(value.shareId) || typeof value.entryId !== "string") return [];
    return [{
      shareId: value.shareId,
      entryId: value.entryId,
      resultIndex: Number.isFinite(value.resultIndex) ? Number(value.resultIndex) : 0,
      createdAt: Number.isFinite(value.createdAt) ? Number(value.createdAt) : 0,
      hidePrompt: value.hidePrompt === true,
    }];
  });
}

function parseRecord(payload: unknown): ShareRecord | null {
  const value = payload as Partial<ShareRecord> | null;
  const snapshot = value?.snapshot as Partial<ShareSnapshot> | undefined;
  if (!value || !isShareId(value.shareId) || !snapshot || typeof snapshot.imageUrl !== "string") {
    return null;
  }
  if (!snapshot.imageUrl.trim()) return null;
  return {
    schemaVersion: Number.isFinite(value.schemaVersion) ? Number(value.schemaVersion) : SHARE_SCHEMA_VERSION,
    shareId: value.shareId,
    ownerUserId: Number.isFinite(value.ownerUserId) ? Number(value.ownerUserId) : 0,
    entryId: typeof value.entryId === "string" ? value.entryId : "",
    resultIndex: Number.isFinite(value.resultIndex) ? Number(value.resultIndex) : 0,
    createdAt: Number.isFinite(value.createdAt) ? Number(value.createdAt) : 0,
    hidePrompt: value.hidePrompt === true,
    snapshot: {
      prompt: typeof snapshot.prompt === "string" ? snapshot.prompt : "",
      modelId: typeof snapshot.modelId === "string" ? snapshot.modelId : "",
      aspectRatio: typeof snapshot.aspectRatio === "string" ? snapshot.aspectRatio : "",
      imageSize: typeof snapshot.imageSize === "string" ? snapshot.imageSize : "",
      imageUrl: snapshot.imageUrl,
    },
  };
}

/** blob 讀取結果的形狀（兩個後端共用同一份 blob-backend 包裝，型別取它的回傳）。 */
type BlobReadResult = Awaited<ReturnType<typeof get>>;

async function readJson(blob: BlobReadResult): Promise<unknown | null> {
  if (!blob || blob.statusCode !== 200 || !blob.stream) return null;
  try {
    const text = await new Response(blob.stream).text();
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────── 索引读写

async function listIndexBlobs(userId: number): Promise<Array<{ url: string; pathname: string; uploadedAt: Date }>> {
  const blobs: Array<{ url: string; pathname: string; uploadedAt: Date }> = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: indexPrefix(userId), cursor });
    for (const blob of page.blobs) {
      blobs.push({ url: blob.url, pathname: blob.pathname, uploadedAt: blob.uploadedAt });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs.sort((a, b) =>
    b.uploadedAt.getTime() - a.uploadedAt.getTime() || b.pathname.localeCompare(a.pathname),
  );
}

async function readIndex(userId: number): Promise<ShareIndexItem[]> {
  if (!ensureBlobBackendWritable("share-store.readIndex")) {
    return [...(memoryIndexes.get(userId) ?? [])];
  }
  const blobs = await listIndexBlobs(userId).catch(() => []);
  if (!blobs.length) return [];
  const payload = await readJson(await get(blobs[0].url, { access: "public" }));
  return payload === null ? [] : parseIndexDocument(payload);
}

async function writeIndex(userId: number, shares: ShareIndexItem[]): Promise<void> {
  const capped = [...shares]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_SHARES_PER_USER);

  if (!ensureBlobBackendWritable("share-store.writeIndex")) {
    memoryIndexes.set(userId, capped);
    return;
  }

  const previous = await listIndexBlobs(userId).catch(() => []);
  const document: ShareIndexDocument = { schemaVersion: SHARE_SCHEMA_VERSION, shares: capped };
  await put(indexPath(userId), JSON.stringify(document), {
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  memoryIndexes.set(userId, capped);

  const stale = previous.slice(INDEX_GENERATIONS_KEPT - 1);
  if (stale.length) {
    await del(stale.map((blob) => blob.url)).catch((error) => {
      console.error("[share] 清理旧索引失败。", error);
    });
  }
}

// ─────────────────────────────────────────────────────────── 記錄读写

async function readRecord(shareId: string): Promise<ShareRecord | null> {
  if (!isShareId(shareId)) return null;
  if (!ensureBlobBackendWritable("share-store.readRecord")) {
    return memoryRecords.get(shareId) ?? null;
  }
  try {
    // 直接按路徑名取（不經 list）：list 在 Vercel Blob 上最終一致，剛建立的分享
    // 可能還沒出現在列表裡——那會讓剛分享完的連結自己 404。
    const payload = await readJson(await get(recordPath(shareId), { access: "public", useCache: false }));
    return payload === null ? null : parseRecord(payload);
  } catch (error) {
    console.error(`[share] 读取分享记录失败 shareId=${shareId}`, error);
    return null;
  }
}

async function writeRecord(record: ShareRecord): Promise<void> {
  if (!ensureBlobBackendWritable("share-store.writeRecord")) {
    memoryRecords.set(record.shareId, record);
    return;
  }
  await put(recordPath(record.shareId), JSON.stringify(record), {
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
    allowOverwrite: true,
  });
  memoryRecords.set(record.shareId, record);
}

// ─────────────────────────────────────────────────────────── 對外 API

export interface CreateShareInput {
  userId: number;
  entryId: string;
  resultIndex: number;
  hidePrompt: boolean;
  snapshot: ShareSnapshot;
}

export interface CreateShareResult {
  record: ShareRecord;
  /** true ＝ 這件作品先前已分享過，回同一條連結（避免每次點都生一條新的）。 */
  reused: boolean;
}

/**
 * 建立（或取回）一條分享。
 *
 * 冪等鍵是 (ownerUserId, entryId, resultIndex)：同一項重複點分享＝同一條連結。
 * shareId 每次都是 128-bit 隨機（不可枚舉），但要重用的那條必須沿用原 id，
 * 否則使用者貼出去的舊連結會在不知不覺中被換掉。
 */
export async function createShare(input: CreateShareInput): Promise<CreateShareResult> {
  const index = await readIndex(input.userId);
  const existing = index.find(
    (item) => item.entryId === input.entryId && item.resultIndex === input.resultIndex,
  );

  if (existing) {
    const record: ShareRecord = {
      schemaVersion: SHARE_SCHEMA_VERSION,
      shareId: existing.shareId,
      ownerUserId: input.userId,
      entryId: input.entryId,
      resultIndex: input.resultIndex,
      createdAt: existing.createdAt || Date.now(),
      hidePrompt: input.hidePrompt,
      snapshot: input.snapshot,
    };
    // 既要沿用原 id（使用者已貼出去的連結不能被悄悄換掉），也要把新的可見性
    // 與快照寫回去——所以是「重寫同一條記錄」而不是「生一條新的」。
    await writeRecord(record);
    await writeIndex(
      input.userId,
      index.map((item) => (item.shareId === record.shareId ? shareIndexItem(record) : item)),
    );
    return { record, reused: true };
  }

  const record: ShareRecord = {
    schemaVersion: SHARE_SCHEMA_VERSION,
    shareId: generateShareId(),
    ownerUserId: input.userId,
    entryId: input.entryId,
    resultIndex: input.resultIndex,
    createdAt: Date.now(),
    hidePrompt: input.hidePrompt,
    snapshot: input.snapshot,
  };
  await writeRecord(record);
  await writeIndex(input.userId, [shareIndexItem(record), ...index]);
  return { record, reused: false };
}

/** 公開讀取（無需登入）：不存在、畸形 id、已撤銷一律 null → 頁面 404。 */
export async function getPublicShare(shareId: string): Promise<{ record: ShareRecord; view: PublicShareView } | null> {
  const record = await readRecord(shareId);
  if (!record) return null;
  return { record, view: publicShareView(record) };
}

/** 使用者自己的分享清單（歷史卡要顯示「已分享」狀態）。 */
export async function listSharesForUser(userId: number): Promise<ShareIndexItem[]> {
  return readIndex(userId);
}

async function ownedRecord(userId: number, shareId: string): Promise<ShareRecord | null> {
  if (!isShareId(shareId)) return null;
  const index = await readIndex(userId);
  if (!index.some((item) => item.shareId === shareId)) return null;
  const record = await readRecord(shareId);
  if (!record) return null;
  return record.ownerUserId === userId ? record : null;
}

/** 切換「隱藏提示詞」。只認本人的分享（所有權由呼叫端已驗證的 userId 決定）。 */
export async function setShareHidden(
  userId: number,
  shareId: string,
  hidePrompt: boolean,
): Promise<ShareRecord | null> {
  const record = await ownedRecord(userId, shareId);
  if (!record) return null;
  const next: ShareRecord = { ...record, hidePrompt };
  await writeRecord(next);
  const index = await readIndex(userId);
  await writeIndex(userId, index.map((item) => (item.shareId === shareId ? shareIndexItem(next) : item)));
  return next;
}

/**
 * 撤銷分享：刪記錄 ＋ 從索引移除。刪完 /p/<shareId> 立即 404（VPS 後端即時；
 * Vercel Blob 後端受 CDN 最短 60 秒快取限制）。
 */
export async function revokeShare(userId: number, shareId: string): Promise<boolean> {
  const record = await ownedRecord(userId, shareId);
  if (!record) return false;

  const index = await readIndex(userId);
  await writeIndex(userId, index.filter((item) => item.shareId !== shareId));

  memoryRecords.delete(shareId);

  if (ensureBlobBackendWritable("share-store.revokeShare")) {
    // del 直接吃路徑：與 recipe-template-store / wechat-login 既有寫法一致，
    // 不必先 get 問一次 URL（vercelBlob.get 的回傳形狀沒有 url 欄位）。
    const deleted = await del([recordPath(shareId)])
      .then(() => true)
      .catch((error) => {
        console.error("[share] 删除分享记录失败。", error);
        return false;
      });
    if (!deleted) {
      // 刪不掉就當場把記錄換成撤銷態（不再指向任何圖）：寧可這條記錄作廢，
      // 也不能出現「按了撤銷、頁面還在」。
      await writeRecord({
        ...record,
        hidePrompt: true,
        snapshot: { ...record.snapshot, prompt: "", imageUrl: "" },
      }).catch(() => undefined);
    }
  }
  return true;
}
