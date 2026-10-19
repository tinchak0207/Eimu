// 画布纯函式层：事件分流、事件正规化、几何、历史快照、专案序列化。
//
// 为什么要有这一层：gateway 的 canvas.* payload 是「宽松解析」过的
// （src/lib/agent-chat-types.ts 的 AgentCanvas* 型别：node 只有 id/type/title/metadata，
// 没有 position/width/height），而 src/lib/canvas/reducer.ts 吃的是完整的 CanvasNode。
// 中间这一步转换必须是纯函式，否则 React 元件里混进契约补齐逻辑，测不了也讲不清。
//
// 排版座标一律留 (0,0) 交给 reducer 的 nextPosition 决定（PRD §5：不允许在
// reducer 外再写一套排版）。这里只补「尺寸」与「型别」这种契约缺口。

import type { AgentSseEvent } from "@/lib/agent-chat-types";
import { isValidCreationStep, MAX_EPISODES_PER_PROJECT } from "@/lib/creation-flow-steps";
import { isReferenceImageRole } from "@/lib/image-types";
import { normalizeStoryboardSceneRef, normalizeStoryboardShot } from "@/lib/storyboard-contract";
// 批准状态清洗的**唯一收口**：不另写第二把尺——`normalizeApprovalState` 同时服务
// 卡侧（`normalizeCharacterCard`/`setApproval`）与节点侧，两侧值域判据同一份。
import { normalizeApprovalState } from "@/lib/character-cards";
import type { CanvasReducerState } from "./reducer";
// metadata 白名单的**键集合单一真源**（双白名单铁律：本档与 canvas-chat-types.ts 的
// compactMetadataForAgent 曾各自手工维护键清单，漏一端＝功能静默消失）。
import {
  DURABLE_METADATA_FIELDS,
  type DurableFieldSpec,
  type MetadataCleanerName,
} from "./node-metadata-fields";
// 版本清单清洗与 project-store 共用同一份（逐项白名单＋裁剪；不制造第二个漂移点）。
import { normalizeNodeVersions } from "./node-versions";
// 风格 id 值域的唯一判据（＝STYLE_LIBRARY 注册面），与 project-store/生成端共用同一份。
import { normalizeProjectStyleId } from "./project-style";
// 解说剧设定（P1-5／D7）：型别值域＋旁白音色值域的唯一清洗入口（与 project-style 同地位）。
import { normalizeProjectNarration, type CanvasScriptType } from "./project-narration";
import { normalizeShotCandidates } from "./storyboard-shots";
// 任务版本史（P1-9/D37）的清洗收口＝`./task-versions` 的 `normalizeTaskVersions`，
// 本档只注册（与 shotCandidates 同款：清洗实作在原模组，白名单真源在 node-metadata-fields）。
import { normalizeTaskVersions } from "./task-versions";
import {
  CANVAS_NODE_DEFAULT_SIZE,
  CanvasNodeType,
  isCanvasProjectType,
  type CanvasConnection,
  type CanvasEpisode,
  type CanvasErrorDetails,
  type CanvasNode,
  type CanvasNodeGateConfirm,
  type CanvasNodeMetadata,
  type CanvasNodeStatus,
  type CanvasPosition,
  type CanvasProject,
  type CanvasProjectMetaPatch,
  type CanvasProjectType,
  type CanvasSseEvent,
  type CanvasViewport,
  type Scene3dCardMetadata,
} from "./types";

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

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
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

// ─────────────────────────────────────────── canvas_state 摘要（上送 gateway）

export interface CanvasStateSummaryNode {
  id: string;
  type: string;
  title: string;
  status?: CanvasNodeStatus;
  model?: string;
  size?: string;
  cost_coins?: number;
}

export interface CanvasStateSummary {
  nodes: CanvasStateSummaryNode[];
  connections: { id: string; fromNodeId: string; toNodeId: string }[];
  units: { unit_id: string; tool: string; node_count: number }[];
}

