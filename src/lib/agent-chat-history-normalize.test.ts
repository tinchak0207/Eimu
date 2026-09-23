// 全量歷史歸一化的單測：fixture 直接用 opencode 的原始 messages shape
// （[{info:{id,role,...},parts:[...]}]），斷言重建出的 transcript 與
// reducer 構造規則同構，且全數能過持久化白名單。

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeOpenCodeMessages, stripInternalSections } from "./agent-chat-history-normalize";
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

// ─────────────────────────── 系統注入訊息歸一化（歸因錯覺病灶）

/** 逐字對齊 gateway/index.ts wakeSessionForSubagent 的注入格式（成功態）。 */
const wakeOkMsg: OpenCodeMessage = {
  info: { role: "user" },
  parts: [
    {
      type: "text",
      text:
        '【子代理完成·系统自动唤醒】subagent a4e7dae6（label="搜索竞品定价"）已完成。结果摘要：已完成 3 家竞品定价抓取，均值 ¥29/月，明细见表格。' +
        "\n请基于以上真实结果继续推进（汇总/补派/返工），并向用户简报。若尚有其他子代理在跑，等其余唤醒到齐再汇总（可用 subagent_status 工具查询，禁止 bash sleep 轮询）。",
    },
  ],
};

/** 失敗態（同真源，verdict=失败 走「失败原因」前綴）。 */
const wakeErrMsg: OpenCodeMessage = {
  info: { role: "user" },
  parts: [
    {
      type: "text",
      text:
        '【子代理失败·系统自动唤醒】subagent b1c2d3e4（label="视频渲染"）已失败。失败原因：上游 429 限流，3 次重试后放弃。' +
        "\n请基于以上真实结果继续推进（汇总/补派/返工），并向用户简报。若尚有其他子代理在跑，等其余唤醒到齐再汇总（可用 subagent_status 工具查询，禁止 bash sleep 轮询）。",
    },
  ],
};

test("子代理喚醒（成功態）→ subagent_result 卡，不冒充用戶氣泡", () => {
  const { items, droppedByType } = normalizeOpenCodeMessages([wakeOkMsg]);
  assert.equal(items.length, 1);
  assert.equal(droppedByType["system-hint"], undefined);
  const it = items[0] as {
    kind: string; id: string; seq: number; subagentId: string; label: string; status: string; text: string;
  };
  assert.equal(it.kind, "subagent_result");
  assert.equal(it.id, "subagent-report-h1");
  assert.equal(it.seq, 1);
  assert.equal(it.subagentId, "a4e7dae6");
  assert.equal(it.label, "搜索竞品定价");
  assert.equal(it.status, "ok");
  // 摘要正文 = 结果摘要內容，尾部的續跑指令行（給模型的）必須剝掉。
  assert.equal(it.text, "已完成 3 家竞品定价抓取，均值 ¥29/月，明细见表格。");
});

test("子代理喚醒（失敗態）→ status error，text = 失敗原因", () => {
  const { items } = normalizeOpenCodeMessages([wakeErrMsg]);
  const it = items[0] as { kind: string; subagentId: string; label: string; status: string; text: string };
  assert.equal(it.kind, "subagent_result");
  assert.equal(it.subagentId, "b1c2d3e4");
  assert.equal(it.label, "视频渲染");
  assert.equal(it.status, "error");
  assert.equal(it.text, "上游 429 限流，3 次重试后放弃。");
});

test("喚醒條目佔 order seq 保時序，不佔 userCount（user id 續號不受污染）", () => {
  const { items } = normalizeOpenCodeMessages([
    { info: { role: "user" }, parts: [{ type: "text", text: "第一句" }] },
    wakeOkMsg,
    { info: { role: "user" }, parts: [{ type: "text", text: "第二句" }] },
  ]);
  assert.deepEqual(items.map((it) => it.kind), ["user", "subagent_result", "user"]);
  assert.equal(items[0].id, "user-0");
  assert.equal(items[2].id, "user-1"); // 喚醒不計用戶輪，第二句仍是 user-1
  // seq 嚴格遞增（喚醒卡佔 2 號位）。
  assert.ok(items[1].seq > items[0].seq && items[2].seq > items[1].seq);
});

test("子代理喚醒骨架漂移（label 帶引號）→ 兜底解析，仍不冒充用戶氣泡", () => {
  const msgs: OpenCodeMessage[] = [
    {
      info: { role: "user" },
      parts: [{ type: "text", text: '【子代理完成·系统自动唤醒】subagent deadbeef（label="带"引号"的标签"）已完成。结果摘要：内容' }],
    },
  ];
  const { items } = normalizeOpenCodeMessages(msgs);
  assert.equal(items.length, 1);
  const it = items[0] as { kind: string; subagentId: string; status: string };
  assert.equal(it.kind, "subagent_result");
  assert.equal(it.subagentId, "deadbeef");
  assert.equal(it.status, "ok");
});

