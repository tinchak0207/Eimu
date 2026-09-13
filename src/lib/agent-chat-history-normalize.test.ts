// 全量歷史歸一化的單測：fixture 直接用 opencode 的原始 messages shape
// （[{info:{id,role,...},parts:[...]}]），斷言重建出的 transcript 與
// reducer 構造規則同構，且全數能過持久化白名單。

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeOpenCodeMessages } from "./agent-chat-history-normalize";
import { sanitizeItemsForStorage } from "./agent-chat-persistence";
import type { OpenCodeMessage } from "./agent-chat-types";

// ─────────────────────────── fixtures

const userMsg: OpenCodeMessage = {
  info: { id: "msg_u1", role: "user", time: { created: 1 }, tokens: undefined },
  parts: [
    { type: "text", text: "幫我畫一隻貓" },
    { type: "file", url: "https://cdn.example.com/uploads/ref.png", mime: "image/png", filename: "ref.png", size: 12345 },
    // 無公網 URL（data: base64）必須被丟棄計數，嚴禁進存檔。
    { type: "file", url: "data:image/png;base64,AAAA", mime: "image/png" },
  ],
};

const assistantMsg: OpenCodeMessage = {
  info: { id: "msg_a1", role: "assistant", time: { created: 2, completed: 3 } },
  parts: [
    { type: "step-start" }, // 內部片段：跳過計數
    { type: "reasoning", text: "先想構圖" },
    { type: "text", text: "好的，" },
    {
      type: "tool",
      tool: "generate_image",
      state: { status: "completed", input: { prompt: "cat" }, output: "ok", time: { start: 1, end: 2 } },
    },
    { type: "text", text: "貓出來了" },
    {
      type: "tool",
      tool: "upscale",
      state: { status: "error", input: "x", error: "quota exceeded" },
    },
    { type: "file", url: "https://cdn.example.com/out/cat.png", mime: "image/png" },
    { type: "mystery-part", whatever: true }, // 未知 part：跳過計數
  ],
};

// ─────────────────────────── 測試

test("全量重建：kind 與時序忠實映射", () => {
  const { items } = normalizeOpenCodeMessages([userMsg, assistantMsg]);
  assert.deepEqual(
    items.map((it) => it.kind),
    // 附件掛在 user item 上（鏡像 live 上傳語義），assistant 內部按
    // text→tool→text→tool→media 的原始時序切段。
    ["user", "assistant", "tool", "assistant", "tool", "image"],
  );

  assert.equal(items[0].kind, "user");
  assert.equal((items[0] as { text: string }).text, "幫我畫一隻貓");
  const att = (items[0] as { attachments?: { kind: string; url?: string }[] }).attachments;
  assert.equal(att?.length, 1);
  assert.equal(att?.[0].kind, "image");
  assert.equal(att?.[0].url, "https://cdn.example.com/uploads/ref.png");

  // reasoning 有承載欄位（AgentAssistantTextItem.reasoning）→ 帶上不丟。
  assert.equal((items[1] as { text: string; reasoning?: string }).text, "好的，");
  assert.equal((items[1] as { reasoning?: string }).reasoning, "先想構圖");
  assert.equal((items[1] as { streaming: boolean }).streaming, false);

  // tool 狀態映射：completed→ok / error→failed（error 帶人類可讀原因）。
  assert.equal((items[2] as { status: string; tool: string }).status, "ok");
  assert.equal((items[2] as { tool: string }).tool, "generate_image");
  assert.ok((items[2] as { argsSummary?: string }).argsSummary?.includes("cat"));
  assert.equal((items[4] as { status: string }).status, "failed");
  assert.equal((items[4] as { error?: string }).error, "quota exceeded");

  // 媒體 item：公網 URL 直入。
  assert.equal((items[5] as { url: string }).url, "https://cdn.example.com/out/cat.png");
});

test("seq：非媒體條目嚴格遞增；媒體 seq 是 kind 內展示序號（鏡像 reducer）", () => {
  const { items } = normalizeOpenCodeMessages([userMsg, assistantMsg]);
  const nonMedia = items.filter((it) => it.kind !== "image" && it.kind !== "video" && it.kind !== "audio");
  for (let i = 1; i < nonMedia.length; i += 1) {
    assert.ok(nonMedia[i].seq > nonMedia[i - 1].seq, `seq 嚴格遞增被破壞：${nonMedia[i - 1].seq} → ${nonMedia[i].seq}`);
  }
  // 第一張圖展示序號 = 1（錨定文案「第 N 張」讀的就是它）。
  assert.equal((items[5] as { seq: number }).seq, 1);
});

