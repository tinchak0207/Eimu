import type { AgentSseEvent } from "@/lib/agent-chat-types";
import { isReferenceImageRole } from "@/lib/image-types";
import { normalizeStoryboardSceneRef, normalizeStoryboardShot } from "@/lib/storyboard-contract";
// 批准状态清洗的**唯一收口**：不另写第二把尺——`normalizeApprovalState` 同时服务
// 卡侧（`normalizeCharacterCard`/`setApproval`）与节点侧，两侧值域判据同一份。
import { normalizeApprovalState } from "@/lib/character-cards";
// metadata 白名单的**键集合单一真源**（双白名单铁律：本档与 canvas-chat-types.ts 的
// compactMetadataForAgent 曾各自手工维护键清单，漏一端＝功能静默消失）。
import { DURABLE_METADATA_FIELDS, type DurableFieldSpec, type MetadataCleanerName } from "../node-metadata-fields";
import { normalizeShotCandidates } from "../storyboard-shots";
// 任务版本史（P1-9/D37）的清洗收口＝`./task-versions` 的 `normalizeTaskVersions`，
// 本档只注册（与 shotCandidates 同款：清洗实作在原模组，白名单真源在 node-metadata-fields）。
import { normalizeTaskVersions } from "../task-versions";
import { CANVAS_NODE_DEFAULT_SIZE, CanvasNodeType, type CanvasErrorDetails, type CanvasNode, type CanvasNodeGateConfirm, type CanvasNodeMetadata, type CanvasNodeStatus, type CanvasPosition, type CanvasSseEvent, type Scene3dCardMetadata } from "../types";

// ─────────────────────────────────────────── 事件分流

/** canvas.* = 画布事件；其余进既有 transcript reducer。 */
export function isCanvasEventName(name: string): boolean {
  return name.startsWith("canvas.");
}

/** 纯展示型画布事件（reducer 不吃，UI 直接透传显示）。 */
export type CanvasPassthroughEvent =
  | { name: "canvas.derive.started"; data: { unit_id: string; source_node_id: string; instruction: string; interpretation?: string } }
  | { name: "canvas.budget.updated"; data: { unit_id?: string; used_coins: number; remaining_coins: number } };

/** reducer 吃得下的事件名（会改变 nodes/connections/units）。 */
const REDUCIBLE = new Set([
  "canvas.plan",
  "canvas.node.created",
  "canvas.node.updated",
  "canvas.node.connected",
  "canvas.node.disconnected",
  "canvas.node.generating",
  "canvas.node.deleted",
]);

export function isReducibleCanvasEvent(name: string): boolean {
  return REDUCIBLE.has(name);
}

// ─────────────────────────────────────────── 型别/尺寸正规化

const NODE_TYPES = new Set<string>(Object.values(CanvasNodeType));

/** 未知 type 一律退成 text：画得出来的节点胜过画不出来的正确性。 */
export function toNodeType(raw: unknown): CanvasNodeType {
  return typeof raw === "string" && NODE_TYPES.has(raw) ? (raw as CanvasNodeType) : CanvasNodeType.Text;
}

const STATUSES = new Set<CanvasNodeStatus>(["idle", "success", "loading", "error"]);

/**
 * gateway 的 status 词汇比前端宽（running/pending/queued/failed…）。
 * 映射到四态，UI 才只需要处理四种颜色。
 */
export function toNodeStatus(raw: unknown): CanvasNodeStatus | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  if (STATUSES.has(raw as CanvasNodeStatus)) return raw as CanvasNodeStatus;
  if (raw === "running" || raw === "pending" || raw === "queued" || raw === "generating") return "loading";
  if (raw === "failed" || raw === "error") return "error";
  if (raw === "done" || raw === "succeeded" || raw === "completed") return "success";
  return undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * id 阵列收敛（照 project-store `normalizeProject` 对 `cardIds` 的同一把尺）：
 * 只留非空字串（纯空白＝没指定）、按首次出现序去重；空阵列/非阵列 → undefined（省略键）。
 * 值本身不动（不补不截）——长度界线在写入端，读取端只做形状收敛。
 */
