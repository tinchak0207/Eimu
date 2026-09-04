import test from "node:test";
import assert from "node:assert/strict";

import { parseAgentSseEvent, isAgentEventName, type AgentToolProgress } from "./agent-chat-types";

function progressData(raw: Record<string, unknown>): AgentToolProgress | null {
  const ev = parseAgentSseEvent("tool.progress", JSON.stringify(raw));
  return ev && ev.name === "tool.progress" ? ev.data : null;
}

test("tool.progress 是已注册事件名", () => {
  assert.equal(isAgentEventName("tool.progress"), true);
});

test("tool.progress 合法帧解析出 done/total/label", () => {
  const data = progressData({ tool: "keyframe_render", done: 3, total: 8, label: "渲染關鍵幀", event_id: 42 });
  assert.deepEqual(data, { tool: "keyframe_render", done: 3, total: 8, label: "渲染關鍵幀" });
});

test("tool.progress 缺 label 时不带 label 键（不塞 undefined）", () => {
  const data = progressData({ tool: "gen", done: 1, total: 4 });
  assert.deepEqual(data, { tool: "gen", done: 1, total: 4 });
  assert.equal("label" in (data ?? {}), false);
});

test("tool.progress 非法帧一律丢弃（宁缺勿假）", () => {
  assert.equal(progressData({ done: 1, total: 4 }), null, "缺 tool");
  assert.equal(progressData({ tool: "", done: 1, total: 4 }), null, "空 tool");
  assert.equal(progressData({ tool: "gen", total: 4 }), null, "缺 done");
  assert.equal(progressData({ tool: "gen", done: 1 }), null, "缺 total");
  assert.equal(progressData({ tool: "gen", done: 1, total: 0 }), null, "total=0 假分母");
  assert.equal(progressData({ tool: "gen", done: 1, total: -3 }), null, "负 total");
  assert.equal(progressData({ tool: "gen", done: -1, total: 4 }), null, "负 done");
  assert.equal(progressData({ tool: "gen", done: NaN, total: 4 }), null, "NaN done");
  assert.equal(progressData({ tool: "gen", done: "2", total: 4 }), null, "字符串 done 不收");
});
