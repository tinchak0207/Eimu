"use client";

// CanvasZoomControls —— 畫布縮放控制膠囊（垂直，iOS 白玻璃質感）。
//
// 純受控元件：只負責把使用者意圖翻譯成 onZoomTo(k) / onFit / onHelp，
// 縮放錨點（視口中心）與實際套用由宿主實作。由上到下：放大（×1.25）、
// 縱向滑桿（log 刻度 5%–500%，等距 = 等倍率）、縮小（÷1.25）、
// 當前百分比（點擊重置 100%）、適應視圖、快捷鍵幫助。
// 根節點帶 data-canvas-interactive，InfiniteCanvas 手勢層才會放行膠囊內
// 的指針事件（否則拖滑桿 = 平移畫布）。

import { useCallback, useRef, useState } from "react";
import { Keyboard, Maximize, Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CanvasZoomControlsProps {
  /** 當前縮放 k（0.05–5） */
  scale: number;
  /** 設定縮放（以視口中心為錨，由宿主實作） */
  onZoomTo: (k: number) => void;
  /** 適應視圖 */
  onFit: () => void;
  /** 打開快捷鍵幫助 */
  onHelp: () => void;
  className?: string;
}

/** 縮放上下限（5%–500%，與 props 契約一致）。 */
const MIN_SCALE = 0.05;
const MAX_SCALE = 5;
/** 加減按鈕的倍率步進。 */
const BUTTON_STEP = 1.25;
/** 滑桿聚焦時方向鍵的倍率步進。 */
const KEY_STEP = 1.1;

const clampScale = (k: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, k));

/** k → 滑桿位置 t ∈ [0,1]（log 刻度：滑桿等距 = 縮放等倍率）。 */
const scaleToT = (k: number) =>
  Math.log(clampScale(k) / MIN_SCALE) / Math.log(MAX_SCALE / MIN_SCALE);

/** 滑桿位置 t ∈ [0,1] → k（log 刻度反函數）。 */
const tToScale = (t: number) =>
  MIN_SCALE * Math.pow(MAX_SCALE / MIN_SCALE, Math.min(1, Math.max(0, t)));

/** 圓形小按鈕統一皮膚（28px 熱區 + hover 態）。 */
const BUTTON_CLASS =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent";

function CanvasZoomControls({ scale, onZoomTo, onFit, onHelp, className }: CanvasZoomControlsProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const t = scaleToT(scale);
  const percent = Math.round(scale * 100);

  // 由指針縱座標反推縮放（滑桿頂部 = 500%，底部 = 5%）。
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

      {/* 縱向滑桿（自繪，免去 input[type=range] 豎排的跨瀏覽器差異）：
          28px 寬熱區，pointer capture 讓拖出滑桿後仍持續跟手。 */}
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
        {/* 軌道上下各內縮 7px（半個 thumb），thumb 到極值也不溢出熱區 */}
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

      {/* 當前百分比（四捨五入整數；點擊重置 100%） */}
      <button
        type="button"
        className="flex h-7 w-full items-center justify-center rounded-full text-ios-caption2 font-medium tabular-nums text-foreground transition-colors hover:bg-black/5"
        title="重置为 100%"
        onClick={() => onZoomTo(1)}
      >
        {percent}%
      </button>

      <div className="my-0.5 h-px w-4 bg-black/10" />

      <button type="button" className={BUTTON_CLASS} title="适应视图" aria-label="适应视图" onClick={onFit}>
        <Maximize className="h-4 w-4" />
      </button>
      <button type="button" className={BUTTON_CLASS} title="键盘快捷键" aria-label="键盘快捷键" onClick={onHelp}>
        <Keyboard className="h-4 w-4" />
      </button>
    </div>
  );
}

export { CanvasZoomControls };
export default CanvasZoomControls;
