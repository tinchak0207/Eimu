// 直傳物件的「擁有者紀錄」真源（Blob 持久化）。
//
// D36 語義：上傳完要**回寫 TosKey 才算入庫**。本檔就是那張擁有者紀錄——
// 每個使用者一份索引 `upload-records/<userId>/index-<ts>-<rand>.json`，內容是
// 「已回寫的物件鍵 ＋ 伺服器親自取回位元組算出的 sha256 ＋ 大小 ＋ mime」。
//
// 沿用 `asset-pack-store.ts` / `project-store.ts` 的既有模式（**同一個輪子**，
// 不另立第三代寫法）：每次寫入落新路徑 + 修剪舊世代（避開 Blob cacheControlMaxAge
// 60s 下限造成的「剛存讀不到」）、單用戶寫入串行。
//
// 記憶體降級：只在 `blob-backend` 的既有一致門禁允許時（非生產，或顯式
// BLOB_ALLOW_MEMORY_FALLBACK=true）才落進程內，生產缺後端一律誠實拋錯。
import { randomBytes } from "node:crypto";
import { del, ensureBlobBackendWritable, get, list, put } from "@/lib/blob-backend";
import { sanitizeBlobSegment } from "@/lib/history-types";

const RECORD_SCHEMA_VERSION = 1;
const INDEX_GENERATIONS_KEPT = 2;
const INDEX_CACHE_TTL_MS = 3_000;

/** 每位使用者的已入庫物件紀錄上限（超出時拒絕，不靜默丟最舊的）。 */
export const MAX_UPLOAD_RECORDS_PER_USER = 2_000;

/** 一筆已回寫入庫的直傳物件。 */
export interface UploadedObjectRecord {
  id: string;
  /** 物件鍵（＝對稱差口徑的 TosKey）。回寫授權由 owner 前綴把關。 */
  objectKey: string;
  /** 公網讀取 URL。 */
  url: string;
  mimeType: string;
  size: number;
  /** 伺服器取回位元組算出的 sha256（不是客戶端自稱）。 */
  sha256: string;
  title?: string;
  backend: "vercel-blob" | "vps-blob" | "unconfigured";
  createdAt: string;
  committedAt: string;
}

const memoryStore = new Map<number, UploadedObjectRecord[]>();
const indexCache = new Map<number, { records: UploadedObjectRecord[]; expiresAt: number }>();
const writeQueues = new Map<number, Promise<unknown>>();

function userPrefix(userId: number): string {
  return `upload-records/${sanitizeBlobSegment(String(userId), "0")}`;
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

/** 逐項清洗（不可信 payload）：形狀不全的項目直接丟，不讓髒資料冒充已入庫。 */
function normalizeRecord(payload: unknown): UploadedObjectRecord | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<UploadedObjectRecord>;
  if (typeof p.id !== "string" || !p.id.trim()) return null;
  if (typeof p.objectKey !== "string" || !p.objectKey.trim()) return null;
  if (typeof p.url !== "string" || !p.url.trim()) return null;
  if (typeof p.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(p.sha256)) return null;
  const backend =
    p.backend === "vps-blob" || p.backend === "vercel-blob" || p.backend === "unconfigured"
      ? p.backend
      : "unconfigured";
  return {
    id: p.id.trim(),
    objectKey: p.objectKey.trim(),
    url: p.url.trim(),
    mimeType: typeof p.mimeType === "string" && p.mimeType.trim() ? p.mimeType.trim() : "application/octet-stream",
    size: typeof p.size === "number" && Number.isFinite(p.size) && p.size >= 0 ? p.size : 0,
    sha256: p.sha256,
    ...(typeof p.title === "string" && p.title.trim() ? { title: p.title.trim() } : {}),
    backend,
    createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date().toISOString(),
    committedAt: typeof p.committedAt === "string" ? p.committedAt : new Date().toISOString(),
  };
}

function parseDocument(payload: unknown): UploadedObjectRecord[] {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { records?: unknown } | null)?.records)
      ? (payload as { records: unknown[] }).records
      : [];
  return raw.flatMap((item) => {
    const normalized = normalizeRecord(item);
    return normalized ? [normalized] : [];
  });
}

async function readBlobDocument(urlOrPath: string): Promise<UploadedObjectRecord[]> {
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

async function fetchRecords(userId: number): Promise<UploadedObjectRecord[]> {
  const blobs = await listIndexBlobs(userId);
  if (blobs.length) return readBlobDocument(blobs[0].url);
  return [];
}

async function readRecords(userId: number): Promise<UploadedObjectRecord[]> {
  if (!ensureBlobBackendWritable("upload-record-store.readRecords")) {
    return [...(memoryStore.get(userId) ?? [])];
  }
  const cached = indexCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return [...cached.records];
  const records = await fetchRecords(userId);
  indexCache.set(userId, { records, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  return [...records];
}

async function writeRecords(userId: number, records: UploadedObjectRecord[]): Promise<void> {
  const sorted = [...records].sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt));
  if (!ensureBlobBackendWritable("upload-record-store.writeRecords")) {
    memoryStore.set(userId, sorted);
    indexCache.delete(userId);
    return;
  }
  const previous = await listIndexBlobs(userId).catch(() => [] as BlobRef[]);
  const document = { schemaVersion: RECORD_SCHEMA_VERSION, records: sorted };
  const pathname = `${indexPrefix(userId)}${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  await put(pathname, JSON.stringify(document), {
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  indexCache.set(userId, { records: sorted, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  const stale = previous.slice(INDEX_GENERATIONS_KEPT - 1);
  if (stale.length) {
    await del(stale.map((b) => b.url)).catch((error) => {
      console.error("[upload-records] 清理舊索引失敗。", error);
    });
  }
}

/** 列出該使用者已入庫的物件（newest 優先）。 */
export async function listUploadedObjects(userId: number): Promise<UploadedObjectRecord[]> {
  return readRecords(userId);
}

/** 依物件鍵取單筆（沒有回 null）。 */
export async function findUploadedObject(userId: number, objectKey: string): Promise<UploadedObjectRecord | null> {
  return (await readRecords(userId)).find((record) => record.objectKey === objectKey) ?? null;
}

/**
 * 回寫（upsert by objectKey）。達上限且是新物件時拋錯——**誠實拒絕**，不丟最舊的冒充成功。
 */
export async function upsertUploadedObject(userId: number, record: UploadedObjectRecord): Promise<void> {
  const normalized = normalizeRecord(record);
  if (!normalized) throw new Error("invalid upload record");
  await enqueue(userId, async () => {
    const current = await readRecords(userId);
    const exists = current.some((r) => r.objectKey === normalized.objectKey);
    if (!exists && current.length >= MAX_UPLOAD_RECORDS_PER_USER) {
      throw new Error(`已入庫物件數量達上限 ${MAX_UPLOAD_RECORDS_PER_USER} 筆`);
    }
    await writeRecords(userId, [normalized, ...current.filter((r) => r.objectKey !== normalized.objectKey)]);
  });
}

/** 僅測試：重置進程內狀態。 */
export function __resetUploadRecordStoreForTests(): void {
  memoryStore.clear();
  indexCache.clear();
  writeQueues.clear();
}
