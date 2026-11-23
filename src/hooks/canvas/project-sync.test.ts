// S10b — 画布人手改动回写工程图（设计文档 §3.4「人手改动回写」；§10 S10b）。
//
// 断点与判准（独立期望，不用源码字串）：
//   ① 工程桥五键必须在**两处**白名单都放行：还原端 `toNodeMetadata` 与上行端
//      `compactMetadataForAgent`（任一漏放＝重载后卡片脱离工程图，症状是「完全没反应」，
//      同 2026-09-24 emitsEntity 事故）。
//   ② 用户改 prompt/model/size、锁定、删除 → 以**公开补丁路由**发 Actor=user 补丁；
//      引擎/代理来源（`event`/`agent_ops`）零回写（防回环）。
//   ③ S10a 缺口①：工程图里没有的卡要收敛移除，orphaned 卡标 stale；工程 404 时按
//      「问不到」处理，绝不当成「全删」。
//   ④ S10a 缺口②：进程重启重发 created 时保留画布上已有的人手位置/尺寸。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProjectSync,
  planProjectConvergence,
  preserveProjectCanvasPlacement,
  projectNodeIdOf,
  projectPatchPath,
  replaceOutputOp,
  userPatchOpsForAction,
  type ProjectNodeProbe,
  type ProjectPatchOp,
  type ProjectSyncTransport,
} from "@/hooks/canvas/project-sync";
import { compactMetadataForAgent } from "@/hooks/canvas/canvas-chat-types";
import type { CanvasAction } from "@/hooks/canvas/canvas-reducer-adapter";
import { toNodeMetadata } from "@/lib/canvas/layout";
import { AGENT_METADATA_FIELD_KEYS, DURABLE_METADATA_FIELD_KEYS } from "@/lib/canvas/node-metadata-fields";
import { CanvasNodeType, type CanvasNode, type CanvasNodeMetadata } from "@/lib/canvas/types";

// ─────────────────────────── 夹具

function projectCanvasCard(overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: "wf-aaaaaaaaaaaaaaaa",
    type: CanvasNodeType.Image,
    title: "首帧",
    position: { x: 120, y: 240 },
    width: 300,
    height: 220,
    moved: true,
    metadata: {
      project_node_id: "keyframe_a",
      project_sig: "9f2c1e4a",
      project_pinned: false,
      project_stale: false,
      project_reused: false,
      prompt: "雨夜码头，中景",
      model: "seedance-image",
      size: "1024x1024",
    } as unknown as CanvasNodeMetadata,
    ...overrides,
  };
}

function legacyCard(): CanvasNode {
  return { id: "wf-legacy", type: CanvasNodeType.Text, title: "旧卡", position: { x: 0, y: 0 }, width: 240, height: 160 };
}

function fakeTransport() {
  const patchCalls: { sessionId: string; ops: ProjectPatchOp[]; opts?: { baseVersion?: number } }[] = [];
  const probes: string[] = [];
  let probeResult: ProjectNodeProbe = { projectExists: true, present: true, status: "done" };
  const transport: ProjectSyncTransport = {
    async patch(sessionId, ops, opts) {
      patchCalls.push({ sessionId, ops, opts });
      return { ok: true, version: 7, applied: ops.length };
    },
    async probeNode(_sessionId, projectNodeId) {
      probes.push(projectNodeId);
      return probeResult;
    },
  };
  return {
    transport,
    patchCalls,
    probes,
    setProbe(next: ProjectNodeProbe) {
      probeResult = next;
    },
  };
}

// ─────────────────────────── ① 三处白名单：五键重载存活

test("工程桥五键：还原端＋上行端双白名单均放行，重载后原值存活（含 false 与空签名）", () => {
  for (const key of ["project_node_id", "project_sig", "project_pinned", "project_stale", "project_reused"]) {
    assert.ok(DURABLE_METADATA_FIELD_KEYS.includes(key), `${key} 不在还原端白名单（重载后静默消失）`);
    assert.ok(AGENT_METADATA_FIELD_KEYS.includes(key), `${key} 不在上行端白名单（回旧会话还原后静默消失）`);
  }

  // 真往复：真上行压缩 → 真还原端清洗。空签名与 false 是「有语义的假值」，最容易踩 truthy 剥键。
  const bag = {
    project_node_id: "keyframe_a",
    project_sig: "",
    project_pinned: false,
    project_stale: true,
    project_reused: false,
  } as unknown as CanvasNodeMetadata;
  const restored = toNodeMetadata(compactMetadataForAgent(bag)) as Record<string, unknown>;
  assert.deepEqual(restored, {
    project_node_id: "keyframe_a",
    project_sig: "",
    project_pinned: false,
    project_stale: true,
    project_reused: false,
  });
});

// ─────────────────────────── ② 用户动作 → Actor=user 补丁

