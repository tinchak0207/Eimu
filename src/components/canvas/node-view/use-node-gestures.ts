"use client";

// node-view/use-node-gestures —— CanvasNodeView 的三套指标手势：
//   1. dragRef：节点拖动（5px 死区，轻点=选取，越区才拖）
//   2. resizeRef：四角缩放（含位置补偿，nw/sw 拖动时 x/y 跟著走）
//   3. scrollDragRef：内容卷动（行动端，InfiniteCanvas 容器 touch-action:none
//      拦截了原生触控卷动，这里用 Pointer Events 自己卷）
// 逻辑从 CanvasNodeView 原样搬迁（L233-421），pointer capture 与 JSX 绑定一一对应。

import { useRef } from "react";
import type { CanvasNode } from "@/lib/canvas/types";
import { MIN_HEIGHT, MIN_WIDTH, MOVE_THRESHOLD_PX, type ResizeCfg } from "./constants";

export interface UseNodeGesturesArgs {
  node: CanvasNode;
  /** 当前缩放，拖动时要把萤幕位移换算成世界位移 */
  scale: number;
  onSelect: (nodeId: string) => void;
  /** 拖动真正开始（越过死区）时触发（供整合层推一格撤销快照） */
  onInteractionStart?: () => void;
  onMove: (nodeId: string, position: { x: number; y: number }) => void;
  onResize?: (nodeId: string, width: number, height: number) => void;
  /** A2：干净点击（选取且未拖动）——宿主用它「点选即开面板」。 */
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
  // 内容卷动（行动端）：InfiniteCanvas 在容器上设 touch-action:none，
  // 浏览器原生触控卷动会被祖先拦截，这里用 Pointer Events 自己卷。
  const scrollDragRef = useRef<{
    pointerId: number;
    startY: number;
    startScrollTop: number;
    moved: boolean;
  } | null>(null);

  const handleScrollAreaDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    // 内容没溢出就不劫持手势（让根节点的选取/拖动照常）。
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
      /* pointer 已结束时 capture 会抛错，忽略 */
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
    // 内容卷动区：内容有溢出时只选取、不启用拖动（交给内容自己的卷动手势）；
    // 没溢出则照常可拖动节点。
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
      // A2：干净点击（未越过拖动死区、非取消）→ 上报 click，宿主用它开节点面板。
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
