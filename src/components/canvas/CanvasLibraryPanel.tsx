"use client";

// CanvasLibraryPanel —— 雲端素材庫 + 提示詞庫右側滑入面板。
//
// 三個 tab：
// - 提示词库：服務端聚合的公共提示詞（GET /api/canvas/prompts）。一次拉全量
//   （服務端 500 上限），搜索（300ms debounce）/ 來源 / 標籤全在客戶端過濾，
//   打字零網絡延遲；卡片可插入畫布、填入當前節點面板、存入個人素材庫。
// - 风格库（2026-08-27 自專業工作站 CreatorResourcePanel 遷入）：kunpeng 161 條
//   風格資產 + 2 條提示詞模板，本地靜態數據（src/lib/kunpeng-*），客戶端過濾，
//   動作與提示詞卡對齊（插入畫布 / 填入當前節點 / 存入素材）。
// - 我的素材：登入用戶的資產包（GET /api/assets）；未登入誠實顯示
//   登入提示，不假裝可用。
// - 镜头词库（2026-09-16 G7）：本地静态词库 src/lib/lens-language-library.ts
//   （AID MIT 逐字 142 条 / 12 类）多选插入，走与提示词卡同一对插入回调。
//
// 視覺沿用 CanvasNodePromptPanel 的白底/暗色語彙；data-canvas-interactive +
// 事件 stopPropagation 阻止畫布手勢吃掉面板操作；Escape / 關閉鈕收起。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Search, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { authHeaders } from "@/lib/canvas/client";
import { nodeToAssetPackItems } from "@/lib/canvas/node-to-asset-items";
import type { AssetPack, AssetPackItem } from "@/lib/asset-pack-store";
import {
  KUNPENG_STYLE_ASSETS,
  KUNPENG_STYLE_CATEGORY_LABELS,
  KUNPENG_SOURCE,
  buildKunpengStylePrompt,
  kunpengStyleSummary,
  type KunpengStyleAsset,
} from "@/lib/kunpeng-style-assets";
import {
  KUNPENG_PROMPT_TEMPLATES,
  type KunpengPromptTemplate,
} from "@/lib/kunpeng-prompt-templates";
import { RecipeTemplateSection } from "@/components/canvas-workstation/panels/RecipeTemplateSection";
import { useRecipeTemplates } from "@/components/canvas-workstation/panels/use-recipe-templates";
import { LensPickerSection } from "./LensPickerSection";
import "@/components/canvas-workstation/panels/panels.css";

export interface CanvasLibraryPanelProps {
  open: boolean;
  onClose: () => void;
  /** 插入文字到畫布（新文本節點） */
  onInsertText: (text: string, title?: string) => void;
  /** 插入圖片到畫布（新圖片節點） */
  onInsertImage: (url: string, title?: string) => void;
  /** 把提示詞直接填進當前打開的節點面板（可選；無則隱藏該按鈕） */
  onUsePrompt?: (prompt: string) => void;
  /** 套用配方模板：把六槽配方（prompt 等）攤開進當前節點/輸入（可選；無則隱藏 tab） */
  onApplyRecipeTemplate?: (config: { prompt?: string; contextPrompt?: string; negativePrompt?: string; modelId?: string }, label: string) => void;
  /** 當前登入態（配方模板 tab 的空態提示用） */
  isLoggedIn?: boolean;
}

type LibraryTab = "prompts" | "styles" | "recipes" | "lens" | "assets";

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
  "w-full rounded-lg border border-input bg-black/5 py-2 pl-8 pr-3 text-xs outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ios-blue";

const SELECT_CLASS =
  "rounded-lg border border-input bg-black/5 px-2 py-1.5 text-xs outline-none";

const ACTION_BTN_CLASS =
  "rounded-md bg-black/5 px-2 py-1 text-ios-caption2 font-medium text-muted-foreground transition-colors hover:bg-black/10 disabled:cursor-not-allowed disabled:opacity-50";

const PRIMARY_BTN_CLASS =
  "rounded-md bg-primary px-2 py-1 text-ios-caption2 font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";

/** 畫布素材確定性資產包：id / 標題 固定，upsert 用（見「存入资产包」動作）。 */
const CANVAS_PACK_ID = "canvas-assets";
const CANVAS_PACK_TITLE = "画布素材";

/**
 * 把新 items 併入確定性「画布素材」包（id = CANVAS_PACK_ID）。
 * 讀現有包 → 同內容 prompt 去重 → PUT /api/assets 整包覆蓋。
 */
