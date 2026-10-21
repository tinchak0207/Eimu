// workflow-dsl 测试：schema 校验、确定性节点 id、增量 op 发射、round-trip 幂等、教学式报错。
// 风格对齐 src/lib/canvas/layout.test.ts（node:test + assert/strict）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CanvasNodeType, type CanvasAgentOp } from "../canvas/types";
import { HARNESS_TOOL_IDS } from "../harness-tool-registry";
import { validateWorkflowDsl, type WorkflowDslSource } from "./schema";
import { compileWorkflow, workflowNodeId, type WorkflowCompileInput, type WorkflowNodeMetadata } from "./compile";
import { decompileWorkflow } from "./decompile";

// ─────────────────────────── helpers

const EMPTY: WorkflowCompileInput = { nodes: [], connections: [] };

/** 三步链：1 text 步 + 2 image 步（带 needs / tool / size / count / gate / meta）。 */
const SOURCE: WorkflowDslSource = {
  workflow: "demo_wf",
  title: "示范工作流",
  steps: [
    { id: "brief", title: "文本简报", kind: "text", prompt: "写一段柴犬画家的简介" },
    {
      id: "shot_a",
      title: "镜头A",
      kind: "image",
      prompt: "柴犬画家第一幕",
      needs: ["brief"],
      tool: "image_generate",
      size: "1024x1024",
      count: 2,
      meta: { custom_tag: "keep_me" },
    },
    { id: "shot_b", title: "镜头B", kind: "image", prompt: "柴犬画家第二幕", needs: ["brief"], gate: true },
  ],
};

function addOps(ops: CanvasAgentOp[]) {
  return ops.filter((op): op is Extract<CanvasAgentOp, { type: "add_node" }> => op.type === "add_node");
}

/** 手工套 ops 成图（语义对齐 canvas-reducer-adapter：update 浅合并 metadata、connect 按 from/to 去重）。 */
function applyOps(current: WorkflowCompileInput, ops: CanvasAgentOp[]): WorkflowCompileInput {
  let nodes = [...current.nodes];
  const connections = [...current.connections];
  for (const op of ops) {
    if (op.type === "add_node") {
      nodes.push({
        id: op.node.id,
        type: op.node.type as CanvasNodeType,
        title: op.node.title ?? "",
        position: { x: 0, y: 0 },
        width: 340,
        height: 240,
        metadata: { ...(op.node.metadata ?? {}) },
      });
    } else if (op.type === "update_node") {
      nodes = nodes.map((n) =>
        n.id === op.id ? { ...n, title: op.patch.title ?? n.title, metadata: { ...n.metadata, ...op.patch.metadata } } : n,
      );
    } else if (op.type === "connect_nodes") {
      for (const c of op.connections) {
        if (!connections.some((x) => x.fromNodeId === c.fromNodeId && x.toNodeId === c.toNodeId)) {
          connections.push({ id: `conn-${c.fromNodeId}-${c.toNodeId}`, fromNodeId: c.fromNodeId, toNodeId: c.toNodeId });
        }
      }
    }
  }
  return { nodes, connections };
}

/** 找某步骤的 add_node op。 */
function addOpOfStep(ops: CanvasAgentOp[], stepId: string) {
  const op = addOps(ops).find((o) => (o.node.metadata as WorkflowNodeMetadata | undefined)?.stepId === stepId);
  assert.ok(op, `应有步骤 ${stepId} 的 add_node`);
  return op;
}

// ─────────────────────────── ① 3 步链 happy path + 确定性 id

