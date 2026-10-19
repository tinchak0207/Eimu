import { randomBytes } from "node:crypto";
import { blobBackendConfigured, del, ensureBlobBackendWritable, get, list, put } from "@/lib/blob-backend";
import { validateAndDescribeBase64Image } from "./generation-core/artifact-service";
import {
  HISTORY_MAX_IMAGE_BYTES,
  HISTORY_MAX_PROMPT_LENGTH,
  HISTORY_MAX_RESULTS_PER_ENTRY,
  HISTORY_PAGE_SIZE,
  HISTORY_SCHEMA_VERSION,
  MAX_HISTORY_ENTRIES_PER_USER,
  buildHistoryFacets,
  buildHistoryStats,
  filterHistoryEntries,
  normalizeHistoryEntry,
  paginateHistoryEntries,
  sanitizeBlobSegment,
  sortHistoryEntries,
} from "./history-types";
import type {
  HistoryFacets,
  HistoryPage,
  HistoryPatch,
  HistoryQuery,
  HistoryResult,
  HistoryStats,
  ServerHistoryEntry,
} from "./history-types";

export type { ServerHistoryEntry } from "./history-types";

/** 兼容旧版导出名，既有调用点仍在用。 */
export type ServerHistoryImageResult = HistoryResult;

/**
 * 写入时的入参。
 * source 与 schemaVersion 由存储层自己填 —— 调用方（生成路由）不该也不需要知道它们。
 */
export type SaveHistoryEntryInput =
  Omit<ServerHistoryEntry, "source" | "schemaVersion" | "results"> & {
    results: Array<Omit<HistoryResult, "image" | "imageUrl"> & {
      image?: string | null;
      imageUrl?: string | null;
    }>;
  };

interface HistoryDocument {
  schemaVersion: number;
  entries: ServerHistoryEntry[];
}

/**
 * 每次写入都落到一个新的路径名。
 *
 * 旧实现固定写 `history/{userId}.json` 并开 allowOverwrite，但 Blob 的
 * cacheControlMaxAge 下限是 60 秒 —— 固定路径意味着刚生成的图最长一分钟读不到。
 * 这里沿用 admin-pool-store 的做法：新路径 + 修剪旧世代。
 */
const INDEX_GENERATIONS_KEPT = 2;

/** 极短的进程内缓存，只为挡住同一次请求里的重复读取；任何写入都会立即刷新它。 */
const INDEX_CACHE_TTL_MS = 3_000;

const memoryStore = new Map<number, ServerHistoryEntry[]>();
const indexCache = new Map<number, { entries: ServerHistoryEntry[]; expiresAt: number }>();

/**
 * 单用户写入串行队列。
 *
 * 索引是「读—改—写」的，而 generate-images 在每个出图端点成功时都会触发一次持久化，
 * 并发写会互相覆盖。这里把同一用户的写入排成一条链。
 * 这只在同一个 lambda 实例内有效 —— 跨实例并发写仍有极小概率丢记录，
 * 彻底解决需要条件写入，而 Blob 目前不提供。
 */
const writeQueues = new Map<number, Promise<unknown>>();

function userPrefix(userId: number): string {
  return `history/${sanitizeBlobSegment(String(userId), "0")}`;
}

function indexPrefix(userId: number): string {
  return `${userPrefix(userId)}/index-`;
}

/** 旧版固定路径，只用于一次性迁移。 */
function legacyIndexPath(userId: number): string {
  return `history/${sanitizeBlobSegment(String(userId), "0")}.json`;
}

/**
 * 图片路径。
 *
 * entryId 与 provider 会被清洗后才拼进路径 —— POST /api/history 的 body 是客户端输入，
 * 未经清洗时传一个 `../{别人的 id}/x` 就能写到别人的目录下。
 */
function imageBlobPath(userId: number, entryId: string, provider: string): string {
  const entry = sanitizeBlobSegment(entryId, "entry");
  const source = sanitizeBlobSegment(provider, "provider");
  return `${userPrefix(userId)}/img/${entry}-${source}.png`;
}

