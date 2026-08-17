"use client";

// CanvasLibraryPanel —— 雲端素材庫 + 提示詞庫右側滑入面板。
//
// 兩個 tab：
// - 提示词库：服務端聚合的公共提示詞（GET /api/canvas/prompts）。一次拉全量
//   （服務端 500 上限），搜索（300ms debounce）/ 來源 / 標籤全在客戶端過濾，
//   打字零網絡延遲；卡片可插入畫布、填入當前節點面板、存入個人素材庫。
// - 我的素材：登入用戶的雲端素材（GET /api/canvas/assets）；未登入誠實顯示
//   登入提示，不假裝可用。
//
// 視覺沿用 CanvasNodePromptPanel 的白底/暗色語彙；data-canvas-interactive +
// 事件 stopPropagation 阻止畫布手勢吃掉面板操作；Escape / 關閉鈕收起。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Loader2, RefreshCw, Search, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { authHeaders } from "@/lib/canvas/client";
import type { CanvasAsset } from "@/lib/canvas/asset-store";

export interface CanvasLibraryPanelProps {
  open: boolean;
  onClose: () => void;
  /** 插入文字到畫布（新文本節點） */
  onInsertText: (text: string, title?: string) => void;
  /** 插入圖片到畫布（新圖片節點） */
  onInsertImage: (url: string, title?: string) => void;
  /** 把提示詞直接填進當前打開的節點面板（可選；無則隱藏該按鈕） */
  onUsePrompt?: (prompt: string) => void;
}

type LibraryTab = "prompts" | "assets";

interface LibraryPromptItem {
  id: string;
  title: string;
  prompt: string;
  tags: string[];
  cover?: string;
  source: string;
}

interface LibrarySourceMeta {
  id: string;
  label: string;
  count: number;
}

type PromptSaveState = "saving" | "done" | "error" | "unauthorized";

