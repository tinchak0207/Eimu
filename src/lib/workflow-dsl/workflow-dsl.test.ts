// workflow-dsl 測試：schema 校驗、確定性節點 id、增量 op 發射、round-trip 冪等、教學式報錯。
// 風格對齊 src/lib/canvas/layout.test.ts（node:test + assert/strict）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CanvasNodeType, type CanvasAgentOp, type CanvasConnection, type CanvasNode } from "../canvas/types";
import { HARNESS_TOOL_IDS } from "../harness-tool-registry";
import { validateWorkflowDsl, type WorkflowDslSource } from "./schema";
import { compileWorkflow, workflowNodeId, type WorkflowCompileInput, type WorkflowNodeMetadata } from "./compile";
import { decompileWorkflow } from "./decompile";

// ─────────────────────────── helpers

const EMPTY: WorkflowCompileInput = { nodes: [], connections: [] };

/** 三步鏈：1 text 步 + 2 image 步（帶 needs / tool / size / count / gate / meta）。 */
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

/** 手工套 ops 成圖（語義對齊 canvas-reducer-adapter：update 淺合併 metadata、connect 按 from/to 去重）。 */
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

/** 找某步驟的 add_node op。 */
function addOpOfStep(ops: CanvasAgentOp[], stepId: string) {
  const op = addOps(ops).find((o) => (o.node.metadata as WorkflowNodeMetadata | undefined)?.stepId === stepId);
  assert.ok(op, `应有步骤 ${stepId} 的 add_node`);
  return op;
}

// ─────────────────────────── ① 3 步鏈 happy path + 確定性 id

test("compileWorkflow 三步鏈：3 個 add_node 無座標、1 條 connect_nodes、連跑兩次 id 全等", () => {
  const r1 = compileWorkflow(SOURCE, EMPTY);
  assert.equal(r1.ok, true);
  if (!r1.ok) throw new Error("unreachable");
  assert.deepEqual(r1.summary, { added: 3, updated: 0, connected: 2, warnings: [] });

  const adds = addOps(r1.ops);
  assert.equal(adds.length, 3);
  assert.equal(r1.ops.length, 4, "3 個 add_node + 1 條 connect_nodes");
  assert.equal(r1.ops[3].type, "connect_nodes", "connect_nodes 在全部 add_node 之後");

  // 一律不帶 position/width/height/moved（座標權交 reducer nextPosition）
  for (const op of adds) {
    const node = op.node;
    for (const banned of ["position", "width", "height", "moved"]) {
      assert.equal(banned in node, false, `add_node.node 禁帶 ${banned}`);
    }
    const md = node.metadata as WorkflowNodeMetadata;
    assert.equal(md.workflow_ns, "demo_wf");
    assert.equal(md.workflow_id, "demo_wf");
    assert.equal(md.status, "idle");
    assert.equal(typeof md.stepIndex, "number");
  }

  const brief = addOpOfStep(r1.ops, "brief");
  assert.equal((brief.node.metadata as WorkflowNodeMetadata).kind, undefined, "text 步不設 image/video kind");
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
  assert.equal(mdA.custom_tag, "keep_me", "meta 透傳");
  assert.equal(mdA.stepIndex, 2);

  const shotB = addOpOfStep(r1.ops, "shot_b");
  assert.equal((shotB.node.metadata as WorkflowNodeMetadata).gate, true, "gate 步帶 gate:true");
  assert.equal((shotB.node.metadata as WorkflowNodeMetadata).stepIndex, 3);

  // 連線：needs 邊 dep→step，合併成一條 connect_nodes
  const connect = r1.ops[3];
  if (connect.type !== "connect_nodes") throw new Error("expected connect_nodes");
  const idOf = (stepId: string) => (addOpOfStep(r1.ops, stepId).node as { id: string }).id;
  assert.deepEqual(connect.connections, [
    { fromNodeId: idOf("brief"), toNodeId: idOf("shot_a") },
    { fromNodeId: idOf("brief"), toNodeId: idOf("shot_b") },
  ]);

  // 節點 id 確定性：wf- + 16 hex，同輸入永遠同 id
  const ids1 = adds.map((o) => o.node.id);
  for (const id of ids1) assert.match(id, /^wf-[0-9a-f]{16}$/);
  assert.equal(idOf("brief"), workflowNodeId("demo_wf", "brief"));
  const r2 = compileWorkflow(SOURCE, EMPTY);
  assert.ok(r2.ok);
  if (!r2.ok) throw new Error("unreachable");
  assert.deepEqual(addOps(r2.ops).map((o) => o.node.id), ids1, "連跑兩次 id 全等");
});

// ─────────────────────────── ② 增量發射：已建圖後再 compile → 全 update

