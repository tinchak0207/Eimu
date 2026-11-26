import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_AGENT_CHAT_STATE,
  type AgentAssistantTextItem,
  type AgentAudioItem,
  type AgentNoticeItem,
  type AgentPlanItem,
  type AgentSseEvent,
  type AgentSubagentItem,
  type AgentSubagentReportItem,
  type AgentToolCallItem,
  type AgentUserTurnItem,
  type AgentVideoItem,
} from "./agent-chat-types";
import { agentChatReducer, appendUserTurn, applyQuotaSnapshot } from "./agent-chat-reducer";

/** 建一帧被 TypeScript 检过型别的 SSE 事件。 */
function evt(event: AgentSseEvent): AgentSseEvent {
  return event;
}

const EMPTY = EMPTY_AGENT_CHAT_STATE;

test("message.delta 并进同一个 streaming 条目，不逐帧开新条目", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "message.delta", event_id: 1, data: { text: "你" } }));
  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 2, data: { text: "好" } }));
  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 3, data: { text: "！" } }));

  assert.equal(s.items.length, 1);
  const assistant = s.items[0] as AgentAssistantTextItem;
  assert.equal(assistant.kind, "assistant");
  assert.equal(assistant.text, "你好！");
  assert.equal(assistant.streaming, true);
  assert.equal(s.turnActive, true);
});

test("reasoning.delta 累积到 streaming 条目的 reasoning 栏位，不污染 text", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "reasoning.delta", event_id: 1, data: { text: "The" } }));
  s = agentChatReducer(s, evt({ name: "reasoning.delta", event_id: 2, data: { text: " user" } }));
  assert.equal(s.items.length, 1);
  const a = s.items[0] as AgentAssistantTextItem;
  assert.equal(a.kind, "assistant");
  assert.equal(a.reasoning, "The user");
  assert.equal(a.text, "");
  assert.equal(a.streaming, true);
});

test("reasoning 后接 message.delta：同一条目，text 与 reasoning 并存", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "reasoning.delta", event_id: 1, data: { text: "画" } }));
  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 2, data: { text: "完成" } }));
  const a = s.items[0] as AgentAssistantTextItem;
  assert.equal(a.reasoning, "画");
  assert.equal(a.text, "完成");
  assert.equal(s.items.length, 1);
});

test("turn.done 之后的 delta 才开新条目", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "message.delta", event_id: 1, data: { text: "a" } }));
  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 2, data: {} }));

  assert.equal((s.items[0] as AgentAssistantTextItem).streaming, false);

  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 3, data: { text: "b" } }));
  assert.equal(s.items.length, 2);
  const second = s.items[1] as AgentAssistantTextItem;
  assert.equal(second.kind, "assistant");
  assert.equal(second.text, "b");
  assert.equal(second.streaming, true);
});

test("tool.invoke → tool.result 回填同一个条目，id 不变", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "generate_image", args_summary: "..." } }));
  assert.equal(s.items.length, 1);
  const before = s.items[0] as AgentToolCallItem;
  assert.equal(before.status, "running");

  s = agentChatReducer(s, evt({ name: "tool.result", event_id: 2, data: { tool: "generate_image", ok: true, cost_coins: 3 } }));

  assert.equal(s.items.length, 1);
  const after = s.items[0] as AgentToolCallItem;
  assert.equal(after.id, before.id, "回填必须沿用原条目 id");
  assert.equal(after.status, "ok");
  assert.equal(after.costCoins, 3);
  assert.equal(s.turnActive, true);
});

test("tool.result 没有对应 invoke 时，补一笔已定案条目（去重/断线把 invoke 弄丢了）", () => {
  const s = agentChatReducer(EMPTY, evt({ name: "tool.result", event_id: 5, data: { tool: "gen", ok: false } }));

  assert.equal(s.items.length, 1);
  const it = s.items[0] as AgentToolCallItem;
  assert.equal(it.kind, "tool");
  assert.equal(it.status, "failed");
  assert.equal(it.seq, 5);
});

test("tool.result 失败时透传 error.human_message 到条目（R10-1：红卡带人类可读错误）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "workflow_add_node" } }));
  s = agentChatReducer(
    s,
    evt({
      name: "tool.result",
      event_id: 2,
      data: {
        tool: "workflow_add_node",
        ok: false,
        error: { code: "workflow_add_node_failed", message: "text 节点必须填 content", human_message: "text 节点必须填 content（提示词内容）或 shot" },
      },
    }),
  );

  const it = s.items[0] as AgentToolCallItem;
  assert.equal(it.status, "failed");
  assert.equal(it.error, "text 节点必须填 content（提示词内容）或 shot", "优先取 human_message");
  assert.equal(s.turnActive, true);
});

test("tool.result 失败但无 error 栏位时，error 为 undefined（不假造错误面）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "gen" } }));
  s = agentChatReducer(s, evt({ name: "tool.result", event_id: 2, data: { tool: "gen", ok: false } }));

  const it = s.items[0] as AgentToolCallItem;
  assert.equal(it.status, "failed");
  assert.equal(it.error, undefined);
});

test("tool.result 只回填最近一个同名 running 条目", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "gen" } }));
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 2, data: { tool: "gen" } }));
  s = agentChatReducer(s, evt({ name: "tool.result", event_id: 3, data: { tool: "gen", ok: true, cost_coins: 1 } }));

  const items = s.items as AgentToolCallItem[];
  assert.equal(items[0]?.status, "running", "前面的同名调用不受影响");
  assert.equal(items[1]?.status, "ok");
  assert.equal(items[1]?.costCoins, 1);
});

test("tool.progress 回填同名 running 卡的进度（逐镜中间态）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "keyframe_render" } }));
  s = agentChatReducer(s, evt({ name: "tool.progress", event_id: 2, data: { tool: "keyframe_render", done: 3, total: 8, label: "渲染关键帧" } }));

  const items = s.items as AgentToolCallItem[];
  assert.equal(items.length, 1, "进度不新建条目");
  assert.equal(items[0]?.status, "running", "进度不改终态");
  assert.deepEqual(items[0]?.progress, { done: 3, total: 8, label: "渲染关键帧" });
  assert.equal(s.turnActive, true);
});

test("tool.progress 逐镜跳动：后一帧覆盖前一帧，id 不变", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "keyframe_render" } }));
  const firstId = (s.items[0] as AgentToolCallItem).id;
  s = agentChatReducer(s, evt({ name: "tool.progress", event_id: 2, data: { tool: "keyframe_render", done: 1, total: 8 } }));
  s = agentChatReducer(s, evt({ name: "tool.progress", event_id: 3, data: { tool: "keyframe_render", done: 2, total: 8 } }));

  const items = s.items as AgentToolCallItem[];
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, firstId, "同一张卡原地更新");
  assert.deepEqual(items[0]?.progress, { done: 2, total: 8 });
});

