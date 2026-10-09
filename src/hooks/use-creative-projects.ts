"use client";

// P0-W3：项目/聊天的**全局单例**客户端状态。
//
// 侧栏与聊天面是两个不同元件，必须看到同一份状态 ⇒ 模块级 store +
// useSyncExternalStore（照抄 src/lib/history-client-store.ts 的形态）。
// 各调一次 hook 各自 useState 会产生两份不一致的状态，这是本刀最容易埋的雷。
//
// 标题真源（对齐 ZCode 的 title_source 语义，custom 粘性）：
//   1. chat.titleSource === "custom" → 取站点存的 chat.title（用户改过名，永不被网关标题盖）
//   2. 否则 → 网关 AgentSessionSummary.title（它本来就是首条输入派生）
//   3. 都没有 → "未命名对话"
// 站点侧不猜首条输入、不写 generated 标题（那是 P1 的事）。

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  listProjects,
  createProject as apiCreateProject,
  patchProject as apiPatchProject,
  upsertChat as apiUpsertChat,
  removeChat as apiRemoveChat,
} from "@/lib/creative-project/client";
import { listAgentSessions } from "@/lib/agent-chat-client";
import type { AgentSessionSummary } from "@/lib/agent-chat-client";
import type { CreativeProject, ProjectChat, ProjectTitleSource } from "@/lib/creative-project/types";

// ─────────────────────────────────────────────────────────── 对外型别（冻结）

export interface ProjectChatView {
  sessionId: string;
  /** 已按优先级解析好的**显示**标题。 */
  title: string;
  titleSource: ProjectTitleSource;
  status?: "running" | "waiting" | "idle";
  /** ms epoch：网关 last_activity_at 优先，否则 Date.parse(chat.updatedAt)。 */
  updatedAt: number;
  canvasCount: number;
  /** 该聊天拥有的画布 id（归属真源＝项目档 chats[].canvasIds，**直传不做变换**）。 */
  canvasIds: string[];
  /** 该聊天的主画布（项目档原值直传；无则 undefined）。 */
  primaryCanvasId?: string;
  archived: boolean;
}

export interface ProjectView {
  id: string; title: string; archived: boolean; updatedAt: number; chats: ProjectChatView[];
}

export interface CreativeProjectsState {
  projects: ProjectView[];
  /** 网关有、但没有任何项目挂过的会话（「未分类」，不强行归属）。 */
  unassigned: ProjectChatView[];
  activeProjectId: string | null;
  loading: boolean;
  error: string | null;
}

const ACTIVE_PROJECT_STORAGE_KEY = "eimu-active-project-v1";

const EMPTY_STATE: CreativeProjectsState = {
  projects: [],
  unassigned: [],
  activeProjectId: null,
  loading: false,
  error: null,
};

// ─────────────────────────────────────────────────────────── store

/** store 内部状态：服务端原样（projects/sessions）+ 本机 UI 上下文。 */
interface StoreState {
  creativeProjects: CreativeProject[];
  sessions: AgentSessionSummary[];
  activeProjectId: string | null;
  loading: boolean;
  error: string | null;
}

let raw: StoreState = {
  creativeProjects: [],
  sessions: [],
  activeProjectId: readStoredActiveProjectId(),
  loading: false,
  error: null,
};

/** 派生视图快照。只在 raw 变化时由 recompute() 换新对象（否则 useSyncExternalStore 无限 render）。 */
let snapshot: CreativeProjectsState = buildState(raw);
const listeners = new Set<() => void>();
/** 递增序号：只有最新一次 refresh 的结果会被采纳（慢响应不覆盖新结果）。 */
let refreshSeq = 0;

function recompute(): void {
  snapshot = buildState(raw);
  for (const listener of listeners) listener();
}

function setRaw(patch: Partial<StoreState>): void {
  raw = { ...raw, ...patch };
  recompute();
}

