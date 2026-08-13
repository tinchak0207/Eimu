"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Clock3, Heart, Maximize2, Search, X } from "lucide-react";
import { getStoredToken, getStoredUser } from "@/lib/new-api-client";
import { cn } from "@/lib/utils";

export interface SelectedLora {
  versionId: string;
  title: string;
  thumb: string;
}

interface LoraItem {
  id: string;
  title: string;
  category: string | null;
  thumb: string;
  versionId: string;
}

interface LoraCatalogResponse {
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  categories: Array<{ id: string; label: string }>;
  items: LoraItem[];
}

interface LoraPreferenceItem {
  versionId: string;
  title: string;
  thumb: string;
  favorite: boolean;
  lastUsedAt?: string;
  updatedAt: string;
}

interface LoraLibraryPanelProps {
  value: SelectedLora | null;
  onChange: (lora: SelectedLora | null) => void;
}

type LoraView = "all" | "favorites" | "recent";

const PAGE_SIZE = 6;

const SORT_OPTIONS = [
  { id: "popular", label: "最受欢迎" },
  { id: "newest", label: "最新发布" },
  { id: "liked", label: "最多收藏" },
];

function asCatalogItem(item: LoraPreferenceItem): LoraItem {
  return {
    id: `saved-${item.versionId}`,
    title: item.title,
    category: null,
    thumb: item.thumb,
    versionId: item.versionId,
  };
}

