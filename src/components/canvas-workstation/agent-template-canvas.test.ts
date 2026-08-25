import test from "node:test";
import assert from "node:assert/strict";
import type { AgentPipeline } from "@/lib/agent-templates";
import { templateToCanvasLayout, applyTemplateToCanvas } from "@/components/canvas-workstation/agent-template-canvas";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";

/** 無 pipeline 模板 fixture（RecipeTemplate 形狀）。 */
function plainFixture() {
  return {
    id: "fixture-plain",
    name: "玄幻封面",
    slots: {
      prompt: "国风水墨玄幻少年，负剑立于山巅",
      contextPrompt: "水墨山海背景",
      negativePrompt: "低画质、错肢",
      composition: ["主体居中偏左", "留白放标题"],
      qualityProfile: "balanced",
    },
  };
}

const PIPELINE: AgentPipeline = {
  summary: "结构化 → 资产先行 → 门禁 → 组装",
  steps: [
    {
      name: "Character Bible",
      deliverable: "角色设定卡 + DNA 签名",
      inputFrom: "初始需求",
      promptNotes: ["三视图", "服装锚点"],
    },
    {
      name: "Sketch-lock",
      deliverable: "锁定线稿",
      inputFrom: "JSON 注入",
      promptNotes: ["黑白线稿", "构图留白"],
      gate: "比例不过关则回炉",
    },
    {
      name: "Final Render",
      deliverable: "成图",
      inputFrom: "sref 锚",
      promptNotes: ["高细节渲染"],
    },
  ],
};

// ── pipeline → 工業級泳道 canvas workflow ──

test("pipeline template expands each step into an industrial lane (specs/notes/gate/gen)", () => {
  const { nodes } = templateToCanvasLayout({ ...plainFixture(), pipeline: PIPELINE });

  // 步骤1：产出2卡 + 要点2卡 + 无门禁 + 生成1卡 = 5
  // 步骤2：产出1卡 + 要点2卡 + 门禁1卡 + 生成1卡 = 5
  // 步骤3：产出1卡 + 要点1卡 + 生成1卡 = 3
  assert.equal(nodes.length, 13);

  const imageNodes = nodes.filter((n) => n.type === "image");
  const promptNodes = nodes.filter((n) => n.type === "prompt");
  // 每步恰好一颗生成卡，其余全是提示词卡。
  assert.equal(imageNodes.length, 3);
  assert.equal(promptNodes.length, 10);
});

test("lane cards form one chain across lanes; endpoints and generation trace are valid", () => {
  const { nodes, connections } = templateToCanvasLayout({ ...plainFixture(), pipeline: PIPELINE });

  // 三步泳道全部有卡時，跨泳道邊補齊成單一鏈：13 顆卡 → 12 條連線。
  assert.equal(connections.length, nodes.length - 1);

  const nodeIds = new Set(nodes.map((node) => node.id));
  assert.ok(connections.every((connection) => nodeIds.has(connection.fromNodeId)));
  assert.ok(connections.every((connection) => nodeIds.has(connection.toNodeId)));
  const incomingCounts = new Map<string, number>();
  for (const connection of connections) {
    incomingCounts.set(connection.toNodeId, (incomingCounts.get(connection.toNodeId) ?? 0) + 1);
  }
  assert.equal(incomingCounts.get(nodes[0].id) ?? 0, 0);
  for (const node of nodes.slice(1)) assert.equal(incomingCounts.get(node.id), 1);

  const lane0 = nodes.filter((n) => n.position.y === 0);
  assert.equal(lane0.length, 5);
  assert.ok(lane0[1].position.x > lane0[0].position.x);
  assert.ok(lane0[4].position.x > lane0[3].position.x);

  const lane1Y = nodes.find((n) => n.title === "门禁")!.position.y;
  const lane1 = nodes.filter((n) => n.position.y === lane1Y);
  assert.ok(lane1.length > 0);
  assert.ok(lane1[0].position.y > 0);

  const generationNodes = nodes.filter((node) => node.type === "image");
  const crossLaneConnections = connections.filter((connection) => {
    const from = nodes.find((node) => node.id === connection.fromNodeId)!;
    const to = nodes.find((node) => node.id === connection.toNodeId)!;
    return from.position.y !== to.position.y;
  });
  assert.equal(crossLaneConnections.length, PIPELINE.steps.length - 1);
  assert.deepEqual(
    crossLaneConnections.map((connection) => [connection.fromNodeId, connection.toNodeId]),
    [
      [generationNodes[0].id, nodes.find((node) => node.position.y === lane1Y)!.id],
      [generationNodes[1].id, nodes.find((node) => node.position.y > lane1Y)!.id],
    ],
  );

  const trace = generationNodes[1].metadata as Record<string, unknown>;
  assert.equal(trace.workflow_id, plainFixture().id);
  assert.equal(trace.stepIndex, 1);
  assert.equal(trace.stepName, PIPELINE.steps[1].name);
});

