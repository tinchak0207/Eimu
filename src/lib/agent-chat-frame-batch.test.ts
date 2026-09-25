// agent-chat-frame-batch 的单元测试。
//
// 运行器：node:test（`npx --yes tsx --test src/lib/agent-chat-frame-batch.test.ts`）。
// 全程注入假时钟与假排程器，不碰 DOM、不起真计时器 —— 併批是时间敏感逻辑，
// 用真 setTimeout 测就会变成 flaky 测试。

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FRAME_BATCH_WINDOW_MS,
  createFrameBatcher,
  shouldCoalesceAgentFrame,
} from "./agent-chat-frame-batch";
import type { AgentSseEvent } from "./agent-chat-types";

// ─────────────────────────── 假时钟 / 假排程器

interface FakeClock {
  now(): number;
  schedule(cb: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  advance(ms: number): void;
  scheduledCount(): number;
  pendingTimers(): number;
}

function fakeClock(): FakeClock {
  let t = 0;
  let nextHandle = 1;
  let scheduled = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  return {
    now: () => t,
    schedule(cb, ms) {
      scheduled += 1;
      const handle = nextHandle++;
      timers.set(handle, { at: t + ms, cb });
      return handle;
    },
    cancel(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      t += ms;
      // 迭代快照：回调里可能再排新的计时期，不能边迭代边改 Map。
      for (const [handle, task] of [...timers]) {
        if (task.at > t) continue;
        timers.delete(handle);
        task.cb();
      }
    },
    scheduledCount: () => scheduled,
    pendingTimers: () => timers.size,
  };
}

function makeBatcher() {
  const clock = fakeClock();
  const applied: AgentSseEvent[] = [];
  const batcher = createFrameBatcher({
    apply: (evt) => applied.push(evt),
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  return { clock, applied, batcher };
}

// ─────────────────────────── 帧构造器（只用到併批判准会读的栏位）

function delta(text: string): AgentSseEvent {
  return { name: "message.delta", event_id: 0, data: { text } };
}
function reasoning(text: string): AgentSseEvent {
  return { name: "reasoning.delta", event_id: 0, data: { text } };
}
function subagentDelta(text: string): AgentSseEvent {
  return { name: "subagent.delta", event_id: 0, data: { id: "s1", text } };
}
function turnDone(): AgentSseEvent {
  return { name: "turn.done", event_id: 0, data: {} };
}

/** 已落地帧的逐帧指纹：併批只该改变「何时渲染」，不该改变内容与顺序。 */
function fingerprint(applied: AgentSseEvent[]): string[] {
  return applied.map((evt) => {
    switch (evt.name) {
      case "message.delta":
      case "reasoning.delta":
        return `${evt.name}:${evt.data.text}`;
      case "subagent.delta":
        return `subagent.delta:${evt.data.text}`;
      default:
        return evt.name;
    }
  });
}

// ─────────────────────────── 併批判准

test("併批判准只认三帧纯文字追加", () => {
  assert.equal(shouldCoalesceAgentFrame(delta("a")), true, "message.delta");
  assert.equal(shouldCoalesceAgentFrame(reasoning("a")), true, "reasoning.delta");
  assert.equal(shouldCoalesceAgentFrame(subagentDelta("a")), true, "subagent.delta");

  // 其余帧会改结构 / 带终态 / 要用户立刻看见 —— 一律直通，不進併批。
  const passThrough: AgentSseEvent[] = [
    { name: "tool.invoke", event_id: 0, data: { tool: "image_generate" } },
    { name: "tool.result", event_id: 0, data: { tool: "image_generate", ok: true } },
    { name: "image.done", event_id: 0, data: { url: "https://example.test/a.png" } },
    turnDone(),
    { name: "turn.status", event_id: 0, data: { text: "正在執行工具" } },
    { name: "confirm.request", event_id: 0, data: { request_id: "cf_1", amount_coins: 3 } },
    { name: "session.closed", event_id: 0, data: { reason: "idle" } },
    { name: "canvas.node.created", event_id: 0, data: { unit_id: "u1", node: { id: "n1", type: "image", title: "t" } } },
    { name: "subagent.started", event_id: 0, data: { id: "s1", label: "搜索" } },
    { name: "subagent.done", event_id: 0, data: { id: "s1", status: "ok" } },
    { name: "quota.changed", event_id: 0, data: { balance_coins: 1, currency: "coins", available: true } },
  ];
  for (const evt of passThrough) {
    assert.equal(shouldCoalesceAgentFrame(evt), false, evt.name);
  }
});

// ─────────────────────────── leading edge

test("leading edge：window 外的帧立即 apply，首字不延迟", () => {
  const { clock, applied, batcher } = makeBatcher();

  batcher.push(delta("第一字"));
  assert.deepEqual(fingerprint(applied), ["message.delta:第一字"], "第一条帧立即落地");
  assert.equal(batcher.pendingCount(), 0);
  assert.equal(clock.scheduledCount(), 0, "leading edge 不该排任何计时器");

  // 距离上次渲染已超过一个窗口：下一帧同样立即落地。
  clock.advance(DEFAULT_FRAME_BATCH_WINDOW_MS + 1);
  batcher.push(delta("第二段"));
  assert.deepEqual(fingerprint(applied), ["message.delta:第一字", "message.delta:第二段"]);
  assert.equal(batcher.pendingCount(), 0);
  assert.equal(clock.scheduledCount(), 0);
});

// ─────────────────────────── 併批 + 字不留失

test("併批：同 window 内 5 帧只排 1 次 flush，落地总数与顺序逐字完整", () => {
  const { clock, applied, batcher } = makeBatcher();

  const frames = [delta("A"), delta("B"), delta("C"), delta("D"), delta("E")];
  frames.forEach((frame) => batcher.push(frame));

  // 第一帧 leading edge 立即落地，其余四帧在缓冲里等同一个窗口。
  assert.deepEqual(fingerprint(applied), ["message.delta:A"]);
  assert.equal(batcher.pendingCount(), 4);
  assert.equal(clock.scheduledCount(), 1, "同 window 内只排一次 flush");

  clock.advance(DEFAULT_FRAME_BATCH_WINDOW_MS);

  assert.deepEqual(fingerprint(applied), [
    "message.delta:A",
    "message.delta:B",
    "message.delta:C",
    "message.delta:D",
    "message.delta:E",
  ]);
  assert.equal(applied.length, frames.length, "一个字都不许丢");
  assert.equal(batcher.pendingCount(), 0);
  assert.equal(clock.pendingTimers(), 0, "落地后不留计时器");
});

test("长串流跨多个窗口：帧数、顺序、内容逐字守恒", () => {
  const { clock, applied, batcher } = makeBatcher();

  const expected: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    const text = `tok${i}-`;
    expected.push(`message.delta:${text}`);
    batcher.push(delta(text));
    clock.advance(3); // 每帧 3ms：一个 50ms 窗口装得下十几帧
  }
  clock.advance(DEFAULT_FRAME_BATCH_WINDOW_MS * 2);

  assert.equal(applied.length, 200);
  assert.deepEqual(fingerprint(applied), expected, "顺序与内容逐字完整");
  assert.equal(batcher.pendingCount(), 0);
});

// ─────────────────────────── 非併批帧插队

test("非併批帧先 flush 缓冲再 apply 自己：delta 一定排在 turn.done 之前", () => {
  const { clock, applied, batcher } = makeBatcher();

  batcher.push(delta("先写的字")); // leading edge 立即落地
  clock.advance(10);
  batcher.push(delta("还没来得及渲染的字")); // 进缓冲
  assert.equal(batcher.pendingCount(), 1);
  assert.equal(clock.pendingTimers(), 1);

  // 窗口还没到期就来了收尾帧：缓冲必须先落地，否则收尾之后才长字 = 假活。
  batcher.push(turnDone());

  assert.deepEqual(fingerprint(applied), [
    "message.delta:先写的字",
    "message.delta:还没来得及渲染的字",
    "turn.done",
  ]);
  assert.equal(batcher.pendingCount(), 0);
  assert.equal(clock.pendingTimers(), 0, "flush 顺带取消已排的计时器");

  // 窗口到期后不该再补一次落地（缓冲已空）。
  clock.advance(DEFAULT_FRAME_BATCH_WINDOW_MS * 4);
  assert.equal(applied.length, 3);
});

test("非併批帧之后的文字帧重新开窗，不与前一窗粘连", () => {
  const { clock, applied, batcher } = makeBatcher();

  batcher.push(delta("1"));
  clock.advance(10);
  batcher.push(delta("2"));
  batcher.push(turnDone());
  assert.deepEqual(fingerprint(applied), ["message.delta:1", "message.delta:2", "turn.done"]);

  // 非併批帧刚落地：紧随其后的文字帧要么立即（若已过窗）要么按剩余窗等，
  // 但必须在 advance 后完整落地，不能丢在缓冲里。
  batcher.push(reasoning("思考中"));
  clock.advance(DEFAULT_FRAME_BATCH_WINDOW_MS);
  assert.deepEqual(fingerprint(applied), ["message.delta:1", "message.delta:2", "turn.done", "reasoning.delta:思考中"]);
});

// ─────────────────────────── drop / flush / pendingCount

test("drop()：清空缓冲、取消排程，之后不再 apply", () => {
  const { clock, applied, batcher } = makeBatcher();

  batcher.push(delta("已落地"));
  clock.advance(5);
  batcher.push(delta("将被丢弃"));
  assert.equal(batcher.pendingCount(), 1);
  assert.equal(clock.pendingTimers(), 1);

  batcher.drop();
  assert.equal(batcher.pendingCount(), 0);
  assert.equal(clock.pendingTimers(), 0, "drop 必须取消排程");

  clock.advance(DEFAULT_FRAME_BATCH_WINDOW_MS * 10);
  assert.deepEqual(fingerprint(applied), ["message.delta:已落地"], "drop 后旧计时期不得再 apply");

  // drop 归零时间锚：新生命的第一条帧立刻见字，不等旧窗口余量。
  batcher.push(delta("新生命首字"));
  assert.deepEqual(fingerprint(applied), ["message.delta:已落地", "message.delta:新生命首字"]);
});

test("flush() 空缓冲是无害 no-op", () => {
  const { clock, applied, batcher } = makeBatcher();
  batcher.flush();
  assert.deepEqual(applied, []);
  assert.equal(clock.scheduledCount(), 0);
  assert.equal(batcher.pendingCount(), 0);
});

test("pendingCount() 反映缓冲深度", () => {
  const { clock, batcher } = makeBatcher();
  assert.equal(batcher.pendingCount(), 0);

  batcher.push(subagentDelta("a")); // leading edge
  assert.equal(batcher.pendingCount(), 0);

  batcher.push(subagentDelta("b"));
  batcher.push(subagentDelta("c"));
  assert.equal(batcher.pendingCount(), 2);

  clock.advance(DEFAULT_FRAME_BATCH_WINDOW_MS);
  assert.equal(batcher.pendingCount(), 0);
});

test("windowMs 可覆盖（注入更宽的窗口）", () => {
  const clock = fakeClock();
  const applied: AgentSseEvent[] = [];
  const batcher = createFrameBatcher({
    apply: (evt) => applied.push(evt),
    windowMs: 500,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  batcher.push(delta("1")); // leading edge
  clock.advance(100);
  batcher.push(delta("2")); // 距上次渲染 100ms < 500ms → 进缓冲
  assert.equal(batcher.pendingCount(), 1);
  assert.deepEqual(fingerprint(applied), ["message.delta:1"]);

  clock.advance(400); // 累计 500ms，窗口到期
  assert.deepEqual(fingerprint(applied), ["message.delta:1", "message.delta:2"]);
});