test("compileWorkflow 三步链：3 个 add_node 无座标、1 条 connect_nodes、连跑两次 id 全等", () => {
  const r1 = compileWorkflow(SOURCE, EMPTY);
  assert.equal(r1.ok, true);
  if (!r1.ok) throw new Error("unreachable");
  assert.deepEqual(r1.summary, { added: 3, updated: 0, connected: 2, warnings: [] });

  const adds = addOps(r1.ops);
  assert.equal(adds.length, 3);
  assert.equal(r1.ops.length, 4, "3 个 add_node + 1 条 connect_nodes");
  assert.equal(r1.ops[3].type, "connect_nodes", "connect_nodes 在全部 add_node 之后");

  // 一律不带 position/width/height/moved（座标权交 reducer nextPosition）
  for (const op of adds) {
    const node = op.node;
    for (const banned of ["position", "width", "height", "moved"]) {
      assert.equal(banned in node, false, `add_node.node 禁带 ${banned}`);
    }
    const md = node.metadata as WorkflowNodeMetadata;
    assert.equal(md.workflow_ns, "demo_wf");
    assert.equal(md.workflow_id, "demo_wf");
    assert.equal(md.status, "idle");
    assert.equal(typeof md.stepIndex, "number");
  }

  const brief = addOpOfStep(r1.ops, "brief");
  assert.equal((brief.node.metadata as WorkflowNodeMetadata).kind, undefined, "text 步不设 image/video kind");
  assert.equal((brief.node.metadata as WorkflowNodeMetadata).content, "写一段柴犬画家的简介", "text 步 content=prompt");
  assert.equal(brief.node.type, "text");
  assert.equal((brief.node.metadata as WorkflowNodeMetadata).stepIndex, 1);

  const shotA = addOpOfStep(r1.ops, "shot_a");
  assert.equal(shotA.node.type, "image");
  const mdA = shotA.node.metadata as WorkflowNodeMetadata;
  assert.equal(mdA.kind, "image");
  assert.equal(mdA.toolId, "image_generate");
  assert.equal(mdA.size, "1024x1024");
  assert.equal(mdA.count, 2);
  assert.equal(mdA.custom_tag, "keep_me", "meta 透传");
  assert.equal(mdA.stepIndex, 2);

  const shotB = addOpOfStep(r1.ops, "shot_b");
  assert.equal((shotB.node.metadata as WorkflowNodeMetadata).gate, true, "gate 步带 gate:true");
  assert.equal((shotB.node.metadata as WorkflowNodeMetadata).stepIndex, 3);

  // 连线：needs 边 dep→step，合并成一条 connect_nodes
  const connect = r1.ops[3];
  if (connect.type !== "connect_nodes") throw new Error("expected connect_nodes");
  const idOf = (stepId: string) => (addOpOfStep(r1.ops, stepId).node as { id: string }).id;
  assert.deepEqual(connect.connections, [
    { fromNodeId: idOf("brief"), toNodeId: idOf("shot_a") },
    { fromNodeId: idOf("brief"), toNodeId: idOf("shot_b") },
  ]);

  // 节点 id 确定性：wf- + 16 hex，同输入永远同 id
  const ids1 = adds.map((o) => o.node.id);
  for (const id of ids1) assert.match(id, /^wf-[0-9a-f]{16}$/);
  assert.equal(idOf("brief"), workflowNodeId("demo_wf", "brief"));
  const r2 = compileWorkflow(SOURCE, EMPTY);
  assert.ok(r2.ok);
  if (!r2.ok) throw new Error("unreachable");
  assert.deepEqual(addOps(r2.ops).map((o) => o.node.id), ids1, "连跑两次 id 全等");
});

// ─────────────────────────── ② 增量发射：已建图后再 compile → 全 update

test("compileWorkflow 增量：ops 套成图后再编译 → 全 update_node、零 add、零 connect", () => {
  const first = compileWorkflow(SOURCE, EMPTY);
  assert.ok(first.ok);
  if (!first.ok) throw new Error("unreachable");
  const current = applyOps(EMPTY, first.ops);

  const second = compileWorkflow(SOURCE, current);
  assert.ok(second.ok);
  if (!second.ok) throw new Error("unreachable");
  assert.equal(second.ops.length, 3);
  assert.ok(second.ops.every((op) => op.type === "update_node"), "全为 update_node");
  assert.deepEqual(second.summary, { added: 0, updated: 3, connected: 0, warnings: [] });

  const firstIds = addOps(first.ops).map((o) => o.node.id).sort();
  const secondIds = second.ops.map((o) => (o as Extract<CanvasAgentOp, { type: "update_node" }>).id).sort();
  assert.deepEqual(secondIds, firstIds, "update 打在原节点上，不二次建号");
});

