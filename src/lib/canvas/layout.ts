// 畫布純函式層：事件分流、事件正規化、幾何、歷史快照、專案序列化。
//
// 為什麼要有這一層：gateway 的 canvas.* payload 是「寬鬆解析」過的
// （src/lib/agent-chat-types.ts 的 AgentCanvas* 型別：node 只有 id/type/title/metadata，
// 沒有 position/width/height），而 src/lib/canvas/reducer.ts 吃的是完整的 CanvasNode。
// 中間這一步轉換必須是純函式，否則 React 元件裡混進契約補齊邏輯，測不了也講不清。
//
// 排版座標一律留 (0,0) 交給 reducer 的 nextPosition 決定（PRD §5：不允許在
// reducer 外再寫一套排版）。這裡只補「尺寸」與「型別」這種契約缺口。

import type { AgentSseEvent } from "@/lib/agent-chat-types";
import { isValidCreationStep, MAX_EPISODES_PER_PROJECT } from "@/lib/creation-flow-steps";
import { isReferenceImageRole } from "@/lib/image-types";
import { normalizeStoryboardSceneRef, normalizeStoryboardShot } from "@/lib/storyboard-contract";
import type { CanvasReducerState } from "./reducer";
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

/** canvas.* = 畫布事件；其餘進既有 transcript reducer。 */
export function isCanvasEventName(name: string): boolean {
  return name.startsWith("canvas.");
}

/** 純展示型畫布事件（reducer 不吃，UI 直接透傳顯示）。 */
export type CanvasPassthroughEvent =
  | { name: "canvas.derive.started"; data: { unit_id: string; source_node_id: string; instruction: string; interpretation?: string } }
  | { name: "canvas.budget.updated"; data: { unit_id?: string; used_coins: number; remaining_coins: number } };

/** reducer 吃得下的事件名（會改變 nodes/connections/units）。 */
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

// ─────────────────────────────────────────── 型別/尺寸正規化

const NODE_TYPES = new Set<string>(Object.values(CanvasNodeType));

/** 未知 type 一律退成 text：畫得出來的節點勝過畫不出來的正確性。 */
export function toNodeType(raw: unknown): CanvasNodeType {
  return typeof raw === "string" && NODE_TYPES.has(raw) ? (raw as CanvasNodeType) : CanvasNodeType.Text;
}

const STATUSES = new Set<CanvasNodeStatus>(["idle", "success", "loading", "error"]);

/**
 * gateway 的 status 詞彙比前端寬（running/pending/queued/failed…）。
 * 映射到四態，UI 才只需要處理四種顏色。
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
 * id 陣列收斂（照 project-store `normalizeProject` 對 `cardIds` 的同一把尺）：
 * 只留非空字串（純空白＝沒指定）、按首次出現序去重；空陣列/非陣列 → undefined（省略鍵）。
 * 值本身不動（不補不截）——長度界線在寫入端，讀取端只做形狀收斂。
 */
function toIdList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
  return out.length > 0 ? out : undefined;
}

// ─────────────────────────────────────────── 模板實體宣告（2026-09-24）

/**
 * 節點 metadata 的實體宣告鍵：gateway 模板節點的 `defaults.emitsEntity`
 * （`deploy-staging/gateway/workflow-templates/*`）經 `expandTemplate` spread 進節點
 * metadata，隨 SSE `canvas.node.created/updated` 落地；消費端
 * `src/lib/agent-output-cards.ts` 據此自動落成可 @ 引用的實體卡。
 *
 * **本檔刻意零依賴**（不 import `character-cards.ts`）：五值字面與該檔
 * `CHARACTER_CARD_KIND_VALUES` **逐字同步**，不 import 以避免讀取端反向依賴卡模組。
 */
export const EMITS_ENTITY_KINDS = ["character", "scene", "style", "prop", "audio"] as const;
export type EmitsEntityKind = (typeof EMITS_ENTITY_KINDS)[number];

