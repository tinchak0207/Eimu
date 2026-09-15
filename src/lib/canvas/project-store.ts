// 畫布專案雲端持久化（Blob）。
//
// 沿用 server-history-store.ts 的模式：每次寫入落到新路徑 + 修剪舊世代，
// 避免 Blob cacheControlMaxAge 60s 下限造成的「剛存讀不到」。單用戶寫入串行。
import { randomBytes } from "node:crypto";
import { del, get, list, put } from "@/lib/blob-backend";
import { sanitizeBlobSegment } from "@/lib/history-types";
import { isValidCreationStep } from "@/lib/creation-flow-steps";
import type { CanvasEpisode, CanvasProject } from "./types";

const PROJECT_SCHEMA_VERSION = 1;
const INDEX_GENERATIONS_KEPT = 2;
const MAX_PROJECTS_PER_USER = 50;
const INDEX_CACHE_TTL_MS = 3_000;
/** 單一作品的劇集上限（2026-09-15 刀 1；與 50 作品上限同哲學：防單筆 Blob 無界膨脹）。 */
const MAX_EPISODES_PER_PROJECT = 200;

const memoryStore = new Map<number, CanvasProject[]>();
const indexCache = new Map<number, { projects: CanvasProject[]; expiresAt: number }>();
const writeQueues = new Map<number, Promise<unknown>>();

function hasBlobStore(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function userPrefix(userId: number): string {
  return `canvas/${sanitizeBlobSegment(String(userId), "0")}`;
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
 * 劇集逐項清洗（照 `normalizeProject` 的逐欄白名單範式）。
 * 非法項回 null（由呼叫端 flatMap 丟棄），不整份作廢。
 */
function normalizeEpisode(payload: unknown): CanvasEpisode | null {
  if (!payload || typeof payload !== "object") return null;
  const e = payload as Partial<CanvasEpisode>;
  if (typeof e.id !== "string" || e.id.length === 0) return null;
  if (typeof e.title !== "string" || e.title.length === 0) return null;
  if (typeof e.episodeNo !== "number" || !Number.isInteger(e.episodeNo) || e.episodeNo < 1) return null;
  const now = new Date().toISOString();
  return {
    id: e.id,
    episodeNo: e.episodeNo,
    title: e.title.slice(0, 200),
    status: e.status === "draft" || e.status === "processing" || e.status === "finished" ? e.status : "draft",
    ...(typeof e.script === "string" ? { script: e.script } : {}),
    createdAt: typeof e.createdAt === "string" ? e.createdAt : now,
    updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : now,
  };
}

/** 劇集清單清洗：逐項白名單 → episodeNo 去重（保留首見）→ 上限 200 集。 */
function normalizeEpisodes(payload: unknown): CanvasEpisode[] | undefined {
  if (!Array.isArray(payload)) return undefined;
  const seen = new Set<number>();
  const out: CanvasEpisode[] = [];
  for (const item of payload) {
    const episode = normalizeEpisode(item);
    if (!episode) continue;
    if (seen.has(episode.episodeNo)) continue; // episodeNo 去重，保留首見
    seen.add(episode.episodeNo);
    out.push(episode);
    if (out.length >= MAX_EPISODES_PER_PROJECT) break;
  }
  return out;
}

/** 逐欄白名單清洗畫布專案（外部 payload 一律走此函數才落盤）。 */
export function normalizeProject(payload: unknown): CanvasProject | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<CanvasProject>;
  if (typeof p.id !== "string" || typeof p.title !== "string" || !Array.isArray(p.nodes)) return null;
  const episodes = normalizeEpisodes(p.episodes);
  return {
    id: p.id,
    title: p.title.slice(0, 200),
    createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date().toISOString(),
    updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : new Date().toISOString(),
    nodes: p.nodes,
    connections: Array.isArray(p.connections) ? p.connections : [],
    viewport: p.viewport ?? { x: 0, y: 0, k: 1 },
    backgroundMode: p.backgroundMode === "blank" || p.backgroundMode === "lines" ? p.backgroundMode : "dots",
    ...(p.budget ? { budget: p.budget } : {}),
    // P2：鎖定的角色/場景卡 id（清洗 + 去重 + 上限 100）。
    ...(Array.isArray(p.cardIds)
      ? { cardIds: [...new Set(p.cardIds.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, 100) }
      : {}),
    // 作品/劇集（2026-09-15 刀 1）：非法值一律省略欄位，不寫預設值冒充用戶設定。
    ...(p.projectType === "movie" || p.projectType === "series" ? { projectType: p.projectType } : {}),
    ...(isValidCreationStep(p.currentStep) ? { currentStep: p.currentStep } : {}),
    ...(episodes ? { episodes } : {}),
  };
}


function parseDocument(payload: unknown): CanvasProject[] {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { projects?: unknown } | null)?.projects)
      ? (payload as { projects: CanvasProject[] }).projects
      : [];
  return raw.flatMap((item) => {
    const normalized = normalizeProject(item);
    return normalized ? [normalized] : [];
  });
}

