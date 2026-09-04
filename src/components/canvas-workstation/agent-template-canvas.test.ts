import test from "node:test";
import assert from "node:assert/strict";
import type { AgentPipeline, AgentPipelineStep } from "@/lib/agent-templates";
import { templateToCanvasLayout, applyTemplateToCanvas } from "@/components/canvas-workstation/agent-template-canvas";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";

/** 步驟 outputKind → 生成卡節點類型字串（CanvasNodeType 值即小寫名；缺省 image）。 */
const GEN_NODE_TYPE: Record<NonNullable<AgentPipelineStep["outputKind"]>, string> = {
  image: "image",
  text: "text",
  video: "video",
  audio: "audio",
  director: "director",
};

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
      shortName: "角色卡",
      name: "Character Bible",
      deliverable: "角色设定卡 + DNA 签名",
      inputFrom: "初始需求",
      promptNotes: ["三视图", "服装锚点"],
      requiredTools: [{ id: "image_generate", input: "DNA 签名", output: "三视图" }],
    },
    {
      shortName: "分镜",
      name: "Sketch-lock",
      deliverable: "锁定线稿",
      inputFrom: "JSON 注入",
      promptNotes: ["黑白线稿", "构图留白"],
      gate: "比例不过关则回炉",
      requiredTools: [
        { id: "canvas_get_state" },
        { id: "video_assembly", unsupported: true, requiredCapability: "editing.manifest" },
      ],
    },
    {
      shortName: "成图",
      name: "Final Render",
      deliverable: "成图",
      inputFrom: "sref 锚",
      promptNotes: ["高细节渲染"],
    },
  ],
};

// ── pipeline → 工業級泳道 canvas workflow（2026-08-26 重鋪：工具鏈可見）──

test("pipeline lane = 步骤头(产出合同) + 工具卡 + 门禁卡 + 生成卡；无提示词凑数卡", () => {
  const { nodes } = templateToCanvasLayout({ ...plainFixture(), pipeline: PIPELINE });

  // 步骤1：头1 + 工具1 + 生成1 = 3；步骤2：头1 + 工具2 + 门禁1 + 生成1 = 5；步骤3：头1 + 生成1 = 2
  assert.equal(nodes.length, 10);

  const imageNodes = nodes.filter((n) => n.type === "image");
  assert.equal(imageNodes.length, 3); // 每步恰好一颗生成卡

  // 无 Prompt 凑数卡（旧版 promptNotes 逐条卡已删）。
  assert.equal(nodes.filter((n) => n.type === "prompt").length, 0);

  // 工具卡：标题 = 工具 id（无 emoji）+ pipelineCard 标记 + IO/unsupported 明示
  // （逐张契约见下方专用测试）。
  const toolCards = nodes.filter((n) => n.metadata?.pipelineCard === "tool");
  assert.equal(toolCards.length, 3);
  assert.ok(toolCards.every((n) => n.title === (n.metadata as Record<string, unknown>).toolId));
  assert.ok(toolCards.some((n) => (n.metadata?.content as string).includes("输入：DNA 签名")));
  assert.ok(toolCards.some((n) => (n.metadata?.content as string).includes("harness 未接上游")));

  // 步骤头卡：产出合同（deliverable 全文）。
  const heads = nodes.filter((n) => n.type === "config");
  assert.equal(heads.length, 3);
  assert.ok(heads.every((n) => (n.metadata?.content as string).startsWith("产出：")));

  // 门禁卡。
  assert.equal(nodes.filter((n) => n.title === "门禁 · 验收").length, 1);
});

test("lane cards form one chain across lanes; generation trace carries tools", () => {
  const { nodes, connections } = templateToCanvasLayout({ ...plainFixture(), pipeline: PIPELINE });

  assert.equal(connections.length, nodes.length - 1);
  const nodeIds = new Set(nodes.map((node) => node.id));
  assert.ok(connections.every((c) => nodeIds.has(c.fromNodeId) && nodeIds.has(c.toNodeId)));
  const incomingCounts = new Map<string, number>();
  for (const c of connections) incomingCounts.set(c.toNodeId, (incomingCounts.get(c.toNodeId) ?? 0) + 1);
  assert.equal(incomingCounts.get(nodes[0].id) ?? 0, 0);
  for (const node of nodes.slice(1)) assert.equal(incomingCounts.get(node.id), 1);

  const generationNodes = nodes.filter((n) => n.type === "image");
  // 生成卡 trace：toolIds / deliverable / inputFrom 全带（agent 按 metadata 干活）。
  const trace = generationNodes[1].metadata as Record<string, unknown>;
  assert.equal(trace.workflow_id, plainFixture().id);
  assert.equal(trace.stepIndex, 1);
  assert.equal(trace.stepName, PIPELINE.steps[1].name);
  assert.deepEqual(trace.toolIds, ["canvas_get_state", "video_assembly"]);
  assert.equal(trace.deliverable, "锁定线稿");
  assert.equal(trace.inputFrom, "JSON 注入");
});

