"use client";

// REQ-D1 資產血統「溯源」抽屜：逐級鏈面板（每級＝類型＋時間＋縮圖或一行描述＋可點擊跳轉）。
//
// 界面裁決對齊（09-22 暴君四刀④）：入口在資產卡與生成歷史卡的「溯源」鈕，
// 展開右側鏈條面板；默認展開 3 層＋「繼續向上」；畫布不畫血統邊。
// 兩態誠實（③）：「來源不明」＝本體沒有血統登記；「已刪除」＝登記了把手但池查無。
// 池加載不完整的降級：查無只標「查無（本頁範圍）」，絕把加載失敗誤報成已刪除。
//
// 面板風格復用歷史頁既有語法（SaveCardDialog 同款）：lg-sheet 玻璃面板 + iOS 字級/圓角。
//
// 文案紀律：本元件零硬編用戶可見字串，全部經 `text()` 取自 src/lib/ui-strings.ts
// （守門件 src/lib/ui-strings.test.ts 去註解後禁 CJK）。lineage.ts 的中文類型標籤、
// history-types.ts 的相對時間、節點 label 都是上游資料，原樣顯示。
//
// 本元件不得殘留硬編用戶可見字串。

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Ban, ChevronDown, CornerUpLeft, GitBranch, HelpCircle, ShieldAlert, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { text, type UiStringKey } from "@/lib/ui-strings";
import { formatRelativeTime } from "@/lib/history-types";
import { loadLineagePool } from "@/lib/lineage-view";
import type { LineagePoolLoadResult } from "@/lib/lineage-view";
import {
  LINEAGE_DEFAULT_DEPTH,
  LINEAGE_DEPTH_STEP,
  LINEAGE_KIND_LABEL,
  buildLineageTree,
} from "@/lib/lineage";
import type { LineageRecordView, LineageTreeNode } from "@/lib/lineage";

export interface LineageDrawerProps {
  /** 正在看的那條記錄（歷史卡或資產卡適配後的視圖）。 */
  host: LineageRecordView;
  /** 宿主類型文案（"生成记录" / "资产卡"），標題行顯示。 */
  hostKindLabel: string;
  onClose: () => void;
  /**
   * 逐級跳轉：宿主能把該記錄打開到自己的視圖（歷史頁開灯箱）時返回 true 並由宿主關閉抽屜。
   * 返回 false（例如卡記錄在歷史頁沒有落點）時抽屜就地鉆入該級鏈條。
   */
  onJump?: (view: LineageRecordView) => boolean;
}

/** 節點行從根到葉的縮進（px）；三層鏈在 320px 面板裡仍可掃讀。 */
const ROW_INDENT_PX = 14;

/** 「繼續向上」的硬頂：12 層之後的病態鏈用「更深鏈條未展開」收口，不給無限按鈕。 */
const MAX_VISIBLE_DEPTH = 12;

function nodeKindLabel(node: LineageTreeNode): string {
  return node.link ? LINEAGE_KIND_LABEL[node.link.kind] : text("lineage.kind.root");
}

/** 狀態徽章：話術鍵（文字只在 ui-strings.ts 一處），池不完整時「查無」不得說成「已刪除」。 */
function statusBadgeOf(node: LineageTreeNode, poolComplete: boolean): { key: UiStringKey; tone: "muted" | "amber" | "neutral" } | null {
  switch (node.status) {
    case "deleted":
      // 池不完整時不得把「加載失敗／範圍外」說成「已刪除」。
      return poolComplete
        ? { key: "lineage.status.deleted", tone: "amber" }
        : { key: "lineage.status.unscanned", tone: "muted" };
    case "unknown-origin":
      return { key: "lineage.status.unknownOrigin", tone: "muted" };
    case "self":
      return { key: "lineage.status.self", tone: "neutral" };
    case "cycle":
      return { key: "lineage.status.cycle", tone: "neutral" };
    case "pruned":
      return { key: "lineage.status.pruned", tone: "muted" };
    default:
      return null;
  }
}

