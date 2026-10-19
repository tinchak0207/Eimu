"use client";

// CanvasZoomControls —— 画布缩放控制胶囊（垂直，iOS 白玻璃质感）。
//
// 纯受控元件：只负责把使用者意图翻译成 onZoomTo(k) / onFit / onHelp，
// 缩放锚点（视口中心）与实际套用由宿主实作。由上到下：放大（×1.25）、
// 纵向滑杆（log 刻度 5%–500%，等距 = 等倍率）、缩小（÷1.25）、
// 当前百分比（点击重置 100%）、适应视图、快捷键帮助、缩略图开关、审查入口。
// 根节点带 data-canvas-interactive，InfiniteCanvas 手势层才会放行胶囊内
// 的指针事件（否则拖滑杆 = 平移画布）。

import { useCallback, useRef, useState } from "react";
import { ClipboardCheck, Keyboard, Layers, LayoutGrid, Map as MapIcon, Maximize, Minus, Plus, ScanLine, Square, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { LOD_LABEL, LOD_TARGET_SCALE, type CanvasLod } from "@/lib/canvas/lod";

export interface CanvasZoomControlsProps {
  /** 当前缩放 k（0.05–5） */
  scale: number;
  /** 设定缩放（以视口中心为锚，由宿主实作） */
  onZoomTo: (k: number) => void;
  /** 适应视图 */
  onFit: () => void;
  /** 打开快捷键帮助 */
  onHelp: () => void;
  /** 缩略图开关（2026-09-27：缩略图预设收合，入口并进本胶囊） */
  minimapOpen?: boolean;
  onToggleMinimap?: () => void;
  /** 资产与分镜审查入口（2026-09-27：左下孤儿按钮并进本胶囊） */
  reviewActive?: boolean;
  reviewPendingCount?: number;
  onToggleReview?: () => void;
  /** 语义缩放（2026-09-30）：当前层级；有值才渲染「鸟瞰/协作/工程」三段按钮。 */
  lod?: CanvasLod;
  /** 是否提供工程层（窄萤幕 false → 不出「工程」钮）。 */
  allowEngineering?: boolean;
  /** 三段按钮的宿主接管（相机飞行转场）；缺省＝onZoomTo(目标倍率) 瞬切。 */
  onSelectLod?: (lod: CanvasLod) => void;
  className?: string;
}

/** 缩放上下限（5%–500%，与 props 契约一致）。 */
const MIN_SCALE = 0.05;
const MAX_SCALE = 5;
/** 加减按钮的倍率步进。 */
const BUTTON_STEP = 1.25;
/** 滑杆聚焦时方向键的倍率步进。 */
const KEY_STEP = 1.1;

const clampScale = (k: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, k));

/** k → 滑杆位置 t ∈ [0,1]（log 刻度：滑杆等距 = 缩放等倍率）。 */
const scaleToT = (k: number) =>
  Math.log(clampScale(k) / MIN_SCALE) / Math.log(MAX_SCALE / MIN_SCALE);

/** 滑杆位置 t ∈ [0,1] → k（log 刻度反函数）。 */
const tToScale = (t: number) =>
  MIN_SCALE * Math.pow(MAX_SCALE / MIN_SCALE, Math.min(1, Math.max(0, t)));

/** 圆形小按钮统一皮肤（28px 热区 + hover 态）。 */
/** 语义缩放四层的图示（画布＝多层画布、鸟瞰＝阶段牌组、协作＝单卡、工程＝扫描透析）；文字进 title/aria。 */
const LOD_ICON: Record<CanvasLod, LucideIcon> = { 0: Layers, 1: LayoutGrid, 2: Square, 3: ScanLine };

const BUTTON_CLASS =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent";

