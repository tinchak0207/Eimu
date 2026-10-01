"use client";

// 相機飛行（語義縮放打磨，2026-09-30）：rAF 驅動 setViewport，插值走
// `interpolateViewport`（世界中心線性＋k 對數）。因為所有 LOD 轉場都是 k 的連續函數，
// 飛行途中聚合/散開/透析動畫自動發生——飛行本身就是轉場。
//
// 使用者一有新的滾輪/按下/觸控輸入就立刻中止（相機永遠聽人的）；reduceMotion 直接跳終點。

import { useCallback, useEffect, useRef } from "react";
import type { CanvasViewport } from "@/lib/canvas/types";
import { easeInOutSine, interpolateViewport, warpFlightProgress } from "@/lib/canvas/lod";

export interface CameraFlightOptions {
  duration?: number;
  easing?: (t: number) => number;
  /** 正常落地才呼叫（被使用者輸入中止不呼叫）。 */
  onDone?: () => void;
  /** 起飛視口（預設＝當前視口）。用於「先無感對位、再起飛」：同幀 setViewport 尚未回寫 ref。 */
  from?: CanvasViewport;
}

export interface UseCameraFlightArgs {
  setViewport: (next: CanvasViewport) => void;
  viewportRef: React.MutableRefObject<CanvasViewport>;
  sizeRef: React.MutableRefObject<{ width: number; height: number }>;
  containerRef: React.RefObject<HTMLElement | null>;
  reduceMotion: boolean;
}

export function useCameraFlight({ setViewport, viewportRef, sizeRef, containerRef, reduceMotion }: UseCameraFlightArgs) {
  const rafRef = useRef<number | null>(null);
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;

  const cancelFlight = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const flyTo = useCallback(
    (target: CanvasViewport, { duration = 560, easing = easeInOutSine, onDone, from: fromOverride }: CameraFlightOptions = {}) => {
      cancelFlight();
      const from = fromOverride ?? viewportRef.current;
      if (fromOverride) setViewport(fromOverride);
      const size = sizeRef.current;
      if (reduceMotionRef.current || duration <= 0 || size.width <= 0) {
        setViewport(target);
        onDone?.();
        return;
      }
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / duration);
        // 帶內減速：形變佔據飛行大半時間（見 warpFlightProgress）。
        setViewport(interpolateViewport(from, target, warpFlightProgress(from.k, target.k, easing(t)), size));
        if (t < 1) {
          rafRef.current = requestAnimationFrame(step);
        } else {
          rafRef.current = null;
          onDone?.();
        }
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [cancelFlight, setViewport, sizeRef, viewportRef],
  );

  // 使用者輸入即中止（capture 階段，先於畫布手勢層）。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const stop = () => cancelFlight();
    el.addEventListener("wheel", stop, { capture: true, passive: true });
    el.addEventListener("pointerdown", stop, { capture: true });
    el.addEventListener("touchstart", stop, { capture: true, passive: true });
    return () => {
      el.removeEventListener("wheel", stop, { capture: true });
      el.removeEventListener("pointerdown", stop, { capture: true });
      el.removeEventListener("touchstart", stop, { capture: true });
    };
  }, [containerRef, cancelFlight]);

  useEffect(() => cancelFlight, [cancelFlight]);

  return { flyTo, cancelFlight };
}