/** 摘要上限：画布可以有 500 个节点，但没必要把 500 个都塞进每一次 send。 */
export const CANVAS_SUMMARY_MAX_NODES = 60;

/**
 * 连线上限。连线数不受节点上限约束——实测 53 个节点挂了 676 条线，光 connections
 * 就 123KB、整份摘要 128.8KB。而 send 的 canvas_state 在中继层超过 128KB 会被挡成
 * 400「画布摘要过大」，挡掉的是**整则讯息**：使用者每发必败，会话就此发不出话。
 * 与节点同理，只留最后 N 条。
 */
export const CANVAS_SUMMARY_MAX_CONNECTIONS = 120;

/**
 * 纯 metadata 摘要，**永不含图片 base64／dataURL**。
 * content 一律不带：图节点的 content 是 URL、文本节点的 content 是整段 prompt，
 * 两者都可能很长，而 gateway 要的只是「画布上有什么」。
 */
export function summarizeCanvasState(state: CanvasReducerState): CanvasStateSummary {
  const nodes = state.nodes.slice(-CANVAS_SUMMARY_MAX_NODES).map((n) => ({
    id: n.id,
    type: String(n.type),
    title: n.title,
    ...(n.metadata?.status ? { status: n.metadata.status } : {}),
    ...(n.metadata?.model ? { model: n.metadata.model } : {}),
    ...(n.metadata?.size ? { size: n.metadata.size } : {}),
    ...(typeof n.metadata?.cost_coins === "number" ? { cost_coins: n.metadata.cost_coins } : {}),
  }));
  const kept = new Set(nodes.map((n) => n.id));
  return {
    nodes,
    connections: state.connections
      .filter((c) => kept.has(c.fromNodeId) && kept.has(c.toNodeId))
      .slice(-CANVAS_SUMMARY_MAX_CONNECTIONS)
      .map((c) => ({ id: c.id, fromNodeId: c.fromNodeId, toNodeId: c.toNodeId })),
    units: state.units.map((u) => ({ unit_id: u.unitId, tool: u.tool, node_count: u.nodes.length })),
  };
}

// ─────────────────────────────────────────── 视口几何

export const CANVAS_MIN_SCALE = 0.05;
export const CANVAS_MAX_SCALE = 5;
export const CANVAS_GRID_BASE = 48;

export function clampScale(k: number): number {
  if (!Number.isFinite(k)) return 1;
  return Math.min(CANVAS_MAX_SCALE, Math.max(CANVAS_MIN_SCALE, k));
}

/** 滚轮缩放：factor = 1.1^(-deltaY/100)，锚点固定在游标下的世界座标。 */
export function zoomAtPoint(vp: CanvasViewport, deltaY: number, px: number, py: number): CanvasViewport {
  const factor = Math.pow(1.1, -deltaY / 100);
  const k = clampScale(vp.k * factor);
  if (k === vp.k) return vp;
  // 游标下的世界点在缩放前后必须落在同一个萤幕位置：
  //   world = (screen - translate) / k  → translate' = screen - world * k'
  const worldX = (px - vp.x) / vp.k;
  const worldY = (py - vp.y) / vp.k;
  return { x: px - worldX * k, y: py - worldY * k, k };
}

export function screenToWorld(vp: CanvasViewport, px: number, py: number): CanvasPosition {
  return { x: (px - vp.x) / vp.k, y: (py - vp.y) / vp.k };
}

export function worldToScreen(vp: CanvasViewport, wx: number, wy: number): CanvasPosition {
  return { x: wx * vp.k + vp.x, y: wy * vp.k + vp.y };
}

