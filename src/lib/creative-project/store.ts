// 创作项目（P0 新层）云端持久化（Blob）。
//
// 沿用 canvas/project-store.ts 的模式：每次写入落到新路径 + 修剪旧世代，
// 避免 Blob cacheControlMaxAge 60s 下限造成的「刚存读不到」。单用户写入串行。
import { randomBytes } from "node:crypto";
import { del, ensureBlobBackendWritable, get, list, put } from "@/lib/blob-backend";
import { sanitizeBlobSegment } from "@/lib/history-types";
// 存量迁移的唯一来源：既有画布专案（只读，本刀不删画布）。
import { listCanvasProjects } from "@/lib/canvas/project-store";
import type { CreativeProject, ProjectChat, ProjectTitleSource } from "./types";

const PROJECT_SCHEMA_VERSION = 1;
const INDEX_GENERATIONS_KEPT = 2;
const MAX_CREATIVE_PROJECTS_PER_USER = 100;
const INDEX_CACHE_TTL_MS = 3_000;
const MAX_CHATS_PER_PROJECT = 200;
/**
 * `sessionId` 长度上限（UTF-16 单元）。
 * 唯一真源：`normalizeChat` 的截断与 `chats/route.ts` 的入口拒收**共用此常量**，
 * 避免「写端截断、读端全串比对」造成往返不对称（PUT 成功但 DELETE 删不掉、同串 PUT 落两条）。
 */
export const MAX_CHAT_SESSION_ID_LENGTH = 200;

const TITLE_SOURCES: ProjectTitleSource[] = ["default", "first_input", "generated", "custom"];

interface ProjectDocument {
  schemaVersion: number;
  projects: CreativeProject[];
  legacyMigratedAt?: string;
}

const memoryStore = new Map<number, ProjectDocument>();
const indexCache = new Map<number, { document: ProjectDocument; expiresAt: number }>();
const writeQueues = new Map<number, Promise<unknown>>();