test("id 全陣列唯一，user id 續接 optimistic 計數語義", () => {
  const { items } = normalizeOpenCodeMessages([userMsg, assistantMsg, userMsg]);
  const ids = new Set(items.map((it) => it.id));
  assert.equal(ids.size, items.length, "id 撞車：React key 會重複");
  assert.equal(items[0].id, "user-0");
  assert.equal(items[6].id, "user-1"); // 第二則 user 沿計數續號
});

test("droppedParts 統計：step-start/未知 part/data: URI 各計一筆", () => {
  const { droppedParts, droppedByType } = normalizeOpenCodeMessages([userMsg, assistantMsg]);
  // user: data: file 1 筆；assistant: step-start + mystery-part 2 筆。
  assert.equal(droppedParts, 3);
  assert.equal(droppedByType["file-no-public-url"], 1);
  assert.equal(droppedByType["step-start"], 1);
  assert.equal(droppedByType["mystery-part"], 1);
});

test("媒體判不出型別（無 mime 無後綴）→ 丟棄計數；同 URL 重複 → 去重", () => {
  const msgs: OpenCodeMessage[] = [
    {
      info: { role: "assistant" },
      parts: [
        { type: "file", url: "https://cdn.example.com/blob" },
        { type: "file", url: "https://cdn.example.com/a.mp4" },
        { type: "file", url: "https://cdn.example.com/a.mp4" },
        { type: "file", url: "https://cdn.example.com/s.mp3", mime: "audio/mpeg" },
      ],
    },
  ];
  const { items, droppedParts, droppedByType } = normalizeOpenCodeMessages(msgs);
  assert.deepEqual(items.map((it) => it.kind), ["video", "audio"]);
  assert.equal(droppedParts, 1);
  assert.equal(droppedByType["media-unknown-kind"], 1);
  // 展示序號按 kind 獨立計數。
  assert.equal((items[0] as { seq: number }).seq, 1);
  assert.equal((items[1] as { seq: number }).seq, 1);
});

test("髒資料不炸：空數組 / 非物件訊息 / 缺 parts / 未知角色 / 缺 state 的 tool", () => {
  const { items, droppedParts } = normalizeOpenCodeMessages([]);
  assert.equal(items.length, 0);
  assert.equal(droppedParts, 0);

  const dirty = [
    null,
    { info: { role: "user" } }, // 缺 parts
    { parts: [{ type: "text", text: "x" }] }, // 缺 info/role
    { info: { role: "wizard" }, parts: [{ type: "text", text: "abracadabra" }] }, // 未知角色
    { info: { role: "assistant" }, parts: [{ type: "tool", tool: "no_state_tool" }] }, // 缺 state
    { info: { role: "user" }, parts: [{ type: "text", text: "   " }] }, // 空白文字：不產條目不計丟棄
  ] as unknown as OpenCodeMessage[];
  const r = normalizeOpenCodeMessages(dirty);
  assert.equal(r.items.length, 0);
  assert.ok(r.droppedParts >= 4, `髒 part 應全數計數，實際 ${r.droppedParts}`);
} );

test("產出全數過 sanitizeItemsForStorage 白名單（無 item 被殺）", () => {
  const { items } = normalizeOpenCodeMessages([userMsg, assistantMsg]);
  assert.ok(items.length > 0);
  const sanitized = sanitizeItemsForStorage(items);
  assert.equal(sanitized.length, items.length, "有 item 被持久化白名單殺掉");
  // 過存檔校驗的三個硬條件：id/kind 字串、kind 在 ITEM_KINDS、seq 是數字。
  const KINDS = new Set(["user", "assistant", "tool", "image", "video", "audio", "notice", "subagent_result"]);
  for (const it of sanitized) {
    assert.equal(typeof it.id, "string");
    assert.ok(KINDS.has(it.kind), `kind 不在白名單：${it.kind}`);
    assert.equal(typeof it.seq, "number");
    assert.ok(Number.isFinite(it.seq));
  }
});

test("進行中 turn 的尾巴：running tool 保留 running 態（等 >counter 增量結算）", () => {
  const msgs: OpenCodeMessage[] = [
    {
      info: { role: "assistant" },
      parts: [{ type: "tool", tool: "long_job", state: { status: "running", input: {} } }],
    },
  ];
  const { items } = normalizeOpenCodeMessages(msgs);
  assert.equal((items[0] as { status: string }).status, "running");
});
