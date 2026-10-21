// 全量历史归一化的单测：fixture 直接用 opencode 的原始 messages shape
// （[{info:{id,role,...},parts:[...]}]），断言重建出的 transcript 与
// reducer 构造规则同构，且全数能过持久化白名单。

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeOpenCodeMessages, stripInternalSections } from "./agent-chat-history-normalize";
import { sanitizeItemsForStorage } from "./agent-chat-persistence";
import type { OpenCodeMessage } from "./agent-chat-types";

// ─────────────────────────── fixtures

const userMsg: OpenCodeMessage = {
  info: { id: "msg_u1", role: "user", time: { created: 1 }, tokens: undefined },
  parts: [
    { type: "text", text: "帮我画一只猫" },
    { type: "file", url: "https://cdn.example.com/uploads/ref.png", mime: "image/png", filename: "ref.png", size: 12345 },
    // 无公网 URL（data: base64）必须被丢弃计数，严禁进存档。
    { type: "file", url: "data:image/png;base64,AAAA", mime: "image/png" },
  ],
};

const assistantMsg: OpenCodeMessage = {
  info: { id: "msg_a1", role: "assistant", time: { created: 2, completed: 3 } },
  parts: [
    { type: "step-start" }, // 内部片段：跳过计数
    { type: "reasoning", text: "先想构图" },
    { type: "text", text: "好的，" },
    {
      type: "tool",
      tool: "generate_image",
      state: { status: "completed", input: { prompt: "cat" }, output: "ok", time: { start: 1, end: 2 } },
    },
    { type: "text", text: "猫出来了" },
    {
      type: "tool",
      tool: "upscale",
      state: { status: "error", input: "x", error: "quota exceeded" },
    },
    { type: "file", url: "https://cdn.example.com/out/cat.png", mime: "image/png" },
    { type: "mystery-part", whatever: true }, // 未知 part：跳过计数
  ],
};

// ─────────────────────────── 测试

test("全量重建：kind 与时序忠实映射", () => {
  const { items } = normalizeOpenCodeMessages([userMsg, assistantMsg]);
  assert.deepEqual(
    items.map((it) => it.kind),
    // 附件挂在 user item 上（镜像 live 上传语义），assistant 内部按
    // text→tool→text→tool→media 的原始时序切段。
    ["user", "assistant", "tool", "assistant", "tool", "image"],
  );

  assert.equal(items[0].kind, "user");
  assert.equal((items[0] as { text: string }).text, "帮我画一只猫");
  const att = (items[0] as { attachments?: { kind: string; url?: string }[] }).attachments;
  assert.equal(att?.length, 1);
  assert.equal(att?.[0].kind, "image");
  assert.equal(att?.[0].url, "https://cdn.example.com/uploads/ref.png");

  // reasoning 有承载栏位（AgentAssistantTextItem.reasoning）→ 带上不丢。
  assert.equal((items[1] as { text: string; reasoning?: string }).text, "好的，");
  assert.equal((items[1] as { reasoning?: string }).reasoning, "先想构图");
  assert.equal((items[1] as { streaming: boolean }).streaming, false);

  // tool 状态映射：completed→ok / error→failed（error 带人类可读原因）。
  assert.equal((items[2] as { status: string; tool: string }).status, "ok");
  assert.equal((items[2] as { tool: string }).tool, "generate_image");
  assert.ok((items[2] as { argsSummary?: string }).argsSummary?.includes("cat"));
  assert.equal((items[4] as { status: string }).status, "failed");
  assert.equal((items[4] as { error?: string }).error, "quota exceeded");

  // 媒体 item：公网 URL 直入。
  assert.equal((items[5] as { url: string }).url, "https://cdn.example.com/out/cat.png");
});

test("seq：非媒体条目严格递增；媒体 seq 是 kind 内展示序号（镜像 reducer）", () => {
  const { items } = normalizeOpenCodeMessages([userMsg, assistantMsg]);
  const nonMedia = items.filter((it) => it.kind !== "image" && it.kind !== "video" && it.kind !== "audio");
  for (let i = 1; i < nonMedia.length; i += 1) {
    assert.ok(nonMedia[i].seq > nonMedia[i - 1].seq, `seq 严格递增被破坏：${nonMedia[i - 1].seq} → ${nonMedia[i].seq}`);
  }
  // 第一张图展示序号 = 1（锚定文案「第 N 张」读的就是它）。
  assert.equal((items[5] as { seq: number }).seq, 1);
});

test("id 全阵列唯一，user id 续接 optimistic 计数语义", () => {
  const { items } = normalizeOpenCodeMessages([userMsg, assistantMsg, userMsg]);
  const ids = new Set(items.map((it) => it.id));
  assert.equal(ids.size, items.length, "id 撞车：React key 会重复");
  assert.equal(items[0].id, "user-0");
  assert.equal(items[6].id, "user-1"); // 第二则 user 沿计数续号
});

