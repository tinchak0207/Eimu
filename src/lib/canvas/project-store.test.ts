// 畫布專案 store 測試：驗證持久化模式（不可變 blob 世代 + 清洗）與 reducer 契約檔案存在。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __resetCanvasStoreForTests } from "./project-store.ts";

test("project-store 使用不可變 blob 世代（不覆寫、保留 2 代）", () => {
  const source = readFileSync("src/lib/canvas/project-store.ts", "utf8");
  assert.match(source, /list\(\{ prefix: indexPrefix/);
  assert.match(source, /Date\.now\(\)/);
  assert.doesNotMatch(source, /allowOverwrite:\s*true/);
  assert.match(source, /INDEX_GENERATIONS_KEPT = 2/);
  assert.match(source, /MAX_PROJECTS_PER_USER = 50/);
});

test("畫布 reducer 契約存在且被 types 引用", () => {
  const reducer = readFileSync("src/lib/canvas/reducer.ts", "utf8");
  const types = readFileSync("src/lib/canvas/types.ts", "utf8");
  assert.match(reducer, /reduceCanvasEvent/);
  assert.match(reducer, /reduceCanvasNodeCreated/);
  assert.match(types, /CANVAS_NODE_DEFAULT_SIZE/);
});

test("agent-chat-types 涵蓋 canvas 事件", () => {
  const types = readFileSync("src/lib/agent-chat-types.ts", "utf8");
  for (const name of [
    "canvas.plan",
    "canvas.node.created",
    "canvas.node.updated",
    "canvas.node.connected",
    "canvas.node.generating",
    "canvas.node.deleted",
    "canvas.derive.started",
    "canvas.budget.updated",
  ]) {
    assert.match(types, new RegExp(name), `應涵蓋 ${name}`);
  }
});

test("reset helper 存在（測試用）", () => {
  __resetCanvasStoreForTests();
  assert.ok(true);
});