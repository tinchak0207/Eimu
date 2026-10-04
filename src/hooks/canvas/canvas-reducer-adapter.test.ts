// canvas-reducer-adapter 契约测试：19+1 种 CanvasAction 逐种驱动，断言 state 转移。
// （union 实际 20 个成员：event/load/move/resize/remove/clear/batch_*4/reference*2/
//  move_many/add_nodes/delete_many/connect/disconnect/rename/patch_metadata/agent_ops）
// 测试直接驱动纯函数 reducer，不架 React —— 这正是 adapter 搬出 hook 的目的。
import { test } from "node:test";
import assert from "node:assert/strict";
import { canvasReducer } from "./canvas-reducer-adapter";
import { CANVAS_INITIAL_STATE, type CanvasReducerState } from "@/lib/canvas/reducer";
import type { AgentSseEvent } from "@/lib/agent-chat-types";
import { normalizeStoryboardShot } from "@/lib/storyboard-contract";
import { CanvasNodeType, type CanvasNode, type CanvasNodeMetadata } from "@/lib/canvas/types";

// ── fixtures

function node(id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    type: CanvasNodeType.Text,
    title: id,
    position: { x: 10, y: 10 },
    width: 300,
    height: 200,
    ...extra,
  };
}

/** 两节点 + 一连线的基线状态。 */
function baseline(): CanvasReducerState {
  return {
    units: [{ unitId: "cu_1", tool: "image_generate", nodes: [node("a"), node("b")], connections: [] }],
    nodes: [node("a"), node("b")],
    connections: [{ id: "c1", fromNodeId: "a", toNodeId: "b" }],
  };
}

function createdEvent(nodeId: string): AgentSseEvent {
  return {
    name: "canvas.node.created",
    event_id: 1,
    data: {
      unit_id: "cu_1",
      node: { id: nodeId, type: "text", title: nodeId, position: { x: 0, y: 0 }, width: 340, height: 240, metadata: { content: "", status: "idle" } },
    },
  } as AgentSseEvent;
}

// ── 1. event：SSE 事件经 normalize 后进底层 reducer

test("event：canvas.node.created 建节点", () => {
  const s = canvasReducer(CANVAS_INITIAL_STATE, { type: "event", event: createdEvent("n1") });
  assert.equal(s.nodes.length, 1);
  assert.equal(s.nodes[0].id, "n1");
});

test("event：非画布事件（message.delta）不改 state", () => {
  const before = baseline();
  const s = canvasReducer(before, {
    type: "event",
    event: { name: "message.delta", event_id: 2, data: { text: "hi" } } as AgentSseEvent,
  });
  assert.equal(s, before);
});

// ── 2. load：整批替换，units 清空

test("load：替换 nodes/connections 且 units 清空", () => {
  const s = canvasReducer(baseline(), { type: "load", nodes: [node("x")], connections: [] });
  assert.equal(s.nodes.length, 1);
  assert.equal(s.nodes[0].id, "x");
  assert.equal(s.connections.length, 0);
  assert.equal(s.units.length, 0);
});

// ── 3. move：位置更新 + moved 标记

test("move：位置更新并标记 moved", () => {
  const s = canvasReducer(baseline(), { type: "move", nodeId: "a", position: { x: 99, y: 88 } });
  const a = s.nodes.find((n) => n.id === "a");
  assert.deepEqual(a?.position, { x: 99, y: 88 });
  assert.equal(a?.moved, true);
  // 其他节点不受影响
  assert.equal(s.nodes.find((n) => n.id === "b")?.moved, undefined);
});

// ── 4. resize

test("resize：更新宽高", () => {
  const s = canvasReducer(baseline(), { type: "resize", nodeId: "a", width: 500, height: 400 });
  const a = s.nodes.find((n) => n.id === "a");
  assert.equal(a?.width, 500);
  assert.equal(a?.height, 400);
});

// ── 5. remove：节点 + 两端连线 + unit 内同步移除

test("remove：移除节点与关联连线（含 unit 内）", () => {
  const s = canvasReducer(baseline(), { type: "remove", nodeId: "a" });
  assert.equal(s.nodes.length, 1);
  assert.equal(s.connections.length, 0);
  assert.equal(s.units[0].nodes.length, 1);
  assert.equal(s.units[0].connections.length, 0);
});

// ── 6. clear

