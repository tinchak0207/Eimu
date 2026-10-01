// canvas-reducer-adapter 契約測試：19+1 種 CanvasAction 逐種驅動，斷言 state 轉移。
// （union 實際 20 個成員：event/load/move/resize/remove/clear/batch_*4/reference*2/
//  move_many/add_nodes/delete_many/connect/disconnect/rename/patch_metadata/agent_ops）
// 測試直接驅動純函數 reducer，不架 React —— 這正是 adapter 搬出 hook 的目的。
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

/** 兩節點 + 一連線的基線狀態。 */
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

// ── 1. event：SSE 事件經 normalize 後進底層 reducer

test("event：canvas.node.created 建節點", () => {
  const s = canvasReducer(CANVAS_INITIAL_STATE, { type: "event", event: createdEvent("n1") });
  assert.equal(s.nodes.length, 1);
  assert.equal(s.nodes[0].id, "n1");
});

test("event：非畫布事件（message.delta）不改 state", () => {
  const before = baseline();
  const s = canvasReducer(before, {
    type: "event",
    event: { name: "message.delta", event_id: 2, data: { text: "hi" } } as AgentSseEvent,
  });
  assert.equal(s, before);
});

// ── 2. load：整批替換，units 清空

test("load：替換 nodes/connections 且 units 清空", () => {
  const s = canvasReducer(baseline(), { type: "load", nodes: [node("x")], connections: [] });
  assert.equal(s.nodes.length, 1);
  assert.equal(s.nodes[0].id, "x");
  assert.equal(s.connections.length, 0);
  assert.equal(s.units.length, 0);
});

// ── 3. move：位置更新 + moved 標記

test("move：位置更新並標記 moved", () => {
  const s = canvasReducer(baseline(), { type: "move", nodeId: "a", position: { x: 99, y: 88 } });
  const a = s.nodes.find((n) => n.id === "a");
  assert.deepEqual(a?.position, { x: 99, y: 88 });
  assert.equal(a?.moved, true);
  // 其他節點不受影響
  assert.equal(s.nodes.find((n) => n.id === "b")?.moved, undefined);
});

// ── 4. resize

test("resize：更新寬高", () => {
  const s = canvasReducer(baseline(), { type: "resize", nodeId: "a", width: 500, height: 400 });
  const a = s.nodes.find((n) => n.id === "a");
  assert.equal(a?.width, 500);
  assert.equal(a?.height, 400);
});

// ── 5. remove：節點 + 兩端連線 + unit 內同步移除

test("remove：移除節點與關聯連線（含 unit 內）", () => {
  const s = canvasReducer(baseline(), { type: "remove", nodeId: "a" });
  assert.equal(s.nodes.length, 1);
  assert.equal(s.connections.length, 0);
  assert.equal(s.units[0].nodes.length, 1);
  assert.equal(s.units[0].connections.length, 0);
});

// ── 6. clear

test("clear：回到初始狀態", () => {
  const s = canvasReducer(baseline(), { type: "clear" });
  assert.deepEqual(s, CANVAS_INITIAL_STATE);
});

// ── 7-10. batch_*：批次父節點操作

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

test("batch_add_child：父節點原位更新 + 子節點追加 + 首子自動主圖", () => {
  const s = canvasReducer(
    { units: [], nodes: [node("p")], connections: [] },
    { type: "batch_add_child", parentId: "p", child: node("c1", { type: CanvasNodeType.Image }) },
  );
  const p = s.nodes.find((n) => n.id === "p");
  assert.deepEqual(p?.batchChildren, ["c1"]);
  assert.equal(p?.batchExpanded, true);
  assert.equal(p?.batchPrimaryImageId, "c1");
  assert.equal(p?.metadata?.batchTotal, 1);
  assert.equal(s.nodes.length, 2); // 子節點已追加
  // 父節點仍在原位（filter+append 會亂序，原位 map 不可）
  assert.equal(s.nodes[0].id, "p");
});

test("batch_add_child：父不存在則原樣返回", () => {
  const before = batchParent();
  const s = canvasReducer(before, { type: "batch_add_child", parentId: "nope", child: node("c9") });
  assert.equal(s, before);
});

test("batch_set_primary：切換主圖 id", () => {
  const s = canvasReducer(batchParent(), { type: "batch_set_primary", parentId: "p", childId: "c1" });
  assert.equal(s.nodes.find((n) => n.id === "p")?.batchPrimaryImageId, "c1");
});

test("batch_delete_child：刪子 + 主圖 fallback + 連線清理", () => {
  const s = canvasReducer(batchParent(), { type: "batch_delete_child", parentId: "p", childId: "c1" });
  assert.equal(s.nodes.length, 1); // 子節點已刪
  const p = s.nodes[0];
  assert.deepEqual(p.batchChildren, []);
  assert.equal(p.batchPrimaryImageId, undefined); // 主圖被刪 → 剩餘第一個（無）→ 清空
  assert.equal(p.metadata?.batchTotal, 0);
  assert.equal(s.connections.length, 0); // 子的連線一併清理
});