export function LoraLibraryPanel({ value, onChange }: LoraLibraryPanelProps) {
  const [keywordInput, setKeywordInput] = useState("");
  const [query, setQuery] = useState({ keyword: "", category: "", sort: "popular" });
  const [items, setItems] = useState<LoraItem[]>([]);
  const [categories, setCategories] = useState<Array<{ id: string; label: string }>>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<LoraView>("all");
  const [preferences, setPreferences] = useState<LoraPreferenceItem[]>([]);
  const [previewItem, setPreviewItem] = useState<LoraItem | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const focusFirstItemAfterLoadRef = useRef(false);

  const authHeaders = useCallback((): Record<string, string> | null => {
    const token = getStoredToken();
    const user = getStoredUser();
    if (!token || !user?.id) return null;
    return { Authorization: `Bearer ${token}`, "x-user-id": String(user.id) };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort: query.sort });
    if (query.keyword) params.set("keyword", query.keyword);
    if (query.category) params.set("category", query.category);
    setLoading(true);
    setError("");
    fetch(`/api/lora-models?${params.toString()}`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<LoraCatalogResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setItems(data.items ?? []);
        setCategories(data.categories ?? []);
        setTotal(data.total ?? 0);
      })
      .catch(() => {
        if (!cancelled) {
          focusFirstItemAfterLoadRef.current = false;
          setError("LoRA 模型暂时无法加载，请稍后重试。");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [page, query]);

  useEffect(() => {
    const headers = authHeaders();
    if (!headers) return;
    let cancelled = false;
    fetch("/api/lora-preferences", { headers, cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { data?: { items?: LoraPreferenceItem[] } } | null) => {
        if (!cancelled && payload?.data?.items) setPreferences(payload.data.items);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [authHeaders]);

  useEffect(() => {
    if (loading || !items.length || !focusFirstItemAfterLoadRef.current) return;
    focusFirstItemAfterLoadRef.current = false;
    gridRef.current?.scrollIntoView({ block: "nearest" });
    firstItemRef.current?.focus({ preventScroll: true });
  }, [items, loading]);

  useEffect(() => {
    if (!previewItem) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewItem(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [previewItem]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const changePage = useCallback((nextPage: number) => {
    if (loading || nextPage < 1 || nextPage > pageCount || nextPage === page) return;
    focusFirstItemAfterLoadRef.current = true;
    setPage(nextPage);
  }, [loading, page, pageCount]);

  const preferenceByVersion = useMemo(
    () => new Map(preferences.map((item) => [item.versionId, item])),
    [preferences],
  );

  const visibleItems = useMemo(() => {
    if (view === "all") return items;
    return preferences
      .filter((item) => view === "favorites" ? item.favorite : Boolean(item.lastUsedAt))
      .sort((left, right) => {
        const leftTime = Date.parse(view === "recent" ? left.lastUsedAt ?? left.updatedAt : left.updatedAt);
        const rightTime = Date.parse(view === "recent" ? right.lastUsedAt ?? right.updatedAt : right.updatedAt);
        return rightTime - leftTime;
      })
      .map(asCatalogItem);
  }, [items, preferences, view]);

  const persistPreference = useCallback(async (item: LoraItem, change: { favorite?: boolean; markUsed?: boolean }) => {
    const now = new Date().toISOString();
    setPreferences((current) => {
      const existing = current.find((entry) => entry.versionId === item.versionId);
      const next: LoraPreferenceItem = {
        versionId: item.versionId,
        title: item.title,
        thumb: item.thumb,
        favorite: change.favorite ?? existing?.favorite ?? false,
        ...(change.markUsed ? { lastUsedAt: now } : existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
        updatedAt: now,
      };
      return [next, ...current.filter((entry) => entry.versionId !== item.versionId)];
    });

    const headers = authHeaders();
    if (!headers) return;
    try {
      const response = await fetch("/api/lora-preferences", {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          versionId: item.versionId,
          title: item.title,
          thumb: item.thumb,
          ...change,
        }),
      });
      if (!response.ok) return;
      const payload = await response.json() as { data?: { item?: LoraPreferenceItem } };
      const saved = payload.data?.item;
      if (!saved) return;
      setPreferences((current) => [saved, ...current.filter((entry) => entry.versionId !== item.versionId)]);
    } catch {
      // Keep optimistic local state; the next authenticated load reconciles it.
    }
  }, [authHeaders]);

  const toggleLora = useCallback((item: LoraItem) => {
    if (value?.versionId === item.versionId) {
      onChange(null);
      return;
    }
    onChange({ versionId: item.versionId, title: item.title, thumb: item.thumb });
    void persistPreference(item, { markUsed: true });
  }, [onChange, persistPreference, value]);

  const selectView = (nextView: LoraView) => {
    setView(nextView);
    focusFirstItemAfterLoadRef.current = true;
  };

  return (
    <div id="pro-tour-lora" className="box-border w-full min-w-0 max-w-full space-y-3 overflow-hidden [contain:inline-size]">
      <div className="flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[rgba(0,0,0,0.48)]" />
          <input
            id="pro-tour-lora-search"
            value={keywordInput}
            onChange={(event) => setKeywordInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              setPage(1);
              setView("all");
              setQuery((current) => ({ ...current, keyword: keywordInput.trim() }));
            }}
            placeholder="搜索 LoRA，例如 Genshin、Flat、Anime"
            className="min-h-11 w-full min-w-0 max-w-full rounded-ios-xl border-0 bg-[rgba(255,255,255,0.52)] py-2.5 pl-10 pr-3 text-[14px] font-semibold text-[rgba(0,0,0,0.72)] outline-none ring-0 transition-all placeholder:text-[rgba(0,0,0,0.48)] focus:bg-[rgba(255,255,255,0.72)] focus:ring-2 focus:ring-[rgba(0,122,255,0.22)]"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            setPage(1);
            setView("all");
            setQuery((current) => ({ ...current, keyword: keywordInput.trim() }));
          }}
          className="min-h-11 max-w-[5rem] shrink-0 rounded-ios-xl bg-[rgba(0,122,255,0.12)] px-4 py-2.5 text-[14px] font-bold text-[#007AFF] transition-colors hover:bg-[rgba(0,122,255,0.19)]"
        >
          搜索
        </button>
      </div>

      <div className="flex w-full items-center gap-1 rounded-ios-xl bg-[rgba(255,255,255,0.42)] p-1" role="tablist" aria-label="LoRA 视图">
        <button type="button" role="tab" aria-selected={view === "all"} onClick={() => selectView("all")} className={cn("min-h-10 flex-1 rounded-ios-lg px-2 text-[12px] font-bold", view === "all" ? "bg-white text-[#007AFF] shadow-sm" : "text-[rgba(0,0,0,0.58)]")}>全部</button>
        <button type="button" role="tab" aria-selected={view === "favorites"} onClick={() => selectView("favorites")} className={cn("min-h-10 flex-1 rounded-ios-lg px-2 text-[12px] font-bold", view === "favorites" ? "bg-white text-[#007AFF] shadow-sm" : "text-[rgba(0,0,0,0.58)]")}>
          收藏{preferences.some((item) => item.favorite) ? ` ${preferences.filter((item) => item.favorite).length}` : ""}
        </button>
        <button type="button" role="tab" aria-selected={view === "recent"} onClick={() => selectView("recent")} className={cn("flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-ios-lg px-2 text-[12px] font-bold", view === "recent" ? "bg-white text-[#007AFF] shadow-sm" : "text-[rgba(0,0,0,0.58)]")}>
          <Clock3 className="h-3.5 w-3.5" />最近使用
        </button>
      </div>

      {view === "all" && (
        <div className="flex w-full min-w-0 max-w-full flex-wrap items-center gap-1.5 overflow-hidden">
          {categories.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => {
                  setPage(1);
                  setQuery((current) => ({ ...current, category: "" }));
                }}
                className={cn(
                  "min-h-10 rounded-full px-3 py-2 text-[12px] font-bold transition-colors",
                  query.category === "" ? "bg-[rgba(0,122,255,0.14)] text-[#007AFF]" : "bg-[rgba(255,255,255,0.46)] text-[rgba(0,0,0,0.58)]",
                )}
              >
                全部
              </button>
              {categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => {
                    setPage(1);
                    setQuery((current) => ({ ...current, category: category.id }));
                  }}
                  className={cn(
                    "min-h-10 rounded-full px-3 py-2 text-[12px] font-bold transition-colors",
                    query.category === category.id ? "bg-[rgba(0,122,255,0.14)] text-[#007AFF]" : "bg-[rgba(255,255,255,0.46)] text-[rgba(0,0,0,0.58)]",
                  )}
                >
                  {category.label}
                </button>
              ))}
            </>
          )}
          <select
            id="pro-tour-lora-sort"
            value={query.sort}
            onChange={(event) => {
              setPage(1);
              setQuery((current) => ({ ...current, sort: event.target.value }));
            }}
            aria-label="LoRA 排序"
            className="ml-auto min-h-10 max-w-full rounded-full border-0 bg-[rgba(255,255,255,0.52)] px-3 py-2 text-[12px] font-bold text-[rgba(0,0,0,0.64)] outline-none"
          >
            {SORT_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </div>
      )}

      {value && (
        <div className="flex w-full min-w-0 max-w-full items-center gap-3 overflow-hidden rounded-ios-2xl bg-[rgba(0,122,255,0.11)] px-3 py-2.5 ring-1 ring-[rgba(0,122,255,0.12)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value.thumb} alt="" className="h-12 w-12 shrink-0 rounded-ios-xl object-cover" />
          <span className="pro-lora-selected-title min-w-0 flex-1 text-[14px] font-bold leading-[1.35] text-[rgba(0,0,0,0.76)]">{value.title}</span>
          <button type="button" onClick={() => onChange(null)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[rgba(255,255,255,0.7)] text-[rgba(0,0,0,0.58)]" title="移除 LoRA">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {error && view === "all" ? <p className="text-[14px] font-semibold text-[#FF3B30]">{error}</p> : null}

      {loading && view === "all" ? (
        <div className="pro-lora-card-grid grid w-full min-w-0 max-w-full gap-2.5 overflow-hidden">
          {Array.from({ length: PAGE_SIZE }).map((_, index) => <div key={index} className="aspect-square animate-pulse rounded-ios-xl bg-[rgba(0,0,0,0.06)]" />)}
        </div>
      ) : visibleItems.length ? (
        <>
          <div ref={gridRef} id="pro-tour-lora-grid" className="pro-lora-card-grid grid w-full min-w-0 max-w-full gap-2.5 overflow-hidden">
            {visibleItems.map((item, index) => {
              const favorite = preferenceByVersion.get(item.versionId)?.favorite === true;
              return (
                <div key={item.id} className={cn("group relative aspect-square overflow-hidden rounded-ios-2xl bg-[rgba(255,255,255,0.58)] ring-1 ring-white/70", value?.versionId === item.versionId && "ring-[3px] ring-[#007AFF]")}>
                  <button ref={index === 0 ? firstItemRef : undefined} type="button" onClick={() => toggleLora(item)} onDoubleClick={() => setPreviewItem(item)} title={`${item.title} · 单击选择，双击预览`} className="absolute inset-0 h-full w-full text-left">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.thumb} alt={item.title} className="h-full w-full object-cover" loading="lazy" />
                    <span className="pro-lora-card-title absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-[rgba(0,0,0,0.62)] to-transparent px-3 pb-2.5 pt-12 text-left text-[14px] font-bold leading-[1.3] text-white">{item.title}</span>
                    {value?.versionId === item.versionId ? <span className="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-full bg-[#007AFF] font-bold text-white">✓</span> : null}
                  </button>
                  <button type="button" aria-label={favorite ? `取消收藏 ${item.title}` : `收藏 ${item.title}`} title={favorite ? "取消收藏" : "收藏"} onClick={() => void persistPreference(item, { favorite: !favorite })} className={cn("absolute left-2.5 top-2.5 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-md", favorite && "bg-[#FF2D55]")}>
                    <Heart className={cn("h-4 w-4", favorite && "fill-current")} />
                  </button>
                  <button type="button" aria-label={`大图预览 ${item.title}`} title="大图预览" onClick={() => setPreviewItem(item)} className="absolute bottom-2.5 right-2.5 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-md">
                    <Maximize2 className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
          {view === "all" && pageCount > 1 ? (
            <nav className="flex min-h-10 items-center justify-center gap-3" aria-label="LoRA 分页">
              <button type="button" onClick={() => changePage(page - 1)} disabled={page <= 1} className="flex h-10 w-10 items-center justify-center rounded-full bg-white/60 text-[rgba(0,0,0,0.64)] disabled:opacity-30" title="上一页" aria-label="上一页"><ChevronLeft className="h-[18px] w-[18px]" /></button>
              <span className="min-w-16 text-center text-[14px] font-bold text-[rgba(0,0,0,0.58)]" aria-live="polite">{page} / {pageCount}</span>
              <button type="button" onClick={() => changePage(page + 1)} disabled={page >= pageCount} className="flex h-10 w-10 items-center justify-center rounded-full bg-white/60 text-[rgba(0,0,0,0.64)] disabled:opacity-30" title="下一页" aria-label="下一页"><ChevronRight className="h-[18px] w-[18px]" /></button>
            </nav>
          ) : null}
        </>
      ) : (
        <p className="py-6 text-center text-[14px] font-semibold text-[rgba(0,0,0,0.48)]">
          {view === "favorites" ? "还没有收藏 LoRA" : view === "recent" ? "还没有使用记录" : "没有找到 LoRA 模型"}
        </p>
      )}

      {previewItem ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 p-4 backdrop-blur-xl" role="dialog" aria-modal="true" aria-label={`预览 ${previewItem.title}`} onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewItem(null); }}>
          <div className="relative flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-ios-3xl bg-[rgba(248,248,250,0.96)] shadow-2xl">
            <button type="button" onClick={() => setPreviewItem(null)} className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white" aria-label="关闭预览"><X className="h-5 w-5" /></button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewItem.thumb} alt={previewItem.title} className="min-h-0 w-full flex-1 object-contain" />
            <div className="flex flex-wrap items-center gap-3 border-t border-black/10 px-4 py-3">
              <strong className="min-w-0 flex-1 text-[16px] text-[rgba(0,0,0,0.82)]">{previewItem.title}</strong>
              <button type="button" onClick={() => void persistPreference(previewItem, { favorite: !preferenceByVersion.get(previewItem.versionId)?.favorite })} className="flex min-h-11 items-center gap-2 rounded-ios-xl bg-[rgba(255,45,85,0.11)] px-4 text-[14px] font-bold text-[#D91E48]">
                <Heart className={cn("h-4 w-4", preferenceByVersion.get(previewItem.versionId)?.favorite && "fill-current")} />
                {preferenceByVersion.get(previewItem.versionId)?.favorite ? "已收藏" : "收藏"}
              </button>
              <button type="button" onClick={() => { toggleLora(previewItem); setPreviewItem(null); }} className="min-h-11 rounded-ios-xl bg-[#007AFF] px-5 text-[14px] font-bold text-white">
                {value?.versionId === previewItem.versionId ? "取消选择" : "使用这个 LoRA"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
