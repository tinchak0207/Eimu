"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Coins, Download, Layers, Loader2, RotateCcw, SlidersHorizontal, Star, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatAbsoluteTime,
  formatCoins,
  formatModelLabel,
  inferEntryKind,
  primaryModelId,
} from "@/lib/history-types";
import { canHistoryEntryRerun } from "@/lib/history-rerun";
import { historyDagNodes, historyDagNodesTotalCoins, workflowDagThumbnailUrl } from "@/lib/history-workflow-view";
import type { HistoryEntry } from "@/lib/history-types";

export interface HistoryLightboxProps {
  entries: HistoryEntry[];
  /** 当前展示的记录在 entries 中的下标；为 null 表示关闭。 */
  index: number | null;
  onClose: () => void;
  onNavigate: (index: number) => void;
  onToggleStar: (id: string) => void;
  onDownload: (entry: HistoryEntry) => void | Promise<void>;
  onDelete: (id: string) => void;
  onReuse?: (entry: HistoryEntry) => void;
  /** 再来 N 组 / 微调变体（payload 级批量重跑）。缺席时工具栏不挂。 */
  onRerun?: (entry: HistoryEntry) => void;
  onRerunVariant?: (entry: HistoryEntry) => void;
}

/**
 * 灯箱主图/缩略图的取图顺序：工作流先看后端渲染好的 DAG 图，否则 image →
 * imageUrl → videoUrl。视频记录的结果里只有 videoUrl，旧实现直接返回 null，
 * 于是整条视频记录在灯箱里显示成「没有留存图片」，胶片条上也全是「无图」。
 */
function entrySrc(entry: HistoryEntry): string | null {
  const dagThumbnailUrl = workflowDagThumbnailUrl(entry);
  if (dagThumbnailUrl) return dagThumbnailUrl;
  const result = entry.results.find((item) => item.image || item.imageUrl || item.videoUrl);
  if (!result) return null;
  return result.image ? `data:image/png;base64,${result.image}` : result.imageUrl ?? result.videoUrl ?? null;
}

/** 工具栏按钮：44px 命中区，符合触摸目标下限。 */
function ToolbarButton({
  label,
  onClick,
  active,
  tone = "neutral",
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  tone?: "neutral" | "danger" | "gold";
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        "flex h-11 w-11 cursor-pointer items-center justify-center rounded-full",
        "bg-white/15 text-white/90 backdrop-blur-xl transition-all duration-200",
        // Tailwind's opacity modifier only resolves values on the default
        // scale (multiples of 5) — /28 silently compiled to nothing. Bracket
        // rgba() is a real arbitrary value, not a scale lookup, so it always
        // compiles regardless of the fraction.
        "hover:bg-[rgba(255,255,255,0.28)] active:scale-[0.94]",
        "focus:outline-none focus:ring-2 focus:ring-white/50",
        tone === "danger" && "hover:bg-[rgba(255,59,48,0.32)]",
        tone === "gold" && active && "text-[#FFD34D]",
      )}
    >
      {children}
    </button>
  );
}