test("clear：回到初始状态", () => {
  const s = canvasReducer(baseline(), { type: "clear" });
  assert.deepEqual(s, CANVAS_INITIAL_STATE);
});

// ── 7-10. batch_*：批次父节点操作

function batchParent(): CanvasReducerState {
  return {
    units: [],
    nodes: [
      node("p", { batchChildren: ["c1"], batchExpanded: false, batchPrimaryImageId: "c1" }),
      node("c1", { type: CanvasNodeType.Image }),
    ],
    connections: [{ id: "cc", fromNodeId: "p", toNodeId: "c1" }],
  };
}

test("batch_add_child：父节点原位更新 + 子节点追加 + 首子自动主图", () => {
  const s = canvasReducer(
    { units: [], nodes: [node("p")], connections: [] },
    { type: "batch_add_child", parentId: "p", child: node("c1", { type: CanvasNodeType.Image }) },
  );
  const p = s.nodes.find((n) => n.id === "p");
  assert.deepEqual(p?.batchChildren, ["c1"]);
  assert.equal(p?.batchExpanded, true);
  assert.equal(p?.batchPrimaryImageId, "c1");
  assert.equal(p?.metadata?.batchTotal, 1);
  assert.equal(s.nodes.length, 2); // 子节点已追加
  // 父节点仍在原位（filter+append 会乱序，原位 map 不可）
  assert.equal(s.nodes[0].id, "p");
});

test("batch_add_child：父不存在则原样返回", () => {
  const before = batchParent();
  const s = canvasReducer(before, { type: "batch_add_child", parentId: "nope", child: node("c9") });
  assert.equal(s, before);
});

test("batch_set_primary：切换主图 id", () => {
  const s = canvasReducer(batchParent(), { type: "batch_set_primary", parentId: "p", childId: "c1" });
  assert.equal(s.nodes.find((n) => n.id === "p")?.batchPrimaryImageId, "c1");
});

test("batch_delete_child：删子 + 主图 fallback + 连线清理", () => {
  const s = canvasReducer(batchParent(), { type: "batch_delete_child", parentId: "p", childId: "c1" });
  assert.equal(s.nodes.length, 1); // 子节点已删
  const p = s.nodes[0];
  assert.deepEqual(p.batchChildren, []);
  assert.equal(p.batchPrimaryImageId, undefined); // 主图被删 → 剩余第一个（无）→ 清空
  assert.equal(p.metadata?.batchTotal, 0);
  assert.equal(s.connections.length, 0); // 子的连线一并清理
});

test("batch_toggle_expanded：展开↔收起", () => {
  const s1 = canvasReducer(batchParent(), { type: "batch_toggle_expanded", parentId: "p" });
  assert.equal(s1.nodes.find((n) => n.id === "p")?.batchExpanded, true);
  const s2 = canvasReducer(s1, { type: "batch_toggle_expanded", parentId: "p" });
  assert.equal(s2.nodes.find((n) => n.id === "p")?.batchExpanded, false);
});

// ── 11-12. add_reference / remove_reference

test("add_reference：加入 referenceNodeIds 且去重", () => {
  const s1 = canvasReducer(baseline(), { type: "add_reference", nodeId: "a", referenceNodeId: "b" });
  assert.deepEqual(s1.nodes.find((n) => n.id === "a")?.metadata?.referenceNodeIds, ["b"]);
  const s2 = canvasReducer(s1, { type: "add_reference", nodeId: "a", referenceNodeId: "b" });
  assert.deepEqual(s2.nodes.find((n) => n.id === "a")?.metadata?.referenceNodeIds, ["b"]);
});

test("remove_reference：移除 referenceNodeIds", () => {
  const s0 = canvasReducer(baseline(), { type: "add_reference", nodeId: "a", referenceNodeId: "b" });
  const s1 = canvasReducer(s0, { type: "remove_reference", nodeId: "a", referenceNodeId: "b" });
  assert.deepEqual(s1.nodes.find((n) => n.id === "a")?.metadata?.referenceNodeIds, []);
});

// ── 13. move_many：群组拖动

test("move_many：整组移动并标记 moved", () => {
  const s = canvasReducer(baseline(), {
    type: "move_many",
    moves: [
      { nodeId: "a", position: { x: 1, y: 2 } },
      { nodeId: "b", position: { x: 3, y: 4 } },
    ],
  });
  assert.deepEqual(s.nodes.find((n) => n.id === "a")?.position, { x: 1, y: 2 });
  assert.deepEqual(s.nodes.find((n) => n.id === "b")?.position, { x: 3, y: 4 });
  assert.ok(s.nodes.every((n) => n.moved === true));
});

