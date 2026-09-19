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

/** 建一幀被 TypeScript 檢過型別的 SSE 事件。 */
function evt(event: AgentSseEvent): AgentSseEvent {
  return event;
}

const EMPTY = EMPTY_AGENT_CHAT_STATE;

test("message.delta 併進同一個 streaming 條目，不逐幀開新條目", () => {
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

test("reasoning.delta 累積到 streaming 條目的 reasoning 欄位，不污染 text", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "reasoning.delta", event_id: 1, data: { text: "The" } }));
  s = agentChatReducer(s, evt({ name: "reasoning.delta", event_id: 2, data: { text: " user" } }));
  assert.equal(s.items.length, 1);
  const a = s.items[0] as AgentAssistantTextItem;
  assert.equal(a.kind, "assistant");
  assert.equal(a.reasoning, "The user");
  assert.equal(a.text, "");
  assert.equal(a.streaming, true);
});

test("reasoning 後接 message.delta：同一條目，text 與 reasoning 並存", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "reasoning.delta", event_id: 1, data: { text: "畫" } }));
  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 2, data: { text: "完成" } }));
  const a = s.items[0] as AgentAssistantTextItem;
  assert.equal(a.reasoning, "畫");
  assert.equal(a.text, "完成");
  assert.equal(s.items.length, 1);
});

test("turn.done 之後的 delta 才開新條目", () => {
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

test("tool.invoke → tool.result 回填同一個條目，id 不變", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "generate_image", args_summary: "..." } }));
  assert.equal(s.items.length, 1);
  const before = s.items[0] as AgentToolCallItem;
  assert.equal(before.status, "running");

  s = agentChatReducer(s, evt({ name: "tool.result", event_id: 2, data: { tool: "generate_image", ok: true, cost_coins: 3 } }));

  assert.equal(s.items.length, 1);
  const after = s.items[0] as AgentToolCallItem;
  assert.equal(after.id, before.id, "回填必須沿用原條目 id");
  assert.equal(after.status, "ok");
  assert.equal(after.costCoins, 3);
  assert.equal(s.turnActive, true);
});

test("tool.result 沒有對應 invoke 時，補一筆已定案條目（去重/斷線把 invoke 弄丟了）", () => {
  const s = agentChatReducer(EMPTY, evt({ name: "tool.result", event_id: 5, data: { tool: "gen", ok: false } }));

  assert.equal(s.items.length, 1);
  const it = s.items[0] as AgentToolCallItem;
  assert.equal(it.kind, "tool");
  assert.equal(it.status, "failed");
  assert.equal(it.seq, 5);
});

test("tool.result 失敗時透傳 error.human_message 到條目（R10-1：紅卡帶人類可讀錯誤）", () => {
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
  assert.equal(it.error, "text 节点必须填 content（提示词内容）或 shot", "優先取 human_message");
  assert.equal(s.turnActive, true);
});

test("tool.result 失敗但無 error 欄位時，error 為 undefined（不假造錯誤面）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "gen" } }));
  s = agentChatReducer(s, evt({ name: "tool.result", event_id: 2, data: { tool: "gen", ok: false } }));

  const it = s.items[0] as AgentToolCallItem;
  assert.equal(it.status, "failed");
  assert.equal(it.error, undefined);
});

test("tool.result 只回填最近一個同名 running 條目", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "gen" } }));
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 2, data: { tool: "gen" } }));
  s = agentChatReducer(s, evt({ name: "tool.result", event_id: 3, data: { tool: "gen", ok: true, cost_coins: 1 } }));

  const items = s.items as AgentToolCallItem[];
  assert.equal(items[0]?.status, "running", "前面的同名調用不受影響");
  assert.equal(items[1]?.status, "ok");
  assert.equal(items[1]?.costCoins, 1);
});

test("tool.progress 回填同名 running 卡的進度（逐鏡中間態）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "keyframe_render" } }));
  s = agentChatReducer(s, evt({ name: "tool.progress", event_id: 2, data: { tool: "keyframe_render", done: 3, total: 8, label: "渲染關鍵幀" } }));

  const items = s.items as AgentToolCallItem[];
  assert.equal(items.length, 1, "進度不新建條目");
  assert.equal(items[0]?.status, "running", "進度不改終態");
  assert.deepEqual(items[0]?.progress, { done: 3, total: 8, label: "渲染關鍵幀" });
  assert.equal(s.turnActive, true);
});

test("tool.progress 逐鏡跳動：後一幀覆蓋前一幀，id 不變", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "keyframe_render" } }));
  const firstId = (s.items[0] as AgentToolCallItem).id;
  s = agentChatReducer(s, evt({ name: "tool.progress", event_id: 2, data: { tool: "keyframe_render", done: 1, total: 8 } }));
  s = agentChatReducer(s, evt({ name: "tool.progress", event_id: 3, data: { tool: "keyframe_render", done: 2, total: 8 } }));

  const items = s.items as AgentToolCallItem[];
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, firstId, "同一張卡原地更新");
  assert.deepEqual(items[0]?.progress, { done: 2, total: 8 });
});