function toIdList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
  return out.length > 0 ? out : undefined;
}

// ─────────────────────────────────────────── 模板实体宣告（2026-09-24）

/**
 * 节点 metadata 的实体宣告键：gateway 模板节点的 `defaults.emitsEntity`
 * （`deploy-staging/gateway/workflow-templates/*`）经 `expandTemplate` spread 进节点
 * metadata，随 SSE `canvas.node.created/updated` 落地；消费端
 * `src/lib/agent-output-cards.ts` 据此自动落成可 @ 引用的实体卡。
 *
 * **本档刻意零依赖**（不 import `character-cards.ts`）：五值字面与该档
 * `CHARACTER_CARD_KIND_VALUES` **逐字同步**，不 import 以避免读取端反向依赖卡模组。
 */
export const EMITS_ENTITY_KINDS = ["character", "scene", "style", "prop", "audio"] as const;
export type EmitsEntityKind = (typeof EMITS_ENTITY_KINDS)[number];

/** 模板实体宣告（形状与 `agent-output-cards.ts` 的 `EmittedEntitySpec` 同构）。 */
export interface EmittedEntityMetadata {
  kind: EmitsEntityKind;
  /** 卡名来源：预设节点标题；`"input"` ＝依序取卡名三键。 */
  nameFrom?: "nodeTitle" | "input";
  /**
   * 参考图来源 role 清单（模板作者宣告，如四视图的 `["view2","view3","view4"]`）：
   * 同模板实例上哪些 role 的交付物算本实体的参考图。单一交付物的实体不写。
   */
  referenceRoles?: string[];
  /**
   * 参考图来源**节点 id** 清单（引擎 `expandTemplate` 的参考图 post-pass 按
   * `referenceRoles` 解出后填入；作者不手写）。站点据此把兄弟节点的交付图并进同一张卡。
   */
  referenceNodeIds?: string[];
}

/**
 * 卡名来源键（`nameFrom: "input"` 时按序取第一个非空字串）——
 * 与 `agent-output-cards.ts` 的 `NAME_FROM_INPUT_KEYS` **逐字同序同步**。
 * 卡名上限 100 与 character-cards / agent-output-cards 的 `MAX_NAME_LENGTH` 同尺。
 */
export const CARD_NAME_KEYS = ["input", "characterName", "sceneName"] as const;
const MAX_CARD_NAME_LENGTH = 100;

/** 卡名收敛：非字串/空字串（含纯空白）→ undefined（省略该键，不写空字串）。 */
export function toCardMetadataName(v: unknown): string | undefined {
  const s = str(v)?.trim();
  return s ? s.slice(0, MAX_CARD_NAME_LENGTH) : undefined;
}

/**
 * `emitsEntity` 内参考图清单（`referenceRoles` / `referenceNodeIds`）的上限：
 *   - 项数 8 ＝ `character-cards.ts` 的 `MAX_CARD_REFERENCES` 同尺（多出来的项在
 *     建卡时本来也会被截，这里先收敛＝上行/存档不搬运永远用不到的字串）
 *   - 单项长度 100 ＝ id 边界同尺（超过者建不出合法 card id，留著只是噪音）
 */
const MAX_ENTITY_REFERENCE_ITEMS = 8;
const MAX_ENTITY_REFERENCE_ITEM_LENGTH = 100;

/**
 * 参考图清单收敛（读取端与上行端共用）：
 *   - 非阵列 → `undefined`（省略键）
 *   - 逐项 trim、只留非空字串、按首次出现序去重、单项截 100 字、项数上限 8
 *   - 收敛后空集合 → `undefined`（**省略键**，不写 `[]`：消费端「没宣告」与「空集合」同义）
 */
function toEntityReferenceList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const s = item.trim().slice(0, MAX_ENTITY_REFERENCE_ITEM_LENGTH);
    if (!s || out.includes(s)) continue;
    out.push(s);
    if (out.length >= MAX_ENTITY_REFERENCE_ITEMS) break;
  }
  return out.length > 0 ? out : undefined;
}