test("tool.progress 找不到同名 running 卡时丢弃（invoke 丢了/已结算）", () => {
  // 无任何条目
  const empty = agentChatReducer(EMPTY, evt({ name: "tool.progress", event_id: 1, data: { tool: "gen", done: 1, total: 4 } }));
  assert.equal(empty.items.length, 0, "无 running 卡不凭空造条目");

  // 已结算（ok）的卡不再吃进度
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "gen" } }));
  s = agentChatReducer(s, evt({ name: "tool.result", event_id: 2, data: { tool: "gen", ok: true } }));
  s = agentChatReducer(s, evt({ name: "tool.progress", event_id: 3, data: { tool: "gen", done: 1, total: 4 } }));
  const items = s.items as AgentToolCallItem[];
  assert.equal(items.length, 1);
  assert.equal(items[0]?.progress, undefined, "终态卡不被进度污染");
});

test("tool.progress 只回填最近一个同名 running 条目", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "gen" } }));
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 2, data: { tool: "gen" } }));
  s = agentChatReducer(s, evt({ name: "tool.progress", event_id: 3, data: { tool: "gen", done: 1, total: 5 } }));

  const items = s.items as AgentToolCallItem[];
  assert.equal(items[0]?.progress, undefined, "前面的同名调用不受影响");
  assert.deepEqual(items[1]?.progress, { done: 1, total: 5 });
});

test("image.done 同 url 去重，不同 url 各自成条目", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "image.done", event_id: 1, data: { url: "https://x/1.png", cost_coins: 2 } }));
  assert.equal(s.items.length, 1);

  s = agentChatReducer(s, evt({ name: "image.done", event_id: 2, data: { url: "https://x/1.png", cost_coins: 2 } }));
  assert.equal(s.items.length, 1, "同 url 重送必须被吃掉");

  s = agentChatReducer(s, evt({ name: "image.done", event_id: 3, data: { url: "https://x/2.png" } }));
  assert.equal(s.items.length, 2);
  const first = s.items[0] as { url: string };
  const second = s.items[1] as { url: string };
  assert.equal(first.url, "https://x/1.png");
  assert.equal(second.url, "https://x/2.png");
});

test("video.done 同 url 去重，不同 url 各自成条目，mediaKind 透传", () => {
  let s = agentChatReducer(
    EMPTY,
    evt({ name: "video.done", event_id: 1, data: { url: "https://x/a.mp4", cost_coins: 5, media_kind: "film" } }),
  );
  assert.equal(s.items.length, 1);
  assert.equal(s.turnActive, true);

  s = agentChatReducer(s, evt({ name: "video.done", event_id: 2, data: { url: "https://x/a.mp4", cost_coins: 5 } }));
  assert.equal(s.items.length, 1, "同 url 重送必须被吃掉");

  s = agentChatReducer(s, evt({ name: "video.done", event_id: 3, data: { url: "https://x/b.mp4", media_kind: "video" } }));
  assert.equal(s.items.length, 2);

  const first = s.items[0] as AgentVideoItem;
  const second = s.items[1] as AgentVideoItem;
  assert.equal(first.kind, "video");
  assert.equal(first.url, "https://x/a.mp4");
  assert.equal(first.costCoins, 5);
  assert.equal(first.mediaKind, "film", "media_kind 要透传到条目");
  assert.equal(second.kind, "video");
  assert.equal(second.url, "https://x/b.mp4");
  assert.equal(second.mediaKind, "video");

  // 缺 media_kind 时条目留 undefined（展示层回落「影片」）。
  s = agentChatReducer(s, evt({ name: "video.done", event_id: 4, data: { url: "https://x/c.mp4" } }));
  const third = s.items[2] as AgentVideoItem;
  assert.equal(third.mediaKind, undefined);
});

test("video.done 与 image.done 互不影响去重（url 相同也各自成条目）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "image.done", event_id: 1, data: { url: "https://x/same" } }));
  s = agentChatReducer(s, evt({ name: "video.done", event_id: 2, data: { url: "https://x/same" } }));
  assert.equal(s.items.length, 2, "去重只比同 kind 的 url");
});

test("audio.done 同 url 去重，不同 url 各自成条目，mediaKind 透传", () => {
  let s = agentChatReducer(
    EMPTY,
    evt({ name: "audio.done", event_id: 1, data: { url: "https://x/a.m4a", cost_coins: 3, media_kind: "music" } }),
  );
  assert.equal(s.items.length, 1);
  assert.equal(s.turnActive, true);

  s = agentChatReducer(s, evt({ name: "audio.done", event_id: 2, data: { url: "https://x/a.m4a", cost_coins: 3 } }));
  assert.equal(s.items.length, 1, "同 url 重送必须被吃掉");

  s = agentChatReducer(s, evt({ name: "audio.done", event_id: 3, data: { url: "https://x/b.mp3", media_kind: "audio" } }));
  assert.equal(s.items.length, 2);

  const first = s.items[0] as AgentAudioItem;
  const second = s.items[1] as AgentAudioItem;
  assert.equal(first.kind, "audio");
  assert.equal(first.url, "https://x/a.m4a");
  assert.equal(first.costCoins, 3);
  assert.equal(first.mediaKind, "music", "media_kind 要透传到条目");
  assert.equal(first.seq, 1, "seq 是会话内第几条音频，不是网关 event_id");
  assert.equal(second.kind, "audio");
  assert.equal(second.url, "https://x/b.mp3");
  assert.equal(second.mediaKind, "audio");
  assert.equal(second.seq, 2);

  // 缺 media_kind 时条目留 undefined（展示层回落「音频」）。
  s = agentChatReducer(s, evt({ name: "audio.done", event_id: 4, data: { url: "https://x/c.wav" } }));
  const third = s.items[2] as AgentAudioItem;
  assert.equal(third.mediaKind, undefined);

  // 音频与影片互不影响去重（url 相同也各自成条目）。
  let both = agentChatReducer(EMPTY, evt({ name: "video.done", event_id: 1, data: { url: "https://x/same" } }));
  both = agentChatReducer(both, evt({ name: "audio.done", event_id: 2, data: { url: "https://x/same" } }));
  assert.equal(both.items.length, 2, "去重只比同 kind 的 url");
});

test("event_id <= lastEventId 的帧整帧丢弃（断线重连去重）", () => {
  const s = agentChatReducer(EMPTY, evt({ name: "message.delta", event_id: 3, data: { text: "hi" } }));
  assert.equal(s.lastEventId, 3);

  // 同序号重放：回同一个 reference，内容不重复加。
  const frozen = s;
  const replayed = agentChatReducer(frozen, evt({ name: "message.delta", event_id: 3, data: { text: "X" } }));
  assert.equal(replayed, frozen);
  assert.equal(replayed.items.length, 1);
  assert.equal((replayed.items[0] as AgentAssistantTextItem).text, "hi");

  // 更旧的序号（例如 reconnect 前的最后一帧）也一样被吃掉。
  const older = agentChatReducer(frozen, evt({ name: "tool.invoke", event_id: 1, data: { tool: "x" } }));
  assert.equal(older, frozen);
  assert.equal(older.items.length, 1);

  // 新序号正常处理，且 lastEventId 推进。
  const newer = agentChatReducer(frozen, evt({ name: "message.delta", event_id: 4, data: { text: "!" } }));
  assert.equal(newer.lastEventId, 4);
});

