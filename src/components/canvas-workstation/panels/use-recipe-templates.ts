"use client";

/**
 * 用户配方模板的客户端读写（模板捕获器 + 我的模板列表共用）。
 *
 * 数据面：/api/recipe-templates（GET/POST/DELETE，登录用户）。
 * 鉴权沿用 LoraLibraryPanel 同款 getStoredToken/getStoredUser 头；
 * 未登录时列表保持空、保存动作由调用方引导登录，不在 hook 里造第二套鉴权。
 */

import { useCallback, useEffect, useState } from "react";
import { getStoredToken, getStoredUser } from "@/lib/new-api-client";
import type { WorkflowRecallConfig } from "@/lib/workflow-recall";

/** 契约扩展点：modelId 为可选扩展字段（向后兼容，无此字段的旧模板照常载入）。 */
export type UserRecipeConfig = WorkflowRecallConfig & { modelId?: string };

export interface UserRecipeTemplateItem {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  config: UserRecipeConfig;
}

function authHeaders(): Record<string, string> | null {
  const token = getStoredToken();
  const user = getStoredUser();
  if (!token || !user?.id) return null;
  return { Authorization: `Bearer ${token}`, "x-user-id": String(user.id) };
}

export function useRecipeTemplates() {
  const [items, setItems] = useState<UserRecipeTemplateItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const headers = authHeaders();
    if (!headers) {
      setItems([]);
      setLoading(false);
      return;
    }
    try {
      const response = await fetch("/api/recipe-templates", { headers, cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as { data?: { items?: UserRecipeTemplateItem[] } };
      setItems(Array.isArray(payload.data?.items) ? payload.data!.items! : []);
    } catch {
      // 读失败保持现状：列表为空比报错横幅更不打断创作流
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveTemplate = useCallback(async (input: {
    name: string;
    config: unknown;
  }): Promise<{ ok: true; item: UserRecipeTemplateItem } | { ok: false; message: string }> => {
    const headers = authHeaders();
    if (!headers) return { ok: false, message: "请先登录后再保存模板。" };
    try {
      const response = await fetch("/api/recipe-templates", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: input.name, config: input.config }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { success?: boolean; data?: { item?: UserRecipeTemplateItem }; message?: string }
        | null;
      if (!response.ok || !payload?.success || !payload.data?.item) {
        return { ok: false, message: payload?.message ?? "模板保存失败，请稍后再试。" };
      }
      await refresh();
      return { ok: true, item: payload.data.item };
    } catch {
      return { ok: false, message: "模板保存请求失败，请检查网络。" };
    }
  }, [refresh]);

  const deleteTemplate = useCallback(async (id: string): Promise<boolean> => {
    const headers = authHeaders();
    if (!headers) return false;
    try {
      const response = await fetch(`/api/recipe-templates?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers,
      });
      if (!response.ok) return false;
      await refresh();
      return true;
    } catch {
      return false;
    }
  }, [refresh]);

  return { items, loading, refresh, saveTemplate, deleteTemplate };
}