export function subscribeCreativeProjects(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCreativeProjectsSnapshot(): CreativeProjectsState {
  return snapshot;
}

/** 服务端渲染快照。必须是稳定引用，否则 useSyncExternalStore 会报无限循环。 */
export function getCreativeProjectsServerSnapshot(): CreativeProjectsState {
  return EMPTY_STATE;
}

// ─────────────────────────────────────────────────────────── 纯逻辑

function parseTime(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/**
 * 标题优先级（见文件头）。custom 粘性——用户改过名永不被网关标题盖掉。
 * 非 custom 的站点标题不参与显示（P0 站点侧不会写这类标题，P1 才写）。
 */
export function resolveChatDisplayTitle(
  chat: { title: string; titleSource: ProjectTitleSource },
  session: { title?: string | null } | undefined,
): string {
  if (chat.titleSource === "custom") return chat.title || "未命名对话";
  const gatewayTitle = session?.title;
  if (typeof gatewayTitle === "string" && gatewayTitle.trim()) return gatewayTitle;
  return "未命名对话";
}

/** ms epoch：网关 last_activity_at 优先，否则回退 Date.parse(chat.updatedAt)（无效时间 → 0）。 */
export function resolveChatUpdatedAt(
  chat: { updatedAt: string },
  session: { last_activity_at?: number } | undefined,
): number {
  const la = session?.last_activity_at;
  if (typeof la === "number" && Number.isFinite(la) && la > 0) return la;
  return parseTime(chat.updatedAt);
}

function sessionUpdatedAt(session: AgentSessionSummary): number {
  const la = session.last_activity_at;
  if (typeof la === "number" && Number.isFinite(la) && la > 0) return la;
  const u = session.updated_at;
  if (typeof u === "number" && Number.isFinite(u) && u > 0) return u;
  return 0;
}

function chatToView(chat: ProjectChat, session: AgentSessionSummary | undefined): ProjectChatView {
  return {
    sessionId: chat.sessionId,
    title: resolveChatDisplayTitle(chat, session),
    titleSource: chat.titleSource,
    status: session?.status,
    updatedAt: resolveChatUpdatedAt(chat, session),
    canvasCount: Array.isArray(chat.canvasIds) ? chat.canvasIds.length : 0,
    // P2-C：直传原始栏位（不做任何派生）——useCanvasChat 的补登/切画布要读它。
    canvasIds: Array.isArray(chat.canvasIds) ? chat.canvasIds : [],
    ...(chat.primaryCanvasId ? { primaryCanvasId: chat.primaryCanvasId } : {}),
    archived: Boolean(chat.archivedAt),
  };
}

function projectToView(project: CreativeProject, sessionById: Map<string, AgentSessionSummary>): ProjectView {
  return {
    id: project.id,
    title: project.title,
    archived: Boolean(project.archivedAt),
    updatedAt: parseTime(project.updatedAt),
    // 顺序沿用服务端/本机原样（排序是展示层的事，这里不发明规则）。
    chats: project.chats.map((chat) => chatToView(chat, sessionById.get(chat.sessionId))),
  };
}

/** 未分类条目：没有站点聊记录，标题只用网关标题；无标题时 titleSource 记 default。 */
function sessionToView(session: AgentSessionSummary): ProjectChatView {
  const hasTitle = typeof session.title === "string" && session.title.trim().length > 0;
  return {
    sessionId: session.session_id,
    title: hasTitle ? (session.title as string) : "未命名对话",
    titleSource: hasTitle ? "generated" : "default",
    status: session.status,
    updatedAt: sessionUpdatedAt(session),
    canvasCount: 0,
    // 未分类会话：站点侧没有任何项目挂过，没有画布归属。
    canvasIds: [],
    archived: false,
  };
}

function buildState(state: StoreState): CreativeProjectsState {
  const sessionById = new Map<string, AgentSessionSummary>();
  for (const session of state.sessions) sessionById.set(session.session_id, session);

  const projects = state.creativeProjects.map((project) => projectToView(project, sessionById));

  // 未分类：网关有、但没有任何项目挂过的会话。不强行归属。
  // 注意 chat.sessionId === ""（存量迁移期的「默认画布」条目）永远匹配不到任何会话。
  const assigned = new Set<string>();
  for (const project of state.creativeProjects) {
    for (const chat of project.chats) if (chat.sessionId) assigned.add(chat.sessionId);
  }
  const unassigned = state.sessions
    .filter((session) => !assigned.has(session.session_id))
    .map((session) => sessionToView(session));

  return {
    projects,
    unassigned,
    activeProjectId: state.activeProjectId,
    loading: state.loading,
    error: state.error,
  };
}

// ─────────────────────────────────────────────────────────── localStorage

function readStoredActiveProjectId(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const value = localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
    return value && value.length ? value : null;
  } catch {
    return null;
  }
}

function writeStoredActiveProjectId(id: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (id) localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, id);
    else localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
  } catch {
    // 隐私模式/配额满：持久化失败不该让功能坏掉。
  }
}