test("turn.done 收掉还在转的工具与 streaming 标记", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "message.delta", event_id: 1, data: { text: "a" } }));
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 2, data: { tool: "t1" } }));
  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 3, data: {} }));

  assert.equal(s.turnActive, false);
  assert.equal((s.items[0] as AgentAssistantTextItem).streaming, false);
  assert.equal((s.items[1] as AgentToolCallItem).status, "failed", "一轮结束不能留一个永远在转的工具");
});

test("session.closed 清空待确认、停掉 streaming/工具、留 notice", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "confirm.request", event_id: 1, data: { request_id: "r1", amount_coins: 10 } }));
  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 2, data: { text: "a" } }));
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 3, data: { tool: "t" } }));
  s = agentChatReducer(s, evt({ name: "session.closed", event_id: 4, data: { reason: "quota_exhausted" } }));

  assert.equal(s.closed, true);
  assert.equal(s.closedReason, "quota_exhausted");
  assert.equal(s.pendingConfirms.length, 0);
  assert.equal(s.pendingQuestions.length, 0);
  assert.equal(s.turnActive, false);
  // confirm.request 不产条目，所以 items = [assistant, tool, notice]。
  assert.equal((s.items[0] as AgentAssistantTextItem).streaming, false);
  assert.equal((s.items[1] as AgentToolCallItem).status, "failed");
  const last = s.items[s.items.length - 1] as AgentNoticeItem;
  assert.equal(last.kind, "notice");
});

test("confirm.request 同 requestId 去重", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "confirm.request", event_id: 1, data: { request_id: "r1", amount_coins: 5 } }));
  s = agentChatReducer(s, evt({ name: "confirm.request", event_id: 2, data: { request_id: "r1", amount_coins: 9 } }));

  assert.equal(s.pendingConfirms.length, 1);
  assert.equal(s.pendingConfirms[0]?.amountCoins, 5, "以先到的金额为准");
});

test("confirm.resolved 移除对应待确认并留 notice", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "confirm.request", event_id: 1, data: { request_id: "r1", amount_coins: 5 } }));
  s = agentChatReducer(s, evt({ name: "confirm.resolved", event_id: 2, data: { request_id: "r1", approved: false } }));

  assert.equal(s.pendingConfirms.length, 0);
  const last = s.items[s.items.length - 1] as AgentNoticeItem;
  assert.equal(last.kind, "notice");
  assert.equal(last.tone, "info");
});

test("question.request 同 requestId 去重，replied / rejected 清掉 pending", () => {
  const questions = [
    {
      question: "要什么规格？",
      header: "规格",
      options: [{ label: "10 秒", description: "稳" }, { label: "15 秒" }],
    },
  ];
  let s = agentChatReducer(EMPTY, evt({
    name: "question.request",
    event_id: 1,
    data: { request_id: "que_1", questions },
  }));
  s = agentChatReducer(s, evt({
    name: "question.request",
    event_id: 2,
    data: { request_id: "que_1", questions },
  }));
  assert.equal(s.pendingQuestions.length, 1);
  assert.equal(s.turnActive, true);

  s = agentChatReducer(s, evt({
    name: "question.replied",
    event_id: 3,
    data: { request_id: "que_1", answer: "10 秒" },
  }));
  assert.equal(s.pendingQuestions.length, 0);
  assert.equal((s.items[s.items.length - 1] as AgentNoticeItem).text, "已选择：10 秒");

  s = agentChatReducer(s, evt({
    name: "question.request",
    event_id: 4,
    data: { request_id: "que_2", questions },
  }));
  s = agentChatReducer(s, evt({
    name: "question.rejected",
    event_id: 5,
    data: { request_id: "que_2", reason: "已取消。" },
  }));
  assert.equal(s.pendingQuestions.length, 0);
  assert.equal((s.items[s.items.length - 1] as AgentNoticeItem).text, "已取消。");
});

test("confirm.resolved 对从没看过的 requestId 不抛错（另一台装置裁的）", () => {
  const s = agentChatReducer(EMPTY, evt({ name: "confirm.resolved", event_id: 1, data: { request_id: "never-seen", approved: true } }));

  assert.equal(s.pendingConfirms.length, 0);
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0]?.kind, "notice");
});

test("quota.changed 替换额度", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "quota.changed", event_id: 1, data: { balance_coins: 20, currency: "coins", available: true } }));
  assert.equal(s.quota?.balanceCoins, 20);
  assert.equal(s.quota?.currency, "coins");
  assert.equal(s.quota?.available, true);

  s = agentChatReducer(s, evt({ name: "quota.changed", event_id: 2, data: { balance_coins: null, currency: "coins", available: false, reason: "upstream_down" } }));
  assert.equal(s.quota?.balanceCoins, null);
  assert.equal(s.quota?.available, false);
});

test("session.error 留 error notice，但不终结会话", () => {
  const s = agentChatReducer(EMPTY, evt({ name: "session.error", event_id: 1, data: { code: "tool_failed", message: "出图失败" } }));

  assert.equal(s.closed, false, "错误不该关掉会话");
  const last = s.items[s.items.length - 1] as AgentNoticeItem;
  assert.equal(last.kind, "notice");
  assert.equal(last.tone, "error");
  assert.equal(last.text, "出图失败");
});

test("image.failed 当场留 error notice（refunded 讲退款、普通失败讲原因）", () => {
  const refunded = agentChatReducer(
    EMPTY,
    evt({ name: "image.failed", event_id: 1, data: { task_id: "t1", reason: "已退款：deadline exceeded", refunded: true } }),
  );
  assert.equal(refunded.closed, false);
  const n1 = refunded.items[refunded.items.length - 1] as AgentNoticeItem;
  assert.equal(n1.kind, "notice");
  assert.equal(n1.tone, "error");
  assert.match(n1.text, /费用已退回/);
  assert.match(n1.text, /deadline exceeded/);

  const failed = agentChatReducer(
    EMPTY,
    evt({ name: "image.failed", event_id: 2, data: { task_id: "t2", reason: "overloaded", refunded: false } }),
  );
  const n2 = failed.items[failed.items.length - 1] as AgentNoticeItem;
  assert.equal(n2.tone, "error");
  assert.match(n2.text, /生成失败/);
  assert.equal(failed.turnActive, true, "失败也是产出讯号，turn 照样活著等 turn.done");
});

test("turnActive 由产出事件打开、turn.done 关掉", () => {
  assert.equal(EMPTY.turnActive, false);

  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "t" } }));
  assert.equal(s.turnActive, true);

  s = agentChatReducer(s, evt({ name: "image.done", event_id: 2, data: { url: "u" } }));
  assert.equal(s.turnActive, true);

  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 3, data: {} }));
  assert.equal(s.turnActive, false);
});

