"use client";

// node-view/use-node-gestures —— CanvasNodeView 的三套指標手勢：
//   1. dragRef：節點拖動（5px 死區，輕點=選取，越區才拖）
//   2. resizeRef：四角縮放（含位置補償，nw/sw 拖動時 x/y 跟著走）
//   3. scrollDragRef：內容捲動（行動端，InfiniteCanvas 容器 touch-action:none
//      攔截了原生觸控捲動，這裡用 Pointer Events 自己捲）
// 邏輯從 CanvasNodeView 原樣搬遷（L233-421），pointer capture 與 JSX 綁定一一對應。

import { useRef } from "react";
import type { CanvasNode } from "@/lib/canvas/types";
import { MIN_HEIGHT, MIN_WIDTH, MOVE_THRESHOLD_PX, type ResizeCfg } from "./constants";

export interface UseNodeGesturesArgs {
  node: CanvasNode;
  /** 當前縮放，拖動時要把螢幕位移換算成世界位移 */
  scale: number;
  onSelect: (nodeId: string) => void;
  /** 拖動真正開始（越過死區）時觸發（供整合層推一格撤銷快照） */
  onInteractionStart?: () => void;
  onMove: (nodeId: string, position: { x: number; y: number }) => void;
  onResize?: (nodeId: string, width: number, height: number) => void;
  /** A2：乾淨點擊（選取且未拖動）——宿主用它「點選即開面板」。 */
  onNodeClick?: (nodeId: string) => void;
}

export function useNodeGestures({ node, scale, onSelect, onInteractionStart, onMove, onResize, onNodeClick }: UseNodeGesturesArgs) {
  const dragRef = useRef<{
    pointerId: number;
    startPointerX: number;
    startPointerY: number;
    startX: number;
    startY: number;
    started: boolean;
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
  // 內容捲動（行動端）：InfiniteCanvas 在容器上設 touch-action:none，
  // 瀏覽器原生觸控捲動會被祖先攔截，這裡用 Pointer Events 自己捲。
  const scrollDragRef = useRef<{
    pointerId: number;
    startY: number;
    startScrollTop: number;
    moved: boolean;
  } | null>(null);

  const handleScrollAreaDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    // 內容沒溢出就不劫持手勢（讓根節點的選取/拖動照常）。
    if (el.scrollHeight <= el.clientHeight + 1) return;
    scrollDragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startScrollTop: el.scrollTop,
      moved: false,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer 已結束時 capture 會拋錯，忽略 */
    }
  };

  const handleScrollAreaMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = scrollDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dy = d.startY - e.clientY;
    if (!d.moved && Math.abs(dy) < 4) return;
    d.moved = true;
    const el = e.currentTarget;
    const k = scale > 0 ? scale : 1;
    el.scrollTop = d.startScrollTop + dy / k;
  };

  const handleScrollAreaEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = scrollDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    scrollDragRef.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-canvas-interactive]")) return;
    onSelect(node.id);
    // 內容捲動區：內容有溢出時只選取、不啟用拖動（交給內容自己的捲動手勢）；
    // 沒溢出則照常可拖動節點。
    const scroller = target.closest<HTMLElement>(".canvas-node-scroll");
    if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) return;
    const existing = dragRef.current;
    if (existing && existing.pointerId === e.pointerId) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      startX: node.position.x,
      startY: node.position.y,
      started: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (!drag.started) {
      const dist = Math.hypot(e.clientX - drag.startPointerX, e.clientY - drag.startPointerY);
      if (dist < MOVE_THRESHOLD_PX) return;
      drag.started = true;
      onInteractionStart?.();
    }
    const dx = (e.clientX - drag.startPointerX) / scale;
    const dy = (e.clientY - drag.startPointerY) / scale;
    onMove(node.id, { x: drag.startX + dx, y: drag.startY + dy });
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId === e.pointerId) {
      // A2：乾淨點擊（未越過拖動死區、非取消）→ 上報 click，宿主用它開節點面板。
      const wasCleanClick = !drag.started && e.type === "pointerup";
      dragRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      if (wasCleanClick) onNodeClick?.(node.id);
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

  return {
    handleScrollAreaDown,
    handleScrollAreaMove,
    handleScrollAreaEnd,
    handlePointerDown,
    handlePointerMove,
    endDrag,
    handleResizeStart,
    handleResizeMove,
    endResize,
  };
}