test("compileWorkflow 增量：ops 套成圖後再編譯 → 全 update_node、零 add、零 connect", () => {
  const first = compileWorkflow(SOURCE, EMPTY);
  assert.ok(first.ok);
  if (!first.ok) throw new Error("unreachable");
  const current = applyOps(EMPTY, first.ops);

  const second = compileWorkflow(SOURCE, current);
  assert.ok(second.ok);
  if (!second.ok) throw new Error("unreachable");
  assert.equal(second.ops.length, 3);
  assert.ok(second.ops.every((op) => op.type === "update_node"), "全為 update_node");
  assert.deepEqual(second.summary, { added: 0, updated: 3, connected: 0, warnings: [] });

  const firstIds = addOps(first.ops).map((o) => o.node.id).sort();
  const secondIds = second.ops.map((o) => (o as Extract<CanvasAgentOp, { type: "update_node" }>).id).sort();
  assert.deepEqual(secondIds, firstIds, "update 打在原節點上，不二次建號");
});

// ─────────────────────────── ③ update patch 禁含 position/width/height/moved

test("compileWorkflow 尊重人拖位置：moved 節點的 update patch 無 position/width/height/moved", () => {
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
  assert.ok(patch.patch.metadata, "patch 帶 metadata");
});

// ─────────────────────────── ④ 校驗失敗四連 + 教學式報錯

test("compileWorkflow 校驗失敗四連：needs 未知/環/假 tool/壞 size → ok:false + 帶修復提示", () => {
  const base = { workflow: "demo_wf", title: "示范" };

  // a. needs 引用不存在：message 列出檔內現有步驟清單
  const unknownNeeds = compileWorkflow(
    { ...base, steps: [{ id: "a", title: "A" }, { id: "b", title: "B", needs: ["ghost"] }] },
    EMPTY,
  );
  assert.equal(unknownNeeds.ok, false);
  if (unknownNeeds.ok) throw new Error("unreachable");
  assert.equal(unknownNeeds.ops.length, 0);
  const needsErr = unknownNeeds.errors.find((e) => e.field === "needs");
  assert.ok(needsErr, "有 needs 錯誤");
  assert.equal(needsErr.step, "b");
  assert.ok(needsErr.message.includes("ghost"), "message 指出未知引用");
  assert.ok(needsErr.message.includes("本档现有步骤"), "message 帶修復提示");
  assert.ok(needsErr.message.includes("a"), "message 列出現有步驟清單");

  // b. 環 a→b→a：列出環成員與破環建議
  const cycle = compileWorkflow(
    { ...base, steps: [{ id: "a", title: "A", needs: ["b"] }, { id: "b", title: "B", needs: ["a"] }] },
    EMPTY,
  );
  assert.equal(cycle.ok, false);
  if (cycle.ok) throw new Error("unreachable");
  assert.equal(cycle.ops.length, 0);
  const cycleErr = cycle.errors.find((e) => e.field === "needs");
  assert.ok(cycleErr, "有環錯誤");
  assert.ok(cycleErr.message.includes("a → b → a"), "message 列出環路");
  assert.ok(cycleErr.message.includes("循环依赖"), "message 點名循環依賴");
  assert.ok(cycleErr.message.includes("needs 移除"), "message 帶破環建議");

  // c. 假 tool：附相近合法 id 建議
  const fakeTool = compileWorkflow({ ...base, steps: [{ id: "t", title: "T", tool: "not_a_tool" }] }, EMPTY);
  assert.equal(fakeTool.ok, false);
  if (fakeTool.ok) throw new Error("unreachable");
  assert.equal(fakeTool.ops.length, 0);
  const toolErr = fakeTool.errors.find((e) => e.field === "tool");
  assert.ok(toolErr, "有 tool 錯誤");
  assert.equal(toolErr.step, "t");
  assert.ok(toolErr.message.includes("not_a_tool"), "message 指出非法 id");
  assert.ok(toolErr.message.includes("image_generate"), "message 附相近合法 id 建議");

  // d. 壞 size：給正確格式示例
  const badSize = compileWorkflow({ ...base, steps: [{ id: "s", title: "S", size: "2048" }] }, EMPTY);
  assert.equal(badSize.ok, false);
  if (badSize.ok) throw new Error("unreachable");
  assert.equal(badSize.ops.length, 0);
  const sizeErr = badSize.errors.find((e) => e.field === "size");
  assert.ok(sizeErr, "有 size 錯誤");
  assert.equal(sizeErr.step, "s");
  assert.ok(sizeErr.message.includes("宽x高"), "message 給正確格式說明");
  assert.ok(sizeErr.message.includes("2048x2048"), "message 給格式示例");
});

// ─────────────────────────── ⑤ round-trip：建圖 → decompile → 再 compile → 全 update、id 相等