test("reducer 不 mutate 输入 state（条目阵列与内容原封不动）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "message.delta", event_id: 1, data: { text: "a" } }));
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 2, data: { tool: "t" } }));

  const before = s;
  const itemsSnapshot = s.items.map((it) => ({ ...it }));
  const pendingSnapshot = s.pendingConfirms.slice();
  const lastEventIdSnapshot = s.lastEventId;

  const next = agentChatReducer(s, evt({ name: "tool.result", event_id: 3, data: { tool: "t", ok: true, cost_coins: 1 } }));

  assert.notEqual(next, before);
  assert.notEqual(next.items, before.items);
  assert.equal(before.items.length, itemsSnapshot.length);
  assert.deepEqual(
    before.items.map((it) => ({ ...it })),
    itemsSnapshot,
  );
  assert.equal(before.lastEventId, lastEventIdSnapshot);
  assert.deepEqual(before.pendingConfirms, pendingSnapshot);
  assert.equal((before.items[1] as AgentToolCallItem).status, "running", "原条目不能被回填改掉");
  assert.equal((next.items[1] as AgentToolCallItem).status, "ok");
});

test("appendUserTurn 乐观插入使用者讯息，id 稳定不碰撞", () => {
  let s = appendUserTurn(EMPTY, "hello");
  assert.equal(s.items.length, 1);
  const first = s.items[0] as AgentUserTurnItem;
  assert.equal(first.kind, "user");
  assert.equal(first.text, "hello");
  assert.equal(first.seq, 0);

  s = appendUserTurn(s, "world", [{ kind: "image", url: "https://x/a.png" }]);
  assert.equal(s.items.length, 2);
  const second = s.items[1] as AgentUserTurnItem;
  assert.notEqual(second.id, first.id, "两则使用者讯息的 id 不能碰撞");
  assert.equal(second.attachments?.length, 1);
});

test("applyQuotaSnapshot 填入额度", () => {
  const s = applyQuotaSnapshot(EMPTY, { balanceCoins: 12, currency: "coins", available: true });
  assert.deepEqual(s.quota, { balanceCoins: 12, currency: "coins", available: true });
});

test("条目 id 是决定性的：同样事件序列产出同样结果", () => {
  const run = () => {
    let s = agentChatReducer(EMPTY, evt({ name: "message.delta", event_id: 1, data: { text: "a" } }));
    s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 2, data: { tool: "t" } }));
    s = agentChatReducer(s, evt({ name: "tool.result", event_id: 3, data: { tool: "t", ok: true, cost_coins: 2 } }));
    s = agentChatReducer(s, evt({ name: "image.done", event_id: 4, data: { url: "u" } }));
    return s.items.map((it) => it.id).join(",");
  };
  assert.equal(run(), run());
});

// ── turn.status：网关暂态状态行（2026-08-30 正文污染根治）──────────────

test("turn.status 落 turnStatus 暂态栏位，不进 items 正文", () => {
  const s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "处理中（已 45s）：工具与子代理仍在执行。" } }));
  assert.equal(s.turnStatus, "处理中（已 45s）：工具与子代理仍在执行。");
  assert.equal(s.turnActive, true);
  assert.equal(s.items.length, 0);
});

test("turn.status 新状态替换旧状态（单行原地刷新，不累加）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "处理中（已 45s）：工具与子代理仍在执行。" } }));
  s = agentChatReducer(s, evt({ name: "turn.status", event_id: 2, data: { text: "处理中（已 90s）：可继续等待；若想中断，按停止后改派更小范围。" } }));
  assert.equal(s.turnStatus, "处理中（已 90s）：可继续等待；若想中断，按停止后改派更小范围。");
});

test("真实正文 message.delta 到达即清 turnStatus", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "处理中（已 45s）：工具与子代理仍在执行。" } }));
  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 2, data: { text: "搞定，" } }));
  assert.equal(s.turnStatus, undefined);
});

test("tool.invoke 期间 turnStatus 保留（工具执行中状态行仍成立）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "处理中（已 45s）：工具与子代理仍在执行。" } }));
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 2, data: { tool: "bash", args_summary: "curl …" } }));
  assert.equal(s.turnStatus, "处理中（已 45s）：工具与子代理仍在执行。");
});

test("turn.done 清 turnStatus", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "处理中（已 45s）：工具与子代理仍在执行。" } }));
  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 2, data: {} }));
  assert.equal(s.turnStatus, undefined);
});

test("appendUserTurn 新轮开始清 turnStatus", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "处理中（已 45s）：工具与子代理仍在执行。" } }));
  s = appendUserTurn(s, "再画一张");
  assert.equal(s.turnStatus, undefined);
});

// ── 会话已关闭后的迟到帧守卫（P0 回归） ─────────────────────────

test("state.closed 后，迟到的 message.delta 不再被处理（items 不变，不重新开 assistant 条目）", () => {
  const closed = agentChatReducer(EMPTY, evt({ name: "session.closed", event_id: 1, data: { reason: "quota_exhausted" } }));
  assert.equal(closed.closed, true);
  const itemsBefore = closed.items;

  const after = agentChatReducer(closed, evt({ name: "message.delta", event_id: 2, data: { text: "迟到的字" } }));

  // 没有新条目产生，assistant 不会诈尸。
  assert.equal(after.items.length, itemsBefore.length);
  assert.deepEqual(
    after.items.map((it) => ({ ...it })),
    itemsBefore.map((it) => ({ ...it })),
  );
  // 只允许 lastEventId 记账推进。
  assert.equal(after.lastEventId, 2);
  assert.equal(after.closed, true);
});

test("state.closed 后，迟到的 confirm.request 不再让 pendingConfirms 死会话复活", () => {
  const closed = agentChatReducer(EMPTY, evt({ name: "session.closed", event_id: 1, data: {} }));
  assert.equal(closed.pendingConfirms.length, 0);

  const after = agentChatReducer(
    closed,
    evt({ name: "confirm.request", event_id: 2, data: { request_id: "late-1", amount_coins: 5 } }),
  );
  assert.equal(after.pendingConfirms.length, 0, "死会话上不该再长出待确认卡");
  assert.equal(after.closed, true);
});

test("已关闭后再次收到 session.closed（本端 end() 合成的 event_id:0 收尾帧）是幂等 no-op", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "message.delta", event_id: 1, data: { text: "a" } }));
  s = agentChatReducer(s, evt({ name: "session.closed", event_id: 2, data: { reason: "user_ended" } }));
  assert.equal(s.closed, true);

  const noticeCountBefore = s.items.filter((it) => it.kind === "notice").length;
  assert.equal(noticeCountBefore, 1, "第一次 session.closed 应留一条「会话已结束」notice");

  // 本端 end() 合成的收尾帧：event_id 固定为 0。
  const again = agentChatReducer(s, evt({ name: "session.closed", event_id: 0, data: { reason: "user_ended" } }));

  assert.equal(again.closed, true);
  const noticeCountAfter = again.items.filter((it) => it.kind === "notice").length;
  assert.equal(noticeCountAfter, 1, "重复的 session.closed 不该再推一条 notice");
  assert.deepEqual(
    again.items.map((it) => ({ ...it })),
    s.items.map((it) => ({ ...it })),
    "幂等：items 形状不变",
  );
});

