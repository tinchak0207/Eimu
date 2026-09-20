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
// 跑批收尾時把整條 workflow 的完成態 POST 給站點，站點要把它落成一條歷史記錄。
// 本節就是那段投影：payload → HistoryEntry 的 workflow 欄位 + 兩個 DAG 陣列。
//
// 為什麼投影放在 lib 而不是 route 裡：route 只該做鑑權、I/O、回應；純資料轉換
// 放 lib 才能在 `node --test` 直接測（本檔已被 generation-workflow.test.ts 覆蓋）。
//
// 為什麼 DAG 陣列「同時」回傳、既存進 workflow 又單獨回：workflow 欄位是歷史
// 記錄的持久形狀（前端讀 dagNodes 畫縮圖），單獨回傳是給 route 立刻丟給
// renderWorkflowDagPng 用，不必從 workflow 欄位再 cast 一次。

/** gateway 推送的節點形狀（欄位名與 workflow-gw.ts 的 map 逐字對齊）。 */
export interface WorkflowRunPushNode {
  id: string;
  role?: string;
  kind?: string;
  title?: string;
  status?: string;
  /** 節點產物（圖片/影片 URL、文本內容）；gateway 可能不給。 */
  content?: string;
  costCoins?: number;
  error?: string;
  /**
   * config 類節點的參數（`{...模板 defaults, ...agent 填的 content[role]}`，
   * 見 workflow-engine.expandTemplate）。記憶庫要存「這條工作流用什麼參數跑」
   * 靠的就是它——`content` 只有 text 節點有，光靠它抽不出 model/size/count。
   */
  metadata?: Record<string, unknown>;
}

/**
 * gateway 推送的連線形狀。**兩種都要吃**：
 *   - `{from, to}`          —— workflow-engine.expandTemplate 展開後的真形狀
 *                              （workflow-engine.ts:155 已把 role 換成 node.id）；
 *   - `{fromRole, toRole}`  —— 模板原始形狀（workflow-templates.ts 的
 *                              WorkflowConnectionSpec），agent 手動加的連線或
 *                              未來 gateway 改推模板層資料時會出現。
 * 兩種混在同一陣列也要各自處理，所以不能先看陣列形狀再整體分支。
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
   * gateway 側 Jev 閘門的結論（`gateWorkflowMemory`）：這條值不值得進記憶庫。
   * `false`＝別沉澱；缺省（舊版 gateway 或 Jev 掛掉）＝照機器判定走。
   * 站點只消費結論，不持有 Jev 憑據。
   */
  memoryWorthPersisting?: boolean;
  /**
   * 記憶庫 ownerKey（該跑批所屬用戶的），由 gateway 從 `state.apiKey` 算出。
   *
   * 為什麼不由站點自行推導：站點只握有推送用的平台級 HARNESS_API_KEY，hash 它
   * 得到的 ownerKey 與 agent 注入記憶用的 per-user key hash **不同**，記憶會寫進
   * 一個 agent 永遠召不到的角落（實測：兩者 hash 不相等）。gateway 的
   * `state.apiKey` 才是那位用戶的派生 key，兩端對同一把 key 做同一套 hash 才收斂。
   *
   * 形狀：24 字元小寫 hex（SHA-256 前 12 bytes）；非此形狀視為無效並回落舊路徑。
   */
  memoryOwnerKeyHash?: string;
}

/** 投影結果：workflow 欄位（落盤用）＋兩個 DAG 陣列（渲染用）。 */
export interface ProjectedWorkflowRun {
  workflow: GenerationWorkflowMetadata;
  dagNodes: DagNodeInput[];
  dagConnections: DagConnectionInput[];
}

// dag-renderer 是純模組（只依賴 dagre），沒有 Next.js / node 原生依賴，
// 因此這裡可以值匯入而不破壞本檔「能被 node --test 直接 import」的前提。
// （型別匯入集中在檔頭，此處只留說明。）

/** 節點 id 清洗：只做「非空字串」這一道，id 由 gateway 生成、不進路徑。 */
function cleanNodeId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 節點投影：缺欄位就沿用 gateway 的語義（title 空字串、status 缺省 pending）。 */
function projectNode(raw: WorkflowRunPushNode): DagNodeInput | null {
  const id = cleanNodeId(raw?.id);
  if (!id) return null;
  const role = typeof raw.role === "string" && raw.role.trim() ? raw.role.trim() : id;
  return {
    id,
    role,
    kind: typeof raw.kind === "string" && raw.kind.trim() ? raw.kind.trim() : "text",
    // 標題缺省用 role：歷史卡的 DAG 縮圖上「沒有標題的方框」比「role 名」難認。
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : role,
    // status 缺省 pending 而非 succeeded：gateway 推的是完成態，但缺值不代表成功，
    // 對缺值說成功就是編造（渲染器只對 "failed" 畫紅框，pending 會是中性外框）。
    status: typeof raw.status === "string" && raw.status.trim() ? raw.status.trim() : "pending",
    ...(typeof raw.costCoins === "number" && Number.isFinite(raw.costCoins) ? { costCoins: raw.costCoins } : {}),
    ...(typeof raw.error === "string" && raw.error.trim() ? { error: raw.error.trim() } : {}),
  };
}

