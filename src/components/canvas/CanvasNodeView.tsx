"use client";

// 畫布單一節點：拖動 / 縮放 / 依類型渲染內文。
// 螢幕位移 → 世界位移：dx / scale。
// 互動元素（按鈕、縮放手柄）帶 data-canvas-interactive，讓 InfiniteCanvas 平移忽略它們。

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { CanvasNodeType, type CanvasNode, type CanvasNodeStatus } from "@/lib/canvas/types";

export interface CanvasNodeViewProps {
  node: CanvasNode;
  selected: boolean;
  onSelect: (nodeId: string) => void;
  /** 拖動開始（供整合層推一格撤銷快照） */
  onInteractionStart?: () => void;
  onMove: (nodeId: string, position: { x: number; y: number }) => void;
  onResize?: (nodeId: string, width: number, height: number) => void;
  onDelete?: (nodeId: string) => void;
  /** 當前縮放，拖動時要把螢幕位移換算成世界位移 */
  scale: number;
}

const MIN_WIDTH = 120;
const MIN_HEIGHT = 90;

const STATUS_COLOR: Record<CanvasNodeStatus, string> = {
  idle: "rgba(0,0,0,0.18)",
  success: "#34C759",
  loading: "#007AFF",
  error: "#FF3B30",
};

const STATUS_LABEL: Record<CanvasNodeStatus, string> = {
  idle: "待处理",
  loading: "生成中…",
  success: "已完成",
  error: "失败",
};

const TYPE_LABEL: Record<CanvasNodeType, string> = {
  [CanvasNodeType.Image]: "图片",
  [CanvasNodeType.Text]: "文本",
  [CanvasNodeType.Config]: "生成配置",
  [CanvasNodeType.Video]: "视频",
  [CanvasNodeType.Group]: "组",
};

function isUrl(value: string): boolean {
  return value.startsWith("http") || value.startsWith("data:");
}

function formatProgress(progress: number): string {
  const pct = progress <= 1 ? Math.round(progress * 100) : Math.round(progress);
  return `${pct}%`;
}

interface ResizeCfg {
  moveX: boolean;
  moveY: boolean;
}

const RESIZE_HANDLES: { id: string; pos: React.CSSProperties; cfg: ResizeCfg }[] = [
  { id: "nw", pos: { left: 0, top: 0, cursor: "nwse-resize" }, cfg: { moveX: true, moveY: true } },
  { id: "ne", pos: { right: 0, top: 0, cursor: "nesw-resize" }, cfg: { moveX: false, moveY: true } },
  { id: "sw", pos: { left: 0, bottom: 0, cursor: "nesw-resize" }, cfg: { moveX: true, moveY: false } },
  { id: "se", pos: { right: 0, bottom: 0, cursor: "nwse-resize" }, cfg: { moveX: false, moveY: false } },
];

