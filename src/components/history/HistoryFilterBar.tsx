"use client";

import { useEffect, useState } from "react";
import { Filter, Image as ImageIcon, Search, Star, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { HistoryFacets, HistoryQuery } from "@/lib/history-types";

export interface HistoryFilterBarProps {
  query: HistoryQuery;
  facets: HistoryFacets | null;
  total: number;
  onChange: (query: HistoryQuery) => void;
}

/**
 * 筛选胶囊。复用站内统一的 .style-chip 语言（36px、真实描边、浅蓝 tint 选中态），
 * 不再自成一套实心蓝填充——那套视觉和画质/风格/模型选择器不是同一个控件家族，
 * 放在同一个产品里会让「胶囊」看起来像三种不同的按钮。
 */
function Chip({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn("style-chip", active && "active")}
    >
      {children}
      {count !== undefined && (
        <span className={cn("tabular-nums", active ? "text-[rgba(0,122,255,0.62)]" : "text-[rgba(0,0,0,0.58)]")}>
          {count}
        </span>
      )}
    </button>
  );
}

export function HistoryFilterBar({ query, facets, total, onChange }: HistoryFilterBarProps) {
  const [keyword, setKeyword] = useState(query.keyword ?? "");
  const [expanded, setExpanded] = useState(false);

  // 外部（比如从 URL 恢复）改了关键词时同步到输入框。
  useEffect(() => {
    setKeyword(query.keyword ?? "");
  }, [query.keyword]);

  // 输入防抖，避免每敲一个字就打一次请求。
  useEffect(() => {
    const current = query.keyword ?? "";
    if (keyword === current) return;

    const timer = setTimeout(() => {
      onChange({ ...query, ...(keyword ? { keyword } : { keyword: undefined }) });
    }, 320);
    return () => clearTimeout(timer);
  }, [keyword, query, onChange]);

  const patch = (next: Partial<HistoryQuery>) => onChange({ ...query, ...next });

  const activeFilters =
    (query.modelId ? 1 : 0) +
    (query.imageSize ? 1 : 0) +
    (query.starredOnly ? 1 : 0) +
    (query.withImageOnly ? 1 : 0);

  const hasAnyFilter = activeFilters > 0 || Boolean(query.keyword);
  const hasFacetOptions = Boolean(facets && (facets.models.length > 1 || facets.imageSizes.length > 1));

  return (
    <div className="mb-4 space-y-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[rgba(0,0,0,0.44)]" />
          <input
            type="search"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索提示词或模型…"
            aria-label="搜索历史记录"
            className="w-full rounded-ios-xl border-0 bg-[rgba(0,0,0,0.05)] py-2.5 pl-9 pr-9 text-ios-footnote text-[rgba(0,0,0,0.85)] placeholder:text-[rgba(0,0,0,0.46)] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)] [background-image:none]"
          />
          {keyword && (
            <button
              type="button"
              onClick={() => setKeyword("")}
              aria-label="清除搜索"
              className="absolute right-2.5 top-1/2 flex h-6 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.44)] transition-colors hover:bg-[rgba(0,0,0,0.06)] hover:text-[rgba(0,0,0,0.62)] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {hasFacetOptions && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label="更多筛选"
            className={cn(
              "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-ios-xl px-3.5 py-2.5",
              "text-ios-footnote font-medium transition-all duration-200",
              "focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]",
              expanded || activeFilters
                ? "bg-[rgba(0,122,255,0.12)] text-[#007AFF]"
                : "bg-[rgba(0,0,0,0.05)] text-[rgba(0,0,0,0.62)] hover:bg-[rgba(0,0,0,0.09)]",
            )}
          >
            <Filter className="h-3.5 w-3.5" />
            筛选
            {activeFilters > 0 && <span className="tabular-nums">{activeFilters}</span>}
          </button>
        )}
      </div>

      {/* 常用开关始终可见 */}
      <div className="flex flex-wrap items-center gap-2">
        <Chip
          active={Boolean(query.starredOnly)}
          onClick={() => patch({ starredOnly: query.starredOnly ? undefined : true })}
          count={facets?.starredCount}
        >
          <Star className="h-3.5 w-3.5" fill={query.starredOnly ? "currentColor" : "none"} />
          收藏
        </Chip>
        <Chip
          active={Boolean(query.withImageOnly)}
          onClick={() => patch({ withImageOnly: query.withImageOnly ? undefined : true })}
          count={facets?.withImageCount}
        >
          <ImageIcon className="h-3.5 w-3.5" />
          有图
        </Chip>

        {hasAnyFilter && (
          <button
            type="button"
            onClick={() => onChange({})}
            className="ml-auto shrink-0 cursor-pointer rounded-full px-2.5 py-1.5 text-ios-footnote text-[rgba(0,0,0,0.58)] transition-colors hover:text-[rgba(0,0,0,0.85)] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
          >
            清除筛选
          </button>
        )}
      </div>

      {/* 分面筛选 */}
      {expanded && facets && (
        <div className="space-y-2.5 rounded-ios-2xl bg-[rgba(0,0,0,0.025)] p-3">
          {facets.models.length > 1 && (
            <div>
              <p className="mb-1.5 text-ios-caption1 font-medium text-[rgba(0,0,0,0.58)]">模型</p>
              <div className="flex flex-wrap gap-1.5">
                {facets.models.map((bucket) => (
                  <Chip
                    key={bucket.value}
                    active={query.modelId === bucket.value}
                    count={bucket.count}
                    onClick={() =>
                      patch({ modelId: query.modelId === bucket.value ? undefined : bucket.value })
                    }
                  >
                    {bucket.label}
                  </Chip>
                ))}
              </div>
            </div>
          )}

          {facets.imageSizes.length > 1 && (
            <div>
              <p className="mb-1.5 text-ios-caption1 font-medium text-[rgba(0,0,0,0.58)]">尺寸</p>
              <div className="flex flex-wrap gap-1.5">
                {facets.imageSizes.map((bucket) => (
                  <Chip
                    key={bucket.value}
                    active={query.imageSize === bucket.value}
                    count={bucket.count}
                    onClick={() =>
                      patch({ imageSize: query.imageSize === bucket.value ? undefined : bucket.value })
                    }
                  >
                    {bucket.label}
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <p className="text-ios-caption1 text-[rgba(0,0,0,0.58)]" aria-live="polite">
        {hasAnyFilter ? `筛选出 ${total} 条` : `共 ${total} 条`}
      </p>
    </div>
  );
}