// ─────────────────────────── ③ update patch 禁含 position/width/height/moved

test("compileWorkflow 尊重人拖位置：moved 节点的 update patch 无 position/width/height/moved", () => {
  const first = compileWorkflow(SOURCE, EMPTY);
  assert.ok(first.ok);
  if (!first.ok) throw new Error("unreachable");
  const current = applyOps(EMPTY, first.ops);
  const shotANodeId = addOpOfStep(first.ops, "shot_a").node.id;
  current.nodes = current.nodes.map((n) => (n.id === shotANodeId ? { ...n, moved: true, position: { x: 999, y: 0 } } : n));

  const again = compileWorkflow(SOURCE, current);
  assert.ok(again.ok);
  if (!again.ok) throw new Error("unreachable");
  const patch = again.ops.find((op) => op.type === "update_node" && op.id === shotANodeId);
  assert.ok(patch);
  if (patch.type !== "update_node") throw new Error("unreachable");
  for (const banned of ["position", "width", "height", "moved"]) {
    assert.equal(banned in patch.patch, false, `patch 禁含 ${banned}`);
  }
  assert.equal(patch.patch.title, "镜头A");
  assert.ok(patch.patch.metadata, "patch 带 metadata");
});

// ─────────────────────────── ④ 校验失败四连 + 教学式报错

test("compileWorkflow 校验失败四连：needs 未知/环/假 tool/坏 size → ok:false + 带修复提示", () => {
  const base = { workflow: "demo_wf", title: "示范" };

  // a. needs 引用不存在：message 列出档内现有步骤清单
  const unknownNeeds = compileWorkflow(
    { ...base, steps: [{ id: "a", title: "A" }, { id: "b", title: "B", needs: ["ghost"] }] },
    EMPTY,
  );
  assert.equal(unknownNeeds.ok, false);
  if (unknownNeeds.ok) throw new Error("unreachable");
  assert.equal(unknownNeeds.ops.length, 0);
  const needsErr = unknownNeeds.errors.find((e) => e.field === "needs");
  assert.ok(needsErr, "有 needs 错误");
  assert.equal(needsErr.step, "b");
  assert.ok(needsErr.message.includes("ghost"), "message 指出未知引用");
  assert.ok(needsErr.message.includes("本档现有步骤"), "message 带修复提示");
  assert.ok(needsErr.message.includes("a"), "message 列出现有步骤清单");

  // b. 环 a→b→a：列出环成员与破环建议
  const cycle = compileWorkflow(
    { ...base, steps: [{ id: "a", title: "A", needs: ["b"] }, { id: "b", title: "B", needs: ["a"] }] },
    EMPTY,
  );
  assert.equal(cycle.ok, false);
  if (cycle.ok) throw new Error("unreachable");
  assert.equal(cycle.ops.length, 0);
  const cycleErr = cycle.errors.find((e) => e.field === "needs");
  assert.ok(cycleErr, "有环错误");
  assert.ok(cycleErr.message.includes("a → b → a"), "message 列出环路");
  assert.ok(cycleErr.message.includes("循环依赖"), "message 点名循环依赖");
  assert.ok(cycleErr.message.includes("needs 移除"), "message 带破环建议");

  // c. 假 tool：附相近合法 id 建议
  const fakeTool = compileWorkflow({ ...base, steps: [{ id: "t", title: "T", tool: "not_a_tool" }] }, EMPTY);
  assert.equal(fakeTool.ok, false);
  if (fakeTool.ok) throw new Error("unreachable");
  assert.equal(fakeTool.ops.length, 0);
  const toolErr = fakeTool.errors.find((e) => e.field === "tool");
  assert.ok(toolErr, "有 tool 错误");
  assert.equal(toolErr.step, "t");
  assert.ok(toolErr.message.includes("not_a_tool"), "message 指出非法 id");
  assert.ok(toolErr.message.includes("image_generate"), "message 附相近合法 id 建议");

  // d. 坏 size：给正确格式示例
  const badSize = compileWorkflow({ ...base, steps: [{ id: "s", title: "S", size: "2048" }] }, EMPTY);
  assert.equal(badSize.ok, false);
  if (badSize.ok) throw new Error("unreachable");
  assert.equal(badSize.ops.length, 0);
  const sizeErr = badSize.errors.find((e) => e.field === "size");
  assert.ok(sizeErr, "有 size 错误");
  assert.equal(sizeErr.step, "s");
  assert.ok(sizeErr.message.includes("宽x高"), "message 给正确格式说明");
  assert.ok(sizeErr.message.includes("2048x2048"), "message 给格式示例");
});

