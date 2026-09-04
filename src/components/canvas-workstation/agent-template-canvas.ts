import { CanvasNodeType, type CanvasConnection, type CanvasNode } from "@/lib/canvas/types";
import { recipeTemplateToRecallConfig } from "@/lib/recipe-templates";
import type { RecipeTemplate } from "@/lib/recipe-templates";
import type { AgentPipeline, AgentPipelineStep } from "@/lib/agent-templates";
import type { WorkflowRecallConfig } from "@/lib/workflow-recall";

/**
 * 助理起手模板 → 畫布 workflow（2026-08-26 工具鏈重鋪）。
 *
 * 兩種鋪法：
 * 1. 帶 pipeline 藍圖（AgentTemplate）：工業級泳道——每步展開成
 *    「步驟頭卡（deliverable 合同）→ 工具卡（每個 requiredTool 一張，
 *    輸入/輸出/unsupported 明示）→ 門禁卡（有 gate 才鋪）→ 生成卡
 *    （短名）」一整排卡片，步驟間按「上一步產出餵下一步」串連；
 *    promptNotes/deliverable/inputFrom/toolIds 全部進生成卡 metadata
 *    給 agent 執行，畫布上不鋪提示詞湊數卡。8 步流水線鋪開就是
 *    30-50 顆卡片的生產現場，不是兩顆孤節點。
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
export type TemplateCanvasInput = RecipeTemplate & {
  pipeline?: AgentPipeline;
  /** VPS agent-harness 已註冊的 workflow 模板 id（如 novel_film；2026-08-27）。 */
  harnessTemplateId?: string;
};

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

/** 要點精煉成生成節點 prompt（進 metadata，不鋪湊數卡）。 */
function promptFromNotes(step: AgentPipelineStep): string {
  return step.promptNotes.join("，");
}

/** 步驟產出類型 → 畫布節點類型（生成卡按此鋪，不再一律 Image）。
 *  director（2026-09-03）= 3D 白模预演步，生成卡鋪成導演台節點；其餘 metadata
 *  （stepIndex/stepName/toolIds/promptNotes…）走與其它步驟同一條生成卡路徑，不分支。 */
const GEN_NODE_TYPE: Record<NonNullable<AgentPipelineStep["outputKind"]>, CanvasNodeType> = {
  image: CanvasNodeType.Image,
  text: CanvasNodeType.Text,
  video: CanvasNodeType.Video,
  audio: CanvasNodeType.Audio,
  director: CanvasNodeType.Director,
};

/**
 * pipeline 藍圖 → 工業級泳道畫布（純函式，可測）。
 *
 * 2026-08-26 重鋪（用戶裁定：畫布要體現 Agent Harness 的工具鏈，不是提示詞湊數）：
 * 每步一條泳道，卡片序列 = 步驟頭卡（這步要產出什麼）→ 工具卡（每個
 * requiredTool 一張：輸入→輸出、unsupported 明示「harness 未接」）→
 * 門禁卡（驗收條件）→ 生成卡（短名，攜帶 promptNotes/deliverable 給 agent）。
 * 舊的 deliverable 拆項卡與 promptNotes 逐條卡（提示詞湊數）已刪——
 * 它們歸入生成卡 metadata，畫布上只留「用戶一眼看懂流水線」的結構卡。
 */