/** 模板實體宣告（形狀與 `agent-output-cards.ts` 的 `EmittedEntitySpec` 同構）。 */
export interface EmittedEntityMetadata {
  kind: EmitsEntityKind;
  /** 卡名來源：預設節點標題；`"input"` ＝依序取卡名三鍵。 */
  nameFrom?: "nodeTitle" | "input";
  /**
   * 參考圖來源 role 清單（模板作者宣告，如四視圖的 `["view2","view3","view4"]`）：
   * 同模板實例上哪些 role 的交付物算本實體的參考圖。單一交付物的實體不寫。
   */
  referenceRoles?: string[];
  /**
   * 參考圖來源**節點 id** 清單（引擎 `expandTemplate` 的參考圖 post-pass 按
   * `referenceRoles` 解出後填入；作者不手寫）。站點據此把兄弟節點的交付圖併進同一張卡。
   */
  referenceNodeIds?: string[];
}

/**
 * 卡名來源鍵（`nameFrom: "input"` 時按序取第一個非空字串）——
 * 與 `agent-output-cards.ts` 的 `NAME_FROM_INPUT_KEYS` **逐字同序同步**。
 * 卡名上限 100 與 character-cards / agent-output-cards 的 `MAX_NAME_LENGTH` 同尺。
 */
export const CARD_NAME_KEYS = ["input", "characterName", "sceneName"] as const;
const MAX_CARD_NAME_LENGTH = 100;

/** 卡名收斂：非字串/空字串（含純空白）→ undefined（省略該鍵，不寫空字串）。 */
export function toCardMetadataName(v: unknown): string | undefined {
  const s = str(v)?.trim();
  return s ? s.slice(0, MAX_CARD_NAME_LENGTH) : undefined;
}

/**
 * `emitsEntity` 內參考圖清單（`referenceRoles` / `referenceNodeIds`）的上限：
 *   - 項數 8 ＝ `character-cards.ts` 的 `MAX_CARD_REFERENCES` 同尺（多出來的項在
 *     建卡時本來也會被截，這裡先收斂＝上行/存檔不搬運永遠用不到的字串）
 *   - 單項長度 100 ＝ id 邊界同尺（超過者建不出合法 card id，留著只是噪音）
 */
const MAX_ENTITY_REFERENCE_ITEMS = 8;
const MAX_ENTITY_REFERENCE_ITEM_LENGTH = 100;

/**
 * 參考圖清單收斂（讀取端與上行端共用）：
 *   - 非陣列 → `undefined`（省略鍵）
 *   - 逐項 trim、只留非空字串、按首次出現序去重、單項截 100 字、項數上限 8
 *   - 收斂後空集合 → `undefined`（**省略鍵**，不寫 `[]`：消費端「沒宣告」與「空集合」同義）
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
 * `emitsEntity` 保留鍵的清洗（讀取端與上行端共用同一份，不製造第二個漂移點）：
 *   - 非物件（含陣列/字串/數字）→ `undefined`
 *   - `kind` 不在五值域 → **整個丟棄**（**不降格成 character**：這裡判的是「這號標記是否
 *     合法」，猜錯會建出錯 kind 的卡；與 `character-cards.ts` `toCharacterCardKind` 的
 *     fail-open 語義刻意不同）
 *   - `nameFrom` 只認 `"nodeTitle" | "input"`，非法則省略該欄（kind 仍有效）
 *   - `referenceRoles` / `referenceNodeIds`（2026-09-24 四視圖聚合）：只收**非空字串
 *     陣列**（trim、去重、單項 ≤100、≤8 項），空集合/非陣列則省略該鍵
 * 回傳**新物件**（不沿用輸入參考）：gateway 的 `expandTemplate` 是淺 spread，節點
 * metadata 與模板模組層的 `defaults` 同參考，沿用參考會把原地改寫擴散到跨會話
 *（`workflow-engine.ts` 已同步做防禦性複製，兩處互為保險）。
 */
export function cleanEmitsEntity(v: unknown): EmittedEntityMetadata | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;
  const kind = EMITS_ENTITY_KINDS.find((k) => k === raw.kind);
  if (!kind) return undefined;
  const nameFrom = str(raw.nameFrom);
  // 聚合兩鍵（**雙白名單生效的關鍵一步**）：漏在這裡＝鍵一進前端就被剝掉，
  // 四視圖聚合的 `referenceNodeIds` 永遠是 undefined（症狀＝功能完全沒反應）。
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
 * 文本節點字號（`metadata.fontSize`）的界：**與寫入端逐字同尺**
 *（`src/components/canvas/embed/context-menu-items.ts:155/156` 的
 *  `Math.min(28, …)` / `Math.max(10, …)`，缺省 14.5 由渲染層補）。
 */
