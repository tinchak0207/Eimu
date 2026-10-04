// 画布专案云端持久化（Blob）。
//
// 沿用 server-history-store.ts 的模式：每次写入落到新路径 + 修剪旧世代，
// 避免 Blob cacheControlMaxAge 60s 下限造成的「刚存读不到」。单用户写入串行。
import { randomBytes } from "node:crypto";
import { del, ensureBlobBackendWritable, get, list, put } from "@/lib/blob-backend";
import { sanitizeBlobSegment } from "@/lib/history-types";
import { isValidCreationStep, MAX_EPISODES_PER_PROJECT } from "@/lib/creation-flow-steps";
import { isCanvasProjectType, type CanvasEpisode, type CanvasProject } from "./types";
// 版本清单清洗与读取端 layout.fromCanvasProject 共用同一份（不制造第二个漂移点）。
import { normalizeNodeVersions } from "./node-versions";
// 风格 id 值域的唯一判据（＝STYLE_LIBRARY 注册面）；读取端与生成端共用同一份。
import { normalizeProjectStyleId } from "./project-style";
// 解说剧设定（P1-5／D7）的逐栏白名单（型别值域＋旁白音色值域，一处收口）。
import { normalizeProjectNarration } from "./project-narration";

const PROJECT_SCHEMA_VERSION = 1;
const INDEX_GENERATIONS_KEPT = 2;
const MAX_PROJECTS_PER_USER = 50;
const INDEX_CACHE_TTL_MS = 3_000;

const memoryStore = new Map<number, CanvasProject[]>();
const indexCache = new Map<number, { projects: CanvasProject[]; expiresAt: number }>();
const writeQueues = new Map<number, Promise<unknown>>();

// ── 团队画布命名空间（2026-09-27 片P 刀 1）──────────────────────────────
// 选型：**照个人画布的同一套轮子**（每命名空间一份 index 文件 + 保留 2 代），
// 只把前缀由 `canvas/<userId>` 换成 `canvas/team/<teamId>`。个人路径逐字不变
//（`userPrefix` 未动；userId 是数字，永不可能是字面 "team"，命名空间不撞）。
// 不采「每专案一档」的另一套模式——那会另造第二个读写/修剪轮子。
const teamMemoryStore = new Map<string, CanvasProject[]>();
const teamIndexCache = new Map<string, { projects: CanvasProject[]; expiresAt: number }>();
const teamWriteQueues = new Map<string, Promise<unknown>>();

/** 团队画布的储存命名空间前缀（`canvas/team/<teamId>`）。 */
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
 * 剧集逐项清洗（照 `normalizeProject` 的逐栏白名单范式）。
 * 非法项回 null（由呼叫端 flatMap 丢弃），不整份作废。
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

/** 剧集清单清洗：逐项白名单 → episodeNo 去重（保留首见）→ 上限 200 集。 */
function normalizeEpisodes(payload: unknown): CanvasEpisode[] | undefined {
  if (!Array.isArray(payload)) return undefined;
  const seen = new Set<number>();
  const out: CanvasEpisode[] = [];
  for (const item of payload) {
    const episode = normalizeEpisode(item);
    if (!episode) continue;
    if (seen.has(episode.episodeNo)) continue; // episodeNo 去重，保留首见
    seen.add(episode.episodeNo);
    out.push(episode);
    if (out.length >= MAX_EPISODES_PER_PROJECT) break;
  }
  return out;
}

/** 逐栏白名单清洗画布专案（外部 payload 一律走此函数才落盘）。 */
export function normalizeProject(payload: unknown): CanvasProject | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<CanvasProject>;
  if (typeof p.id !== "string" || typeof p.title !== "string" || !Array.isArray(p.nodes)) return null;
  const episodes = normalizeEpisodes(p.episodes);
  // 节点版本历史（2026-09-27）：逐项白名单＋逐节点裁剪（上限见 node-versions.ts）。
  const nodeVersions = normalizeNodeVersions(p.nodeVersions);
  // 专案级风格绑定（P1-8／D34）：唯一注册面＝STYLE_LIBRARY，查不到即省略键。
  const styleId = normalizeProjectStyleId(p.styleId);
  // 解说剧设定（P1-5／D7）：型别与旁白音色走同一个清洗入口（逐栏独立、非法省略该键）。
  const narration = normalizeProjectNarration({ scriptType: p.scriptType, narrationVoice: p.narrationVoice });
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
    // P2：锁定的角色/场景卡 id（清洗 + 去重 + 上限 100）。
    ...(Array.isArray(p.cardIds)
      ? { cardIds: [...new Set(p.cardIds.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, 100) }
      : {}),
    // 作品/剧集（2026-09-15 刀 1）：非法值一律省略栏位，不写预设值冒充用户设定。
    ...(isCanvasProjectType(p.projectType) ? { projectType: p.projectType } : {}),
    ...(isValidCreationStep(p.currentStep) ? { currentStep: p.currentStep } : {}),
    ...(episodes ? { episodes } : {}),
    ...(nodeVersions ? { nodeVersions } : {}),
    // 专案级风格绑定（P1-8／对称差 D34）：非法／未注册 id 一律**省略栏位**
    // （不写预设值冒充用户设定，与 projectType 同范式）；缺栏＝无绑定，旧专案零改动。
    ...(styleId ? { styleId } : {}),
    // 解说剧设定：有值才落键（缺栏＝未宣告，旧专案形状不变）。
    ...(narration.scriptType ? { scriptType: narration.scriptType } : {}),
    ...(narration.narrationVoice ? { narrationVoice: narration.narrationVoice } : {}),
    // 作用域（2026-09-27 片P 刀 1）：**只认 team**——personal 与缺栏一律省略栏位
    //（读取端语义即「缺省＝personal」），不写 "personal" 冒充用户设定（照 projectType 同范式）。
    // teamId 只在 scope=team 且为非空字串时保留（去空白、上限 128）。
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
      console.error("[canvas] 清理旧索引失败。", error);
    });
  }
}

