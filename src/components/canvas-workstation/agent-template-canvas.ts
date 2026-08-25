import { CanvasNodeType, type CanvasConnection, type CanvasNode } from "@/lib/canvas/types";
import { recipeTemplateToRecallConfig } from "@/lib/recipe-templates";
import type { RecipeTemplate } from "@/lib/recipe-templates";
import type { WorkflowRecallConfig } from "@/lib/workflow-recall";

/**
 * 助理起手模板 → 畫布 workflow（2026-08-25 模板庫點卡）。
 *
 * 模板 slots 先經 recipeTemplateToRecallConfig 轉成 WorkflowRecallConfig
 * （與工作台表單/配方總線同一結構），再攤成「槽位提示詞節點 → 生成節點」
 * 的線性 workflow：每個非空槽一顆 Prompt 節點（連到生成節點時文本注入為
 * prompt 前綴——這是 Prompt 節點的既有語義），終點一顆空 Image 節點
 * （A4：空節點=生成落地位，原地回填）。
 */

/** 槽位節點縱向間距：一行卡片高 + 呼吸空隙。 */
const SLOT_GAP_Y = 232;
/** 槽位節點與生成節點的橫向間隙。 */
const SLOT_GAP_X = 80;

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

/**
 * 模板 → 畫布節點佈局（純函式，可測）。生成節點攜帶質量槽與張數，
 * 風格槽沒有畫布 metadata 對應欄位——風格由左側對話裡的 agent 接手，
 * 不在節點上硬造一個顯示不出來的欄位。
 */
export function templateToCanvasLayout(template: RecipeTemplate): TemplateCanvasLayout {
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
  template: RecipeTemplate,
): void {
  const { nodes, connections } = templateToCanvasLayout(template);
  if (!addNodes || nodes.length === 0) return;
  addNodes(nodes, connections);
}
