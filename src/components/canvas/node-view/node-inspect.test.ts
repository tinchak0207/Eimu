import { test } from "node:test";
import assert from "node:assert/strict";
import { CanvasNodeType, type CanvasNode, type CanvasNodeMetadata } from "@/lib/canvas/types";
import { inspectSections, inspectRowCount } from "./node-inspect";

function node(type: CanvasNodeType, metadata: CanvasNodeMetadata, title = "镜 03"): CanvasNode {
  return { id: "node-abcdef-123456", type, title, position: { x: 780, y: 230 }, width: 280, height: 190, metadata };
}

const labelsOf = (n: CanvasNode, inputs = []) => inspectSections(n, inputs).flatMap((s) => s.rows.map((r) => r.label));

test("inspectSections：生成节点给调参/排错有用的栏位，全中文标签、完整值", () => {
  const n = node(CanvasNodeType.Image, {
    model: "seedream-4",
    prompt: "雨夜旧车站远景，霓虹反光",
    negativePrompt: "模糊",
    size: "1536x1024",
    quality: "high",
    count: 1,
    shotId: "03",
    status: "error",
    imageTaskId: "gt_2026_abcdef123456",
    errorDetails: { human_message: "上游繁忙，请稍后重试" },
  });
  const sections = inspectSections(n, [{ id: "r1", label: "主角·林雨", type: CanvasNodeType.Reference }]);
  const rows = sections.flatMap((s) => s.rows);
  const byLabel = new Map(rows.map((r) => [r.label, r]));
  assert.equal(sections[0].title, "输入");
  assert.equal((byLabel.get("参考图") as { value: string }).value, "主角·林雨");
  assert.equal((byLabel.get("模型") as { value: string }).value, "seedream-4");
  assert.equal((byLabel.get("提示词") as { value: string }).value, "雨夜旧车站远景，霓虹反光");
  assert.equal((byLabel.get("任务 ID") as { value: string }).value, "gt_2026_abcdef123456", "id 完整不截断");
  assert.equal((byLabel.get("错误") as { value: string; tone?: string }).tone, "error");
  assert.equal((byLabel.get("状态") as { value: string }).value, "失败");
});

test("inspectSections：不放对使用者无意义的栏位（座标/尺寸/内部 id/英文缩写）", () => {
  const labels = labelsOf(node(CanvasNodeType.Image, { model: "m", size: "1:1", workflow_id: "wf-1", session_id: "s-1" }));
  for (const bad of ["ID", "TYPE", "DIM", "POS", "WF", "SES", "CARD"]) assert.ok(!labels.includes(bad), `不应出现 ${bad}`);
  for (const l of labels) assert.ok(!/^[A-Z.]{2,}$/.test(l), `标签不得是英文缩写：${l}`);
});

test("inspectSections：流水线步骤卡＝步骤/工具/交付物/输入来源；工具输入 JSON 缩排排版", () => {
  const step = node(CanvasNodeType.Config, {
    pipelineCard: "step_head",
    stepIndex: 1,
    stepName: "拆解剧本",
    toolIds: ["script_scene_parse"],
    deliverable: "结构化剧本 JSON（场次表 + 节拍 beat list）",
    inputFrom: "用户输入/选题原稿",
  });
  const labels = labelsOf(step);
  for (const l of ["步骤", "工具", "交付物", "输入来源"]) assert.ok(labels.includes(l), `缺 ${l}`);
  const tool = inspectSections(node(CanvasNodeType.Config, { pipelineCard: "tool", toolId: "cast_asset_lock", toolInput: '{"cast":["林雨"]}' }));
  const input = tool.flatMap((s) => s.rows).find((r) => r.label === "工具输入") as { value: string; mono?: boolean };
  assert.equal(input.mono, true);
  assert.match(input.value, /\n {2}"cast"/);
});

test("inspectSections：分镜 21 栏用 AID 中文栏名；总行数给「还有 N 项」用", () => {
  const n = node(CanvasNodeType.Image, { storyboardShot: { shotNumber: "03", visualDescription: "少女撑伞站在月台边", shotSize: "中景" } as never });
  const shot = inspectSections(n).find((s) => s.key === "shot");
  assert.deepEqual(shot?.rows.map((r) => r.label), ["镜号", "画面描述", "景别"]);
  assert.ok(inspectRowCount(inspectSections(n)) >= 3);
});
