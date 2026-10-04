"use client";

// 相机飞行（语义缩放打磨，2026-09-30）：rAF 驱动 setViewport，插值走
// `interpolateViewport`（世界中心线性＋k 对数）。因为所有 LOD 转场都是 k 的连续函数，
// 飞行途中聚合/散开/透析动画自动发生——飞行本身就是转场。
//
// 使用者一有新的滚轮/按下/触控输入就立刻中止（相机永远听人的）；reduceMotion 直接跳终点。

import { useCallback, useEffect, useRef } from "react";
import type { CanvasViewport } from "@/lib/canvas/types";
import { easeInOutSine, interpolateViewport, warpFlightProgress } from "@/lib/canvas/lod";

export interface CameraFlightOptions {
  duration?: number;
  easing?: (t: number) => number;
  /** 正常落地才呼叫（被使用者输入中止不呼叫）。 */
  onDone?: () => void;
  /** 起飞视口（预设＝当前视口）。用于「先无感对位、再起飞」：同帧 setViewport 尚未回写 ref。 */
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
        // 带内减速：形变占据飞行大半时间（见 warpFlightProgress）。
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

  // 使用者输入即中止（capture 阶段，先于画布手势层）。
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
