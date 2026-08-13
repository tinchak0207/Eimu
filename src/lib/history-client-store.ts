"use client";

// 生成历史的客户端共享 store。
//
// /history 页面和专业工作站的历史侧栏读的是同一份状态，所以在工作站里收藏一张图，
// 另一个已打开的历史页会立刻跟着变，反之亦然。
//
// 设计要点：
//   - 单一模块级 store + useSyncExternalStore，不引入新依赖；
//   - 服务端记录与 localStorage 缓存在读取时归并，本地记录不会因为服务端还没落盘而消失；
//   - 收藏和删除都是乐观更新，失败自动回滚并把错误交给调用方展示；
//   - 每次查询变更都会取消上一次在途请求，避免慢响应覆盖新结果。

import {
  HISTORY_PAGE_SIZE,
  mergeHistoryEntries,
  normalizeHistoryEntry,
  sortHistoryEntries,
} from "./history-types";
import type { HistoryEntry, HistoryFacets, HistoryQuery } from "./history-types";
import { readGenerationCache, selectPersistedHistoryForUser } from "./generation-cache";
import {
  clearStoredHistory,
  deleteStoredHistoryEntries,
  fetchHistoryPage,
  patchStoredHistoryEntry,
} from "./new-api-client";
import type { PersistedGenerationEntry } from "./generation-cache";

export interface HistoryStoreState {
  entries: HistoryEntry[];
  facets: HistoryFacets | null;
  query: HistoryQuery;
  cursor: string | null;
  total: number;
  /** 首屏加载中。翻页用 loadingMore 区分，避免整页被骨架屏顶掉。 */
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /** 已经完成过至少一次加载，用于区分「还没开始」和「确实是空的」。 */
  loaded: boolean;
}

const EMPTY_STATE: HistoryStoreState = {
  entries: [],
  facets: null,
  query: {},
  cursor: null,
  total: 0,
  loading: false,
  loadingMore: false,
  error: null,
  loaded: false,
};

let state: HistoryStoreState = EMPTY_STATE;
const listeners = new Set<() => void>();

/** 当前会话上下文。切换账号会清空 store。 */
let activeUserId: number | null = null;
let activeToken: string | null = null;

/** 在途请求控制器，用于取消被新查询取代的旧请求。 */
let inflight: AbortController | null = null;

/** 递增的请求序号：只有最新一次请求的结果会被采纳。 */
let requestSeq = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<HistoryStoreState>): void {
  state = { ...state, ...patch };
  emit();
}

export function subscribeHistoryStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getHistoryStoreState(): HistoryStoreState {
  return state;
}

/** 服务端渲染时的快照。必须是稳定引用，否则 useSyncExternalStore 会报无限循环。 */
export function getHistoryStoreServerState(): HistoryStoreState {
  return EMPTY_STATE;
}

// ─────────────────────────────────────────────────────────── 本地缓存

/** 把 localStorage 里的记录转成统一模型。这些记录没有图（base64 在写入前就被剥掉了）。 */
function readLocalEntries(userId: number): HistoryEntry[] {
  try {
    const cached: PersistedGenerationEntry[] = selectPersistedHistoryForUser(readGenerationCache(), userId);
    return cached.flatMap((item) => {
      const normalized = normalizeHistoryEntry(item, "local");
      return normalized ? [normalized] : [];
    });
  } catch {
    // 缓存损坏不该让历史页打不开。
    return [];
  }
}

// ─────────────────────────────────────────────────────────── 加载