async function upsertCanvasPack(newItems: AssetPackItem[]): Promise<PromptSaveState> {
  const headers = authHeaders();
  if (!headers) return "unauthorized";
  try {
    const listRes = await fetch("/api/assets", { headers, cache: "no-store" });
    if (listRes.status === 401) return "unauthorized";
    const listData = (await listRes.json().catch(() => null)) as { success?: boolean; packs?: AssetPack[] } | null;
    const existing =
      listData?.success && Array.isArray(listData.packs)
        ? listData.packs.find((p) => p.id === CANVAS_PACK_ID)
        : undefined;
    const existingItems = existing?.items ?? [];
    const seenPrompt = new Set<string>();
    for (const item of existingItems) {
      if (item.kind === "prompt" && item.content) seenPrompt.add(item.content);
    }
    const merged = [...existingItems];
    for (const item of newItems) {
      if (item.kind === "prompt" && item.content && seenPrompt.has(item.content)) continue;
      if (item.kind === "prompt" && item.content) seenPrompt.add(item.content);
      merged.push(item);
    }
    const now = new Date().toISOString();
    const pack: AssetPack = {
      id: CANVAS_PACK_ID,
      title: CANVAS_PACK_TITLE,
      items: merged,
      tags: existing?.tags?.length ? existing.tags : ["画布"],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.active === true ? { active: true } : {}),
    };
    const res = await fetch("/api/assets", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(pack),
    });
    if (res.status === 401) return "unauthorized";
    const data = (await res.json().catch(() => null)) as { success?: boolean } | null;
    if (!res.ok || !data?.success) return "error";
    return "done";
  } catch {
    return "error";
  }
}