function CanvasZoomControls({
  scale,
  onZoomTo,
  onFit,
  onHelp,
  minimapOpen,
  onToggleMinimap,
  reviewActive,
  reviewPendingCount = 0,
  onToggleReview,
  lod,
  allowEngineering = true,
  onSelectLod,
  className,
}: CanvasZoomControlsProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const t = scaleToT(scale);
  const percent = Math.round(scale * 100);

  // 由指针纵座标反推缩放（滑杆顶部 = 500%，底部 = 5%）。
  const zoomFromClientY = useCallback(
    (clientY: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      if (rect.height <= 0) return;
      onZoomTo(tToScale(1 - (clientY - rect.top) / rect.height));
    },
    [onZoomTo],
  );

  return (
    <div
      data-canvas-interactive
      aria-label="缩放控制"
      className={cn(
        "inline-flex w-11 select-none flex-col items-center gap-0.5 rounded-full lg-float p-1.5",
        className,
      )}
    >
      <button
        type="button"
        className={BUTTON_CLASS}
        title="放大"
        aria-label="放大"
        disabled={scale >= MAX_SCALE - 1e-6}
        onClick={() => onZoomTo(clampScale(scale * BUTTON_STEP))}
      >
        <Plus className="h-4 w-4" />
      </button>

      {/* 纵向滑杆（自绘，免去 input[type=range] 竖排的跨浏览器差异）：
          28px 宽热区，pointer capture 让拖出滑杆后仍持续跟手。 */}
      <div
        role="slider"
        aria-label="缩放"
        aria-orientation="vertical"
        aria-valuemin={5}
        aria-valuemax={500}
        aria-valuenow={percent}
        aria-valuetext={`${percent}%`}
        tabIndex={0}
        className="relative h-24 w-7 shrink-0 cursor-pointer touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
          zoomFromClientY(e.clientY);
        }}
        onPointerMove={(e) => {
          if (dragging) zoomFromClientY(e.clientY);
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") {
            e.preventDefault();
            onZoomTo(clampScale(scale * KEY_STEP));
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            onZoomTo(clampScale(scale / KEY_STEP));
          }
        }}
      >
        {/* 轨道上下各内缩 7px（半个 thumb），thumb 到极值也不溢出热区 */}
        <div ref={trackRef} className="absolute inset-x-0 bottom-[7px] top-[7px]">
          <div className="absolute left-1/2 top-0 h-full w-[3px] -translate-x-1/2 rounded-full bg-black/10" />
          <div
            className="absolute bottom-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-ios-blue"
            style={{ height: `${t * 100}%` }}
          />
          <div
            className={cn(
              "absolute left-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.28)] ring-1 ring-black/5 transition-transform",
              dragging && "scale-110",
            )}
            style={{ top: `${(1 - t) * 100}%` }}
          />
        </div>
      </div>

      <button
        type="button"
        className={BUTTON_CLASS}
        title="缩小"
        aria-label="缩小"
        disabled={scale <= MIN_SCALE + 1e-6}
        onClick={() => onZoomTo(clampScale(scale / BUTTON_STEP))}
      >
        <Minus className="h-4 w-4" />
      </button>

      <div className="my-0.5 h-px w-4 bg-black/10" />

      {/* 当前百分比（四舍五入整数；点击重置 100%） */}
      <button
        type="button"
        className="flex h-7 w-full items-center justify-center rounded-full text-ios-caption2 font-medium tabular-nums text-foreground transition-colors hover:bg-black/5"
        title="重置为 100%"
        onClick={() => onZoomTo(1)}
      >
        {percent}%
      </button>

      <div className="my-0.5 h-px w-4 bg-black/10" />

      {/* 语义缩放四段：点击以中心为锚缩到该层目标倍率；高亮当前层。 */}
      {lod !== undefined && (
        <>
          {([0, 1, 2, 3] as const)
            .filter((level) => level !== 3 || allowEngineering)
            .map((level) => (
              <button
                key={level}
                type="button"
                className={cn(
                  BUTTON_CLASS,
                  lod === level && "bg-ios-blue/10 text-ios-blue hover:bg-ios-blue/15 hover:text-ios-blue",
                )}
                title={`${LOD_LABEL[level]}视图`}
                aria-label={`${LOD_LABEL[level]}视图`}
                aria-pressed={lod === level}
                onClick={() => (onSelectLod ? onSelectLod(level) : onZoomTo(LOD_TARGET_SCALE[level]))}
              >
                {(() => {
                  const Icon = LOD_ICON[level];
                  return <Icon className="h-4 w-4" />;
                })()}
              </button>
            ))}
          <div className="my-0.5 h-px w-4 bg-black/10" />
        </>
      )}

      <button type="button" className={BUTTON_CLASS} title="适应视图" aria-label="适应视图" onClick={onFit}>
        <Maximize className="h-4 w-4" />
      </button>
      <button type="button" className={BUTTON_CLASS} title="键盘快捷键" aria-label="键盘快捷键" onClick={onHelp}>
        <Keyboard className="h-4 w-4" />
      </button>
      {onToggleMinimap && (
        <button
          type="button"
          className={cn(BUTTON_CLASS, minimapOpen && "bg-ios-blue/10 text-ios-blue hover:bg-ios-blue/15 hover:text-ios-blue")}
          title="缩略图"
          aria-label="缩略图"
          aria-pressed={minimapOpen}
          onClick={onToggleMinimap}
        >
          <MapIcon className="h-4 w-4" />
        </button>
      )}
      {onToggleReview && (
        <>
          <div className="my-0.5 h-px w-4 bg-black/10" />
          <button
            type="button"
            className={cn(BUTTON_CLASS, "relative", reviewActive && "bg-ios-blue/10 text-ios-blue hover:bg-ios-blue/15 hover:text-ios-blue")}
            title={reviewPendingCount > 0 ? `审查 · 待确认 ${reviewPendingCount}` : "审查"}
            aria-label="资产与分镜审查"
            aria-pressed={reviewActive}
            onClick={onToggleReview}
          >
            <ClipboardCheck className="h-4 w-4" />
            {reviewPendingCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-ios-red px-1 text-ios-caption2 font-semibold leading-none text-white tabular-nums">
                {reviewPendingCount > 9 ? "9+" : reviewPendingCount}
              </span>
            )}
          </button>
        </>
      )}
    </div>
  );
}

export { CanvasZoomControls };
export default CanvasZoomControls;