// ─────────────────────────────────────────── 团队命名空间（与个人同轮子）

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
      console.error("[canvas] 清理旧团队索引失败。", error);
    });
  }
}

// ─────────────────────────────────────────── 对外接口

/** 读全部画布专案（newest 优先）。 */
export async function listCanvasProjects(userId: number): Promise<CanvasProject[]> {
  return readProjects(userId);
}

/** 储存/覆盖一整个画布专案（upsert by id）。 */
export async function saveCanvasProject(userId: number, project: CanvasProject): Promise<void> {
  const normalized = normalizeProject(project);
  if (!normalized) return;
  await enqueue(userId, async () => {
    const current = await readProjects(userId);
    await writeProjects(userId, [normalized, ...current.filter((p) => p.id !== normalized.id)]);
  });
}

/** 读单一画布专案（找不到回 null）。 */
export async function readCanvasProject(userId: number, id: string): Promise<CanvasProject | null> {
  const projects = await readProjects(userId);
  return projects.find((p) => p.id === id) ?? null;
}

/**
 * 对单一专案做**读-改-写**（在 per-user 写入伫列 `enqueue` 内执行，避免与 debounce 存档竞态。
 *
 * 版本回退/软删还原都走这里：不新增第二套储存、不绕过既有落盘白名单。
 * mutator 回 `null`＝放弃写入（例如找不到目标节点）；找不到专案同样回 null。
 * 回传实际落盘的（已清洗）专案，供路由原样回给端点。
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
    // 走同一条落盘白名单（normalizeProject）；updatedAt 由 store 盖章。
    const normalized = normalizeProject({ ...next, updatedAt: new Date().toISOString() });
    if (!normalized) return null;
    await writeProjects(userId, [normalized, ...current.filter((p) => p.id !== id)]);
    return normalized;
  });
}

/** 删除若干画布专案。返回实际删除数。 */
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

/** 仅测试：重置进程内状态。 */
export function __resetCanvasStoreForTests(): void {
  memoryStore.clear();
  indexCache.clear();
  writeQueues.clear();
  teamMemoryStore.clear();
  teamIndexCache.clear();
  teamWriteQueues.clear();
}

// ─────────────────────────────────────────── 团队画布（刀 2 读写）

/**
 * 读某团队的全部共享画布（newest 优先）。teamId 不存在／无资料 → 空阵列（不得 500）。
 * **不在此做成员判定**：呼叫端必须先以权威成员身份取得 teamId
 *（见 team-canvas-gate.ts 的 caller 读取闸），本函式只是储存层。
 */
export async function listTeamCanvasProjects(teamId: string): Promise<CanvasProject[]> {
  if (!teamId || typeof teamId !== "string") return [];
  return readTeamProjects(teamId);
}

/** 读某团队的单一画布（找不到回 null）。 */
export async function readTeamCanvasProject(teamId: string, id: string): Promise<CanvasProject | null> {
  if (!teamId || typeof teamId !== "string") return null;
  const projects = await readTeamProjects(teamId);
  return projects.find((p) => p.id === id) ?? null;
}

/** 储存/覆盖一整个团队画布（upsert by id；单写，后写覆盖）。 */
export async function saveTeamCanvasProject(teamId: string, project: CanvasProject): Promise<void> {
  if (!teamId || typeof teamId !== "string") return;
  const normalized = normalizeProject(project);
  if (!normalized) return;
  await enqueueTeam(teamId, async () => {
    const current = await readTeamProjects(teamId);
    await writeTeamProjects(teamId, [normalized, ...current.filter((p) => p.id !== normalized.id)]);
  });
}
