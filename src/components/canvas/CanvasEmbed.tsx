"use client";

// CanvasEmbed —— 畫布嵌合（v3）：agent 對話右側結果面板的畫布渲染模式。
//
// 暴君指令：canvas 不是獨立頁面，是 AI 助理模式中 agent 檢測到需要畫布時，
// 右側結果面板切換成這個 embed。這裡只渲染畫布 + 節點流（不含左側欄、
// 不自開 agent 對話——對話由宿主 AgentChatSurface 負責）。
//
// 吃 useCanvasChat 的 canvas 部分（nodes/connections/units/視口/歷史），
// 全部純展示；畫布狀態由 useCanvasChat 的 onCanvasEvent 分流餵入。

import { useRef, useEffect, useState, useCallback } from "react";
import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import type { CanvasNode } from "@/lib/canvas/types";
import { InfiniteCanvas } from "./InfiniteCanvas";
import { CanvasConnections } from "./CanvasConnections";
import { CanvasNodeView } from "./CanvasNodeView";
import { CanvasMiniMap } from "./CanvasMiniMap";

export interface CanvasEmbedProps {
  /** useCanvasChat 的完整 return（chat 部分由宿主另外用，這裡只用畫布部分）。 */
  canvas: UseCanvasChatReturn;
  /** embed 高度；不傳則撐滿父容器。 */
  height?: string;
  /** 全屏展開態（宿主用固定定位包住這個 embed）。 */
  expanded?: boolean;
  /** 面板關閉（回到 ImageDisplay 模式）時觸發。 */
  onClose?: () => void;
  /** 展開/收合切換（宿主維護展開狀態）。 */
  onToggleExpand?: () => void;
}

export function CanvasEmbed({
  canvas,
  height = "100%",
  expanded = false,
  onClose,
  onToggleExpand,
}: CanvasEmbedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const viewportSizeRef = useRef(viewportSize);
  viewportSizeRef.current = viewportSize;

  const handleSizeChange = useCallback((size: { width: number; height: number }) => {
    setViewportSize((prev) => (prev.width === size.width && prev.height === size.height ? prev : size));
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => handleSizeChange({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [handleSizeChange]);

  // 空畫布：沒節點時顯示「agent 正在籌備畫布」的輕提示，不是空白一片。
  const hasNodes = canvas.nodes.length > 0;
  const visibleNodes = canvas.nodes;

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden" style={{ height }}>
      <InfiniteCanvas
        viewport={canvas.viewport}
        backgroundMode={canvas.backgroundMode}
        onViewportChange={canvas.setViewport}
      >
        <CanvasConnections
          nodes={canvas.nodes}
          connections={canvas.connections}
          activeNodeId={canvas.selectedNodeId}
          onSelectConnection={() => {}}
        />
        {visibleNodes.map((node: CanvasNode) => (
          <CanvasNodeView
            key={node.id}
            node={node}
            scale={canvas.viewport.k}
            selected={canvas.selectedNodeId === node.id}
            onSelect={(nodeId) => canvas.selectNode(nodeId)}
            onMove={canvas.moveNode}
          />
        ))}
      </InfiniteCanvas>

      {canvas.nodes.length > 1 && (
        <CanvasMiniMap
          nodes={canvas.nodes}
          viewport={canvas.viewport}
          viewportSize={viewportSize}
          onJumpTo={(world) => canvas.centerOn(world, viewportSize.width, viewportSize.height)}
        />
      )}

      {/* 頂部薄條：畫布名稱 + 關閉（回到圖片結果模式） */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2">
        <span className="rounded-full bg-white/80 px-2.5 py-1 text-ios-caption1 font-medium text-[rgba(0,0,0,0.65)] shadow-sm backdrop-blur">
          画布
        </span>
        {onClose && !expanded && (
          <button
            type="button"
            onClick={onClose}
            className="pointer-events-auto cursor-pointer rounded-full bg-white/80 px-2.5 py-1 text-ios-caption1 font-medium text-[#007AFF] shadow-sm backdrop-blur hover:bg-white"
          >
            关闭画布
          </button>
        )}
        {expanded && onToggleExpand && (
          <button
            type="button"
            onClick={onToggleExpand}
            className="pointer-events-auto cursor-pointer rounded-full bg-white/80 px-2.5 py-1 text-ios-caption1 font-medium text-[#007AFF] shadow-sm backdrop-blur hover:bg-white"
          >
            收合画布
          </button>
        )}
      </div>

      {!hasNodes && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-ios-2xl bg-white/80 px-4 py-2 text-ios-footnote text-[rgba(0,0,0,0.5)] shadow-sm backdrop-blur">
            agent 正在筹备画布…
          </p>
        </div>
      )}
    </div>
  );
}