test("gen card carries recipe (step 1) / notes prompt (later steps)", () => {
  const { nodes } = templateToCanvasLayout({ ...plainFixture(), pipeline: PIPELINE });
  const gens = nodes.filter((n) => n.type === "image");
  assert.equal(gens[0].metadata?.prompt, "国风水墨玄幻少年，负剑立于山巅");
  assert.equal(gens[0].metadata?.quality, "balanced");
  assert.equal(gens[1].metadata?.prompt, "黑白线稿，构图留白");
  assert.equal(gens[2].metadata?.prompt, "高细节渲染");
  // 生成卡标题 = shortName（不是黑话原名）。
  assert.equal(gens[0].title, "角色卡");
  assert.equal(gens[1].title, "分镜");
});

test("every generation card carries the full agent trace (toolIds = requiredTools ids, deliverable, inputFrom, shortName title)", () => {
  const { nodes } = templateToCanvasLayout({ ...plainFixture(), pipeline: PIPELINE });
  const gens = nodes
    .filter((n) => n.type === "image")
    .sort((a, b) => a.position.y - b.position.y);
  assert.equal(gens.length, PIPELINE.steps.length);
  gens.forEach((gen, i) => {
    const step = PIPELINE.steps[i];
    const meta = gen.metadata as Record<string, unknown>;
    assert.deepEqual(meta.toolIds, (step.requiredTools ?? []).map((t) => t.id), `step ${i} toolIds`);
    assert.equal(meta.deliverable, step.deliverable, `step ${i} deliverable`);
    assert.equal(meta.inputFrom, step.inputFrom, `step ${i} inputFrom`);
    assert.equal(meta.stepIndex, i, `step ${i} stepIndex`);
    assert.equal(meta.stepName, step.name, `step ${i} stepName`);
    assert.equal(meta.count, 1, `step ${i} count`);
    assert.equal(meta.workflow_id, "fixture-plain", `step ${i} workflow_id`);
    // 生成卡标题 = shortName（非黑话原名）。
    assert.equal(gen.title, step.shortName, `step ${i} title`);
  });
});

test("tool cards per-card contract: supported = 输入/输出, bare tool = 平台原生工具, unsupported = harness 未接", () => {
  const { nodes } = templateToCanvasLayout({ ...plainFixture(), pipeline: PIPELINE });
  const byToolId = new Map<string, Record<string, unknown>>();
  for (const card of nodes.filter((n) => n.metadata?.pipelineCard === "tool")) {
    // 标题 = 工具 id 原文（2026-08-27 去 🔧 emoji；全名可读性由正文 toolId 承担）。
    const meta = card.metadata as Record<string, unknown>;
    assert.equal(card.title, meta.toolId, `tool card title should be <id>, got ${card.title}`);
    byToolId.set(card.title, meta);
  }
  // 支持的工具：结构化 IO 字段 + 纯文本 content 兜底逐字进卡。
  assert.equal(byToolId.get("image_generate")?.content, "工具：image_generate\n输入：DNA 签名\n输出：三视图");
  assert.equal(byToolId.get("image_generate")?.toolInput, "DNA 签名");
  assert.equal(byToolId.get("image_generate")?.toolOutput, "三视图");
  assert.equal(byToolId.get("image_generate")?.unsupported, false);
  // 无 input/output 的工具：平台原生工具兜底，不冒充 IO。
  assert.equal(byToolId.get("canvas_get_state")?.content, "工具：canvas_get_state\n平台原生工具");
  // unsupported：必须明示 harness 未接 + requiredCapability，禁止冒充可用。
  assert.match(String(byToolId.get("video_assembly")?.content ?? ""), /harness 未接/);
  assert.match(String(byToolId.get("video_assembly")?.content ?? ""), /editing\.manifest/);
  assert.equal(byToolId.get("video_assembly")?.unsupported, true);
  assert.equal(byToolId.get("video_assembly")?.requiredCapability, "editing.manifest");
});

test("step header cards are titled 「第 N 步 · 名」 (config type, deliverable contract)", () => {
  const { nodes } = templateToCanvasLayout({ ...plainFixture(), pipeline: PIPELINE });
  const heads = nodes
    .filter((n) => n.type === "config")
    .sort((a, b) => a.position.y - b.position.y);
  assert.equal(heads.length, PIPELINE.steps.length);
  heads.forEach((head, i) => {
    assert.equal(head.title, `第 ${i + 1} 步 · ${PIPELINE.steps[i].name}`);
    assert.ok((head.metadata?.content as string).startsWith("产出："));
  });
});

test("steps without requiredTools produce no tool cards and gen toolIds = []", () => {
  const { nodes } = templateToCanvasLayout({ ...plainFixture(), pipeline: PIPELINE });
  // 第 3 步（Final Render）无 requiredTools：泳道只有头卡 + 生成卡。
  const lane2 = nodes.filter((n) => n.position.y === 2 * 330);
  assert.equal(lane2.length, 2);
  assert.equal(lane2.filter((n) => n.metadata?.pipelineCard === "tool").length, 0);
  const gen = lane2.find((n) => n.type === "image")!;
  assert.deepEqual((gen.metadata as Record<string, unknown>).toolIds, []);
});