test("event_id>0 的既有去重行为不受影响（eventId<=lastEventId 整帧丢弃）", () => {
  const s = agentChatReducer(EMPTY, evt({ name: "message.delta", event_id: 3, data: { text: "hi" } }));
  assert.equal(s.lastEventId, 3);

  const frozen = s;
  const replayed = agentChatReducer(frozen, evt({ name: "message.delta", event_id: 3, data: { text: "X" } }));
  assert.equal(replayed, frozen);
  assert.equal(replayed.items.length, 1);
  assert.equal((replayed.items[0] as AgentAssistantTextItem).text, "hi");

  const older = agentChatReducer(frozen, evt({ name: "tool.invoke", event_id: 1, data: { tool: "x" } }));
  assert.equal(older, frozen);
  assert.equal(older.items.length, 1);

  const newer = agentChatReducer(frozen, evt({ name: "message.delta", event_id: 4, data: { text: "!" } }));
  assert.equal(newer.lastEventId, 4);
});

// ── 子代理：状态单一真源（F1）+ 产出保留（F3）+ 全文不截断（F4）──────────

test("F1 async 派遣：工具卡先回 ok，子代理后失败 → 卡片同步拉回失败（不两处打脸）", () => {
  let s = agentChatReducer(
    EMPTY,
    evt({
      name: "tool.invoke",
      event_id: 1,
      data: { tool: "subagent_dispatch", args_summary: '{"async":true,"label":"视频全量模型普查"}' },
    }),
  );
  s = agentChatReducer(s, evt({ name: "subagent.started", event_id: 2, data: { id: "sa3", label: "视频全量模型普查" } }));
  // async：派遣工具立刻回 ok（子代理还在背景跑）。
  s = agentChatReducer(s, evt({ name: "tool.result", event_id: 3, data: { tool: "subagent_dispatch", ok: true } }));
  assert.equal((s.items[0] as AgentToolCallItem).status, "ok");
  assert.equal(s.items.find((it) => it.kind === "subagent")?.status, "running");

  // 子代理随后被中止/失败：两处状态必须一致，不能一处「已完成」一处「失败」。
  s = agentChatReducer(s, evt({ name: "subagent.done", event_id: 4, data: { id: "sa3", status: "error", summary: "被中止" } }));
  assert.equal((s.items[0] as AgentToolCallItem).status, "failed");
  assert.equal((s.items[1] as AgentSubagentItem).status, "error");
});

test("F1 停止≠失败：subagent.done status=stopped → 派遣卡走 ok 同款中性结算、子代理标已停止（0920 gateway 契约）", () => {
  let s = agentChatReducer(
    EMPTY,
    evt({
      name: "tool.invoke",
      event_id: 1,
      data: { tool: "subagent_dispatch", args_summary: '{"label":"视频全量模型普查"}' },
    }),
  );
  s = agentChatReducer(s, evt({ name: "subagent.started", event_id: 2, data: { id: "sa4", label: "视频全量模型普查" } }));
  // 人工停止成功：gateway 送 stopped（不再是复用的 error），此时派遣卡还在 running。
  s = agentChatReducer(s, evt({ name: "subagent.done", event_id: 3, data: { id: "sa4", status: "stopped", summary: "用户终止了本轮，子代理一并停止" } }));

  const tool = s.items.find((it): it is AgentToolCallItem => it.kind === "tool" && it.subagentId === "sa4");
  const sub = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(tool && sub);
  assert.equal(sub.status, "stopped", "人工停止成功＝中性 stopped，不判 error");
  assert.equal(tool.status, "ok", "派遣卡走 ok 同款中性结算，不打红成 failed");
  assert.equal(tool.error, undefined, "不产生错误文案");
  assert.ok(!s.items.some((it) => it.kind === "tool" && (it as AgentToolCallItem).status === "failed"), "没有任何卡片被打成失败");
});

test("F1 子代理状态单一真源：started 绑定 dispatch 工具卡，done 一次结两处", () => {
  let s = agentChatReducer(
    EMPTY,
    evt({
      name: "tool.invoke",
      event_id: 1,
      data: { tool: "subagent_dispatch", args_summary: '{"async":false,"label":"视频牌价预检"}' },
    }),
  );
  s = agentChatReducer(s, evt({ name: "subagent.started", event_id: 2, data: { id: "sa1", label: "视频牌价预检" } }));

  const toolBefore = s.items.find((it): it is AgentToolCallItem => it.kind === "tool");
  const subBefore = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(toolBefore && subBefore);
  assert.equal(toolBefore.subagentId, "sa1", "started 必须把子代理绑到刚派出的工具卡上");
  assert.equal(toolBefore.status, "running");
  assert.equal(subBefore.status, "running");

  s = agentChatReducer(s, evt({ name: "subagent.done", event_id: 3, data: { id: "sa1", status: "ok", summary: "预检完成" } }));

  const toolAfter = s.items.find((it): it is AgentToolCallItem => it.kind === "tool");
  const subAfter = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(toolAfter && subAfter);
  assert.equal(subAfter.status, "ok");
  assert.equal(toolAfter.status, "ok", "子代理完成即结算绑定的工具卡：同一批任务不许两处状态互相打脸");
  // 同一子代理在画面模型里只有一处状态，且是完成态。
  const statuses = s.items
    .filter((it) => it.kind === "tool" && (it as AgentToolCallItem).subagentId === "sa1")
    .map((it) => (it as AgentToolCallItem).status);
  assert.deepEqual(statuses, ["ok"]);
  assert.ok(!s.items.some((it) => it.kind === "subagent" && it.status === "running"), "不得还有一处说运行中");
});

test("F1 跨回合在跑不退场：started 未 done + turn.done → 工具卡照旧判死、running 子代理原样保留（0921 契约）", () => {
  let s = agentChatReducer(
    EMPTY,
    evt({
      name: "tool.invoke",
      event_id: 1,
      data: { tool: "subagent_dispatch", args_summary: '{"label":"视频全量模型普查"}' },
    }),
  );
  s = agentChatReducer(s, evt({ name: "subagent.started", event_id: 2, data: { id: "sa2", label: "视频全量模型普查" } }));
  s = agentChatReducer(s, evt({ name: "subagent.delta", event_id: 3, data: { id: "sa2", text: "610 秒零输出" } }));
  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 4, data: {} }));

  const tool = s.items.find((it): it is AgentToolCallItem => it.kind === "tool" && it.subagentId === "sa2");
  const sub = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(tool && sub);
  assert.notEqual(tool.status, "running", "收尾不能留一张永远在转的工具卡");
  assert.equal(tool.status, "failed");
  assert.equal(sub.status, "running", "回合收尾不得退场在跑的子代理：它完工才 wakeParent 发 done，那时才该退场");
  assert.equal(sub.text, "610 秒零输出", "串流产出留在条目上，定案前不转存");
  assert.ok(!s.items.some((it) => it.kind === "subagent_result"), "未定态不转存：终态由 subagent.done 帧独占裁决");
});