const MIN_NODE_FONT_SIZE = 10;
const MAX_NODE_FONT_SIZE = 28;

/**
 * 字號收斂（讀取端與上行端共用同一份）：
 *   - 只收**有限數字**（`Number.isFinite`：字串 `"22"`／`NaN`／`Infinity`／`null` 一律不收
 *     ——面板寫的是 number，字串是歷史髒值，不代為轉型）
 *   - 四捨五入成整數（面板只寫整數；小數是髒值）
 *   - 夾在 10..28（與寫入端同一把尺；超界＝收斂到界，不是丟掉）
 * 不合法 → `undefined`（**省略該鍵**，渲染層回預設 14.5）。
 *
 * 為什麼要進白名單：本鍵原本「session 內可見、重載即消失」（右鍵放大/縮小字号改的字號
 * 刷新就回默認）；`toNodeMetadata` 是唯一的耐久化路徑（fromCanvasProject → … → 本函式）。
 */
export function toNodeFontSize(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.min(MAX_NODE_FONT_SIZE, Math.max(MIN_NODE_FONT_SIZE, Math.round(v)));
}

/** errorDetails 收斂：字串原樣；物件只留 message/human_message 兩個字串欄位（G-FE 合同），空形丟棄。 */
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

/** 把寬鬆 metadata 收斂成 CanvasNodeMetadata（丟掉不認得的欄位，status 走映射）。 */
export function toNodeMetadata(raw: unknown): CanvasNodeMetadata {
  if (!raw || typeof raw !== "object") return {};
  const m = raw as Record<string, unknown>;
  const status = toNodeStatus(m.status);
  const errorDetails = toErrorDetails(m.errorDetails);
  // 分鏡實體的卡引用（WS7）：三條 id 陣列走同一把尺（非空、去重、空則省略鍵）。
  const characterCardIds = toIdList(m.characterCardIds);
  const sceneCardIds = toIdList(m.sceneCardIds);
  const propCardIds = toIdList(m.propCardIds);
  const entityCardId = str(m.entityCardId)?.trim();
  // 模板實體宣告 ＋ 卡名三鍵（2026-09-24）：emitsEntity 是**結構化物件**（非字串、
  // 非 id 陣列），走專用清洗函式；卡名三鍵走字串 trim + 上限（空字串省略該鍵）。
  const emitsEntity = cleanEmitsEntity(m.emitsEntity);
  const cardNames = {
    input: toCardMetadataName(m.input),
    characterName: toCardMetadataName(m.characterName),
    sceneName: toCardMetadataName(m.sceneName),
  };
  // 文本節點字號（2026-09-25）：右鍵「放大/縮小字号」寫的鍵——不放行＝刷新回默認字號。
  const fontSize = toNodeFontSize(m.fontSize);
  return {
    ...(str(m.content) !== undefined ? { content: str(m.content) } : {}),
    ...(str(m.prompt) !== undefined ? { prompt: str(m.prompt) } : {}),
    ...(str(m.negativePrompt) !== undefined ? { negativePrompt: str(m.negativePrompt) } : {}),
    ...(str(m.model) !== undefined ? { model: str(m.model) } : {}),
    ...(str(m.size) !== undefined ? { size: str(m.size) } : {}),
    ...(str(m.quality) !== undefined ? { quality: str(m.quality) } : {}),
    ...(num(m.count) !== undefined ? { count: num(m.count) } : {}),
    ...(str(m.kind) !== undefined ? { kind: str(m.kind) } : {}),
    ...(m.source_image === null || str(m.source_image) !== undefined
      ? { source_image: (str(m.source_image) ?? null) as string | null }
      : {}),
    ...(status ? { status } : {}),
    ...(errorDetails !== undefined ? { errorDetails } : {}),
    ...(num(m.naturalWidth) !== undefined ? { naturalWidth: num(m.naturalWidth) } : {}),
    ...(num(m.naturalHeight) !== undefined ? { naturalHeight: num(m.naturalHeight) } : {}),
    ...(num(m.cost_coins) !== undefined ? { cost_coins: num(m.cost_coins) } : {}),
    ...(num(m.cost_hint) !== undefined ? { cost_hint: num(m.cost_hint) } : {}),
    ...(str(m.imageTaskId) !== undefined ? { imageTaskId: str(m.imageTaskId) } : {}),
    ...(num(m.startedAt) !== undefined ? { startedAt: num(m.startedAt) } : {}),
    ...(num(m.progress) !== undefined ? { progress: num(m.progress) } : {}),
    // reference 節點角色：只收合法 ReferenceImageRole，未知值丟棄（收斂在讀取端做）。
    ...(isReferenceImageRole(m.referenceRole) ? { referenceRole: m.referenceRole } : {}),
    // pipeline 卡型白名單：director（導演台）＋ tool/gate/note（後端 derived 工具卡/
    // 門禁卡/配方卡，kind=text，NodeBody 工具/門禁/配方分支渲染）。未列舉值（含
    // step_head——前端模板路徑直産、後端不送）照舊丟棄。
    ...(m.pipelineCard === "tool" || m.pipelineCard === "gate" || m.pipelineCard === "note" || m.pipelineCard === "director"
      ? { pipelineCard: m.pipelineCard as "tool" | "gate" | "note" | "director" }
      : {}),
    // derived 工具卡欄位族（pipelineCard:"tool"）：四字串欄走 str() 收斂；
    // unsupported 是 boolean 旗標——truthy 判斷保留 boolean，只過 str() 會剝掉
    //（同 gate boolean 形態的教訓）。
    ...(str(m.toolId) !== undefined ? { toolId: str(m.toolId) } : {}),
    ...(str(m.toolInput) !== undefined ? { toolInput: str(m.toolInput) } : {}),
    ...(str(m.toolOutput) !== undefined ? { toolOutput: str(m.toolOutput) } : {}),
    ...(str(m.requiredCapability) !== undefined ? { requiredCapability: str(m.requiredCapability) } : {}),
    ...(m.unsupported ? { unsupported: true } : {}),
    // director 節點（gateway director.done 攔截同步，spec §5 片5）：SVG 可達 48KB，
    // 原樣收字串欄位；planName 明確 null 時保留 null（活卡語義=「目前無方案」）。
    // 後端 workflow 骨架節點的產出合同/驗收門禁（各一行，SSE canvas.node.created/updated 帶入）。
    ...(str(m.deliverable) !== undefined ? { deliverable: str(m.deliverable) } : {}),
    // gate 兩形態（types.ts 註解）：string 門禁全文照走；boolean（workflow-dsl
    // 的「需人工批准」旗標）原樣保留，不能只過 str() 否則旗標會被剝掉。
    ...(str(m.gate) !== undefined ? { gate: str(m.gate) } : m.gate === true ? { gate: true } : {}),
    ...(str(m.directorSessionId) !== undefined ? { directorSessionId: str(m.directorSessionId) } : {}),
    ...(str(m.planName) !== undefined ? { planName: str(m.planName) } : {}),
    ...(m.planName === null ? { planName: null } : {}),
    ...(num(m.shotCount) !== undefined ? { shotCount: num(m.shotCount) } : {}),
    ...(m.healthOk === true || m.healthOk === false ? { healthOk: m.healthOk } : {}),
    ...(str(m.topViewSvg) !== undefined ? { topViewSvg: str(m.topViewSvg) } : {}),
    ...(str(m.cameraViewSvg) !== undefined ? { cameraViewSvg: str(m.cameraViewSvg) } : {}),
    ...(num(m.revision) !== undefined ? { revision: num(m.revision) } : {}),
    // 3D 場景卡節點（Astra PRD P1-3）：sceneCard 欄位族收斂（Scene3dCardMetadata）。
    // 契約全形六欄；非契約形狀（任一必填欄缺失/型別不符）整包丟棄，不製造半形數據。
    ...(toScene3dCard(m.sceneCard) ? { sceneCard: toScene3dCard(m.sceneCard) } : {}),
    // 分鏡實體（2026-09-15 刀 2）：AID 21 欄契約。shotNumber 為空即整包丟棄
    //（分鏡無鏡號 = 無法與門禁 storyboard_qc_17 的 shot_identity 對齊）。
    ...(normalizeStoryboardShot(m.storyboardShot) ? { storyboardShot: normalizeStoryboardShot(m.storyboardShot)! } : {}),
    ...(normalizeStoryboardSceneRef(m.storyboardScene)
      ? { storyboardScene: normalizeStoryboardSceneRef(m.storyboardScene)! }
      : {}),
    // 分鏡實體的卡引用＋自動落卡標記（WS7，2026-09-24）：與 storyboardShot 同族的
    // 雙白名單欄位——漏此處 = 刷新/回舊會話（fromCanvasProject → 本函式）後
    // 卡引用與冪等標記憑空消失，分鏡節點永遠拿不到卡引用。
    ...(characterCardIds ? { characterCardIds } : {}),
    ...(sceneCardIds ? { sceneCardIds } : {}),
    ...(propCardIds ? { propCardIds } : {}),
    ...(entityCardId ? { entityCardId } : {}),
    // 模板交付自動落卡（2026-09-24）：emitsEntity 是**驅動整條落卡鏈**的鍵——漏此處
    // ＝前端落地剝掉它 → `agent-output-cards.emittedEntityOf` 回 null → 一卡都落不成
    //（已用真 expandTemplate 輸出 + 本函式＋ compactMetadataForAgent 實錘）。
    // 三條卡名鍵是 `nameFrom: "input"` 的來源；只放行 emitsEntity 不放行它們，
    // 卡名只會退回節點標題（「正面」而非角色名）。
    ...(emitsEntity ? { emitsEntity } : {}),
    ...(cardNames.input ? { input: cardNames.input } : {}),
    ...(cardNames.characterName ? { characterName: cardNames.characterName } : {}),
    ...(cardNames.sceneName ? { sceneName: cardNames.sceneName } : {}),
    ...(fontSize !== undefined ? { fontSize } : {}),
    // 協作確認閘的門禁卡狀態（2026-09-24）：漏此處＝SSE 到了也被剝掉，門禁卡永遠
    // 只有純文字（使用者「資產圖都不讓我們確認」的 UI 側缺口）。三欄全字串才收，
    // 殘形整包丟棄（不製造半形狀態：缺 request_id 的卡按不下批准）。
    ...(toGateConfirm(m.gateConfirm) ? { gateConfirm: toGateConfirm(m.gateConfirm)! } : {}),
  };
}