// ─────────────────────────────────────────────────────────── 动作（模块级，单例）

function upsertProjectInList(list: CreativeProject[], project: CreativeProject): CreativeProject[] {
  const index = list.findIndex((item) => item.id === project.id);
  if (index === -1) return [project, ...list];
  const next = list.slice();
  next[index] = project;
  return next;
}

function findChatEntryBySession(sessionId: string): { project: CreativeProject; chat: ProjectChat } | null {
  if (!sessionId) return null;
  for (const project of raw.creativeProjects) {
    const chat = project.chats.find((item) => item.sessionId === sessionId);
    if (chat) return { project, chat };
  }
  return null;
}

/**
 * 会话 → 该聊天条目的画布归属（canvasIds + primaryCanvasId）。
 * **直传项目档原值，不做派生**（归属真源＝项目档 chats[]，见 types.ts 档头）。
 * 未归属会话 → null。供 `useCanvasChat` 的第二参注入——避免它绕过共享 store
 * 直读原始项目档（`listProjects()`）而多一轮 `GET /api/projects`。
 */
export function findChatBySession(
  sessionId: string,
): { canvasIds: string[]; primaryCanvasId?: string } | null {
  const entry = findChatEntryBySession(sessionId);
  if (!entry) return null;
  const { chat } = entry;
  return {
    canvasIds: Array.isArray(chat.canvasIds) ? chat.canvasIds : [],
    ...(chat.primaryCanvasId ? { primaryCanvasId: chat.primaryCanvasId } : {}),
  };
}

/**
 * 拉取项目列表 + 网关会话列表并合并。
 * 任一路失败只保留旧数据 + 设 error；activeProjectId 指向不存在项目时清空（fail-safe）。
 * silent 用于写操作后的对帐（不闪 loading）。
 */
export async function refreshProjects(options?: { silent?: boolean }): Promise<void> {
  const seq = ++refreshSeq;
  if (!options?.silent) setRaw({ loading: true, error: null });

  const [projectsResult, sessionsResult] = await Promise.allSettled([listProjects(), listAgentSessions()]);
  if (seq !== refreshSeq) return; // 被更新的一次取代，丢弃旧结果。

  let error: string | null = null;
  let creativeProjects = raw.creativeProjects;
  let sessions = raw.sessions;

  if (projectsResult.status === "fulfilled") {
    const res = projectsResult.value;
    if (res.ok && res.data) creativeProjects = res.data;
    else error = res.message ?? "项目列表加载失败";
  } else {
    error = errorMessage(projectsResult.reason, "项目列表加载失败");
  }

  if (sessionsResult.status === "fulfilled") {
    sessions = sessionsResult.value;
  } else {
    error = error ?? errorMessage(sessionsResult.reason, "会话列表加载失败");
  }

  let activeProjectId = raw.activeProjectId;
  if (activeProjectId && !creativeProjects.some((project) => project.id === activeProjectId)) {
    activeProjectId = null;
    writeStoredActiveProjectId(null);
  }

  raw = { creativeProjects, sessions, activeProjectId, loading: false, error };
  recompute();
}