test("built-in templates all lay out with visible tool chain (>= 1 tool card, gens = steps)", () => {
  for (const template of AGENT_TEMPLATES) {
    const { nodes, connections } = templateToCanvasLayout(template);
    const gens = nodes.filter((n) => n.id.endsWith("-gen"));
    assert.equal(gens.length, template.pipeline.steps.length, `${template.id} 生成卡數 = 步驟數`);
    // 八模板都有工具卡（工具链可见是这次铺法的目的）。
    const toolCards = nodes.filter((n) => n.metadata?.pipelineCard === "tool");
    assert.ok(toolCards.length >= 4, `${template.id} 工具卡過少（${toolCards.length}）——流水线工具链必须可见`);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const crossLane = connections.filter((c) => {
      const from = nodes.find((n) => n.id === c.fromNodeId)!;
      const to = nodes.find((n) => n.id === c.toNodeId)!;
      return from.position.y !== to.position.y;
    });
    assert.ok(crossLane.length >= 1, `${template.id} 缺少跨泳道連線`);
    assert.ok(connections.every((c) => nodeIds.has(c.fromNodeId) && nodeIds.has(c.toNodeId)));
  }
});

test("built-in templates: every gen card carries toolIds/deliverable/inputFrom + shortName title; every tool card shows 输入/输出", () => {
  for (const template of AGENT_TEMPLATES) {
    const { nodes } = templateToCanvasLayout(template);
    const gens = nodes
      .filter((n) => n.id.endsWith("-gen"))
      .sort((a, b) => a.position.y - b.position.y);
    assert.equal(gens.length, template.pipeline.steps.length, template.id);
    gens.forEach((gen, i) => {
      const step = template.pipeline.steps[i];
      const meta = gen.metadata as Record<string, unknown>;
      // 生成卡節點類型 = 步驟 outputKind（缺省 image），文本/視頻/配音步不再鋪成圖片卡。
      assert.equal(gen.type, GEN_NODE_TYPE[step.outputKind ?? "image"], `${template.id} step ${i} 生成卡類型應為 outputKind 映射`);
      assert.deepEqual(
        meta.toolIds,
        (step.requiredTools ?? []).map((t) => t.id),
        `${template.id} step ${i} toolIds 应与 requiredTools 一致`,
      );
      assert.equal(meta.deliverable, step.deliverable, `${template.id} step ${i} deliverable`);
      assert.equal(meta.inputFrom, step.inputFrom, `${template.id} step ${i} inputFrom`);
      assert.equal(gen.title, step.shortName, `${template.id} step ${i} 生成卡标题应为 shortName`);
    });
    for (const card of nodes.filter((n) => n.metadata?.pipelineCard === "tool")) {
      const content = card.metadata?.content as string;
      assert.match(content, /输入：/, `${template.id} ${card.title} 缺「输入：」`);
      assert.match(content, /输出：/, `${template.id} ${card.title} 缺「输出：」`);
    }
  }
});

test("empty pipeline lane does not create a fabricated cross-lane connection", () => {
  const sparsePipeline: AgentPipeline = {
    summary: "含空泳道",
    steps: [
      PIPELINE.steps[0],
      { shortName: "", name: "", deliverable: "", inputFrom: "", promptNotes: [] },
      PIPELINE.steps[2],
    ],
  };
  const { nodes, connections } = templateToCanvasLayout({ ...plainFixture(), pipeline: sparsePipeline });
  const nodeIds = new Set(nodes.map((node) => node.id));
  assert.ok(connections.every((c) => nodeIds.has(c.fromNodeId) && nodeIds.has(c.toNodeId)));
  const crossLane = connections.filter((c) => {
    const from = nodes.find((n) => n.id === c.fromNodeId)!;
    const to = nodes.find((n) => n.id === c.toNodeId)!;
    return from.position.y !== to.position.y;
  });
  // 空泳道（无 name/deliverable/tools/gate）不伪造凑数卡，但链路仍穿过：
  // 跨泳道连线 = 2（步0生成→空泳道首卡、空泳道生成→步2首卡）。
  assert.equal(crossLane.length, 2);
  // 空泳道内部卡片数 ≤ 2（最多头+生成，无内容卡可凑）。
  const lane1Nodes = nodes.filter((n) => n.position.y === 330);
  assert.ok(lane1Nodes.length <= 2, `空泳道不应伪造内容卡，实际 ${lane1Nodes.length} 张`);
  // 末段：步2 的头卡（config）在链上。
  assert.ok(nodes.some((n) => n.type === "config" && n.position.y === 2 * 330));
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
  assert.equal(calls[0].nodes.length, 10);
  assert.equal(calls[0].connections?.length, 9);

  // host 尚未就绪不拋錯、不鋪節點。
  applyTemplateToCanvas(undefined, { ...plainFixture(), pipeline: PIPELINE });
});