test("droppedParts 统计：step-start/未知 part/data: URI 各计一笔", () => {
  const { droppedParts, droppedByType } = normalizeOpenCodeMessages([userMsg, assistantMsg]);
  // user: data: file 1 笔；assistant: step-start + mystery-part 2 笔。
  assert.equal(droppedParts, 3);
  assert.equal(droppedByType["file-no-public-url"], 1);
  assert.equal(droppedByType["step-start"], 1);
  assert.equal(droppedByType["mystery-part"], 1);
});

test("媒体判不出型别（无 mime 无后缀）→ 丢弃计数；同 URL 重复 → 去重", () => {
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
  // 展示序号按 kind 独立计数。
  assert.equal((items[0] as { seq: number }).seq, 1);
  assert.equal((items[1] as { seq: number }).seq, 1);
});

test("脏资料不炸：空数组 / 非物件讯息 / 缺 parts / 未知角色 / 缺 state 的 tool", () => {
  const { items, droppedParts } = normalizeOpenCodeMessages([]);
  assert.equal(items.length, 0);
  assert.equal(droppedParts, 0);

  const dirty = [
    null,
    { info: { role: "user" } }, // 缺 parts
    { parts: [{ type: "text", text: "x" }] }, // 缺 info/role
    { info: { role: "wizard" }, parts: [{ type: "text", text: "abracadabra" }] }, // 未知角色
    { info: { role: "assistant" }, parts: [{ type: "tool", tool: "no_state_tool" }] }, // 缺 state
    { info: { role: "user" }, parts: [{ type: "text", text: "   " }] }, // 空白文字：不产条目不计丢弃
  ] as unknown as OpenCodeMessage[];
  const r = normalizeOpenCodeMessages(dirty);
  assert.equal(r.items.length, 0);
  assert.ok(r.droppedParts >= 4, `脏 part 应全数计数，实际 ${r.droppedParts}`);
} );

test("产出全数过 sanitizeItemsForStorage 白名单（无 item 被杀）", () => {
  const { items } = normalizeOpenCodeMessages([userMsg, assistantMsg]);
  assert.ok(items.length > 0);
  const sanitized = sanitizeItemsForStorage(items);
  assert.equal(sanitized.length, items.length, "有 item 被持久化白名单杀掉");
  // 过存档校验的三个硬条件：id/kind 字串、kind 在 ITEM_KINDS、seq 是数字。
  const KINDS = new Set(["user", "assistant", "tool", "image", "video", "audio", "notice", "subagent_result"]);
  for (const it of sanitized) {
    assert.equal(typeof it.id, "string");
    assert.ok(KINDS.has(it.kind), `kind 不在白名单：${it.kind}`);
    assert.equal(typeof it.seq, "number");
    assert.ok(Number.isFinite(it.seq));
  }
});

test("进行中 turn 的尾巴：running tool 保留 running 态（等 >counter 增量结算）", () => {
  const msgs: OpenCodeMessage[] = [
    {
      info: { role: "assistant" },
      parts: [{ type: "tool", tool: "long_job", state: { status: "running", input: {} } }],
    },
  ];
  const { items } = normalizeOpenCodeMessages(msgs);
  assert.equal((items[0] as { status: string }).status, "running");
});

// ─────────────────────────── 系统注入讯息归一化（归因错觉病灶）

/** 逐字对齐 gateway/index.ts wakeSessionForSubagent 的注入格式（成功态）。 */
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

/** 失败态（同真源，verdict=失败 走「失败原因」前缀）。 */
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

test("子代理唤醒（成功态）→ subagent_result 卡，不冒充用户气泡", () => {
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
  // 摘要正文 = 结果摘要内容，尾部的续跑指令行（给模型的）必须剥掉。
  assert.equal(it.text, "已完成 3 家竞品定价抓取，均值 ¥29/月，明细见表格。");
});

test("子代理唤醒（失败态）→ status error，text = 失败原因", () => {
  const { items } = normalizeOpenCodeMessages([wakeErrMsg]);
  const it = items[0] as { kind: string; subagentId: string; label: string; status: string; text: string };
  assert.equal(it.kind, "subagent_result");
  assert.equal(it.subagentId, "b1c2d3e4");
  assert.equal(it.label, "视频渲染");
  assert.equal(it.status, "error");
  assert.equal(it.text, "上游 429 限流，3 次重试后放弃。");
});

test("唤醒条目占 order seq 保时序，不占 userCount（user id 续号不受污染）", () => {
  const { items } = normalizeOpenCodeMessages([
    { info: { role: "user" }, parts: [{ type: "text", text: "第一句" }] },
    wakeOkMsg,
    { info: { role: "user" }, parts: [{ type: "text", text: "第二句" }] },
  ]);
  assert.deepEqual(items.map((it) => it.kind), ["user", "subagent_result", "user"]);
  assert.equal(items[0].id, "user-0");
  assert.equal(items[2].id, "user-1"); // 唤醒不计用户轮，第二句仍是 user-1
  // seq 严格递增（唤醒卡占 2 号位）。
  assert.ok(items[1].seq > items[0].seq && items[2].seq > items[1].seq);
});