/** 門禁卡裁決憑據收斂：三欄型別全對才回物件，否則整包丟棄（同 storyboard 家族寫法）。 */
function toGateConfirm(v: unknown): CanvasNodeGateConfirm | undefined {
  if (!v || typeof v !== "object") return undefined;
  const g = v as Record<string, unknown>;
  const requestId = str(g.request_id);
  const sessionId = str(g.session_id);
  const status = g.status === "pending" || g.status === "approved" || g.status === "rejected" ? g.status : undefined;
  if (!requestId || !sessionId || !status) return undefined;
  return { request_id: requestId, session_id: sessionId, status };
}

/** sceneCard 欄位族收斂：六欄逐一驗型，任一必填欄不符契約即整包丟棄。 */
function toScene3dCard(v: unknown): Scene3dCardMetadata | undefined {
  if (!v || typeof v !== "object") return undefined;
  const s = v as Record<string, unknown>;
  const turntableUrl = str(s.turntable_url);
  const blendPath = str(s.blend_path);
  const glbPath = str(s.glb_path);
  const summary = str(s.scene_summary);
  const durationMs = num(s.duration_ms);
  const stills = Array.isArray(s.stills_urls)
    ? s.stills_urls.filter((u): u is string => typeof u === "string")
    : undefined;
  if (!turntableUrl || !blendPath || !glbPath || !summary || durationMs === undefined || !stills) return undefined;
  return {
    turntable_url: turntableUrl,
    stills_urls: stills,
    blend_path: blendPath,
    glb_path: glbPath,
    scene_summary: summary,
    duration_ms: durationMs,
  };
}