test("系統重試提示 → 整條不顯示，計 droppedByType.system-hint", () => {
  const hint =
    "（系统提示：上一轮回复因上游模型错误中断，请从中断处继续完成任务，不要重复已完成的步骤或工具调用）";
  const { items, droppedParts, droppedByType } = normalizeOpenCodeMessages([
    { info: { role: "user" }, parts: [{ type: "text", text: hint }] },
    { info: { role: "user" }, parts: [{ type: "text", text: "真實用戶訊息" }] },
  ]);
  assert.equal(items.length, 1);
  assert.equal((items[0] as { text: string }).text, "真實用戶訊息");
  assert.equal(droppedParts, 1);
  assert.equal(droppedByType["system-hint"], 1);
});

// 現場實錘（messages-gw.ts:195）：召回前綴實際是「頭部注入」——
// `prefix + "\n\n" + 用戶正文`（舊規格描述的尾部追加也一併覆蓋）。
const recallBlock =
  "[相關領域知識（供參考，衝突以現場為準）]\n" +
  "- [product] pricing-rules\n" +
  "  套餐定价以 PRODUCT.md 为准。\n" +
  "- [infra] vercel-deploy\n" +
  "  部署走干净 worktree。\n";

test("記憶召回知識塊（頭部注入，live 實際格式）→ 從用戶氣泡剝離，剩餘文本正常顯示", () => {
  const msgs: OpenCodeMessage[] = [
    { info: { role: "user" }, parts: [{ type: "text", text: `${recallBlock}\n\n帮我画一只猫` }] },
  ];
  const { items, droppedByType } = normalizeOpenCodeMessages(msgs);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "user");
  assert.equal((items[0] as { text: string }).text, "帮我画一只猫");
  assert.equal(droppedByType["recall-block"], undefined); // 有剩餘文本：不是丟棄是剝離
});

test("記憶召回知識塊（尾部追加格式）→ 同樣剝離", () => {
  const msgs: OpenCodeMessage[] = [
    { info: { role: "user" }, parts: [{ type: "text", text: `帮我画一只猫\n\n${recallBlock}` }] },
  ];
  const { items } = normalizeOpenCodeMessages(msgs);
  assert.equal(items.length, 1);
  assert.equal((items[0] as { text: string }).text, "帮我画一只猫");
});

test("純知識塊（剝後無剩餘文本）→ 不生成 user item，計 droppedByType.recall-block", () => {
  const { items, droppedByType, droppedParts } = normalizeOpenCodeMessages([
    { info: { role: "user" }, parts: [{ type: "text", text: recallBlock }] },
  ]);
  assert.equal(items.length, 0);
  assert.equal(droppedByType["recall-block"], 1);
  assert.equal(droppedParts, 1);
});

test("assistant 內部框架段（歷史路徑）→ 剝離，正文與正常標題保留", () => {
  const text =
    "这是给用户的正文。\n" +
    "## Objective\n完成定价调研\n" +
    "## Work State\n- done: 抓取\n" +
    "### Progress Summary\n内部小结\n" +
    "## Next Move\n补派\n" +
    "## 真正的下一节\n后续正文";
  const msgs: OpenCodeMessage[] = [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }];
  const { items } = normalizeOpenCodeMessages(msgs);
  assert.equal(items.length, 1);
  assert.equal((items[0] as { text: string }).text, "这是给用户的正文。\n## 真正的下一节\n后续正文");
});

test("stripInternalSections：代碼柵欄內的內部段標題直通不剝", () => {
  const text = "前言\n```text\n## Objective\nfenced ## Objective stays\n```\n后记";
  assert.equal(stripInternalSections(text), text);
});

test("stripInternalSections：無內部段標題 → 原樣返回（零改動）", () => {
  const text = "## Objectives（复数不命中）\n## 目标\n正文保留  ";
  assert.equal(stripInternalSections(text), text);
});

test("喚醒產出的 subagent_result 過 sanitizeItemsForStorage 白名單", () => {
  const { items } = normalizeOpenCodeMessages([wakeOkMsg]);
  const sanitized = sanitizeItemsForStorage(items);
  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].kind, "subagent_result");
  assert.equal(typeof sanitized[0].id, "string");
  assert.equal(typeof sanitized[0].seq, "number");
});