/**
 * `emitsEntity` 保留键的清洗（读取端与上行端共用同一份，不制造第二个漂移点）：
 *   - 非物件（含阵列/字串/数字）→ `undefined`
 *   - `kind` 不在五值域 → **整个丢弃**（**不降格成 character**：这里判的是「这号标记是否
 *     合法」，猜错会建出错 kind 的卡；与 `character-cards.ts` `toCharacterCardKind` 的
 *     fail-open 语义刻意不同）
 *   - `nameFrom` 只认 `"nodeTitle" | "input"`，非法则省略该栏（kind 仍有效）
 *   - `referenceRoles` / `referenceNodeIds`（2026-09-24 四视图聚合）：只收**非空字串
 *     阵列**（trim、去重、单项 ≤100、≤8 项），空集合/非阵列则省略该键
 * 回传**新物件**（不沿用输入参考）：gateway 的 `expandTemplate` 是浅 spread，节点
 * metadata 与模板模组层的 `defaults` 同参考，沿用参考会把原地改写扩散到跨会话
 *（`workflow-engine.ts` 已同步做防御性复制，两处互为保险）。
 */
export function cleanEmitsEntity(v: unknown): EmittedEntityMetadata | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;
  const kind = EMITS_ENTITY_KINDS.find((k) => k === raw.kind);
  if (!kind) return undefined;
  const nameFrom = str(raw.nameFrom);
  // 聚合两键（**双白名单生效的关键一步**）：漏在这里＝键一进前端就被剥掉，
  // 四视图聚合的 `referenceNodeIds` 永远是 undefined（症状＝功能完全没反应）。
  const referenceRoles = toEntityReferenceList(raw.referenceRoles);
  const referenceNodeIds = toEntityReferenceList(raw.referenceNodeIds);
  return {
    kind,
    ...(nameFrom === "nodeTitle" || nameFrom === "input" ? { nameFrom } : {}),
    ...(referenceRoles ? { referenceRoles } : {}),
    ...(referenceNodeIds ? { referenceNodeIds } : {}),
  };
}

/**
 * 文本节点字号（`metadata.fontSize`）的界：**与写入端逐字同尺**
 *（`src/components/canvas/embed/context-menu-items.ts:155/156` 的
 *  `Math.min(28, …)` / `Math.max(10, …)`，缺省 14.5 由渲染层补）。
 */
const MIN_NODE_FONT_SIZE = 10;
const MAX_NODE_FONT_SIZE = 28;

/**
 * 字号收敛（读取端与上行端共用同一份）：
 *   - 只收**有限数字**（`Number.isFinite`：字串 `"22"`／`NaN`／`Infinity`／`null` 一律不收
 *     ——面板写的是 number，字串是历史脏值，不代为转型）
 *   - 四舍五入成整数（面板只写整数；小数是脏值）
 *   - 夹在 10..28（与写入端同一把尺；超界＝收敛到界，不是丢掉）
 * 不合法 → `undefined`（**省略该键**，渲染层回预设 14.5）。
 *
 * 为什么要进白名单：本键原本「session 内可见、重载即消失」（右键放大/缩小字号改的字号
 * 刷新就回默认）；`toNodeMetadata` 是唯一的耐久化路径（fromCanvasProject → … → 本函式）。
 */
export function toNodeFontSize(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.min(MAX_NODE_FONT_SIZE, Math.max(MIN_NODE_FONT_SIZE, Math.round(v)));
}

/** errorDetails 收敛：字串原样；物件只留 message/human_message 两个字串栏位（G-FE 合同），空形丢弃。 */
function toErrorDetails(v: unknown): string | CanvasErrorDetails | undefined {
  const s = str(v);
  if (s !== undefined) return s.length > 0 ? s : undefined;
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const message = str(o.message);
  const human = str(o.human_message);
  if (message === undefined && human === undefined) return undefined;
  return { ...(message !== undefined ? { message } : {}), ...(human !== undefined ? { human_message: human } : {}) };
}