export function HistoryLightbox({
  entries,
  index,
  onClose,
  onNavigate,
  onToggleStar,
  onDownload,
  onDelete,
  onReuse,
  onRerun,
  onRerunVariant,
}: HistoryLightboxProps) {
  const [mounted, setMounted] = useState(false);
  /** 下载要等整图 fetch 成 blob，期间工具栏下载钮转圈防重复点击。 */
  const [downloadBusy, setDownloadBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  /** 打开前的焦点，关闭时要还回去，否则键盘用户会被扔回页面顶部。 */
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const isOpen = index !== null && index >= 0 && index < entries.length;
  const entry = isOpen ? entries[index] : null;

  // createPortal 需要 document，SSR 阶段不能调用。
  useEffect(() => {
    setMounted(true);
  }, []);

  // 打开时记住焦点并移入对话框；关闭时还原。
  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    return () => {
      previousFocusRef.current?.focus?.();
    };
  }, [isOpen]);

  // 锁住背景滚动。直接改 overflow 会让滚动条消失导致页面横跳，所以补上等宽的 padding。
  useEffect(() => {
    if (!isOpen) return;
    const { body } = document;
    const previousOverflow = body.style.overflow;
    const previousPadding = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;

    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPadding;
    };
  }, [isOpen]);

  // 安卓返回键关闭灯箱，而不是退出整个页面。
  useEffect(() => {
    if (!isOpen) return;
    window.history.pushState({ historyLightbox: true }, "");
    const handlePopState = () => onClose();
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [isOpen, onClose]);

  const goPrev = useCallback(() => {
    if (index === null || index <= 0) return;
    onNavigate(index - 1);
  }, [index, onNavigate]);

  const goNext = useCallback(() => {
    if (index === null || index >= entries.length - 1) return;
    onNavigate(index + 1);
  }, [index, entries.length, onNavigate]);

  // 键盘：Esc 关闭、左右切换、Tab 在对话框内循环。
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goPrev();
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        goNext();
        return;
      }
      if (event.key !== "Tab") return;

      // 焦点陷阱：不这么做的话 Tab 会跑到灯箱背后的页面上去。
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables?.length) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, goPrev, goNext]);

  if (!mounted || !isOpen || !entry) return null;

  const src = entrySrc(entry);
  const model = primaryModelId(entry);
  const promptText = entry.prompt.trim();
  const workflow = entry.workflow;
  const rerunnable = canHistoryEntryRerun(entry);
  // 只在真的带 DAG 节点时才算一遍，普通图像记录零开销。
  const dagNodes = inferEntryKind(entry) === "workflow" ? historyDagNodes(entry) : null;
  const dagNodesTotalCoins = historyDagNodesTotalCoins(dagNodes);
  /** DAG 缩略图：主图用的就是它，这里额外用 type badge 说出来「这是工作流图」。 */
  const isDagThumbnail = Boolean(workflowDagThumbnailUrl(entry));

  return createPortal(
    <div
      // bg-[#1f2230]/74 silently compiled to nothing: Tailwind's opacity
      // modifier only resolves scale values (multiples of 5), so /74 never
      // generated a rule at all — the whole dark backdrop was actually fully
      // transparent, leaving every white-on-dark control in this lightbox
      // rendering as white-on-whatever-was-behind-it (i.e. invisible on the
      // light page). rgba() as a bracket value bypasses the scale lookup.
      className="hist-lightbox-enter fixed inset-0 z-50 flex min-h-[100dvh] w-screen flex-col bg-[rgba(31,34,48,0.74)] backdrop-blur-md"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex min-h-0 flex-1 flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 顶部工具栏 */}
        <header className="flex shrink-0 items-center justify-between gap-3 px-4 pt-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <p id={titleId} className="truncate text-ios-subhead font-semibold text-[rgba(255,255,255,0.92)]">
              {promptText || "生成记录"}
            </p>
            <p className="mt-0.5 truncate text-ios-caption1 text-white/70">
              {model ? formatModelLabel(model) : "未知模型"} · {formatAbsoluteTime(entry.generatedAt)}
              {entry.quota !== undefined && entry.quota > 0 && ` · 消耗 ${formatCoins(entry.quota)} 张`}
              {/* 工作流记录的主图是后端渲染的 DAG 缩略图，不是生成结果本身。
                  不说明的话用户会以为那就是跑出来的图。 */}
              {isDagThumbnail && " · 工作流结构图"}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <ToolbarButton
              label={entry.starred ? "取消收藏" : "收藏"}
              active={Boolean(entry.starred)}
              tone="gold"
              onClick={() => onToggleStar(entry.id)}
            >
              <Star className="h-4 w-4" fill={entry.starred ? "currentColor" : "none"} />
            </ToolbarButton>
            {src && (
              <ToolbarButton
                label="下载"
                disabled={downloadBusy}
                onClick={() => {
                  if (downloadBusy) return;
                  setDownloadBusy(true);
                  Promise.resolve(onDownload(entry)).finally(() => setDownloadBusy(false));
                }}
              >
                {downloadBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              </ToolbarButton>
            )}
            {onReuse && workflow && (
              <ToolbarButton label="用这套参数继续做图" onClick={() => onReuse(entry)}>
                <RotateCcw className="h-4 w-4" />
              </ToolbarButton>
            )}
            {/* payload 级重跑：配方完整才挂，按下去只会失败的按钮比不挂更糟。 */}
            {onRerun && rerunnable && (
              <ToolbarButton label="再来 N 组" onClick={() => onRerun(entry)}>
                <Layers className="h-4 w-4" />
              </ToolbarButton>
            )}
            {onRerunVariant && rerunnable && (
              <ToolbarButton label="微调变体" onClick={() => onRerunVariant(entry)}>
                <SlidersHorizontal className="h-4 w-4" />
              </ToolbarButton>
            )}
            <ToolbarButton label="删除" tone="danger" onClick={() => onDelete(entry.id)}>
              <Trash2 className="h-4 w-4" />
            </ToolbarButton>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label="关闭大图"
              className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-white/15 text-white/90 backdrop-blur-xl transition-all duration-200 hover:bg-[rgba(255,255,255,0.28)] active:scale-[0.94] focus:outline-none focus:ring-2 focus:ring-white/50"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* 主图区 */}
        <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 py-4 sm:px-16">
          {index > 0 && (
            <button
              type="button"
              onClick={goPrev}
              aria-label="上一张"
              className="absolute left-2 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/15 text-white/90 backdrop-blur-xl transition-all duration-200 hover:bg-[rgba(255,255,255,0.28)] active:scale-[0.94] focus:outline-none focus:ring-2 focus:ring-white/50 sm:left-4"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          )}

          {src ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              key={entry.id}
              src={src}
              alt={promptText ? `生成结果：${promptText.slice(0, 60)}` : "生成结果"}
              decoding="async"
              className="hist-lightbox-figure max-h-full max-w-full rounded-ios-2xl object-contain shadow-[0_30px_80px_rgba(0,0,0,0.32)]"
            />
          ) : (
            <div className="rounded-ios-2xl bg-white/10 px-8 py-12 text-center">
              <p className="text-ios-footnote text-white/85">这条记录没有留存图片</p>
              <p className="mt-1 text-ios-caption1 text-white/60">参数仍可复用</p>
            </div>
          )}

          {index < entries.length - 1 && (
            <button
              type="button"
              onClick={goNext}
              aria-label="下一张"
              className="absolute right-2 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/15 text-white/90 backdrop-blur-xl transition-all duration-200 hover:bg-[rgba(255,255,255,0.28)] active:scale-[0.94] focus:outline-none focus:ring-2 focus:ring-white/50 sm:right-4"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* 参数摘要 + 衍生关联（重跑任务经 retryOfTaskId 指回父任务） */}
        {(workflow || entry.retryOfTaskId) && (
          <div className="shrink-0 px-4 pb-2 sm:px-6">
            <div className="flex flex-wrap gap-1.5">
              {workflow?.workflowPresetLabel && (
                <span className="rounded-full bg-[rgba(255,255,255,0.12)] px-2.5 py-1 text-ios-caption1 text-[rgba(255,255,255,0.82)]">
                  {workflow.workflowPresetLabel}
                </span>
              )}
              {workflow?.imageSize && (
                <span className="rounded-full bg-[rgba(255,255,255,0.12)] px-2.5 py-1 text-ios-caption1 text-[rgba(255,255,255,0.82)]">
                  {workflow.imageSize}
                </span>
              )}
              {workflow?.qualityProfile && (
                <span className="rounded-full bg-[rgba(255,255,255,0.12)] px-2.5 py-1 text-ios-caption1 text-[rgba(255,255,255,0.82)]">
                  {workflow.qualityProfile}
                </span>
              )}
              {workflow?.estimatedCredits !== undefined && (
                <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(255,255,255,0.12)] px-2.5 py-1 text-ios-caption1 text-[rgba(255,255,255,0.82)]">
                  <Coins className="h-2.5 w-2.5" />
                  预估 {workflow.estimatedCredits}
                </span>
              )}
              {entry.retryOfTaskId && (
                <span
                  className="rounded-full bg-[rgba(255,255,255,0.12)] px-2.5 py-1 text-ios-caption1 text-[rgba(255,255,255,0.82)]"
                  title={`衍生自任务 ${entry.retryOfTaskId}`}
                >
                  衍生自任务 {entry.retryOfTaskId.slice(0, 8)}
                </span>
              )}
            </div>

            {/* 节点产物清单：DAG 每個節點跑完各自的產物與實付。後端沒有寫入
                dagNodes 時整塊不渲染（而不是顯示一個空清單）。 */}
            {dagNodes && (
              <div className="mt-3">
                <p className="text-ios-caption1 font-medium text-[rgba(255,255,255,0.82)]">节点产物</p>
                <ul className="mt-1.5 space-y-1">
                  {dagNodes.map((node, nodeIndex) => (
                    <li
                      key={`${node.role ?? node.kind ?? "node"}-${nodeIndex}`}
                      className="flex items-center gap-2 text-ios-caption1 text-white/70"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {node.title ?? node.role ?? "未命名节点"}
                        {node.kind && <span className="ml-1.5 text-white/50">{node.kind}</span>}
                      </span>
                      {node.status && <span className="shrink-0 text-white/50">{node.status}</span>}
                      {node.costCoins !== null && (
                        <span className="inline-flex shrink-0 items-center gap-0.5 text-[#FFCE73]">
                          <Coins className="h-2.5 w-2.5" />
                          {node.costCoins}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {dagNodesTotalCoins !== null && (
                  <p className="mt-1.5 inline-flex items-center gap-1 text-ios-caption1 text-[rgba(255,255,255,0.82)]">
                    <Coins className="h-2.5 w-2.5 text-[#FFCE73]" />
                    节点合计 {dagNodesTotalCoins} 币
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* 胶片条 */}
        <nav
          aria-label="历史图片列表"
          className="hist-filmstrip flex shrink-0 gap-2 overflow-x-auto px-4 pb-4 pt-2 sm:px-6"
        >
          {entries.map((item, itemIndex) => {
            const thumb = entrySrc(item);
            const isCurrent = itemIndex === index;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(itemIndex)}
                aria-label={`第 ${itemIndex + 1} 张`}
                aria-current={isCurrent ? "true" : undefined}
                className={cn(
                  "h-14 w-14 shrink-0 cursor-pointer overflow-hidden rounded-ios-md transition-all duration-200",
                  "focus:outline-none focus:ring-2 focus:ring-white/50",
                  isCurrent
                    ? "opacity-100 ring-2 ring-white/85"
                    : "opacity-45 hover:opacity-80",
                )}
              >
                {thumb ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={thumb}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-white/10 text-ios-caption1 text-white/60">
                    无图
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <p className="shrink-0 pb-3 text-center text-ios-caption1 text-white/60">
          左右方向键切换，按 Esc 关闭
        </p>
      </div>
    </div>,
    document.body,
  );
}
