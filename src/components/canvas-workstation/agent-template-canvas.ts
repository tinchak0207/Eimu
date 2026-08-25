import { CanvasNodeType, type CanvasConnection, type CanvasNode } from "@/lib/canvas/types";
import { recipeTemplateToRecallConfig } from "@/lib/recipe-templates";
import type { RecipeTemplate } from "@/lib/recipe-templates";
import type { AgentPipeline, AgentPipelineStep } from "@/lib/agent-templates";
import type { WorkflowRecallConfig } from "@/lib/workflow-recall";

/**
 * 助理起手模板 → 畫布 workflow（2026-08-25 模板庫點卡）。
 *
 * 兩種鋪法：
 * 1. 帶 pipeline 藍圖（AgentTemplate）：每步一個泳道行——步驟節點（Prompt，
 *    產出+要點+門禁）+ 生成節點（Image，該步 promptNotes 精煉 prompt），
 *    步驟間按「上一步產出餵下一步」連線，打開即見 N 步流水線。
 *    slots 是流水線首步配方，仍進第一步生成節點的 metadata。
 * 2. 無 pipeline（純 RecipeTemplate）：舊兩層兜底——槽位 Prompt 節點
 *    匯入單顆生成節點。
 */

/** 槽位節點縱向間距：一行卡片高 + 呼吸空隙（舊兩層布局用）。 */
const SLOT_GAP_Y = 232;
/** 槽位節點與生成節點的橫向間隙。 */
const SLOT_GAP_X = 80;
/** 流水線泳道行高：生成節點 240 + 呼吸空隙。 */
const LANE_GAP_Y = 340;
/** 步驟節點寬高。 */
const STEP_W = 340;
const STEP_H = 220;
/** 生成節點寬高。 */
const GEN_W = 340;
const GEN_H = 240;

/** applyTemplateToCanvas 接受的模板：RecipeTemplate 為底，pipeline 可選。 */
export type TemplateCanvasInput = RecipeTemplate & { pipeline?: AgentPipeline };

interface SlotSpec {
  key: string;
  title: string;
  text: string;
}

/** WorkflowRecallConfig → 槽位文本清單（順序即畫布縱向順序）。 */
function recallConfigSlots(config: WorkflowRecallConfig): SlotSpec[] {
  const slots: SlotSpec[] = [];
  if (config.prompt) slots.push({ key: "prompt", title: "画面描述", text: config.prompt });
  if (config.contextPrompt) slots.push({ key: "context", title: "场景", text: config.contextPrompt });
  for (const [i, region] of (config.regionalPrompts ?? []).entries()) {
    if (region.text) slots.push({ key: `composition-${i}`, title: "构图", text: region.text });
  }
  if (config.negativePrompt) slots.push({ key: "negative", title: "避免", text: config.negativePrompt });
  return slots;
}

export interface TemplateCanvasLayout {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
}

/** 步驟節點正文：產出 + 要點，帶門禁的步驟再附門禁。 */
function stepContent(step: AgentPipelineStep): string {
  const lines = [`产出：${step.deliverable}`, `要点：${step.promptNotes.join("；")}`];
  if (step.gate) lines.push(`门禁：${step.gate}`);
  return lines.join("\n");
}

/** 步驟 promptNotes 精煉成生成節點 prompt。 */
function promptFromNotes(step: AgentPipelineStep): string {
  return step.promptNotes.join("，");
}

/**
 * pipeline 藍圖 → N 步流水線畫布（純函式，可測）。
 *
 * 每步一個泳道行：步驟節點（左，Prompt）+ 生成節點（右，Image）。
 * 連線兩種：步驟內 step→gen（該步要點注入生成），步驟間 gen_i→step_{i+1}
 * （上一步產出餵下一步）。slots 首步配方進第一顆生成節點 metadata。
 */