test("gen card carries recipe (step 1) / notes prompt (later steps)", () => {
  const { nodes } = templateToCanvasLayout({ ...plainFixture(), pipeline: PIPELINE });
  const gens = nodes.filter((n) => n.type === "image");
  assert.equal(gens[0].metadata?.prompt, "国风水墨玄幻少年，负剑立于山巅");
  assert.equal(gens[0].metadata?.quality, "balanced");
  assert.equal(gens[1].metadata?.prompt, "黑白线稿，构图留白");
  const trace = gens[0].metadata as Record<string, unknown>;
  assert.equal(trace.workflow_id, plainFixture().id);
  assert.equal(trace.stepIndex, 0);
  assert.equal(trace.stepName, PIPELINE.steps[0].name);
});

test("built-in templates all lay out to industrial scale (>= 20 cards)", () => {
  for (const template of AGENT_TEMPLATES) {
    const { nodes, connections } = templateToCanvasLayout(template);
    assert.ok(
      nodes.length >= 20,
      `${template.id} 只有 ${nodes.length} 顆卡片，未達工業級（>=20）`,
    );
    const gens = nodes.filter((n) => n.type === "image");
    assert.equal(gens.length, template.pipeline.steps.length, `${template.id} 生成卡數 = 步驟數`);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const crossLaneConnections = connections.filter((connection) => {
      const from = nodes.find((node) => node.id === connection.fromNodeId)!;
      const to = nodes.find((node) => node.id === connection.toNodeId)!;
      return from.position.y !== to.position.y;
    });
    assert.ok(crossLaneConnections.length >= 1, `${template.id} 缺少跨泳道連線`);
    assert.ok(crossLaneConnections.every((connection) =>
      nodeIds.has(connection.fromNodeId) && nodeIds.has(connection.toNodeId),
    ));
  }
});

test("empty pipeline lane does not create a fabricated cross-lane connection", () => {
  const sparsePipeline: AgentPipeline = {
    summary: "含空泳道",
    steps: [
      PIPELINE.steps[0],
      { name: "", deliverable: "", inputFrom: "", promptNotes: [] },
      PIPELINE.steps[2],
    ],
  };
  const { nodes, connections } = templateToCanvasLayout({ ...plainFixture(), pipeline: sparsePipeline });
  const nodeIds = new Set(nodes.map((node) => node.id));
  assert.ok(connections.every((connection) =>
    nodeIds.has(connection.fromNodeId) && nodeIds.has(connection.toNodeId),
  ));
  const crossLaneConnections = connections.filter((connection) => {
    const from = nodes.find((node) => node.id === connection.fromNodeId)!;
    const to = nodes.find((node) => node.id === connection.toNodeId)!;
    return from.position.y !== to.position.y;
  });
  assert.equal(crossLaneConnections.length, 1);
  const lastGeneration = nodes.find((node) => node.title === PIPELINE.steps[0].name)!;
  const firstFinalCard = nodes.find((node) => node.title === "产出" && node.position.y === 2 * 330)!;
  assert.ok(firstFinalCard);
  assert.deepEqual(crossLaneConnections[0], {
    id: `conn-${lastGeneration.id}-${firstFinalCard!.id}`,
    fromNodeId: lastGeneration.id,
    toNodeId: firstFinalCard!.id,
  });
});

test("no-pipeline template falls back to legacy two-layer layout", () => {
  const { nodes, connections } = templateToCanvasLayout(plainFixture());

  // 5 個非空槽 Prompt 節點 + 1 顆生成節點，全部連到生成節點。
  assert.equal(nodes.length, 6);
  const promptNodes = nodes.filter((n) => n.type === "prompt");
  const imageNodes = nodes.filter((n) => n.type === "image");
  assert.equal(promptNodes.length, 5);
  assert.equal(imageNodes.length, 1);
  assert.equal(connections.length, 5);
  assert.ok(connections.every((c) => c.toNodeId === imageNodes[0].id));
});

test("pipeline layout with empty steps array falls back; applyTemplateToCanvas routes through addNodes", () => {
  // steps 空數組視同無 pipeline，走舊兩層。
  const legacy = templateToCanvasLayout({ ...plainFixture(), pipeline: { summary: "空", steps: [] } });
  assert.equal(legacy.nodes.length, 6);

  const calls: { nodes: unknown[]; connections?: unknown[] }[] = [];
  applyTemplateToCanvas(
    (nodes, connections) => calls.push({ nodes, connections }),
    { ...plainFixture(), pipeline: PIPELINE },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].nodes.length, 13);
  assert.equal(calls[0].connections?.length, 12);

  // host 尚未就绪不拋錯、不鋪節點。
  applyTemplateToCanvas(undefined, { ...plainFixture(), pipeline: PIPELINE });
});