test("F3 中止不销毁产出：subagent.done 的 summary 转存成产出卡留在转录里", () => {
  const summary = [
    "| 模型 | 720p 单价 | 15s｜10s｜5s |",
    "|---|---|---|",
    "| seedance-2.0 | 13 币/条 | 15s=10s=13 |",
    "seedance-2.0 近 24h 9 笔 0 交付（全退款）",
  ].join("\n");
  let s = agentChatReducer(EMPTY, evt({ name: "subagent.started", event_id: 1, data: { id: "sa1", label: "视频牌价预检" } }));
  s = agentChatReducer(s, evt({ name: "subagent.done", event_id: 2, data: { id: "sa1", status: "ok", summary } }));
  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 3, data: {} }));

  const report = s.items.find((it): it is AgentSubagentReportItem => it.kind === "subagent_result");
  assert.ok(report, "summary 必须转存成产出卡，不得随 clearSubagentItems 消失");
  assert.equal(report.text, summary);
  assert.equal(report.label, "视频牌价预检");
  assert.equal(report.status, "ok");
  assert.equal(report.subagentId, "sa1");
});

test("F3 中止走 session.error 也不销毁产出：running 条目跨中止保留（0921 契约）", () => {
  const stream = "权威牌价表：seedance-2.0 13 币/条\nseedance-2.0-fast 10 币/条";
  let s = agentChatReducer(EMPTY, evt({ name: "subagent.started", event_id: 1, data: { id: "sa9", label: "视频全量模型普查" } }));
  s = agentChatReducer(s, evt({ name: "subagent.delta", event_id: 2, data: { id: "sa9", text: stream } }));
  s = agentChatReducer(
    s,
    evt({ name: "session.error", event_id: 3, data: { code: "tool_error", message: "Tool execution aborted", human_message: "已按你的要求中止本轮" } }),
  );

  const sub = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(sub, "中止当下 running 条目原样保留——中止后画面不能比中止前更空");
  assert.equal(sub.status, "running", "终态留给 gateway 的 subagent.done（0920 停止闸会发 stopped）独占裁决");
  assert.equal(sub.text, stream, "串流全文留在条目上，不丢弃");
});

test("F4 超长文字进模型时保留全文（截断只发生在渲染层）", () => {
  const lines = Array.from({ length: 120 }, (_, i) => `第 ${i} 行：权威牌价与交付证据`);
  const long = lines.join("\n");
  let s = agentChatReducer(EMPTY, evt({ name: "subagent.started", event_id: 1, data: { id: "sa1", label: "研究" } }));
  s = agentChatReducer(s, evt({ name: "subagent.delta", event_id: 2, data: { id: "sa1", text: long } }));

  const sub = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(sub);
  assert.equal(sub.text, long, "模型层保留全文");
  assert.equal(sub.lastLine, lines[lines.length - 1], "lastLine 只是渲染预览（末行）");

  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 3, data: {} }));
  // 0921 契约：running 条目跨回合保留，回合收尾不退场也不转存——全文仍留在条目上。
  const kept = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(kept, "running 条目跨回合保留，收尾不得退场");
  assert.equal(kept.status, "running");
  assert.ok(!s.items.some((it) => it.kind === "subagent_result"), "未定态不转存：等 done 帧");
  assert.equal(kept.text, long, "模型层保留全文（截断只发生在渲染层）");

  // 完工的 done 帧落在后续回合，下一次收尾才转存成带全文的产出卡。
  s = agentChatReducer(s, evt({ name: "subagent.done", event_id: 4, data: { id: "sa1", status: "ok" } }));
  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 5, data: {} }));
  const report = s.items.find((it): it is AgentSubagentReportItem => it.kind === "subagent_result");
  assert.ok(report, "定案后的收尾才转存产出卡");
  assert.equal(report.text, long, "产出卡带全文");
  assert.ok(report.text.includes("第 0 行"), "开头没有被砍掉");
  assert.ok(report.text.includes(lines[lines.length - 1]), "结尾没有被砍掉");
});

// ── S2 活动流：reasoning 只喂跑马灯，不污染交付物（2026-09-11 跨片契约）──────

test("S2 活动流：kind=reasoning 的 delta 只进 activity，不污染 text / lastLine", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "subagent.started", event_id: 1, data: { id: "sa1", label: "搜索素材" } }));
  s = agentChatReducer(s, evt({ name: "subagent.delta", event_id: 2, data: { id: "sa1", text: "先看看候选", kind: "reasoning" } }));

  let sub = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(sub);
  assert.equal(sub.activity, "先看看候选", "reasoning 进活动流（跑马灯才有东西可滚）");
  // text 是交付物：产出卡会把 text 当全文带走，混入思考就是谎报交付物。
  assert.equal(sub.text, undefined, "reasoning 不得进 text");
  assert.equal(sub.lastLine, "", "reasoning 不得进 lastLine");
  assert.equal(sub.status, "running");
  assert.equal(s.turnActive, true);

  // 尾段累加：第二帧 reasoning 接在 activity 尾巴上。
  s = agentChatReducer(s, evt({ name: "subagent.delta", event_id: 3, data: { id: "sa1", text: "，再核价", kind: "reasoning" } }));
  sub = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(sub);
  assert.equal(sub.activity, "先看看候选，再核价", "activity 尾端累加，不替换");
  assert.equal(sub.text, undefined, "连续 reasoning 也不长出 text");

  // 正文到来：text 只收正文，activity 收全部（reasoning 也算在工作）。
  s = agentChatReducer(s, evt({ name: "subagent.delta", event_id: 4, data: { id: "sa1", text: "找到 3 张" } }));
  sub = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(sub);
  assert.equal(sub.text, "找到 3 张", "text 只有正文");
  assert.equal(sub.lastLine, "找到 3 张");
  assert.equal(sub.activity, "先看看候选，再核价找到 3 张", "活动流是「全部增量」的超集");

  // 思考不是交付物（0921 契约版）：首回合收尾 running 不退场、无产出卡；
  // done 落在 wake 后的回合，下一次收尾才转存——届时全文仍只收正文，思考不得混进。
  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 5, data: {} }));
  assert.ok(
    s.items.some((it) => it.kind === "subagent" && (it as AgentSubagentItem).status === "running"),
    "回合收尾保留 running 卡（跨回合在跑）",
  );
  s = agentChatReducer(s, evt({ name: "subagent.done", event_id: 6, data: { id: "sa1", status: "ok" } }));
  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 7, data: {} }));
  const report = s.items.find((it): it is AgentSubagentReportItem => it.kind === "subagent_result");
  assert.ok(report, "定案后的收尾转存产出卡");
  assert.ok(!report.text.includes("先看看候选"), "reasoning 不得流入产出卡全文");
});