test("tool.progress 找不到同名 running 卡時丟棄（invoke 丟了/已結算）", () => {
  // 無任何條目
  const empty = agentChatReducer(EMPTY, evt({ name: "tool.progress", event_id: 1, data: { tool: "gen", done: 1, total: 4 } }));
  assert.equal(empty.items.length, 0, "無 running 卡不憑空造條目");

  // 已結算（ok）的卡不再吃進度
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "gen" } }));
  s = agentChatReducer(s, evt({ name: "tool.result", event_id: 2, data: { tool: "gen", ok: true } }));
  s = agentChatReducer(s, evt({ name: "tool.progress", event_id: 3, data: { tool: "gen", done: 1, total: 4 } }));
  const items = s.items as AgentToolCallItem[];
  assert.equal(items.length, 1);
  assert.equal(items[0]?.progress, undefined, "終態卡不被進度污染");
});

test("tool.progress 只回填最近一個同名 running 條目", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "gen" } }));
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 2, data: { tool: "gen" } }));
  s = agentChatReducer(s, evt({ name: "tool.progress", event_id: 3, data: { tool: "gen", done: 1, total: 5 } }));

  const items = s.items as AgentToolCallItem[];
  assert.equal(items[0]?.progress, undefined, "前面的同名調用不受影響");
  assert.deepEqual(items[1]?.progress, { done: 1, total: 5 });
});

test("image.done 同 url 去重，不同 url 各自成條目", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "image.done", event_id: 1, data: { url: "https://x/1.png", cost_coins: 2 } }));
  assert.equal(s.items.length, 1);

  s = agentChatReducer(s, evt({ name: "image.done", event_id: 2, data: { url: "https://x/1.png", cost_coins: 2 } }));
  assert.equal(s.items.length, 1, "同 url 重送必須被吃掉");

  s = agentChatReducer(s, evt({ name: "image.done", event_id: 3, data: { url: "https://x/2.png" } }));
  assert.equal(s.items.length, 2);
  const first = s.items[0] as { url: string };
  const second = s.items[1] as { url: string };
  assert.equal(first.url, "https://x/1.png");
  assert.equal(second.url, "https://x/2.png");
});

test("video.done 同 url 去重，不同 url 各自成條目，mediaKind 透傳", () => {
  let s = agentChatReducer(
    EMPTY,
    evt({ name: "video.done", event_id: 1, data: { url: "https://x/a.mp4", cost_coins: 5, media_kind: "film" } }),
  );
  assert.equal(s.items.length, 1);
  assert.equal(s.turnActive, true);

  s = agentChatReducer(s, evt({ name: "video.done", event_id: 2, data: { url: "https://x/a.mp4", cost_coins: 5 } }));
  assert.equal(s.items.length, 1, "同 url 重送必須被吃掉");

  s = agentChatReducer(s, evt({ name: "video.done", event_id: 3, data: { url: "https://x/b.mp4", media_kind: "video" } }));
  assert.equal(s.items.length, 2);

  const first = s.items[0] as AgentVideoItem;
  const second = s.items[1] as AgentVideoItem;
  assert.equal(first.kind, "video");
  assert.equal(first.url, "https://x/a.mp4");
  assert.equal(first.costCoins, 5);
  assert.equal(first.mediaKind, "film", "media_kind 要透傳到條目");
  assert.equal(second.kind, "video");
  assert.equal(second.url, "https://x/b.mp4");
  assert.equal(second.mediaKind, "video");

  // 缺 media_kind 時條目留 undefined（展示層回落「影片」）。
  s = agentChatReducer(s, evt({ name: "video.done", event_id: 4, data: { url: "https://x/c.mp4" } }));
  const third = s.items[2] as AgentVideoItem;
  assert.equal(third.mediaKind, undefined);
});

test("video.done 與 image.done 互不影響去重（url 相同也各自成條目）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "image.done", event_id: 1, data: { url: "https://x/same" } }));
  s = agentChatReducer(s, evt({ name: "video.done", event_id: 2, data: { url: "https://x/same" } }));
  assert.equal(s.items.length, 2, "去重只比同 kind 的 url");
});

