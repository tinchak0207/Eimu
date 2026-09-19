import test from "node:test";
import assert from "node:assert/strict";

import { parseAgentSseEvent, isAgentEventName, type AgentToolProgress, type AgentTurnPlan } from "./agent-chat-types";

function progressData(raw: Record<string, unknown>): AgentToolProgress | null {
  const ev = parseAgentSseEvent("tool.progress", JSON.stringify(raw));
  return ev && ev.name === "tool.progress" ? ev.data : null;
}

function planData(raw: Record<string, unknown>): AgentTurnPlan | null {
  const ev = parseAgentSseEvent("turn.plan", JSON.stringify(raw));
  return ev && ev.name === "turn.plan" ? ev.data : null;
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

test("turn.plan 是已注册事件名（hook 逐名注册 listener，注册即消费）", () => {
  assert.equal(isAgentEventName("turn.plan"), true);
});

test("turn.plan 合法帧解析出 plan/experts/provisional/source（model 只进 console 也保留）", () => {
  const data = planData({
    event_id: 147,
    plan: "打算这么做：先拆解赛博朋克 15 秒短片的剧情节拍与分镜脚本。",
    experts: ["screenwriter"],
    provisional: true,
    source: "model",
    model: "hublinuxdo/deepseek-v4.1-flash",
  });
  assert.deepEqual(data, {
    plan: "打算这么做：先拆解赛博朋克 15 秒短片的剧情节拍与分镜脚本。",
    experts: ["screenwriter"],
    provisional: true,
    source: "model",
    model: "hublinuxdo/deepseek-v4.1-flash",
  });
});

test("turn.plan 缺 plan（或空字串 / 非字串）→ 整帧丢弃", () => {
  // plan 是唯一必需欄位：沒有它就只是一張空話卡，寧可不畫。
  assert.equal(planData({ event_id: 1 }), null, "缺 plan");
  assert.equal(planData({ event_id: 1, plan: "" }), null, "空 plan");
  assert.equal(planData({ event_id: 1, plan: "   " }), null, "空白 plan");
  assert.equal(planData({ event_id: 1, plan: 123 }), null, "非字串 plan");
  assert.equal(parseAgentSseEvent("turn.plan", "not json"), null, "壞 JSON");
});

test("turn.plan experts 非陣列 / 空陣列 → 不帶 experts 鍵（缺席就不畫晶片）", () => {
  const a = planData({ plan: "先出分镜。", experts: "screenwriter" });
  assert.equal("experts" in (a ?? {}), false, "非陣列不收");

  const b = planData({ plan: "先出分镜。", experts: [] });
  assert.equal("experts" in (b ?? {}), false, "空陣列等於沒有");

  const c = planData({ plan: "先出分镜。", experts: ["screenwriter", 42, "", null, "composer"] });
  assert.deepEqual(c?.experts, ["screenwriter", "composer"], "逐項收斂：非字串/空字串剔除，不留 undefined");
});

test("turn.plan provisional 預設 true，只有明確 false 才是 false", () => {
  assert.equal(planData({ plan: "先出分镜。" })?.provisional, true, "缺欄位 = 還在進行中（保守誠實的一側）");
  assert.equal(planData({ plan: "先出分镜。", provisional: "no" })?.provisional, true, "非 false 的壞值照預設");
  assert.equal(planData({ plan: "先出分镜。", provisional: false })?.provisional, false);
});

test("turn.plan source 白名單單值；superseded 只在明確 true 時帶", () => {
  assert.equal(planData({ plan: "先出分镜。", source: "rule" })?.source, "rule");
  assert.equal(planData({ plan: "先出分镜。", source: "guess" })?.source, undefined, "認不得的來源折成 undefined，不假造");
  assert.equal("superseded" in (planData({ plan: "先出分镜。" }) ?? {}), false, "缺席不出現");
  assert.equal(planData({ plan: "先出分镜。", superseded: true })?.superseded, true);
  assert.equal("superseded" in (planData({ plan: "先出分镜。", superseded: "yes" }) ?? {}), false, "非布林不帶");
});
