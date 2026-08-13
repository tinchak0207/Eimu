// 畫布 reducer 測試：驗證 canvas.* 事件 → 畫布狀態的完整契約。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANVAS_INITIAL_STATE,
  reduceCanvasEvent,
  getUnitGraph,
} from "./reducer";
import type { CanvasSseEvent } from "./types";

function plan(unitId: string, tool = "image_generate"): CanvasSseEvent {
  return {
    name: "canvas.plan",
    data: {
      unit_id: unitId,
      tool,
      label: "生图",
      prompt: "一只戴礼帽的柴犬喝奶茶",
      model: "pixai-tsubaki2",
      size: "1024x1024",
      count: 1,
      kind: "image",
      source_image: null,
      cost_hint: null,
    },
  };
}

function created(unitId: string, id: string, type: string, title: string, kind?: "result"): CanvasSseEvent {
  return {
    name: "canvas.node.created",
    data: {
      unit_id: unitId,
      node: { id, type, title, position: { x: 0, y: 0 }, width: 340, height: 240, metadata: { content: "", status: "idle" } },
      ...(kind ? { target_kind: kind } : {}),
    },
  };
}

function connected(unitId: string, id: string, from: string, to: string): CanvasSseEvent {
  return {
    name: "canvas.node.connected",
    data: { unit_id: unitId, connection: { id, fromNodeId: from, toNodeId: to } },
  };
}

function updated(unitId: string, nodeId: string, patch: Record<string, unknown>, url?: string, cost?: number): CanvasSseEvent {
  return {
    name: "canvas.node.updated",
    data: { unit_id: unitId, node_id: nodeId, patch, ...(url ? { url } : {}), ...(cost !== undefined ? { cost_coins: cost } : {}) },
  };
}

test("plan 建立 unit，不建節點", () => {
  const s = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_1"));
  assert.equal(s.units.length, 1);
  assert.equal(s.units[0].unitId, "cu_1");
  assert.equal(s.units[0].nodes.length, 0);
  assert.equal(s.nodes.length, 0);
});

test("created 建節點並入 unit 與扁平清單", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_1"));
  s = reduceCanvasEvent(s, created("cu_1", "cu_1-text", "text", "文本", undefined));
  s = reduceCanvasEvent(s, created("cu_1", "cu_1-config", "config", "配置", undefined));
  assert.equal(s.units[0].nodes.length, 2);
  assert.equal(s.nodes.length, 2);
  assert.ok(s.nodes.every((n) => n.position.x !== 0 || n.position.y !== 0), "自動排版不該留在 0,0");
});

test("connected 建連線", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_1"));
  s = reduceCanvasEvent(s, created("cu_1", "a", "text", "A"));
  s = reduceCanvasEvent(s, created("cu_1", "b", "config", "B"));
  s = reduceCanvasEvent(s, connected("cu_1", "cu_1-c", "a", "b"));
  assert.equal(s.connections.length, 1);
  assert.equal(s.connections[0].fromNodeId, "a");
  assert.equal(s.connections[0].toNodeId, "b");
});

test("updated 落地結果（status/content/cost）", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_1"));
  s = reduceCanvasEvent(s, created("cu_1", "cu_1-image", "image", "生成中", "result"));
  s = reduceCanvasEvent(s, updated("cu_1", "cu_1-image", { status: "success" }, "https://example.com/img.webp", 2));
  const node = s.nodes.find((n) => n.id === "cu_1-image");
  assert.ok(node);
  assert.equal(node.metadata?.status, "success");
  assert.equal(node.metadata?.content, "https://example.com/img.webp");
  assert.equal(node.metadata?.cost_coins, 2);
});

test("generating 更新進度", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_1"));
  s = reduceCanvasEvent(s, created("cu_1", "cu_1-image", "image", "生成中", "result"));
  s = reduceCanvasEvent(s, { name: "canvas.node.generating", data: { unit_id: "cu_1", node_id: "cu_1-image", status: "running", progress: 50 } });
  const node = s.nodes.find((n) => n.id === "cu_1-image");
  assert.equal(node?.metadata?.status, "running");
  assert.equal(node?.metadata?.progress, 50);
});

test("deleted 移除節點與關聯連線", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_1"));
  s = reduceCanvasEvent(s, created("cu_1", "a", "text", "A"));
  s = reduceCanvasEvent(s, created("cu_1", "b", "config", "B"));
  s = reduceCanvasEvent(s, connected("cu_1", "c", "a", "b"));
  s = reduceCanvasEvent(s, { name: "canvas.node.deleted", data: { unit_id: "cu_1", node_id: "a" } });
  assert.equal(s.nodes.length, 1);
  assert.equal(s.connections.length, 0);
});

test("未知事件原樣返回", () => {
  const s = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_1"));
  const unchanged = reduceCanvasEvent(s, { name: "canvas.derive.started", data: { unit_id: "cu_1", source_node_id: "a", instruction: "改暖色" } } as CanvasSseEvent);
  assert.equal(unchanged.units.length, 1);
});

test("getUnitGraph 回單元完整圖", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_1"));
  s = reduceCanvasEvent(s, created("cu_1", "a", "text", "A"));
  s = reduceCanvasEvent(s, connected("cu_1", "c", "a", "b"));
  const g = getUnitGraph(s, "cu_1");
  assert.equal(g.nodes.length, 1);
  assert.equal(g.connections.length, 1);
});