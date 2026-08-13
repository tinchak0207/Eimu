"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import {
  clearHistory,
  dismissHistoryError,
  getHistoryStoreServerState,
  getHistoryStoreState,
  loadHistory,
  loadMoreHistory,
  removeHistoryEntries,
  setHistorySession,
  subscribeHistoryStore,
  toggleHistoryStar,
} from "@/lib/history-client-store";
import type { HistoryQuery } from "@/lib/history-types";

/**
 * 订阅共享的历史 store。
 *
 * /history 页面和工作站侧栏都用这个 hook，因此它们读到的是同一份状态，
 * 在一处收藏或删除，另一处会立刻同步。
 */
export function useHistoryStore() {
  const { user, token, isLoggedIn, isLoading } = useAuth();

  const state = useSyncExternalStore(
    subscribeHistoryStore,
    getHistoryStoreState,
    getHistoryStoreServerState,
  );

  // 账号或令牌变化时重置会话。useAuth 在后台刷新用户信息时会换掉 user 的对象引用，
  // 所以这里只依赖 user.id 而不是 user 本身，避免无谓的重置与重复请求。
  const userId = user?.id ?? null;
  useEffect(() => {
    if (isLoading) return;
    setHistorySession(isLoggedIn ? userId : null, isLoggedIn ? token : null);
  }, [isLoading, isLoggedIn, userId, token]);

  const search = useCallback((query: HistoryQuery) => {
    void loadHistory(query);
  }, []);

  const loadMore = useCallback(() => {
    void loadMoreHistory();
  }, []);

  const toggleStar = useCallback((id: string) => toggleHistoryStar(id), []);
  const remove = useCallback((ids: string[]) => removeHistoryEntries(ids), []);
  const clear = useCallback(() => clearHistory(), []);

  return useMemo(
    () => ({
      ...state,
      isLoggedIn,
      isAuthLoading: isLoading,
      hasMore: state.cursor !== null,
      search,
      loadMore,
      toggleStar,
      remove,
      clear,
      dismissError: dismissHistoryError,
    }),
    [state, isLoggedIn, isLoading, search, loadMore, toggleStar, remove, clear],
  );
}
