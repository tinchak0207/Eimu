"use client";

// 畫布即時視口（2026-10-01 效能審計 P0-1）。
//
// 宿主的 viewport state 在 use-canvas-chat（掛在 ImagePlayground 根）：每幀平移/縮放/飛行都 setState
// ＝整站（聊天面板、素材庫、首頁 SEO 區塊…）每幀重渲染，實測佔飛行主線程 44%。
// 這裡把「每幀」留在 CanvasEmbed 本地：live 視口即時更新畫布，停手 VIEWPORT_COMMIT_MS 後才回寫宿主
// （存檔、agent 快照、undo 都只關心落點）。宿主側主動改視口（fitView / 開專案 / agent op / undo）照常採用。

import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasViewport } from "@/lib/canvas/types";

export const VIEWPORT_COMMIT_MS = 150;

type ViewportUpdate = CanvasViewport | ((prev: CanvasViewport) => CanvasViewport);

function sameViewport(a: CanvasViewport, b: CanvasViewport): boolean {
  return a.x === b.x && a.y === b.y && a.k === b.k;
}

export function useLiveViewport(hostViewport: CanvasViewport, hostSetViewport: (next: CanvasViewport) => void) {
  const [viewport, setLive] = useState(hostViewport);
  // 視口變動中（尚未回寫宿主）：節點拿量化倍率，免得每幀都重渲染。
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

  // 宿主側改了視口（不是我們回寫的那一筆）→ 採用，並丟掉未回寫的 live 值。
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

  // 卸載前把最後一筆寫回宿主（存檔要記住落點）。
  useEffect(() => flush, [flush]);

  return { viewport, viewportRef: liveRef, setViewport, flush, moving };
}