/** 只切上下文，**不切换会话**（切会话仍由现有 switchSession 负责）。 */
export function selectActiveProject(id: string | null): void {
  if (raw.activeProjectId === id) return;
  writeStoredActiveProjectId(id);
  setRaw({ activeProjectId: id });
}

export async function createProjectAction(title?: string): Promise<string | null> {
  const res = await apiCreateProject(title);
  if (!res.ok || !res.data) {
    setRaw({ error: res.message ?? "新建项目失败" });
    return null;
  }
  const project = res.data;
  raw = { ...raw, creativeProjects: upsertProjectInList(raw.creativeProjects, project), error: null };
  recompute();
  void refreshProjects({ silent: true });
  return project.id;
}

export async function renameProjectAction(id: string, title: string): Promise<void> {
  const res = await apiPatchProject(id, { title });
  if (!res.ok || !res.data) {
    setRaw({ error: res.message ?? "重命名失败" });
    return;
  }
  const project = res.data;
  raw = { ...raw, creativeProjects: upsertProjectInList(raw.creativeProjects, project), error: null };
  recompute();
  void refreshProjects({ silent: true });
}

export async function setProjectArchivedAction(id: string, archived: boolean): Promise<void> {
  const res = await apiPatchProject(id, { archived });
  if (!res.ok || !res.data) {
    setRaw({ error: res.message ?? "归档失败" });
    return;
  }
  const project = res.data;
  raw = { ...raw, creativeProjects: upsertProjectInList(raw.creativeProjects, project), error: null };
  recompute();
  void refreshProjects({ silent: true });
}

/** 把会话挂到项目（upsert）。不给 canvasIds，靠后端口径「没给就保留既有」。 */
export async function attachChatAction(projectId: string, sessionId: string, title?: string): Promise<void> {
  const res = await apiUpsertChat(projectId, title === undefined ? { sessionId } : { sessionId, title });
  if (!res.ok || !res.data) {
    setRaw({ error: res.message ?? "加入项目失败" });
    return;
  }
  const project = res.data;
  raw = { ...raw, creativeProjects: upsertProjectInList(raw.creativeProjects, project), error: null };
  recompute();
  void refreshProjects({ silent: true });
}

/**
 * 把画布挂到会话。既有 canvasIds 从本机已知记录取（会话若当前挂在别的项目也从那里取），
 * 并上新的 canvasId，**绝不覆盖成空**。primaryCanvasId 仅在原本没有时补上，不抢既有主画布。
 */
export async function attachCanvasAction(
  projectId: string,
  sessionId: string,
  canvasId: string,
  title?: string,
): Promise<void> {
  const existing = findChatEntryBySession(sessionId);
  const canvasIds = Array.from(new Set([...(existing?.chat.canvasIds ?? []), canvasId]));
  const chat: {
    sessionId: string;
    title?: string;
    canvasIds: string[];
    primaryCanvasId?: string;
  } = { sessionId, canvasIds };
  if (title !== undefined) chat.title = title;
  if (!existing?.chat.primaryCanvasId) chat.primaryCanvasId = canvasId;

  const res = await apiUpsertChat(projectId, chat);
  if (!res.ok || !res.data) {
    setRaw({ error: res.message ?? "关联画布失败" });
    return;
  }
  const project = res.data;
  raw = { ...raw, creativeProjects: upsertProjectInList(raw.creativeProjects, project), error: null };
  recompute();
  void refreshProjects({ silent: true });
}