test("S2 活动流：无 kind 的正文 delta 同时追加 text 与 activity（正文也算活动）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "subagent.started", event_id: 1, data: { id: "sa1", label: "搜索素材" } }));
  s = agentChatReducer(s, evt({ name: "subagent.delta", event_id: 2, data: { id: "sa1", text: "第一行" } }));
  s = agentChatReducer(s, evt({ name: "subagent.delta", event_id: 3, data: { id: "sa1", text: "\n第二行" } }));

  const sub = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(sub);
  // 既有行为不变（F4）。
  assert.equal(sub.text, "第一行\n第二行", "text 照旧累积全文");
  assert.equal(sub.lastLine, "第二行", "lastLine 照旧只当渲染预览");
  // 新增：正文同样是「子代理在工作」的讯号，活动流必须同步跟上。
  assert.equal(sub.activity, "第一行\n第二行", "正文 delta 同步进 activity");
});

test("S2 活动流：started 丢失且首帧是 reasoning 时，补的卡只有 activity、不伪造 text", () => {
  const s = agentChatReducer(EMPTY, evt({ name: "subagent.delta", event_id: 1, data: { id: "sa-x", text: "在想…", kind: "reasoning" } }));
  const sub = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(sub);
  assert.equal(sub.status, "running");
  assert.equal(sub.activity, "在想…");
  assert.equal(sub.text, undefined, "思考不冒充交付物");
  assert.equal(sub.lastLine, "");
});

// ── 提交型工具的中继态（2026-09-18 契约：artifact_pending / task_id）──────────
//
// 语义：tool.result 带 artifact_pending=true = 任务已提交成功、成品还没到，
// 卡片停在中继态 pending（绝不显示「已完成」）；等成品事件（image/video/audio.done）
// 或失败事件（image.failed）到了才转终态。旧格式（不带新栏位）逐位元照旧。

test("tool.result artifact_pending=true → 卡片是中继态 pending，不是 ok，且回填 taskId", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "image_generate" } }));
  s = agentChatReducer(
    s,
    evt({
      name: "tool.result",
      event_id: 2,
      data: { tool: "image_generate", ok: true, cost_coins: 3, task_id: "t-1", artifact_pending: true },
    }),
  );

  const it = s.items[0] as AgentToolCallItem;
  assert.equal(it.status, "pending", "已提交 ≠ 已完成");
  assert.notEqual(it.status, "ok");
  assert.equal(it.taskId, "t-1", "task_id 必须写进卡片，成品事件才配得回来");
  assert.equal(it.costCoins, 3, "计费栏位照旧透传（钱确实花了）");
  assert.equal(s.turnActive, true);
});

test("image.done 带 task_id → 只结算对应那张 pending 卡（同批其他任务照旧等）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "image_generate" } }));
  s = agentChatReducer(
    s,
    evt({ name: "tool.result", event_id: 2, data: { tool: "image_generate", ok: true, task_id: "t-a", artifact_pending: true } }),
  );
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 3, data: { tool: "image_generate" } }));
  s = agentChatReducer(
    s,
    evt({ name: "tool.result", event_id: 4, data: { tool: "image_generate", ok: true, task_id: "t-b", artifact_pending: true } }),
  );

  s = agentChatReducer(s, evt({ name: "image.done", event_id: 5, data: { url: "https://x/a.png", task_id: "t-b" } }));

  const tools = s.items.filter((it): it is AgentToolCallItem => it.kind === "tool");
  assert.equal(tools[0]?.status, "pending", "任务号不匹配的卡不得被误结算");
  assert.equal(tools[1]?.status, "ok", "成品到了，对应的 pending 卡结算成 ok");
  assert.equal(s.items.filter((it) => it.kind === "image").length, 1, "出图卡照旧建立（去重行为不变）");
});

test("image.failed 带 task_id → 对应的 pending 卡判失败、带上 human_message，notice 照旧留痕", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "image_generate" } }));
  s = agentChatReducer(
    s,
    evt({ name: "tool.result", event_id: 2, data: { tool: "image_generate", ok: true, task_id: "t-9", artifact_pending: true } }),
  );
  s = agentChatReducer(
    s,
    evt({ name: "image.failed", event_id: 3, data: { task_id: "t-9", reason: "deadline exceeded", refunded: true, human_message: "上游超时，费用已退回" } }),
  );

  const it = s.items[0] as AgentToolCallItem;
  assert.equal(it.status, "failed", "失败事件必须把还在转的卡判死，不留假「生成中…」");
  assert.equal(it.error, "上游超时，费用已退回", "human_message 顺手填进卡片");
  const notice = s.items.find((n): n is AgentNoticeItem => n.kind === "notice");
  assert.ok(notice, "原本的 notice 行为保留");
  assert.match(notice.text, /费用已退回/);
});

test("turn.done 不判死 pending 卡（running 照旧判死，pending 留著等成品/失败事件）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "bash" } }));
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 2, data: { tool: "image_generate" } }));
  s = agentChatReducer(
    s,
    evt({ name: "tool.result", event_id: 3, data: { tool: "image_generate", ok: true, task_id: "t-1", artifact_pending: true } }),
  );

  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 4, data: {} }));

  const tools = s.items as AgentToolCallItem[];
  assert.equal(tools[0]?.status, "failed", "没交出去的 running 卡照旧判死");
  assert.equal(tools[1]?.status, "pending", "回合结束 ≠ 成品到了：pending 必须留著，不能被 settleItems 判死");
  assert.equal(s.turnActive, false);
});

test("无 task_id 的 image.done → FIFO 结算最旧的一张 pending 卡", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "image_generate" } }));
  s = agentChatReducer(
    s,
    evt({ name: "tool.result", event_id: 2, data: { tool: "image_generate", ok: true, task_id: "t-1", artifact_pending: true } }),
  );
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 3, data: { tool: "image_generate" } }));
  s = agentChatReducer(
    s,
    evt({ name: "tool.result", event_id: 4, data: { tool: "image_generate", ok: true, task_id: "t-2", artifact_pending: true } }),
  );

  // 成品事件没带 task_id：配不到精确的，回退结算最旧那张（防成品到了卡还在转）。
  s = agentChatReducer(s, evt({ name: "image.done", event_id: 5, data: { url: "https://x/a.png" } }));

  const tools = s.items.filter((it): it is AgentToolCallItem => it.kind === "tool");
  assert.equal(tools[0]?.status, "ok", "FIFO：最旧的 pending 先结算");
  assert.equal(tools[1]?.status, "pending", "较新的 pending 留著，继续等自己的成品事件");
});

test("video.done / audio.done 同样结算 pending 卡（成品事件不只有图）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "video_generate" } }));
  s = agentChatReducer(
    s,
    evt({ name: "tool.result", event_id: 2, data: { tool: "video_generate", ok: true, task_id: "v-1", artifact_pending: true } }),
  );
  s = agentChatReducer(s, evt({ name: "video.done", event_id: 3, data: { url: "https://x/a.mp4", task_id: "v-1" } }));
  assert.equal((s.items[0] as AgentToolCallItem).status, "ok");

  let a = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "music_gen" } }));
  a = agentChatReducer(
    a,
    evt({ name: "tool.result", event_id: 2, data: { tool: "music_gen", ok: true, task_id: "m-1", artifact_pending: true } }),
  );
  a = agentChatReducer(a, evt({ name: "audio.done", event_id: 3, data: { url: "https://x/a.m4a", task_id: "m-1" } }));
  assert.equal((a.items[0] as AgentToolCallItem).status, "ok");
});

