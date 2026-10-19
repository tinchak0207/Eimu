// Wave C agent 画布操作伫列的纯函式（自 use-canvas-chat.ts 外围搬迁，2026-08-31 修 bug）；
// ops 一到即自动执行（画布操作自动化，无人工确认闸）。
//
// 背景：CanvasAgentOpsEvent 没有 session_id 栏位，原先用单一 nullable slot
// （setPendingAgentOps）存「待执行的一批操作」——第二个 canvas.ops 事件在第一个
// 还没被执行前抵达时会直接覆盖掉它，该 request_id 永远等不到
// postCanvasOpsResult，gateway 那头的工具调用只能等超时。且 resolve 时读的是
// sessionIdRef.current（呼叫当下的 session），不是事件抵达当下的 session ——
// 若使用者在操作落地前切了 session，回报会用错的 sid。
//
// 修法：Map<request_id, entry> 保序伫列（JS Map 迭代序 = 插入序），每笔 entry
// 带上「事件抵达当下」捕获的 session id。resolve（apply/dismiss）用 entry 自己
// 捕获的 sid，不用当下的 sessionIdRef。
//
// 对外仍只暴露伫列头（单一 CanvasAgentOpsEvent | null）——一次只处理一批，
// resolve 后自动前进到下一笔（CanvasEmbed 的 effect 一到即自动执行）。

import type { CanvasAgentOpsEvent } from "@/lib/canvas/types";

export interface AgentOpsQueueEntry {
  event: CanvasAgentOpsEvent;
  /** 事件抵达那一刻的 sessionId（不是 resolve 时的）——结果回报要用这个。 */
  capturedSessionId: string | null;
}

/** request_id → entry，Map 保插入序＝伫列序。 */
export type AgentOpsQueue = Map<string, AgentOpsQueueEntry>;

export function createAgentOpsQueue(): AgentOpsQueue {
  return new Map();
}

/**
 * 入队。同 request_id 重入＝gateway 重送同一批（合法重放，不是资料丢失）——
 * 直接覆盖该笔（连带更新捕获的 sid），伫列序不变（Map.set 对既有 key 不移动
 * 插入位置）。不同 request_id 一律追加，绝不覆盖伫列里其他笔。
 */
export function enqueueAgentOps(
  queue: AgentOpsQueue,
  event: CanvasAgentOpsEvent,
  capturedSessionId: string | null,
): AgentOpsQueue {
  const next = new Map(queue);
  next.set(event.request_id, { event, capturedSessionId });
  return next;
}

/** 移除指定 request_id（resolve 后从伫列摘除）。找不到则原样返回同一实例。 */
export function dequeueAgentOps(queue: AgentOpsQueue, requestId: string): AgentOpsQueue {
  if (!queue.has(requestId)) return queue;
  const next = new Map(queue);
  next.delete(requestId);
  return next;
}

/** 伫列头（最早入队、尚未 resolve 的一笔）。空伫列回 undefined。 */
export function getQueueHead(
  queue: AgentOpsQueue,
): { requestId: string; entry: AgentOpsQueueEntry } | undefined {
  const first = queue.entries().next();
  if (first.done) return undefined;
  const [requestId, entry] = first.value;
  return { requestId, entry };
}

/** 便捷读法：伫列头的事件本体（单一 pendingAgentOps，供宿主自动执行）。 */
export function getQueueHeadEvent(queue: AgentOpsQueue): CanvasAgentOpsEvent | null {
  return getQueueHead(queue)?.entry.event ?? null;
}