/**
 * 補齊節點契約缺口：type 收斂、尺寸取預設、position 留 (0,0)。
 *
 * position 留 0,0 是刻意的 —— reducer 的 upsertNode 看到 0,0 才會呼叫
 * nextPosition 自動排版。gateway 不給座標，版面權在前端 reducer 一處。
 */
export function normalizeCanvasNode(raw: {
  id: string;
  type: string;
  title: string;
  position?: CanvasPosition;
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
  /** gateway 泳道座標已定局（moved:true）＝ reducer layoutGraph 不得重排。只透傳 true。 */
  moved?: boolean;
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
    // moved 是 boolean 旗標——只透傳 true（false/缺省不帶），同 gate/unsupported 形態教訓。
    ...(raw.moved === true ? { moved: true } : {}),
  };
}

/**
 * AgentSseEvent（寬鬆）→ CanvasSseEvent（reducer 契約）。
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
          // reducer 會把 status 原樣塞進 metadata，所以這裡就先映射成四態之一。
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

/** 摘要上限：畫布可以有 500 個節點，但沒必要把 500 個都塞進每一次 send。 */
export const CANVAS_SUMMARY_MAX_NODES = 60;

/**
 * 純 metadata 摘要，**永不含圖片 base64／dataURL**。
 * content 一律不帶：圖節點的 content 是 URL、文本節點的 content 是整段 prompt，
 * 兩者都可能很長，而 gateway 要的只是「畫布上有什麼」。
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
      .map((c) => ({ id: c.id, fromNodeId: c.fromNodeId, toNodeId: c.toNodeId })),
    units: state.units.map((u) => ({ unit_id: u.unitId, tool: u.tool, node_count: u.nodes.length })),
  };
}

// ─────────────────────────────────────────── 視口幾何

export const CANVAS_MIN_SCALE = 0.05;
export const CANVAS_MAX_SCALE = 5;
export const CANVAS_GRID_BASE = 48;

export function clampScale(k: number): number {
  if (!Number.isFinite(k)) return 1;
  return Math.min(CANVAS_MAX_SCALE, Math.max(CANVAS_MIN_SCALE, k));
}

/** 滾輪縮放：factor = 1.1^(-deltaY/100)，錨點固定在游標下的世界座標。 */
export function zoomAtPoint(vp: CanvasViewport, deltaY: number, px: number, py: number): CanvasViewport {
  const factor = Math.pow(1.1, -deltaY / 100);
  const k = clampScale(vp.k * factor);
  if (k === vp.k) return vp;
  // 游標下的世界點在縮放前後必須落在同一個螢幕位置：
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

/** 小地圖的世界範圍：節點 min/max 各留 pad（PRD §7.4 預設 ±500）。 */
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
 * 「可讀縮放」下限：全圖 fit 低於它時寧可不顯示全部，也要保證節點文字可讀。
 * 暴君原則：一進來就要看到清楚的內容，而不是縮成一團的整張圖。
 */
export const CANVAS_READABLE_MIN_SCALE = 0.85;

/** 把整張畫布帶進視口（含邊距），回新的 viewport。
 *  minScale > 0 時是「可讀優先」模式：全圖 fit 的縮放低於 minScale，
 *  改用 minScale 並把視口對齊內容開頭（第一個/上游節點清晰可見），
 *  其餘節點平移查看——不會出現「小到看不清」的整圖縮略。 */
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
  // 全圖 fit 太小：放大到可讀縮放，視口對齊內容左上（padding 邊距），
  // 讓上游第一個節點（劇本/描述）清晰可見。
  return {
    x: padding - b.minX * k,
    y: padding - b.minY * k,
    k,
  };
}

