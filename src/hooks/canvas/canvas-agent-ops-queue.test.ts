// canvas-agent-ops-queue 契約測試：驗證 2026-08-31 修的「第二個 canvas.ops 覆蓋第一個」bug
// 不再重現，以及每筆的 capturedSessionId 獨立於後續 session 切換。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAgentOpsQueue,
  enqueueAgentOps,
  dequeueAgentOps,
  getQueueHead,
  getQueueHeadEvent,
} from "./canvas-agent-ops-queue";
import type { CanvasAgentOpsEvent } from "@/lib/canvas/types";

function opsEvent(requestId: string, label = "test"): CanvasAgentOpsEvent {
  return {
    request_id: requestId,
    ops: [{ type: "select_nodes", ids: ["a"] }],
    label,
  };
}

// ── 核心 bug 修復：兩個不同 request_id 背靠背抵達，都不能丟

test("enqueue：兩個不同 request_id 都保留，先進先出", () => {
  let queue = createAgentOpsQueue();
  queue = enqueueAgentOps(queue, opsEvent("req-1"), "sess-a");
  queue = enqueueAgentOps(queue, opsEvent("req-2"), "sess-a");
  assert.equal(queue.size, 2);
  assert.ok(queue.has("req-1"));
  assert.ok(queue.has("req-2"));
  // 佇列頭是先入隊的 req-1，不是被 req-2 覆蓋
  const head = getQueueHead(queue);
  assert.equal(head?.requestId, "req-1");
});

test("enqueue：同 request_id 重入視為合法重放，覆蓋該筆但不影響佇列序", () => {
  let queue = createAgentOpsQueue();
  queue = enqueueAgentOps(queue, opsEvent("req-1", "第一次"), "sess-a");
  queue = enqueueAgentOps(queue, opsEvent("req-2"), "sess-a");
  // req-1 重送（同 id，內容變了）——覆蓋但仍在佇列頭位置
  queue = enqueueAgentOps(queue, opsEvent("req-1", "重送"), "sess-a");
  assert.equal(queue.size, 2);
  const head = getQueueHead(queue);
  assert.equal(head?.requestId, "req-1");
  assert.equal(head?.entry.event.label, "重送");
});

// ── resolve 頭後前進到下一筆

test("dequeue：移除頭後，佇列前進到下一個 request_id", () => {
  let queue = createAgentOpsQueue();
  queue = enqueueAgentOps(queue, opsEvent("req-1"), "sess-a");
  queue = enqueueAgentOps(queue, opsEvent("req-2"), "sess-a");
  queue = dequeueAgentOps(queue, "req-1");
  assert.equal(queue.size, 1);
  assert.equal(getQueueHead(queue)?.requestId, "req-2");
});

test("dequeue：不存在的 id 原樣返回同一實例（無 no-op 副作用）", () => {
  const queue = enqueueAgentOps(createAgentOpsQueue(), opsEvent("req-1"), "sess-a");
  const next = dequeueAgentOps(queue, "nope");
  assert.equal(next, queue);
});

// ── 每筆 entry 的 capturedSessionId 獨立，不隨後續 session 切換而變

test("capturedSessionId：每筆各自捕獲抵達時的 session，互不干擾", () => {
  let queue = createAgentOpsQueue();
  queue = enqueueAgentOps(queue, opsEvent("req-1"), "sess-a");
  // 模擬使用者在 req-1 待確認時切了 session
  queue = enqueueAgentOps(queue, opsEvent("req-2"), "sess-b");
  const e1 = queue.get("req-1");
  const e2 = queue.get("req-2");
  assert.equal(e1?.capturedSessionId, "sess-a");
  assert.equal(e2?.capturedSessionId, "sess-b");
});

test("getQueueHeadEvent：空佇列回 null，非空回頭部事件本體", () => {
  assert.equal(getQueueHeadEvent(createAgentOpsQueue()), null);
  const queue = enqueueAgentOps(createAgentOpsQueue(), opsEvent("req-1"), "sess-a");
  assert.equal(getQueueHeadEvent(queue)?.request_id, "req-1");
});
