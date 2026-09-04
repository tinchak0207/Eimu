import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_AGENT_CHAT_STATE,
  type AgentAssistantTextItem,
  type AgentNoticeItem,
  type AgentSseEvent,
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
  const s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "仍在思考/执行中，已 45s 无正文输出" } }));
  assert.equal(s.turnStatus, "仍在思考/执行中，已 45s 无正文输出");
  assert.equal(s.turnActive, true);
  assert.equal(s.items.length, 0);
});

test("turn.status 新狀態替換舊狀態（單行原地刷新，不累加）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "仍在思考/执行中，已 45s 无正文输出" } }));
  s = agentChatReducer(s, evt({ name: "turn.status", event_id: 2, data: { text: "仍在思考/执行中，已 90s 无正文输出" } }));
  assert.equal(s.turnStatus, "仍在思考/执行中，已 90s 无正文输出");
});

test("真實正文 message.delta 到達即清 turnStatus", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "仍在思考/执行中，已 45s 无正文输出" } }));
  s = agentChatReducer(s, evt({ name: "message.delta", event_id: 2, data: { text: "搞定，" } }));
  assert.equal(s.turnStatus, undefined);
});

test("tool.invoke 期間 turnStatus 保留（工具執行中狀態行仍成立）", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "仍在思考/执行中，已 45s 无正文输出" } }));
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 2, data: { tool: "bash", args_summary: "curl …" } }));
  assert.equal(s.turnStatus, "仍在思考/执行中，已 45s 无正文输出");
});

test("turn.done 清 turnStatus", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "仍在思考/执行中，已 45s 无正文输出" } }));
  s = agentChatReducer(s, evt({ name: "turn.done", event_id: 2, data: {} }));
  assert.equal(s.turnStatus, undefined);
});

test("appendUserTurn 新輪開始清 turnStatus", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "turn.status", event_id: 1, data: { text: "仍在思考/执行中，已 45s 无正文输出" } }));
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