export interface CanvasBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/** 小地图的世界范围：节点 min/max 各留 pad（PRD §7.4 预设 ±500）。 */
export function computeWorldBounds(nodes: CanvasNode[], pad = 500): CanvasBounds {
  if (nodes.length === 0) {
    return { minX: -pad, minY: -pad, maxX: pad, maxY: pad, width: pad * 2, height: pad * 2 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + n.width);
    maxY = Math.max(maxY, n.position.y + n.height);
  }
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * 「可读缩放」下限：全图 fit 低于它时宁可不显示全部，也要保证节点文字可读。
 * 项目负责人原则：一进来就要看到清楚的内容，而不是缩成一团的整张图。
 */
export const CANVAS_READABLE_MIN_SCALE = 0.85;

/** 把整张画布带进视口（含边距），回新的 viewport。
 *  minScale > 0 时是「可读优先」模式：全图 fit 的缩放低于 minScale，
 *  改用 minScale 并把视口对齐内容开头（第一个/上游节点清晰可见），
 *  其余节点平移查看——不会出现「小到看不清」的整图缩略。 */
export function fitToNodes(
  nodes: CanvasNode[],
  viewportWidth: number,
  viewportHeight: number,
  padding = 80,
  minScale = 0,
): CanvasViewport {
  if (nodes.length === 0 || viewportWidth <= 0 || viewportHeight <= 0) return { x: 0, y: 0, k: 1 };
  const b = computeWorldBounds(nodes, 0);
  const kFit = clampScale(
    Math.min((viewportWidth - padding * 2) / Math.max(b.width, 1), (viewportHeight - padding * 2) / Math.max(b.height, 1)),
  );
  const k = clampScale(Math.max(kFit, minScale));
  if (k === kFit) {
    return {
      x: viewportWidth / 2 - (b.minX + b.width / 2) * k,
      y: viewportHeight / 2 - (b.minY + b.height / 2) * k,
      k,
    };
  }
  // 全图 fit 太小：放大到可读缩放，视口对齐内容左上（padding 边距），
  // 让上游第一个节点（剧本/描述）清晰可见。
  return {
    x: padding - b.minX * k,
    y: padding - b.minY * k,
    k,
  };
}

/** 贝兹连线：方向自适应（水平邻居走侧出侧入、垂直重叠邻居走底出顶入、
    长距离前向跳线走顶部拱桥，消除垂直节点反折大耳朵与长线拦腰穿透中间卡片；
    反向连线不再绕一大圈回来）。 */
export function bezierPath(from: CanvasNode, to: CanvasNode): string {
  const fromRight = from.position.x + from.width;
  const toRight = to.position.x + to.width;
  const fromBottom = from.position.y + from.height;
  const toBottom = to.position.y + to.height;

  // 垂直相邻/重叠判断：两节点水平范围有交集（例如同列堆叠），且垂直有间隔
  const horizontalOverlap = !(fromRight <= to.position.x || toRight <= from.position.x);
  if (horizontalOverlap && (fromBottom <= to.position.y || toBottom <= from.position.y)) {
    const downward = fromBottom <= to.position.y;
    const x1 = from.position.x + from.width / 2;
    const y1 = downward ? fromBottom : from.position.y;
    const x2 = to.position.x + to.width / 2;
    const y2 = downward ? to.position.y : toBottom;
    const c = Math.min(Math.max(Math.abs(y2 - y1) * 0.5, 30), 120);
    const dir = downward ? 1 : -1;
    return `M ${x1} ${y1} C ${x1} ${y1 + dir * c}, ${x2} ${y2 - dir * c}, ${x2} ${y2}`;
  }

  // 长距离前向跳线（边缘净距塞得下一整张卡）：水平中线直连会拦腰穿透中间
  // 栏位的卡片——改走顶部拱桥（顶心出、拱顶跨越、顶心入），上方净空零穿透。
  const forward = from.position.x + from.width / 2 <= to.position.x + to.width / 2;
  const xExit = forward ? fromRight : from.position.x;
  const xEnter = forward ? to.position.x : toRight;
  if (forward && xEnter - xExit > 340) {
    const x1 = from.position.x + from.width / 2;
    const y1 = from.position.y;
    const x2 = to.position.x + to.width / 2;
    const y2 = to.position.y;
    const peak = Math.min(y1, y2) - Math.min(200, 80 + Math.abs(x2 - x1) * 0.08);
    return `M ${x1} ${y1} C ${x1} ${peak}, ${x2} ${peak}, ${x2} ${y2}`;
  }

  const y1 = from.position.y + from.height / 2;
  const y2 = to.position.y + to.height / 2;
  const x1 = forward ? fromRight : from.position.x;
  const x2 = forward ? to.position.x : toRight;
  const c = Math.min(Math.max(Math.abs(x2 - x1) * 0.5, 50), 200);
  const dir = forward ? 1 : -1;
  return `M ${x1} ${y1} C ${x1 + dir * c} ${y1}, ${x2 - dir * c} ${y2}, ${x2} ${y2}`;
}

/** 网格背景：gridSize 跟著缩放走，backgroundPosition 取视口的模，格线才不会漂。 */
export function gridBackground(vp: CanvasViewport, mode: "dots" | "lines" | "blank"): {
  backgroundImage?: string;
  backgroundSize?: string;
  backgroundPosition?: string;
} {
  if (mode === "blank") return {};
  const size = CANVAS_GRID_BASE * vp.k;
  if (size < 6) return {}; // 缩太小时格线变噪点，直接不画
  const offsetX = ((vp.x % size) + size) % size;
  const offsetY = ((vp.y % size) + size) % size;
  if (mode === "lines") {
    return {
      backgroundImage:
        "linear-gradient(to right, rgba(0,0,0,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,0,0,0.06) 1px, transparent 1px)",
      backgroundSize: `${size}px ${size}px`,
      backgroundPosition: `${offsetX}px ${offsetY}px`,
    };
  }
  return {
    backgroundImage: "radial-gradient(circle, rgba(0,0,0,0.13) 1px, transparent 1px)",
    backgroundSize: `${size}px ${size}px`,
    backgroundPosition: `${offsetX}px ${offsetY}px`,
  };
}

// ─────────────────────────────────────────── 历史快照（undo/redo）

export interface CanvasSnapshot {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  viewport: CanvasViewport;
  /**
   * 软删节点（2026-09-27）：undo/redo 快照也要带，否则「删除→撤销」后
   * deletedNodes 会残留一份已回到节点清单的重复项。optional＝旧快照相容。
   */
  deletedNodes?: CanvasNode[];
}

export interface CanvasHistory {
  past: CanvasSnapshot[];
  future: CanvasSnapshot[];
}

export const CANVAS_HISTORY_LIMIT = 50;
export const CANVAS_EMPTY_HISTORY: CanvasHistory = { past: [], future: [] };

/** 推一格快照。任何新动作都会清空 future（分岔后旧的 redo 已经没有意义）。 */
export function pushSnapshot(history: CanvasHistory, snapshot: CanvasSnapshot): CanvasHistory {
  const past = [...history.past, snapshot];
  return { past: past.slice(Math.max(0, past.length - CANVAS_HISTORY_LIMIT)), future: [] };
}

/** 撤销：把 current 推进 future，回上一格。没得撤销时回 null。 */
export function undoSnapshot(
  history: CanvasHistory,
  current: CanvasSnapshot,
): { history: CanvasHistory; snapshot: CanvasSnapshot } | null {
  if (history.past.length === 0) return null;
  const snapshot = history.past[history.past.length - 1];
  return {
    history: { past: history.past.slice(0, -1), future: [current, ...history.future].slice(0, CANVAS_HISTORY_LIMIT) },
    snapshot,
  };
}

/** 重做：把 current 推回 past，回 future 的第一格。没得重做时回 null。 */
export function redoSnapshot(
  history: CanvasHistory,
  current: CanvasSnapshot,
): { history: CanvasHistory; snapshot: CanvasSnapshot } | null {
  if (history.future.length === 0) return null;
  const snapshot = history.future[0];
  return {
    history: { past: [...history.past, current].slice(-CANVAS_HISTORY_LIMIT), future: history.future.slice(1) },
    snapshot,
  };
}

// ─────────────────────────────────────────── 专案序列化（Blob / 汇出汇入）

/** reducer state + 视口 → 可存的 CanvasProject。 */
export function toCanvasProject(
  base: { id: string; title: string; createdAt?: string },
  state: CanvasReducerState,
  viewport: CanvasViewport,
  backgroundMode: "dots" | "lines" | "blank",
  budget?: { totalCoins: number; usedCoins: number },
  cardIds?: string[],
  // 作品/剧集三级状态机（2026-09-15 刀 1 前端接线）：照 cardIds 的既有条件展开范式。
  // 刻意「不清洗」——清洗单一真源在 project-store 的 normalizeProject，
  // 这里只决定「要不要带这个栏位」，否则两处白名单会漂移（见 PRD §3）。
  projectType?: CanvasProjectType,
  currentStep?: number,
  episodes?: CanvasEpisode[],
  // 专案级风格绑定（P1-8／D34）：同样「不清洗」，只决定要不要带键 ——
  // 注册面判据在 project-store 的 normalizeProject（呼叫 normalizeProjectStyleId）。
  styleId?: string,
  // 解说剧设定（P1-5／D7）：第 11、12 个位置参数（照三栏/风格先例往后追加）。
  // 同样「不清洗」——只决定要不要带键，值域判据在 project-store 的 normalizeProject
  // （呼叫 normalizeProjectNarration）。
  scriptType?: string,
  narrationVoice?: string,
): CanvasProject {
  const now = new Date().toISOString();
  // 风格 id 只在此判「有没有合法值」；非法/未知 id 不落盘（落盘端 normalizeProject 同一把尺）。
  const projectStyleId = normalizeProjectStyleId(styleId);
  const narration = normalizeProjectNarration({ scriptType, narrationVoice });
  return {
    id: base.id,
    title: base.title || "未命名画布",
    createdAt: base.createdAt ?? now,
    updatedAt: now,
    // 软删节点仍要落盘（否则 restore API/还原撤销都找不到资料）：
    // 带 deletedAt 随 nodes 一起存，读取端 fromCanvasProject 再拆回 deletedNodes。
    nodes:
      state.deletedNodes && state.deletedNodes.length > 0
        ? [...state.nodes, ...state.deletedNodes]
        : state.nodes,
    connections: state.connections,
    viewport,
    backgroundMode,
    ...(budget ? { budget } : {}),
    ...(cardIds && cardIds.length > 0 ? { cardIds } : {}),
    ...(projectType ? { projectType } : {}),
    ...(isValidCreationStep(currentStep) ? { currentStep } : {}),
    ...(episodes && episodes.length > 0 ? { episodes } : {}),
    // 风格绑定（P1-8／D34）：有合法 id 才带键；缺栏＝无绑定（旧专案形状不变）。
    ...(projectStyleId ? { styleId: projectStyleId } : {}),
    // 解说剧设定（P1-5／D7）：有值才带键；缺栏＝未宣告（旧专案形状不变）。
    ...(narration.scriptType ? { scriptType: narration.scriptType } : {}),
    ...(narration.narrationVoice ? { narrationVoice: narration.narrationVoice } : {}),
    // 版本历史（2026-09-27）：有版本才带键，旧专案形状不变。
    ...(state.nodeVersions && state.nodeVersions.length > 0 ? { nodeVersions: state.nodeVersions } : {}),
  };
}

/**
 * CanvasProject → reducer state。units 一律回空阵列：
 * 单元是「这次会话的生成批次」，跨刷新没有意义，节点/连线才是画布本体。
 */
export function fromCanvasProject(project: {
  nodes?: unknown;
  connections?: unknown;
  nodeVersions?: unknown;
}): CanvasReducerState {
  const rawNodes = Array.isArray(project.nodes) ? project.nodes : [];
  const allNodes = rawNodes.flatMap((n) => {
    if (!n || typeof n !== "object") return [];
    const r = n as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id.length === 0) return [];
    const node = normalizeCanvasNode({
      id: r.id,
      type: String(r.type ?? ""),
      title: String(r.title ?? ""),
      ...(r.position && typeof r.position === "object"
        ? { position: r.position as CanvasPosition }
        : {}),
      ...(num(r.width) !== undefined ? { width: num(r.width) } : {}),
      ...(num(r.height) !== undefined ? { height: num(r.height) } : {}),
      ...(r.metadata && typeof r.metadata === "object" ? { metadata: r.metadata as Record<string, unknown> } : {}),
      ...(typeof r.deletedAt === "string" && r.deletedAt.length > 0 ? { deletedAt: r.deletedAt } : {}),
    });
    // 存档里的座标要原样还原（normalizeCanvasNode 只在缺座标时给 0,0）。
    const pos = r.position as CanvasPosition | undefined;
    return [pos && num(pos.x) !== undefined && num(pos.y) !== undefined ? { ...node, position: { x: pos.x, y: pos.y } } : node];
  });
  // 软删节点（有 deletedAt）不进可见 nodes，收进 deletedNodes（可经 restore 还原）。
  const nodes = allNodes.filter((n) => !n.deletedAt);
  const deletedNodes = allNodes.filter((n) => n.deletedAt);
  const ids = new Set(nodes.map((n) => n.id));
  const rawConns = Array.isArray(project.connections) ? project.connections : [];
  const connections = rawConns.flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const r = c as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.fromNodeId !== "string" || typeof r.toNodeId !== "string") return [];
    // 悬空连线不还原：一头找不到节点的线画出来是一条指向虚空的曲线。
    if (!ids.has(r.fromNodeId) || !ids.has(r.toNodeId)) return [];
    return [{ id: r.id, fromNodeId: r.fromNodeId, toNodeId: r.toNodeId }];
  });
  const nodeVersions = normalizeNodeVersions(project.nodeVersions);
  return {
    units: [],
    nodes,
    connections,
    ...(deletedNodes.length > 0 ? { deletedNodes } : {}),
    ...(nodeVersions ? { nodeVersions } : {}),
  };
}

