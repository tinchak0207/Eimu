// 画布 reducer 测试：验证 canvas.* 事件 → 画布状态的完整契约。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANVAS_INITIAL_STATE,
  reduceCanvasEvent,
  getUnitGraph,
  layoutGraph,
} from "./reducer";
import { CanvasNodeType, type CanvasNode, type CanvasSseEvent } from "./types";

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

test("plan 建立 unit，不建节点", () => {
  const s = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_1"));
  assert.equal(s.units.length, 1);
  assert.equal(s.units[0].unitId, "cu_1");
  assert.equal(s.units[0].nodes.length, 0);
  assert.equal(s.nodes.length, 0);
});

test("created 建节点并入 unit 与扁平清单", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_1"));
  s = reduceCanvasEvent(s, created("cu_1", "cu_1-text", "text", "文本", undefined));
  s = reduceCanvasEvent(s, created("cu_1", "cu_1-config", "config", "配置", undefined));
  assert.equal(s.units[0].nodes.length, 2);
  assert.equal(s.nodes.length, 2);
  assert.ok(s.nodes.every((n) => n.position.x !== 0 || n.position.y !== 0), "自动排版不该留在 0,0");
});

test("connected 建连线", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_1"));
  s = reduceCanvasEvent(s, created("cu_1", "a", "text", "A"));
  s = reduceCanvasEvent(s, created("cu_1", "b", "config", "B"));
  s = reduceCanvasEvent(s, connected("cu_1", "cu_1-c", "a", "b"));
  assert.equal(s.connections.length, 1);
  assert.equal(s.connections[0].fromNodeId, "a");
  assert.equal(s.connections[0].toNodeId, "b");
});

test("updated 落地结果（status/content/cost）", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_1"));
  s = reduceCanvasEvent(s, created("cu_1", "cu_1-image", "image", "生成中", "result"));
  s = reduceCanvasEvent(s, updated("cu_1", "cu_1-image", { status: "success" }, "https://example.com/img.webp", 2));
  const node = s.nodes.find((n) => n.id === "cu_1-image");
  assert.ok(node);
  assert.equal(node.metadata?.status, "success");
  assert.equal(node.metadata?.content, "https://example.com/img.webp");
  assert.equal(node.metadata?.cost_coins, 2);
});

test("generating 更新进度", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_1"));
  s = reduceCanvasEvent(s, created("cu_1", "cu_1-image", "image", "生成中", "result"));
  s = reduceCanvasEvent(s, { name: "canvas.node.generating", data: { unit_id: "cu_1", node_id: "cu_1-image", status: "running", progress: 50 } });
  const node = s.nodes.find((n) => n.id === "cu_1-image");
  assert.equal(node?.metadata?.status, "running");
  assert.equal(node?.metadata?.progress, 50);
});

test("plan 的 cost_hint 盖章到生成卡（image/video），实际 cost 落地后并存接班（C-FE）", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, { name: "canvas.plan", data: { ...plan("cu_1").data, cost_hint: 7 } });
  assert.equal(s.units[0].costHint, 7);
  s = reduceCanvasEvent(s, created("cu_1", "cu_1-text", "text", "提示词"));
  s = reduceCanvasEvent(s, created("cu_1", "cu_1-image", "image", "结果", "result"));
  assert.equal(s.nodes.find((n) => n.id === "cu_1-image")?.metadata?.cost_hint, 7);
  assert.equal(s.nodes.find((n) => n.id === "cu_1-text")?.metadata?.cost_hint, undefined);
  // 实际花费落地：cost_coins 进场（显示层实际角标接班），cost_hint 事实保留不删。
  s = reduceCanvasEvent(s, updated("cu_1", "cu_1-image", {}, undefined, 6));
  assert.equal(s.nodes.find((n) => n.id === "cu_1-image")?.metadata?.cost_coins, 6);
  assert.equal(s.nodes.find((n) => n.id === "cu_1-image")?.metadata?.cost_hint, 7);
  // cost_hint null（缺值）＝ 现状行为：unit 不挂、节点不盖章。
  let s2 = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_2"));
  s2 = reduceCanvasEvent(s2, created("cu_2", "cu_2-image", "image", "结果", "result"));
  assert.equal(s2.units[0].costHint, undefined);
  assert.equal(s2.nodes.find((n) => n.id === "cu_2-image")?.metadata?.cost_hint, undefined);
});