function userPrefix(userId: number): string {
  return `projects/${sanitizeBlobSegment(String(userId), "0")}`;
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

function isTitleSource(value: unknown): value is ProjectTitleSource {
  return typeof value === "string" && (TITLE_SOURCES as string[]).includes(value);
}

function emptyDocument(): ProjectDocument {
  return { schemaVersion: PROJECT_SCHEMA_VERSION, projects: [] };
}

/**
 * 聊天条目逐项清洗（照 `normalizeCreativeProject` 的逐栏白名单范式）。
 * 非法项回 null（由呼叫端 flatMap 丢弃），不整份作废。
 * `sessionId` 允许空串＝迁移期的「默认画布」未绑定会话特例（见 types.ts）。
 */
function normalizeChat(payload: unknown): ProjectChat | null {
  if (!payload || typeof payload !== "object") return null;
  const c = payload as Partial<ProjectChat>;
  if (typeof c.sessionId !== "string") return null;
  const now = new Date().toISOString();
  const canvasIds = Array.isArray(c.canvasIds)
    ? [...new Set(c.canvasIds.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, 100)
    : [];
  // primaryCanvasId 必须落在 canvasIds 内，否则省略键（不写无效值冒充设定）。
  const primaryCanvasId =
    typeof c.primaryCanvasId === "string" && canvasIds.includes(c.primaryCanvasId) ? c.primaryCanvasId : undefined;
  return {
    sessionId: c.sessionId.slice(0, MAX_CHAT_SESSION_ID_LENGTH),
    title: typeof c.title === "string" ? c.title.slice(0, 200) : "新聊天",
    titleSource: isTitleSource(c.titleSource) ? c.titleSource : "default",
    canvasIds,
    ...(primaryCanvasId ? { primaryCanvasId } : {}),
    createdAt: typeof c.createdAt === "string" ? c.createdAt : now,
    updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : now,
    // 只有非空 string 才落键（不写预设值冒充用户设定）。
    ...(typeof c.archivedAt === "string" && c.archivedAt.length > 0 ? { archivedAt: c.archivedAt } : {}),
  };
}

/**
 * 聊天清单裁剪到上限：超限时**保最新、丢最旧**。
 *
 * 旧实作是 `.slice(0, MAX_CHATS_PER_PROJECT)`（取数组头部）——但新条目由路由
 * 追加到尾部，于是被砍掉的是**最新**的，PUT 回 success 却静默蒸发（Hacker F2）。
 * 改为按 `updatedAt` 判新旧，丢掉最旧的 `length - MAX_CHATS_PER_PROJECT` 条；
 * 存活条目**保持原相对顺序**（展示层依赖服务端顺序，不做全量 sort 重排）。
 * `updatedAt` 相同／不可解析时，靠后者视为较新（稳定、确定性，不用随机排序）。
 *
 * **受保护条目**：`sessionId === ""` 的迁移条目（存量迁移构造的「默认画布」）是项目 UI
 * 通往存量画布的**唯一挂载点**，裁剪**永不丢弃它**，也不占用名额——`MAX_CHATS_PER_PROJECT`
 * 只约束非保护条目的数量；名额不足时只从非保护条目里按 `updatedAt` 丢最旧。外部入口
 * 已由路由的 F4 闸拒收空 `sessionId`（外面挡得住，里面也不能自己删）。
 *
 * 已知边界（本刀不修）：逐栏清洗沿用全仓既有的 `String.prototype.slice`（UTF-16 单元），
 * 在边界会切断 emoji 代理对（Hacker F3）；全仓同一范式，单独修会造出第二套截断口径。
 */
function trimChatsToLimit(chats: ProjectChat[]): ProjectChat[] {
  const candidates = chats
    .map((chat, index) => ({ index, ts: Date.parse(chat.updatedAt) }))
    .filter((item) => chats[item.index].sessionId !== "");
  if (candidates.length <= MAX_CHATS_PER_PROJECT) return chats;
  const dropCount = candidates.length - MAX_CHATS_PER_PROJECT;
  const ordered = candidates.sort((a, b) => {
    const av = Number.isFinite(a.ts) ? a.ts : null;
    const bv = Number.isFinite(b.ts) ? b.ts : null;
    // 两边都是有效时间 → 旧在前（升序）；任一不可解析视为并列 → 按原序（靠后者较新）。
    if (av !== null && bv !== null && av !== bv) return av - bv;
    return a.index - b.index;
  });
  const dropped = new Set(ordered.slice(0, dropCount).map((item) => item.index));
  return chats.filter((_, index) => !dropped.has(index));
}

/** 逐栏白名单清洗创作项目（外部 payload 一律走此函数才落盘）。 */
export function normalizeCreativeProject(payload: unknown): CreativeProject | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<CreativeProject>;
  if (typeof p.id !== "string" || p.id.length === 0) return null;
  const now = new Date().toISOString();
  // 聊天清单：逐项白名单 → 非法丢项（不整份作废）→ 超限保最新丢最旧（见 trimChatsToLimit）。
  const chats = Array.isArray(p.chats)
    ? trimChatsToLimit(
        p.chats.flatMap((item) => {
          const chat = normalizeChat(item);
          return chat ? [chat] : [];
        }),
      )
    : [];
  return {
    id: p.id.slice(0, 120),
    title: typeof p.title === "string" ? p.title.slice(0, 200) : "未命名项目",
    createdAt: typeof p.createdAt === "string" ? p.createdAt : now,
    updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : now,
    // 只有非空 string 才落键（不写预设值冒充用户设定）。
    ...(typeof p.archivedAt === "string" && p.archivedAt.length > 0 ? { archivedAt: p.archivedAt } : {}),
    chats,
  };
}

function parseDocument(payload: unknown): ProjectDocument {
  const container = Array.isArray(payload)
    ? null
    : (payload as { projects?: unknown; legacyMigratedAt?: unknown } | null);
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(container?.projects)
      ? (container.projects as unknown[])
      : [];
  const projects = raw.flatMap((item) => {
    const normalized = normalizeCreativeProject(item);
    return normalized ? [normalized] : [];
  });
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projects,
    ...(typeof container?.legacyMigratedAt === "string" && container.legacyMigratedAt.length > 0
      ? { legacyMigratedAt: container.legacyMigratedAt }
      : {}),
  };
}

async function readBlobDocument(urlOrPath: string): Promise<ProjectDocument> {
  try {
    const blob = await get(urlOrPath, { access: "public" });
    if (!blob || blob.statusCode !== 200) return emptyDocument();
    const text = await new Response(blob.stream).text();
    if (!text) return emptyDocument();
    return parseDocument(JSON.parse(text) as unknown);
  } catch {
    return emptyDocument();
  }
}

async function fetchDocument(userId: number): Promise<ProjectDocument> {
  const blobs = await listIndexBlobs(userId);
  if (blobs.length) return readBlobDocument(blobs[0].url);
  return emptyDocument();
}