test("move_many：空 moves 原样返回", () => {
  const before = baseline();
  const s = canvasReducer(before, { type: "move_many", moves: [] });
  assert.equal(s, before);
});

// ── 14. add_nodes：贴上/切图插入

test("add_nodes：追加节点与新连线（id 防撞去重）", () => {
  const s = canvasReducer(baseline(), {
    type: "add_nodes",
    nodes: [node("c"), node("a")], // a 撞 id → 旧的被新值覆盖（不重复）
    connections: [
      { id: "c2", fromNodeId: "a", toNodeId: "c" },
      { id: "c1", fromNodeId: "a", toNodeId: "b" }, // 撞既有连线 id → 去重
    ],
  });
  assert.equal(s.nodes.filter((n) => n.id === "a").length, 1);
  assert.equal(s.nodes.length, 3);
  assert.equal(s.connections.length, 2); // c1 保留旧的，c2 新增
});

test("add_nodes：空节点空连线原样返回", () => {
  const before = baseline();
  const s = canvasReducer(before, { type: "add_nodes", nodes: [] });
  assert.equal(s, before);
});

// ── 15. delete_many：多删 + 批次子清整

function batchTwo(): CanvasReducerState {
  return {
    units: [],
    nodes: [
      node("p", { batchChildren: ["c1", "c2"], batchPrimaryImageId: "c1" }),
      node("c1", { type: CanvasNodeType.Image }),
      node("c2", { type: CanvasNodeType.Image }),
      node("solo"),
    ],
    connections: [
      { id: "k1", fromNodeId: "p", toNodeId: "c1" },
      { id: "k2", fromNodeId: "solo", toNodeId: "c2" },
    ],
  };
}

test("delete_many：多删 + 批次子收缩 + 主图 fallback + 连线清理", () => {
  const s = canvasReducer(batchTwo(), { type: "delete_many", nodeIds: ["c1", "solo"] });
  assert.equal(s.nodes.length, 2); // 剩 p + c2
  const p = s.nodes.find((n) => n.id === "p");
  assert.deepEqual(p?.batchChildren, ["c2"]);
  assert.equal(p?.batchPrimaryImageId, "c2"); // 主图被删 → fallback 剩余第一个
  assert.equal(p?.metadata?.batchTotal, 1);
  assert.equal(s.connections.length, 0); // k1（c1 端）k2（solo 端）都清
});

// ── 16. connect / 17. disconnect

test("connect：建连线（id 稳定命名）", () => {
  const s0 = { units: [], nodes: [node("a"), node("b")], connections: [] };
  const s = canvasReducer(s0, { type: "connect", fromNodeId: "a", toNodeId: "b" });
  assert.equal(s.connections.length, 1);
  assert.equal(s.connections[0].id, "conn-a-b");
});

test("connect：自环与重复同向拒绝", () => {
  const s0 = baseline();
  assert.equal(canvasReducer(s0, { type: "connect", fromNodeId: "a", toNodeId: "a" }), s0);
  assert.equal(canvasReducer(s0, { type: "connect", fromNodeId: "a", toNodeId: "b" }), s0); // c1 已存在同向
});

test("disconnect：按 id 删连线", () => {
  const s = canvasReducer(baseline(), { type: "disconnect", connectionId: "c1" });
  assert.equal(s.connections.length, 0);
});

// ── 18. rename

test("rename：标题 trim + 截 120", () => {
  const s = canvasReducer(baseline(), { type: "rename", nodeId: "a", title: "  新标题  " });
  assert.equal(s.nodes.find((n) => n.id === "a")?.title, "新标题");
  const long = "x".repeat(200);
  const s2 = canvasReducer(baseline(), { type: "rename", nodeId: "a", title: long });
  assert.equal(s2.nodes.find((n) => n.id === "a")?.title.length, 120);
});

test("rename：空标题原样返回", () => {
  const before = baseline();
  assert.equal(canvasReducer(before, { type: "rename", nodeId: "a", title: "   " }), before);
});

// ── 19. patch_metadata

