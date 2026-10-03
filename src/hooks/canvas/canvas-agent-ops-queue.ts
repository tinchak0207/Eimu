// Wave C agent 畫布操作佇列的純函式（自 use-canvas-chat.ts 外圍搬遷，2026-08-31 修 bug）；
// ops 一到即自動執行（畫布操作自動化，無人工確認閘）。
//
// 背景：CanvasAgentOpsEvent 沒有 session_id 欄位，原先用單一 nullable slot
// （setPendingAgentOps）存「待執行的一批操作」——第二個 canvas.ops 事件在第一個
// 還沒被執行前抵達時會直接覆蓋掉它，該 request_id 永遠等不到
// postCanvasOpsResult，gateway 那頭的工具調用只能等超時。且 resolve 時讀的是
// sessionIdRef.current（呼叫當下的 session），不是事件抵達當下的 session ——
// 若使用者在操作落地前切了 session，回報會用錯的 sid。
//
// 修法：Map<request_id, entry> 保序佇列（JS Map 迭代序 = 插入序），每筆 entry
// 帶上「事件抵達當下」捕獲的 session id。resolve（apply/dismiss）用 entry 自己
// 捕獲的 sid，不用當下的 sessionIdRef。
//
// 對外仍只暴露佇列頭（單一 CanvasAgentOpsEvent | null）——一次只處理一批，
// resolve 後自動前進到下一筆（CanvasEmbed 的 effect 一到即自動執行）。

import type { CanvasAgentOpsEvent } from "@/lib/canvas/types";

export interface AgentOpsQueueEntry {
  event: CanvasAgentOpsEvent;
  /** 事件抵達那一刻的 sessionId（不是 resolve 時的）——結果回報要用這個。 */
  capturedSessionId: string | null;
}

/** request_id → entry，Map 保插入序＝佇列序。 */
export type AgentOpsQueue = Map<string, AgentOpsQueueEntry>;

export function createAgentOpsQueue(): AgentOpsQueue {
  return new Map();
}

/**
 * 入隊。同 request_id 重入＝gateway 重送同一批（合法重放，不是資料丟失）——
 * 直接覆蓋該筆（連帶更新捕獲的 sid），佇列序不變（Map.set 對既有 key 不移動
 * 插入位置）。不同 request_id 一律追加，絕不覆蓋佇列裡其他筆。
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

/** 移除指定 request_id（resolve 後從佇列摘除）。找不到則原樣返回同一實例。 */
export function dequeueAgentOps(queue: AgentOpsQueue, requestId: string): AgentOpsQueue {
  if (!queue.has(requestId)) return queue;
  const next = new Map(queue);
  next.delete(requestId);
  return next;
}

/** 佇列頭（最早入隊、尚未 resolve 的一筆）。空佇列回 undefined。 */
export function getQueueHead(
  queue: AgentOpsQueue,
): { requestId: string; entry: AgentOpsQueueEntry } | undefined {
  const first = queue.entries().next();
  if (first.done) return undefined;
  const [requestId, entry] = first.value;
  return { requestId, entry };
}

/** 便捷讀法：佇列頭的事件本體（單一 pendingAgentOps，供宿主自動執行）。 */
export function getQueueHeadEvent(queue: AgentOpsQueue): CanvasAgentOpsEvent | null {
  return getQueueHead(queue)?.entry.event ?? null;
}