test("audio.done 同 url 去重，不同 url 各自成條目，mediaKind 透傳", () => {
  let s = agentChatReducer(
    EMPTY,
    evt({ name: "audio.done", event_id: 1, data: { url: "https://x/a.m4a", cost_coins: 3, media_kind: "music" } }),
  );
  assert.equal(s.items.length, 1);
  assert.equal(s.turnActive, true);

  s = agentChatReducer(s, evt({ name: "audio.done", event_id: 2, data: { url: "https://x/a.m4a", cost_coins: 3 } }));
  assert.equal(s.items.length, 1, "同 url 重送必須被吃掉");

  s = agentChatReducer(s, evt({ name: "audio.done", event_id: 3, data: { url: "https://x/b.mp3", media_kind: "audio" } }));
  assert.equal(s.items.length, 2);

  const first = s.items[0] as AgentAudioItem;
  const second = s.items[1] as AgentAudioItem;
  assert.equal(first.kind, "audio");
  assert.equal(first.url, "https://x/a.m4a");
  assert.equal(first.costCoins, 3);
  assert.equal(first.mediaKind, "music", "media_kind 要透傳到條目");
  assert.equal(first.seq, 1, "seq 是會話內第幾條音頻，不是網關 event_id");
  assert.equal(second.kind, "audio");
  assert.equal(second.url, "https://x/b.mp3");
  assert.equal(second.mediaKind, "audio");
  assert.equal(second.seq, 2);

  // 缺 media_kind 時條目留 undefined（展示層回落「音频」）。
  s = agentChatReducer(s, evt({ name: "audio.done", event_id: 4, data: { url: "https://x/c.wav" } }));
  const third = s.items[2] as AgentAudioItem;
  assert.equal(third.mediaKind, undefined);

  // 音頻與影片互不影響去重（url 相同也各自成條目）。
  let both = agentChatReducer(EMPTY, evt({ name: "video.done", event_id: 1, data: { url: "https://x/same" } }));
  both = agentChatReducer(both, evt({ name: "audio.done", event_id: 2, data: { url: "https://x/same" } }));
  assert.equal(both.items.length, 2, "去重只比同 kind 的 url");
});

test("event_id <= lastEventId 的幀整幀丟棄（斷線重連去重）", () => {
  const s = agentChatReducer(EMPTY, evt({ name: "message.delta", event_id: 3, data: { text: "hi" } }));
  assert.equal(s.lastEventId, 3);

  // 同序號重放：回同一個 reference，內容不重複加。
  const frozen = s;
  const replayed = agentChatReducer(frozen, evt({ name: "message.delta", event_id: 3, data: { text: "X" } }));
  assert.equal(replayed, frozen);
  assert.equal(replayed.items.length, 1);
  assert.equal((replayed.items[0] as AgentAssistantTextItem).text, "hi");

  // 更舊的序號（例如 reconnect 前的最後一幀）也一樣被吃掉。
  const older = agentChatReducer(frozen, evt({ name: "tool.invoke", event_id: 1, data: { tool: "x" } }));
  assert.equal(older, frozen);
  assert.equal(older.items.length, 1);

  // 新序號正常處理，且 lastEventId 推進。
  const newer = agentChatReducer(frozen, evt({ name: "message.delta", event_id: 4, data: { text: "!" } }));
  assert.equal(newer.lastEventId, 4);
});

test("turn.done 收掉還在轉的工具與 streaming 標記", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "message.delta", event_id: 1, data: { text: "a" } }));
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 2, data: { tool: "t1" } }));
  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 3, data: {} }));

  assert.equal(s.turnActive, false);
  assert.equal((s.items[0] as AgentAssistantTextItem).streaming, false);
  assert.equal((s.items[1] as AgentToolCallItem).status, "failed", "一輪結束不能留一個永遠在轉的工具");
});

test("session.closed 清空待確認、停掉 streaming/工具、留 notice", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "confirm.request", event_id: 1, data: { request_id: "r1", amount_coins: 10 } }));
  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 2, data: { text: "a" } }));
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 3, data: { tool: "t" } }));
  s = agentChatReducer(s, evt({ name: "session.closed", event_id: 4, data: { reason: "quota_exhausted" } }));

  assert.equal(s.closed, true);
  assert.equal(s.closedReason, "quota_exhausted");
  assert.equal(s.pendingConfirms.length, 0);
  assert.equal(s.pendingQuestions.length, 0);
  assert.equal(s.turnActive, false);
  // confirm.request 不產條目，所以 items = [assistant, tool, notice]。
  assert.equal((s.items[0] as AgentAssistantTextItem).streaming, false);
  assert.equal((s.items[1] as AgentToolCallItem).status, "failed");
  const last = s.items[s.items.length - 1] as AgentNoticeItem;
  assert.equal(last.kind, "notice");
});

test("confirm.request 同 requestId 去重", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "confirm.request", event_id: 1, data: { request_id: "r1", amount_coins: 5 } }));
  s = agentChatReducer(s, evt({ name: "confirm.request", event_id: 2, data: { request_id: "r1", amount_coins: 9 } }));

  assert.equal(s.pendingConfirms.length, 1);
  assert.equal(s.pendingConfirms[0]?.amountCoins, 5, "以先到的金額為準");
});

test("confirm.resolved 移除對應待確認並留 notice", () => {
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
      question: "要什麼規格？",
      header: "規格",
      options: [{ label: "10 秒", description: "穩" }, { label: "15 秒" }],
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

test("confirm.resolved 對從沒看過的 requestId 不拋錯（另一台裝置裁的）", () => {
  const s = agentChatReducer(EMPTY, evt({ name: "confirm.resolved", event_id: 1, data: { request_id: "never-seen", approved: true } }));

  assert.equal(s.pendingConfirms.length, 0);
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0]?.kind, "notice");
});

