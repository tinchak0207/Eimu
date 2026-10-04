// canvas-agent-snapshot 测试：DSL 反推、版本索引、上行载荷大小守卫。
// 风格对齐 src/lib/workflow-dsl/workflow-dsl.test.ts（node:test + assert/strict）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CanvasNodeType, type CanvasConnection, type CanvasNode, type CanvasNodeVersion } from "@/lib/canvas/types";
import { compileWorkflow } from "@/lib/workflow-dsl/compile";
import { buildAgentCanvasSnapshot, buildNodeVersionIndex, buildWorkflowDsl } from "./canvas-agent-snapshot";

// ─────────────────────────── helpers

function node(id: string, type: CanvasNodeType, title: string, metadata: Record<string, unknown> = {}): CanvasNode {
  return { id, type, title, position: { x: 10, y: 20 }, width: 340, height: 240, metadata };
}

/** 用真编译器铺一张三步链，再转成 CanvasNode（metadata 全量，非压缩）。 */
function compiledGraph(): { nodes: CanvasNode[]; connections: CanvasConnection[] } {
  const r = compileWorkflow(
    {
      workflow: "demo_wf",
      steps: [
        { id: "brief", title: "文本简报", kind: "text", prompt: "写简介" },
        { id: "shot_a", title: "镜头A", kind: "image", prompt: "第一幕", needs: ["brief"], tool: "image_generate" },
      ],
    },
    { nodes: [], connections: [] },
  );
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("unreachable");
  const nodes: CanvasNode[] = [];
  const connections: CanvasConnection[] = [];
  for (const op of r.ops) {
    if (op.type === "add_node") {
      nodes.push(node(op.node.id, op.node.type as CanvasNodeType, op.node.title ?? "", { ...(op.node.metadata ?? {}) }));
    } else if (op.type === "connect_nodes") {
      for (const c of op.connections) connections.push({ id: `c-${c.fromNodeId}-${c.toNodeId}`, ...c });
    }
  }
  return { nodes, connections };
}

// ─────────────────────────── ① DSL 反推＝图的可逆声明

test("buildWorkflowDsl：从全量节点 metadata 反推回原步骤（含 needs/prompt/tool）", () => {
  const { nodes, connections } = compiledGraph();
  const dsl = buildWorkflowDsl(nodes, connections);
  assert.equal(dsl.length, 1);
  assert.equal(dsl[0].workflow, "demo_wf");
  const ids = dsl[0].steps.map((s) => s.id).sort();
  assert.deepEqual(ids, ["brief", "shot_a"]);
  const shot = dsl[0].steps.find((s) => s.id === "shot_a");
  assert.ok(shot);
  assert.deepEqual(shot.needs, ["brief"]);
  assert.equal(shot.tool, "image_generate");
  assert.equal(shot.prompt, "第一幕");
});

test("buildWorkflowDsl：无法反推（无 stepId）的节点被跳过，不虚构步骤", () => {
  const nodes = [node("plain-1", CanvasNodeType.Image, "手拉的图")];
  assert.deepEqual(buildWorkflowDsl(nodes, []), []);
});

// ─────────────────────────── ② 版本索引

test("buildNodeVersionIndex：按 nodeId 分组、升序、只留 version/createdAt/reason/title（不带 metadata）", () => {
  const versions: CanvasNodeVersion[] = [
    { version: 2, nodeId: "n1", createdAt: "2026-10-03T01:00:00.000Z", reason: "generated", title: "第二版", metadata: { prompt: "big" } },
    { version: 1, nodeId: "n1", createdAt: "2026-10-03T00:00:00.000Z", reason: "created", title: "第一版", metadata: { prompt: "small" } },
    { version: 1, nodeId: "n2", createdAt: "2026-10-03T00:00:00.000Z", reason: "created", title: "另一格", metadata: {} },
  ];
  const idx = buildNodeVersionIndex([node("n1", CanvasNodeType.Image, "当前标题")], versions);
  assert.equal(idx.length, 2);
  const n1 = idx.find((e) => e.node_id === "n1");
  assert.ok(n1);
  assert.deepEqual(n1.versions.map((v) => v.version), [1, 2]);
  assert.equal(n1.title, "当前标题", "标题取当前节点标题");
  assert.equal(JSON.stringify(n1).includes("metadata"), false, "版本索引不带 metadata");
});

// ─────────────────────────── ③ 快照载荷

test("buildAgentCanvasSnapshot：带 dsl + node_versions，且节点仍走压缩白名单", () => {
  const { nodes, connections } = compiledGraph();
  const snap = buildAgentCanvasSnapshot({
    nodes,
    connections,
    selectedNodeIds: [],
    viewport: { x: 0, y: 0, k: 1 },
    nodeVersions: [
      { version: 1, nodeId: nodes[0].id, createdAt: "2026-10-03T00:00:00.000Z", reason: "created", title: "v1", metadata: {} },
    ],
  });
  assert.ok(Array.isArray(snap.dsl), "快照应带 dsl");
  assert.equal((snap.dsl as unknown[]).length, 1);
  assert.ok(Array.isArray(snap.node_versions), "快照应带 node_versions");
  assert.equal((snap.node_versions as unknown[]).length, 1);
  assert.equal((snap.nodes as CanvasNode[]).length, 2);
});

test("buildAgentCanvasSnapshot：超预算时先丢 dsl、再丢 node_versions，既有 nodes 不动", () => {
  const { nodes, connections } = compiledGraph();
  // character_cards 的 prompt 不截断（见 canvas-agent-snapshot 的映射），用一张巨卡把载荷顶过预算。
  const hugeCard = {
    id: "card-huge",
    kind: "character" as const,
    name: "巨卡",
    prompt: "x".repeat(600_000),
    references: [],
  };
  const snap = buildAgentCanvasSnapshot({
    nodes,
    connections,
    selectedNodeIds: [],
    viewport: { x: 0, y: 0, k: 1 },
    characterCards: [hugeCard as never],
    nodeVersions: [
      { version: 1, nodeId: nodes[0].id, createdAt: "2026-10-03T00:00:00.000Z", reason: "created", title: "v1", metadata: {} },
    ],
  });
  assert.equal(snap.dsl, undefined, "超预算先丢 dsl");
  assert.equal(snap.node_versions, undefined, "再超预算丢 node_versions");
  assert.equal((snap.nodes as CanvasNode[]).length, 2, "节点永不受影响");
});
