// 节点版本历史＋回退（2026-09-27）：真行为断言（不是源码字串断言）。
//
// 三条核心行为：
//   1. 软删 → 列表不含 → restore → 回来（reducer 与持久化往返各验一次）
//   2. 生成 3 版 → revert 到第 2 版 → 内容逐栏等于第 2 版
//   3. 版本上限裁剪后仍可取最新 N 版
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANVAS_INITIAL_STATE,
  reduceCanvasEvent,
  restoreCanvasNodes,
  revertCanvasNodeToVersion,
  softDeleteCanvasNodes,
  type CanvasReducerState,
} from "./reducer";
import { fromCanvasProject, toCanvasProject } from "./layout";
import { canvasReducer } from "@/hooks/canvas/canvas-reducer-adapter";
import {
  MAX_NODE_VERSIONS_PER_NODE,
  appendNodeVersion,
  countNodeVersions,
  createNodeVersion,
  diffNodeVersions,
  isNodeContentChange,
  listNodeVersions,
  normalizeNodeVersions,
  previousNodeVersion,
  selectNodeVersion,
} from "./node-versions";
import { __resetCanvasStoreForTests, mutateCanvasProject, readCanvasProject, saveCanvasProject } from "./project-store";
import { CanvasNodeType, type CanvasNode, type CanvasNodeVersion, type CanvasSseEvent } from "./types";

function mkNode(id: string, content: string, status: "idle" | "success" = "idle"): CanvasNode {
  return {
    id,
    type: CanvasNodeType.Text,
    title: id,
    position: { x: 40, y: 40 },
    width: 340,
    height: 240,
    metadata: { content, status },
  };
}

function created(node: CanvasNode, unitId = "cu_1"): CanvasSseEvent {
  return { name: "canvas.node.created", data: { unit_id: unitId, node } };
}

function updated(nodeId: string, patch: Record<string, unknown>, unitId = "cu_1"): CanvasSseEvent {
  return { name: "canvas.node.updated", data: { unit_id: unitId, node_id: nodeId, patch } };
}

function connected(id: string, from: string, to: string, unitId = "cu_1"): CanvasSseEvent {
  return { name: "canvas.node.connected", data: { unit_id: unitId, connection: { id, fromNodeId: from, toNodeId: to } } };
}

// ─────────────────────────────────────────── 纯函式：内容变更判定

test("isNodeContentChange：进度抖动不落版；success/content/prompt 各归类", () => {
  const base = mkNode("n", "c0");
  // 纯进度/花费/任务 id 变化 → null（不该被版本历史灌满）
  assert.equal(isNodeContentChange(base, { ...base, metadata: { ...base.metadata, progress: 50 } }), null);
  assert.equal(isNodeContentChange(base, { ...base, metadata: { ...base.metadata, cost_coins: 3 } }), null);
  assert.equal(isNodeContentChange(base, { ...base, metadata: { ...base.metadata, status: "loading" } }), null);
  // 生成完成
  assert.equal(
    isNodeContentChange(base, { ...base, metadata: { ...base.metadata, status: "success" } }),
    "generated",
  );
  // 内容 / 标题 / prompt
  assert.equal(isNodeContentChange(base, { ...base, metadata: { ...base.metadata, content: "c1" } }), "edited");
  assert.equal(isNodeContentChange(base, { ...base, title: "新标题" }), "edited");
  assert.equal(isNodeContentChange(base, { ...base, metadata: { ...base.metadata, prompt: "p" } }), "edited");
  // 其余 metadata
  assert.equal(isNodeContentChange(base, { ...base, metadata: { ...base.metadata, model: "m" } }), "metadata");
});

