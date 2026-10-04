"use client";

// 画布即时视口（2026-10-01 效能审计 P0-1）。
//
// 宿主的 viewport state 在 use-canvas-chat（挂在 ImagePlayground 根）：每帧平移/缩放/飞行都 setState
// ＝整站（聊天面板、素材库、首页 SEO 区块…）每帧重渲染，实测占飞行主线程 44%。
// 这里把「每帧」留在 CanvasEmbed 本地：live 视口即时更新画布，停手 VIEWPORT_COMMIT_MS 后才回写宿主
// （存档、agent 快照、undo 都只关心落点）。宿主侧主动改视口（fitView / 开专案 / agent op / undo）照常采用。

import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasViewport } from "@/lib/canvas/types";

export const VIEWPORT_COMMIT_MS = 150;

type ViewportUpdate = CanvasViewport | ((prev: CanvasViewport) => CanvasViewport);

function sameViewport(a: CanvasViewport, b: CanvasViewport): boolean {
  return a.x === b.x && a.y === b.y && a.k === b.k;
}

export function useLiveViewport(hostViewport: CanvasViewport, hostSetViewport: (next: CanvasViewport) => void) {
  const [viewport, setLive] = useState(hostViewport);
  // 视口变动中（尚未回写宿主）：节点拿量化倍率，免得每帧都重渲染。
  const [moving, setMoving] = useState(false);
  const liveRef = useRef(hostViewport);
  const committedRef = useRef(hostViewport);
  const timerRef = useRef<number | null>(null);
  const hostSetRef = useRef(hostSetViewport);
  hostSetRef.current = hostSetViewport;

  const flush = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
    committedRef.current = liveRef.current;
    hostSetRef.current(liveRef.current);
    setMoving(false);
  }, []);

  const setViewport = useCallback(
    (next: ViewportUpdate) => {
      const prev = liveRef.current;
      const value = typeof next === "function" ? next(prev) : next;
      if (sameViewport(value, prev)) return;
      liveRef.current = value;
      setLive(value);
      if (timerRef.current === null) setMoving(true);
      else window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(flush, VIEWPORT_COMMIT_MS);
    },
    [flush],
  );

  // 宿主侧改了视口（不是我们回写的那一笔）→ 采用，并丢掉未回写的 live 值。
  useEffect(() => {
    if (sameViewport(hostViewport, committedRef.current)) return;
    committedRef.current = hostViewport;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    liveRef.current = hostViewport;
    setLive(hostViewport);
    setMoving(false);
  }, [hostViewport]);

  // 卸载前把最后一笔写回宿主（存档要记住落点）。
  useEffect(() => flush, [flush]);

  return { viewport, viewportRef: liveRef, setViewport, flush, moving };
}