// ─────────────────────────── ⑤ round-trip：建图 → decompile → 再 compile → 全 update、id 相等

test("round-trip 幂等：decompile 反推再编译 → 全 update_node、id 与首轮相等、零新增连线", () => {
  assert.deepEqual(decompileWorkflow({ nodes: [], connections: [] }), [], "空画布反推为空");

  const first = compileWorkflow(SOURCE, EMPTY);
  assert.ok(first.ok);
  if (!first.ok) throw new Error("unreachable");
  const current = applyOps(EMPTY, first.ops);

  const sources = decompileWorkflow(current);
  assert.equal(sources.length, 1, "一个 workflow 命名空间一份源码");
  const s0 = sources[0];
  assert.equal(s0.workflow, "demo_wf");
  assert.deepEqual(
    s0.steps.map((s) => s.id),
    ["brief", "shot_a", "shot_b"],
    "按 stepIndex 排序",
  );
  assert.equal(s0.steps[0].kind, "text");
  assert.deepEqual(s0.steps[1].needs, ["brief"], "needs 从组内连线反推");
  assert.equal(s0.steps[1].tool, "image_generate");
  assert.equal(s0.steps[1].size, "1024x1024");
  assert.equal(s0.steps[1].count, 2);
  // 运输键（8063be17）：反推器对每个步骤塞 meta._origin_node_id = 原节点 id，
  // 供 compile 收编第三路回写原节点；它不属于用户 meta，但反推结果里必须明确存在。
  const shotANodeId = addOpOfStep(first.ops, "shot_a").node.id;
  assert.deepEqual(
    s0.steps[1].meta,
    { custom_tag: "keep_me", _origin_node_id: shotANodeId },
    "meta 透传 = 白名单外剩余 + 运输键 _origin_node_id",
  );
  assert.equal(s0.steps[2].gate, true);
  assert.equal(s0.steps[2].prompt, "柴犬画家第二幕");

  const again = compileWorkflow(s0, current);
  assert.ok(again.ok);
  if (!again.ok) throw new Error("unreachable");
  assert.ok(again.ops.every((op) => op.type === "update_node"), "再编译全为 update_node");
  assert.deepEqual(again.summary, { added: 0, updated: 3, connected: 0, warnings: [] });
  const firstIds = addOps(first.ops).map((o) => o.node.id).sort();
  const againIds = again.ops.map((o) => (o as Extract<CanvasAgentOp, { type: "update_node" }>).id).sort();
  assert.deepEqual(againIds, firstIds, "id 与首轮相等");

  const shotAUpdate = again.ops.find(
    (op) => op.type === "update_node" && (op.patch.metadata as WorkflowNodeMetadata | undefined)?.stepId === "shot_a",
  );
  assert.ok(shotAUpdate);
  if (shotAUpdate.type !== "update_node") throw new Error("unreachable");
  assert.equal((shotAUpdate.patch.metadata as WorkflowNodeMetadata).custom_tag, "keep_me", "meta 经 round-trip 不丢");
  // 运输键只供收编匹配，compile 必须扣下、不得写进产物节点 metadata（否则会污染画布真相）。
  for (const op of again.ops) {
    if (op.type !== "update_node" || !op.patch.metadata) continue;
    assert.equal("_origin_node_id" in op.patch.metadata, false, "编译产物不得落运输键");
  }
});

// ─────────────────────────── ⑥ tool 校验用真 registry

