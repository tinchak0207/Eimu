// SSE 事件的最終一致性收斂（settle 對賬）—— 自 use-canvas-chat.ts 的
// handleCanvasEvent 內聯閉包搬遷（2026-08-16 根因修復的邏輯，語義逐行保留）。
//
// gateway 對「上游無 task_id」的工具結果只發 image.done、不發
// canvas.node.updated，畫布節點會永久卡 loading。這裡用 image.done 的
// url 把節點落地：task_id 配對優先，回合結束時按序配對兜底。
"use client";

import { useCallback, useRef } from "react";
import type { AgentImageDone, AgentSseEvent } from "@/lib/agent-chat-types";
import type { CanvasReducerState } from "@/lib/canvas/reducer";
import { CanvasNodeType } from "@/lib/canvas/types";
import type { CanvasNode } from "@/lib/canvas/types";
import type { CanvasAction } from "./canvas-reducer-adapter";

/** useCanvasEventSettler 需要的共享物件（皆由主 hook 提供）。 */
export interface UseCanvasEventSettlerParams {
  /** 畫布狀態的最新值鏡像 ref（render 期間同步賦值）—— settle 讀它拿當前節點。 */
  canvasRef: { current: CanvasReducerState };
  /** 進度節流表：node_id → 計時器（落地時作廢排隊中的進度幀）。 */
  progressTimerRef: { current: Map<string, number> };
  /** 進度節流表：node_id → 最新待送事件。 */
  progressPendingRef: { current: Map<string, AgentSseEvent> };
  dispatchCanvas: (action: CanvasAction) => void;
}

/** settle 對賬域：image.done 佇列 + task_id/按序配對落地。 */
export function useCanvasEventSettler(params: UseCanvasEventSettlerParams) {
  const { canvasRef, progressTimerRef, progressPendingRef, dispatchCanvas } = params;

  // 最終一致性收斂：image.done 的 URL 佇列，供 settleStaleNodes 對賬用。
  const imageDoneQueueRef = useRef<AgentImageDone[]>([]);

  const isPendingSettledNode = useCallback((n: CanvasNode): boolean =>
    (n.type === CanvasNodeType.Image || n.type === CanvasNodeType.Video) &&
    !n.metadata?.content &&
    (!n.metadata?.status || n.metadata.status === "loading"), []);

  const settleNodeWithUrl = useCallback((nodeId: string, url: string, costCoins?: number) => {
    // 落地與 canvas.node.updated 同語義：該節點排隊中的進度幀作廢；
    // 結果落地不可撤（與 gateway 的 updated 事件一致，不推歷史快照）。
    const t = progressTimerRef.current.get(nodeId);
    if (t !== undefined) {
      window.clearTimeout(t);
      progressTimerRef.current.delete(nodeId);
      progressPendingRef.current.delete(nodeId);
    }
    dispatchCanvas({
      type: "event",
      event: {
        name: "canvas.node.updated",
        event_id: 0,
        data: {
          unit_id: "",
          node_id: nodeId,
          patch: { status: "success" as const },
          url,
          ...(typeof costCoins === "number" ? { cost_coins: costCoins } : {}),
        },
      },
    });
  }, [dispatchCanvas, progressTimerRef, progressPendingRef]);

  const settleCandidateNode = useCallback((done: AgentImageDone) => {
    if (!done.url) return;
    const state = canvasRef.current;
    const target = state.nodes.find(
      (n) => isPendingSettledNode(n) && !!n.metadata?.imageTaskId && n.metadata.imageTaskId === done.task_id,
    );
    if (!target) return;
    const queue = imageDoneQueueRef.current;
    const idx = queue.findIndex((q) => q.url === done.url);
    if (idx >= 0) queue.splice(idx, 1);
    settleNodeWithUrl(target.id, done.url, done.cost_coins);
  }, [canvasRef, isPendingSettledNode, settleNodeWithUrl]);

  const settleStaleNodes = useCallback(() => {
    const queue = imageDoneQueueRef.current;
    if (queue.length === 0) return;
    const pending = canvasRef.current.nodes.filter(isPendingSettledNode);
    if (pending.length === 0) return;
    const settled = new Set<string>();
    // 第一輪：task_id 精確配對。
    for (const node of pending) {
      const taskId = node.metadata?.imageTaskId;
      if (!taskId) continue;
      const idx = queue.findIndex((q) => q.task_id === taskId);
      if (idx >= 0) {
        const [hit] = queue.splice(idx, 1);
        settleNodeWithUrl(node.id, hit.url, hit.cost_coins);
        settled.add(node.id);
      }
    }
    // 第二輪：剩餘節點按序配對（gateway 建節點與發 image.done 同順序）。
    for (const node of pending) {
      if (settled.has(node.id)) continue;
      const hit = queue.shift();
      if (!hit) break;
      settleNodeWithUrl(node.id, hit.url, hit.cost_coins);
    }
    // 回合已結束：殘留的 url 不再跨回合污染（節點都不存在了，url 無家可歸）。
    imageDoneQueueRef.current.length = 0;
  }, [canvasRef, isPendingSettledNode, settleNodeWithUrl]);

  return { imageDoneQueueRef, settleCandidateNode, settleStaleNodes };
}