/**
 * 读取侧防炸校验：只确认「型别不会让下游炸」，不重复 project-store 的完整清洗。
 *
 * 分工（勿混）：store `normalizeProject` 是落盘白名单（截断字串、补时间戳、
 * episodeNo 去重、上限 200）；这里是从任意 JSON（快照/汇入档/旧 Blob）取用时的
 * 最小防护——非法项一律丢弃，绝不捏造栏位。两者刻意不共用，避免读取路径反向
 * 影响落盘语义。
 */
function readEpisode(payload: unknown): CanvasEpisode | null {
  if (!payload || typeof payload !== "object") return null;
  const e = payload as Record<string, unknown>;
  if (typeof e.id !== "string" || e.id.length === 0) return null;
  if (typeof e.title !== "string" || e.title.length === 0) return null;
  if (typeof e.episodeNo !== "number" || !Number.isInteger(e.episodeNo) || e.episodeNo < 1) return null;
  if (e.status !== "draft" && e.status !== "processing" && e.status !== "finished") return null;
  return {
    id: e.id,
    episodeNo: e.episodeNo,
    title: e.title,
    status: e.status,
    ...(typeof e.script === "string" ? { script: e.script } : {}),
    createdAt: typeof e.createdAt === "string" ? e.createdAt : "",
    updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : "",
  };
}

