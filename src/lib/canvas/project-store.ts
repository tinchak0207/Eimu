// 畫布專案雲端持久化（Blob）。
//
// 沿用 server-history-store.ts 的模式：每次寫入落到新路徑 + 修剪舊世代，
// 避免 Blob cacheControlMaxAge 60s 下限造成的「剛存讀不到」。單用戶寫入串行。
import { randomBytes } from "node:crypto";
import { del, ensureBlobBackendWritable, get, list, put } from "@/lib/blob-backend";
import { sanitizeBlobSegment } from "@/lib/history-types";
import { isValidCreationStep, MAX_EPISODES_PER_PROJECT } from "@/lib/creation-flow-steps";
import { isCanvasProjectType, type CanvasEpisode, type CanvasProject } from "./types";
// 版本清單清洗與讀取端 layout.fromCanvasProject 共用同一份（不製造第二個漂移點）。
import { normalizeNodeVersions } from "./node-versions";
// 風格 id 值域的唯一判據（＝STYLE_LIBRARY 註冊面）；讀取端與生成端共用同一份。
import { normalizeProjectStyleId } from "./project-style";

const PROJECT_SCHEMA_VERSION = 1;
const INDEX_GENERATIONS_KEPT = 2;
const MAX_PROJECTS_PER_USER = 50;
const INDEX_CACHE_TTL_MS = 3_000;

const memoryStore = new Map<number, CanvasProject[]>();
const indexCache = new Map<number, { projects: CanvasProject[]; expiresAt: number }>();
const writeQueues = new Map<number, Promise<unknown>>();

// ── 團隊畫布命名空間（2026-09-27 片P 刀 1）──────────────────────────────
// 選型：**照個人畫布的同一套輪子**（每命名空間一份 index 文件 + 保留 2 代），
// 只把前綴由 `canvas/<userId>` 換成 `canvas/team/<teamId>`。個人路徑逐字不變
//（`userPrefix` 未動；userId 是數字，永不可能是字面 "team"，命名空間不撞）。
// 不採「每專案一檔」的另一套模式——那會另造第二個讀寫/修剪輪子。
const teamMemoryStore = new Map<string, CanvasProject[]>();
const teamIndexCache = new Map<string, { projects: CanvasProject[]; expiresAt: number }>();
const teamWriteQueues = new Map<string, Promise<unknown>>();

/** 團隊畫布的儲存命名空間前綴（`canvas/team/<teamId>`）。 */
export function teamCanvasNamespace(teamId: string): string {
  return `canvas/team/${sanitizeBlobSegment(teamId, "_")}`;
}