/** 300ms debounce 的字串值。 */
function useDebouncedValue(value: string, delayMs = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

const INPUT_CLASS =
  "w-full rounded-lg border border-[rgba(0,0,0,0.1)] bg-[rgba(0,0,0,0.03)] py-2 pl-8 pr-3 text-xs outline-none transition-colors focus:border-[#2f80ff] dark:border-[rgba(255,255,255,0.1)] dark:bg-[rgba(255,255,255,0.05)] dark:text-white dark:focus:border-[#5a9bff]";

const SELECT_CLASS =
  "rounded-lg border border-[rgba(0,0,0,0.1)] bg-[rgba(0,0,0,0.03)] px-2 py-1.5 text-xs outline-none dark:border-[rgba(255,255,255,0.1)] dark:bg-[rgba(255,255,255,0.05)] dark:text-white";

const ACTION_BTN_CLASS =
  "rounded-md bg-[rgba(0,0,0,0.05)] px-2 py-1 text-[11px] font-medium text-[rgba(0,0,0,0.65)] transition-colors hover:bg-[rgba(0,0,0,0.1)] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[rgba(255,255,255,0.08)] dark:text-[rgba(255,255,255,0.65)] dark:hover:bg-[rgba(255,255,255,0.14)]";

const PRIMARY_BTN_CLASS =
  "rounded-md bg-black px-2 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-black";

export function CanvasLibraryPanel({ open, onClose, onInsertText, onInsertImage, onUsePrompt }: CanvasLibraryPanelProps) {
  const [tab, setTab] = useState<LibraryTab>("prompts");

  // ── 提示詞庫狀態
  const [promptsData, setPromptsData] = useState<{ prompts: LibraryPromptItem[]; sources: LibrarySourceMeta[] } | null>(null);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [promptsError, setPromptsError] = useState<string | null>(null);
  const [promptQuery, setPromptQuery] = useState("");
  const debouncedPromptQuery = useDebouncedValue(promptQuery);
  const [sourceFilter, setSourceFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [saveStates, setSaveStates] = useState<Record<string, PromptSaveState>>({});

  // ── 我的素材狀態
  const [assets, setAssets] = useState<CanvasAsset[] | null>(null);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [assetsUnauthorized, setAssetsUnauthorized] = useState(false);
  const [assetQuery, setAssetQuery] = useState("");
  const debouncedAssetQuery = useDebouncedValue(assetQuery);
  const [assetKind, setAssetKind] = useState<"" | "text" | "image">("");
  const [assetActionError, setAssetActionError] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // ── Escape 收起
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // ── 提示詞庫載入（首次打開拉一次；重試按鈕再觸發）
  const loadPrompts = useCallback(async () => {
    setPromptsLoading(true);
    setPromptsError(null);
    try {
      const res = await fetch("/api/canvas/prompts");
      const data = (await res.json()) as {
        success?: boolean;
        prompts?: LibraryPromptItem[];
        sources?: LibrarySourceMeta[];
        error?: string;
      };
      if (!res.ok || !data.success || !Array.isArray(data.prompts)) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setPromptsData({ prompts: data.prompts, sources: Array.isArray(data.sources) ? data.sources : [] });
    } catch (error) {
      setPromptsError(error instanceof Error ? error.message : "加载失败");
    } finally {
      setPromptsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && tab === "prompts" && !promptsData && !promptsLoading && !promptsError) {
      void loadPrompts();
    }
  }, [open, tab, promptsData, promptsLoading, promptsError, loadPrompts]);

  // ── 我的素材載入（每次打開/切到該 tab 重新拉，保證存入後可見）
  const loadAssets = useCallback(async () => {
    setAssetsLoading(true);
    setAssetsError(null);
    setAssetActionError(null);
    try {
      const headers = authHeaders();
      if (!headers) {
        // 未登入誠實顯示登入提示，不發註定 401 的請求。
        setAssetsUnauthorized(true);
        setAssets(null);
        return;
      }
      const res = await fetch("/api/canvas/assets", { headers, cache: "no-store" });
      if (res.status === 401) {
        setAssetsUnauthorized(true);
        setAssets(null);
        return;
      }
      const data = (await res.json()) as { success?: boolean; assets?: CanvasAsset[]; error?: string };
      if (!res.ok || !data.success || !Array.isArray(data.assets)) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setAssetsUnauthorized(false);
      setAssets(data.assets);
    } catch (error) {
      setAssetsError(error instanceof Error ? error.message : "加载失败");
    } finally {
      setAssetsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && tab === "assets") void loadAssets();
  }, [open, tab, loadAssets]);

  // ── 提示詞客戶端過濾 + 標籤聚合
  const filteredPrompts = useMemo(() => {
    if (!promptsData) return [];
    const q = debouncedPromptQuery.trim().toLowerCase();
    return promptsData.prompts.filter(
      (p) =>
        (!sourceFilter || p.source === sourceFilter) &&
        (!tagFilter || p.tags.includes(tagFilter)) &&
        (!q || p.title.toLowerCase().includes(q) || p.prompt.toLowerCase().includes(q)),
    );
  }, [promptsData, debouncedPromptQuery, sourceFilter, tagFilter]);

  const tagChips = useMemo(() => {
    if (!promptsData) return [];
    const counts = new Map<string, number>();
    for (const p of promptsData.prompts) {
      for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([t]) => t);
  }, [promptsData]);

  const sourceLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of promptsData?.sources ?? []) map.set(s.id, s.label);
    return map;
  }, [promptsData]);

  // ── 素材客戶端過濾
  const filteredAssets = useMemo(() => {
    if (!assets) return [];
    const q = debouncedAssetQuery.trim().toLowerCase();
    return assets.filter(
      (a) =>
        (!assetKind || a.kind === assetKind) &&
        (!q || a.title.toLowerCase().includes(q) || a.tags.some((tag) => tag.toLowerCase().includes(q))),
    );
  }, [assets, debouncedAssetQuery, assetKind]);

  // ── 動作：提示詞存入素材（deterministic id → 重複點擊 upsert 不會堆重複）
  const saveToAssets = useCallback(async (p: LibraryPromptItem) => {
    setSaveStates((prev) => ({ ...prev, [p.id]: "saving" }));
    try {
      const now = new Date().toISOString();
      const asset: CanvasAsset = {
        id: `prompt-${p.id}`,
        kind: "text",
        title: p.title,
        content: p.prompt,
        tags: p.tags,
        note: `来自提示词库 · ${p.source}`,
        createdAt: now,
        updatedAt: now,
      };
      const res = await fetch("/api/canvas/assets", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(authHeaders() ?? {}) },
        body: JSON.stringify(asset),
      });
      if (res.status === 401) {
        setSaveStates((prev) => ({ ...prev, [p.id]: "unauthorized" }));
        return;
      }
      const data = (await res.json()) as { success?: boolean };
      if (!res.ok || !data.success) throw new Error("save failed");
      setSaveStates((prev) => ({ ...prev, [p.id]: "done" }));
    } catch {
      setSaveStates((prev) => ({ ...prev, [p.id]: "error" }));
    }
  }, []);

  // ── 動作：刪除素材
  const deleteAsset = useCallback(async (id: string) => {
    setDeletingIds((prev) => new Set(prev).add(id));
    setAssetActionError(null);
    try {
      const res = await fetch("/api/canvas/assets", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...(authHeaders() ?? {}) },
        body: JSON.stringify({ ids: [id] }),
      });
      const data = (await res.json()) as { success?: boolean };
      if (!res.ok || !data.success) throw new Error("delete failed");
      setAssets((prev) => (prev ? prev.filter((a) => a.id !== id) : prev));
    } catch {
      setAssetActionError("删除失败，请重试");
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  // ── 動作：複製正文
  const copyContent = useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500);
    } catch {
      setAssetActionError("复制失败，请手动选择文本");
    }
  }, []);

  // 阻止事件冒泡到畫布
  const stopPropagation = useCallback((e: React.MouseEvent | React.TouchEvent | React.PointerEvent) => {
    e.stopPropagation();
  }, []);

  const saveLabel = (state: PromptSaveState | undefined): string => {
    if (state === "saving") return "存入中…";
    if (state === "done") return "已存入";
    if (state === "error") return "存入失败";
    if (state === "unauthorized") return "请先登录";
    return "存入素材";
  };

  return (
    <div
      data-canvas-interactive
      role="dialog"
      aria-label="资源库"
      aria-hidden={!open}
      className={cn(
        "fixed bottom-0 right-0 top-0 z-[90] flex w-[min(360px,92vw)] flex-col border-l border-[rgba(0,0,0,0.08)] bg-white shadow-[-12px_0_32px_rgba(0,0,0,0.12)] transition-transform duration-300 dark:border-[rgba(255,255,255,0.08)] dark:bg-[#1c1c1e]",
        open ? "translate-x-0" : "pointer-events-none translate-x-full",
      )}
      onMouseDown={stopPropagation}
      onTouchStart={stopPropagation}
      onPointerDown={stopPropagation}
      onClick={stopPropagation}
    >
      {/* 頭部 */}
      <div className="flex items-center justify-between border-b border-[rgba(0,0,0,0.06)] px-4 py-3 dark:border-[rgba(255,255,255,0.06)]">
        <h2 className="text-sm font-semibold text-[rgba(0,0,0,0.85)] dark:text-[rgba(255,255,255,0.85)]">资源库</h2>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="flex h-7 w-7 items-center justify-center rounded-md text-[rgba(0,0,0,0.4)] hover:bg-[rgba(0,0,0,0.06)] dark:text-[rgba(255,255,255,0.4)] dark:hover:bg-[rgba(255,255,255,0.08)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* tab 切換 */}
      <div className="flex gap-1 border-b border-[rgba(0,0,0,0.06)] px-3 py-2 dark:border-[rgba(255,255,255,0.06)]">
        {(
          [
            { id: "prompts", label: "提示词库" },
            { id: "assets", label: "我的素材" },
          ] as { id: LibraryTab; label: string }[]
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              tab === t.id
                ? "bg-black text-white dark:bg-white dark:text-black"
                : "text-[rgba(0,0,0,0.55)] hover:bg-[rgba(0,0,0,0.05)] dark:text-[rgba(255,255,255,0.55)] dark:hover:bg-[rgba(255,255,255,0.08)]",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── 提示詞庫 tab */}
      {tab === "prompts" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-2 border-b border-[rgba(0,0,0,0.06)] px-3 py-2.5 dark:border-[rgba(255,255,255,0.06)]">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[rgba(0,0,0,0.3)] dark:text-[rgba(255,255,255,0.3)]" />
                <input
                  value={promptQuery}
                  onChange={(e) => setPromptQuery(e.target.value)}
                  placeholder="搜索提示词…"
                  className={INPUT_CLASS}
                />
              </div>
              <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className={cn(SELECT_CLASS, "max-w-[128px]")}>
                <option value="">全部来源</option>
                {(promptsData?.sources ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}（{s.count}）
                  </option>
                ))}
              </select>
            </div>
            {tagChips.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                {tagChips.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTagFilter((current) => (current === t ? "" : t))}
                    className={cn(
                      "shrink-0 rounded-full px-2.5 py-1 text-[11px] transition-colors",
                      tagFilter === t
                        ? "bg-black text-white dark:bg-white dark:text-black"
                        : "bg-[rgba(0,0,0,0.05)] text-[rgba(0,0,0,0.6)] hover:bg-[rgba(0,0,0,0.1)] dark:bg-[rgba(255,255,255,0.08)] dark:text-[rgba(255,255,255,0.6)]",
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
            {promptsLoading && !promptsData && (
              <>
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-24 animate-pulse rounded-xl bg-[rgba(0,0,0,0.05)] dark:bg-[rgba(255,255,255,0.06)]" />
                ))}
              </>
            )}

            {promptsError && !promptsData && (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <p className="text-xs text-[rgba(0,0,0,0.5)] dark:text-[rgba(255,255,255,0.5)]">加载失败：{promptsError}</p>
                <button type="button" onClick={() => void loadPrompts()} className={cn(ACTION_BTN_CLASS, "flex items-center gap-1")}>
                  <RefreshCw className="h-3 w-3" /> 重试
                </button>
              </div>
            )}

            {promptsData && filteredPrompts.length === 0 && (
              <p className="py-10 text-center text-xs text-[rgba(0,0,0,0.4)] dark:text-[rgba(255,255,255,0.4)]">没有匹配的提示词</p>
            )}

            {filteredPrompts.map((p) => (
              <div
                key={p.id}
                className="rounded-xl border border-[rgba(0,0,0,0.08)] bg-white p-3 dark:border-[rgba(255,255,255,0.08)] dark:bg-[rgba(255,255,255,0.03)]"
              >
                <div className="flex gap-2.5">
                  {p.cover && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.cover}
                      alt={p.title}
                      loading="lazy"
                      draggable={false}
                      className="h-14 w-14 shrink-0 rounded-lg bg-[rgba(0,0,0,0.04)] object-cover dark:bg-[rgba(255,255,255,0.06)]"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="truncate text-[13px] font-medium text-[rgba(0,0,0,0.85)] dark:text-[rgba(255,255,255,0.85)]">{p.title}</p>
                      <span className="shrink-0 rounded-md bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 text-[10px] text-[rgba(0,0,0,0.45)] dark:bg-[rgba(255,255,255,0.08)] dark:text-[rgba(255,255,255,0.45)]">
                        {sourceLabels.get(p.source) ?? p.source}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-[rgba(0,0,0,0.55)] dark:text-[rgba(255,255,255,0.55)]">{p.prompt}</p>
                    {p.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {p.tags.slice(0, 3).map((t) => (
                          <span key={t} className="rounded bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 text-[10px] text-[rgba(0,0,0,0.45)] dark:bg-[rgba(255,255,255,0.06)] dark:text-[rgba(255,255,255,0.45)]">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                  <button type="button" onClick={() => onInsertText(p.prompt, p.title)} className={PRIMARY_BTN_CLASS}>
                    插入画布
                  </button>
                  {onUsePrompt && (
                    <button type="button" onClick={() => onUsePrompt(p.prompt)} className={ACTION_BTN_CLASS}>
                      用到当前节点
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void saveToAssets(p)}
                    disabled={saveStates[p.id] === "saving" || saveStates[p.id] === "done"}
                    className={ACTION_BTN_CLASS}
                  >
                    {saveLabel(saveStates[p.id])}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 我的素材 tab */}
      {tab === "assets" && (
        <div className="flex min-h-0 flex-1 flex-col">
          {assetsUnauthorized ? (
            <p className="py-12 text-center text-xs text-[rgba(0,0,0,0.5)] dark:text-[rgba(255,255,255,0.5)]">登录后可用云端素材库</p>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-[rgba(0,0,0,0.06)] px-3 py-2.5 dark:border-[rgba(255,255,255,0.06)]">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[rgba(0,0,0,0.3)] dark:text-[rgba(255,255,255,0.3)]" />
                  <input
                    value={assetQuery}
                    onChange={(e) => setAssetQuery(e.target.value)}
                    placeholder="搜索素材…"
                    className={INPUT_CLASS}
                  />
                </div>
                <select value={assetKind} onChange={(e) => setAssetKind(e.target.value as "" | "text" | "image")} className={SELECT_CLASS}>
                  <option value="">全部</option>
                  <option value="text">文本</option>
                  <option value="image">图片</option>
                </select>
                {assetsLoading && assets !== null && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[rgba(0,0,0,0.35)] dark:text-[rgba(255,255,255,0.35)]" />}
              </div>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
                {assetActionError && (
                  <p className="rounded-lg bg-[rgba(255,59,48,0.08)] px-2.5 py-1.5 text-[11px] text-[#d93025] dark:text-[#ff6b60]">{assetActionError}</p>
                )}

                {assetsLoading && assets === null && (
                  <>
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="h-20 animate-pulse rounded-xl bg-[rgba(0,0,0,0.05)] dark:bg-[rgba(255,255,255,0.06)]" />
                    ))}
                  </>
                )}

                {assetsError && assets === null && !assetsLoading && (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <p className="text-xs text-[rgba(0,0,0,0.5)] dark:text-[rgba(255,255,255,0.5)]">加载失败：{assetsError}</p>
                    <button type="button" onClick={() => void loadAssets()} className={cn(ACTION_BTN_CLASS, "flex items-center gap-1")}>
                      <RefreshCw className="h-3 w-3" /> 重试
                    </button>
                  </div>
                )}

                {assets !== null && filteredAssets.length === 0 && !assetsLoading && (
                  <p className="py-10 text-center text-xs text-[rgba(0,0,0,0.4)] dark:text-[rgba(255,255,255,0.4)]">
                    {assets.length === 0 ? "还没有素材，从提示词库或画布节点存入" : "没有匹配的素材"}
                  </p>
                )}

                {filteredAssets.map((a) => (
                  <div
                    key={a.id}
                    className="rounded-xl border border-[rgba(0,0,0,0.08)] bg-white p-3 dark:border-[rgba(255,255,255,0.08)] dark:bg-[rgba(255,255,255,0.03)]"
                  >
                    {a.kind === "image" && a.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={a.imageUrl}
                        alt={a.title}
                        loading="lazy"
                        draggable={false}
                        className="mb-2 h-28 w-full rounded-lg bg-[rgba(0,0,0,0.04)] object-cover dark:bg-[rgba(255,255,255,0.06)]"
                      />
                    ) : null}
                    <p className="truncate text-[13px] font-medium text-[rgba(0,0,0,0.85)] dark:text-[rgba(255,255,255,0.85)]">{a.title}</p>
                    {a.kind === "text" && a.content ? (
                      <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed text-[rgba(0,0,0,0.55)] dark:text-[rgba(255,255,255,0.55)]">{a.content}</p>
                    ) : null}
                    {a.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {a.tags.slice(0, 4).map((t) => (
                          <span key={t} className="rounded bg-[rgba(0,0,0,0.04)] px-1.5 py-0.5 text-[10px] text-[rgba(0,0,0,0.45)] dark:bg-[rgba(255,255,255,0.06)] dark:text-[rgba(255,255,255,0.45)]">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="mt-2 flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          a.kind === "image" && a.imageUrl ? onInsertImage(a.imageUrl, a.title) : onInsertText(a.content ?? "", a.title)
                        }
                        className={PRIMARY_BTN_CLASS}
                      >
                        插入画布
                      </button>
                      {a.kind === "text" && (
                        <button
                          type="button"
                          onClick={() => void copyContent(a.id, a.content ?? "")}
                          className={cn(ACTION_BTN_CLASS, "flex items-center gap-1")}
                        >
                          <Copy className="h-3 w-3" />
                          {copiedId === a.id ? "已复制" : "复制"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void deleteAsset(a.id)}
                        disabled={deletingIds.has(a.id)}
                        className={cn(ACTION_BTN_CLASS, "ml-auto flex items-center gap-1")}
                      >
                        {deletingIds.has(a.id) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