/**
 * 从 CanvasProject 取出专案级栏位（给 hook 还原用；缺栏位/非法值一律省略）。
 *
 * 刻意独立于 `fromCanvasProject`：后者回 `CanvasReducerState`（只有 nodes/connections/
 * units），改它的回传型别会炸一票消费端；三栏是「专案级」状态，不是 reducer 状态。
 * （`styleId` 是同一批专案级栏位的第四员，P1-8／D34；`scriptType`／`narrationVoice` 是
 * 第五、六员，P1-5／D7；合法性判据共用 `project-style.ts` 与 `project-narration.ts`。）
 */
export function canvasProjectMeta(project: {
  projectType?: unknown;
  currentStep?: unknown;
  episodes?: unknown;
  styleId?: unknown;
  scriptType?: unknown;
  narrationVoice?: unknown;
}): {
  projectType?: CanvasProjectType;
  currentStep?: number;
  episodes?: CanvasEpisode[];
  styleId?: string;
  scriptType?: CanvasScriptType;
  narrationVoice?: string;
} {
  if (!project || typeof project !== "object") return {};
  const episodes = Array.isArray(project.episodes)
    ? project.episodes.flatMap((item) => {
        const episode = readEpisode(item);
        return episode ? [episode] : [];
      })
    : [];
  const styleId = normalizeProjectStyleId(project.styleId);
  // 解说剧设定（P1-5／D7）：清洗入口与落盘端同一份（逐栏独立、非法省略该键）。
  const narration = normalizeProjectNarration({ scriptType: project.scriptType, narrationVoice: project.narrationVoice });
  return {
    ...(isCanvasProjectType(project.projectType) ? { projectType: project.projectType } : {}),
    ...(isValidCreationStep(project.currentStep) ? { currentStep: project.currentStep } : {}),
    ...(episodes.length > 0 ? { episodes } : {}),
    ...(styleId ? { styleId } : {}),
    ...(narration.scriptType ? { scriptType: narration.scriptType } : {}),
    ...(narration.narrationVoice ? { narrationVoice: narration.narrationVoice } : {}),
  };
}

