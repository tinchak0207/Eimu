"use client";

// 画布小地图（2026-10-09 改为常驻）。桌面：标准大小；行动端（<768px）：紧凑版（更小、
// 触控目标 ≥44px）。整个地图本身就是 ≥44px 的跳转目标。
//
// 常态存在：**收起态**＝一条带「当前画布名」的胶囊（点一下展开）；**展开态**＝小地图本体
// ＋标题行换成「画布名下拉」——列出 canvasList，点选＝switchCanvas，当前项打勾/高亮。
// 展开/收起受控（宿主缩放胶囊的缩略图钮也走同一状态），缺省内部自管。

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Map as MapIcon, X } from "lucide-react";
import type { CanvasNode, CanvasNodeStatus, CanvasViewport } from "@/lib/canvas/types";
import { computeWorldBounds } from "@/lib/canvas/layout";
import { cn } from "@/lib/utils";
import type { ChatCanvasEntry } from "@/hooks/canvas/canvas-chat-types";

export interface CanvasMiniMapProps {
  nodes: CanvasNode[];
  viewport: CanvasViewport;
  /** 主画布视口的像素尺寸，用来画「当前可见范围」的框 */
  viewportSize: { width: number; height: number };
  /** 点击缩略图 → 把该世界坐标居中 */
  onJumpTo: (world: { x: number; y: number }) => void;
  /** 画布清单（下拉切换用）；<=1 张时收起下拉。 */
  canvases?: ChatCanvasEntry[];
  activeCanvasId?: string | null;
  onSwitchCanvas?: (canvasId: string) => void;
  /** 展开态（受控）。缺省内部自管。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
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
  canvases = [],
  activeCanvasId = null,
  onSwitchCanvas,
  open,
  onOpenChange,
  className,
}: CanvasMiniMapProps) {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_MQ).matches,
  );
  const [internalOpen, setInternalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const isOpen = open ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (onOpenChange) onOpenChange(next);
    else setInternalOpen(next);
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(MOBILE_MQ);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // 下拉开著时点外部/按 Esc 关闭。
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const activeTitle = canvases.find((c) => c.id === activeCanvasId)?.title || (canvases.length > 0 ? "未命名画布" : "画布");
  const canSwitch = canvases.length > 1 && !!onSwitchCanvas;

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
    <div ref={rootRef} data-canvas-interactive className={cn("absolute right-4 bottom-4", className)}>
      {!isOpen ? (
        // ── 收起态：常驻胶囊（当前画布名）
        <button
          type="button"
          data-canvas-interactive
          onClick={() => setOpen(true)}
          aria-label={`画布「${activeTitle}」，展开缩略图`}
          className="lg-float flex h-11 touch-manipulation items-center gap-2 rounded-full px-3.5 text-left transition-transform active:scale-[0.98]"
        >
          <MapIcon className="h-4 w-4 shrink-0 text-foreground/55" strokeWidth={2} />
          <span className="max-w-[40vw] truncate text-ios-caption1 font-medium text-foreground">{activeTitle}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 rotate-180 text-foreground/45" strokeWidth={2.5} />
        </button>
      ) : (
        <div className="relative">
          {/* 下拉：挂在外层（不受地图卡 overflow-hidden 裁切），浮在卡的上方 */}
          {menuOpen && canSwitch && (
            <div
              data-canvas-interactive
              className="lg-sheet absolute bottom-full right-0 mb-2 max-h-64 w-56 overflow-y-auto rounded-2xl p-1"
              role="listbox"
              aria-label="切换画布"
            >
              {canvases.map((c) => {
                const active = c.id === activeCanvasId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    data-canvas-interactive
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      if (!active) onSwitchCanvas?.(c.id);
                      setMenuOpen(false);
                    }}
                    className={cn(
                      "flex min-h-11 w-full touch-manipulation items-center gap-2 rounded-xl px-2.5 py-2 text-left text-ios-caption1 transition-colors max-sm:min-h-12",
                      active ? "bg-ios-blue/10 font-medium text-ios-blue" : "text-foreground/80 hover:bg-black/5",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{c.title || "未命名画布"}</span>
                    {c.isPrimary && <span className="shrink-0 rounded-full bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] text-foreground/60">主</span>}
                    {active && <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={3} />}
                  </button>
                );
              })}
            </div>
          )}

          <div className="lg-float overflow-hidden rounded-2xl">
            <div className="flex items-center justify-between gap-2 px-3 pt-2">
              {canSwitch ? (
                <button
                  type="button"
                  data-canvas-interactive
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-haspopup="listbox"
                  aria-expanded={menuOpen}
                  title="切换画布"
                  className="flex min-h-8 min-w-0 touch-manipulation items-center gap-1 rounded-lg py-1 pl-1 pr-1.5 text-ios-caption2 font-medium text-foreground/80 transition-colors hover:bg-black/5 max-sm:min-h-11"
                >
                  <span className="max-w-[160px] truncate">{activeTitle}</span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-foreground/45" strokeWidth={2.5} />
                </button>
              ) : (
                <span className="min-h-8 truncate py-1 text-ios-caption2 font-medium text-muted-foreground max-sm:min-h-11">{activeTitle}</span>
              )}
              <button
                type="button"
                data-canvas-interactive
                onClick={() => {
                  setMenuOpen(false);
                  setOpen(false);
                }}
                aria-label="收起缩略图"
                className="flex h-5 w-5 shrink-0 touch-manipulation items-center justify-center rounded-full text-foreground/45 transition-colors hover:bg-black/5 hover:text-muted-foreground max-sm:h-11 max-sm:w-11 max-sm:active:bg-black/5"
              >
                <X className="h-3.5 w-3.5 max-sm:h-5 max-sm:w-5" />
              </button>
            </div>
            <div className="relative" style={{ width: mapWidth, height: mapHeight }}>
              {nodes.length === 0 ? (
                <div className="flex h-full w-full items-center justify-center">
                  <span className="text-ios-caption1 text-foreground/45">暂无节点</span>
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
                    className="pointer-events-none absolute border border-ios-blue/90 bg-ios-blue/10"
                    style={{ left: rectLeft, top: rectTop, width: rectWidth, height: rectHeight }}
                  />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { CanvasMiniMap };
export default CanvasMiniMap;