test("quota.changed 替換額度", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "quota.changed", event_id: 1, data: { balance_coins: 20, currency: "coins", available: true } }));
  assert.equal(s.quota?.balanceCoins, 20);
  assert.equal(s.quota?.currency, "coins");
  assert.equal(s.quota?.available, true);

  s = agentChatReducer(s, evt({ name: "quota.changed", event_id: 2, data: { balance_coins: null, currency: "coins", available: false, reason: "upstream_down" } }));
  assert.equal(s.quota?.balanceCoins, null);
  assert.equal(s.quota?.available, false);
});

test("session.error 留 error notice，但不終結會話", () => {
  const s = agentChatReducer(EMPTY, evt({ name: "session.error", event_id: 1, data: { code: "tool_failed", message: "出圖失敗" } }));

  assert.equal(s.closed, false, "錯誤不該關掉會話");
  const last = s.items[s.items.length - 1] as AgentNoticeItem;
  assert.equal(last.kind, "notice");
  assert.equal(last.tone, "error");
  assert.equal(last.text, "出圖失敗");
});

test("image.failed 當場留 error notice（refunded 講退款、普通失敗講原因）", () => {
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
  assert.equal(failed.turnActive, true, "失敗也是產出訊號，turn 照樣活著等 turn.done");
});

test("turnActive 由產出事件打開、turn.done 關掉", () => {
  assert.equal(EMPTY.turnActive, false);

  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "t" } }));
  assert.equal(s.turnActive, true);

  s = agentChatReducer(s, evt({ name: "image.done", event_id: 2, data: { url: "u" } }));
  assert.equal(s.turnActive, true);

  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 3, data: {} }));
  assert.equal(s.turnActive, false);
});

test("reducer 不 mutate 輸入 state（條目陣列與內容原封不動）", () => {
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
  assert.equal((before.items[1] as AgentToolCallItem).status, "running", "原條目不能被回填改掉");
  assert.equal((next.items[1] as AgentToolCallItem).status, "ok");
});

test("appendUserTurn 樂觀插入使用者訊息，id 穩定不碰撞", () => {
  let s = appendUserTurn(EMPTY, "hello");
  assert.equal(s.items.length, 1);
  const first = s.items[0] as AgentUserTurnItem;
  assert.equal(first.kind, "user");
  assert.equal(first.text, "hello");
  assert.equal(first.seq, 0);

  s = appendUserTurn(s, "world", [{ kind: "image", url: "https://x/a.png" }]);
  assert.equal(s.items.length, 2);
  const second = s.items[1] as AgentUserTurnItem;
  assert.notEqual(second.id, first.id, "兩則使用者訊息的 id 不能碰撞");
  assert.equal(second.attachments?.length, 1);
});

test("applyQuotaSnapshot 填入額度", () => {
  const s = applyQuotaSnapshot(EMPTY, { balanceCoins: 12, currency: "coins", available: true });
  assert.deepEqual(s.quota, { balanceCoins: 12, currency: "coins", available: true });
});

test("條目 id 是決定性的：同樣事件序列產出同樣結果", () => {
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

test("turn.status 落 turnStatus 暫態欄位，不進 items 正文", () => {
  const s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "處理中（已 45s）：工具與子代理仍在執行。" } }));
  assert.equal(s.turnStatus, "處理中（已 45s）：工具與子代理仍在執行。");
  assert.equal(s.turnActive, true);
  assert.equal(s.items.length, 0);
});

test("turn.status 新狀態替換舊狀態（單行原地刷新，不累加）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "處理中（已 45s）：工具與子代理仍在執行。" } }));
  s = agentChatReducer(s, evt({ name: "turn.status", event_id: 2, data: { text: "處理中（已 90s）：可繼續等待；若想中斷，按停止後改派更小範圍。" } }));
  assert.equal(s.turnStatus, "處理中（已 90s）：可繼續等待；若想中斷，按停止後改派更小範圍。");
});

test("真實正文 message.delta 到達即清 turnStatus", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "處理中（已 45s）：工具與子代理仍在執行。" } }));
  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 2, data: { text: "搞定，" } }));
  assert.equal(s.turnStatus, undefined);
});

test("tool.invoke 期間 turnStatus 保留（工具執行中狀態行仍成立）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "處理中（已 45s）：工具與子代理仍在執行。" } }));
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 2, data: { tool: "bash", args_summary: "curl …" } }));
  assert.equal(s.turnStatus, "處理中（已 45s）：工具與子代理仍在執行。");
});

test("turn.done 清 turnStatus", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "處理中（已 45s）：工具與子代理仍在執行。" } }));
  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 2, data: {} }));
  assert.equal(s.turnStatus, undefined);
});

test("appendUserTurn 新輪開始清 turnStatus", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "處理中（已 45s）：工具與子代理仍在執行。" } }));
  s = appendUserTurn(s, "再画一张");
  assert.equal(s.turnStatus, undefined);
});

// ── 会话已关闭后的迟到帧守卫（P0 回归） ─────────────────────────