/**
 * agent op 载荷清洗：`set_project_meta` 的 patch（2026-09-16 G1）。
 *
 * 为何需要第三个清洗层：agent 送进来的 patch 与 UI 的 `setProjectMeta` 走同一个写入口，
 * 但来源不可信（模型输出，可能带 AID 审核态、超长 script、非 1..7 的 step）。这里只做
 * 「能不能进 state」的守门；完整落盘白名单仍在 `project-store.normalizeProject`（两层互不取代）。
 *
 * 语义（与 store/读取端既有范式一致 + 一处刻意不同）：
 *   - 逐栏独立：某栏非法只丢该栏，不整包作废（同 `normalizeEpisodes` 逐项丢弃）。
 *   - 非法值**省略该键**，不是写 `undefined` —— 省略 = `setProjectMeta` 不动该栏。
 *     刻意不同于 UI 路径的「`undefined` = 清除」：agent 打错一个 enum 值不该清掉
 *     用户已填的剧集清单。**代价（诚实标记）**：agent 无法藉此 op 清空栏位。
 *   - `episodes` 逐项走 `readEpisode`（缺 id/title、episodeNo 非正整数、status 非三态 → 丢该项）
 *     → `episodeNo` 去重（保留首见）→ 上限 `MAX_EPISODES_PER_PROJECT`。
 *     去重/截断刻意在此就做（不只靠落盘端）：否则 UI 显示的集数与 Blob 存下的不一致
 *     （`normalizeProject` 也会去重截断），即「介面显示 ≠ 实际资料」。
 *   - `episodes: []` 与非法值同义（省略）：不制造「空壳已设定」的假象；要清空留下次机会。
 */
