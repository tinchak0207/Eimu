// SSE 事件的最終一致性收斂（settle 對賬）—— 自 use-canvas-chat.ts 的
// handleCanvasEvent 內聯閉包搬遷（2026-08-16 根因修復的邏輯，語義逐行保留）。
//
// gateway 對「上游無 task_id」的工具結果只發 image.done、不發
// canvas.node.updated，畫布節點會永久卡 loading。這裡用 image.done 的
// url 把節點落地：task_id 配對優先，回合結束時按序配對兜底。
"use client";

import { useCallback, useEffect, useRef } from "react";
import type { AgentImageDone, AgentImageFailed, AgentSseEvent } from "@/lib/agent-chat-types";
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

/**
 * 前端超時兜底：loading 節點超過此時長（15 分鐘）且從未收到任何成功/失敗幀
 * （poller 掛了、SSE 斷了、事件丟了——任何一環都可能），節點自行置
 * 「疑似失敗，可重試」，寧可誤報也不讓用戶對著永遠轉圈的節點乾等。
 */
const LOADING_SUSPECT_TIMEOUT_MS = 15 * 60 * 1000;
const SUSPECT_SCAN_INTERVAL_MS = 60 * 1000;

/** settle 對賬域：image.done 佇列 + task_id/按序配對落地。 */
export function useCanvasEventSettler(params: UseCanvasEventSettlerParams) {
  const { canvasRef, progressTimerRef, progressPendingRef, dispatchCanvas } = params;

  // 最終一致性收斂：image.done 的 URL 佇列，供 settleStaleNodes 對賬用。
  const imageDoneQueueRef = useRef<AgentImageDone[]>([]);
  // 節點進入 loading 態的本地時刻（node_id → epoch ms），超時兜底用。
  const loadingSinceRef = useRef<Map<string, number>>(new Map());

  const isPendingSettledNode = useCallback((n: CanvasNode): boolean =>
    (n.type === CanvasNodeType.Image || n.type === CanvasNodeType.Video) &&
    !n.metadata?.content &&
    (!n.metadata?.status || n.metadata.status === "loading"), []);

  const settleNodeWithUrl = useCallback((nodeId: string, url: string, costCoins?: number) => {
    // 落地與 canvas.node.updated 同語義：該節點排隊中的進度幀作廢；
    // 結果落地不可撤（與 gateway 的 updated 事件一致，不推歷史快照）。
    loadingSinceRef.current.delete(nodeId);
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

  /** 失敗落地：節點置 error 態 + 人話 errorDetails（NodeBody 已有 error 渲染）。 */
  const settleNodeWithFailure = useCallback(
    (nodeId: string, reason: string) => {
      loadingSinceRef.current.delete(nodeId);
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
            patch: { status: "error" as const, errorDetails: reason },
          },
        },
      });
    },
    [dispatchCanvas, progressTimerRef, progressPendingRef],
  );

  /**
   * image.failed 收斂（與 settleCandidateNode 對稱）：task_id 精確配對優先，
   * 沒配上就按序配對第一個 pending 節點——失敗幀絕不能因為配不上就丟掉，
   * 那正是「永遠生成中」黑洞的形狀。
   */
  const settleFailedNode = useCallback(
    (failed: AgentImageFailed) => {
      const state = canvasRef.current;
      const pending = state.nodes.filter(isPendingSettledNode);
      if (pending.length === 0) return;
      // G-FE 合同：human_message（中文短句）优先，缺省回落原 reason/退款话术。
      const reason =
        failed.human_message && failed.human_message.length > 0
          ? failed.human_message
          : failed.refunded === true
            ? "这张图没排上队，费用已退回，可重试"
            : failed.reason || "生成失败，可重试";
      const target =
        (failed.task_id
          ? pending.find((n) => !!n.metadata?.imageTaskId && n.metadata.imageTaskId === failed.task_id)
          : undefined) ?? pending[0];
      settleNodeWithFailure(target.id, reason);
    },
    [canvasRef, isPendingSettledNode, settleNodeWithFailure],
  );

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

  // 超時兜底：掃描 loading 節點的本地計時，超過 15 分鐘置「疑似失敗，可重試」。
  // 這是最後一道防線——poller 掛掉、SSE 斷線丟幀、任何一環啞掉時，用戶仍能在
  // 15 分鐘內得到確定性的錯誤終態，而不是無限轉圈。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const since = loadingSinceRef.current;
      const now = Date.now();
      for (const node of canvasRef.current.nodes) {
        if (!isPendingSettledNode(node)) {
          since.delete(node.id);
          continue;
        }
        if (!since.has(node.id)) since.set(node.id, now);
        else if (now - since.get(node.id)! > LOADING_SUSPECT_TIMEOUT_MS) {
          settleNodeWithFailure(node.id, "等待超时（15 分钟无结果），疑似失败，可重试");
        }
      }
    }, SUSPECT_SCAN_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [canvasRef, isPendingSettledNode, settleNodeWithFailure]);

  return { imageDoneQueueRef, settleCandidateNode, settleFailedNode, settleStaleNodes };
}
