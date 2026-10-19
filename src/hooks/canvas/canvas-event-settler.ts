// SSE 事件的最终一致性收敛（settle 对账）—— 自 use-canvas-chat.ts 的
// handleCanvasEvent 内联闭包搬迁（2026-08-16 根因修复的逻辑，语义逐行保留）。
//
// gateway 对「上游无 task_id」的工具结果只发 image.done、不发
// canvas.node.updated，画布节点会永久卡 loading。这里用 image.done 的
// url 把节点落地：task_id 配对优先，回合结束时按序配对兜底。
"use client";

import { useCallback, useEffect, useRef } from "react";
import type { AgentImageDone, AgentImageFailed, AgentSseEvent } from "@/lib/agent-chat-types";
import type { CanvasReducerState } from "@/lib/canvas/reducer";
import { CanvasNodeType } from "@/lib/canvas/types";
import type { CanvasNode } from "@/lib/canvas/types";
import type { CanvasAction } from "./canvas-reducer-adapter";

/** useCanvasEventSettler 需要的共享物件（皆由主 hook 提供）。 */
export interface UseCanvasEventSettlerParams {
  /** 画布状态的最新值镜像 ref（render 期间同步赋值）—— settle 读它拿当前节点。 */
  canvasRef: { current: CanvasReducerState };
  /** 进度节流表：node_id → 计时器（落地时作废排队中的进度帧）。 */
  progressTimerRef: { current: Map<string, number> };
  /** 进度节流表：node_id → 最新待送事件。 */
  progressPendingRef: { current: Map<string, AgentSseEvent> };
  dispatchCanvas: (action: CanvasAction) => void;
}

/**
 * 前端超时兜底：loading 节点超过此时长（15 分钟）且从未收到任何成功/失败帧
 * （poller 挂了、SSE 断了、事件丢了——任何一环都可能），节点自行置
 * 「疑似失败，可重试」，宁可误报也不让用户对著永远转圈的节点干等。
 */
const LOADING_SUSPECT_TIMEOUT_MS = 15 * 60 * 1000;
const SUSPECT_SCAN_INTERVAL_MS = 60 * 1000;

/** settle 对账域：image.done 伫列 + task_id/按序配对落地。 */
export function useCanvasEventSettler(params: UseCanvasEventSettlerParams) {
  const { canvasRef, progressTimerRef, progressPendingRef, dispatchCanvas } = params;

  // 最终一致性收敛：image.done 的 URL 伫列，供 settleStaleNodes 对账用。
  const imageDoneQueueRef = useRef<AgentImageDone[]>([]);
  // 节点进入 loading 态的本地时刻（node_id → epoch ms），超时兜底用。
  const loadingSinceRef = useRef<Map<string, number>>(new Map());

  const isPendingSettledNode = useCallback((n: CanvasNode): boolean =>
    (n.type === CanvasNodeType.Image || n.type === CanvasNodeType.Video) &&
    !n.metadata?.content &&
    (!n.metadata?.status || n.metadata.status === "loading"), []);

  const settleNodeWithUrl = useCallback((nodeId: string, url: string, costCoins?: number) => {
    // 落地与 canvas.node.updated 同语义：该节点排队中的进度帧作废；
    // 结果落地不可撤（与 gateway 的 updated 事件一致，不推历史快照）。
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

  /** 失败落地：节点置 error 态 + 人话 errorDetails（NodeBody 已有 error 渲染）。 */
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
   * image.failed 收敛（与 settleCandidateNode 对称）：task_id 精确配对优先，
   * 没配上就按序配对第一个 pending 节点——失败帧绝不能因为配不上就丢掉，
   * 那正是「永远生成中」黑洞的形状。
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
    // 第一轮：task_id 精确配对。
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
    // 第二轮：剩余节点按序配对（gateway 建节点与发 image.done 同顺序）。
    for (const node of pending) {
      if (settled.has(node.id)) continue;
      const hit = queue.shift();
      if (!hit) break;
      settleNodeWithUrl(node.id, hit.url, hit.cost_coins);
    }
    // 回合已结束：残留的 url 不再跨回合污染（节点都不存在了，url 无家可归）。
    imageDoneQueueRef.current.length = 0;
  }, [canvasRef, isPendingSettledNode, settleNodeWithUrl]);

  // 超时兜底：扫描 loading 节点的本地计时，超过 15 分钟置「疑似失败，可重试」。
  // 这是最后一道防线——poller 挂掉、SSE 断线丢帧、任何一环哑掉时，用户仍能在
  // 15 分钟内得到确定性的错误终态，而不是无限转圈。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const since = loadingSinceRef.current;
      const now = Date.now();
      const liveIds = new Set<string>();
      for (const node of canvasRef.current.nodes) {
        liveIds.add(node.id);
        if (!isPendingSettledNode(node)) {
          since.delete(node.id);
          continue;
        }
        if (!since.has(node.id)) since.set(node.id, now);
        else if (now - since.get(node.id)! > LOADING_SUSPECT_TIMEOUT_MS) {
          settleNodeWithFailure(node.id, "等待超时（15 分钟无结果），疑似失败，可重试");
        }
      }
      for (const id of since.keys()) {
        if (!liveIds.has(id)) since.delete(id);
      }
    }, SUSPECT_SCAN_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [canvasRef, isPendingSettledNode, settleNodeWithFailure]);

  return { imageDoneQueueRef, settleCandidateNode, settleFailedNode, settleStaleNodes };
}
