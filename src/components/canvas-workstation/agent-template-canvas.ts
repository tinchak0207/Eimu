import { CanvasNodeType, type CanvasConnection, type CanvasNode } from "@/lib/canvas/types";
import { recipeTemplateToRecallConfig } from "@/lib/recipe-templates";
import type { RecipeTemplate } from "@/lib/recipe-templates";
// 2026-09-12 首屏减重拆分：本档是执行侧铺法，需要带 promptNotes/deliverable/
// requiredTools 的完整步骤；显示档的 AgentPipelineStep 只剩卡面环节字段。
// 纯 type import（编译期擦除），不把 payload 的 11 万字文案拉进 bundle。
import type { AgentPipelineFull, AgentPipelineStepFull } from "@/lib/agent-templates-payload";
import type { WorkflowRecallConfig } from "@/lib/workflow-recall";

/**
 * 助理起手模板 → 画布 workflow（2026-08-26 工具链重铺）。
 *
 * 两种铺法：
 * 1. 带 pipeline 蓝图（AgentTemplate）：工业级泳道——每步展开成
 *    「步骤头卡（deliverable 合同）→ 工具卡（每个 requiredTool 一张，
 *    输入/输出/unsupported 明示）→ 门禁卡（有 gate 才铺）→ 生成卡
 *    （短名）」一整排卡片，步骤间按「上一步产出喂下一步」串连；
 *    promptNotes/deliverable/inputFrom/toolIds 全部进生成卡 metadata
 *    给 agent 执行，画布上不铺提示词凑数卡。8 步流水线铺开就是
 *    30-50 颗卡片的生产现场，不是两颗孤节点。
 * 2. 无 pipeline（纯 RecipeTemplate）：旧两层兜底——槽位 Prompt 节点
 *    汇入单颗生成节点。
 */

/** 槽位节点纵向间距：一行卡片高 + 呼吸空隙（旧两层布局用）。 */
const SLOT_GAP_Y = 232;
/** 槽位节点与生成节点的横向间隙。 */
const SLOT_GAP_X = 80;

// ── 工业级泳道几何 ──
/** 卡片统一宽度；高度按内容类型分档。 */
const CARD_W = 300;
const SPEC_H = 170;
const NOTE_H = 150;
const GATE_H = 150;
const GEN_H = 240;
/** 泳道内卡片横向间隙。 */
const CARD_GAP_X = 60;
/** 泳道行高：最高卡（生成 240）+ 呼吸空隙。 */
const LANE_GAP_Y = 330;

/** applyTemplateToCanvas 接受的模板：RecipeTemplate 为底，pipeline 可选（执行完整形态）。 */
export type TemplateCanvasInput = RecipeTemplate & {
  pipeline?: AgentPipelineFull;
  /** VPS agent-harness 已注册的 workflow 模板 id（如 novel_film；2026-08-27）。 */
  harnessTemplateId?: string;
};

interface SlotSpec {
  key: string;
  title: string;
  text: string;
}

/** WorkflowRecallConfig → 槽位文本清单（顺序即画布纵向顺序）。 */
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

/** 要点精炼成生成节点 prompt（进 metadata，不铺凑数卡）。 */
function promptFromNotes(step: AgentPipelineStepFull): string {
  return step.promptNotes.join("，");
}

/** 步骤产出类型 → 画布节点类型（生成卡按此铺，不再一律 Image）。
 *  director（2026-09-03）= 3D 白模预演步，生成卡铺成导演台节点；其余 metadata
 *  （stepIndex/stepName/toolIds/promptNotes…）走与其它步骤同一条生成卡路径，不分支。 */
const GEN_NODE_TYPE: Record<NonNullable<AgentPipelineStepFull["outputKind"]>, CanvasNodeType> = {
  image: CanvasNodeType.Image,
  text: CanvasNodeType.Text,
  video: CanvasNodeType.Video,
  audio: CanvasNodeType.Audio,
  director: CanvasNodeType.Director,
};

/**
 * pipeline 蓝图 → 工业级泳道画布（纯函式，可测）。
 *
 * 2026-08-26 重铺（用户裁定：画布要体现 Agent Harness 的工具链，不是提示词凑数）：
 * 每步一条泳道，卡片序列 = 步骤头卡（这步要产出什么）→ 工具卡（每个
 * requiredTool 一张：输入→输出、unsupported 明示「harness 未接」）→
 * 门禁卡（验收条件）→ 生成卡（短名，携带 promptNotes/deliverable 给 agent）。
 * 旧的 deliverable 拆项卡与 promptNotes 逐条卡（提示词凑数）已删——
 * 它们归入生成卡 metadata，画布上只留「用户一眼看懂流水线」的结构卡。
 */
function pipelineToCanvasLayout(template: TemplateCanvasInput, pipeline: AgentPipelineFull): TemplateCanvasLayout {
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
        // Bug3 前置：泳道上的每一张卡（头卡/工具卡/门禁卡/生成卡）都盖同一个
        // workflow_id 章 —— replaceWorkflowNodes 才能把整条旧泳道一次删净。
        // 只有生成卡带章的话，重点模板会残留 ~90% 的辅助卡。
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

    // ① 步骤头卡：这一步的产出规格（deliverable 全文）——不是提示词，是合同。
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

    // ② 工具卡：每个 requiredTool 一张——用户一眼看到这步用什么工具、
    //    输入喂什么、输出得什么；unsupported 明示（harness 未接，不冒充）。
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

    // ③ 门禁卡：验收条件（有 gate 才铺）。
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

    // ④ 生成卡：短名。promptNotes/deliverable/inputFrom 进 metadata 给 agent，
    //    画布上不铺提示词凑数卡。
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
 * 模板 → 画布节点布局（纯函式，可测）。带 pipeline 走工业级泳道布局；
 * 无 pipeline 走旧两层：每个非空槽一颗 Prompt 节点（连到生成节点时
 * 文本注入为 prompt 前缀——Prompt 节点既有语义），终点一颗空 Image
 * 节点（A4：空节点=生成落地位，原地回填）。
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
    // 同上：槽位布局也要能被同 workflow 替换清掉。
    metadata: { content: slot.text, workflow_id: template.id },
  }));

  const connections: CanvasConnection[] = slotNodes.map((n) => ({
    id: `conn-${n.id}-${imageId}`,
    fromNodeId: n.id,
    toNodeId: imageId,
  }));

  // 连槽位都没有（空模板）= 没有可铺的 workflow，直接回空。
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

/** 铺到画布：走 useCanvasChat 既有的 addNodes（入 reducer、可 undo）。 */
export function applyTemplateToCanvas(
  addNodes: ((nodes: CanvasNode[], connections?: CanvasConnection[]) => void) | undefined,
  template: TemplateCanvasInput,
): void {
  const { nodes, connections } = templateToCanvasLayout(template);
  if (!addNodes || nodes.length === 0) return;
  addNodes(nodes, connections);
}