function enqueue<T>(userId: number, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(userId) ?? Promise.resolve();
  // 前一个任务失败不应阻断后续写入，所以先把它的拒绝吞掉。
  const next = previous.catch(() => undefined).then(task);
  writeQueues.set(userId, next.catch(() => undefined));
  return next;
}

// ─────────────────────────────────────────────────────────── 读取

type BlobRef = { url: string; pathname: string; uploadedAt: Date };

async function listIndexBlobs(userId: number): Promise<BlobRef[]> {
  const blobs: BlobRef[] = [];
  let cursor: string | undefined;

  // list() 按路径名分页，必须走完所有页，否则新索引可能落在第二页而被忽略。
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

/** 把任意历史形态的文档解析成规范化的记录数组。 */
function parseHistoryDocument(payload: unknown, userId: number): ServerHistoryEntry[] {
  // 旧版文档直接就是一个数组；新版是 { schemaVersion, entries }。
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as HistoryDocument | null)?.entries)
      ? (payload as HistoryDocument).entries
      : [];

  return raw.flatMap((item): ServerHistoryEntry[] => {
    const normalized = normalizeHistoryEntry(item, "server");
    return normalized ? [{ ...normalized, userId }] : [];
  });
}

async function readBlobDocument(urlOrPath: string, userId: number): Promise<ServerHistoryEntry[]> {
  try {
    const blob = await get(urlOrPath, { access: "public" });
    if (!blob || blob.statusCode !== 200) return [];
    const text = await new Response(blob.stream).text();
    if (!text) return [];
    return parseHistoryDocument(JSON.parse(text) as unknown, userId);
  } catch {
    return [];
  }
}

async function fetchEntries(userId: number): Promise<ServerHistoryEntry[]> {
  const blobs = await listIndexBlobs(userId);

  if (blobs.length) {
    return readBlobDocument(blobs[0].url, userId);
  }

  // 还没有新版索引：把旧版固定路径的数据迁移过来，之后就不再读它。
  const legacy = await readBlobDocument(legacyIndexPath(userId), userId);
  if (legacy.length) {
    await writeEntries(userId, legacy).catch((error) => {
      console.error("[history] 迁移旧版历史记录失败。", error);
    });
  }
  return legacy;
}

