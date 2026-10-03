// WindowControls SSR 行為測試（2026-10-04）：
//   普通瀏覽器（無 window.eimuShell）⇒ 元件回 null，SSR 輸出必須是空字串
//   —— 一顆控制鈕都不能有（出現按了沒反應的死鈕比沒有更糟）。
// 用 react-dom/server 真渲染（tsx classic JSX 需先掛 globalThis.React，
// 先例見 src/components/agent-chat/agent-attachment-thumb.test.ts）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsx 對 .tsx 走 classic JSX（tsconfig jsx=preserve），元件運行期引用自由變數 React——
// SSR 前先把它掛到 globalThis；tsx 輸出 cjs，require 同步可用，元件模組經 require
// 在賦值之後載入（靜態 import 會被提升到賦值之前，拿不到全局 React）。
(globalThis as unknown as { React: typeof React }).React = React;

/* eslint-disable @typescript-eslint/no-require-imports */
const { WindowControls } = require("./WindowControls") as typeof import("./WindowControls");
/* eslint-enable @typescript-eslint/no-require-imports */

test("普通瀏覽器（無 window.eimuShell）：SSR 完全不渲染控制鈕", () => {
  const html = renderToStaticMarkup(createElement(WindowControls, {}));
  assert.equal(html, "", `無殼時應回 null（輸出空字串），實際：${html}`);
  assert.ok(!html.includes("最小化"), "不得渲染最小化鈕");
  assert.ok(!html.includes("最大化"), "不得渲染最大化鈕");
  assert.ok(!html.includes("关闭"), "不得渲染關閉鈕");
});

test("殼偵測走 useEimuShell（SSR/首幀不得讀 window，避免 hydration 不一致）", () => {
  const source = readFileSync(join(process.cwd(), "src/components/WindowControls.tsx"), "utf8");
  // 渲染期直接讀 window.eimuShell 會讓 SSR 與 client 首幀不一致；判定一律走 hook（effect 內）。
  assert.match(source, /useEimuShell\(\)/);
  // 三顆鈕都在自身根節點標 no-drag，且三顆皆 type="button"。
  assert.match(source, /app-region-no-drag/);
  const typeButtons = source.match(/type="button"/g) ?? [];
  assert.equal(typeButtons.length, 3, "三顆鈕都必須是 type=button");
  // 卸載退訂：onMaximizeChange 的回傳值必須被呼叫。
  assert.match(source, /onMaximizeChange/);
  assert.match(source, /if \(typeof unsubscribe === "function"\) unsubscribe\(\);/);
});