function pipelineToCanvasLayout(template: TemplateCanvasInput, pipeline: AgentPipeline): TemplateCanvasLayout {
  const config = recipeTemplateToRecallConfig(template);
  const ts = Date.now().toString(36);

  const nodes: CanvasNode[] = [];
  const connections: CanvasConnection[] = [];

  let previousGenerationId: string | null = null;

  pipeline.steps.forEach((step, i) => {
    const laneTop = i * LANE_GAP_Y;
    let previousId: string | null = null;

    const push = (
      key: string,
      node: Omit<CanvasNode, "id" | "position">,
      col: number,
    ): string => {
      const id = `tpl-${ts}-s${i}-${key}`;
      nodes.push({
        ...node,
        id,
        position: { x: col * (CARD_W + CARD_GAP_X), y: laneTop },
        // 罪状 8：模板节点必须盖 moved 章。没盖章的节点会被 lib/canvas/reducer
        // 的 layoutGraph 当成「未手动摆放」重新排版——整条泳道被压成
        // 左→右 DAG 单行链（每张卡都是链上一环，深度=卡片数），泳道布局
        // 全毁。盖章后模板布局即权威，自动排版不再动它。
        moved: true,
        // Bug3 前置：泳道上的每一張卡（頭卡/工具卡/門禁卡/生成卡）都蓋同一個
        // workflow_id 章 —— replaceWorkflowNodes 才能把整條舊泳道一次刪淨。
        // 只有生成卡帶章的話，重點模板會殘留 ~90% 的輔助卡。
        metadata: { ...(node.metadata ?? {}), workflow_id: template.id },
      } as CanvasNode);
      if (!previousId && previousGenerationId) {
        connections.push({ id: `conn-${previousGenerationId}-${id}`, fromNodeId: previousGenerationId, toNodeId: id });
      } else if (previousId) {
        connections.push({ id: `conn-${previousId}-${id}`, fromNodeId: previousId, toNodeId: id });
      }
      previousId = id;
      return id;
    };

    // ① 步驟头卡：这一步的产出规格（deliverable 全文）——不是提示词，是合同。
    //    2026-08-27 结构化（Liquid Glass 正文分层）：pipelineCard=step_head
    //    标记卡种，deliverable 走结构化字段（渲染层出 green tint 胶囊 + 正文），
    //    content 留纯文本兜底（旧画布/降级渲染仍可读）。
    push("head", {
      type: CanvasNodeType.Config,
      title: `第 ${i + 1} 步 · ${step.name}`,
      width: CARD_W,
      height: SPEC_H,
      metadata: {
        pipelineCard: "step_head",
        deliverable: step.deliverable,
        inputFrom: step.inputFrom,
        content: `产出：${step.deliverable}`,
      },
    }, 0);

    // ② 工具卡：每個 requiredTool 一張——用戶一眼看到這步用什麼工具、
    //    輸入餵什麼、輸出得什麼；unsupported 明示（harness 未接，不冒充）。
    //    2026-08-27 结构化：tool 字段进 metadata（渲染层出等宽字名 + Lucide
    //    箭头 IO + unsupported 红色警示行），content 留纯文本兜底。标题去 🔧
    //    emoji（DESIGN.md 禁 emoji，图标识别改由渲染层 typeBadge 承担）。
    (step.requiredTools ?? []).forEach((tool, ti) => {
      const toolLine = `工具：${tool.id}`;
      const io = [tool.input ? `输入：${tool.input}` : null, tool.output ? `输出：${tool.output}` : null]
        .filter(Boolean)
        .join("\n");
      const body = tool.unsupported
        ? `${toolLine}\n${io ? io + "\n" : ""}harness 未接上游（${tool.requiredCapability ?? tool.id}）——agent 须明说不可用，禁止用 prompt 冒充`
        : io
          ? `${toolLine}\n${io}`
          : `${toolLine}\n平台原生工具`;
      push(`tool-${ti}`, {
        type: CanvasNodeType.Text,
        title: tool.id,
        width: CARD_W,
        height: NOTE_H,
        metadata: {
          pipelineCard: "tool",
          toolId: tool.id,
          toolInput: tool.input,
          toolOutput: tool.output,
          unsupported: tool.unsupported ?? false,
          requiredCapability: tool.requiredCapability,
          content: body,
        },
      }, 1 + ti);
    });

    // ③ 門禁卡：驗收條件（有 gate 才鋪）。
    //    2026-08-27 结构化：kind=gate 标记（渲染层出 ShieldCheck 图标 + 条件分行）。
    if (step.gate) {
      push("gate", {
        type: CanvasNodeType.Text,
        title: "门禁 · 验收",
        width: CARD_W,
        height: GATE_H,
        metadata: { pipelineCard: "gate", content: step.gate },
      }, 1 + (step.requiredTools?.length ?? 0));
    }

    // ④ 生成卡：短名。promptNotes/deliverable/inputFrom 進 metadata 給 agent，
    //    畫布上不鋪提示詞湊數卡。
    const genId = push("gen", {
      type: GEN_NODE_TYPE[step.outputKind ?? "image"],
      title: step.shortName ?? step.name,
      width: CARD_W,
      height: GEN_H,
      metadata: {
        ...(i === 0
          ? {
              prompt: config.prompt || promptFromNotes(step),
              ...(config.qualityProfile ? { quality: config.qualityProfile } : {}),
            }
          : { prompt: promptFromNotes(step) }),
        count: 1,
        workflow_id: template.id,
        ...(template.harnessTemplateId ? { harnessTemplateId: template.harnessTemplateId } : {}),
        stepIndex: i,
        stepName: step.name,
        inputFrom: step.inputFrom,
        deliverable: step.deliverable,
        toolIds: (step.requiredTools ?? []).map((t) => t.id),
      } as CanvasNode["metadata"] & Record<string, unknown>,
    }, 2 + (step.requiredTools?.length ?? 0) + (step.gate ? 1 : 0));
    previousGenerationId = genId;
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
    // 同罪状 8：模板槽位节点也是「摆好的」，不让 layoutGraph 重排。
    moved: true,
    // 同上：槽位佈局也要能被同 workflow 替換清掉。
    metadata: { content: slot.text, workflow_id: template.id },
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
    moved: true,
    metadata: {
      prompt: config.prompt,
      ...(config.qualityProfile ? { quality: config.qualityProfile } : {}),
      count: 1,
      workflow_id: template.id,
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