function abortInflight(): void {
  if (inflight) {
    inflight.abort();
    inflight = null;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/**
 * 加载首屏。查询条件变化时调用。
 * 会取消上一次在途请求，并把本地缓存归并进结果。
 */
export async function loadHistory(query: HistoryQuery = state.query): Promise<void> {
  if (!activeToken || activeUserId === null) return;

  abortInflight();
  const controller = new AbortController();
  inflight = controller;
  const seq = ++requestSeq;

  setState({ query, loading: true, error: null });

  try {
    const response = await fetchHistoryPage(activeToken, query, {
      pageSize: HISTORY_PAGE_SIZE,
      facets: true,
      signal: controller.signal,
    });

    if (seq !== requestSeq) return; // 已被更新的查询取代

    if (!response.success || !response.data) {
      setState({ loading: false, loaded: true, error: response.message ?? "历史记录加载失败。" });
      return;
    }

    const serverEntries = response.data.entries.flatMap((item) => {
      const normalized = normalizeHistoryEntry(item, "server");
      return normalized ? [normalized] : [];
    });

    setState({
      entries: mergeHistoryEntries(serverEntries, readLocalEntries(activeUserId)),
      facets: response.facets ?? null,
      cursor: response.data.cursor,
      total: response.data.total,
      loading: false,
      loaded: true,
      error: null,
    });
  } catch (error) {
    if (isAbortError(error) || seq !== requestSeq) return;
    setState({ loading: false, loaded: true, error: errorMessage(error, "网络异常，请稍后重试。") });
  } finally {
    if (inflight === controller) inflight = null;
  }
}

/** 加载下一页并追加。已经到底或正在加载时是空操作。 */
export async function loadMoreHistory(): Promise<void> {
  if (!activeToken || activeUserId === null) return;
  if (!state.cursor || state.loading || state.loadingMore) return;

  const cursor = state.cursor;
  const seq = requestSeq;
  setState({ loadingMore: true });

  try {
    const response = await fetchHistoryPage(activeToken, state.query, {
      cursor,
      pageSize: HISTORY_PAGE_SIZE,
    });

    // 期间发生过一次首屏重载：这一页已经过期，丢弃。
    if (seq !== requestSeq) return;

    if (!response.success || !response.data) {
      setState({ loadingMore: false, error: response.message ?? "加载更多失败。" });
      return;
    }

    const more = response.data.entries.flatMap((item) => {
      const normalized = normalizeHistoryEntry(item, "server");
      return normalized ? [normalized] : [];
    });

    setState({
      entries: mergeHistoryEntries(state.entries, more),
      cursor: response.data.cursor,
      total: response.data.total,
      loadingMore: false,
    });
  } catch (error) {
    if (isAbortError(error) || seq !== requestSeq) return;
    setState({ loadingMore: false, error: errorMessage(error, "加载更多失败。") });
  }
}

// ─────────────────────────────────────────────────────────── 变更

/**
 * 切换收藏。乐观更新，失败回滚。
 * 返回是否成功，方便调用方决定要不要提示。
 */
export async function toggleHistoryStar(id: string): Promise<boolean> {
  if (!activeToken) return false;

  const target = state.entries.find((entry) => entry.id === id);
  if (!target) return false;

  const next = !target.starred;
  const rollback = state.entries;

  setState({
    entries: state.entries.map((entry) => (entry.id === id ? { ...entry, starred: next } : entry)),
    error: null,
  });

  try {
    const response = await patchStoredHistoryEntry(activeToken, id, { starred: next });
    if (!response.success) {
      // 只回滚这一条，期间其他条目的变更不该被一起撤销。
      setState({
        entries: state.entries.map((entry) =>
          entry.id === id ? (rollback.find((item) => item.id === id) ?? entry) : entry,
        ),
        error: response.message ?? "收藏失败。",
      });
      return false;
    }
    return true;
  } catch (error) {
    setState({
      entries: state.entries.map((entry) =>
        entry.id === id ? (rollback.find((item) => item.id === id) ?? entry) : entry,
      ),
      error: errorMessage(error, "收藏失败。"),
    });
    return false;
  }
}

/** 删除若干条。乐观移除，失败把它们放回原位。 */
export async function removeHistoryEntries(ids: string[]): Promise<boolean> {
  if (!activeToken || !ids.length) return false;

  const targets = new Set(ids);
  const removed = state.entries.filter((entry) => targets.has(entry.id));
  if (!removed.length) return false;

  setState({
    entries: state.entries.filter((entry) => !targets.has(entry.id)),
    total: Math.max(0, state.total - removed.length),
    error: null,
  });

  /**
   * 把乐观移除的记录放回去。
   * 期间可能已经有新的一页把同一条带回来了，所以按 id 去重，避免出现两张一样的卡片。
   */
  const restore = (message: string) => {
    const present = new Set(state.entries.map((entry) => entry.id));
    const missing = removed.filter((entry) => !present.has(entry.id));
    setState({
      entries: sortHistoryEntries([...state.entries, ...missing], "newest"),
      total: state.total + missing.length,
      error: message,
    });
  };

  try {
    const response = await deleteStoredHistoryEntries(activeToken, ids);
    if (!response.success) {
      restore(response.message ?? "删除失败。");
      return false;
    }
    return true;
  } catch (error) {
    restore(errorMessage(error, "删除失败。"));
    return false;
  }
}

/** 清空全部历史。这个操作不做乐观更新 —— 代价太大，宁可等服务端确认。 */
export async function clearHistory(): Promise<boolean> {
  if (!activeToken) return false;

  setState({ loading: true, error: null });
  try {
    const response = await clearStoredHistory(activeToken);
    if (!response.success) {
      setState({ loading: false, error: response.message ?? "清空失败。" });
      return false;
    }
    setState({ entries: [], cursor: null, total: 0, loading: false, facets: null });
    return true;
  } catch (error) {
    setState({ loading: false, error: errorMessage(error, "清空失败。") });
    return false;
  }
}

/** 手动清除错误提示。 */
export function dismissHistoryError(): void {
  if (state.error) setState({ error: null });
}

// ─────────────────────────────────────────────────────────── 会话

/**
 * 绑定当前会话。账号或令牌变化时重置 store 并重新加载。
 * 传 null 表示退出登录。
 */
export function setHistorySession(userId: number | null, token: string | null): void {
  if (activeUserId === userId && activeToken === token) return;

  abortInflight();
  requestSeq += 1;
  activeUserId = userId;
  activeToken = token;

  if (userId === null || !token) {
    state = EMPTY_STATE;
    emit();
    return;
  }

  // 先用本地缓存把首屏填上，服务端数据到了再覆盖 —— 避免登录后短暂空白。
  state = { ...EMPTY_STATE, entries: readLocalEntries(userId) };
  emit();
}

/** 仅供测试与热重载使用：把 store 恢复到初始状态。 */
export function __resetHistoryStore(): void {
  abortInflight();
  requestSeq += 1;
  activeUserId = null;
  activeToken = null;
  state = EMPTY_STATE;
  listeners.clear();
}
