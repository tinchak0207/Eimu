// WindowControls SSR 行为测试（2026-10-04）：
//   普通浏览器（无 window.eimuShell）⇒ 元件回 null，SSR 输出必须是空字串
//   —— 一颗控制钮都不能有（出现按了没反应的死钮比没有更糟）。
// 用 react-dom/server 真渲染（tsx classic JSX 需先挂 globalThis.React，
// 先例见 src/components/agent-chat/agent-attachment-thumb.test.ts）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsx 对 .tsx 走 classic JSX（tsconfig jsx=preserve），元件运行期引用自由变数 React——
// SSR 前先把它挂到 globalThis；tsx 输出 cjs，require 同步可用，元件模组经 require
// 在赋值之后载入（静态 import 会被提升到赋值之前，拿不到全局 React）。
(globalThis as unknown as { React: typeof React }).React = React;

/* eslint-disable @typescript-eslint/no-require-imports */
const { WindowControls } = require("./WindowControls") as typeof import("./WindowControls");
/* eslint-enable @typescript-eslint/no-require-imports */

test("普通浏览器（无 window.eimuShell）：SSR 完全不渲染控制钮", () => {
  const html = renderToStaticMarkup(createElement(WindowControls, {}));
  assert.equal(html, "", `无壳时应回 null（输出空字串），实际：${html}`);
  assert.ok(!html.includes("最小化"), "不得渲染最小化钮");
  assert.ok(!html.includes("最大化"), "不得渲染最大化钮");
  assert.ok(!html.includes("关闭"), "不得渲染关闭钮");
});

test("壳侦测走 useEimuShell（SSR/首帧不得读 window，避免 hydration 不一致）", () => {
  const source = readFileSync(join(process.cwd(), "src/components/WindowControls.tsx"), "utf8");
  // 渲染期直接读 window.eimuShell 会让 SSR 与 client 首帧不一致；判定一律走 hook（effect 内）。
  assert.match(source, /useEimuShell\(\)/);
  // 三颗钮都在自身根节点标 no-drag，且三颗皆 type="button"。
  assert.match(source, /app-region-no-drag/);
  const typeButtons = source.match(/type="button"/g) ?? [];
  assert.equal(typeButtons.length, 3, "三颗钮都必须是 type=button");
  // 卸载退订：onMaximizeChange 的回传值必须被呼叫。
  assert.match(source, /onMaximizeChange/);
  assert.match(source, /if \(typeof unsubscribe === "function"\) unsubscribe\(\);/);
});