test("appendNodeVersion：逐节点裁剪到上限，保留最新 N 版", () => {
  let versions: CanvasNodeVersion[] = [];
  for (let i = 1; i <= 25; i++) {
    versions = appendNodeVersion(versions, {
      version: i,
      nodeId: "n",
      createdAt: `2026-09-27T00:00:${String(i).padStart(2, "0")}.000Z`,
      reason: "edited",
      title: "n",
      metadata: { content: `c${i}` },
    });
  }
  const kept = listNodeVersions(versions, "n");
  assert.equal(kept.length, MAX_NODE_VERSIONS_PER_NODE);
  assert.equal(kept[0].version, 6);
  assert.equal(kept[kept.length - 1].version, 25);
});

test("selectNodeVersion / previousNodeVersion / diffNodeVersions / normalizeNodeVersions", () => {
  const v1: CanvasNodeVersion = {
    version: 1,
    nodeId: "n",
    createdAt: "2026-09-27T00:00:01.000Z",
    reason: "created",
    title: "n",
    metadata: { content: "c1" },
  };
  const v2: CanvasNodeVersion = {
    version: 2,
    nodeId: "n",
    createdAt: "2026-09-27T00:00:02.000Z",
    reason: "edited",
    title: "n2",
    metadata: { content: "c2", prompt: "p" },
  };
  assert.equal(selectNodeVersion([v1, v2], "n")?.version, 2); // 省略版号＝最新
  assert.equal(selectNodeVersion([v1, v2], "n", 1)?.version, 1);
  assert.equal(selectNodeVersion([v1, v2], "n", 9), undefined);
  assert.equal(previousNodeVersion([v1, v2], "n")?.version, 1);
  assert.equal(previousNodeVersion([v1], "n"), undefined);
  assert.deepEqual(diffNodeVersions(v1, v2), { titleChanged: true, changedKeys: ["content", "prompt"] });

  // 清洗：非法项丢弃、同节点同版号去重、逐节点裁剪。
  const noisy = normalizeNodeVersions([
    v1,
    v1,
    { version: 0, nodeId: "n", title: "x", reason: "edited" },
    { version: 3, nodeId: "n", title: "x", reason: "bogus" },
    { ...v2, metadata: { content: "c2" } },
  ]);
  assert.deepEqual(noisy?.map((v) => v.version), [1, 2]);
});

// ─────────────────────────────────────────── 真行为 1：软删 → 不含 → restore → 回来

test("软删：canvas.node.deleted 后列表不含（连线断），restore 后回来且 deletedAt 清除", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, created(mkNode("a", "x")));
  s = reduceCanvasEvent(s, created(mkNode("b", "y")));
  s = reduceCanvasEvent(s, connected("c1", "a", "b"));

  s = reduceCanvasEvent(s, { name: "canvas.node.deleted", data: { unit_id: "cu_1", node_id: "a" } });
  // 呼叫端语义不变：可见列表不含、连线断开。
  assert.equal(s.nodes.some((n) => n.id === "a"), false, "软删后 nodes 不应含该节点");
  assert.equal(s.connections.length, 0, "软删后关联连线应断开");
  // 差别：资料还在垃圾桶，带 deletedAt。
  assert.equal(s.deletedNodes?.length, 1);
  assert.equal(s.deletedNodes?.[0].id, "a");
  assert.equal(typeof s.deletedNodes?.[0].deletedAt, "string");

  s = restoreCanvasNodes(s, ["a"]);
  assert.equal(s.nodes.some((n) => n.id === "a"), true, "restore 后节点应回到 nodes");
  assert.equal(s.deletedNodes?.length, 0, "restore 后垃圾桶应清空该节点");
  assert.equal(s.nodes.find((n) => n.id === "a")?.deletedAt, undefined, "restore 后 deletedAt 应清除");
});