test("用户改 prompt/model/size：一次补丁、三个 set op，走公开代理路径且请求体不带 actor", async () => {
  const fake = fakeTransport();
  const sync = createProjectSync({ getSessionId: () => "sess-1", transport: fake.transport });
  const card = projectCanvasCard();

  const ops = sync.noteUserAction(
    { type: "patch_metadata", nodeId: card.id, patch: { prompt: "雨夜码头，特写", model: "m2", size: "768x768" } },
    [card],
  );
  assert.deepEqual(ops, [
    { op: "set", node: "keyframe_a", path: "params.prompt", value: "雨夜码头，特写" },
    { op: "set", node: "keyframe_a", path: "params.model", value: "m2" },
    { op: "set", node: "keyframe_a", path: "params.size", value: "768x768" },
  ]);
  assert.equal(fake.patchCalls.length, 1, "一次用户改动只能发一次补丁");
  assert.equal(fake.patchCalls[0].sessionId, "sess-1");
  assert.deepEqual(fake.patchCalls[0].ops, ops);
  // Actor 由网关强制 user：请求体里出现 actor 栏位就说明前端在自报身份（S9 明文禁止）。
  assert.equal(JSON.stringify(fake.patchCalls[0]).includes('"actor"'), false);
  assert.equal(projectPatchPath("sess-1"), "/api/agent/sessions/sess-1/project/patch", "必须走 S9 公开补丁路由的站点代理族");
});

test("锁定/解锁映射成 lock(fields:*) / unlock；非工程卡与引擎状态键不回写", () => {
  const card = projectCanvasCard();
  assert.deepEqual(userPatchOpsForAction({ type: "patch_metadata", nodeId: card.id, patch: { locked: true } }, [card]), [
    { op: "lock", node: "keyframe_a", fields: "*" },
  ]);
  assert.deepEqual(userPatchOpsForAction({ type: "patch_metadata", nodeId: card.id, patch: { locked: false } }, [card]), [
    { op: "unlock", node: "keyframe_a" },
  ]);
  // 引擎回灌的 status/content 不是人手决策，不得回写（否则每帧生成结果都改工程图）。
  assert.deepEqual(userPatchOpsForAction({ type: "patch_metadata", nodeId: card.id, patch: { status: "success", content: "https://x/y.png" } }, [card]), []);
  // 生成流程的自家补丁（带 status）写的是角色卡注入后的**合成**提示词：回写会造成双注入。
  assert.deepEqual(
    userPatchOpsForAction(
      { type: "patch_metadata", nodeId: card.id, patch: { status: "loading", prompt: "角色卡注入前缀＋用户原句", model: "m3", size: "512x512" } },
      [card],
    ),
    [],
  );
  // 非工程卡（旧工作流卡）没有工程身份，零回写。
  const legacy = legacyCard();
  assert.deepEqual(userPatchOpsForAction({ type: "patch_metadata", nodeId: legacy.id, patch: { prompt: "改" } }, [legacy]), []);
});

test("删除：单删与多删都转 remove_node，非工程卡被跳过", () => {
  const card = projectCanvasCard();
  const legacy = legacyCard();
  assert.deepEqual(userPatchOpsForAction({ type: "remove", nodeId: card.id }, [card, legacy]), [
    { op: "remove_node", node: "keyframe_a" },
  ]);
  assert.deepEqual(userPatchOpsForAction({ type: "delete_many", nodeIds: [legacy.id, card.id] }, [card, legacy]), [
    { op: "remove_node", node: "keyframe_a" },
  ]);
});

test("回环抑制：工程桥 created/updated 帧与 agent_ops 一律零回写", () => {
  const fake = fakeTransport();
  const sync = createProjectSync({ getSessionId: () => "sess-1", transport: fake.transport });
  const card = projectCanvasCard();

  const created: CanvasAction = {
    type: "event",
    event: {
      event_id: 1,
      name: "canvas.node.created",
      data: { unit_id: "p_sess-1", node: card },
    },
  };
  const updated: CanvasAction = {
    type: "event",
    event: {
      event_id: 2,
      name: "canvas.node.updated",
      data: { unit_id: "p_sess-1", node_id: card.id, patch: { prompt: "引擎回灌" } },
    },
  };
  const agentOps: CanvasAction = {
    type: "agent_ops",
    ops: [{ type: "update_node", node_id: card.id, patch: { prompt: "模型改的" } }] as never,
  };

  for (const action of [created, updated, agentOps]) {
    assert.deepEqual(sync.noteUserAction(action, [card]), [], `${action.type} 不是人手动作，必须零回写`);
  }
  assert.equal(fake.patchCalls.length, 0, "引擎/代理事件不得触发任何补丁请求（否则画布→图→画布回环）");
});

test("替换产物：显式入口产出 replace_output（只收内容寻址 artifactId，不猜）", () => {
  assert.deepEqual(replaceOutputOp("keyframe_a", "art_0123456789abcdef"), {
    op: "replace_output",
    node: "keyframe_a",
    artifactId: "art_0123456789abcdef",
  });
  assert.equal(replaceOutputOp("keyframe_a", ""), null);
});

