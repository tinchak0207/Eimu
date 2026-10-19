import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsconfig 的 jsx=preserve 让 tsx 对 .tsx 退回 classic runtime（React.createElement），
// 组件源码不 import React（Next 构建走 automatic）。补全局 React 桩（同 agent-history-list.test.ts）。
(globalThis as unknown as Record<string, unknown>).React ??= React;

import { AgentMessageBubble } from "./AgentMessageBubble";
import { AgentMarkdown } from "./AgentMarkdown";
import type { AgentUserTurnItem } from "@/lib/agent-chat-types";

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const chatCss = read("src/components/agent-chat/agent-chat.css");
const bubbleSrc = read("src/components/agent-chat/AgentMessageBubble.tsx");
const markdownSrc = read("src/components/agent-chat/AgentMarkdown.tsx");
const surfaceSrc = read("src/components/agent-chat/AgentChatSurface.tsx");
const composerSrc = read("src/components/agent-chat/AgentComposer.tsx");
const confirmSrc = read("src/components/agent-chat/AgentConfirmCard.tsx");

// 窄屏字级阶梯所在的 @media (max-width: 639.98px) 块。
// 该块右侧紧邻的下一节注释是「输入框外壳 / 发送钮」（media 块之后的第一处 section
// 注释），用它当右边界——避免把后面 @media (prefers-reduced-motion) 的规则也算进来。
const NARROW_MARK = "@media (max-width: 639.98px)";
const narrowStart = chatCss.indexOf(NARROW_MARK);
const narrowEnd = chatCss.indexOf("输入框外壳", narrowStart);
const narrowBlock = chatCss.slice(narrowStart, narrowEnd);
const outsideNarrow = chatCss.slice(0, narrowStart) + chatCss.slice(narrowEnd);