/**
 * 清洗器注册表：**键集合由 `node-metadata-fields.ts` 的 `DURABLE_METADATA_FIELDS` 导出**
 * （逐键列举的清单不在本档），清洗实作留在本档（不搬家＝不动既有 export 与 import 拓扑）。
 * `Record<MetadataCleanerName, …>` 标型：真源新增清洗器名称而这里没实作 → tsc 红
 *（编译期守门件，不是「注释说要同步」）。
 */
const DURABLE_FIELD_CLEANERS: Record<MetadataCleanerName, (raw: unknown) => unknown> = {
  string: str,
  finiteNumber: num,
  nodeStatus: toNodeStatus,
  errorDetails: toErrorDetails,
  // null 是合法值（「目前没有来源图」），字串照收，其余省略。
  sourceImage: (v) => (v === null ? null : str(v)),
  referenceRole: (v) => (isReferenceImageRole(v) ? v : undefined),
  // pipeline 卡型白名单：director（导演台）＋ tool/gate/note（后端 derived 工具卡/门禁卡/
  // 配方卡，kind=text，NodeBody 工具/门禁/配方分支渲染）。未列举值（含 step_head——
  // 前端模板路径直产、后端不送）照旧丢弃。
  pipelineCard: (v) =>
    v === "tool" || v === "gate" || v === "note" || v === "director"
      ? (v as "tool" | "gate" | "note" | "director")
      : undefined,
  // unsupported 是 boolean 旗标——truthy 判断保留 boolean，只过 str() 会剥掉
  //（同 gate boolean 形态的教训）。
  unsupportedFlag: (v) => (v ? true : undefined),
  // gate 两形态（types.ts 注解）：string 门禁全文照走；boolean（workflow-dsl
  // 的「需人工批准」旗标）原样保留，不能只过 str() 否则旗标会被剥掉。
  stringOrTrue: (v) => {
    const s = str(v);
    return s !== undefined ? s : v === true ? true : undefined;
  },
  // planName 明确 null 时保留 null（活卡语义=「目前无方案」）。
  nullableString: (v) => {
    const s = str(v);
    return s !== undefined ? s : v === null ? null : undefined;
  },
  // healthOk 只收真 boolean 两态（绿徽章/琥珀徽章）。
  booleanFlag: (v) => (v === true || v === false ? v : undefined),
  sceneCard: toScene3dCard,
  // 契约清洗函式用 `null` 表示「整包丢弃」，本回圈的 `undefined` 才是「省略键」，
  // 两者语义不同，故显式转换（漏转＝写出 storyboardShot: null 的半形数据）。
  storyboardShot: (v) => normalizeStoryboardShot(v) ?? undefined,
  storyboardScene: (v) => normalizeStoryboardSceneRef(v) ?? undefined,
  // `normalizeShotCandidates` 用 `undefined` 表示「省略键」（空集合/无候选）；
  // 逐条非法候选在函式内丢弃（不连坐整包），`selectedId` 非成员即不收。
  shotCandidates: (v) => normalizeShotCandidates(v),
  idList: toIdList,
  // 落卡幂等标记：trim 后非空才收（纯空白＝没有标记）。
  trimmedString: (v) => {
    const s = str(v)?.trim();
    return s ? s : undefined;
  },
  emitsEntity: cleanEmitsEntity,
  cardName: toCardMetadataName,
  fontSize: toNodeFontSize,
  gateConfirm: toGateConfirm,
  // `normalizeApprovalState` 用 `null` 表示「整包丢弃」（status 不在三值域/非物件），
  // 本回圈的 `undefined` 才是「省略键」——不转换会写出 `approval: null` 的半形状态。
  approval: (v) => normalizeApprovalState(v) ?? undefined,
  // `normalizeTaskVersions` 用 `undefined` 表示「省略键」（空集合/无任务版本）；
  // 逐笔非法在函式内丢弃（不连坐整包），`selectedVersion` 非成员即不收。
  taskVersions: (v) => normalizeTaskVersions(v),
};

