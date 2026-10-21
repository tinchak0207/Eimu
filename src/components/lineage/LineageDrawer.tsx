"use client";

// REQ-D1 资产血统「溯源」抽屉：逐级链面板（每级＝类型＋时间＋缩图或一行描述＋可点击跳转）。
//
// 界面裁决对齐（09-22 暴君四刀④）：入口在资产卡与生成历史卡的「溯源」钮，
// 展开右侧链条面板；默认展开 3 层＋「继续向上」；画布不画血统边。
// 两态诚实（③）：「来源不明」＝本体没有血统登记；「已删除」＝登记了把手但池查无。
// 池加载不完整的降级：查无只标「查无（本页范围）」，绝把加载失败误报成已删除。
//
// 面板风格复用历史页既有语法（SaveCardDialog 同款）：lg-sheet 玻璃面板 + iOS 字级/圆角。
//
// 文案纪律：本元件零硬编用户可见字串，全部经 `text()` 取自 src/lib/ui-strings.ts
// （守门件 src/lib/ui-strings.test.ts 去注解后禁 CJK）。lineage.ts 的中文类型标签、
// history-types.ts 的相对时间、节点 label 都是上游资料，原样显示。
//
// 本元件不得残留硬编用户可见字串。

import { useCallback, useEffect, useId, useMemo, useState } from "react";
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
  /** 正在看的那条记录（历史卡或资产卡适配后的视图）。 */
  host: LineageRecordView;
  /** 宿主类型文案（"生成记录" / "资产卡"），标题行显示。 */
  hostKindLabel: string;
  onClose: () => void;
  /**
   * 逐级跳转：宿主能把该记录打开到自己的视图（历史页开灯箱）时返回 true 并由宿主关闭抽屉。
   * 返回 false（例如卡记录在历史页没有落点）时抽屉就地钻入该级链条。
   */
  onJump?: (view: LineageRecordView) => boolean;
}

/** 节点行从根到叶的缩进（px）；三层链在 320px 面板里仍可扫读。 */
const ROW_INDENT_PX = 14;

/** 「继续向上」的硬顶：12 层之后的病态链用「更深链条未展开」收口，不给无限按钮。 */
const MAX_VISIBLE_DEPTH = 12;

function nodeKindLabel(node: LineageTreeNode): string {
  return node.link ? LINEAGE_KIND_LABEL[node.link.kind] : text("lineage.kind.root");
}

/** 状态徽章：话术键（文字只在 ui-strings.ts 一处），池不完整时「查无」不得说成「已删除」。 */
function statusBadgeOf(node: LineageTreeNode, poolComplete: boolean): { key: UiStringKey; tone: "muted" | "amber" | "neutral" } | null {
  switch (node.status) {
    case "deleted":
      // 池不完整时不得把「加载失败／范围外」说成「已删除」。
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
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.45)] transition-colors hover:bg-black/5 hover:text-[#007AFF] focus:outline-none focus:ring-2 focus:ring-ring/20"
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
  /** 钻入栈：末尾为当前链条的根（宿主记录在 index 0）。 */
  const [rootStack, setRootStack] = useState<LineageRecordView[]>([host]);
  const [poolState, setPoolState] = useState<{ status: "loading" | "ready"; data: LineagePoolLoadResult | null }>({
    status: "loading",
    data: null,
  });
  useEffect(() => setMounted(true), []);
  // host 变化（换卡重开）重置钻入与深度。
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
    if (onJump?.(view)) return; // 宿主已把视图带到该记录，抽屉由宿主负责关闭。
    setRootStack((stack) => [...stack, view]);
  }, [pool, onJump]);

  const backOneLevel = useCallback(() => {
    setRootStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack));
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[90]" role="presentation">
      <div className="absolute inset-0 bg-[rgba(31,34,48,0.45)] backdrop-blur-md" onClick={onClose} />
      <aside
        role="dialog"
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
                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.44)] hover:bg-black/5 focus:outline-none focus:ring-2 focus:ring-ring/20"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label={text("common.close")}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.44)] transition-colors hover:bg-black/5 hover:text-[rgba(0,0,0,0.72)] focus:outline-none focus:ring-2 focus:ring-ring/20"
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
              className="w-full cursor-pointer rounded-ios-xl bg-[rgba(0,122,255,0.10)] px-4 py-2.5 text-ios-footnote font-medium text-[#007AFF] transition-colors hover:bg-[rgba(0,122,255,0.16)] focus:outline-none focus:ring-2 focus:ring-ring/20"
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

/** 前序展平（不插入占位行——深度限制由 buildLineageTree 的 pruned 节点诚实表达）。 */
export function collectVisibleRows(tree: LineageTreeNode): LineageTreeNode[] {
  const rows: LineageTreeNode[] = [];
  const walk = (node: LineageTreeNode) => {
    rows.push(node);
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return rows;
}
