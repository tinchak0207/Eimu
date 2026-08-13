"use client";

import { useEffect, useRef, useState } from "react";
import type { CanvasViewport } from "@/lib/canvas/types";
import { gridBackground, zoomAtPoint } from "@/lib/canvas/layout";
import { cn } from "@/lib/utils";

export interface InfiniteCanvasProps {
  viewport: CanvasViewport;
  onViewportChange: (next: CanvasViewport | ((prev: CanvasViewport) => CanvasViewport)) => void;
  backgroundMode: "dots" | "lines" | "blank";
  /** 空白处按下时调用（用来清空选取） */
  onBackgroundPointerDown?: () => void;
  /** 视口尺寸变化时回报，供 fitView / minimap 用 */
  onSizeChange?: (size: { width: number; height: number }) => void;
  className?: string;
  children: React.ReactNode;
}

function InfiniteCanvas({
  viewport,
  onViewportChange,
  backgroundMode,
  onBackgroundPointerDown,
  onSizeChange,
  className,
  children,
}: InfiniteCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  // 最新的 viewport / 回呼存在 ref：wheel listener 只注册一次，
  // 不因每次 render 重新注册，也不吃闭包里的旧值。
  const viewportRef = useRef(viewport);
  const onViewportChangeRef = useRef(onViewportChange);
  const onSizeChangeRef = useRef(onSizeChange);

  // 尺寸存 ref + state（ref 给 ResizeObserver 用，state 留给需要重渲染的场景）。
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const sizeRef = useRef(size);

  useEffect(() => {
    viewportRef.current = viewport;
  });
  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  });
  useEffect(() => {
    onSizeChangeRef.current = onSizeChange;
  });

  // 滚轮缩放：React 19 的 onWheel 是 passive，preventDefault 会静默失败，
  // 必须用原生 listener + { passive: false }。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      onViewportChangeRef.current((prev) => zoomAtPoint(prev, e.deltaY, px, py));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 追踪容器尺寸，回报给父层（fitView / minimap 用）。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const next = { width, height };
        sizeRef.current = next;
        setSize(next);
        onSizeChangeRef.current?.(next);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 平移：用 pointer capture。未超过 3px 当作空白点击。
  const panStartRef = useRef<{ x: number; y: number } | null>(null);
  const panLastRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const panActiveRef = useRef(false);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-canvas-node], [data-canvas-interactive]")) return;
    panStartRef.current = { x: e.clientX, y: e.clientY };
    panLastRef.current = { x: e.clientX, y: e.clientY };
    panActiveRef.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!panStartRef.current) return;
    if (!panActiveRef.current) {
      const totalX = e.clientX - panStartRef.current.x;
      const totalY = e.clientY - panStartRef.current.y;
      if (Math.hypot(totalX, totalY) <= 3) return;
      panActiveRef.current = true;
      setIsPanning(true);
    }
    const dx = e.clientX - panLastRef.current.x;
    const dy = e.clientY - panLastRef.current.y;
    panLastRef.current = { x: e.clientX, y: e.clientY };
    onViewportChange((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
  };

  const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!panStartRef.current) return;
    const wasActive = panActiveRef.current;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    panStartRef.current = null;
    panActiveRef.current = false;
    setIsPanning(false);
    if (!wasActive) {
      onBackgroundPointerDown?.();
    }
  };

  const background = gridBackground(viewport, backgroundMode);
  const contentStyle = {
    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`,
    "--canvas-inverse-scale": String(1 / viewport.k),
  } as React.CSSProperties;

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative h-full w-full cursor-grab select-none overflow-hidden",
        isPanning && "cursor-grabbing",
        className,
      )}
      style={{ ...background }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    >
      <div className="absolute origin-top-left" style={contentStyle}>
        {children}
      </div>
    </div>
  );
}

export { InfiniteCanvas };
export default InfiniteCanvas;