test("workflow plan 的全图总额 cost_hint 不逐卡盖章（2026-08-29 25.005 事故）", () => {
  // workflow 计画：cost_hint = estimateGraphCoins 整图总额，侧栏展示；
  // 逐卡盖章会把总额贴到每张生成卡上。
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, { name: "canvas.plan", data: { ...plan("wf_1", "workflow:novel_film").data, cost_hint: 25.005 } });
  s = reduceCanvasEvent(s, created("wf_1", "wf_1-image", "image", "分镜", "result"));
  s = reduceCanvasEvent(s, created("wf_1", "wf_1-video", "video", "片段", "result"));
  assert.equal(s.units[0].costHint, 25.005);
  assert.equal(s.nodes.find((n) => n.id === "wf_1-image")?.metadata?.cost_hint, undefined);
  assert.equal(s.nodes.find((n) => n.id === "wf_1-video")?.metadata?.cost_hint, undefined);
  // 工具层单生成 unit 的盖章行为不受影响（见上一测试）。
});

test("deleted 移除节点与关联连线", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_1"));
  s = reduceCanvasEvent(s, created("cu_1", "a", "text", "A"));
  s = reduceCanvasEvent(s, created("cu_1", "b", "config", "B"));
  s = reduceCanvasEvent(s, connected("cu_1", "c", "a", "b"));
  s = reduceCanvasEvent(s, { name: "canvas.node.deleted", data: { unit_id: "cu_1", node_id: "a" } });
  assert.equal(s.nodes.length, 1);
  assert.equal(s.connections.length, 0);
});

test("disconnected 移除 from->to 连线，节点保留", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_1"));
  s = reduceCanvasEvent(s, created("cu_1", "a", "text", "A"));
  s = reduceCanvasEvent(s, created("cu_1", "b", "config", "B"));
  s = reduceCanvasEvent(s, connected("cu_1", "c", "a", "b"));
  s = reduceCanvasEvent(s, { name: "canvas.node.disconnected", data: { unit_id: "cu_1", from: "a", to: "b" } });
  assert.equal(s.connections.length, 0);
  assert.equal(s.nodes.length, 2);
  assert.equal(s.units[0].connections.length, 0);
});

test("未知事件原样返回", () => {
  const s = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_1"));
  const unchanged = reduceCanvasEvent(s, { name: "canvas.derive.started", data: { unit_id: "cu_1", source_node_id: "a", instruction: "改暖色" } } as CanvasSseEvent);
  assert.equal(unchanged.units.length, 1);
});

test("getUnitGraph 回单元完整图", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, plan("cu_1"));
  s = reduceCanvasEvent(s, created("cu_1", "a", "text", "A"));
  s = reduceCanvasEvent(s, connected("cu_1", "c", "a", "b"));
  const g = getUnitGraph(s, "cu_1");
  assert.equal(g.nodes.length, 1);
  assert.equal(g.connections.length, 1);
});

test("layoutGraph：座标全 (0,0) 的回放快照分层展开且互不重叠（2026-09-14 回旧会话堆叠回归）", () => {
  // restoreAgentSnapshot 的输入形状：gateway 摘要不带座标，fromCanvasProject 补 (0,0)。
  const mk = (id: string): CanvasNode => ({
    id,
    type: CanvasNodeType.Text,
    title: id,
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: {},
  });
  const nodes = [mk("a"), mk("b"), mk("c"), mk("d")];
  const connections = [
    { id: "c1", fromNodeId: "a", toNodeId: "b" },
    { id: "c2", fromNodeId: "b", toNodeId: "c" },
    { id: "c3", fromNodeId: "b", toNodeId: "d" },
  ];
  const out = layoutGraph({ ...CANVAS_INITIAL_STATE, nodes, connections });
  const byId = new Map(out.nodes.map((n) => [n.id, n]));
  // DAG 分层：链上 x 严格递增，分叉的 c/d 不同 y。
  assert.ok(byId.get("a")!.position.x < byId.get("b")!.position.x);
  assert.ok(byId.get("b")!.position.x < byId.get("c")!.position.x);
  assert.ok(byId.get("b")!.position.x < byId.get("d")!.position.x);
  assert.notEqual(byId.get("c")!.position.y, byId.get("d")!.position.y);
  // 任意两卡矩形不得重叠——堆叠事故的直接判据。
  for (let i = 0; i < out.nodes.length; i++) {
    for (let j = i + 1; j < out.nodes.length; j++) {
      const p = out.nodes[i];
      const q = out.nodes[j];
      const overlap =
        p.position.x < q.position.x + q.width &&
        q.position.x < p.position.x + p.width &&
        p.position.y < q.position.y + q.height &&
        q.position.y < p.position.y + p.height;
      assert.ok(!overlap, `${p.id} 与 ${q.id} 重叠`);
    }
  }
});