function pipelineToCanvasLayout(template: TemplateCanvasInput, pipeline: AgentPipeline): TemplateCanvasLayout {
  const config = recipeTemplateToRecallConfig(template);
  const ts = Date.now().toString(36);
  const stepX = 0;
  const genX = STEP_W + SLOT_GAP_X;

  const nodes: CanvasNode[] = [];
  const connections: CanvasConnection[] = [];

  pipeline.steps.forEach((step, i) => {
    const stepId = `tpl-${ts}-step-${i}`;
    const genId = `tpl-${ts}-gen-${i}`;
    const y = i * LANE_GAP_Y;

    nodes.push({
      id: stepId,
      type: CanvasNodeType.Prompt,
      title: step.name,
      position: { x: stepX, y },
      width: STEP_W,
      height: STEP_H,
      metadata: { content: stepContent(step) },
    });

    // 首步生成節點攜帶 slots 配方（prompt/質量檔/張數）；其餘步驟攜帶要點精煉 prompt。
    const genMetadata: CanvasNode["metadata"] =
      i === 0
        ? {
            prompt: config.prompt || promptFromNotes(step),
            ...(config.qualityProfile ? { quality: config.qualityProfile } : {}),
            count: 1,
          }
        : { prompt: promptFromNotes(step), count: 1 };

    nodes.push({
      id: genId,
      type: CanvasNodeType.Image,
      title: step.name,
      position: { x: genX, y },
      width: GEN_W,
      height: GEN_H,
      metadata: genMetadata,
    });

    connections.push({ id: `conn-${stepId}-${genId}`, fromNodeId: stepId, toNodeId: genId });
    if (i > 0) {
      const prevGen = `tpl-${ts}-gen-${i - 1}`;
      connections.push({ id: `conn-${prevGen}-${stepId}`, fromNodeId: prevGen, toNodeId: stepId });
    }
  });

  return { nodes, connections };
}

/**
 * 模板 → 畫布節點佈局（純函式，可測）。帶 pipeline 走流水線布局；
 * 無 pipeline 走舊兩層：每個非空槽一顆 Prompt 節點（連到生成節點時
 * 文本注入為 prompt 前綴——Prompt 節點既有語義），終點一顆空 Image
 * 節點（A4：空節點=生成落地位，原地回填）。
 */
export function templateToCanvasLayout(template: TemplateCanvasInput): TemplateCanvasLayout {
  const pipeline = template.pipeline;
  if (pipeline && pipeline.steps.length > 0) {
    return pipelineToCanvasLayout(template, pipeline);
  }

  const config = recipeTemplateToRecallConfig(template);
  const slots = recallConfigSlots(config);
  const ts = Date.now().toString(36);
  const imageId = `tpl-${ts}-gen`;

  const slotNodes: CanvasNode[] = slots.map((slot, i) => ({
    id: `tpl-${ts}-${slot.key}`,
    type: CanvasNodeType.Prompt,
    title: slot.title,
    position: { x: 0, y: i * SLOT_GAP_Y },
    width: 340,
    height: 200,
    metadata: { content: slot.text },
  }));

  const connections: CanvasConnection[] = slotNodes.map((n) => ({
    id: `conn-${n.id}-${imageId}`,
    fromNodeId: n.id,
    toNodeId: imageId,
  }));

  // 連槽位都沒有（空模板）= 沒有可鋪的 workflow，直接回空。
  if (slotNodes.length === 0) return { nodes: [], connections: [] };

  const imageNode: CanvasNode = {
    id: imageId,
    type: CanvasNodeType.Image,
    title: template.name,
    position: { x: 340 + SLOT_GAP_X, y: 0 },
    width: 340,
    height: 240,
    metadata: {
      prompt: config.prompt,
      ...(config.qualityProfile ? { quality: config.qualityProfile } : {}),
      count: 1,
    },
  };

  return { nodes: [...slotNodes, imageNode], connections };
}

/** 鋪到畫布：走 useCanvasChat 既有的 addNodes（入 reducer、可 undo）。 */
export function applyTemplateToCanvas(
  addNodes: ((nodes: CanvasNode[], connections?: CanvasConnection[]) => void) | undefined,
  template: TemplateCanvasInput,
): void {
  const { nodes, connections } = templateToCanvasLayout(template);
  if (!addNodes || nodes.length === 0) return;
  addNodes(nodes, connections);
}