function teamIndexPrefix(teamId: string): string {
  return `${teamCanvasNamespace(teamId)}/index-`;
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

function enqueueTeam<T>(teamId: string, task: () => Promise<T>): Promise<T> {
  const key = teamCanvasNamespace(teamId);
  const previous = teamWriteQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  teamWriteQueues.set(key, next.catch(() => undefined));
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
  // 節點版本歷史（2026-09-27）：逐項白名單＋逐節點裁剪（上限見 node-versions.ts）。
  const nodeVersions = normalizeNodeVersions(p.nodeVersions);
  // 專案級風格綁定（P1-8／D34）：唯一註冊面＝STYLE_LIBRARY，查不到即省略鍵。
  const styleId = normalizeProjectStyleId(p.styleId);
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
    ...(isCanvasProjectType(p.projectType) ? { projectType: p.projectType } : {}),
    ...(isValidCreationStep(p.currentStep) ? { currentStep: p.currentStep } : {}),
    ...(episodes ? { episodes } : {}),
    ...(nodeVersions ? { nodeVersions } : {}),
    // 專案級風格綁定（P1-8／對稱差 D34）：非法／未註冊 id 一律**省略欄位**
    // （不寫預設值冒充用戶設定，與 projectType 同範式）；缺欄＝無綁定，舊專案零改動。
    ...(styleId ? { styleId } : {}),
    // 作用域（2026-09-27 片P 刀 1）：**只認 team**——personal 與缺欄一律省略欄位
    //（讀取端語義即「缺省＝personal」），不寫 "personal" 冒充用戶設定（照 projectType 同範式）。
    // teamId 只在 scope=team 且為非空字串時保留（去空白、上限 128）。
    ...(p.scope === "team" ? { scope: "team" as const } : {}),
    ...(p.scope === "team" && typeof p.teamId === "string" && p.teamId.trim().length > 0
      ? { teamId: p.teamId.trim().slice(0, 128) }
      : {}),
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
  if (!ensureBlobBackendWritable("canvas/project-store.readProjects")) return [...(memoryStore.get(userId) ?? [])];
  const cached = indexCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return [...cached.projects];
  const projects = await fetchProjects(userId);
  indexCache.set(userId, { projects, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  return [...projects];
}

async function writeProjects(userId: number, projects: CanvasProject[]): Promise<void> {
  const capped = [...projects].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, MAX_PROJECTS_PER_USER);
  if (!ensureBlobBackendWritable("canvas/project-store.writeProjects")) {
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

// ─────────────────────────────────────────── 團隊命名空間（與個人同輪子）

async function listTeamIndexBlobs(teamId: string): Promise<BlobRef[]> {
  const blobs: BlobRef[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: teamIndexPrefix(teamId), cursor });
    for (const blob of page.blobs) {
      blobs.push({ url: blob.url, pathname: blob.pathname, uploadedAt: blob.uploadedAt });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
}

async function fetchTeamProjects(teamId: string): Promise<CanvasProject[]> {
  const blobs = await listTeamIndexBlobs(teamId);
  if (blobs.length) return readBlobDocument(blobs[0].url);
  return [];
}

async function readTeamProjects(teamId: string): Promise<CanvasProject[]> {
  const key = teamCanvasNamespace(teamId);
  if (!ensureBlobBackendWritable("canvas/project-store.readTeamProjects")) return [...(teamMemoryStore.get(key) ?? [])];
  const cached = teamIndexCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return [...cached.projects];
  const projects = await fetchTeamProjects(teamId);
  teamIndexCache.set(key, { projects, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  return [...projects];
}

async function writeTeamProjects(teamId: string, projects: CanvasProject[]): Promise<void> {
  const key = teamCanvasNamespace(teamId);
  const capped = [...projects].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, MAX_PROJECTS_PER_USER);
  if (!ensureBlobBackendWritable("canvas/project-store.writeTeamProjects")) {
    teamMemoryStore.set(key, capped);
    teamIndexCache.delete(key);
    return;
  }
  const previous = await listTeamIndexBlobs(teamId).catch(() => [] as BlobRef[]);
  const document = { schemaVersion: PROJECT_SCHEMA_VERSION, projects: capped };
  const pathname = `${teamIndexPrefix(teamId)}${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  await put(pathname, JSON.stringify(document), {
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  teamIndexCache.set(key, { projects: capped, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  const stale = previous.slice(INDEX_GENERATIONS_KEPT - 1);
  if (stale.length) {
    await del(stale.map((b) => b.url)).catch((error) => {
      console.error("[canvas] 清理舊團隊索引失敗。", error);
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

/** 讀單一畫布專案（找不到回 null）。 */
export async function readCanvasProject(userId: number, id: string): Promise<CanvasProject | null> {
  const projects = await readProjects(userId);
  return projects.find((p) => p.id === id) ?? null;
}

/**
 * 對單一專案做**讀-改-寫**（在 per-user 寫入佇列 `enqueue` 內執行，避免與 debounce 存檔競態。
 *
 * 版本回退/軟刪還原都走這裡：不新增第二套儲存、不繞過既有落盤白名單。
 * mutator 回 `null`＝放棄寫入（例如找不到目標節點）；找不到專案同樣回 null。
 * 回傳實際落盤的（已清洗）專案，供路由原樣回給端點。
 */
export async function mutateCanvasProject(
  userId: number,
  id: string,
  mutator: (project: CanvasProject) => CanvasProject | null,
): Promise<CanvasProject | null> {
  return enqueue(userId, async () => {
    const current = await readProjects(userId);
    const existing = current.find((p) => p.id === id);
    if (!existing) return null;
    const next = mutator({
      ...existing,
      nodes: [...existing.nodes],
      ...(existing.nodeVersions ? { nodeVersions: [...existing.nodeVersions] } : {}),
    });
    if (!next) return null;
    // 走同一條落盤白名單（normalizeProject）；updatedAt 由 store 蓋章。
    const normalized = normalizeProject({ ...next, updatedAt: new Date().toISOString() });
    if (!normalized) return null;
    await writeProjects(userId, [normalized, ...current.filter((p) => p.id !== id)]);
    return normalized;
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
  teamMemoryStore.clear();
  teamIndexCache.clear();
  teamWriteQueues.clear();
}

// ─────────────────────────────────────────── 團隊畫布（刀 2 讀寫）

/**
 * 讀某團隊的全部共享畫布（newest 優先）。teamId 不存在／無資料 → 空陣列（不得 500）。
 * **不在此做成員判定**：呼叫端必須先以權威成員身份取得 teamId
 *（見 team-canvas-gate.ts 的 caller 讀取閘），本函式只是儲存層。
 */
export async function listTeamCanvasProjects(teamId: string): Promise<CanvasProject[]> {
  if (!teamId || typeof teamId !== "string") return [];
  return readTeamProjects(teamId);
}

/** 讀某團隊的單一畫布（找不到回 null）。 */
export async function readTeamCanvasProject(teamId: string, id: string): Promise<CanvasProject | null> {
  if (!teamId || typeof teamId !== "string") return null;
  const projects = await readTeamProjects(teamId);
  return projects.find((p) => p.id === id) ?? null;
}

/** 儲存/覆蓋一整個團隊畫布（upsert by id；單寫，後寫覆蓋）。 */
export async function saveTeamCanvasProject(teamId: string, project: CanvasProject): Promise<void> {
  if (!teamId || typeof teamId !== "string") return;
  const normalized = normalizeProject(project);
  if (!normalized) return;
  await enqueueTeam(teamId, async () => {
    const current = await readTeamProjects(teamId);
    await writeTeamProjects(teamId, [normalized, ...current.filter((p) => p.id !== normalized.id)]);
  });
}