export function normalizeProjectMetaPatch(payload: unknown): CanvasProjectMetaPatch {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const p = payload as Record<string, unknown>;
  const out: CanvasProjectMetaPatch = {};
  if (isCanvasProjectType(p.projectType)) out.projectType = p.projectType;
  if (isValidCreationStep(p.currentStep)) out.currentStep = p.currentStep;
  // 风格绑定（P1-8／D34）：未注册 id 省略该键＝不动专案已绑的风格
  // （同其余栏位：模型打错一个 id 不该把用户绑好的风格清掉）。
  const styleId = normalizeProjectStyleId(p.styleId);
  if (styleId) out.styleId = styleId;
  // 解说剧设定（P1-5／D7）：同款逐栏判——型别值域外省略该键（模型打错型别不该清掉
  // 用户选好的解说剧设定），音色未在语音库里也省略该键。
  const narration = normalizeProjectNarration({ scriptType: p.scriptType, narrationVoice: p.narrationVoice });
  if (narration.scriptType) out.scriptType = narration.scriptType;
  if (narration.narrationVoice) out.narrationVoice = narration.narrationVoice;
  if (Array.isArray(p.episodes)) {
    const seen = new Set<number>();
    const episodes: CanvasEpisode[] = [];
    for (const item of p.episodes) {
      const episode = readEpisode(item);
      if (!episode) continue;
      if (seen.has(episode.episodeNo)) continue; // episodeNo 去重，保留首见
      seen.add(episode.episodeNo);
      episodes.push(episode);
      if (episodes.length >= MAX_EPISODES_PER_PROJECT) break;
    }
    if (episodes.length > 0) out.episodes = episodes;
  }
  return out;
}