// ─────────────────────────── ③ 删除收敛（缺口①）

const probesOf = (entries: [string, ProjectNodeProbe][]): Map<string, ProjectNodeProbe> => new Map(entries);

test("删除收敛：图里没有的工程卡移除；orphaned 卡标 stale（已标的只有一次）；问不到的不动", () => {
  const gone = projectCanvasCard({ id: "wf-gone", metadata: { project_node_id: "clip_b" } as unknown as CanvasNodeMetadata });
  const orphan = projectCanvasCard({ id: "wf-orphan", metadata: { project_node_id: "clip_c", project_stale: false } as unknown as CanvasNodeMetadata });
  const unknown = projectCanvasCard({ id: "wf-unknown", metadata: { project_node_id: "clip_d" } as unknown as CanvasNodeMetadata });
  const legacy = legacyCard();

  const plan = planProjectConvergence(
    [projectCanvasCard(), gone, orphan, unknown, legacy],
    probesOf([
      ["keyframe_a", { projectExists: true, present: true, status: "done" }],
      ["clip_b", { projectExists: true, present: false }],
      ["clip_c", { projectExists: true, present: true, status: "orphaned" }],
    ]),
  );
  assert.deepEqual(plan.removeCanvasNodeIds, ["wf-gone"]);
  assert.deepEqual(plan.markStale, [{ canvasNodeId: "wf-orphan", projectNodeId: "clip_c" }]);

  // 工程 404（projectExists=false）＝问不到，不得当删除。
  const blind = planProjectConvergence([gone], probesOf([["clip_b", { projectExists: false, present: false }]]));
  assert.deepEqual(blind.removeCanvasNodeIds, []);
});

test("reconcile 用公开只读 node 视图逐卡核对，只删真缺失的卡", async () => {
  const fake = fakeTransport();
  fake.setProbe({ projectExists: true, present: false });
  const sync = createProjectSync({ getSessionId: () => "sess-1", transport: fake.transport });
  const plan = await sync.reconcile([projectCanvasCard()]);
  assert.deepEqual(plan.removeCanvasNodeIds, ["wf-aaaaaaaaaaaaaaaa"]);
  assert.deepEqual(fake.probes, ["keyframe_a"]);
});

// ─────────────────────────── ④ 重同步保留位置/尺寸（缺口②）

test("重同步：created 重发时保留人手位置/尺寸/moved；非工程卡与更新帧原样不动", () => {
  const existing = projectCanvasCard();
  const incoming = projectCanvasCard({ position: { x: 0, y: 0 }, width: 999, height: 888, moved: false });
  const action: CanvasAction = {
    type: "event",
    event: { event_id: 3, name: "canvas.node.created", data: { unit_id: "p_sess-1", node: incoming } },
  };

  const merged = preserveProjectCanvasPlacement(action, [existing]);
  assert.notEqual(merged, action, "命中重发必须回新 action（不原地改事件）");
  assert.equal(merged.type, "event");
  if (merged.type === "event" && merged.event.name === "canvas.node.created") {
    assert.deepEqual(merged.event.data.node.position, { x: 120, y: 240 }, "用户拖过的位置不能被泳道坐标覆盖");
    assert.equal(merged.event.data.node.width, 300);
    assert.equal(merged.event.data.node.height, 220);
    assert.equal(merged.event.data.node.moved, true);
  }
  // 画布上没有这张卡（首建）→ 原样。
  assert.equal(preserveProjectCanvasPlacement(action, []), action);
  // 非工程卡的旧路径行为逐字不变。
  const legacyNode = legacyCard();
  const legacyAction: CanvasAction = {
    type: "event",
    event: { event_id: 4, name: "canvas.node.created", data: { unit_id: "u", node: { ...legacyNode, width: 999 } } },
  };
  assert.equal(preserveProjectCanvasPlacement(legacyAction, [legacyNode]), legacyAction);
});

// ─────────────────────────── ⑤ 无会话 / 无工程卡时不发请求

test("没有会话或没有工程卡：零请求（旧画布行为不变）", async () => {
  const fake = fakeTransport();
  const noSession = createProjectSync({ getSessionId: () => null, transport: fake.transport });
  const card = projectCanvasCard();
  assert.deepEqual(noSession.noteUserAction({ type: "patch_metadata", nodeId: card.id, patch: { prompt: "x" } }, [card]), [
    { op: "set", node: "keyframe_a", path: "params.prompt", value: "x" },
  ]);
  assert.equal(fake.patchCalls.length, 0, "无会话不得发请求");

  const withSession = createProjectSync({ getSessionId: () => "sess-1", transport: fake.transport });
  assert.deepEqual(await withSession.reconcile([legacyCard()]), { removeCanvasNodeIds: [], markStale: [] });
  assert.deepEqual(fake.probes, []);
  assert.equal(projectNodeIdOf(legacyCard()), undefined);
});