test("软删持久化往返：toCanvasProject 带 deletedAt/nodeVersions，fromCanvasProject 拆回垃圾桶且不还原悬空连线", () => {
  let s: CanvasReducerState = reduceCanvasEvent(CANVAS_INITIAL_STATE, created(mkNode("a", "x")));
  s = reduceCanvasEvent(s, updated("a", { content: "x2" }));
  s = softDeleteCanvasNodes(s, ["a"]);
  assert.equal(s.nodes.length, 0);

  const project = toCanvasProject({ id: "p1", title: "P" }, s, { x: 0, y: 0, k: 1 }, "dots");
  assert.equal(project.nodes.length, 1, "软删节点必须落盘（否则无法 restore）");
  assert.equal(typeof project.nodes[0].deletedAt, "string");
  assert.equal(project.nodeVersions?.length, 2, "版本历史必须落盘");

  const restoredState = fromCanvasProject(project);
  assert.equal(restoredState.nodes.length, 0, "读回时软删节点不进可见 nodes");
  assert.equal(restoredState.deletedNodes?.length, 1);
  assert.equal(restoredState.nodeVersions?.length, 2);

  const back = restoreCanvasNodes(restoredState, ["a"]);
  assert.equal(back.nodes.length, 1);
  assert.equal(back.nodes[0].id, "a");
});

// ─────────────────────────────────────────── 真行为 2：3 版 → revert 到第 2 版

test("生成 3 版 → revert 到第 2 版 → 内容逐栏等于第 2 版（且回退本身留第 4 版）", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, created(mkNode("n", "c0"))); // v1: created
  s = reduceCanvasEvent(s, updated("n", { content: "c1" })); // v2: edited
  s = reduceCanvasEvent(s, updated("n", { content: "c2", status: "success" })); // v3: generated

  const versions = s.nodeVersions ?? [];
  assert.equal(countNodeVersions(versions, "n"), 3);
  const v2 = selectNodeVersion(versions, "n", 2);
  assert.ok(v2, "第 2 版必须存在");
  assert.equal(s.nodes.find((n) => n.id === "n")?.metadata?.content, "c2");

  s = revertCanvasNodeToVersion(s, "n", 2);
  const reverted = s.nodes.find((n) => n.id === "n");
  assert.ok(reverted);
  // 逐栏等于第 2 版（title + metadata 全等）
  assert.equal(reverted.title, v2!.title);
  assert.deepEqual(reverted.metadata, v2!.metadata);
  assert.equal(reverted.metadata?.content, "c1");
  // 回退留痕：第 4 版 reason=revert，内容等于第 2 版
  const after = s.nodeVersions ?? [];
  assert.equal(countNodeVersions(after, "n"), 4);
  const v4 = selectNodeVersion(after, "n", 4);
  assert.equal(v4?.reason, "revert");
  assert.equal(v4?.metadata.content, "c1");
});

test("revert 省略版号＝回上一版；没有更早版本时原样返回", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, created(mkNode("n", "c0")));
  s = reduceCanvasEvent(s, updated("n", { content: "c1" }));
  const before = s.nodeVersions?.length;
  s = revertCanvasNodeToVersion(s, "n"); // 最新 v2 的上一版 = v1
  assert.equal(s.nodes.find((n) => n.id === "n")?.metadata?.content, "c0");
  assert.equal(s.nodeVersions?.length, (before ?? 0) + 1);

  // 对只有 1 版的节点回退 → 没有目标，state 原样（不制造空版本）
  const single = reduceCanvasEvent(CANVAS_INITIAL_STATE, created(mkNode("q", "only")));
  const same = revertCanvasNodeToVersion(single, "q");
  assert.equal(same, single);
});

// ─────────────────────────────────────────── 真行为 3：上限裁剪后仍可取最新 N 版

test("版本上限裁剪后仍可取最新 N 版（reducer 落版路径）", () => {
  let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, created(mkNode("n", "c0")));
  for (let i = 1; i <= 25; i++) s = reduceCanvasEvent(s, updated("n", { content: `c${i}` }));
  const kept = listNodeVersions(s.nodeVersions ?? [], "n");
  assert.equal(kept.length, MAX_NODE_VERSIONS_PER_NODE);
  // 最新版是第 26 版（1 created + 25 edited）
  assert.equal(kept[kept.length - 1].version, 26);
  assert.equal(kept[kept.length - 1].metadata.content, "c25");
  // 可取最新 N 版里最旧的一版，内容正确
  assert.equal(kept[0].version, 7);
  assert.equal(kept[0].metadata.content, "c6");
  // 被裁掉的旧版确实取不到
  assert.equal(selectNodeVersion(s.nodeVersions ?? [], "n", 1), undefined);
});