export function CanvasLibraryPanel({ open, onClose, onInsertText, onInsertImage, onUsePrompt, onApplyRecipeTemplate, isLoggedIn = false }: CanvasLibraryPanelProps) {
  const [tab, setTab] = useState<LibraryTab>("prompts");

  // ── 配方模板（2026-08-27 自專業工作站遷入：useRecipeTemplates 原樣引用）
  const recipeTemplates = useRecipeTemplates();

  // ── 提示詞庫狀態
  const [promptsData, setPromptsData] = useState<{ prompts: LibraryPromptItem[]; sources: LibrarySourceMeta[] } | null>(null);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [promptsError, setPromptsError] = useState<string | null>(null);
  const [promptQuery, setPromptQuery] = useState("");
  const debouncedPromptQuery = useDebouncedValue(promptQuery);
  const [sourceFilter, setSourceFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [saveStates, setSaveStates] = useState<Record<string, PromptSaveState>>({});

  // ── 风格库狀態（kunpeng 本地靜態數據，純客戶端過濾）
  const [styleQuery, setStyleQuery] = useState("");
  const debouncedStyleQuery = useDebouncedValue(styleQuery);
  const [styleKind, setStyleKind] = useState<"" | "style" | "prompt">("");
  const [styleCategory, setStyleCategory] = useState("");
  const [styleSaveStates, setStyleSaveStates] = useState<Record<string, PromptSaveState>>({});

  // ── 我的素材狀態（資產包視圖）
  const [assets, setAssets] = useState<AssetPack[] | null>(null);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [assetsUnauthorized, setAssetsUnauthorized] = useState(false);
  const [assetQuery, setAssetQuery] = useState("");
  const debouncedAssetQuery = useDebouncedValue(assetQuery);
  const [assetActionError, setAssetActionError] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [activatingId, setActivatingId] = useState<string | null>(null);

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

  // ── 我的素材載入（每次打開/切到該 tab 重新拉，保證存入後可見）。
  // 支援 ?q= 跨 pack 搜尋（title/tags/digest 由服務端過濾，空字串還原為拉全量）。
  const loadAssets = useCallback(async (query = "") => {
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
      const q = query.trim();
      const url = q ? `/api/assets?q=${encodeURIComponent(q)}` : "/api/assets";
      const res = await fetch(url, { headers, cache: "no-store" });
      if (res.status === 401) {
        setAssetsUnauthorized(true);
        setAssets(null);
        return;
      }
      const data = (await res.json()) as { success?: boolean; packs?: AssetPack[]; error?: string };
      if (!res.ok || !data.success || !Array.isArray(data.packs)) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setAssetsUnauthorized(false);
      setAssets(data.packs);
    } catch (error) {
      setAssetsError(error instanceof Error ? error.message : "加载失败");
    } finally {
      setAssetsLoading(false);
    }
  }, []);

  // 搜索词（300ms debounce）变化即按 q 重新拉取；空字串還原為全量。
  useEffect(() => {
    if (open && tab === "assets") void loadAssets(debouncedAssetQuery);
  }, [open, tab, loadAssets, debouncedAssetQuery]);

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

  // ── 风格库客戶端過濾（kunpeng 161 條風格 + 2 條提示詞模板；類別 chips 沿用標籤聚合樣式）
  const filteredStyles = useMemo(() => {
    const q = debouncedStyleQuery.trim().toLowerCase();
    return KUNPENG_STYLE_ASSETS.filter(
      (s) =>
        (!styleKind || styleKind === "style") &&
        (!styleCategory || s.category === styleCategory) &&
        (!q ||
          s.name.toLowerCase().includes(q) ||
          s.promptSuffix.toLowerCase().includes(q) ||
          s.visualDNA.toLowerCase().includes(q)),
    );
  }, [debouncedStyleQuery, styleKind, styleCategory]);

  const filteredPromptTemplates = useMemo(() => {
    if (styleKind !== "prompt") return [];
    const q = debouncedStyleQuery.trim().toLowerCase();
    return KUNPENG_PROMPT_TEMPLATES.filter(
      (t) => !q || t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.body.toLowerCase().includes(q),
    );
  }, [debouncedStyleQuery, styleKind]);

  const styleCategories = useMemo(
    () =>
      KUNPENG_STYLE_CATEGORY_LABELS
        ? Object.entries(KUNPENG_STYLE_CATEGORY_LABELS).map(([id, label]) => ({ id, label }))
        : [],
    [],
  );

  // ── 动作：風格 / 模板存入资产包（確定性包 canvas-assets，同內容 prompt 去重）
  const saveStyleToAssets = useCallback(async (item: { id: string; title: string; text: string; tags: string[]; note: string }) => {
    setStyleSaveStates((prev) => ({ ...prev, [item.id]: "saving" }));
    const state = await upsertCanvasPack(nodeToAssetPackItems({ id: `kunpeng-${item.id}`, title: item.title, prompt: item.text }));
    setStyleSaveStates((prev) => ({ ...prev, [item.id]: state }));
  }, []);

  // ── 資產包客戶端過濾（title / tags / digest）
  const filteredAssets = useMemo(() => {
    if (!assets) return [];
    const q = debouncedAssetQuery.trim().toLowerCase();
    return assets.filter(
      (pack) =>
        !q ||
        pack.title.toLowerCase().includes(q) ||
        pack.tags.some((tag) => tag.toLowerCase().includes(q)) ||
        (pack.digest ?? "").toLowerCase().includes(q),
    );
  }, [assets, debouncedAssetQuery]);

  // ── 動作：提示詞存入资产包（確定性包 canvas-assets）
  const saveToAssets = useCallback(async (p: LibraryPromptItem) => {
    setSaveStates((prev) => ({ ...prev, [p.id]: "saving" }));
    const state = await upsertCanvasPack(nodeToAssetPackItems({ id: `prompt-${p.id}`, title: p.title, prompt: p.prompt }));
    setSaveStates((prev) => ({ ...prev, [p.id]: state }));
  }, []);

  // ── 動作：刪除資產包
  const deleteAsset = useCallback(async (id: string) => {
    setDeletingIds((prev) => new Set(prev).add(id));
    setAssetActionError(null);
    try {
      const res = await fetch("/api/assets", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...(authHeaders() ?? {}) },
        body: JSON.stringify({ ids: [id] }),
      });
      const data = (await res.json()) as { success?: boolean };
      if (!res.ok || !data.success) throw new Error("delete failed");
      setAssets((prev) => (prev ? prev.filter((p) => p.id !== id) : prev));
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

  // ── 動作：設為使用（active）— PUT /api/assets 該包 active:true（單一 active 由後端保證）
  const setPackActive = useCallback(async (pack: AssetPack) => {
    setActivatingId(pack.id);
    setAssetActionError(null);
    try {
      const res = await fetch("/api/assets", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(authHeaders() ?? {}) },
        body: JSON.stringify({ ...pack, active: true }),
      });
      if (res.status === 401) {
        setAssetsUnauthorized(true);
        return;
      }
      const data = (await res.json()) as { success?: boolean };
      if (!res.ok || !data.success) throw new Error("set active failed");
      setAssets((prev) => prev?.map((p) => (p.id === pack.id ? { ...p, active: true } : { ...p, active: undefined })) ?? prev);
    } catch {
      setAssetActionError("设为使用失败，请重试");
    } finally {
      setActivatingId(null);
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
    return "存入资产包";
  };

  return (
    <div
      data-canvas-interactive
      role="dialog"
      aria-label="资源库"
      aria-hidden={!open}
      className={cn(
        "fixed bottom-0 right-0 top-0 z-[90] flex w-[min(360px,92vw)] flex-col lg-sheet transition-transform duration-300",
        open ? "translate-x-0" : "pointer-events-none translate-x-full",
      )}
      onMouseDown={stopPropagation}
      onTouchStart={stopPropagation}
      onPointerDown={stopPropagation}
      onClick={stopPropagation}
    >
      {/* 頭部 */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">资源库</h2>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/45 hover:bg-black/5"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* tab 切換 */}
      <div className="flex gap-1 border-b px-3 py-2">
        {(
          [
            { id: "prompts", label: "提示词库" },
            { id: "styles", label: "风格库" },
            // 镜头词库（2026-09-16 G7）：本地静态词库，与「风格库」同为纯客户端数据。
            { id: "lens", label: "镜头词库" },
            ...(onApplyRecipeTemplate ? [{ id: "recipes" as LibraryTab, label: "配方模板" }] : []),
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
                ? "lg-fill-active text-ios-blue"
                : "text-muted-foreground hover:bg-black/5",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── 提示詞庫 tab */}
      {tab === "prompts" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-2 border-b px-3 py-2.5">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground/45" />
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
                      "shrink-0 rounded-full px-2.5 py-1 text-ios-caption2 transition-colors",
                      tagFilter === t
                        ? "lg-fill-active text-ios-blue"
                        : "bg-black/5 text-muted-foreground hover:bg-black/10",
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
                  <div key={i} className="h-24 animate-pulse rounded-xl bg-black/5" />
                ))}
              </>
            )}

            {promptsError && !promptsData && (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <p className="text-xs text-muted-foreground">加载失败：{promptsError}</p>
                <button type="button" onClick={() => void loadPrompts()} className={cn(ACTION_BTN_CLASS, "flex items-center gap-1")}>
                  <RefreshCw className="h-3 w-3" /> 重试
                </button>
              </div>
            )}

            {promptsData && filteredPrompts.length === 0 && (
              <p className="py-10 text-center text-xs text-foreground/45">没有匹配的提示词</p>
            )}

            {filteredPrompts.map((p) => (
              <div
                key={p.id}
                className="rounded-xl border border-border bg-card p-3"
              >
                <div className="flex gap-2.5">
                  {p.cover && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.cover}
                      alt={p.title}
                      loading="lazy"
                      draggable={false}
                      className="h-14 w-14 shrink-0 rounded-lg bg-black/5 object-cover"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="truncate text-ios-footnote font-medium text-foreground">{p.title}</p>
                      <span className="shrink-0 rounded-md bg-black/5 px-1.5 py-0.5 text-ios-caption2 text-foreground/45">
                        {sourceLabels.get(p.source) ?? p.source}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{p.prompt}</p>
                    {p.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {p.tags.slice(0, 3).map((t) => (
                          <span key={t} className="rounded bg-black/5 px-1.5 py-0.5 text-ios-caption2 text-foreground/45">
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

      {/* ── 风格库 tab（kunpeng 161 條風格 + 提示詞模板，本地數據零網絡） */}
      {tab === "styles" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-2 border-b px-3 py-2.5">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground/45" />
                <input
                  value={styleQuery}
                  onChange={(e) => setStyleQuery(e.target.value)}
                  placeholder="搜索风格…"
                  className={INPUT_CLASS}
                />
              </div>
              <select
                value={styleKind}
                onChange={(e) => setStyleKind(e.target.value as "" | "style" | "prompt")}
                className={cn(SELECT_CLASS, "max-w-[128px]")}
              >
                <option value="">全部</option>
                <option value="style">风格</option>
                <option value="prompt">提示词模板</option>
              </select>
            </div>
            {styleKind !== "prompt" && styleCategories.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                <button
                  type="button"
                  onClick={() => setStyleCategory((current) => (current === "" ? "" : ""))}
                  className={cn(
                    "shrink-0 rounded-full px-2.5 py-1 text-ios-caption2 transition-colors",
                    styleCategory === ""
                      ? "lg-fill-active text-ios-blue"
                      : "bg-black/5 text-muted-foreground hover:bg-black/10",
                  )}
                >
                  全部
                </button>
                {styleCategories.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setStyleCategory((current) => (current === c.id ? "" : c.id))}
                    className={cn(
                      "shrink-0 rounded-full px-2.5 py-1 text-ios-caption2 transition-colors",
                      styleCategory === c.id
                        ? "lg-fill-active text-ios-blue"
                        : "bg-black/5 text-muted-foreground hover:bg-black/10",
                    )}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
            <p className="text-ios-caption2 text-foreground/45">
              来源：{KUNPENG_SOURCE.sourceName}（{KUNPENG_SOURCE.license}）
            </p>
          </div>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
            {filteredPromptTemplates.map((t) => (
              <StyleTemplateCard
                key={t.id}
                title={t.title}
                badge="提示词骨架"
                description={t.description}
                body={t.body}
                tags={[t.engine]}
                footerNote="插入后替换花括号内容即可"
                saveState={styleSaveStates[t.id]}
                onInsert={() => onInsertText(t.body, t.title)}
                onUse={onUsePrompt ? () => onUsePrompt(t.body) : undefined}
                onSave={() => void saveStyleToAssets({ id: t.id, title: t.title, text: t.body, tags: [t.engine], note: `来自鲲鹏提示词模板 · ${t.engine}` })}
              />
            ))}
            {filteredStyles.length === 0 && styleKind !== "prompt" && (
              <p className="py-10 text-center text-xs text-foreground/45">没有匹配的风格</p>
            )}
            {styleKind === "prompt" && filteredPromptTemplates.length === 0 && (
              <p className="py-10 text-center text-xs text-foreground/45">没有匹配的模板</p>
            )}
            {filteredStyles.map((s) => (
              <StyleTemplateCard
                key={s.id}
                title={s.name}
                badge={KUNPENG_STYLE_CATEGORY_LABELS[s.category] ?? s.category}
                description={kunpengStyleSummary(s)}
                body={buildKunpengStylePrompt(s)}
                tags={[KUNPENG_STYLE_CATEGORY_LABELS[s.category] ?? s.category]}
                footerNote="套用后追加到画面描述末尾"
                saveState={styleSaveStates[s.id]}
                onInsert={() => onInsertText(buildKunpengStylePrompt(s), s.name)}
                onUse={onUsePrompt ? () => onUsePrompt(buildKunpengStylePrompt(s)) : undefined}
                onSave={() =>
                  void saveStyleToAssets({
                    id: s.id,
                    title: s.name,
                    text: buildKunpengStylePrompt(s),
                    tags: [KUNPENG_STYLE_CATEGORY_LABELS[s.category] ?? s.category],
                    note: `来自鲲鹏风格库 · ${KUNPENG_STYLE_CATEGORY_LABELS[s.category] ?? s.category}`,
                  })
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* ── 镜头词库 tab（2026-09-16 G7）：本地静态词库多选插入。
          插入通道复用面板本体的 onInsertText / onUsePrompt（与提示词卡同一条路），
          不新增 props、不另造插入机制。 */}
      {tab === "lens" && (
        <LensPickerSection
          onInsertText={onInsertText}
          onUsePrompt={onUsePrompt ? (prompt) => onUsePrompt(prompt) : undefined}
        />
      )}

      {/* ── 配方模板 tab（2026-08-27 自專業工作站遷入：RecipeTemplateSection 原樣掛載） */}
      {tab === "recipes" && onApplyRecipeTemplate && (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <RecipeTemplateSection
            isLoggedIn={isLoggedIn}
            userTemplates={recipeTemplates.items}
            userTemplatesLoading={recipeTemplates.loading}
            onApplyTemplate={(config, label) => onApplyRecipeTemplate(config, label)}
            onDeleteUserTemplate={(id) => void recipeTemplates.deleteTemplate(id)}
          />
        </div>
      )}

      {/* ── 我的素材 tab（資產包視圖：GET /api/assets） */}
      {tab === "assets" && (
        <div className="flex min-h-0 flex-1 flex-col">
          {assetsUnauthorized ? (
            <p className="py-12 text-center text-xs text-muted-foreground">登录后可用云端素材库</p>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b px-3 py-2.5">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground/45" />
                  <input
                    value={assetQuery}
                    onChange={(e) => setAssetQuery(e.target.value)}
                    placeholder="搜索资产包…"
                    className={INPUT_CLASS}
                  />
                </div>
                {assetsLoading && assets !== null && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-foreground/45" />}
              </div>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
                {assetActionError && (
                  <p className="rounded-lg bg-destructive/10 px-2.5 py-1.5 text-ios-caption2 text-destructive">{assetActionError}</p>
                )}

                {assetsLoading && assets === null && (
                  <>
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="h-20 animate-pulse rounded-xl bg-black/5" />
                    ))}
                  </>
                )}

                {assetsError && assets === null && !assetsLoading && (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <p className="text-xs text-muted-foreground">加载失败：{assetsError}</p>
                    <button type="button" onClick={() => void loadAssets()} className={cn(ACTION_BTN_CLASS, "flex items-center gap-1")}>
                      <RefreshCw className="h-3 w-3" /> 重试
                    </button>
                  </div>
                )}

                {assets !== null && filteredAssets.length === 0 && !assetsLoading && (
                  <p className="py-10 text-center text-xs text-foreground/45">
                    {assets.length === 0 ? "还没有资产包，可从历史/聊天/本画布存入" : "没有匹配的资产包"}
                  </p>
                )}

                {filteredAssets.map((pack) => (
                  <div
                    key={pack.id}
                    className="rounded-xl border border-border bg-card p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 truncate text-ios-footnote font-medium text-foreground">{pack.title}</p>
                      {pack.active === true && (
                        <span className="shrink-0 rounded-md bg-black/5 px-1.5 py-0.5 text-ios-caption2 text-ios-blue">使用中</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-ios-caption2 text-foreground/45">{pack.items.length} 项内容</p>
                    {pack.digest ? (
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{pack.digest}</p>
                    ) : null}
                    <div className="mt-2 flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void setPackActive(pack)}
                        disabled={pack.active === true || activatingId === pack.id}
                        className={PRIMARY_BTN_CLASS}
                      >
                        {activatingId === pack.id ? "设置中…" : pack.active === true ? "使用中" : "设为使用"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteAsset(pack.id)}
                        disabled={deletingIds.has(pack.id)}
                        className={cn(ACTION_BTN_CLASS, "ml-auto flex items-center gap-1")}
                      >
                        {deletingIds.has(pack.id) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
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

/** 風格库卡片：與提示詞卡同構（標題 / 徽章 / 描述 / 三動作），複用面板的 class 語彙。 */
function StyleTemplateCard({
  title,
  badge,
  description,
  body,
  tags,
  footerNote,
  saveState,
  onInsert,
  onUse,
  onSave,
}: {
  title: string;
  badge: string;
  description: string;
  body: string;
  tags: string[];
  footerNote: string;
  saveState: PromptSaveState | undefined;
  onInsert: () => void;
  onUse?: () => void;
  onSave: () => void;
}) {
  const saveLabel = (state: PromptSaveState | undefined): string => {
    if (state === "saving") return "存入中…";
    if (state === "done") return "已存入";
    if (state === "error") return "存入失败";
    if (state === "unauthorized") return "请先登录";
    return "存入资产包";
  };
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-ios-footnote font-medium text-foreground">{title}</p>
        <span className="shrink-0 rounded-md bg-black/5 px-1.5 py-0.5 text-ios-caption2 text-foreground/45">{badge}</span>
      </div>
      <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{description}</p>
      <p className="mt-1 line-clamp-2 text-ios-caption2 text-foreground/45">{footerNote}</p>
      {tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {tags.slice(0, 3).map((t) => (
            <span key={t} className="rounded bg-black/5 px-1.5 py-0.5 text-ios-caption2 text-foreground/45">
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <button type="button" onClick={onInsert} className={PRIMARY_BTN_CLASS}>
          插入画布
        </button>
        {onUse && (
          <button type="button" onClick={onUse} className={ACTION_BTN_CLASS}>
            用到当前节点
          </button>
        )}
        <button
          type="button"
          onClick={onSave}
          disabled={saveState === "saving" || saveState === "done"}
          className={ACTION_BTN_CLASS}
        >
          {saveLabel(saveState)}
        </button>
      </div>
      {/* body 供无障碍访问完整文本 */}
      <span className="sr-only">{body}</span>
    </div>
  );
}
