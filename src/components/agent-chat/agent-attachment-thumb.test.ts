// 用户消息附件「图片真缩略」行为测试（2026-10-03）：
//   - image/* 有票 → 渲染真 <img>，src 直连网关读回 URL（不是檔名 chip）；
//   - 无票 / 铸票失败 → 降级文档卡，绝不渲染破图；
//   - 铸票中 → 骨架占位，无 <img> 无文件名泄漏；
//   - 非图片（pdf 等）→ 维持檔名 chip，且檔名与大小都渲染出来。
// 用 react-dom/server 真渲染（node:test 无 DOM 先例见 canvas/creation-flow-panel.test.ts），
// 断言落在真实输出 markup 上，不是源码字符串探针。

import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsx 对 .tsx 走 classic JSX 转换（tsconfig jsx=preserve），组件运行期引用自由变量
// React——SSR 前先把它挂到 globalThis；tsx 输出 cjs，require 同步可用，组件模块
// 经 require 在赋值之后加载（静态 import 会被提升到赋值之前，拿不到全局 React）。
(globalThis as unknown as { React: typeof React }).React = React;

/* eslint-disable @typescript-eslint/no-require-imports */
const { AgentAttachmentCards, AttachmentThumb } =
  require("./AgentAttachmentCards") as typeof import("./AgentAttachmentCards");
const { buildAssetUrl } = require("@/lib/agent-uploads") as typeof import("@/lib/agent-uploads");
const { formatBytes } = require("@/lib/video-frames") as typeof import("@/lib/video-frames");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { AgentAttachmentRef } from "@/lib/agent-chat-types";

const IMG_REF: AgentAttachmentRef = {
  kind: "image",
  path: "a/book-cover.png",
  name: "book-cover.png",
  mime: "image/png",
  size: 2_202_009,
};

const PDF_REF: AgentAttachmentRef = {
  kind: "document",
  path: "docs/book.pdf",
  name: "book.pdf",
  mime: "application/pdf",
  size: 2_202_009,
};

test("image 附件有票：渲染真 <img>，src 是网关读回 URL", () => {
  const html = renderToStaticMarkup(
    createElement(AttachmentThumb, {
      sessionId: "s1",
      attRef: IMG_REF,
      ticket: "tok-1",
      minting: false,
      mintFailed: false,
      wrapperClassName: "w-fit max-w-full self-end",
      chromeClassName: "rounded-[18px] border border-black/[0.06]",
      imgClassName: "block max-h-60 w-auto max-w-[min(100%,260px)] object-cover",
    }),
  );
  const expectedUrl = buildAssetUrl("s1", IMG_REF.path!, "tok-1");
  assert.ok(html.includes("<img"), `应渲染 <img>，实际：${html}`);
  assert.ok(
    html.includes(`src="${expectedUrl}"`),
    `img src 应是网关读回 URL ${expectedUrl}，实际：${html}`,
  );
  assert.ok(html.includes('alt="book-cover.png"'), "img alt 应是附件名");
  // 缩略壳：圆角+淡描边在，白图也有边界。
  assert.ok(html.includes("rounded-[18px]"), "缩略壳应有 18px 圆角");
  assert.ok(!html.includes(formatBytes(IMG_REF.size!)), "真图缩略不应再渲染檔名 chip 的大小文本");
});

test("image 附件无票（铸票失败/无 session）：降级文档卡，绝不渲染破图", () => {
  const html = renderToStaticMarkup(
    createElement(AttachmentThumb, {
      sessionId: null,
      attRef: IMG_REF,
      ticket: null,
      minting: false,
      mintFailed: true,
      imgClassName: "block",
    }),
  );
  assert.ok(!html.includes("<img"), `无票不应渲染 <img>，实际：${html}`);
  assert.ok(html.includes("book-cover.png"), "降级卡应显示檔名");
  assert.ok(html.includes(formatBytes(IMG_REF.size!)), "降级卡应显示人类可读大小");
});

test("image 附件铸票中：骨架占位，无 <img>、无文件名泄漏", () => {
  const html = renderToStaticMarkup(
    createElement(AttachmentThumb, {
      sessionId: "s1",
      attRef: IMG_REF,
      ticket: "tok-1",
      minting: true,
      mintFailed: false,
      imgClassName: "block",
      skeletonClassName: "h-60 w-48 animate-pulse rounded-[18px] bg-black/[0.04]",
    }),
  );
  assert.ok(!html.includes("<img"), "铸票中不应渲染 <img>");
  assert.ok(!html.includes("book-cover.png"), "骨架态不应泄漏文件名");
  assert.ok(html.includes("animate-pulse"), "应渲染骨架块");
});

test("非图片附件（pdf）：维持檔名 chip，檔名与大小都渲染", () => {
  const html = renderToStaticMarkup(
    createElement(AgentAttachmentCards, { refs: [PDF_REF], sessionId: "s1" }),
  );
  assert.ok(!html.includes("<img"), `pdf 不应渲染 <img>，实际：${html}`);
  assert.ok(html.includes("book.pdf"), "chip 应显示檔名");
  assert.ok(html.includes("2.1 MB"), `chip 应显示大小，实际：${html}`);
});

test("整卡组 SSR 初态（票未铸出）：image 附件也是文档卡降级，不出现破图", () => {
  const html = renderToStaticMarkup(
    createElement(AgentAttachmentCards, { refs: [IMG_REF], sessionId: "s1" }),
  );
  assert.ok(!html.includes("<img"), `票未就绪不应渲染 <img>，实际：${html}`);
  assert.ok(html.includes("book-cover.png"), "降级卡应显示檔名");
});