export function CanvasNodeView({
  node,
  selected,
  onSelect,
  onInteractionStart,
  onMove,
  onResize,
  onDelete,
  scale,
}: CanvasNodeViewProps) {
  const [mounted, setMounted] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startPointerX: number;
    startPointerY: number;
    startX: number;
    startY: number;
  } | null>(null);
  const resizeRef = useRef<{
    pointerId: number;
    startPointerX: number;
    startPointerY: number;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    cfg: ResizeCfg;
  } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const status: CanvasNodeStatus = node.metadata?.status ?? "idle";
  const statusColor = STATUS_COLOR[status];
  const statusLabel = STATUS_LABEL[status];
  const typeLabel = TYPE_LABEL[node.type];

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-canvas-interactive]")) return;
    onSelect(node.id);
    const existing = dragRef.current;
    if (existing && existing.pointerId === e.pointerId) return;
    onInteractionStart?.();
    dragRef.current = {
      pointerId: e.pointerId,
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      startX: node.position.x,
      startY: node.position.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = (e.clientX - drag.startPointerX) / scale;
    const dy = (e.clientY - drag.startPointerY) / scale;
    onMove(node.id, { x: drag.startX + dx, y: drag.startY + dy });
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleResizeStart = (e: React.PointerEvent<HTMLDivElement>, cfg: ResizeCfg) => {
    e.stopPropagation();
    onSelect(node.id);
    onInteractionStart?.();
    resizeRef.current = {
      pointerId: e.pointerId,
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      startX: node.position.x,
      startY: node.position.y,
      startWidth: node.width,
      startHeight: node.height,
      cfg,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const handleResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== e.pointerId) return;
    const dx = (e.clientX - r.startPointerX) / scale;
    const dy = (e.clientY - r.startPointerY) / scale;
    const width = Math.max(MIN_WIDTH, r.startWidth + (r.cfg.moveX ? -dx : dx));
    const height = Math.max(MIN_HEIGHT, r.startHeight + (r.cfg.moveY ? -dy : dy));
    const x = r.cfg.moveX ? r.startX + (r.startWidth - width) : r.startX;
    const y = r.cfg.moveY ? r.startY + (r.startHeight - height) : r.startY;
    onMove(node.id, { x, y });
    onResize?.(node.id, width, height);
  };

  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId === e.pointerId) {
      resizeRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(node.id);
    }
  };

  const renderPlaceholder = (statusValue: CanvasNodeStatus, metadata: CanvasNode["metadata"]) => {
    if (statusValue === "loading") {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-3">
          <div
            className="h-5 w-5 animate-spin rounded-full border-2 border-[rgba(0,0,0,0.15)] border-t-[#007AFF]"
            aria-hidden="true"
          />
          <span className="text-[13px] text-[rgba(0,0,0,0.55)]">生成中…</span>
          {typeof metadata?.progress === "number" && (
            <span className="text-[12px] text-[rgba(0,0,0,0.4)] tabular-nums">{formatProgress(metadata.progress)}</span>
          )}
        </div>
      );
    }
    if (statusValue === "error") {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-3">
          <span className="text-[13px] font-medium text-[#FF3B30]">失败</span>
          {metadata?.errorDetails ? (
            <span className="break-words text-center text-[11px] leading-snug text-[#FF3B30]">{metadata.errorDetails}</span>
          ) : null}
        </div>
      );
    }
    return (
      <div className="flex flex-1 items-center justify-center p-3">
        <span className="text-[12px] text-[rgba(0,0,0,0.35)]">{statusLabel}</span>
      </div>
    );
  };

  const renderBody = () => {
    const metadata = node.metadata;
    switch (node.type) {
      case CanvasNodeType.Image:
      case CanvasNodeType.Video: {
        const content = metadata?.content;
        if (content && isUrl(content)) {
          if (node.type === CanvasNodeType.Video) {
            return <video src={content} controls className="h-full w-full object-cover" />;
          }
          return (
            <img src={content} alt={node.title} loading="lazy" draggable={false} className="h-full w-full object-cover" />
          );
        }
        return renderPlaceholder(status, metadata);
      }
      case CanvasNodeType.Text: {
        const text = metadata?.content ?? metadata?.prompt;
        return (
          <div className="overflow-auto p-3 text-[13px] leading-relaxed whitespace-pre-wrap break-words text-[rgba(0,0,0,0.78)]">
            {text || ""}
          </div>
        );
      }
      case CanvasNodeType.Config: {
        const rows: { label: string; value: string }[] = [];
        if (metadata?.model) rows.push({ label: "模型", value: metadata.model });
        if (metadata?.size) rows.push({ label: "尺寸", value: metadata.size });
        if (metadata?.quality) rows.push({ label: "质量", value: metadata.quality });
        if (typeof metadata?.count === "number") rows.push({ label: "数量", value: String(metadata.count) });
        if (metadata?.kind) rows.push({ label: "类型", value: metadata.kind });
        if (metadata?.source_image) rows.push({ label: "参考图", value: metadata.source_image });
        if (rows.length === 0) {
          return (
            <div className="flex flex-1 items-center justify-center p-3">
              <span className="text-[12px] text-[rgba(0,0,0,0.35)]">无配置</span>
            </div>
          );
        }
        return (
          <div className="flex-1 space-y-1 overflow-auto p-3">
            {rows.map((row) => (
              <div key={row.label} className="flex items-baseline justify-between gap-2">
                <span className="shrink-0 text-[11px] text-[rgba(0,0,0,0.4)]">{row.label}</span>
                <span className="min-w-0 truncate text-[11px] font-mono text-[rgba(0,0,0,0.7)]">{row.value}</span>
              </div>
            ))}
          </div>
        );
      }
      case CanvasNodeType.Group:
        return (
          <div className="m-3 flex flex-1 items-center justify-center rounded-xl border-2 border-dashed border-[rgba(0,0,0,0.12)]">
            <span className="px-3 text-center text-[13px] text-[rgba(0,0,0,0.45)]">{node.title}</span>
          </div>
        );
    }
  };

  const showCostBadge =
    (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) &&
    typeof node.metadata?.cost_coins === "number";

  return (
    <div
      data-canvas-node={node.id}
      role="button"
      tabIndex={0}
      aria-label={`画布节点：${node.title}，${statusLabel}`}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={cn(
        "absolute touch-none select-none transition-[opacity,transform] duration-300 ease-out",
        mounted ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
      )}
      style={{ left: node.position.x, top: node.position.y, width: node.width, height: node.height }}
    >
      <div
        className={cn(
          "lg-card relative flex h-full flex-col overflow-hidden rounded-2xl",
          selected && "ring-2 ring-[rgba(0,122,255,0.5)]",
        )}
      >
        <div className="h-[3px] w-full shrink-0" style={{ background: statusColor }} />
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[rgba(0,0,0,0.85)]">
            {node.title}
          </span>
          <span className="shrink-0 text-[11px] text-[rgba(0,0,0,0.35)]">{typeLabel}</span>
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
              status === "idle" && "bg-[rgba(0,0,0,0.06)] text-[rgba(0,0,0,0.5)]",
              status === "success" && "bg-[rgba(52,199,89,0.14)] text-[#248A3D]",
              status === "loading" && "bg-[rgba(0,122,255,0.12)] text-[#007AFF]",
              status === "error" && "bg-[rgba(255,59,48,0.12)] text-[#FF3B30]",
            )}
          >
            {statusLabel}
          </span>
          {onDelete && (
            <button
              type="button"
              data-canvas-interactive
              onClick={() => onDelete(node.id)}
              title="删除节点"
              aria-label="删除节点"
              className="shrink-0 rounded-full p-1 text-[rgba(0,0,0,0.4)] transition-colors hover:bg-[rgba(0,0,0,0.06)] hover:text-[rgba(0,0,0,0.7)]"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="relative min-h-0 flex-1">{renderBody()}</div>
        {showCostBadge && (
          <span className="pointer-events-none absolute right-2 bottom-2 rounded-full bg-[rgba(0,0,0,0.6)] px-2 py-0.5 text-[11px] font-medium text-white">
            {node.metadata?.cost_coins} 币
          </span>
        )}
      </div>
      {selected && onResize
        ? RESIZE_HANDLES.map((h) => (
            <div
              key={h.id}
              data-canvas-interactive
              onPointerDown={(e) => handleResizeStart(e, h.cfg)}
              onPointerMove={handleResizeMove}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              className="z-10 rounded-[3px] border border-[rgba(0,122,255,0.6)] bg-[rgba(0,122,255,0.2)]"
              style={{
                ...h.pos,
                position: "absolute",
                width: "calc(10px * var(--canvas-inverse-scale, 1))",
                height: "calc(10px * var(--canvas-inverse-scale, 1))",
              }}
            />
          ))
        : null}
    </div>
  );
}