/**
 * 把宽松 metadata 收敛成 CanvasNodeMetadata（丢掉不认得的栏位，status 走映射）。
 *
 * **逐键放行清单不写在本档**：唯一真源＝`src/lib/canvas/node-metadata-fields.ts` 的
 * `DURABLE_METADATA_FIELDS`（每个耐久键的清洗器名称与理由都在那里）。
 * 双白名单铁律：本函式（还原端）与 `compactMetadataForAgent`（上行端）任一端漏放行
 * ＝功能静默消失（2026-09-24 `emitsEntity` 事故：当下就被剥，症状是「完全没反应」）。
 *
 * 第二参数只为契约测试的「注入新键、验证缺键可被侦测」而存在；正式呼叫端一律用预设值。
 */
export function toNodeMetadata(
  raw: unknown,
  fields: readonly DurableFieldSpec[] = DURABLE_METADATA_FIELDS,
): CanvasNodeMetadata {
  if (!raw || typeof raw !== "object") return {};
  const m = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const clean = DURABLE_FIELD_CLEANERS[field.cleaner];
    // 未注册清洗器＝fail-closed（不放行、不猜语义）：注入清单写错名称时宁可漏键也不乱放。
    if (!clean) continue;
    const value = clean(m[field.key]);
    if (value !== undefined) out[field.key] = value;
  }
  return out as unknown as CanvasNodeMetadata;
}

/**
 * 门禁卡裁决凭据收敛：三栏型别全对才回物件，否则整包丢弃（同 storyboard 家族写法）。
 *
 * 导出原因＝上行压缩端 `compactMetadataForAgent` 必须走**同一份**清洗（双白名单铁律：
 * 两端各写一份判据＝两个漂移点；`cleanEmitsEntity`/`toCardMetadataName` 同为此而导出）。
 */
export function toGateConfirm(v: unknown): CanvasNodeGateConfirm | undefined {
  if (!v || typeof v !== "object") return undefined;
  const g = v as Record<string, unknown>;
  const requestId = str(g.request_id);
  const sessionId = str(g.session_id);
  const status = g.status === "pending" || g.status === "approved" || g.status === "rejected" ? g.status : undefined;
  if (!requestId || !sessionId || !status) return undefined;
  return { request_id: requestId, session_id: sessionId, status };
}

/**
 * sceneCard 栏位族收敛。
 *
 * 契约（2026-09-27 本机导入刀放宽）：底线＝`glb_path` ＋ `scene_summary` 两栏为非空字串，
 * 其余四栏（turntable_url / stills_urls / blend_path / duration_ms）**可选**——导入卡
 * 只带 GLB 也必须活下来。缺底线任一＝整包丢弃（不制造半形场景卡，负向对照有测试）。
 * 可选栏位照旧逐栏验型：型别不符＝省略该栏，不连坐整包。
 */
function toScene3dCard(v: unknown): Scene3dCardMetadata | undefined {
  if (!v || typeof v !== "object") return undefined;
  const s = v as Record<string, unknown>;
  const glbPath = str(s.glb_path);
  const summary = str(s.scene_summary);
  if (!glbPath || !summary) return undefined;
  const turntableUrl = str(s.turntable_url);
  const blendPath = str(s.blend_path);
  const durationMs = num(s.duration_ms);
  const stills = Array.isArray(s.stills_urls)
    ? s.stills_urls.filter((u): u is string => typeof u === "string")
    : undefined;
  // 来源判别栏位：只收两值枚举（未列举值＝省略键，不连坐整包；卡仍以「无来源标记」存活）。
  const source = s.source === "director" || s.source === "import" ? s.source : undefined;
  return {
    ...(turntableUrl ? { turntable_url: turntableUrl } : {}),
    ...(stills && stills.length > 0 ? { stills_urls: stills } : {}),
    ...(blendPath ? { blend_path: blendPath } : {}),
    glb_path: glbPath,
    scene_summary: summary,
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    ...(source ? { source } : {}),
  };
}

/**
 * 补齐节点契约缺口：type 收敛、尺寸取预设、position 留 (0,0)。
 *
 * position 留 0,0 是刻意的 —— reducer 的 upsertNode 看到 0,0 才会呼叫
 * nextPosition 自动排版。gateway 不给座标，版面权在前端 reducer 一处。
 */