test("patch_metadata：补丁合并进 metadata", () => {
  const s0 = canvasReducer(baseline(), { type: "add_reference", nodeId: "a", referenceNodeId: "b" });
  const s = canvasReducer(s0, { type: "patch_metadata", nodeId: "a", patch: { status: "loading" } });
  const m = s.nodes.find((n) => n.id === "a")?.metadata;
  assert.equal(m?.status, "loading");
  assert.deepEqual(m?.referenceNodeIds, ["b"]); // 既有栏位保留
});

// ── 19b. patch_metadata × 分镜媒体关联失效（W2，2026-09-30 接线到本漏斗）
//
// 真行为断言：驱动 reducer 后看**结果 state 上实际存活哪些关联键**（不是源码字串扫描）。
// 分镜节点真形状：内容在巢状 `storyboardShot`（21 栏），关联键（shotCandidates／
// dialogueAudioId／narrationAudioId／audioAnchorId）在 metadata 顶层。

/** 一颗「媒体已备妥」的分镜节点（所有关联都有值）。 */
function shotNode(id: string, over: Record<string, unknown> = {}): CanvasNode {
  return node(id, {
    metadata: {
      storyboardShot: normalizeStoryboardShot({
        shotNumber: "001",
        visualDescription: "wide establishing shot",
        dialogue: "hello there",
        shotSize: "WS",
      }),
      prompt: "painter prompt v1",
      narration: "narration v1",
      shotCandidates: { items: [{ id: "c1", prompt: "candidate prompt" }], selectedId: "c1" },
      dialogueAudioId: "dlg-audio-1",
      narrationAudioId: "nar-audio-1",
      audioAnchorId: "anchor-1",
      ...over,
    } as CanvasNodeMetadata,
  });
}

function shotState(over: Record<string, unknown> = {}): CanvasReducerState {
  return { units: [], nodes: [shotNode("s", over)], connections: [] };
}

/** 结果 state 上该节点的 metadata（宽化袋子读——音轨关联键不在 interface 内）。 */
function shotMetadata(s: CanvasReducerState): Record<string, unknown> {
  const n = s.nodes.find((x) => x.id === "s");
  assert.ok(n, "节点 s 应仍在");
  return (n.metadata ?? {}) as Record<string, unknown>;
}

test("patch_metadata:改 dialogue 经漏斗后 dialogueAudioId 真的不见（未变更关联原样）", () => {
  const s = canvasReducer(shotState(), {
    type: "patch_metadata",
    nodeId: "s",
    patch: {
      storyboardShot: normalizeStoryboardShot({
        shotNumber: "001",
        visualDescription: "wide establishing shot", // 画面未变
        dialogue: "hello there!", // 台词真的变了
        shotSize: "WS",
      })!,
    },
  });
  const m = shotMetadata(s);
  // 台词配音关联真的被移除（不是「值变空」——键本身不在）
  assert.ok(!("dialogueAudioId" in m), "dialogueAudioId 应已失效并自 metadata 移除");
  // 音频锚点（台词变 → 锚点失效，对齐 routes.js:445-447）
  assert.ok(!("audioAnchorId" in m), "audioAnchorId 应已失效");
  // 旁白未变 → 旁白配音关联一个都不能动
  assert.equal(m.narrationAudioId, "nar-audio-1");
  // 画面未变 → 影像关联不动
  assert.deepEqual(m.shotCandidates, { items: [{ id: "c1", prompt: "candidate prompt" }], selectedId: "c1" });
  // 而台词本身真的有写进去
  assert.equal((m.storyboardShot as Record<string, unknown>).dialogue, "hello there!");
});

test("patch_metadata:只改无关栏位（status）→ 四个关联全都不动", () => {
  const s = canvasReducer(shotState(), { type: "patch_metadata", nodeId: "s", patch: { status: "loading" } });
  const m = shotMetadata(s);
  assert.equal(m.status, "loading");
  assert.equal(m.dialogueAudioId, "dlg-audio-1");
  assert.equal(m.narrationAudioId, "nar-audio-1");
  assert.equal(m.audioAnchorId, "anchor-1");
  assert.ok("shotCandidates" in m);
});