test("子代理唤醒骨架漂移（label 带引号）→ 兜底解析，仍不冒充用户气泡", () => {
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

// 生产真路径：gateway 历史读面（sessions-http.ts / session-read.ts）已把唤醒
// 讯息的 role 改写成 "system"。系统角色分支必须还原产出卡，且普通 system 讯息
// 绝不冒充用户气泡。
test("role=system 的子代理唤醒 → subagent_result；普通 system 讯息整条丢弃计数", () => {
  const { items, droppedParts, droppedByType } = normalizeOpenCodeMessages([
    { info: { role: "system" }, parts: [{ type: "text", text: wakeOkMsg.parts![0].text as string }] },
    { info: { role: "system" }, parts: [{ type: "text", text: "内部系统注入，不应显示" }] },
  ]);
  assert.equal(items.length, 1);
  const it = items[0] as { kind: string; subagentId: string; label: string; status: string; text: string };
  assert.equal(it.kind, "subagent_result");
  assert.equal(it.subagentId, "a4e7dae6");
  assert.equal(it.label, "搜索竞品定价");
  assert.equal(it.status, "ok");
  assert.equal(it.text, "已完成 3 家竞品定价抓取，均值 ¥29/月，明细见表格。");
  assert.equal(droppedParts, 1);
  assert.equal(droppedByType["system-message"], 1);
});

test("系统重试提示原样保留：剥离归 gateway 显示通道，前端不再按文案猜测", () => {
  const hint =
    "（系统提示：上一轮回复因上游模型错误中断，请从中断处继续完成任务，不要重复已完成的步骤或工具调用）";
  const { items, droppedParts, droppedByType } = normalizeOpenCodeMessages([
    { info: { role: "user" }, parts: [{ type: "text", text: hint }] },
    { info: { role: "user" }, parts: [{ type: "text", text: "真实用户讯息" }] },
  ]);
  // 431b39b5 起显示通道已在 gateway 侧剥离；前端不得再按正文标题猜删
  // （用户可能正好引用同一段指令）。历史归一化只做忠实映射。
  assert.equal(items.length, 2);
  assert.equal((items[0] as { text: string }).text, hint);
  assert.equal((items[1] as { text: string }).text, "真实用户讯息");
  assert.equal(droppedParts, 0);
  assert.equal(droppedByType["system-hint"], undefined);
});

// 现场实锤（messages-gw.ts:195）：召回前缀实际是「头部注入」——
// `prefix + "\n\n" + 用户正文`（旧规格描述的尾部追加也一并覆盖）。
const recallBlock =
  "[相关领域知识（供参考，冲突以现场为准）]\n" +
  "- [product] pricing-rules\n" +
  "  套餐定价以 PRODUCT.md 为准。\n" +
  "- [infra] vercel-deploy\n" +
  "  部署走干净 worktree。\n";

test("记忆召回知识块（头部注入）原样保留：剥离归 gateway 显示通道", () => {
  const msgs: OpenCodeMessage[] = [
    { info: { role: "user" }, parts: [{ type: "text", text: `${recallBlock}\n\n帮我画一只猫` }] },
  ];
  const { items, droppedByType } = normalizeOpenCodeMessages(msgs);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "user");
  assert.equal((items[0] as { text: string }).text, `${recallBlock}\n\n帮我画一只猫`);
  assert.equal(droppedByType["recall-block"], undefined); // 前端不重复剥离
});

test("记忆召回知识块（尾部追加格式）→ 同样原样保留", () => {
  const msgs: OpenCodeMessage[] = [
    { info: { role: "user" }, parts: [{ type: "text", text: `帮我画一只猫\n\n${recallBlock}` }] },
  ];
  const { items } = normalizeOpenCodeMessages(msgs);
  assert.equal(items.length, 1);
  assert.equal((items[0] as { text: string }).text, `帮我画一只猫\n\n${recallBlock}`);
});

test("纯知识块也作为用户正文保留（前端不再重复剥离）", () => {
  const { items, droppedByType, droppedParts } = normalizeOpenCodeMessages([
    { info: { role: "user" }, parts: [{ type: "text", text: recallBlock }] },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "user");
  assert.equal((items[0] as { text: string }).text, recallBlock);
  assert.equal(droppedByType["recall-block"], undefined);
  assert.equal(droppedParts, 0);
});

test("assistant 内部框架段（历史路径）→ 剥离，正文与正常标题保留", () => {
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

test("stripInternalSections：代码栅栏内的内部段标题直通不剥", () => {
  const text = "前言\n```text\n## Objective\nfenced ## Objective stays\n```\n后记";
  assert.equal(stripInternalSections(text), text);
});

test("stripInternalSections：无内部段标题 → 原样返回（零改动）", () => {
  const text = "## Objectives（复数不命中）\n## 目标\n正文保留  ";
  assert.equal(stripInternalSections(text), text);
});

test("唤醒产出的 subagent_result 过 sanitizeItemsForStorage 白名单", () => {
  const { items } = normalizeOpenCodeMessages([wakeOkMsg]);
  const sanitized = sanitizeItemsForStorage(items);
  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].kind, "subagent_result");
  assert.equal(typeof sanitized[0].id, "string");
  assert.equal(typeof sanitized[0].seq, "number");
});