export async function removeChatAction(projectId: string, sessionId: string): Promise<void> {
  const res = await apiRemoveChat(projectId, sessionId);
  if (!res.ok || !res.data) {
    setRaw({ error: res.message ?? "移除会话失败" });
    return;
  }
  const project = res.data;
  raw = { ...raw, creativeProjects: upsertProjectInList(raw.creativeProjects, project), error: null };
  recompute();
  void refreshProjects({ silent: true });
}

/**
 * 某个会话挂在哪个项目：**先命中者优先**（按 creativeProjects 数组顺序，即服务端 listProjects 顺序）。
 * 同一 sessionId 被两个项目挂过时取先命中者；archived 项目同样算命中。
 */
export function findProjectIdBySession(sessionId: string): string | null {
  if (!sessionId) return null;
  for (const project of raw.creativeProjects) {
    if (project.chats.some((chat) => chat.sessionId === sessionId)) return project.id;
  }
  return null;
}

/** 仅供自验/热重载：把 store 恢复到初始状态。 */
export function __resetCreativeProjectsStore(): void {
  refreshSeq += 1;
  raw = { creativeProjects: [], sessions: [], activeProjectId: null, loading: false, error: null };
  recompute();
}

// ─────────────────────────────────────────────────────────── hook

export function useCreativeProjects(): CreativeProjectsState & {
  refresh(): Promise<void>;
  selectProject(id: string | null): void;
  createProject(title?: string): Promise<string | null>;
  renameProject(id: string, title: string): Promise<void>;
  setProjectArchived(id: string, archived: boolean): Promise<void>;
  attachChat(projectId: string, sessionId: string, title?: string): Promise<void>;
  attachCanvas(projectId: string, sessionId: string, canvasId: string, title?: string): Promise<void>;
  removeChat(projectId: string, sessionId: string): Promise<void>;
  findProjectIdBySession(sessionId: string): string | null;
  findChatBySession(sessionId: string): { canvasIds: string[]; primaryCanvasId?: string } | null;
} {
  const state = useSyncExternalStore(
    subscribeCreativeProjects,
    getCreativeProjectsSnapshot,
    getCreativeProjectsServerSnapshot,
  );

  // refresh() 只在挂载时跑一次；之后由写操作触发（silent）。不轮询、不 setInterval。
  useEffect(() => {
    void refreshProjects();
  }, []);

  const refresh = useCallback(() => refreshProjects(), []);
  const selectProject = useCallback((id: string | null) => selectActiveProject(id), []);
  const createProject = useCallback((title?: string) => createProjectAction(title), []);
  const renameProject = useCallback((id: string, title: string) => renameProjectAction(id, title), []);
  const setProjectArchived = useCallback((id: string, archived: boolean) => setProjectArchivedAction(id, archived), []);
  const attachChat = useCallback(
    (projectId: string, sessionId: string, title?: string) => attachChatAction(projectId, sessionId, title),
    [],
  );
  const attachCanvas = useCallback(
    (projectId: string, sessionId: string, canvasId: string, title?: string) =>
      attachCanvasAction(projectId, sessionId, canvasId, title),
    [],
  );
  const removeChat = useCallback((projectId: string, sessionId: string) => removeChatAction(projectId, sessionId), []);
  const findProject = useCallback((sessionId: string) => findProjectIdBySession(sessionId), []);
  const findChat = useCallback((sessionId: string) => findChatBySession(sessionId), []);

  return useMemo(
    () => ({
      ...state,
      refresh,
      selectProject,
      createProject,
      renameProject,
      setProjectArchived,
      attachChat,
      attachCanvas,
      removeChat,
      findProjectIdBySession: findProject,
      findChatBySession: findChat,
    }),
    [
      state,
      refresh,
      selectProject,
      createProject,
      renameProject,
      setProjectArchived,
      attachChat,
      attachCanvas,
      removeChat,
      findProject,
      findChat,
    ],
  );
}