/** 貝茲連線：方向自適應（水平鄰居走側出側入、垂直重疊鄰居走底出頂入、
    長距離前向跳線走頂部拱橋，消除垂直節點反折大耳朵與長線攔腰穿透中間卡片；
    反向連線不再繞一大圈回來）。 */
export function bezierPath(from: CanvasNode, to: CanvasNode): string {
  const fromRight = from.position.x + from.width;
  const toRight = to.position.x + to.width;
  const fromBottom = from.position.y + from.height;
  const toBottom = to.position.y + to.height;

  // 垂直相鄰/重疊判斷：兩節點水平範圍有交集（例如同列堆疊），且垂直有間隔
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

  // 長距離前向跳線（邊緣淨距塞得下一整張卡）：水平中線直連會攔腰穿透中間
  // 欄位的卡片——改走頂部拱橋（頂心出、拱頂跨越、頂心入），上方淨空零穿透。
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

/** 網格背景：gridSize 跟著縮放走，backgroundPosition 取視口的模，格線才不會漂。 */
export function gridBackground(vp: CanvasViewport, mode: "dots" | "lines" | "blank"): {
  backgroundImage?: string;
  backgroundSize?: string;
  backgroundPosition?: string;
} {
  if (mode === "blank") return {};
  const size = CANVAS_GRID_BASE * vp.k;
  if (size < 6) return {}; // 縮太小時格線變噪點，直接不畫
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

// ─────────────────────────────────────────── 歷史快照（undo/redo）

export interface CanvasSnapshot {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  viewport: CanvasViewport;
}

export interface CanvasHistory {
  past: CanvasSnapshot[];
  future: CanvasSnapshot[];
}

export const CANVAS_HISTORY_LIMIT = 50;
export const CANVAS_EMPTY_HISTORY: CanvasHistory = { past: [], future: [] };

/** 推一格快照。任何新動作都會清空 future（分岔後舊的 redo 已經沒有意義）。 */
export function pushSnapshot(history: CanvasHistory, snapshot: CanvasSnapshot): CanvasHistory {
  const past = [...history.past, snapshot];
  return { past: past.slice(Math.max(0, past.length - CANVAS_HISTORY_LIMIT)), future: [] };
}

/** 撤銷：把 current 推進 future，回上一格。沒得撤銷時回 null。 */
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

/** 重做：把 current 推回 past，回 future 的第一格。沒得重做時回 null。 */
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

// ─────────────────────────────────────────── 專案序列化（Blob / 匯出匯入）

/** reducer state + 視口 → 可存的 CanvasProject。 */
export function toCanvasProject(
  base: { id: string; title: string; createdAt?: string },
  state: CanvasReducerState,
  viewport: CanvasViewport,
  backgroundMode: "dots" | "lines" | "blank",
  budget?: { totalCoins: number; usedCoins: number },
  cardIds?: string[],
  // 作品/劇集三級狀態機（2026-09-15 刀 1 前端接線）：照 cardIds 的既有條件展開範式。
  // 刻意「不清洗」——清洗單一真源在 project-store 的 normalizeProject，
  // 這裡只決定「要不要帶這個欄位」，否則兩處白名單會漂移（見 PRD §3）。
  projectType?: CanvasProjectType,
  currentStep?: number,
  episodes?: CanvasEpisode[],
): CanvasProject {
  const now = new Date().toISOString();
  return {
    id: base.id,
    title: base.title || "未命名画布",
    createdAt: base.createdAt ?? now,
    updatedAt: now,
    nodes: state.nodes,
    connections: state.connections,
    viewport,
    backgroundMode,
    ...(budget ? { budget } : {}),
    ...(cardIds && cardIds.length > 0 ? { cardIds } : {}),
    ...(projectType ? { projectType } : {}),
    ...(isValidCreationStep(currentStep) ? { currentStep } : {}),
    ...(episodes && episodes.length > 0 ? { episodes } : {}),
  };
}

/**
 * CanvasProject → reducer state。units 一律回空陣列：
 * 單元是「這次會話的生成批次」，跨刷新沒有意義，節點/連線才是畫布本體。
 */
export function fromCanvasProject(project: {
  nodes?: unknown;
  connections?: unknown;
}): CanvasReducerState {
  const rawNodes = Array.isArray(project.nodes) ? project.nodes : [];
  const nodes = rawNodes.flatMap((n) => {
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
    });
    // 存檔裡的座標要原樣還原（normalizeCanvasNode 只在缺座標時給 0,0）。
    const pos = r.position as CanvasPosition | undefined;
    return [pos && num(pos.x) !== undefined && num(pos.y) !== undefined ? { ...node, position: { x: pos.x, y: pos.y } } : node];
  });
  const ids = new Set(nodes.map((n) => n.id));
  const rawConns = Array.isArray(project.connections) ? project.connections : [];
  const connections = rawConns.flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const r = c as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.fromNodeId !== "string" || typeof r.toNodeId !== "string") return [];
    // 懸空連線不還原：一頭找不到節點的線畫出來是一條指向虛空的曲線。
    if (!ids.has(r.fromNodeId) || !ids.has(r.toNodeId)) return [];
    return [{ id: r.id, fromNodeId: r.fromNodeId, toNodeId: r.toNodeId }];
  });
  return { units: [], nodes, connections };
}

