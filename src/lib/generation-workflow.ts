import { SUPPORTED_IMAGE_SIZES } from "./generation-model-catalog";
import type { DagConnectionInput, DagNodeInput } from "./dag-renderer";
import type {
  GenerationWorkflowMetadata,
  ReferenceImage,
  ReferenceImageRole,
  RegionalPromptMetadata,
} from "@/lib/image-types";

export interface GenerationWorkflowOptions {
  schemaVersion?: number;
  contextPrompt?: string;
  negativePrompt?: string;
  negativeHint?: string;
  workflowPreset?: string;
  workflowPresetLabel?: string;
  promptHint?: string;
  productionIntent?: string;
  imageSize?: string;
  imageSizes?: string[];
  aspectRatio?: GenerationWorkflowMetadata["aspectRatio"];
  outputResolution?: GenerationWorkflowMetadata["outputResolution"];
  durationSeconds?: number;
  generateAudio?: boolean;
  styleTemplate?: string;
  qualityProfile?: string;
  seedHint?: string;
  regionalPrompts?: RegionalPromptMetadata[];
  estimatedCredits?: number;
  copies?: number;
  concurrency?: number;
  referenceImageRoles?: Record<string, ReferenceImageRole>;
}

export const WORKFLOW_SCHEMA_VERSION = 2;

function cleanText(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function clampInteger(value: number | undefined, min: number, max: number) {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.round(value as number)));
}

function normalizeCredits(value: number | undefined, copies: number | undefined) {
  return clampInteger(value ?? copies ?? 1, 1, 8) ?? 1;
}

const MAX_REGIONAL_PROMPTS = 8;
const MAX_REGIONAL_PROMPT_LENGTH = 240;
const SUPPORTED_WORKFLOW_IMAGE_SIZES = SUPPORTED_IMAGE_SIZES;

export function normalizeImageSizes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sizes = SUPPORTED_WORKFLOW_IMAGE_SIZES.filter((size) => value.includes(size));
  return sizes.length ? sizes : undefined;
}

export function normalizeRegionalPrompts(
  value: unknown,
): RegionalPromptMetadata[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const prompts = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const text = typeof (item as { text?: unknown }).text === "string"
      ? (item as { text: string }).text.trim().slice(0, MAX_REGIONAL_PROMPT_LENGTH)
      : "";
    if (!text) return [];
    const weight = clampInteger((item as { weight?: number }).weight, 1, 100);
    return [{ text, ...(weight !== undefined ? { weight } : {}) }];
  }).slice(0, MAX_REGIONAL_PROMPTS);
  return prompts.length ? prompts : undefined;
}

export function normalizeGenerationWorkflowMetadata(
  workflow?: GenerationWorkflowMetadata,
): GenerationWorkflowMetadata | undefined {
  if (!workflow || Object.keys(workflow).length === 0) return undefined;
  const copies = clampInteger(workflow.copies, 1, 8);
  const concurrency = clampInteger(workflow.concurrency, 1, 4);
  const regionalPrompts = normalizeRegionalPrompts(workflow.regionalPrompts);
  const imageSizes = normalizeImageSizes(workflow.imageSizes);
  return {
    ...workflow,
    schemaVersion: workflow.schemaVersion ?? WORKFLOW_SCHEMA_VERSION,
    ...(copies ? { copies } : {}),
    ...(concurrency ? { concurrency } : {}),
    ...(regionalPrompts ? { regionalPrompts } : { regionalPrompts: undefined }),
    ...(imageSizes ? { imageSizes } : { imageSizes: undefined }),
    estimatedCredits: normalizeCredits(workflow.estimatedCredits, copies),
  };
}