// ─────────────────────────────────────────── adapter 整合：delete_many/restore_nodes/revert_node

test("adapter：delete_many 走软删、restore_nodes 还原、revert_node 回退", () => {
  let s: CanvasReducerState = { units: [], nodes: [mkNode("a", "v0"), mkNode("b", "v0")], connections: [] };
  s = canvasReducer(s, { type: "add_nodes", nodes: [mkNode("a", "v0")] }); // 触发 created 版
  s = canvasReducer(s, { type: "patch_metadata", nodeId: "a", patch: { content: "v1" } });
  s = canvasReducer(s, { type: "rename", nodeId: "a", title: "A2" });

  s = canvasReducer(s, { type: "delete_many", nodeIds: ["a"] });
  assert.equal(s.nodes.some((n) => n.id === "a"), false);
  assert.equal(s.deletedNodes?.length, 1);

  s = canvasReducer(s, { type: "restore_nodes", nodeIds: ["a"] });
  assert.equal(s.nodes.some((n) => n.id === "a"), true);
  assert.equal(s.deletedNodes?.length, 0);

  // 回退到第 1 版：内容恢复成 v0、标题恢复成 a
  s = canvasReducer(s, { type: "revert_node", nodeId: "a", version: 1 });
  const node = s.nodes.find((n) => n.id === "a");
  assert.equal(node?.metadata?.content, "v0");
  assert.equal(node?.title, "a");
});

// ─────────────────────────────────────────── 储存层：mutateCanvasProject 真读-改-写

test("store：mutateCanvasProject 在既有专案上回退版本（真落盘 + 真读回）", async () => {
  __resetCanvasStoreForTests();
  const userId = 987654;
  const state = toCanvasProject(
    { id: "proj-1", title: "P" },
    (() => {
      let s = reduceCanvasEvent(CANVAS_INITIAL_STATE, created(mkNode("n", "c0")));
      s = reduceCanvasEvent(s, updated("n", { content: "c1" }));
      s = reduceCanvasEvent(s, updated("n", { content: "c2" }));
      return s;
    })(),
    { x: 0, y: 0, k: 1 },
    "dots",
  );
  await saveCanvasProject(userId, state);

  const saved = await readCanvasProject(userId, "proj-1");
  assert.ok(saved, "专案必须被 store 读回");
  assert.equal(saved!.nodeVersions?.length, 3);

  const target = selectNodeVersion(saved!.nodeVersions ?? [], "n", 2)!;
  const mutated = await mutateCanvasProject(userId, "proj-1", (project) => {
    const node = project.nodes.find((n) => n.id === "n");
    if (!node) return null;
    const reverted = { ...node, title: target.title, metadata: target.metadata };
    const recorded = createNodeVersion(reverted, "revert", project.nodeVersions ?? []);
    return {
      ...project,
      nodes: project.nodes.map((n) => (n.id === "n" ? reverted : n)),
      nodeVersions: appendNodeVersion(project.nodeVersions ?? [], recorded),
    };
  });
  assert.ok(mutated, "mutate 必须成功");
  const reread = await readCanvasProject(userId, "proj-1");
  assert.deepEqual(reread!.nodes.find((n) => n.id === "n")!.metadata, target.metadata);
  assert.equal(reread!.nodeVersions?.length, 4);

  // 不存在的专案 → null（不捏造专案）
  assert.equal(await mutateCanvasProject(userId, "nope", () => null), null);
  __resetCanvasStoreForTests();
});
