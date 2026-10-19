// canvas-agent-ops-queue 契约测试：验证 2026-08-31 修的「第二个 canvas.ops 覆盖第一个」bug
// 不再重现，以及每笔的 capturedSessionId 独立于后续 session 切换。
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

// ── 核心 bug 修复：两个不同 request_id 背靠背抵达，都不能丢

test("enqueue：两个不同 request_id 都保留，先进先出", () => {
  let queue = createAgentOpsQueue();
  queue = enqueueAgentOps(queue, opsEvent("req-1"), "sess-a");
  queue = enqueueAgentOps(queue, opsEvent("req-2"), "sess-a");
  assert.equal(queue.size, 2);
  assert.ok(queue.has("req-1"));
  assert.ok(queue.has("req-2"));
  // 伫列头是先入队的 req-1，不是被 req-2 覆盖
  const head = getQueueHead(queue);
  assert.equal(head?.requestId, "req-1");
});

test("enqueue：同 request_id 重入视为合法重放，覆盖该笔但不影响伫列序", () => {
  let queue = createAgentOpsQueue();
  queue = enqueueAgentOps(queue, opsEvent("req-1", "第一次"), "sess-a");
  queue = enqueueAgentOps(queue, opsEvent("req-2"), "sess-a");
  // req-1 重送（同 id，内容变了）——覆盖但仍在伫列头位置
  queue = enqueueAgentOps(queue, opsEvent("req-1", "重送"), "sess-a");
  assert.equal(queue.size, 2);
  const head = getQueueHead(queue);
  assert.equal(head?.requestId, "req-1");
  assert.equal(head?.entry.event.label, "重送");
});

// ── resolve 头后前进到下一笔

test("dequeue：移除头后，伫列前进到下一个 request_id", () => {
  let queue = createAgentOpsQueue();
  queue = enqueueAgentOps(queue, opsEvent("req-1"), "sess-a");
  queue = enqueueAgentOps(queue, opsEvent("req-2"), "sess-a");
  queue = dequeueAgentOps(queue, "req-1");
  assert.equal(queue.size, 1);
  assert.equal(getQueueHead(queue)?.requestId, "req-2");
});

test("dequeue：不存在的 id 原样返回同一实例（无 no-op 副作用）", () => {
  const queue = enqueueAgentOps(createAgentOpsQueue(), opsEvent("req-1"), "sess-a");
  const next = dequeueAgentOps(queue, "nope");
  assert.equal(next, queue);
});

// ── 每笔 entry 的 capturedSessionId 独立，不随后续 session 切换而变

test("capturedSessionId：每笔各自捕获抵达时的 session，互不干扰", () => {
  let queue = createAgentOpsQueue();
  queue = enqueueAgentOps(queue, opsEvent("req-1"), "sess-a");
  // 模拟使用者在 req-1 待确认时切了 session
  queue = enqueueAgentOps(queue, opsEvent("req-2"), "sess-b");
  const e1 = queue.get("req-1");
  const e2 = queue.get("req-2");
  assert.equal(e1?.capturedSessionId, "sess-a");
  assert.equal(e2?.capturedSessionId, "sess-b");
});

test("getQueueHeadEvent：空伫列回 null，非空回头部事件本体", () => {
  assert.equal(getQueueHeadEvent(createAgentOpsQueue()), null);
  const queue = enqueueAgentOps(createAgentOpsQueue(), opsEvent("req-1"), "sess-a");
  assert.equal(getQueueHeadEvent(queue)?.request_id, "req-1");
});