test("缺席新栏位的旧格式 tool.result → 行为与现状逐位元一致（直接 ok，不长 taskId）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "gen" } }));
  s = agentChatReducer(s, evt({ name: "tool.result", event_id: 2, data: { tool: "gen", ok: true, cost_coins: 2 } }));

  const it = s.items[0] as AgentToolCallItem;
  assert.equal(it.status, "ok", "旧格式不得被当成中继态");
  assert.equal(it.taskId, undefined);
  assert.equal(it.costCoins, 2);

  // ok:false 的旧格式照旧 failed。
  let f = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "gen" } }));
  f = agentChatReducer(f, evt({ name: "tool.result", event_id: 2, data: { tool: "gen", ok: false } }));
  assert.equal((f.items[0] as AgentToolCallItem).status, "failed");
});

// ─────────────────────────── turn.plan（本轮计画，2026-09-18 契约）

test("turn.plan 落成独立的 plan 条目，不并进 assistant 条目", () => {
  const s = agentChatReducer(
    EMPTY,
    evt({
      name: "turn.plan",
      event_id: 1,
      data: { plan: "打算这么做：先拆解分镜脚本，再生成配乐。", experts: ["screenwriter"], provisional: true, source: "model" },
    }),
  );

  assert.equal(s.items.length, 1, "计画自成条目，不寄生在任何既有条目上");
  const plan = s.items[0] as AgentPlanItem;
  assert.equal(plan.kind, "plan");
  assert.equal(plan.text, "打算这么做：先拆解分镜脚本，再生成配乐。");
  assert.deepEqual(plan.experts, ["screenwriter"]);
  assert.equal(plan.provisional, true);
  assert.equal(plan.collapsed, false, "刚到的计画预设展开（此刻它是画面上唯一的资讯）");
  assert.equal(s.turnActive, true, "计画帧到达 = 回合确实开始了");
});

test("turn.plan 清掉罐头状态行（turnStatus），与 message.delta 同款", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "正在思考…" } }));
  assert.equal(s.turnStatus, "正在思考…");
  s = agentChatReducer(s, evt({ name: "turn.plan", event_id: 2, data: { plan: "先出分镜再出片。" } }));
  assert.equal(s.turnStatus, undefined, "真实计画到了，暂态罐头行必须退场");
  assert.equal((s.items[0] as AgentPlanItem).kind, "plan");
});

test("首条 message.delta 开新 assistant 条目时，计画被收合成一行", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.plan", event_id: 1, data: { plan: "先拆解剧情节拍，再逐镜生成。" } }));
  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 2, data: { text: "好的" } }));

  assert.equal(s.items.length, 2, "计画与正文是两条独立条目");
  const plan = s.items[0] as AgentPlanItem;
  const assistant = s.items[1] as AgentAssistantTextItem;
  assert.equal(plan.collapsed, true, "真实正文开新条目 = 计画让位，自动收合");
  assert.equal(plan.text, "先拆解剧情节拍，再逐镜生成。", "收合只翻 collapsed，计画文字一字不动");
  assert.equal(assistant.kind, "assistant");
  assert.equal(assistant.text, "好的", "正文不得把计画文字吃进同一条气泡");
});

test("追加到既有 streaming assistant 条目的 delta 不动计画卡（不误触另一条分支）", () => {
  // reasoning 先开条目（思维链通常先于正文），之后的 message.delta 走「追加既有
  // streaming 条目」分支 —— 那条分支与工具卡 pending 契约的测试语义挂在一起，
  // 计画收合只在「开新条目」分支发生，这里不得被波及。
  let s = agentChatReducer(EMPTY, evt({ name: "turn.plan", event_id: 1, data: { plan: "先出分镜。" } }));
  s = agentChatReducer(s, evt({ name: "reasoning.delta", event_id: 2, data: { text: "先想一下" } }));
  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 3, data: { text: "开始" } }));

  assert.equal((s.items[0] as AgentPlanItem).collapsed, false, "同一条交付物的续写不触发计画收合");
  assert.equal((s.items[1] as AgentAssistantTextItem).text, "开始");
});

test("turn.done 后计画仍在，且不影响 settleItems 对 running 工具卡的结算", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.plan", event_id: 1, data: { plan: "先出分镜，再逐镜生成视频。" } }));
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 2, data: { tool: "bash" } }));
  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 3, data: { text: "开始处理" } }));
  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 4, data: {} }));

  const plan = s.items.find((it): it is AgentPlanItem => it.kind === "plan");
  assert.ok(plan, "回合收尾不删计画卡（它是这一轮做过什么的痕迹）");
  assert.equal(plan.collapsed, true);
  const tool = s.items.find((it): it is AgentToolCallItem => it.kind === "tool");
  assert.equal(tool?.status, "failed", "running 工具卡照旧由 settleItems 判死");
  assert.equal(s.turnActive, false);
});

test("superseded 帧就地换掉既有计画文字（同一 id），不新增第二张卡", () => {
  let s = agentChatReducer(
    EMPTY,
    evt({ name: "turn.plan", event_id: 1, data: { plan: "旧计画：先出分镜。", source: "rule" } }),
  );
  const firstId = s.items[0].id;
  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 2, data: { text: "正文" } }));
  assert.equal((s.items[0] as AgentPlanItem).collapsed, true);

  s = agentChatReducer(
    s,
    evt({ name: "turn.plan", event_id: 3, data: { plan: "新计画：先拆解剧情节拍，再逐镜生成并剪辑。", superseded: true, source: "model" } }),
  );

  const plans = s.items.filter((it): it is AgentPlanItem => it.kind === "plan");
  assert.equal(plans.length, 1, "同一轮只有一份计画：就地换文字，不堆成版本流水帐");
  assert.equal(plans[0].id, firstId, "id 不变，React 不重挂卡片");
  assert.equal(plans[0].text, "新计画：先拆解剧情节拍，再逐镜生成并剪辑。");
  assert.equal(plans[0].collapsed, true, "换文字不动使用者在看／收合状态");
});

test("思考后直接调工具：tool.invoke 当下结算 reasoningMs，不拖到整轮结束", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "reasoning.delta", event_id: 1, data: { text: "先抓影片" } }));
  const started = s.items[0];
  assert.equal(started.kind, "assistant");
  assert.equal(started.kind === "assistant" ? started.reasoningMs : "x", undefined);
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 2, data: { tool: "video_fetch", args_summary: "{}" } }));
  const settled = s.items[0];
  assert.equal(settled.kind, "assistant");
  assert.equal(typeof (settled.kind === "assistant" ? settled.reasoningMs : undefined), "number");
  assert.equal(s.items[1].kind, "tool");
});
