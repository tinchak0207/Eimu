import test from "node:test";
import assert from "node:assert/strict";
import { buildAnchorMessage, buildReanchorMessage, deriveBatchAnchor } from "./agent-batch-anchor";
import type { AgentTranscriptItem } from "./agent-chat-types";

function tool(id: string, seq: number, argsSummary?: string): AgentTranscriptItem {
  return { kind: "tool", id, seq, tool: "image_generate", status: "ok", argsSummary };
}
function image(id: string, seq: number): AgentTranscriptItem {
  return { kind: "image", id, seq, url: `https://example.invalid/${id}.png` };
}
function user(id: string, text: string): AgentTranscriptItem {
  return { kind: "user", id, seq: 0, text };
}

test("no image yet → no anchor card", () => {
  assert.equal(deriveBatchAnchor([user("u1", "画 20 只猫"), tool("t1", 1, '{"model":"pixai"}')]), null);
});

test("anchor pairs the first image with the call that produced it", () => {
  const items = [
    user("u1", "画 20 只猫"),
    tool("t1", 1, '{"model":"pixai-v1","size":"1024x1024","seed":42,"prompt":"a cat"}'),
    image("i1", 2),
    tool("t2", 3, '{"model":"other","seed":99}'),
    image("i2", 4),
  ];
  const anchor = deriveBatchAnchor(items);
  assert.ok(anchor);
  assert.equal(anchor.imageId, "i1");
  assert.equal(anchor.seq, 2);
  // 拿的是第一张之前那次调用的 seed，不是后面那次
  assert.equal(anchor.params.find((p) => p.key === "seed")?.value, "42");
  assert.equal(anchor.params.find((p) => p.key === "model")?.value, "pixai-v1");
  // prompt 不属于锚定集合：锚的是风格参数，不是把描述又念一遍
  assert.equal(anchor.params.find((p) => p.key === "prompt"), undefined);
});

test("no reproducible params → no anchor (never offer an anchor that cannot hold)", () => {
  // 只有 prompt，锚不住风格
  assert.equal(deriveBatchAnchor([tool("t1", 1, '{"prompt":"a cat"}'), image("i1", 2)]), null);
  // 图之前完全没有带参数的调用
  assert.equal(deriveBatchAnchor([tool("t1", 1, undefined), image("i1", 2)]), null);
});

test("truncated upstream summary is surfaced, not hidden", () => {
  const anchor = deriveBatchAnchor([tool("t1", 1, '{"model":"pixai-v1","seed":7,"lora":"abc...'), image("i1", 2)]);
  assert.ok(anchor);
  assert.equal(anchor.truncated, true);
});

test("anchor message reads the real params back and forbids drift", () => {
  const anchor = deriveBatchAnchor([
    tool("t1", 1, '{"model":"pixai-v1","size":"1024x1024","seed":42}'),
    image("i1", 2),
  ]);
  assert.ok(anchor);
  const msg = buildAnchorMessage(anchor);
  assert.match(msg, /第 2 张就是我要的风格/);
  assert.match(msg, /不要改动/);
  assert.match(msg, /seed）：42/);
  assert.match(msg, /model）：pixai-v1/);
  // 锚不住的时候要先说，不许默默换参数
  assert.match(msg, /先告诉我再继续/);
});

test("re-anchor asks for one image first, never a whole batch on an unconfirmed direction", () => {
  const anchor = deriveBatchAnchor([tool("t1", 1, '{"model":"m","seed":1}'), image("i1", 2)]);
  assert.ok(anchor);
  const msg = buildReanchorMessage(anchor);
  assert.match(msg, /先只出 1 张/);
  assert.match(msg, /满意了我再让你出整批/);
});