test("patch_metadata:patch 显式带新 dialogueAudioId → 该键以其为准（不被失效清掉）", () => {
  const s = canvasReducer(shotState(), {
    type: "patch_metadata",
    nodeId: "s",
    patch: {
      storyboardShot: normalizeStoryboardShot({
        shotNumber: "001",
        visualDescription: "wide establishing shot",
        dialogue: "hello there!", // 台词变
        shotSize: "WS",
      })!,
      // 同一 patch 显式绑一颗新配音（caller 明确要换）→ 不得被失效清掉
      dialogueAudioId: "dlg-audio-2",
    } as Partial<CanvasNodeMetadata>,
  });
  const m = shotMetadata(s);
  assert.equal(m.dialogueAudioId, "dlg-audio-2"); // 新值存活且是最新那颗
  assert.ok(!("audioAnchorId" in m)); // 未显式带的锚点仍失效（审查：不扩张也不漏）
  assert.equal(m.narrationAudioId, "nar-audio-1");
});

// ── 20. agent_ops：批量操作原子套用

test("agent_ops：add_node 用预设尺寸补全 + 撞 id 丢弃", () => {
  const s = canvasReducer(baseline(), {
    type: "agent_ops",
    ops: [
      { type: "add_node", node: { id: "new1", type: "text", title: "agent 卡" } },
      { type: "add_node", node: { id: "a", type: "text", title: "撞号" } }, // 撞 id → 丢弃
    ],
  });
  assert.equal(s.nodes.length, 3); // a b new1
  const added = s.nodes.find((n) => n.id === "new1");
  assert.ok(added);
  assert.equal(added.type, CanvasNodeType.Text);
  assert.equal(added.width, 340); // CANVAS_NODE_DEFAULT_SIZE 文本预设 340x240
  assert.equal(added.height, 240);
  assert.equal(added.moved, true);
});

test("agent_ops：update_node 套补丁（标题截断/位置标 moved/尺寸下限）", () => {
  const s = canvasReducer(baseline(), {
    type: "agent_ops",
    ops: [
      {
        type: "update_node",
        id: "a",
        patch: { title: "y".repeat(300), position: { x: 5, y: 6 }, width: 10, height: 10 },
      },
    ],
  });
  const a = s.nodes.find((n) => n.id === "a");
  assert.equal(a?.title.length, 120);
  assert.deepEqual(a?.position, { x: 5, y: 6 });
  assert.equal(a?.moved, true);
  assert.equal(a?.width, 120); // Math.max(120, 10)
  assert.equal(a?.height, 90); // Math.max(90, 10)
});

test("agent_ops：delete_nodes/connect_nodes/delete_connections 组合", () => {
  const s = canvasReducer(baseline(), {
    type: "agent_ops",
    ops: [
      { type: "delete_nodes", ids: ["b"] },
      { type: "add_node", node: { id: "c", type: "text" } },
      { type: "connect_nodes", connections: [{ fromNodeId: "a", toNodeId: "c" }] },
      { type: "delete_connections", ids: [] },
    ],
  });
  assert.equal(s.nodes.map((n) => n.id).join(","), "a,c");
  assert.equal(s.connections.length, 1);
  assert.equal(s.connections[0].id, "conn-a-c");
});

test("agent_ops：select_nodes 等非结构 op 不改 state", () => {
  const before = baseline();
  const s = canvasReducer(before, {
    type: "agent_ops",
    ops: [{ type: "select_nodes", ids: ["a"] }],
  });
  assert.equal(s.nodes, before.nodes);
});

test("agent_ops：revert_node 把内容回到指定版（座标不动、回退本身 append 一版）", () => {
  const state: CanvasReducerState = {
    units: [],
    nodes: [node("a", { title: "第二版", position: { x: 99, y: 88 }, metadata: { content: "new" } })],
    connections: [],
    nodeVersions: [
      { version: 1, nodeId: "a", createdAt: "2026-10-03T00:00:00.000Z", reason: "created", title: "第一版", metadata: { content: "old" } },
    ],
  };
  const s = canvasReducer(state, { type: "agent_ops", ops: [{ type: "revert_node", nodeId: "a", version: 1 }] });
  const a = s.nodes.find((n) => n.id === "a");
  assert.equal(a?.title, "第一版");
  assert.equal((a?.metadata as Record<string, unknown> | undefined)?.content, "old");
  assert.deepEqual(a?.position, { x: 99, y: 88 }, "版本＝内容历史，座标不动");
  const versions = s.nodeVersions ?? [];
  assert.equal(versions.length, 2, "回退本身也落一版");
  assert.equal(versions[versions.length - 1].reason, "revert");
});