test("state.closed 後，遲到的 message.delta 不再被處理（items 不變，不重新開 assistant 條目）", () => {
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

test("state.closed 後，遲到的 confirm.request 不再讓 pendingConfirms 死會話復活", () => {
  const closed = agentChatReducer(EMPTY, evt({ name: "session.closed", event_id: 1, data: {} }));
  assert.equal(closed.pendingConfirms.length, 0);

  const after = agentChatReducer(
    closed,
    evt({ name: "confirm.request", event_id: 2, data: { request_id: "late-1", amount_coins: 5 } }),
  );
  assert.equal(after.pendingConfirms.length, 0, "死会话上不该再长出待确认卡");
  assert.equal(after.closed, true);
});

test("已關閉後再次收到 session.closed（本端 end() 合成的 event_id:0 收尾帧）是幂等 no-op", () => {
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

test("event_id>0 的既有去重行為不受影響（eventId<=lastEventId 整幀丟棄）", () => {
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

// ── 子代理：狀態單一真源（F1）+ 產出保留（F3）+ 全文不截斷（F4）──────────

test("F1 async 派遣：工具卡先回 ok，子代理後失敗 → 卡片同步拉回失敗（不兩處打臉）", () => {
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

  // 子代理随后被中止/失敗：兩處狀態必須一致，不能一處「已完成」一處「失败」。
  s = agentChatReducer(s, evt({ name: "subagent.done", event_id: 4, data: { id: "sa3", status: "error", summary: "被中止" } }));
  assert.equal((s.items[0] as AgentToolCallItem).status, "failed");
  assert.equal((s.items[1] as AgentSubagentItem).status, "error");
});

test("F1 子代理狀態單一真源：started 綁定 dispatch 工具卡，done 一次結兩處", () => {
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
  assert.equal(toolBefore.subagentId, "sa1", "started 必須把子代理綁到剛派出的工具卡上");
  assert.equal(toolBefore.status, "running");
  assert.equal(subBefore.status, "running");

  s = agentChatReducer(s, evt({ name: "subagent.done", event_id: 3, data: { id: "sa1", status: "ok", summary: "预检完成" } }));

  const toolAfter = s.items.find((it): it is AgentToolCallItem => it.kind === "tool");
  const subAfter = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(toolAfter && subAfter);
  assert.equal(subAfter.status, "ok");
  assert.equal(toolAfter.status, "ok", "子代理完成即結算綁定的工具卡：同一批任務不許兩處狀態互相打臉");
  // 同一子代理在畫面模型裡只有一處狀態，且是完成態。
  const statuses = s.items
    .filter((it) => it.kind === "tool" && (it as AgentToolCallItem).subagentId === "sa1")
    .map((it) => (it as AgentToolCallItem).status);
  assert.deepEqual(statuses, ["ok"]);
  assert.ok(!s.items.some((it) => it.kind === "subagent" && it.status === "running"), "不得還有一處說運行中");
});

test("F1 中止收尾不留矛盾狀態：started 未 done + turn.done → 工具卡判死、產出卡標已中止", () => {
  let s = agentChatReducer(
    EMPTY,
    evt({
      name: "tool.invoke",
      event_id: 1,
      data: { tool: "subagent_dispatch", args_summary: '{"label":"视频全量模型普查"}' },
    }),
  );
  s = agentChatReducer(s, evt({ name: "subagent.started", event_id: 2, data: { id: "sa2", label: "视频全量模型普查" } }));
  s = agentChatReducer(s, evt({ name: "subagent.delta", event_id: 3, data: { id: "sa2", text: "610 秒零輸出" } }));
  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 4, data: {} }));

  const tool = s.items.find((it): it is AgentToolCallItem => it.kind === "tool" && it.subagentId === "sa2");
  const report = s.items.find((it): it is AgentSubagentReportItem => it.kind === "subagent_result");
  assert.ok(tool && report);
  assert.notEqual(tool.status, "running", "收尾不能留一張永遠在轉的工具卡");
  assert.equal(tool.status, "failed");
  assert.equal(report.status, "interrupted", "中止誠實標已中止，不謊報 ok");
  assert.ok(!s.items.some((it) => it.kind === "subagent"), "子代理欄條目退場：不留第二處狀態源");
});

test("F3 中止不銷毀產出：subagent.done 的 summary 轉存成產出卡留在轉錄裡", () => {
  const summary = [
    "| 模型 | 720p 單價 | 15s｜10s｜5s |",
    "|---|---|---|",
    "| seedance-2.0 | 13 幣/條 | 15s=10s=13 |",
    "seedance-2.0 近 24h 9 筆 0 交付（全退款）",
  ].join("\n");
  let s = agentChatReducer(EMPTY, evt({ name: "subagent.started", event_id: 1, data: { id: "sa1", label: "视频牌价预检" } }));
  s = agentChatReducer(s, evt({ name: "subagent.done", event_id: 2, data: { id: "sa1", status: "ok", summary } }));
  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 3, data: {} }));

  const report = s.items.find((it): it is AgentSubagentReportItem => it.kind === "subagent_result");
  assert.ok(report, "summary 必須轉存成產出卡，不得隨 clearSubagentItems 消失");
  assert.equal(report.text, summary);
  assert.equal(report.label, "视频牌价预检");
  assert.equal(report.status, "ok");
  assert.equal(report.subagentId, "sa1");
});

