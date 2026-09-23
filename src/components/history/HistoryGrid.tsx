"use client";

import { useEffect, useMemo, useRef } from "react";
import { groupHistoryByDay, inferEntryKind } from "@/lib/history-types";
import type { HistoryEntry } from "@/lib/history-types";
import { HistoryCard } from "./HistoryCard";
import { HistorySkeleton } from "./HistorySkeleton";

/** 记录类型档位；"all" 不过滤。与 HistoryFilterBar 的 Chip 一一对应。 */
export type HistoryEntryKindFilter = "all" | "image" | "video" | "workflow";

export interface HistoryGridProps {
  entries: HistoryEntry[];
  /** 类型档位：只渲染这一类的记录。缺席时不过滤（与接线前逐位元一致）。 */
  entryKindFilter?: HistoryEntryKindFilter;
  selectionMode: boolean;
  selectedIds: Set<string>;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onOpen: (entry: HistoryEntry) => void;
  onToggleSelect: (id: string) => void;
  onToggleStar: (id: string) => void;
  onDownload: (entry: HistoryEntry) => void | Promise<void>;
  onDelete: (id: string) => void;
  onReuse?: (entry: HistoryEntry) => void;
  /** D-18：把这条记录交给 AI 助理继续做。缺席时卡片不挂这颗按钮。 */
  onOpenAgent?: (entry: HistoryEntry) => void;
  /** 再来 N 组 / 微调变体（payload 级批量重跑）。缺席时卡片不挂。 */
  onRerun?: (entry: HistoryEntry) => void;
  onRerunVariant?: (entry: HistoryEntry) => void;
  /** REQ-D1：溯源抽屉入口（与灯箱共用页面级单例抽屉）。 */
  onShowLineage?: (entry: HistoryEntry) => void;
}

export function HistoryGrid({
  entries,
  entryKindFilter = "all",
  selectionMode,
  selectedIds,
  loadingMore,
  hasMore,
  onLoadMore,
  onOpen,
  onToggleSelect,
  onToggleStar,
  onDownload,
  onDelete,
  onReuse,
  onOpenAgent,
  onRerun,
  onRerunVariant,
  onShowLineage,
}: HistoryGridProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  /** 放在 ref 里，这样 observer 不必因为回调变化而反复重建。 */
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  // 滚到底自动加载下一页。
  useEffect(() => {
    if (!hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((item) => item.isIntersecting)) loadMoreRef.current();
      },
      // 提前一屏开始加载，滚动时基本感觉不到等待。
      { rootMargin: "600px 0px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore]);

  // 服务端只对它返回的那批做过查询过滤，而这里还归并了只存在于本机缓存的记录
  // （history-client-store 把 readLocalEntries 直接并进来，不过查询条件）。
  // 所以类型档位必须在渲染前再过一遍，否则「只看工作流」时本地缓存里的图片
  // 记录照样会出现，档位形同虚设。
  const visibleEntries = useMemo(
    () =>
      entryKindFilter === "all"
        ? entries
        : entries.filter((entry) => inferEntryKind(entry) === entryKindFilter),
    [entries, entryKindFilter],
  );

  const groups = groupHistoryByDay(visibleEntries);

  return (
    <div>
      {groups.map((group) => (
        <section key={group.bucket} className="mb-6" aria-label={group.label}>
          <div className="mb-2.5 flex items-baseline gap-2">
            <h2 className="text-ios-subhead font-semibold text-[rgba(0,0,0,0.72)]">{group.label}</h2>
            <span className="text-ios-caption1 tabular-nums text-[rgba(0,0,0,0.58)]">
              {group.entries.length}
            </span>
          </div>

          <div className="hist-masonry">
            {group.entries.map((entry) => (
              <HistoryCard
                key={entry.id}
                entry={entry}
                selectionMode={selectionMode}
                selected={selectedIds.has(entry.id)}
                onOpen={onOpen}
                onToggleSelect={onToggleSelect}
                onToggleStar={onToggleStar}
                onDownload={onDownload}
                onDelete={onDelete}
                {...(onReuse ? { onReuse } : {})}
                {...(onOpenAgent ? { onOpenAgent } : {})}
                {...(onRerun ? { onRerun } : {})}
                {...(onRerunVariant ? { onRerunVariant } : {})}
                {...(onShowLineage ? { onShowLineage } : {})}
              />
            ))}
          </div>
        </section>
      ))}

      {/* 无限滚动哨兵。有下一页时才渲染，否则 observer 会一直空转。 */}
      {hasMore && <div ref={sentinelRef} aria-hidden="true" className="h-px w-full" />}

      {loadingMore && (
        <div className="hist-masonry" role="status" aria-label="正在加载更多">
          <HistorySkeleton count={4} />
        </div>
      )}
    </div>
  );
}