/**
 * 讀取側防炸校驗：只確認「型別不會讓下游炸」，不重複 project-store 的完整清洗。
 *
 * 分工（勿混）：store `normalizeProject` 是落盤白名單（截斷字串、補時間戳、
 * episodeNo 去重、上限 200）；這裡是從任意 JSON（快照/匯入檔/舊 Blob）取用時的
 * 最小防護——非法項一律丟棄，絕不捏造欄位。兩者刻意不共用，避免讀取路徑反向
 * 影響落盤語義。
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
 * 從 CanvasProject 取出三級狀態機欄位（給 hook 還原用；缺欄位/非法值一律省略）。
 *
 * 刻意獨立於 `fromCanvasProject`：後者回 `CanvasReducerState`（只有 nodes/connections/
 * units），改它的回傳型別會炸一票消費端；三欄是「專案級」狀態，不是 reducer 狀態。
 */
export function canvasProjectMeta(project: {
  projectType?: unknown;
  currentStep?: unknown;
  episodes?: unknown;
}): { projectType?: CanvasProjectType; currentStep?: number; episodes?: CanvasEpisode[] } {
  if (!project || typeof project !== "object") return {};
  const episodes = Array.isArray(project.episodes)
    ? project.episodes.flatMap((item) => {
        const episode = readEpisode(item);
        return episode ? [episode] : [];
      })
    : [];
  return {
    ...(isCanvasProjectType(project.projectType) ? { projectType: project.projectType } : {}),
    ...(isValidCreationStep(project.currentStep) ? { currentStep: project.currentStep } : {}),
    ...(episodes.length > 0 ? { episodes } : {}),
  };
}