async function readBlobDocument(urlOrPath: string): Promise<CanvasProject[]> {
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

async function fetchProjects(userId: number): Promise<CanvasProject[]> {
  const blobs = await listIndexBlobs(userId);
  if (blobs.length) return readBlobDocument(blobs[0].url);
  return [];
}

async function readProjects(userId: number): Promise<CanvasProject[]> {
  if (!hasBlobStore()) return [...(memoryStore.get(userId) ?? [])];
  const cached = indexCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return [...cached.projects];
  const projects = await fetchProjects(userId);
  indexCache.set(userId, { projects, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  return [...projects];
}

async function writeProjects(userId: number, projects: CanvasProject[]): Promise<void> {
  const capped = [...projects].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, MAX_PROJECTS_PER_USER);
  if (!hasBlobStore()) {
    memoryStore.set(userId, capped);
    indexCache.delete(userId);
    return;
  }
  const previous = await listIndexBlobs(userId).catch(() => [] as BlobRef[]);
  const document = { schemaVersion: PROJECT_SCHEMA_VERSION, projects: capped };
  const pathname = `${indexPrefix(userId)}${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  await put(pathname, JSON.stringify(document), {
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  indexCache.set(userId, { projects: capped, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  const stale = previous.slice(INDEX_GENERATIONS_KEPT - 1);
  if (stale.length) {
    await del(stale.map((b) => b.url)).catch((error) => {
      console.error("[canvas] 清理舊索引失敗。", error);
    });
  }
}

// ─────────────────────────────────────────── 對外接口

/** 讀全部畫布專案（newest 優先）。 */
export async function listCanvasProjects(userId: number): Promise<CanvasProject[]> {
  return readProjects(userId);
}

/** 儲存/覆蓋一整個畫布專案（upsert by id）。 */
export async function saveCanvasProject(userId: number, project: CanvasProject): Promise<void> {
  const normalized = normalizeProject(project);
  if (!normalized) return;
  await enqueue(userId, async () => {
    const current = await readProjects(userId);
    await writeProjects(userId, [normalized, ...current.filter((p) => p.id !== normalized.id)]);
  });
}

/** 刪除若干畫布專案。返回實際刪除數。 */
export async function deleteCanvasProjects(userId: number, ids: string[]): Promise<number> {
  const targets = new Set(ids.filter(Boolean));
  if (!targets.size) return 0;
  return enqueue(userId, async () => {
    const current = await readProjects(userId);
    const removed = current.filter((p) => targets.has(p.id));
    if (!removed.length) return 0;
    await writeProjects(userId, current.filter((p) => !targets.has(p.id)));
    return removed.length;
  });
}

/** 僅測試：重置進程內狀態。 */
export function __resetCanvasStoreForTests(): void {
  memoryStore.clear();
  indexCache.clear();
  writeQueues.clear();
}