function statusIcon(node: LineageTreeNode) {
  switch (node.status) {
    case "deleted":
      return Trash2;
    case "unknown-origin":
      return HelpCircle;
    case "pruned":
      return ChevronDown;
    default:
      return Ban;
  }
}

function LineageRow({
  node,
  poolComplete,
  canDrill,
  onOpenNode,
}: {
  node: LineageTreeNode;
  poolComplete: boolean;
  canDrill: boolean;
  onOpenNode: (node: LineageTreeNode) => void;
}) {
  const badge = statusBadgeOf(node, poolComplete);
  const jumpable = Boolean(node.jumpTo) && node.status !== "deleted";
  return (
    <li className="flex gap-2 py-2" style={{ paddingLeft: node.depth * ROW_INDENT_PX }} data-lineage-depth={node.depth}>
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/5">
        {node.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={node.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <GitBranch className="h-3.5 w-3.5 text-[rgba(0,0,0,0.35)]" aria-hidden="true" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 text-ios-footnote text-foreground">
          <span className="shrink-0 rounded-full bg-[rgba(0,122,255,0.10)] px-1.5 py-0.5 text-ios-caption1 font-medium text-[#007AFF]">
            {nodeKindLabel(node)}
          </span>
          <span className="min-w-0 flex-1 truncate">{node.label || text("common.noDescription")}</span>
          {node.timeMs !== null && (
            <time dateTime={new Date(node.timeMs).toISOString()} className="shrink-0 text-ios-caption1 text-foreground/45">
              {formatRelativeTime(node.timeMs)}
            </time>
          )}
        </p>
        {badge && (
          <p className={cn("mt-0.5 flex items-center gap-1 text-ios-caption1", badge.tone === "amber" ? "text-[#B26A00]" : "text-foreground/45")}>
            {(() => {
              const Icon = statusIcon(node);
              return <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />;
            })()}
            {text(badge.key)}
          </p>
        )}
        {node.truncated && (
          <p className="mt-0.5 text-ios-caption1 text-foreground/45">{text("lineage.truncated")}</p>
        )}
      </div>
      {jumpable && (canDrill || node.depth > 0) && (
        <button
          type="button"
          onClick={() => onOpenNode(node)}
          aria-label={node.link ? text("lineage.openSource") : text("lineage.openRecord")}
          title={text("lineage.jumpTitle")}
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.45)] transition-colors hover:bg-black/5 hover:text-[#007AFF] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
        >
          <CornerUpLeft className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  );
}

export function LineageDrawer({ host, hostKindLabel, onClose, onJump }: LineageDrawerProps) {
  const [mounted, setMounted] = useState(false);
  const titleId = useId();
  const [visibleDepth, setVisibleDepth] = useState(LINEAGE_DEFAULT_DEPTH);
  /** 鉆入棧：末尾為當前鏈條的根（宿主記錄在 index 0）。 */
  const [rootStack, setRootStack] = useState<LineageRecordView[]>([host]);
  const [poolState, setPoolState] = useState<{ status: "loading" | "ready"; data: LineagePoolLoadResult | null }>({
    status: "loading",
    data: null,
  });
  const closedRef = useRef(false);

  useEffect(() => setMounted(true), []);
  // host 變化（換卡重開）重置鉆入與深度。
  useEffect(() => {
    setRootStack([host]);
    setVisibleDepth(LINEAGE_DEFAULT_DEPTH);
  }, [host]);

  useEffect(() => {
    let cancelled = false;
    void loadLineagePool().then((data) => {
      if (!cancelled) setPoolState({ status: "ready", data });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const currentRoot = rootStack[rootStack.length - 1];
  const pool = poolState.data?.pool;
  const built = useMemo(
    () => (pool ? buildLineageTree(currentRoot, pool, { maxDepth: visibleDepth }) : null),
    [pool, currentRoot, visibleDepth],
  );
  const rows = useMemo(() => (built ? collectVisibleRows(built.tree) : []), [built]);
  const hasDeeper = rows.some((row) => row.status === "pruned" && row.jumpTo);
  const poolComplete = poolState.status === "ready"
    && poolState.data?.historyLoaded === true
    && poolState.data?.cardsLoaded === true;

  const openNode = useCallback((node: LineageTreeNode) => {
    if (!pool || !node.jumpTo) return;
    const view = pool.find(node.jumpTo.jobId, node.jumpTo.assetId);
    if (!view) return;
    if (onJump?.(view)) return; // 宿主已把視圖帶到該記錄，抽屜由宿主負責關閉。
    setRootStack((stack) => [...stack, view]);
  }, [pool, onJump]);

  const backOneLevel = useCallback(() => {
    setRootStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack));
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50" role="presentation">
      <div className="absolute inset-0 bg-[rgba(31,34,48,0.45)] backdrop-blur-md" onClick={onClose} />
      <aside
        aria-modal="true"
        aria-labelledby={titleId}
        className="lg-sheet absolute inset-y-0 right-0 flex w-full max-w-sm flex-col rounded-l-ios-2xl p-0"
      >
        <header className="flex items-start justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <p id={titleId} className="flex items-center gap-1.5 text-ios-subhead font-semibold text-foreground">
              <GitBranch className="h-4 w-4 text-[rgba(0,0,0,0.44)]" />
              {text("lineage.title", { hostKind: hostKindLabel })}
            </p>
            <p className="mt-1 truncate text-ios-footnote text-[rgba(0,0,0,0.55)]" title={currentRoot.label}>
              {currentRoot.label}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {rootStack.length > 1 && (
              <button
                type="button"
                onClick={backOneLevel}
                aria-label={text("lineage.back")}
                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.44)] hover:bg-black/5 focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label={text("common.close")}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.44)] transition-colors hover:bg-black/5 hover:text-[rgba(0,0,0,0.72)] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
          {poolState.status === "loading" && (
            <p className="py-6 text-center text-ios-footnote text-foreground/45">{text("lineage.loading")}</p>
          )}
          {poolState.status === "ready" && built && !built.rootHasLineage && (
            <div className="my-3 flex items-start gap-2 rounded-ios-xl bg-[rgba(0,0,0,0.04)] px-3 py-2.5">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[rgba(0,0,0,0.44)]" />
              <p className="text-ios-footnote leading-snug text-[rgba(0,0,0,0.62)]">{text("lineage.noLineage")}</p>
            </div>
          )}
          {poolState.status === "ready" && built && (
            <ol className="divide-y divide-black/5">
              {rows.map((row, index) => (
                <LineageRow
                  key={`${row.status}-${row.depth}-${index}-${row.link?.jobId ?? row.link?.assetId ?? "root"}`}
                  node={row}
                  poolComplete={poolComplete}
                  canDrill={Boolean(pool && row.jumpTo && pool.find(row.jumpTo.jobId, row.jumpTo.assetId))}
                  onOpenNode={openNode}
                />
              ))}
            </ol>
          )}
        </div>

        <footer className="border-t px-5 py-3">
          {hasDeeper && visibleDepth < MAX_VISIBLE_DEPTH ? (
            <button
              type="button"
              onClick={() => setVisibleDepth((depth) => Math.min(MAX_VISIBLE_DEPTH, depth + LINEAGE_DEPTH_STEP))}
              className="w-full cursor-pointer rounded-ios-xl bg-[rgba(0,122,255,0.10)] px-4 py-2.5 text-ios-footnote font-medium text-[#007AFF] transition-colors hover:bg-[rgba(0,122,255,0.16)] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
            >
              {text("lineage.expandMore", { depth: visibleDepth })}
            </button>
          ) : (
            <p className="text-ios-caption1 text-foreground/40">
              {poolState.status === "ready" && !poolComplete
                ? text("lineage.footerPartial")
                : text("lineage.footerDefault", { depth: LINEAGE_DEFAULT_DEPTH })}
            </p>
          )}
        </footer>
      </aside>
    </div>,
    document.body,
  );
}

/** 前序展平（不插入佔位行——深度限制由 buildLineageTree 的 pruned 節點誠實表達）。 */
export function collectVisibleRows(tree: LineageTreeNode): LineageTreeNode[] {
  const rows: LineageTreeNode[] = [];
  const walk = (node: LineageTreeNode) => {
    rows.push(node);
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return rows;
}