test("tool 校验对齐真 harness registry：image_generate 过、not_a_tool 不过", () => {
  assert.ok(HARNESS_TOOL_IDS.has("image_generate"), "registry 实有 image_generate");
  assert.ok(!HARNESS_TOOL_IDS.has("not_a_tool"));

  const good = compileWorkflow(
    { workflow: "demo_wf", steps: [{ id: "gen", title: "生成", tool: "image_generate" }] },
    EMPTY,
  );
  assert.ok(good.ok);
  if (!good.ok) throw new Error("unreachable");
  const gen = addOpOfStep(good.ops, "gen");
  assert.equal((gen.node.metadata as WorkflowNodeMetadata).toolId, "image_generate");

  const bad = compileWorkflow(
    { workflow: "demo_wf", steps: [{ id: "gen", title: "生成", tool: "not_a_tool" }] },
    EMPTY,
  );
  assert.equal(bad.ok, false);
  if (bad.ok) throw new Error("unreachable");
  assert.ok(bad.errors.some((e) => e.field === "tool"));
});

// ─────────────────────────── ⑦ director 步：3D 白模预演（2026-09-03）

test("kind director 步编译出 add_node(type director)：导演台节点 + tool 校验走真 registry", () => {
  const result = compileWorkflow(
    {
      workflow: "director_wf",
      steps: [
        {
          id: "preview",
          title: "3D 白模预演",
          kind: "director",
          prompt: "按分镜表出白模预演方案",
          needs: [],
          tool: "director_propose_plans",
          meta: { stepName: "3D 白模预演", toolIds: ["director_propose_plans"] },
        },
      ],
    },
    EMPTY,
  );
  assert.ok(result.ok);
  if (!result.ok) throw new Error("unreachable");
  const op = addOpOfStep(result.ops, "preview");
  assert.equal(op.node.type, "director", "director 步编译成导演台节点");
  const md = op.node.metadata as WorkflowNodeMetadata;
  assert.equal(md.kind, undefined, "metadata.kind 既有契约只承载 image/video，director 由节点型别表达");
  assert.equal(md.toolId, "director_propose_plans");
  assert.equal(md.stepName, "3D 白模预演", "meta 透传导演相关栏");
  assert.equal(md.workflow_ns, "director_wf");
  assert.equal(md.stepIndex, 1);

  // schema 层：kind "director" 通过校验；坏 kind 仍挡。
  const okSchema = validateWorkflowDsl({ workflow: "director_wf", steps: [{ id: "a", title: "A", kind: "director" }] });
  assert.ok(okSchema.ok, "schema 放行 kind=director");
  const badKind = validateWorkflowDsl({ workflow: "director_wf", steps: [{ id: "a", title: "A", kind: "film" }] });
  assert.equal(badKind.ok, false);
  if (badKind.ok) throw new Error("unreachable");
  assert.ok(badKind.errors.some((e) => e.field === "kind" && e.message.includes("director")), "kind 错误清单含 director");
});

// ─────────────────────────── schema 补充：边界与格式

test("validateWorkflowDsl：steps 空清单、坏 workflow 名、id 不合规均带修复提示", () => {
  const emptySteps = validateWorkflowDsl({ workflow: "demo_wf", steps: [] });
  assert.equal(emptySteps.ok, false);
  if (emptySteps.ok) throw new Error("unreachable");
  const stepsErr = emptySteps.errors.find((e) => e.field === "steps");
  assert.ok(stepsErr);
  assert.ok(stepsErr.message.includes("1..256"), "message 说明边界");

  const badNs = validateWorkflowDsl({ workflow: "Demo WF!", steps: [{ id: "a", title: "A" }] });
  assert.equal(badNs.ok, false);
  if (badNs.ok) throw new Error("unreachable");
  assert.ok(badNs.errors.some((e) => e.field === "workflow" && e.message.includes("novel_film")));

  const badId = validateWorkflowDsl({ workflow: "demo_wf", steps: [{ id: "Keyframe 01", title: "A" }] });
  assert.equal(badId.ok, false);
  if (badId.ok) throw new Error("unreachable");
  const idErr = badId.errors.find((e) => e.field === "id");
  assert.ok(idErr);
  assert.ok(idErr.message.includes("keyframe_01"), "message 给正确 id 示例");
});
