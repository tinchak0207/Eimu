import test from "node:test";
import assert from "node:assert/strict";
import type { AgentPipeline } from "@/lib/agent-templates";
import { templateToCanvasLayout, applyTemplateToCanvas } from "@/components/canvas-workstation/agent-template-canvas";

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
      deliverable: "角色设定卡",
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

// ── pipeline → 多步驟 canvas workflow ──

test("pipeline template lays N steps as chained lanes (step + gen per step)", () => {
  const { nodes, connections } = templateToCanvasLayout({ ...plainFixture(), pipeline: PIPELINE });

  // 3 步 × (步驟節點 + 生成節點) = 6 顆。
  assert.equal(nodes.length, 6);
  const [s0, g0, s1, g1, s2, g2] = nodes;
  assert.equal(s0.type, "prompt");
  assert.equal(g0.type, "image");
  assert.equal(s1.type, "prompt");
  assert.equal(g1.type, "image");
  assert.equal(s2.type, "prompt");
  assert.equal(g2.type, "image");

  // 步驟節點 title = 步驟名（行業黑話），生成節點同名。
  assert.equal(s0.title, "Character Bible");
  assert.equal(s1.title, "Sketch-lock");
  assert.equal(g1.title, "Sketch-lock");
  assert.equal(s2.title, "Final Render");
});

test("pipeline nodes carry deliverable/promptNotes/gate text in content", () => {
  const { nodes } = templateToCanvasLayout({ ...plainFixture(), pipeline: PIPELINE });
  const [s0, , s1] = nodes;

  assert.match(s0.metadata?.content ?? "", /产出：角色设定卡/);
  assert.match(s0.metadata?.content ?? "", /要点：三视图；服装锚点/);
  // 無門禁步驟不出現門禁行。
  assert.doesNotMatch(s0.metadata?.content ?? "", /门禁/);
  // 有門禁步驟附門禁文字。
  assert.match(s1.metadata?.content ?? "", /门禁：比例不过关则回炉/);
});

test("pipeline connections chain step→gen within step and gen→next-step across steps", () => {
  const { nodes, connections } = templateToCanvasLayout({ ...plainFixture(), pipeline: PIPELINE });
  const [s0, g0, s1, g1, s2, g2] = nodes;

  assert.equal(connections.length, 5); // 3 步內 + 2 步間
  const pairs = connections.map((c) => `${c.fromNodeId}->${c.toNodeId}`);
  assert.ok(pairs.includes(`${s0.id}->${g0.id}`), "步驟0 → 生成0");
  assert.ok(pairs.includes(`${g0.id}->${s1.id}`), "生成0 產出餵步驟1");
  assert.ok(pairs.includes(`${s1.id}->${g1.id}`), "步驟1 → 生成1");
  assert.ok(pairs.includes(`${g1.id}->${s2.id}`), "生成1 產出餵步驟2");
  assert.ok(pairs.includes(`${s2.id}->${g2.id}`), "步驟2 → 生成2");
});

test("pipeline layout: step nodes left, gen nodes right, lanes stack vertically", () => {
  const { nodes } = templateToCanvasLayout({ ...plainFixture(), pipeline: PIPELINE });
  const [s0, g0, s1, g1, s2, g2] = nodes;

  assert.equal(s0.position.x, 0);
  assert.equal(s1.position.x, 0);
  assert.equal(s2.position.x, 0);
  assert.ok(g0.position.x > s0.position.x);
  assert.ok(g1.position.x > s1.position.x);
  assert.ok(g2.position.x > s2.position.x);
  assert.ok(s1.position.y > s0.position.y);
  assert.ok(s2.position.y > s1.position.y);
  assert.ok(g2.position.y > g0.position.y);
});

test("pipeline first gen node carries slots recipe; later gens carry notes-refined prompt", () => {
  const { nodes } = templateToCanvasLayout({ ...plainFixture(), pipeline: PIPELINE });
  const [, g0, , g1] = nodes;

  // slots = 首步配方 → 第一步生成節點 metadata。
  assert.equal(g0.metadata?.prompt, "国风水墨玄幻少年，负剑立于山巅");
  assert.equal(g0.metadata?.quality, "balanced");
  assert.equal(g0.metadata?.count, 1);
  // 後續步驟生成節點攜帶 promptNotes 精煉 prompt。
  assert.equal(g1.metadata?.prompt, "黑白线稿，构图留白");
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
  assert.equal(calls[0].nodes.length, 6);
  assert.equal(calls[0].connections?.length, 5);

  // host 尚未就绪不拋錯、不鋪節點。
  applyTemplateToCanvas(undefined, { ...plainFixture(), pipeline: PIPELINE });
});