/** 汇出档的信封（带 kind/version，汇入时才能认出这不是别的 JSON）。 */
export const CANVAS_EXPORT_KIND = "image-studio.canvas";
export const CANVAS_EXPORT_VERSION = 1;

export interface CanvasExportFile {
  kind: typeof CANVAS_EXPORT_KIND;
  version: number;
  exportedAt: string;
  project: CanvasProject;
}

export function buildExportFile(project: CanvasProject): CanvasExportFile {
  return {
    kind: CANVAS_EXPORT_KIND,
    version: CANVAS_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    project,
  };
}

/** 汇入：认信封也认裸 project（别人手改过的档案不该直接失败）。回 null = 不是画布档。 */
export function parseImportFile(raw: unknown): {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  viewport?: CanvasViewport;
  backgroundMode?: "dots" | "lines" | "blank";
  title?: string;
  projectType?: CanvasProjectType;
  currentStep?: number;
  episodes?: CanvasEpisode[];
  /** 专案级风格绑定（P1-8／D34）：汇出→汇入带著走（否则静默丢风格）。 */
  styleId?: string;
  /** 解说剧型别（P1-5／D7）：同样带著走（否则「汇出→汇入」会静默丢掉解说剧设定）。 */
  scriptType?: CanvasScriptType;
  /** 旁白音色（P1-5／D7）：同上。 */
  narrationVoice?: string;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const env = raw as Record<string, unknown>;
  const project = (env.kind === CANVAS_EXPORT_KIND && env.project && typeof env.project === "object"
    ? (env.project as Record<string, unknown>)
    : env) as Record<string, unknown>;
  if (!Array.isArray(project.nodes)) return null;
  const state = fromCanvasProject(project as { nodes?: unknown; connections?: unknown });
  const vp = project.viewport as CanvasViewport | undefined;
  const bg = project.backgroundMode;
  // 作品/剧集三栏：汇出档带著走（否则「汇出→汇入」会静默丢掉剧集清单）。
  const meta = canvasProjectMeta(project);
  return {
    nodes: state.nodes,
    connections: state.connections,
    ...(vp && num(vp.x) !== undefined && num(vp.y) !== undefined && num(vp.k) !== undefined
      ? { viewport: { x: vp.x, y: vp.y, k: clampScale(vp.k) } }
      : {}),
    ...(bg === "dots" || bg === "lines" || bg === "blank" ? { backgroundMode: bg } : {}),
    ...(typeof project.title === "string" ? { title: project.title } : {}),
    ...meta,
  };
}
