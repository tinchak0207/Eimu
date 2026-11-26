"use client";

/**
 * 「我的记忆」管理面：看见助理记住了你什么，并且完全由你说了算。
 *
 * - 记忆总开关（使用记忆）与自动记录开关（自动记录新记忆）：对应网关 memory_use／memory_generate；
 * - 列表：搜索、手动新增、就地编辑、逐条删除（二次确认）、清空全部（二次确认）、导出 JSON；
 * - 历史对话索引：显示已索引的会话数，一键清空（只清检索索引，不删对话本身）。
 * 删除是硬删：后端把正文、历史世代、目录、索引一并抹掉，不是「标记失效」。
 * 外壳与「我的技能」同一套 lg-sheet portal 配方（避开 canvas 面板的 overflow／堆叠脉络）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getAgentSettings,
  saveAgentSettings,
  tryAuthHeaders,
  type AgentSettings,
} from "@/lib/agent/agent-chat-client";

interface MemoryRow {
  id: string;
  description: string;
  body: string;
  domain: string;
  source: "user" | "agent";
  updatedAt: string;
}

interface HistoryStatus {
  sessions: number;
  turns: number;
  available: boolean;
}

const INPUT_CLASS =
  "w-full rounded-lg border border-input bg-black/5 px-2.5 py-1.5 text-ios-caption1 outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ios-blue";

const ERROR_TEXT: Record<string, string> = {
  invalid_description: "标题请控制在 120 字以内，且不能换行。",
  invalid_body: "内容不能为空，且不超过 2000 字。",
  quota_exceeded: "记忆条数到上限了（200 条），请先删掉一些。",
  not_found: "这条记忆已经不存在了。",
  unauthorized: "请先登录后再管理记忆。",
};

function humanizeError(code: string | undefined): string {
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
  if (code?.startsWith("sensitive_content")) return "内容里像是含有密码或密钥，出于安全不会被记住。请去掉后再保存。";
  return "操作没成功，请稍后重试。";
}

function parseMemories(payload: unknown): MemoryRow[] {
  const list = (payload as { memories?: unknown })?.memories;
  if (!Array.isArray(list)) return [];
  const rows: MemoryRow[] = [];
  for (const item of list) {
    const r = item as Record<string, unknown>;
    if (typeof r?.id !== "string" || typeof r.description !== "string") continue;
    rows.push({
      id: r.id,
      description: r.description,
      body: typeof r.body === "string" ? r.body : "",
      domain: typeof r.domain === "string" ? r.domain : "",
      source: r.source === "user" ? "user" : "agent",
      updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
    });
  }
  return rows;
}

function dayLabel(iso: string): string {
  return iso ? iso.slice(0, 10) : "";
}

function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex h-11 w-11 shrink-0 cursor-pointer items-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className={cn("relative h-6 w-11 rounded-full transition-colors", checked ? "bg-ios-blue" : "bg-black/15")}>
        <span className={cn("absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform", checked ? "left-6" : "left-1")} />
      </span>
    </button>
  );
}

export function MyMemoriesDialog({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<MemoryRow[] | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState<"memories" | "history" | null>(null);
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [history, setHistory] = useState<HistoryStatus | null>(null);
  const aliveRef = useRef(true);

  const authedFetch = useCallback(async (path: string, init: RequestInit = {}): Promise<Response | null> => {
    const headers = tryAuthHeaders();
    if (!headers) {
      setLoggedOut(true);
      return null;
    }
    const res = await fetch(path, {
      cache: "no-store",
      ...init,
      headers: { ...headers, accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
    });
    if (res.status === 401) {
      setLoggedOut(true);
      return null;
    }
    return res;
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await authedFetch("/api/agent/memory/mine");
      if (!aliveRef.current) return;
      if (!res) {
        setRows([]);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      setRows(parseMemories(await res.json()));
    } catch {
      if (!aliveRef.current) return;
      setRows([]);
      setError("记忆读取失败，请稍后重试。");
    }
  }, [authedFetch]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await authedFetch("/api/agent/memory/mine/history");
      if (!res || !res.ok || !aliveRef.current) return;
      const data = (await res.json()) as Partial<HistoryStatus>;
      setHistory({ sessions: Number(data.sessions ?? 0), turns: Number(data.turns ?? 0), available: data.available !== false });
    } catch {
      /* 状态拿不到只是不显示这一行 */
    }
  }, [authedFetch]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    void loadHistory();
    void getAgentSettings().then((res) => {
      if (aliveRef.current && res.ok) setSettings(res.settings);
    });
    return () => {
      aliveRef.current = false;
    };
  }, [load, loadHistory]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const toggle = useCallback(
    (patch: Partial<AgentSettings>) => {
      if (!settings) return;
      const before = settings;
      setSettings({ ...before, ...patch });
      void saveAgentSettings(patch).then((res) => {
        if (!aliveRef.current) return;
        if (res.ok) setSettings(res.settings);
        else {
          setSettings(before);
          setError("开关保存失败，未生效。");
        }
      });
    },
    [settings],
  );

  const addMemory = useCallback(async () => {
    const text = draft.trim();
    if (!text || adding) return;
    setAdding(true);
    setError(null);
    try {
      const res = await authedFetch("/api/agent/memory/mine", {
        method: "POST",
        body: JSON.stringify({ description: text.replace(/\s+/g, " ").slice(0, 120), body: text }),
      });
      if (!res) return;
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(humanizeError(data.error));
        return;
      }
      setDraft("");
      await load();
    } catch {
      setError(humanizeError(undefined));
    } finally {
      if (aliveRef.current) setAdding(false);
    }
  }, [adding, authedFetch, draft, load]);

  const saveEdit = useCallback(
    async (row: MemoryRow) => {
      const text = editText.trim();
      if (!text) return;
      setBusyId(row.id);
      setError(null);
      try {
        const res = await authedFetch(`/api/agent/memory/mine/${encodeURIComponent(row.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ description: text.replace(/\s+/g, " ").slice(0, 120), body: text }),
        });
        if (!res) return;
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(humanizeError(data.error));
          return;
        }
        setEditId(null);
        await load();
      } catch {
        setError(humanizeError(undefined));
      } finally {
        if (aliveRef.current) setBusyId(null);
      }
    },
    [authedFetch, editText, load],
  );

  const remove = useCallback(
    async (row: MemoryRow) => {
      setBusyId(row.id);
      setError(null);
      try {
        const res = await authedFetch(`/api/agent/memory/mine/${encodeURIComponent(row.id)}`, { method: "DELETE" });
        if (!res) return;
        if (!res.ok && res.status !== 404) {
          setError(humanizeError(undefined));
          return;
        }
        setConfirmId(null);
        await load();
      } catch {
        setError(humanizeError(undefined));
      } finally {
        if (aliveRef.current) setBusyId(null);
      }
    },
    [authedFetch, load],
  );

  const clearAll = useCallback(
    async (kind: "memories" | "history") => {
      setBusyId(kind);
      setError(null);
      try {
        const path = kind === "memories" ? "/api/agent/memory/mine?confirm=all" : "/api/agent/memory/mine/history";
        const res = await authedFetch(path, { method: "DELETE" });
        if (!res) return;
        if (!res.ok) {
          setError(humanizeError(undefined));
          return;
        }
        setConfirmClear(null);
        await (kind === "memories" ? load() : loadHistory());
      } catch {
        setError(humanizeError(undefined));
      } finally {
        if (aliveRef.current) setBusyId(null);
      }
    },
    [authedFetch, load, loadHistory],
  );

  const exportAll = useCallback(async () => {
    try {
      const res = await authedFetch("/api/agent/memory/mine/export");
      if (!res || !res.ok) {
        if (res) setError(humanizeError(undefined));
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "eimu-memories.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(humanizeError(undefined));
    }
  }, [authedFetch]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!rows) return [];
    if (!q) return rows;
    return rows.filter((r) => `${r.description} ${r.body}`.toLowerCase().includes(q));
  }, [rows, query]);

  const linkBtn =
    "cursor-pointer rounded-full px-2 py-0.5 text-ios-caption1 font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30";

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="我的记忆"
      data-my-memories-dialog="true"
    >
      <button type="button" aria-label="关闭我的记忆" onClick={onClose} className="absolute inset-0 cursor-default bg-black/25 backdrop-blur-[2px]" />
      <div className="lg-sheet relative flex max-h-[min(86dvh,44rem)] w-full max-w-md flex-col overflow-hidden rounded-ios-2xl p-1">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
        <div className="flex shrink-0 items-center justify-between gap-2 px-2.5 pt-2 pb-1.5">
          <span className="text-ios-footnote font-medium text-foreground">我的记忆</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground/45 transition-colors hover:bg-black/5 hover:text-foreground/75 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        <div className="agent-scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-2">
          {loggedOut ? (
            <p className="py-3 text-ios-caption1 leading-relaxed text-foreground/55">登录后可以查看和管理助理记住的内容</p>
          ) : (
            <>
              <div className="divide-y divide-black/[0.06]">
                <div className="flex items-center justify-between gap-3 py-1">
                  <div className="min-w-0">
                    <div className="text-ios-footnote font-medium text-foreground">使用记忆</div>
                    <p className="text-ios-caption2 leading-relaxed text-foreground/45">关闭后，助理不再参考任何记忆和历史对话</p>
                  </div>
                  <Switch label="使用记忆" checked={settings?.memory_use !== false} disabled={!settings} onChange={(v) => toggle({ memory_use: v })} />
                </div>
                <div className="flex items-center justify-between gap-3 py-1">
                  <div className="min-w-0">
                    <div className="text-ios-footnote font-medium text-foreground">自动记录新记忆</div>
                    <p className="text-ios-caption2 leading-relaxed text-foreground/45">关闭后，不再从对话里生成新记忆，已有的保留</p>
                  </div>
                  <Switch label="自动记录新记忆" checked={settings?.memory_generate !== false} disabled={!settings} onChange={(v) => toggle({ memory_generate: v })} />
                </div>
              </div>

              <div className="mt-2 flex items-start gap-1.5">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={2}
                  maxLength={2000}
                  placeholder="告诉助理一件要长期记住的事，例如：我的品牌叫青禾茶舍，主色是松针绿"
                  aria-label="新增记忆"
                  className={cn(INPUT_CLASS, "resize-none")}
                />
                <button
                  type="button"
                  onClick={() => void addMemory()}
                  disabled={!draft.trim() || adding}
                  aria-label="添加记忆"
                  className="flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-lg bg-ios-blue px-2.5 text-ios-caption1 font-medium text-white transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
                  添加
                </button>
              </div>

              {error && <p className="mt-1.5 text-ios-caption2 leading-relaxed text-ios-red">{error}</p>}

              <div className="mt-2.5 flex items-center justify-between gap-2">
                <span className="text-ios-caption1 font-medium text-foreground/60">
                  已记住 {rows ? rows.length : "…"} 条
                </span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索"
                  aria-label="搜索记忆"
                  className={cn(INPUT_CLASS, "w-28")}
                />
              </div>

              <ul className="mt-1.5 flex flex-col">
                {rows === null && (
                  <li className="flex items-center gap-2 py-3 text-ios-caption1 text-foreground/45">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    读取中
                  </li>
                )}
                {rows !== null && rows.length === 0 && (
                  <li className="py-3 text-ios-caption1 leading-relaxed text-foreground/55">
                    还没有记忆。聊天里告诉助理“记住……”，或在上面直接添加，它们会出现在这里。
                  </li>
                )}
                {rows !== null && rows.length > 0 && shown.length === 0 && (
                  <li className="py-3 text-ios-caption1 text-foreground/55">没有匹配的记忆</li>
                )}
                {shown.map((row) => {
                  const editing = editId === row.id;
                  const busy = busyId === row.id;
                  return (
                    <li key={row.id} className="border-t border-black/[0.06] py-2 first:border-t-0" data-memory-id={row.id}>
                      {editing ? (
                        <div className="flex flex-col gap-1.5">
                          <textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            rows={3}
                            maxLength={2000}
                            aria-label="编辑记忆"
                            className={cn(INPUT_CLASS, "resize-none")}
                          />
                          <div className="flex justify-end gap-1">
                            <button type="button" onClick={() => setEditId(null)} className={cn(linkBtn, "text-foreground/55 hover:bg-black/5")}>取消</button>
                            <button type="button" onClick={() => void saveEdit(row)} disabled={busy || !editText.trim()} className={cn(linkBtn, "text-ios-blue hover:bg-ios-blue/10 disabled:opacity-40")}>
                              {busy ? "保存中" : "保存"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-start justify-between gap-2">
                            <p className="min-w-0 break-words text-ios-footnote leading-snug text-foreground">{row.body || row.description}</p>
                            <div className="flex shrink-0 items-center">
                              <button
                                type="button"
                                aria-label="编辑这条记忆"
                                onClick={() => {
                                  setEditId(row.id);
                                  setEditText(row.body || row.description);
                                  setConfirmId(null);
                                }}
                                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-foreground/45 transition-colors hover:bg-black/5 hover:text-foreground/75 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
                              >
                                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                aria-label="删除这条记忆"
                                onClick={() => setConfirmId(confirmId === row.id ? null : row.id)}
                                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-foreground/45 transition-colors hover:bg-black/5 hover:text-ios-red focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                            </div>
                          </div>
                          <p className="mt-0.5 text-ios-caption2 text-foreground/40">
                            {row.source === "user" ? "你添加" : "助理记录"} · {dayLabel(row.updatedAt)}
                          </p>
                          {confirmId === row.id && (
                            <div className="mt-1 flex items-center justify-between gap-2 rounded-lg bg-ios-red/5 px-2 py-1">
                              <span className="text-ios-caption2 text-foreground/65">彻底删除后无法恢复，助理也不会再想起</span>
                              <div className="flex shrink-0 gap-1">
                                <button type="button" onClick={() => setConfirmId(null)} className={cn(linkBtn, "text-foreground/55 hover:bg-black/5")}>取消</button>
                                <button type="button" onClick={() => void remove(row)} disabled={busy} className={cn(linkBtn, "text-ios-red hover:bg-ios-red/10 disabled:opacity-40")}>
                                  {busy ? "删除中" : "删除"}
                                </button>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>

              <div className="mt-2 divide-y divide-black/[0.06] border-t border-black/[0.06]">
                <div className="flex items-center justify-between gap-2 py-2">
                  <span className="text-ios-caption1 text-foreground/55">下载全部记忆（JSON）</span>
                  <button type="button" onClick={() => void exportAll()} className={cn(linkBtn, "flex items-center gap-1 text-ios-blue hover:bg-ios-blue/10")}>
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    导出
                  </button>
                </div>
                {history?.available && (
                  <div className="py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-ios-caption1 text-foreground/55">
                        已为 {history.sessions} 个对话建立检索，用于“上次我们聊过……”
                      </span>
                      <button
                        type="button"
                        onClick={() => setConfirmClear(confirmClear === "history" ? null : "history")}
                        disabled={history.turns === 0}
                        className={cn(linkBtn, "shrink-0 text-ios-red hover:bg-ios-red/10 disabled:opacity-40")}
                      >
                        清空
                      </button>
                    </div>
                    {confirmClear === "history" && (
                      <div className="mt-1 flex items-center justify-between gap-2 rounded-lg bg-ios-red/5 px-2 py-1">
                        <span className="text-ios-caption2 text-foreground/65">只清检索索引，对话本身不会被删除</span>
                        <div className="flex shrink-0 gap-1">
                          <button type="button" onClick={() => setConfirmClear(null)} className={cn(linkBtn, "text-foreground/55 hover:bg-black/5")}>取消</button>
                          <button type="button" onClick={() => void clearAll("history")} disabled={busyId === "history"} className={cn(linkBtn, "text-ios-red hover:bg-ios-red/10 disabled:opacity-40")}>
                            {busyId === "history" ? "清空中" : "确认清空"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div className="py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-ios-caption1 text-foreground/55">清空全部记忆</span>
                    <button
                      type="button"
                      onClick={() => setConfirmClear(confirmClear === "memories" ? null : "memories")}
                      disabled={!rows || rows.length === 0}
                      className={cn(linkBtn, "text-ios-red hover:bg-ios-red/10 disabled:opacity-40")}
                    >
                      清空
                    </button>
                  </div>
                  {confirmClear === "memories" && (
                    <div className="mt-1 flex items-center justify-between gap-2 rounded-lg bg-ios-red/5 px-2 py-1">
                      <span className="text-ios-caption2 text-foreground/65">将彻底删除全部 {rows?.length ?? 0} 条记忆，无法恢复</span>
                      <div className="flex shrink-0 gap-1">
                        <button type="button" onClick={() => setConfirmClear(null)} className={cn(linkBtn, "text-foreground/55 hover:bg-black/5")}>取消</button>
                        <button type="button" onClick={() => void clearAll("memories")} disabled={busyId === "memories"} className={cn(linkBtn, "text-ios-red hover:bg-ios-red/10 disabled:opacity-40")}>
                          {busyId === "memories" ? "清空中" : "确认清空"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