/**
 * agent op 載荷清洗：`set_project_meta` 的 patch（2026-09-16 G1）。
 *
 * 為何需要第三個清洗層：agent 送進來的 patch 與 UI 的 `setProjectMeta` 走同一個寫入口，
 * 但來源不可信（模型輸出，可能帶 AID 審核態、超長 script、非 1..7 的 step）。這裡只做
 * 「能不能進 state」的守門；完整落盤白名單仍在 `project-store.normalizeProject`（兩層互不取代）。
 *
 * 語義（與 store/讀取端既有範式一致 + 一處刻意不同）：
 *   - 逐欄獨立：某欄非法只丟該欄，不整包作廢（同 `normalizeEpisodes` 逐項丟棄）。
 *   - 非法值**省略該鍵**，不是寫 `undefined` —— 省略 = `setProjectMeta` 不動該欄。
 *     刻意不同於 UI 路徑的「`undefined` = 清除」：agent 打錯一個 enum 值不該清掉
 *     用戶已填的劇集清單。**代價（誠實標記）**：agent 無法藉此 op 清空欄位。
 *   - `episodes` 逐項走 `readEpisode`（缺 id/title、episodeNo 非正整數、status 非三態 → 丟該項）
 *     → `episodeNo` 去重（保留首見）→ 上限 `MAX_EPISODES_PER_PROJECT`。
 *     去重/截斷刻意在此就做（不只靠落盤端）：否則 UI 顯示的集數與 Blob 存下的不一致
 *     （`normalizeProject` 也會去重截斷），即「介面顯示 ≠ 實際資料」。
 *   - `episodes: []` 與非法值同義（省略）：不製造「空殼已設定」的假象；要清空留下次機會。
 */
export function normalizeProjectMetaPatch(payload: unknown): CanvasProjectMetaPatch {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const p = payload as Record<string, unknown>;
  const out: CanvasProjectMetaPatch = {};
  if (isCanvasProjectType(p.projectType)) out.projectType = p.projectType;
  if (isValidCreationStep(p.currentStep)) out.currentStep = p.currentStep;
  if (Array.isArray(p.episodes)) {
    const seen = new Set<number>();
    const episodes: CanvasEpisode[] = [];
    for (const item of p.episodes) {
      const episode = readEpisode(item);
      if (!episode) continue;
      if (seen.has(episode.episodeNo)) continue; // episodeNo 去重，保留首見
      seen.add(episode.episodeNo);
      episodes.push(episode);
      if (episodes.length >= MAX_EPISODES_PER_PROJECT) break;
    }
    if (episodes.length > 0) out.episodes = episodes;
  }
  return out;
}

/** 匯出檔的信封（帶 kind/version，匯入時才能認出這不是別的 JSON）。 */
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

/** 匯入：認信封也認裸 project（別人手改過的檔案不該直接失敗）。回 null = 不是畫布檔。 */
export function parseImportFile(raw: unknown): {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  viewport?: CanvasViewport;
  backgroundMode?: "dots" | "lines" | "blank";
  title?: string;
  projectType?: CanvasProjectType;
  currentStep?: number;
  episodes?: CanvasEpisode[];
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
  // 作品/劇集三欄：匯出檔帶著走（否則「匯出→匯入」會靜默丟掉劇集清單）。
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
