import { CanvasNodeType, type CanvasConnection, type CanvasNode } from "@/lib/canvas/types";
import { recipeTemplateToRecallConfig } from "@/lib/recipe-templates";
import type { RecipeTemplate } from "@/lib/recipe-templates";
import type { AgentPipeline, AgentPipelineStep } from "@/lib/agent-templates";
import type { WorkflowRecallConfig } from "@/lib/workflow-recall";

/**
 * 助理起手模板 → 畫布 workflow（2026-08-25 模板庫點卡）。
 *
 * 兩種鋪法：
 * 1. 帶 pipeline 藍圖（AgentTemplate）：工業級泳道——每步展開成
 *    「規格卡（deliverable 拆項）→ 要點卡（promptNotes 逐條）→ 門禁卡 →
 *    生成卡」一整排卡片，步驟間按「上一步產出餵下一步」串連。5 步流水線
 *    鋪開就是 30-50 顆卡片的生產現場，不是兩顆孤節點。
 * 2. 無 pipeline（純 RecipeTemplate）：舊兩層兜底——槽位 Prompt 節點
 *    匯入單顆生成節點。
 */

/** 槽位節點縱向間距：一行卡片高 + 呼吸空隙（舊兩層布局用）。 */
const SLOT_GAP_Y = 232;
/** 槽位節點與生成節點的橫向間隙。 */
const SLOT_GAP_X = 80;

// ── 工業級泳道幾何 ──
/** 卡片統一寬度；高度按內容類型分檔。 */
const CARD_W = 300;
const SPEC_H = 170;
const NOTE_H = 150;
const GATE_H = 150;
const GEN_H = 240;
/** 泳道內卡片橫向間隙。 */
const CARD_GAP_X = 60;
/** 泳道行高：最高卡（生成 240）+ 呼吸空隙。 */
const LANE_GAP_Y = 330;

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

/** deliverable 字串拆成產出項清單：頓號/加號/逗號分隔的複合產出各成一卡。 */
function splitDeliverable(deliverable: string): string[] {
  return deliverable
    .split(/[+＋、;；]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/** 要點精煉成生成節點 prompt。 */
function promptFromNotes(step: AgentPipelineStep): string {
  return step.promptNotes.join("，");
}

/**
 * pipeline 藍圖 → 工業級泳道畫布（純函式，可測）。
 *
 * 每步一條泳道：規格卡（deliverable 拆項，每項一卡）→ 要點卡（promptNotes
 * 逐條一卡）→ 門禁卡（有 gate 才有）→ 生成卡。泳道內卡片鏈式串連
 * （規格₁→規格₂→…→要點₁→…→門禁→生成），泳道間生成卡 → 下一步第一張卡。
 * slots 首步配方進第一顆生成節點 metadata。
 */
function pipelineToCanvasLayout(template: TemplateCanvasInput, pipeline: AgentPipeline): TemplateCanvasLayout {
  const config = recipeTemplateToRecallConfig(template);
  const ts = Date.now().toString(36);

  const nodes: CanvasNode[] = [];
  const connections: CanvasConnection[] = [];

  let previousGenerationId: string | null = null;

  pipeline.steps.forEach((step, i) => {
    // 泳道卡片序列：規格 → 要點 → 門禁 → 生成。
    const cards: Array<{ title: string; text: string; h: number; generation?: boolean }> = [];

    for (const spec of splitDeliverable(step.deliverable)) {
      cards.push({ title: "产出", text: spec, h: SPEC_H });
    }
    step.promptNotes.forEach((note, ni) => {
      cards.push({ title: `要点 ${ni + 1}`, text: note, h: NOTE_H });
    });
    if (step.gate) cards.push({ title: "门禁", text: step.gate, h: GATE_H });
    if (step.name.trim()) {
      cards.push({
        title: step.name,
        text: promptFromNotes(step),
        h: GEN_H,
        generation: true,
      });
    }

    let previousId: string | null = null;
    const laneTop = i * LANE_GAP_Y;

    cards.forEach((card, ci) => {
      const id = `tpl-${ts}-s${i}-c${ci}`;
      const metadata = card.generation
        ? ({
            ...(i === 0
              ? {
                  prompt: config.prompt || card.text,
                  ...(config.qualityProfile ? { quality: config.qualityProfile } : {}),
                }
              : { prompt: card.text }),
            count: 1,
            workflow_id: template.id,
            stepIndex: i,
            stepName: step.name,
            inputFrom: step.inputFrom,
          } as CanvasNode["metadata"] & Record<string, unknown>)
        : { content: card.text };

      nodes.push({
        id,
        type: card.generation ? CanvasNodeType.Image : CanvasNodeType.Prompt,
        title: card.title,
        position: { x: ci * (CARD_W + CARD_GAP_X), y: laneTop },
        width: CARD_W,
        height: card.h,
        metadata,
      });

      if (!previousId && previousGenerationId) {
        connections.push({
          id: `conn-${previousGenerationId}-${id}`,
          fromNodeId: previousGenerationId,
          toNodeId: id,
        });
      } else if (previousId) {
        connections.push({ id: `conn-${previousId}-${id}`, fromNodeId: previousId, toNodeId: id });
      }
      previousId = id;
      if (card.generation) previousGenerationId = id;
    });
  });

  return { nodes, connections };
}

/**
 * 模板 → 畫布節點佈局（純函式，可測）。帶 pipeline 走工業級泳道布局；
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