async function readDocument(userId: number): Promise<ProjectDocument> {
  if (!ensureBlobBackendWritable("projects/project-store.readDocument")) {
    return memoryStore.get(userId) ?? emptyDocument();
  }
  const cached = indexCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.document;
  const document = await fetchDocument(userId);
  indexCache.set(userId, { document, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  return document;
}

async function writeDocument(userId: number, document: ProjectDocument): Promise<ProjectDocument> {
  const capped: ProjectDocument = {
    ...document,
    projects: [...document.projects]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, MAX_CREATIVE_PROJECTS_PER_USER),
  };
  if (!ensureBlobBackendWritable("projects/project-store.writeDocument")) {
    memoryStore.set(userId, capped);
    indexCache.delete(userId);
    return capped;
  }
  const previous = await listIndexBlobs(userId).catch(() => [] as BlobRef[]);
  const pathname = `${indexPrefix(userId)}${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  await put(pathname, JSON.stringify(capped), {
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  indexCache.set(userId, { document: capped, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  const stale = previous.slice(INDEX_GENERATIONS_KEPT - 1);
  if (stale.length) {
    await del(stale.map((b) => b.url)).catch((error) => {
      console.error("[projects] 清理旧索引失败。", error);
    });
  }
  return capped;
}

// ─────────────────────────────────────────── 对外接口

/** 读全部创作项目（newest 优先）。 */
export async function listCreativeProjects(userId: number): Promise<CreativeProject[]> {
  const document = await readDocument(userId);
  return [...document.projects];
}

/** 读单一创作项目（找不到回 null）。 */
export async function readCreativeProject(userId: number, id: string): Promise<CreativeProject | null> {
  const projects = await listCreativeProjects(userId);
  return projects.find((p) => p.id === id) ?? null;
}

/** 储存/覆盖一整个创作项目（upsert by id）。 */
export async function saveCreativeProject(userId: number, project: CreativeProject): Promise<void> {
  const normalized = normalizeCreativeProject(project);
  if (!normalized) return;
  await enqueue(userId, async () => {
    const document = await readDocument(userId);
    await writeDocument(userId, {
      ...document,
      projects: [normalized, ...document.projects.filter((p) => p.id !== normalized.id)],
    });
  });
}

/**
 * 对单一项目做**读-改-写**（在 per-user 写入伫列 `enqueue` 内执行，避免与存档竞态。
 *
 * mutator 回 `null`＝放弃写入；找不到项目同样回 null。
 * 回传实际落盘的（已清洗）项目，供路由原样回给端点。updatedAt 由 store 盖章。
 */
export async function mutateCreativeProject(
  userId: number,
  id: string,
  mutator: (project: CreativeProject) => CreativeProject | null,
): Promise<CreativeProject | null> {
  return enqueue(userId, async () => {
    const document = await readDocument(userId);
    const existing = document.projects.find((p) => p.id === id);
    if (!existing) return null;
    const next = mutator({
      ...existing,
      chats: [...existing.chats],
    });
    if (!next) return null;
    // 走同一条落盘白名单（normalizeCreativeProject）；updatedAt 由 store 盖章。
    const normalized = normalizeCreativeProject({ ...next, updatedAt: new Date().toISOString() });
    if (!normalized) return null;
    await writeDocument(userId, {
      ...document,
      projects: [normalized, ...document.projects.filter((p) => p.id !== id)],
    });
    return normalized;
  });
}

/** 删除若干创作项目。返回实际删除数。 */
export async function deleteCreativeProjects(userId: number, ids: string[]): Promise<number> {
  const targets = new Set(ids.filter(Boolean));
  if (!targets.size) return 0;
  return enqueue(userId, async () => {
    const document = await readDocument(userId);
    const removed = document.projects.filter((p) => targets.has(p.id));
    if (!removed.length) return 0;
    await writeDocument(userId, {
      ...document,
      projects: document.projects.filter((p) => !targets.has(p.id)),
    });
    return removed.length;
  });
}

/**
 * 存量迁移（幂等）：既有画布专案 → 一条「默认画布」聊天（`sessionId: ""`）。
 *
 * 在 enqueue 串行区内做：
 * 1. 已盖过 `legacyMigratedAt` 章 → 直接回现项目，不写盘。
 * 2. 无 legacy 画布 → 不写盘（不给新用户白烧一次 Blob 写）。
 * 3. 有 legacy 画布且当前项目数为 0 → 建项目（id 由 randomBytes 生成）。
 * 4. 有 legacy 画布但当前已有项目 → 不改内容，只盖章。
 * 两种情况都在同一支写盘里盖 `legacyMigratedAt`。
 */
export async function ensureLegacyProjectMigration(userId: number): Promise<CreativeProject[]> {
  return enqueue(userId, async () => {
    const document = await readDocument(userId);
    if (document.legacyMigratedAt) return [...document.projects];

    const legacy = await listCanvasProjects(userId);
    if (!legacy.length) return [...document.projects];

    const now = new Date().toISOString();
    let projects = document.projects;
    if (projects.length === 0) {
      // 按 updatedAt 降序取全部 legacy 画布 id；第一个为 primaryCanvasId。
      const canvasIds = [...legacy]
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .map((c) => c.id);
      const chat: ProjectChat = {
        sessionId: "",
        title: "默认画布",
        titleSource: "default",
        canvasIds,
        ...(canvasIds[0] ? { primaryCanvasId: canvasIds[0] } : {}),
        createdAt: now,
        updatedAt: now,
      };
      projects = [
        {
          id: `prj_${randomBytes(12).toString("hex")}`,
          title: "我的项目",
          createdAt: now,
          updatedAt: now,
          chats: [chat],
        },
      ];
    }
    const written = await writeDocument(userId, {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      projects,
      legacyMigratedAt: now,
    });
    return [...written.projects];
  });
}

/** 仅测试：重置进程内状态。 */
export function __resetCreativeProjectStoreForTests(): void {
  memoryStore.clear();
  indexCache.clear();
  writeQueues.clear();
}