test("F3 中止走 session.error 也不銷毀產出（等不到 turn.done 的路徑）", () => {
  const stream = "權威牌價表：seedance-2.0 13 幣/條\nseedance-2.0-fast 10 幣/條";
  let s = agentChatReducer(EMPTY, evt({ name: "subagent.started", event_id: 1, data: { id: "sa9", label: "视频全量模型普查" } }));
  s = agentChatReducer(s, evt({ name: "subagent.delta", event_id: 2, data: { id: "sa9", text: stream } }));
  s = agentChatReducer(
    s,
    evt({ name: "session.error", event_id: 3, data: { code: "tool_error", message: "Tool execution aborted", human_message: "已按你的要求中止本轮" } }),
  );

  assert.ok(!s.items.some((it) => it.kind === "subagent"), "中止當下子代理條目退場");
  const report = s.items.find((it): it is AgentSubagentReportItem => it.kind === "subagent_result");
  assert.ok(report, "串流全文必須落成產出卡——中止後畫面不能比中止前更空");
  assert.equal(report.text, stream);
  assert.equal(report.status, "interrupted");
});

test("F4 超長文字進模型時保留全文（截斷只發生在渲染層）", () => {
  const lines = Array.from({ length: 120 }, (_, i) => `第 ${i} 行：權威牌價與交付證據`);
  const long = lines.join("\n");
  let s = agentChatReducer(EMPTY, evt({ name: "subagent.started", event_id: 1, data: { id: "sa1", label: "研究" } }));
  s = agentChatReducer(s, evt({ name: "subagent.delta", event_id: 2, data: { id: "sa1", text: long } }));

  const sub = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(sub);
  assert.equal(sub.text, long, "模型層保留全文");
  assert.equal(sub.lastLine, lines[lines.length - 1], "lastLine 只是渲染預覽（末行）");

  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 3, data: {} }));
  const report = s.items.find((it): it is AgentSubagentReportItem => it.kind === "subagent_result");
  assert.ok(report);
  assert.equal(report.text, long, "產出卡帶全文");
  assert.ok(report.text.includes("第 0 行"), "開頭沒有被砍掉");
  assert.ok(report.text.includes(lines[lines.length - 1]), "結尾沒有被砍掉");
});

// ── S2 活動流：reasoning 只餵跑馬燈，不污染交付物（2026-09-11 跨片契約）──────

test("S2 活動流：kind=reasoning 的 delta 只進 activity，不污染 text / lastLine", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "subagent.started", event_id: 1, data: { id: "sa1", label: "搜索素材" } }));
  s = agentChatReducer(s, evt({ name: "subagent.delta", event_id: 2, data: { id: "sa1", text: "先看看候选", kind: "reasoning" } }));

  let sub = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(sub);
  assert.equal(sub.activity, "先看看候选", "reasoning 進活動流（跑馬燈才有東西可滾）");
  // text 是交付物：產出卡會把 text 當全文帶走，混入思考就是謊報交付物。
  assert.equal(sub.text, undefined, "reasoning 不得進 text");
  assert.equal(sub.lastLine, "", "reasoning 不得進 lastLine");
  assert.equal(sub.status, "running");
  assert.equal(s.turnActive, true);

  // 尾段累加：第二幀 reasoning 接在 activity 尾巴上。
  s = agentChatReducer(s, evt({ name: "subagent.delta", event_id: 3, data: { id: "sa1", text: "，再核價", kind: "reasoning" } }));
  sub = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(sub);
  assert.equal(sub.activity, "先看看候选，再核價", "activity 尾端累加，不替換");
  assert.equal(sub.text, undefined, "連續 reasoning 也不長出 text");

  // 正文到來：text 只收正文，activity 收全部（reasoning 也算在工作）。
  s = agentChatReducer(s, evt({ name: "subagent.delta", event_id: 4, data: { id: "sa1", text: "找到 3 张" } }));
  sub = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(sub);
  assert.equal(sub.text, "找到 3 张", "text 只有正文");
  assert.equal(sub.lastLine, "找到 3 张");
  assert.equal(sub.activity, "先看看候选，再核價找到 3 张", "活動流是「全部增量」的超集");

  // 思考不是交付物：收尾後不得經由產出卡混進轉錄全文。
  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 5, data: {} }));
  const report = s.items.find((it): it is AgentSubagentReportItem => it.kind === "subagent_result");
  assert.ok(!report?.text.includes("先看看候选"), "reasoning 不得流入產出卡全文");
});

test("S2 活動流：無 kind 的正文 delta 同時追加 text 與 activity（正文也算活動）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "subagent.started", event_id: 1, data: { id: "sa1", label: "搜索素材" } }));
  s = agentChatReducer(s, evt({ name: "subagent.delta", event_id: 2, data: { id: "sa1", text: "第一行" } }));
  s = agentChatReducer(s, evt({ name: "subagent.delta", event_id: 3, data: { id: "sa1", text: "\n第二行" } }));

  const sub = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(sub);
  // 既有行為不變（F4）。
  assert.equal(sub.text, "第一行\n第二行", "text 照舊累積全文");
  assert.equal(sub.lastLine, "第二行", "lastLine 照舊只當渲染預覽");
  // 新增：正文同樣是「子代理在工作」的訊號，活動流必須同步跟上。
  assert.equal(sub.activity, "第一行\n第二行", "正文 delta 同步進 activity");
});

