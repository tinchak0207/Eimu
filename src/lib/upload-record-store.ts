// 直传物件的「拥有者纪录」真源（Blob 持久化）。
//
// D36 语义：上传完要**回写 TosKey 才算入库**。本档就是那张拥有者纪录——
// 每个使用者一份索引 `upload-records/<userId>/index-<ts>-<rand>.json`，内容是
// 「已回写的物件键 ＋ 伺服器亲自取回位元组算出的 sha256 ＋ 大小 ＋ mime」。
//
// 沿用 `asset-pack-store.ts` / `project-store.ts` 的既有模式（**同一个轮子**，
// 不另立第三代写法）：每次写入落新路径 + 修剪旧世代（避开 Blob cacheControlMaxAge
// 60s 下限造成的「刚存读不到」）、单用户写入串行。
//
// 记忆体降级：只在 `blob-backend` 的既有一致门禁允许时（非生产，或显式
// BLOB_ALLOW_MEMORY_FALLBACK=true）才落进程内，生产缺后端一律诚实抛错。
import { randomBytes } from "node:crypto";
import { del, ensureBlobBackendWritable, get, list, put } from "@/lib/blob-backend";
import { sanitizeBlobSegment } from "@/lib/history-types";

const RECORD_SCHEMA_VERSION = 1;
const INDEX_GENERATIONS_KEPT = 2;
const INDEX_CACHE_TTL_MS = 3_000;

/** 每位使用者的已入库物件纪录上限（超出时拒绝，不静默丢最旧的）。 */
export const MAX_UPLOAD_RECORDS_PER_USER = 2_000;

/** 一笔已回写入库的直传物件。 */
export interface UploadedObjectRecord {
  id: string;
  /** 物件键（＝对称差口径的 TosKey）。回写授权由 owner 前缀把关。 */
  objectKey: string;
  /** 公网读取 URL。 */
  url: string;
  mimeType: string;
  size: number;
  /** 伺服器取回位元组算出的 sha256（不是客户端自称）。 */
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

/** 逐项清洗（不可信 payload）：形状不全的项目直接丢，不让脏资料冒充已入库。 */
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
      console.error("[upload-records] 清理旧索引失败。", error);
    });
  }
}

/** 列出该使用者已入库的物件（newest 优先）。 */
export async function listUploadedObjects(userId: number): Promise<UploadedObjectRecord[]> {
  return readRecords(userId);
}

/** 依物件键取单笔（没有回 null）。 */
export async function findUploadedObject(userId: number, objectKey: string): Promise<UploadedObjectRecord | null> {
  return (await readRecords(userId)).find((record) => record.objectKey === objectKey) ?? null;
}

/**
 * 回写（upsert by objectKey）。达上限且是新物件时抛错——**诚实拒绝**，不丢最旧的冒充成功。
 */
export async function upsertUploadedObject(userId: number, record: UploadedObjectRecord): Promise<void> {
  const normalized = normalizeRecord(record);
  if (!normalized) throw new Error("invalid upload record");
  await enqueue(userId, async () => {
    const current = await readRecords(userId);
    const exists = current.some((r) => r.objectKey === normalized.objectKey);
    if (!exists && current.length >= MAX_UPLOAD_RECORDS_PER_USER) {
      throw new Error(`已入库物件数量达上限 ${MAX_UPLOAD_RECORDS_PER_USER} 笔`);
    }
    await writeRecords(userId, [normalized, ...current.filter((r) => r.objectKey !== normalized.objectKey)]);
  });
}

/** 仅测试：重置进程内状态。 */
export function __resetUploadRecordStoreForTests(): void {
  memoryStore.clear();
  indexCache.clear();
  writeQueues.clear();
}
