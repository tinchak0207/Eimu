"use client";

// 畫布小地圖。桌面：標準大小；行動端（<768px）：緊湊版（更小、隱藏標題、
// 關閉鈕 ≥44px），避免佔據小螢幕 —— 整個地圖本身就是 ≥44px 的跳轉目標。

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type { CanvasNode, CanvasNodeStatus, CanvasViewport } from "@/lib/canvas/types";
import { computeWorldBounds } from "@/lib/canvas/layout";
import { cn } from "@/lib/utils";

export interface CanvasMiniMapProps {
  nodes: CanvasNode[];
  viewport: CanvasViewport;
  /** 主画布视口的像素尺寸，用来画「当前可见范围」的框 */
  viewportSize: { width: number; height: number };
  /** 点击缩略图 → 把该世界坐标居中 */
  onJumpTo: (world: { x: number; y: number }) => void;
  onClose?: () => void;
  className?: string;
}

const MAP_WIDTH_DESKTOP = 240;
const MAP_HEIGHT_DESKTOP = 160;
const MAP_WIDTH_MOBILE = 156;
const MAP_HEIGHT_MOBILE = 104;

const MOBILE_MQ = "(max-width: 767px)";

function nodeColor(status: CanvasNodeStatus | undefined): string {
  switch (status) {
    case "success":
      return "rgba(52,199,89,0.75)";
    case "loading":
      return "rgba(0,122,255,0.75)";
    case "error":
      return "rgba(255,59,48,0.75)";
    default:
      return "rgba(0,0,0,0.28)";
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function CanvasMiniMap({
  nodes,
  viewport,
  viewportSize,
  onJumpTo,
  onClose,
  className,
}: CanvasMiniMapProps) {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_MQ).matches,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(MOBILE_MQ);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const mapWidth = isMobile ? MAP_WIDTH_MOBILE : MAP_WIDTH_DESKTOP;
  const mapHeight = isMobile ? MAP_HEIGHT_MOBILE : MAP_HEIGHT_DESKTOP;

  const { bounds, scale } = useMemo(() => {
    const b = computeWorldBounds(nodes, 500);
    const raw = b.width > 0 && b.height > 0 ? Math.min(mapWidth / b.width, mapHeight / b.height) : 1;
    return { bounds: b, scale: Number.isFinite(raw) && raw > 0 ? raw : 1 };
  }, [nodes, mapWidth, mapHeight]);

  const handleJump = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    onJumpTo({ x: bounds.minX + offsetX / scale, y: bounds.minY + offsetY / scale });
  };

  // 主视口的可见世界矩形：-x/k, -y/k, w/k, h/k
  const k = viewport.k > 0 ? viewport.k : 1;
  const worldLeft = -viewport.x / k;
  const worldTop = -viewport.y / k;
  const worldW = viewportSize.width / k;
  const worldH = viewportSize.height / k;

  const rectLeft = clamp((worldLeft - bounds.minX) * scale, 0, mapWidth);
  const rectTop = clamp((worldTop - bounds.minY) * scale, 0, mapHeight);
  const rectWidth = clamp((worldLeft + worldW - bounds.minX) * scale, rectLeft, mapWidth) - rectLeft;
  const rectHeight = clamp((worldTop + worldH - bounds.minY) * scale, rectTop, mapHeight) - rectTop;

  return (
    <div data-canvas-interactive className={cn("absolute right-4 bottom-4", className)}>
      <div className="lg-float overflow-hidden rounded-2xl">
        <div className="flex items-center justify-between gap-2 px-3 pt-2">
          <span className="text-[11px] font-medium text-black/50 max-sm:hidden">缩略图</span>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭缩略图"
              className="flex h-5 w-5 touch-manipulation items-center justify-center rounded-full text-black/40 transition-colors hover:bg-black/5 hover:text-black/70 max-sm:h-11 max-sm:w-11 max-sm:active:bg-black/5"
            >
              <X className="h-3.5 w-3.5 max-sm:h-5 max-sm:w-5" />
            </button>
          ) : null}
        </div>
        <div className="relative" style={{ width: mapWidth, height: mapHeight }}>
          {nodes.length === 0 ? (
            <div className="flex h-full w-full items-center justify-center">
              <span className="text-xs text-black/40">暂无节点</span>
            </div>
          ) : (
            <button
              type="button"
              data-canvas-interactive
              className="relative block h-full w-full cursor-pointer touch-manipulation"
              aria-label="跳转到画布位置"
              onClick={handleJump}
            >
              {nodes.map((n) => (
                <div
                  key={n.id}
                  className="pointer-events-none absolute rounded-[2px]"
                  style={{
                    left: (n.position.x - bounds.minX) * scale,
                    top: (n.position.y - bounds.minY) * scale,
                    width: Math.max(2, n.width * scale),
                    height: Math.max(2, n.height * scale),
                    backgroundColor: nodeColor(n.metadata?.status),
                  }}
                />
              ))}
              <div
                className="pointer-events-none absolute border border-[rgba(0,122,255,0.9)] bg-[rgba(0,122,255,0.08)]"
                style={{ left: rectLeft, top: rectTop, width: rectWidth, height: rectHeight }}
              />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export { CanvasMiniMap };
export default CanvasMiniMap;