test("batch_toggle_expanded：展開↔收起", () => {
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

// ── 13. move_many：群組拖動

test("move_many：整組移動並標記 moved", () => {
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

test("move_many：空 moves 原樣返回", () => {
  const before = baseline();
  const s = canvasReducer(before, { type: "move_many", moves: [] });
  assert.equal(s, before);
});

// ── 14. add_nodes：貼上/切圖插入

test("add_nodes：追加節點與新連線（id 防撞去重）", () => {
  const s = canvasReducer(baseline(), {
    type: "add_nodes",
    nodes: [node("c"), node("a")], // a 撞 id → 舊的被新值覆蓋（不重複）
    connections: [
      { id: "c2", fromNodeId: "a", toNodeId: "c" },
      { id: "c1", fromNodeId: "a", toNodeId: "b" }, // 撞既有連線 id → 去重
    ],
  });
  assert.equal(s.nodes.filter((n) => n.id === "a").length, 1);
  assert.equal(s.nodes.length, 3);
  assert.equal(s.connections.length, 2); // c1 保留舊的，c2 新增
});

test("add_nodes：空節點空連線原樣返回", () => {
  const before = baseline();
  const s = canvasReducer(before, { type: "add_nodes", nodes: [] });
  assert.equal(s, before);
});

// ── 15. delete_many：多刪 + 批次子清整

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

test("delete_many：多刪 + 批次子收縮 + 主圖 fallback + 連線清理", () => {
  const s = canvasReducer(batchTwo(), { type: "delete_many", nodeIds: ["c1", "solo"] });
  assert.equal(s.nodes.length, 2); // 剩 p + c2
  const p = s.nodes.find((n) => n.id === "p");
  assert.deepEqual(p?.batchChildren, ["c2"]);
  assert.equal(p?.batchPrimaryImageId, "c2"); // 主圖被刪 → fallback 剩餘第一個
  assert.equal(p?.metadata?.batchTotal, 1);
  assert.equal(s.connections.length, 0); // k1（c1 端）k2（solo 端）都清
});

// ── 16. connect / 17. disconnect

test("connect：建連線（id 穩定命名）", () => {
  const s0 = { units: [], nodes: [node("a"), node("b")], connections: [] };
  const s = canvasReducer(s0, { type: "connect", fromNodeId: "a", toNodeId: "b" });
  assert.equal(s.connections.length, 1);
  assert.equal(s.connections[0].id, "conn-a-b");
});

test("connect：自環與重複同向拒絕", () => {
  const s0 = baseline();
  assert.equal(canvasReducer(s0, { type: "connect", fromNodeId: "a", toNodeId: "a" }), s0);
  assert.equal(canvasReducer(s0, { type: "connect", fromNodeId: "a", toNodeId: "b" }), s0); // c1 已存在同向
});

test("disconnect：按 id 刪連線", () => {
  const s = canvasReducer(baseline(), { type: "disconnect", connectionId: "c1" });
  assert.equal(s.connections.length, 0);
});

// ── 18. rename

test("rename：標題 trim + 截 120", () => {
  const s = canvasReducer(baseline(), { type: "rename", nodeId: "a", title: "  新標題  " });
  assert.equal(s.nodes.find((n) => n.id === "a")?.title, "新標題");
  const long = "x".repeat(200);
  const s2 = canvasReducer(baseline(), { type: "rename", nodeId: "a", title: long });
  assert.equal(s2.nodes.find((n) => n.id === "a")?.title.length, 120);
});

test("rename：空標題原樣返回", () => {
  const before = baseline();
  assert.equal(canvasReducer(before, { type: "rename", nodeId: "a", title: "   " }), before);
});

// ── 19. patch_metadata

test("patch_metadata：補丁合併進 metadata", () => {
  const s0 = canvasReducer(baseline(), { type: "add_reference", nodeId: "a", referenceNodeId: "b" });
  const s = canvasReducer(s0, { type: "patch_metadata", nodeId: "a", patch: { status: "loading" } });
  const m = s.nodes.find((n) => n.id === "a")?.metadata;
  assert.equal(m?.status, "loading");
  assert.deepEqual(m?.referenceNodeIds, ["b"]); // 既有欄位保留
});

// ── 19b. patch_metadata × 分鏡媒體關聯失效（W2，2026-09-30 接線到本漏斗）
//
// 真行為斷言：驅動 reducer 後看**結果 state 上實際存活哪些關聯鍵**（不是源碼字串掃描）。
// 分鏡節點真形狀：內容在巢狀 `storyboardShot`（21 欄），關聯鍵（shotCandidates／
// dialogueAudioId／narrationAudioId／audioAnchorId）在 metadata 頂層。

/** 一顆「媒體已備妥」的分鏡節點（所有關聯都有值）。 */
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

/** 結果 state 上該節點的 metadata（寬化袋子讀——音軌關聯鍵不在 interface 內）。 */
function shotMetadata(s: CanvasReducerState): Record<string, unknown> {
  const n = s.nodes.find((x) => x.id === "s");
  assert.ok(n, "節點 s 應仍在");
  return (n.metadata ?? {}) as Record<string, unknown>;
}

test("patch_metadata:改 dialogue 經漏斗後 dialogueAudioId 真的不見（未變更關聯原樣）", () => {
  const s = canvasReducer(shotState(), {
    type: "patch_metadata",
    nodeId: "s",
    patch: {
      storyboardShot: normalizeStoryboardShot({
        shotNumber: "001",
        visualDescription: "wide establishing shot", // 畫面未變
        dialogue: "hello there!", // 台詞真的變了
        shotSize: "WS",
      })!,
    },
  });
  const m = shotMetadata(s);
  // 台詞配音關聯真的被移除（不是「值變空」——鍵本身不在）
  assert.ok(!("dialogueAudioId" in m), "dialogueAudioId 應已失效並自 metadata 移除");
  // 音頻錨點（台詞變 → 錨點失效，對齊 routes.js:445-447）
  assert.ok(!("audioAnchorId" in m), "audioAnchorId 應已失效");
  // 旁白未變 → 旁白配音關聯一個都不能動
  assert.equal(m.narrationAudioId, "nar-audio-1");
  // 畫面未變 → 影像關聯不動
  assert.deepEqual(m.shotCandidates, { items: [{ id: "c1", prompt: "candidate prompt" }], selectedId: "c1" });
  // 而台詞本身真的有寫進去
  assert.equal((m.storyboardShot as Record<string, unknown>).dialogue, "hello there!");
});

test("patch_metadata:只改無關欄位（status）→ 四個關聯全都不動", () => {
  const s = canvasReducer(shotState(), { type: "patch_metadata", nodeId: "s", patch: { status: "loading" } });
  const m = shotMetadata(s);
  assert.equal(m.status, "loading");
  assert.equal(m.dialogueAudioId, "dlg-audio-1");
  assert.equal(m.narrationAudioId, "nar-audio-1");
  assert.equal(m.audioAnchorId, "anchor-1");
  assert.ok("shotCandidates" in m);
});

test("patch_metadata:patch 顯式帶新 dialogueAudioId → 該鍵以其為準（不被失效清掉）", () => {
  const s = canvasReducer(shotState(), {
    type: "patch_metadata",
    nodeId: "s",
    patch: {
      storyboardShot: normalizeStoryboardShot({
        shotNumber: "001",
        visualDescription: "wide establishing shot",
        dialogue: "hello there!", // 台詞變
        shotSize: "WS",
      })!,
      // 同一 patch 顯式綁一顆新配音（caller 明確要換）→ 不得被失效清掉
      dialogueAudioId: "dlg-audio-2",
    } as Partial<CanvasNodeMetadata>,
  });
  const m = shotMetadata(s);
  assert.equal(m.dialogueAudioId, "dlg-audio-2"); // 新值存活且是最新那顆
  assert.ok(!("audioAnchorId" in m)); // 未顯式帶的錨點仍失效（審查：不擴張也不漏）
  assert.equal(m.narrationAudioId, "nar-audio-1");
});

// ── 20. agent_ops：批量操作原子套用

test("agent_ops：add_node 用預設尺寸補全 + 撞 id 丟棄", () => {
  const s = canvasReducer(baseline(), {
    type: "agent_ops",
    ops: [
      { type: "add_node", node: { id: "new1", type: "text", title: "agent 卡" } },
      { type: "add_node", node: { id: "a", type: "text", title: "撞號" } }, // 撞 id → 丟棄
    ],
  });
  assert.equal(s.nodes.length, 3); // a b new1
  const added = s.nodes.find((n) => n.id === "new1");
  assert.ok(added);
  assert.equal(added.type, CanvasNodeType.Text);
  assert.equal(added.width, 340); // CANVAS_NODE_DEFAULT_SIZE 文本預設 340x240
  assert.equal(added.height, 240);
  assert.equal(added.moved, true);
});

test("agent_ops：update_node 套補丁（標題截斷/位置標 moved/尺寸下限）", () => {
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

test("agent_ops：delete_nodes/connect_nodes/delete_connections 組合", () => {
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

test("agent_ops：select_nodes 等非結構 op 不改 state", () => {
  const before = baseline();
  const s = canvasReducer(before, {
    type: "agent_ops",
    ops: [{ type: "select_nodes", ids: ["a"] }],
  });
  assert.equal(s.nodes, before.nodes);
});