test("S2 活動流：started 丟失且首幀是 reasoning 時，補的卡只有 activity、不偽造 text", () => {
  const s = agentChatReducer(EMPTY, evt({ name: "subagent.delta", event_id: 1, data: { id: "sa-x", text: "在想…", kind: "reasoning" } }));
  const sub = s.items.find((it): it is AgentSubagentItem => it.kind === "subagent");
  assert.ok(sub);
  assert.equal(sub.status, "running");
  assert.equal(sub.activity, "在想…");
  assert.equal(sub.text, undefined, "思考不冒充交付物");
  assert.equal(sub.lastLine, "");
});

// ── 提交型工具的中继態（2026-09-18 契約：artifact_pending / task_id）──────────
//
// 语义：tool.result 带 artifact_pending=true = 任務已提交成功、成品还没到，
// 卡片停在中继態 pending（绝不显示「已完成」）；等成品事件（image/video/audio.done）
// 或失敗事件（image.failed）到了才转终态。旧格式（不带新栏位）逐位元照旧。

test("tool.result artifact_pending=true → 卡片是中继態 pending，不是 ok，且回填 taskId", () => {
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
  assert.equal(it.taskId, "t-1", "task_id 必須寫進卡片，成品事件才配得回來");
  assert.equal(it.costCoins, 3, "計費欄位照舊透傳（錢確實花了）");
  assert.equal(s.turnActive, true);
});

test("image.done 帶 task_id → 只結算對應那張 pending 卡（同批其他任務照舊等）", () => {
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
  assert.equal(tools[0]?.status, "pending", "任務號不匹配的卡不得被誤結算");
  assert.equal(tools[1]?.status, "ok", "成品到了，對應的 pending 卡結算成 ok");
  assert.equal(s.items.filter((it) => it.kind === "image").length, 1, "出圖卡照舊建立（去重行為不變）");
});

test("image.failed 帶 task_id → 對應的 pending 卡判失敗、帶上 human_message，notice 照舊留痕", () => {
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
  assert.equal(it.status, "failed", "失敗事件必須把還在轉的卡判死，不留假「生成中…」");
  assert.equal(it.error, "上游超时，费用已退回", "human_message 順手填進卡片");
  const notice = s.items.find((n): n is AgentNoticeItem => n.kind === "notice");
  assert.ok(notice, "原本的 notice 行為保留");
  assert.match(notice.text, /费用已退回/);
});

test("turn.done 不判死 pending 卡（running 照舊判死，pending 留著等成品/失敗事件）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "bash" } }));
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 2, data: { tool: "image_generate" } }));
  s = agentChatReducer(
    s,
    evt({ name: "tool.result", event_id: 3, data: { tool: "image_generate", ok: true, task_id: "t-1", artifact_pending: true } }),
  );

  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 4, data: {} }));

  const tools = s.items as AgentToolCallItem[];
  assert.equal(tools[0]?.status, "failed", "沒交出去的 running 卡照舊判死");
  assert.equal(tools[1]?.status, "pending", "回合結束 ≠ 成品到了：pending 必須留著，不能被 settleItems 判死");
  assert.equal(s.turnActive, false);
});

test("無 task_id 的 image.done → FIFO 結算最舊的一張 pending 卡", () => {
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

  // 成品事件沒帶 task_id：配不到精確的，回退結算最舊那張（防成品到了卡還在轉）。
  s = agentChatReducer(s, evt({ name: "image.done", event_id: 5, data: { url: "https://x/a.png" } }));

  const tools = s.items.filter((it): it is AgentToolCallItem => it.kind === "tool");
  assert.equal(tools[0]?.status, "ok", "FIFO：最舊的 pending 先結算");
  assert.equal(tools[1]?.status, "pending", "較新的 pending 留著，繼續等自己的成品事件");
});

test("video.done / audio.done 同樣結算 pending 卡（成品事件不只有圖）", () => {
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

test("缺席新欄位的舊格式 tool.result → 行為與現狀逐位元一致（直接 ok，不長 taskId）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "gen" } }));
  s = agentChatReducer(s, evt({ name: "tool.result", event_id: 2, data: { tool: "gen", ok: true, cost_coins: 2 } }));

  const it = s.items[0] as AgentToolCallItem;
  assert.equal(it.status, "ok", "舊格式不得被當成中继態");
  assert.equal(it.taskId, undefined);
  assert.equal(it.costCoins, 2);

  // ok:false 的舊格式照舊 failed。
  let f = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "gen" } }));
  f = agentChatReducer(f, evt({ name: "tool.result", event_id: 2, data: { tool: "gen", ok: false } }));
  assert.equal((f.items[0] as AgentToolCallItem).status, "failed");
});

// ─────────────────────────── turn.plan（本輪計畫，2026-09-18 契約）