export function createGenerationWorkflow(
  options: GenerationWorkflowOptions = {},
  referenceImages: ReferenceImage[] = [],
): GenerationWorkflowMetadata | undefined {
  const contextPrompt = cleanText(options.contextPrompt);
  const negativePrompt = cleanText(options.negativePrompt);
  const negativeHint = cleanText(options.negativeHint);
  const workflowPreset = cleanText(options.workflowPreset);
  const workflowPresetLabel = cleanText(options.workflowPresetLabel);
  const promptHint = cleanText(options.promptHint);
  const productionIntent = cleanText(options.productionIntent);
  const imageSize = cleanText(options.imageSize);
  const imageSizes = normalizeImageSizes(options.imageSizes);
  const styleTemplate = cleanText(options.styleTemplate);
  const qualityProfile = cleanText(options.qualityProfile);
  const seedHint = cleanText(options.seedHint);
  const regionalPrompts = normalizeRegionalPrompts(options.regionalPrompts);
  const copies = clampInteger(options.copies, 1, 8);
  const concurrency = clampInteger(options.concurrency, 1, 4);
  const imageMetadata = referenceImages.map((image) => ({
    name: image.name,
    role: image.role ?? options.referenceImageRoles?.[image.id] ?? options.referenceImageRoles?.[image.name] ?? "general",
    size: image.size,
    ...(clampInteger(image.strength, 1, 100) !== undefined
      ? { strength: clampInteger(image.strength, 1, 100) }
      : {}),
    ...(image.sourceResultId ? { sourceResultId: image.sourceResultId } : {}),
    ...(image.sourceGenerationId ? { sourceGenerationId: image.sourceGenerationId } : {}),
  }));

  const workflow: GenerationWorkflowMetadata = {
    schemaVersion: options.schemaVersion ?? WORKFLOW_SCHEMA_VERSION,
    ...(contextPrompt ? { contextPrompt } : {}),
    ...(negativePrompt ? { negativePrompt } : {}),
    ...(negativeHint ? { negativeHint } : {}),
    ...(workflowPreset ? { workflowPreset } : {}),
    ...(workflowPresetLabel ? { workflowPresetLabel } : {}),
    ...(promptHint ? { promptHint } : {}),
    ...(productionIntent ? { productionIntent } : {}),
    ...(imageSize ? { imageSize } : {}),
    ...(imageSizes ? { imageSizes } : {}),
    ...(options.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
    ...(options.outputResolution ? { outputResolution: options.outputResolution } : {}),
    ...(options.durationSeconds ? { durationSeconds: options.durationSeconds } : {}),
    ...(options.generateAudio !== undefined ? { generateAudio: options.generateAudio } : {}),
    ...(styleTemplate ? { styleTemplate } : {}),
    ...(qualityProfile ? { qualityProfile } : {}),
    ...(seedHint ? { seedHint } : {}),
    ...(regionalPrompts ? { regionalPrompts } : {}),
    ...(imageMetadata.length ? { referenceImages: imageMetadata } : {}),
    estimatedCredits: normalizeCredits(options.estimatedCredits, copies),
    ...(copies ? { copies } : {}),
    ...(concurrency ? { concurrency } : {}),
  };

  return Object.keys(workflow).length ? workflow : undefined;
}

// ─────────────────────────── 工作流跑批推送投影（2026-09-20 Phase 2）
//
// gateway（deploy-staging/gateway/workflow-gw.ts:190 pushWorkflowCompletion）在
// 跑批收尾时把整条 workflow 的完成态 POST 给站点，站点要把它落成一条历史记录。
// 本节就是那段投影：payload → HistoryEntry 的 workflow 栏位 + 两个 DAG 阵列。
//
// 为什么投影放在 lib 而不是 route 里：route 只该做鉴权、I/O、回应；纯资料转换
// 放 lib 才能在 `node --test` 直接测（本档已被 generation-workflow.test.ts 覆盖）。
//
// 为什么 DAG 阵列「同时」回传、既存进 workflow 又单独回：workflow 栏位是历史
// 记录的持久形状（前端读 dagNodes 画缩图），单独回传是给 route 立刻丢给
// renderWorkflowDagPng 用，不必从 workflow 栏位再 cast 一次。

/** gateway 推送的节点形状（栏位名与 workflow-gw.ts 的 map 逐字对齐）。 */
export interface WorkflowRunPushNode {
  id: string;
  role?: string;
  kind?: string;
  title?: string;
  status?: string;
  /** 节点产物（图片/影片 URL、文本内容）；gateway 可能不给。 */
  content?: string;
  costCoins?: number;
  error?: string;
  /**
   * config 类节点的参数（`{...模板 defaults, ...agent 填的 content[role]}`，
   * 见 workflow-engine.expandTemplate）。记忆库要存「这条工作流用什么参数跑」
   * 靠的就是它——`content` 只有 text 节点有，光靠它抽不出 model/size/count。
   */
  metadata?: Record<string, unknown>;
}

/**
 * gateway 推送的连线形状。**两种都要吃**：
 *   - `{from, to}`          —— workflow-engine.expandTemplate 展开后的真形状
 *                              （workflow-engine.ts:155 已把 role 换成 node.id）；
 *   - `{fromRole, toRole}`  —— 模板原始形状（workflow-templates.ts 的
 *                              WorkflowConnectionSpec），agent 手动加的连线或
 *                              未来 gateway 改推模板层资料时会出现。
 * 两种混在同一阵列也要各自处理，所以不能先看阵列形状再整体分支。
 */
export interface WorkflowRunPushConnection {
  from?: string;
  to?: string;
  fromRole?: string;
  toRole?: string;
}

export interface WorkflowRunPushPayload {
  workflowId: string;
  templateId?: string;
  sessionId?: string;
  status?: string;
  nodes?: WorkflowRunPushNode[];
  connections?: WorkflowRunPushConnection[];
  totalCostCoins?: number;
  completedAt?: string;
  /**
   * gateway 侧 Jev 闸门的结论（`gateWorkflowMemory`）：这条值不值得进记忆库。
   * `false`＝别沉淀；缺省（旧版 gateway 或 Jev 挂掉）＝照机器判定走。
   * 站点只消费结论，不持有 Jev 凭据。
   */
  memoryWorthPersisting?: boolean;
  /**
   * 记忆库 ownerKey（该跑批所属用户的），由 gateway 从 `state.apiKey` 算出。
   *
   * 为什么不由站点自行推导：站点只握有推送用的平台级 HARNESS_API_KEY，hash 它
   * 得到的 ownerKey 与 agent 注入记忆用的 per-user key hash **不同**，记忆会写进
   * 一个 agent 永远召不到的角落（实测：两者 hash 不相等）。gateway 的
   * `state.apiKey` 才是那位用户的派生 key，两端对同一把 key 做同一套 hash 才收敛。
   *
   * 形状：24 字元小写 hex（SHA-256 前 12 bytes）；非此形状视为无效并回落旧路径。
   */
  memoryOwnerKeyHash?: string;
}

/** 投影结果：workflow 栏位（落盘用）＋两个 DAG 阵列（渲染用）。 */
export interface ProjectedWorkflowRun {
  workflow: GenerationWorkflowMetadata;
  dagNodes: DagNodeInput[];
  dagConnections: DagConnectionInput[];
}

// dag-renderer 是纯模组（只依赖 dagre），没有 Next.js / node 原生依赖，
// 因此这里可以值汇入而不破坏本档「能被 node --test 直接 import」的前提。
// （型别汇入集中在档头，此处只留说明。）

/** 节点 id 清洗：只做「非空字串」这一道，id 由 gateway 生成、不进路径。 */
function cleanNodeId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 节点投影：缺栏位就沿用 gateway 的语义（title 空字串、status 缺省 pending）。 */
function projectNode(raw: WorkflowRunPushNode): DagNodeInput | null {
  const id = cleanNodeId(raw?.id);
  if (!id) return null;
  const role = typeof raw.role === "string" && raw.role.trim() ? raw.role.trim() : id;
  return {
    id,
    role,
    kind: typeof raw.kind === "string" && raw.kind.trim() ? raw.kind.trim() : "text",
    // 标题缺省用 role：历史卡的 DAG 缩图上「没有标题的方框」比「role 名」难认。
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : role,
    // status 缺省 pending 而非 succeeded：gateway 推的是完成态，但缺值不代表成功，
    // 对缺值说成功就是编造（渲染器只对 "failed" 画红框，pending 会是中性外框）。
    status: typeof raw.status === "string" && raw.status.trim() ? raw.status.trim() : "pending",
    ...(typeof raw.costCoins === "number" && Number.isFinite(raw.costCoins) ? { costCoins: raw.costCoins } : {}),
    ...(typeof raw.error === "string" && raw.error.trim() ? { error: raw.error.trim() } : {}),
  };
}

/**
 * 连线正规化：把 `{from,to}` / `{fromRole,toRole}` 两种形状一律收敛成
 * `{from: nodeId, to: nodeId}`。
 *
 * role → nodeId 的映射表由节点阵列建（同一 role 取第一个，重复时记 warn 并
 * 只认首见——`workflow-engine.expandTemplate` 的 byRole 也是「后者覆盖前者」，
 * 但多镜展开后同 role 原则上只会有一颗；出现两颗代表资料异常，取首见至少
 * 是稳定的）。
 *
 * 解析不出端点的连线直接丢弃（孤儿边）——画到 DAG 上会是一条接不到节点的线，
 * 渲染器本身也会略过，这里丢掉是让上游的计数诚实（不回一个含垃圾的阵列）。
 */
export function normalizeWorkflowConnections(
  nodes: DagNodeInput[],
  connections: WorkflowRunPushConnection[] | undefined,
): DagConnectionInput[] {
  if (!Array.isArray(connections) || connections.length === 0) return [];

  const byRole = new Map<string, string>();
  const duplicateRoles = new Set<string>();
  for (const node of nodes) {
    if (byRole.has(node.role)) {
      if (!duplicateRoles.has(node.role)) {
        duplicateRoles.add(node.role);
        console.warn(`[workflow] role "${node.role}" 对应多个节点，连线一律取首见节点。`);
      }
      continue;
    }
    byRole.set(node.role, node.id);
  }
  const nodeIds = new Set(nodes.map((node) => node.id));

  /** 端点解析：先当 nodeId（from/to 形状），再当 role（fromRole/toRole 形状）。 */
  const endpoint = (idValue: unknown, roleValue: unknown): string | undefined => {
    const id = cleanNodeId(idValue);
    if (id && nodeIds.has(id)) return id;
    const role = cleanNodeId(roleValue);
    if (role) return byRole.get(role);
    return undefined;
  };

  const out: DagConnectionInput[] = [];
  const seen = new Set<string>();
  for (const conn of connections) {
    if (!conn || typeof conn !== "object") continue;
    const from = endpoint(conn.from, conn.fromRole);
    const to = endpoint(conn.to, conn.toRole);
    if (!from || !to || from === to) continue;
    const key = `${from}→${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from, to });
  }
  return out;
}

/**
 * 把 gateway 跑批推送 payload 投影成 HistoryEntry 的 workflow 栏位 + DAG 阵列。
 * 纯函式、绝不抛错：呼叫端（route）负责先验必要栏位。
 */
export function projectWorkflowRunToHistory(payload: WorkflowRunPushPayload): ProjectedWorkflowRun {
  const rawNodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  const dagNodes = rawNodes
    .map((node) => projectNode(node))
    .filter((node): node is DagNodeInput => node !== null);

  const dagConnections = normalizeWorkflowConnections(dagNodes, payload?.connections);

  const totalCostCoins =
    typeof payload?.totalCostCoins === "number" && Number.isFinite(payload.totalCostCoins)
      ? payload.totalCostCoins
      : undefined;

  const workflow: GenerationWorkflowMetadata = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    ...(cleanText(payload?.templateId) ? { workflowPreset: cleanText(payload?.templateId) } : {}),
    ...(cleanText(payload?.templateId) ? { templateId: cleanText(payload?.templateId) } : {}),
    ...(cleanText(payload?.workflowId) ? { workflowId: cleanText(payload?.workflowId) } : {}),
    ...(totalCostCoins !== undefined ? { totalCostCoins } : {}),
    ...(dagNodes.length ? { dagNodes } : {}),
    ...(dagConnections.length ? { dagConnections } : {}),
  };

  return { workflow, dagNodes, dagConnections };
}

/** 历史记录 id：由 workflowId 派生 = 同一条工作流重复推送只会落到同一条记录。 */
export function workflowHistoryEntryId(workflowId: string): string {
  return `workflow-${String(workflowId ?? "").trim()}`;
}

/**
 * 从跑批 payload 反推「这条工作流用什么参数跑」的 config（记忆库的 body 原料）。
 *
 * 为什么不能只读一个栏位：gateway 把参数摊在节点上，没有单一 config 物件——
 *   - **prompt** 在 text 节点的 `content`（workflow-service 把提示词灌注进
 *     kind="text" 的节点，见 workflow-service.ts 的 nodeContent 组装）；
 *   - **model/size/count/kind** 在 config 节点的 `metadata`（expandTemplate 的
 *     `{...defaults, ...content[role]}`，见 workflow-engine.ts:69）。
 * 抽的时候按 kind 分流，并以「第一个有值的为准」——同一模板可能有多个 text/config
 * 节点（多镜展开会克隆 shotN_gen），取首个代表整条工作流的参数基调。
 *
 * `metadata` 只收纯量（字串/数字/布林）与短阵列，避免把整包上游回包塞进记忆
 * body（body 硬上限 2000 字元，见 workflow-memory.ts）。
 */
export function extractWorkflowRunConfig(
  nodes: readonly WorkflowRunPushNode[] | undefined,
): Record<string, unknown> {
  const list = Array.isArray(nodes) ? nodes : [];
  const config: Record<string, unknown> = {};

  const promptNode = list.find((n) => n?.kind === "text" && cleanText(n?.content));
  if (promptNode && cleanText(promptNode.content)) config.prompt = cleanText(promptNode.content);

  // config 节点的 metadata 摊平：`kind` 决定这是图片还是影片配置，其余栏位
  //（model/size/count/duration_seconds/unit_price_*）原样带上。
  const configNode = list.find((n) => n?.kind === "config" && isRecord(n?.metadata));
  if (configNode && isRecord(configNode.metadata)) {
    for (const [key, value] of Object.entries(configNode.metadata)) {
      if (scalarOrShortArray(value)) config[key] = value;
    }
  }

  // 节点结构本身也是「这条工作流长什么样」的一部分：把 role:kind 序列记下来，
  // 让记忆库能回答「这条有几个镜头/几道手续」而不必重读 DAG。
  const shape = list
    .map((n) => {
      const role = cleanText(n?.role);
      const kind = cleanText(n?.kind);
      if (role && kind) return `${role}:${kind}`;
      return role ?? kind ?? "";
    })
    .filter(Boolean);
  if (shape.length) config.nodeShape = shape.slice(0, 40);

  return config;
}

/** 记忆 body 只收纯量与短字串阵列；物件/长阵列会把 2000 字元预算吃光。 */
function scalarOrShortArray(value: unknown): boolean {
  if (typeof value === "string") return value.length <= 600;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length <= 16 && value.every((v) => typeof v === "string" || typeof v === "number");
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function buildWorkflowPrompt(
  prompt: string,
  workflow?: GenerationWorkflowMetadata,
) {
  const basePrompt = prompt.trim();
  if (!workflow) return basePrompt;

  const sections = [
    workflow.contextPrompt?.trim() ? `Project context:\n${workflow.contextPrompt.trim()}` : "",
    basePrompt ? `Prompt:\n${basePrompt}` : "",
    workflow.workflowPreset?.trim()
      ? `Workflow preset: ${(workflow.workflowPresetLabel ?? workflow.workflowPreset).trim()}`
      : "",
    workflow.promptHint?.trim() ? `Preset guidance:\n${workflow.promptHint.trim()}` : "",
    workflow.regionalPrompts?.length
      ? `Regional requirements (apply to the matching part of the image):\n${workflow.regionalPrompts
          .map((item, index) => `${index + 1}. ${item.text}${item.weight !== undefined ? ` (importance ${item.weight}%)` : ""}`)
          .join("\n")}`
      : "",
    [workflow.productionIntent, workflow.imageSize, workflow.qualityProfile, workflow.seedHint].some((item) => item?.trim())
      ? `Production profile:\n${[
          workflow.productionIntent?.trim() ? `Intent: ${workflow.productionIntent.trim()}` : "",
          workflow.imageSize?.trim() ? `Size: ${workflow.imageSize.trim()}` : "",
          workflow.qualityProfile?.trim() ? `Quality: ${workflow.qualityProfile.trim()}` : "",
          workflow.seedHint?.trim() ? `Seed hint: ${workflow.seedHint.trim()}` : "",
        ].filter(Boolean).join("\n")}`
      : "",
    workflow.referenceImages?.length
      ? `Reference images:\n${workflow.referenceImages
          .map((image) => `- ${image.name} as ${image.role}${image.strength !== undefined ? ` (influence ${image.strength}%)` : ""}`)
          .join("\n")}`
      : "",
    [workflow.negativeHint, workflow.negativePrompt].some((item) => item?.trim())
      ? `Avoid:\n${[workflow.negativeHint, workflow.negativePrompt]
          .map((item) => item?.trim())
          .filter(Boolean)
          .join("\n")}`
      : "",
  ].filter(Boolean);

  return sections.join("\n\n");
}
