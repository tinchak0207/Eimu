import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_AGENT_CHAT_STATE,
  type AgentAssistantTextItem,
  type AgentNoticeItem,
  type AgentSseEvent,
  type AgentToolCallItem,
  type AgentUserTurnItem,
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

test("tool.result 只回填最近一個同名 running 條目", () => {
  let s = agentChatReducer(EMPTY, evt({ name: "tool.invoke", event_id: 1, data: { tool: "gen" } }));
  s = agentChatReducer(s, evt({ name: "tool.invoke", event_id: 2, data: { tool: "gen" } }));
  s = agentChatReducer(s, evt({ name: "tool.result", event_id: 3, data: { tool: "gen", ok: true, cost_coins: 1 } }));

  const items = s.items as AgentToolCallItem[];
  assert.equal(items[0]?.status, "running", "前面的同名調用不受影響");
  assert.equal(items[1]?.status, "ok");
  assert.equal(items[1]?.costCoins, 1);
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