test("turn.plan 落成獨立的 plan 條目，不併進 assistant 條目", () => {
  const s = agentChatReducer(
    EMPTY,
    evt({
      name: "turn.plan",
      event_id: 1,
      data: { plan: "打算这么做：先拆解分镜脚本，再生成配乐。", experts: ["screenwriter"], provisional: true, source: "model" },
    }),
  );

  assert.equal(s.items.length, 1, "計畫自成條目，不寄生在任何既有條目上");
  const plan = s.items[0] as AgentPlanItem;
  assert.equal(plan.kind, "plan");
  assert.equal(plan.text, "打算这么做：先拆解分镜脚本，再生成配乐。");
  assert.deepEqual(plan.experts, ["screenwriter"]);
  assert.equal(plan.provisional, true);
  assert.equal(plan.collapsed, false, "剛到的計畫預設展開（此刻它是畫面上唯一的資訊）");
  assert.equal(s.turnActive, true, "計畫幀到達 = 回合確實開始了");
});

test("turn.plan 清掉罐頭狀態行（turnStatus），與 message.delta 同款", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "正在思考…" } }));
  assert.equal(s.turnStatus, "正在思考…");
  s = agentChatReducer(s, evt({ name: "turn.plan", event_id: 2, data: { plan: "先出分镜再出片。" } }));
  assert.equal(s.turnStatus, undefined, "真實計畫到了，暫態罐頭行必須退場");
  assert.equal((s.items[0] as AgentPlanItem).kind, "plan");
});

test("首條 message.delta 開新 assistant 條目時，計畫被收合成一行", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.plan", event_id: 1, data: { plan: "先拆解剧情节拍，再逐镜生成。" } }));
  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 2, data: { text: "好的" } }));

  assert.equal(s.items.length, 2, "計畫與正文是兩條獨立條目");
  const plan = s.items[0] as AgentPlanItem;
  const assistant = s.items[1] as AgentAssistantTextItem;
  assert.equal(plan.collapsed, true, "真實正文開新條目 = 計畫讓位，自動收合");
  assert.equal(plan.text, "先拆解剧情节拍，再逐镜生成。", "收合只翻 collapsed，計畫文字一字不動");
  assert.equal(assistant.kind, "assistant");
  assert.equal(assistant.text, "好的", "正文不得把計畫文字吃進同一條氣泡");
});

test("追加到既有 streaming assistant 條目的 delta 不動計畫卡（不誤觸另一條分支）", () => {
  // reasoning 先開條目（思維鏈通常先於正文），之後的 message.delta 走「追加既有
  // streaming 條目」分支 —— 那條分支與工具卡 pending 契約的測試語義掛在一起，
  // 計畫收合只在「開新條目」分支發生，這裡不得被波及。
  let s = agentChatReducer(EMPTY, evt({ name: "turn.plan", event_id: 1, data: { plan: "先出分镜。" } }));
  s = agentChatReducer(s, evt({ name: "reasoning.delta", event_id: 2, data: { text: "先想一下" } }));
  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 3, data: { text: "開始" } }));

  assert.equal((s.items[0] as AgentPlanItem).collapsed, false, "同一條交付物的續寫不觸發計畫收合");
  assert.equal((s.items[1] as AgentAssistantTextItem).text, "開始");
});

test("turn.done 後計畫仍在，且不影響 settleItems 對 running 工具卡的結算", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.plan", event_id: 1, data: { plan: "先出分镜，再逐镜生成视频。" } }));
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 2, data: { tool: "bash" } }));
  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 3, data: { text: "開始處理" } }));
  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 4, data: {} }));

  const plan = s.items.find((it): it is AgentPlanItem => it.kind === "plan");
  assert.ok(plan, "回合收尾不刪計畫卡（它是這一輪做過什麼的痕跡）");
  assert.equal(plan.collapsed, true);
  const tool = s.items.find((it): it is AgentToolCallItem => it.kind === "tool");
  assert.equal(tool?.status, "failed", "running 工具卡照舊由 settleItems 判死");
  assert.equal(s.turnActive, false);
});

test("superseded 幀就地換掉既有計畫文字（同一 id），不新增第二張卡", () => {
  let s = agentChatReducer(
    EMPTY,
    evt({ name: "turn.plan", event_id: 1, data: { plan: "舊計畫：先出分镜。", source: "rule" } }),
  );
  const firstId = s.items[0].id;
  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 2, data: { text: "正文" } }));
  assert.equal((s.items[0] as AgentPlanItem).collapsed, true);

  s = agentChatReducer(
    s,
    evt({ name: "turn.plan", event_id: 3, data: { plan: "新計畫：先拆解剧情节拍，再逐镜生成并剪辑。", superseded: true, source: "model" } }),
  );

  const plans = s.items.filter((it): it is AgentPlanItem => it.kind === "plan");
  assert.equal(plans.length, 1, "同一輪只有一份計畫：就地換文字，不堆成版本流水帳");
  assert.equal(plans[0].id, firstId, "id 不變，React 不重掛卡片");
  assert.equal(plans[0].text, "新計畫：先拆解剧情节拍，再逐镜生成并剪辑。");
  assert.equal(plans[0].collapsed, true, "換文字不動使用者在看／收合狀態");
});