export function normalizeCanvasNode(raw: {
  id: string;
  type: string;
  title: string;
  position?: CanvasPosition;
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
  /** gateway 泳道座标已定局（moved:true）＝ reducer layoutGraph 不得重排。只透传 true。 */
  moved?: boolean;
  /** 软删时间戳（节点级栏位，非 metadata）；只透传非空字串。 */
  deletedAt?: string;
}): CanvasNode {
  const type = toNodeType(raw.type);
  const size = CANVAS_NODE_DEFAULT_SIZE[type];
  return {
    id: raw.id,
    type,
    title: raw.title || size.title,
    position: raw.position && (raw.position.x || raw.position.y) ? raw.position : { x: 0, y: 0 },
    width: num(raw.width) ?? size.width,
    height: num(raw.height) ?? size.height,
    metadata: toNodeMetadata(raw.metadata),
    // moved 是 boolean 旗标——只透传 true（false/缺省不带），同 gate/unsupported 形态教训。
    ...(raw.moved === true ? { moved: true } : {}),
    // 软删标记是节点级栏位（不进 metadata 双白名单）；空字串＝未删。
    ...(str(raw.deletedAt)?.length ? { deletedAt: raw.deletedAt } : {}),
  };
}

/**
 * AgentSseEvent（宽松）→ CanvasSseEvent（reducer 契约）。
 * 非 canvas 事件、或 canvas 事件但 reducer 不吃的（derive/budget）回 null。
 */
export function normalizeCanvasEvent(event: AgentSseEvent): CanvasSseEvent | null {
  switch (event.name) {
    case "canvas.plan":
      return { name: "canvas.plan", data: { ...event.data } };
    case "canvas.node.created": {
      const node = event.data.node;
      if (!node || typeof node.id !== "string" || node.id.length === 0) return null;
      return {
        name: "canvas.node.created",
        data: {
          unit_id: event.data.unit_id,
          node: normalizeCanvasNode(node),
          ...(event.data.target_kind ? { target_kind: event.data.target_kind } : {}),
        },
      };
    }
    case "canvas.node.updated": {
      if (!event.data.node_id) return null;
      const patch = toNodeMetadata(event.data.patch);
      return {
        name: "canvas.node.updated",
        data: {
          unit_id: event.data.unit_id,
          node_id: event.data.node_id,
          patch,
          ...(event.data.url ? { url: event.data.url } : {}),
          ...(typeof event.data.cost_coins === "number" ? { cost_coins: event.data.cost_coins } : {}),
        },
      };
    }
    case "canvas.node.connected": {
      const c = event.data.connection;
      if (!c || !c.id || !c.fromNodeId || !c.toNodeId) return null;
      return {
        name: "canvas.node.connected",
        data: {
          unit_id: event.data.unit_id,
          connection: { id: c.id, fromNodeId: c.fromNodeId, toNodeId: c.toNodeId },
          ...(event.data.target_kind ? { target_kind: event.data.target_kind } : {}),
        },
      };
    }
    case "canvas.node.generating": {
      if (!event.data.node_id) return null;
      return {
        name: "canvas.node.generating",
        data: {
          unit_id: event.data.unit_id,
          node_id: event.data.node_id,
          // reducer 会把 status 原样塞进 metadata，所以这里就先映射成四态之一。
          status: toNodeStatus(event.data.status) ?? "loading",
          ...(typeof event.data.progress === "number" ? { progress: event.data.progress } : {}),
        },
      };
    }
    case "canvas.node.deleted":
      return {
        name: "canvas.node.deleted",
        data: { unit_id: event.data.unit_id, ...(event.data.node_id ? { node_id: event.data.node_id } : {}) },
      };
    case "canvas.node.disconnected":
      return {
        name: "canvas.node.disconnected",
        data: { unit_id: event.data.unit_id, from: event.data.from, to: event.data.to },
      };
    default:
      return null;
  }
}