/**
 * 連線正規化：把 `{from,to}` / `{fromRole,toRole}` 兩種形狀一律收斂成
 * `{from: nodeId, to: nodeId}`。
 *
 * role → nodeId 的映射表由節點陣列建（同一 role 取第一個，重複時記 warn 並
 * 只認首見——`workflow-engine.expandTemplate` 的 byRole 也是「後者覆蓋前者」，
 * 但多鏡展開後同 role 原則上只會有一顆；出現兩顆代表資料異常，取首見至少
 * 是穩定的）。
 *
 * 解析不出端點的連線直接丟棄（孤兒邊）——畫到 DAG 上會是一條接不到節點的線，
 * 渲染器本身也會略過，這裡丟掉是讓上游的計數誠實（不回一個含垃圾的陣列）。
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
        console.warn(`[workflow] role "${node.role}" 對應多個節點，連線一律取首見節點。`);
      }
      continue;
    }
    byRole.set(node.role, node.id);
  }
  const nodeIds = new Set(nodes.map((node) => node.id));

  /** 端點解析：先當 nodeId（from/to 形狀），再當 role（fromRole/toRole 形狀）。 */
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
 * 把 gateway 跑批推送 payload 投影成 HistoryEntry 的 workflow 欄位 + DAG 陣列。
 * 純函式、絕不拋錯：呼叫端（route）負責先驗必要欄位。
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

/** 历史记录 id：由 workflowId 派生 = 同一條工作流重複推送只會落到同一條記錄。 */
export function workflowHistoryEntryId(workflowId: string): string {
  return `workflow-${String(workflowId ?? "").trim()}`;
}

/**
 * 從跑批 payload 反推「這條工作流用什麼參數跑」的 config（記憶庫的 body 原料）。
 *
 * 為什麼不能只讀一個欄位：gateway 把參數攤在節點上，沒有單一 config 物件——
 *   - **prompt** 在 text 節點的 `content`（workflow-service 把提示詞灌注進
 *     kind="text" 的節點，見 workflow-service.ts 的 nodeContent 組裝）；
 *   - **model/size/count/kind** 在 config 節點的 `metadata`（expandTemplate 的
 *     `{...defaults, ...content[role]}`，見 workflow-engine.ts:69）。
 * 抽的時候按 kind 分流，並以「第一個有值的為準」——同一模板可能有多個 text/config
 * 節點（多鏡展開會克隆 shotN_gen），取首個代表整條工作流的參數基調。
 *
 * `metadata` 只收純量（字串/數字/布林）與短陣列，避免把整包上游回包塞進記憶
 * body（body 硬上限 2000 字元，見 workflow-memory.ts）。
 */
export function extractWorkflowRunConfig(
  nodes: readonly WorkflowRunPushNode[] | undefined,
): Record<string, unknown> {
  const list = Array.isArray(nodes) ? nodes : [];
  const config: Record<string, unknown> = {};

  const promptNode = list.find((n) => n?.kind === "text" && cleanText(n?.content));
  if (promptNode && cleanText(promptNode.content)) config.prompt = cleanText(promptNode.content);

  // config 節點的 metadata 攤平：`kind` 決定這是圖片還是影片配置，其餘欄位
  //（model/size/count/duration_seconds/unit_price_*）原樣帶上。
  const configNode = list.find((n) => n?.kind === "config" && isRecord(n?.metadata));
  if (configNode && isRecord(configNode.metadata)) {
    for (const [key, value] of Object.entries(configNode.metadata)) {
      if (scalarOrShortArray(value)) config[key] = value;
    }
  }

  // 節點結構本身也是「這條工作流長什麼樣」的一部分：把 role:kind 序列記下來，
  // 讓記憶庫能回答「這條有幾個鏡頭/幾道手續」而不必重讀 DAG。
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

/** 記憶 body 只收純量與短字串陣列；物件/長陣列會把 2000 字元預算吃光。 */
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