// ────────────────────────── 窄屏阶梯存在且数值正确（变更探针）──────────────
// 说明：这是对 CSS 源文件的字符串断言（变更探针，不是渲染 oracle）。硬性边界要求
// 只作用在 ≤639.98px，所以先证明规则确实落在该 media 块内。
test("窄屏字级阶梯：正文 17px/25px、过程列 15px、次要行 14px、输入区 17px", () => {
  assert.ok(narrowStart >= 0, "agent-chat.css 缺 @media (max-width: 639.98px)");
  assert.ok(narrowEnd > narrowStart, "找不到窄屏块右边界");

  // 正文（用户气泡／助手 Markdown／确认卡内文）：17px、行高 25px（Grok 手机端实测值）。
  assert.match(
    narrowBlock,
    /\.agent-chat-surface \.agent-turn-text[\s\S]{0,200}?font-size:\s*17px/,
    "正文阶梯缺 17px",
  );
  assert.match(
    narrowBlock,
    /\.agent-chat-surface \.agent-turn-text[\s\S]{0,200}?line-height:\s*25px/,
    "正文阶梯缺 25px 行高",
  );
  // Markdown 一级标题必须高于正文（否则 18 < 17 观感倒挂）。
  assert.match(narrowBlock, /\.agent-turn-title[\s\S]{0,120}?font-size:\s*18px/);

  // 13px 层（footnote）→ 15px。
  assert.match(
    narrowBlock,
    /\.agent-chat-surface \.text-ios-footnote[\s\S]{0,120}?font-size:\s*15px/,
    "footnote 层缺 15px",
  );
  // 12px 层（caption1）→ 14px。
  assert.match(
    narrowBlock,
    /\.agent-chat-surface \.text-ios-caption1[\s\S]{0,120}?font-size:\s*14px/,
    "caption1 层缺 14px",
  );
  // 手机端不得 <14px：caption2(11px) 与 12/13px 正文小字全部抬到 14px 地板。
  assert.match(narrowBlock, /\.agent-chat-surface \.text-ios-caption2/);
  assert.match(narrowBlock, /\.agent-chat-surface \.text-\\\[0\\\.6875rem\\\]/);
  assert.match(narrowBlock, /\.agent-chat-surface \.text-\\\[0\\\.75rem\\\]/);
  assert.match(narrowBlock, /\.agent-chat-surface \.text-\\\[0\\\.8125rem\\\]/);

  // composer textarea：16px → 17px（仍 ≥16px，iOS 聚焦不缩放）。
  assert.match(narrowBlock, /\.agent-composer textarea\s*\{[\s\S]{0,60}?font-size:\s*17px/);
});

test("字级阶梯不进桌面：17px 只出现在窄屏块内", () => {
  // 桌面 ≥640px 必须 pixel-identical——任何 17px/25px 阶梯泄漏到窄屏块之外即失败。
  assert.ok(!outsideNarrow.includes("font-size: 17px"), "17px 阶梯泄漏到窄屏块之外");
  assert.ok(!/\.agent-turn-text/.test(outsideNarrow), ".agent-turn-text 规则泄漏到窄屏块之外");
});

// ────────────────────────── 桌面基础值未被改动（契约断言）─────────────────
test("桌面基础值原封不动：正文仍 text-[0.9375rem]、输入区 15px、surface 根 class 保留", () => {
  // AgentMessageBubble 正文容器在桌面仍用原来的 15px arbitrary value + 两条 leading。
  assert.match(bubbleSrc, /text-\[0\.9375rem\]/, "正文桌面 15px 被改动");
  assert.match(bubbleSrc, /leading-\[1\.55\]/, "助手行距桌面值被改动");
  assert.match(bubbleSrc, /leading-\[1\.45\]/, "用户行距桌面值被改动");
  // composer 基础仍是 15px / 1.375rem 行距（桌面生效）。
  assert.match(composerSrc, /text-\[0\.9375rem\] leading-\[1\.375rem\]/, "composer 桌面基础字级被改动");
  // surface 根 div 的两条原 class 序列（桌面渲染）保持不变。
  assert.match(surfaceSrc, /page-shell flex flex-col pb-4 pt-3/);
  assert.match(surfaceSrc, /flex min-h-0 flex-1 flex-col overflow-hidden pb-1/);
  // 确认卡内文桌面仍是 15px。
  assert.match(confirmSrc, /text-\[0\.9375rem\] leading-snug/);
});

// ────────────────────────── 渲染行为：阶梯锚点真的挂在元素上 ───────────────
test("渲染契约：用户气泡正文元素同时带 agent-turn-text 与桌面 15px class", () => {
  const item: AgentUserTurnItem = { kind: "user", id: "u1", seq: 0, text: "做成四格宣传海报" };
  const html = renderToStaticMarkup(createElement(AgentMessageBubble, { item }));
  assert.match(html, /class="[^"]*agent-turn-text[^"]*"/, "气泡未挂 agent-turn-text 锚点");
  const cls = html.match(/class="[^"]*agent-turn-text[^"]*"/)![0];
  assert.ok(cls.includes("text-[0.9375rem]"), "锚点元素丢了桌面 15px class");
});

test("渲染契约：Markdown 一级标题带 agent-turn-title、二/三级带 agent-turn-text", () => {
  const h1 = renderToStaticMarkup(createElement(AgentMarkdown, { text: "# 大标题" }));
  assert.match(h1, /class="[^"]*agent-turn-title[^"]*"/, "h1 未挂 agent-turn-title");
  assert.ok(h1.includes("text-base"), "h1 丢了桌面 text-base");

  const h2 = renderToStaticMarkup(createElement(AgentMarkdown, { text: "## 二级标题" }));
  assert.match(h2, /class="[^"]*agent-turn-text[^"]*"/, "h2 未挂 agent-turn-text");
  const h3 = renderToStaticMarkup(createElement(AgentMarkdown, { text: "### 三级标题" }));
  assert.match(h3, /class="[^"]*agent-turn-text[^"]*"/, "h3 未挂 agent-turn-text");
});