test("round-trip 冪等：decompile 反推再編譯 → 全 update_node、id 與首輪相等、零新增連線", () => {
  assert.deepEqual(decompileWorkflow({ nodes: [], connections: [] }), [], "空畫布反推為空");

  const first = compileWorkflow(SOURCE, EMPTY);
  assert.ok(first.ok);
  if (!first.ok) throw new Error("unreachable");
  const current = applyOps(EMPTY, first.ops);

  const sources = decompileWorkflow(current);
  assert.equal(sources.length, 1, "一個 workflow 命名空間一份源碼");
  const s0 = sources[0];
  assert.equal(s0.workflow, "demo_wf");
  assert.deepEqual(
    s0.steps.map((s) => s.id),
    ["brief", "shot_a", "shot_b"],
    "按 stepIndex 排序",
  );
  assert.equal(s0.steps[0].kind, "text");
  assert.deepEqual(s0.steps[1].needs, ["brief"], "needs 從組內連線反推");
  assert.equal(s0.steps[1].tool, "image_generate");
  assert.equal(s0.steps[1].size, "1024x1024");
  assert.equal(s0.steps[1].count, 2);
  assert.deepEqual(s0.steps[1].meta, { custom_tag: "keep_me" }, "meta 透傳 = 白名單外剩餘");
  assert.equal(s0.steps[2].gate, true);
  assert.equal(s0.steps[2].prompt, "柴犬画家第二幕");

  const again = compileWorkflow(s0, current);
  assert.ok(again.ok);
  if (!again.ok) throw new Error("unreachable");
  assert.ok(again.ops.every((op) => op.type === "update_node"), "再編譯全為 update_node");
  assert.deepEqual(again.summary, { added: 0, updated: 3, connected: 0, warnings: [] });
  const firstIds = addOps(first.ops).map((o) => o.node.id).sort();
  const againIds = again.ops.map((o) => (o as Extract<CanvasAgentOp, { type: "update_node" }>).id).sort();
  assert.deepEqual(againIds, firstIds, "id 與首輪相等");

  const shotAUpdate = again.ops.find(
    (op) => op.type === "update_node" && (op.patch.metadata as WorkflowNodeMetadata | undefined)?.stepId === "shot_a",
  );
  assert.ok(shotAUpdate);
  if (shotAUpdate.type !== "update_node") throw new Error("unreachable");
  assert.equal((shotAUpdate.patch.metadata as WorkflowNodeMetadata).custom_tag, "keep_me", "meta 經 round-trip 不丟");
});

// ─────────────────────────── ⑥ tool 校驗用真 registry

test("tool 校驗對齊真 harness registry：image_generate 過、not_a_tool 不過", () => {
  assert.ok(HARNESS_TOOL_IDS.has("image_generate"), "registry 實有 image_generate");
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

test("kind director 步編譯出 add_node(type director)：導演台節點 + tool 校驗走真 registry", () => {
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
  assert.equal(op.node.type, "director", "director 步編譯成導演台節點");
  const md = op.node.metadata as WorkflowNodeMetadata;
  assert.equal(md.kind, undefined, "metadata.kind 既有契約只承載 image/video，director 由節點型別表達");
  assert.equal(md.toolId, "director_propose_plans");
  assert.equal(md.stepName, "3D 白模预演", "meta 透傳導演相關欄");
  assert.equal(md.workflow_ns, "director_wf");
  assert.equal(md.stepIndex, 1);

  // schema 層：kind "director" 通過校驗；壞 kind 仍擋。
  const okSchema = validateWorkflowDsl({ workflow: "director_wf", steps: [{ id: "a", title: "A", kind: "director" }] });
  assert.ok(okSchema.ok, "schema 放行 kind=director");
  const badKind = validateWorkflowDsl({ workflow: "director_wf", steps: [{ id: "a", title: "A", kind: "film" }] });
  assert.equal(badKind.ok, false);
  if (badKind.ok) throw new Error("unreachable");
  assert.ok(badKind.errors.some((e) => e.field === "kind" && e.message.includes("director")), "kind 錯誤清單含 director");
});

// ─────────────────────────── schema 補充：邊界與格式

test("validateWorkflowDsl：steps 空清單、壞 workflow 名、id 不合規均帶修復提示", () => {
  const emptySteps = validateWorkflowDsl({ workflow: "demo_wf", steps: [] });
  assert.equal(emptySteps.ok, false);
  if (emptySteps.ok) throw new Error("unreachable");
  const stepsErr = emptySteps.errors.find((e) => e.field === "steps");
  assert.ok(stepsErr);
  assert.ok(stepsErr.message.includes("1..24"), "message 說明邊界");

  const badNs = validateWorkflowDsl({ workflow: "Demo WF!", steps: [{ id: "a", title: "A" }] });
  assert.equal(badNs.ok, false);
  if (badNs.ok) throw new Error("unreachable");
  assert.ok(badNs.errors.some((e) => e.field === "workflow" && e.message.includes("novel_film")));

  const badId = validateWorkflowDsl({ workflow: "demo_wf", steps: [{ id: "Keyframe 01", title: "A" }] });
  assert.equal(badId.ok, false);
  if (badId.ok) throw new Error("unreachable");
  const idErr = badId.errors.find((e) => e.field === "id");
  assert.ok(idErr);
  assert.ok(idErr.message.includes("keyframe_01"), "message 給正確 id 示例");
});