async function readEntries(userId: number): Promise<ServerHistoryEntry[]> {
  if (!ensureBlobBackendWritable("server-history-store.readEntries")) {
    return [...(memoryStore.get(userId) ?? [])];
  }

  const cached = indexCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return [...cached.entries];

  const entries = await fetchEntries(userId);
  indexCache.set(userId, { entries, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  return [...entries];
}

// ─────────────────────────────────────────────────────────── 写入

async function writeEntries(userId: number, entries: ServerHistoryEntry[]): Promise<void> {
  const capped = sortHistoryEntries(entries, "newest").slice(
    0,
    MAX_HISTORY_ENTRIES_PER_USER,
  ) as ServerHistoryEntry[];

  if (!ensureBlobBackendWritable("server-history-store.writeEntries")) {
    memoryStore.set(userId, capped);
    indexCache.delete(userId);
    return;
  }

  const previous = await listIndexBlobs(userId).catch(() => [] as BlobRef[]);
  const document: HistoryDocument = { schemaVersion: HISTORY_SCHEMA_VERSION, entries: capped };
  const pathname = `${indexPrefix(userId)}${Date.now()}-${randomBytes(4).toString("hex")}.json`;

  await put(pathname, JSON.stringify(document), {
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });

  indexCache.set(userId, { entries: capped, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });

  const stale = previous.slice(INDEX_GENERATIONS_KEPT - 1);
  if (stale.length) {
    await del(stale.map((blob) => blob.url)).catch((error) => {
      console.error("[history] 清理旧索引失败。", error);
    });
  }
}

export function canPersistGeneratedImages(): boolean {
  // 能力探针（非写入路径）：任一后端可用即 true——只看 token 会在 VPS 后端下误报「不能存图」。
  return blobBackendConfigured();
}

/**
 * 上传一张 base64 PNG，返回它的公开 URL。
 *
 * 生成路由在「响应之前」就调用它，好让响应体带的是 URL 而不是约 2.7MB 的 base64
 * （那个体积也逼近 4.5MB 的非流式响应上限）。历史持久化随后本来也要传同样的字节，
 * 所以这只是把工作提前，没有增加开销 —— 而且 PNG 之后由 Blob CDN 就近分发。
 */
export async function persistGeneratedImage(
  userId: number,
  entryId: string,
  provider: string,
  base64Image: string,
): Promise<string> {
  // 魔数嗅探 + 头部尺寸探测 + sha256 —— 挡住垃圾字节、错误格式、损坏头部，
  // 不能只靠字节数校验（旧实现只检查非空与体积上限）。
  const validated = validateAndDescribeBase64Image(base64Image, HISTORY_MAX_IMAGE_BYTES);
  if ("error" in validated) throw new Error(validated.error);

  const blob = await put(imageBlobPath(userId, entryId, provider), validated.buffer, {
    access: "public",
    contentType: validated.mimeType,
    allowOverwrite: true,
    cacheControlMaxAge: 31_536_000,
  });
  return blob.url;
}

/**
 * 把上游回传的图片 URL（签名/短时链接）下载并转存到本站 Blob，返回持久 URL。
 *
 * 2026-08-15 根因修复：上游（new-api/pixai/Adobe）可能回传 url 而非 b64_json，
 * 此时旧逻辑直接把这个短时链接存进 Canvas metadata.content，链接过期即破图。
 * 这里统一在「响应前」把字节转存，让 Canvas 与历史拿到的永远是本站托管的持久 URL。
 * 失败由调用方兜底（保留原 URL），这里只负责尽力转存。
 */
export async function persistUpstreamImageBytes(
  userId: number,
  entryId: string,
  upstreamUrl: string,
): Promise<string> {
  const res = await fetch(upstreamUrl, {
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`upstream image fetch failed: HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    throw new Error(`upstream is not an image (${contentType || "no content-type"})`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength === 0 || buffer.byteLength > HISTORY_MAX_IMAGE_BYTES) {
    throw new Error(`upstream image empty or over ${HISTORY_MAX_IMAGE_BYTES} bytes`);
  }
  const blob = await put(imageBlobPath(userId, entryId, "image_eimu"), buffer, {
    access: "public",
    contentType,
    allowOverwrite: true,
    cacheControlMaxAge: 31_536_000,
  });
  return blob.url;
}

/** 把还留在记录里的 base64 转存到独立 Blob；索引会被整份读写，绝不能塞进几 MB 的字符串。 */
async function persistImages(entry: ServerHistoryEntry): Promise<ServerHistoryEntry> {
  if (!ensureBlobBackendWritable("server-history-store.persistImages")) {
    // 允许内存降级（非生产或显式 opt-in）时没有 Blob：直接丢掉 base64，避免把内存吃满。
    return { ...entry, results: entry.results.map((result) => ({ ...result, image: null })) };
  }

  const results = await Promise.all(entry.results.map(async (result): Promise<HistoryResult> => {
    // 生成路由已经传过了（image 置空、imageUrl 已填），跳过。
    if (!result.image) return result;

    try {
      const imageUrl = await persistGeneratedImage(entry.userId, entry.id, result.provider, result.image);
      return { ...result, image: null, imageUrl };
    } catch (error) {
      console.error("[history] 图片转存失败，保留记录但不保留图。", error);
      return { ...result, image: null };
    }
  }));

  return { ...entry, results };
}

// ─────────────────────────────────────────────────────────── 对外接口

/** 写入一条生成记录。同一用户的并发调用会被串行执行。 */
export async function saveGeneratedHistoryEntry(entry: SaveHistoryEntryInput): Promise<void> {
  const normalized = normalizeHistoryEntry(entry, "server");
  if (!normalized || !Number.isFinite(entry.userId)) return;

  const prepared: ServerHistoryEntry = {
    ...normalized,
    userId: entry.userId,
    prompt: normalized.prompt.slice(0, HISTORY_MAX_PROMPT_LENGTH),
    results: normalized.results.slice(0, HISTORY_MAX_RESULTS_PER_ENTRY),
  };

  await enqueue(entry.userId, async () => {
    const withImages = await persistImages(prepared);
    const current = await readEntries(entry.userId);
    await writeEntries(entry.userId, [withImages, ...current.filter((item) => item.id !== withImages.id)]);
  });
}

/** 读取全部记录。保留旧版导出名，供既有调用点使用。 */
export async function listGeneratedHistoryEntries(userId: number): Promise<ServerHistoryEntry[]> {
  return readEntries(userId);
}

/** 按查询条件取一页记录。 */
export async function listHistoryPage(
  userId: number,
  query: HistoryQuery = {},
  cursor: string | null = null,
  pageSize: number = HISTORY_PAGE_SIZE,
): Promise<HistoryPage> {
  const entries = await readEntries(userId);
  return paginateHistoryEntries(filterHistoryEntries(entries, query), cursor, pageSize);
}

/** 分面统计，用于筛选栏。基于全量记录，不受当前分页影响。 */
export async function getHistoryFacets(userId: number): Promise<HistoryFacets> {
  return buildHistoryFacets(await readEntries(userId));
}

/** 汇总统计。 */
export async function getHistoryStats(userId: number): Promise<HistoryStats> {
  return buildHistoryStats(await readEntries(userId));
}

/** 读取单条记录。 */
export async function getHistoryEntry(userId: number, id: string): Promise<ServerHistoryEntry | null> {
  const entries = await readEntries(userId);
  return entries.find((entry) => entry.id === id) ?? null;
}

/** 更新单条记录（目前只有收藏）。记录不存在时返回 null。 */
export async function patchHistoryEntry(
  userId: number,
  id: string,
  patch: HistoryPatch,
): Promise<ServerHistoryEntry | null> {
  return enqueue(userId, async () => {
    const entries = await readEntries(userId);
    const index = entries.findIndex((entry) => entry.id === id);
    if (index < 0) return null;

    const updated: ServerHistoryEntry = {
      ...entries[index],
      ...(patch.starred !== undefined ? { starred: patch.starred } : {}),
    };
    const next = [...entries];
    next[index] = updated;
    await writeEntries(userId, next);
    return updated;
  });
}

/** 删除若干条记录。返回实际删除的条数。 */
export async function deleteHistoryEntries(userId: number, ids: string[]): Promise<number> {
  const targets = new Set(ids.filter(Boolean));
  if (!targets.size) return 0;

  return enqueue(userId, async () => {
    const entries = await readEntries(userId);
    const removed = entries.filter((entry) => targets.has(entry.id));
    if (!removed.length) return 0;

    await writeEntries(userId, entries.filter((entry) => !targets.has(entry.id)));

    // 2026-08-15 修复：不再连带删除图片 Blob。
    // 同一颗 Blob 可能同时被 Canvas 节点的 metadata.content 与历史记录引用，
    // 这里删图会把画布上仍在使用的图片打成破图。引用数无法在 Blob 上追踪，
    // 取舍是「宁可留垃圾也不破图」——后续要清理时按存留时间（LRU）单独处理。
    return removed.length;
  });
}

/** 清空某个用户的全部历史。 */
export async function clearHistoryEntries(userId: number): Promise<number> {
  return enqueue(userId, async () => {
    const entries = await readEntries(userId);
    if (!entries.length) return 0;

    await writeEntries(userId, []);
    // 2026-08-15 修复：与 deleteHistoryEntries 一致，清历史不删图片 Blob，
    // 避免把 Canvas 节点仍在引用的图片打成破图。

    return entries.length;
  });
}

/** 仅供测试使用：重置进程内状态。 */
export function __resetHistoryStoreForTests(): void {
  memoryStore.clear();
  indexCache.clear();
  writeQueues.clear();
}
