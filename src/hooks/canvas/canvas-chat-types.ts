// 畫布 chat 的展示型類型與介面（自 use-canvas-chat.ts 外圍搬遷，符號名不變）。
// use-canvas-chat.ts 仍是唯一匯出點（barrel），消費端 import 路徑零改動。
import { cleanEmitsEntity, toCardMetadataName, toGateConfirm, toNodeFontSize } from "@/lib/canvas/layout";
// 上行白名單的**鍵集合單一真源**（與還原端 layout.toNodeMetadata 共用同一份清單；
// 漏一端＝回舊會話還原後該鍵靜默消失）。
import {
  AGENT_CONTENT_TRUNCATE_KEEP,
  AGENT_CONTENT_TRUNCATE_TRIGGER,
  AGENT_METADATA_FIELDS,
  AGENT_PROMPT_TRUNCATE_KEEP,
  type AgentFieldCondition,
  type AgentFieldTransform,
} from "@/lib/canvas/node-metadata-fields";
import type { AgentSseEvent } from "@/lib/agent-chat-types";
import { normalizeApprovalState } from "@/lib/character-cards";
import type { CharacterCard } from "@/lib/character-cards";
import type { CanvasScriptType } from "@/lib/canvas/project-narration";
import { compactStoryboardShot, type StoryboardScriptShot } from "@/lib/storyboard-contract";
import type {
  CanvasAgentOp,
  CanvasAgentOpsEvent,
  CanvasConnection,
  CanvasEpisode,
  CanvasNode,
  CanvasNodeMetadata,
  CanvasNodeVersion,
  CanvasPlanEvent,
  CanvasPosition,
  CanvasProject,
  CanvasProjectType,
  CanvasUnit,
  CanvasViewport,
} from "@/lib/canvas/types";

// ─────────────────────────────────────────── 展示型事件狀態

/** canvas.plan 的計畫卡（左側欄）。 */
export interface CanvasPlanCard extends CanvasPlanEvent {
  receivedAt: number;
}

/** canvas.derive.started 的指揮解讀卡。 */
export interface CanvasDeriveCard {
  unitId: string;
  sourceNodeId: string;
  instruction: string;
  interpretation?: string;
  receivedAt: number;
}

/** canvas.budget.updated 的預算信封。 */
export interface CanvasBudget {
  usedCoins: number;
  remainingCoins: number;
  updatedAt: number;
}

/** 歷史畫布清單的一列：只帶列表渲染需要的欄位，不載入整份 nodes。 */
export interface CanvasProjectSummary {
  id: string;
  title: string;
  updatedAt: string;
  nodeCount: number;
}

/** 服務端摘要（`?view=summary`）的最小形狀：已有節點數，不帶節點本體。 */
type CanvasProjectSummaryLike = { id: string; title: string; updatedAt: string; nodeCount: number };

/** CanvasProject[]／服務端摘要 → 清單摘要（濾掉空畫布），依 updatedAt 由新到舊。 */
export function toProjectSummaries(projects: ReadonlyArray<CanvasProject | CanvasProjectSummaryLike>): CanvasProjectSummary[] {
  return projects
    .map((p) => ({
      id: p.id,
      title: p.title || "未命名画布",
      updatedAt: p.updatedAt,
      nodeCount: "nodes" in p ? (Array.isArray(p.nodes) ? p.nodes.length : 0) : p.nodeCount,
    }))
    .filter((p) => p.nodeCount > 0)
    .sort((a, b) => {
      const at = Date.parse(a.updatedAt);
      const bt = Date.parse(b.updatedAt);
      const aTs = Number.isFinite(at) ? at : 0;
      const bTs = Number.isFinite(bt) ? bt : 0;
      return bTs - aTs;
    });
}

export type CanvasBackgroundMode = "dots" | "lines" | "blank";

/** 分鏡實體卡的 id 陣列清洗（與還原端 `layout.toIdList` 同一把尺）：只留非空字串、
 *  按首次出現序去重；空陣列/非陣列 → undefined（不把空欄位寫進快照）。 */
function cleanIdList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
  return out.length > 0 ? out : undefined;
}

/** 分族條件是否命中（工具卡族要求 pipelineCard∈{tool,gate,note}；導演台族要求 =director）。 */
function agentFieldConditionMet(bag: Record<string, unknown>, condition: AgentFieldCondition): boolean {
  const value = bag[condition.key];
  return typeof value === "string" && condition.oneOf.includes(value);
}

/**
 * 依真源的 `transform` 分派。回傳 `undefined` ＝「省略該鍵」（不寫空殼）。
 *
 * 每個 transform 的判據與既有 runtime **逐字相同**（含髒值行為：truthy 判斷、
 * `typeof === "number"` 不收斂 NaN、非字串 content/prompt 直接讀 `.length`/`.slice`）——
 * 本函式只把「哪個鍵走哪個動作」交給真源，動作本身不改。
 */
function applyAgentFieldTransform(transform: AgentFieldTransform, raw: unknown): unknown {
  switch (transform) {
    case "content": {
      // 超預算只留前 N 字＋省略號（門檻/保留字數＝真源 AGENT_TRUNCATION_BUDGETS）。
      if (!raw) return undefined;
      const text = raw as string;
      return text.length > AGENT_CONTENT_TRUNCATE_TRIGGER
        ? `${text.slice(0, AGENT_CONTENT_TRUNCATE_KEEP)}…`
        : text;
    }
    case "prompt": {
      if (!raw) return undefined;
      return (raw as string).slice(0, AGENT_PROMPT_TRUNCATE_KEEP);
    }
    case "truthy":
      return raw ? raw : undefined;
    case "number":
      return typeof raw === "number" ? raw : undefined;
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "defined":
      return raw !== undefined ? raw : undefined;
    case "pipelineCard":
      // 四值枚舉；未列舉值（含 step_head——前端模板路徑直産、後端不送）照舊丟棄。
      return raw === "tool" || raw === "gate" || raw === "note" || raw === "director" ? raw : undefined;
    case "idList":
      return cleanIdList(raw);
    case "cardName":
      return toCardMetadataName(raw);
    case "storyboardShot":
      // 欄位清單只准一份（storyboard-contract.ts），壓縮下放純函數，未來加欄自動跟上。
      return raw ? compactStoryboardShot(raw as StoryboardScriptShot) : undefined;
    case "emitsEntity":
      return cleanEmitsEntity(raw);
    case "fontSize":
      return toNodeFontSize(raw);
    case "gateConfirm":
      return toGateConfirm(raw);
    case "approval":
      // `normalizeApprovalState` 用 `null` 表示「整包丟棄」，本函式的 `undefined` 才是
      // 「省略鍵」——不轉換會寫出 `approval: null` 的空殼鍵。
      return normalizeApprovalState(raw) ?? undefined;
  }
}

/**
 * agent 快照的 metadata 壓縮（上行端白名單）。
 *
 * **鍵集合不寫在本檔**：唯一真源＝`src/lib/canvas/node-metadata-fields.ts` 的
 * `AGENT_METADATA_FIELDS`（鍵、分族條件、截斷預算與排除理由都在那裡）。
 * 與還原端 `layout.toNodeMetadata` 構成雙白名單：任一端漏鍵＝回舊會話/換裝置還原後
 * 該鍵靜默消失（2026-09-03 導演台空殼、2026-09-24 `emitsEntity` 當下被剝兩次事故）。
 */
export function compactMetadataForAgent(metadata: CanvasNodeMetadata | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const bag = metadata as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of AGENT_METADATA_FIELDS) {
    if (field.requires && !agentFieldConditionMet(bag, field.requires)) continue;
    const value = applyAgentFieldTransform(field.transform, bag[field.key]);
    if (value !== undefined) out[field.key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const SAVE_DEBOUNCE_MS = 400;
export const PLAN_CARD_LIMIT = 30;
export const DERIVE_CARD_LIMIT = 20;
/** 進度節流窗（行動端）：canvas.node.generating 可能高頻送達（後端進度流），
 *  低階裝置上每幀整張畫布重渲染會掉幀。同節點每窗最多落地一次 reducer，
 *  窗內只留最新一筆、窗末補送——最後的 progress 不會遺失。 */
export const PROGRESS_THROTTLE_MS = 120;

export interface UseCanvasChatReturn {
  // ── 事件入口：外部 chat（AgentChatSurface 的 useAgentChat onCanvasEvent）轉交這裡。
  feedCanvasEvent: (event: AgentSseEvent) => void;
  /** 每次 send 上送的畫布摘要（供外部掛到 chat 的 canvasStateProvider）。 */
  summarize: () => unknown;
  // ── 畫布狀態
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  units: CanvasUnit[];
  /** 節點內容版本歷史（append-only；右鍵「恢复上一版」據此判斷可用）。 */
  nodeVersions: CanvasNodeVersion[];
  plans: CanvasPlanCard[];
  derives: CanvasDeriveCard[];
  budget: CanvasBudget | null;
  // ── 視口
  viewport: CanvasViewport;
  setViewport: (next: CanvasViewport | ((prev: CanvasViewport) => CanvasViewport)) => void;
  backgroundMode: CanvasBackgroundMode;
  cycleBackground: () => void;
  fitView: (width: number, height: number) => void;
  centerOn: (world: CanvasPosition, viewportWidth: number, viewportHeight: number) => void;
  // ── 選取 / 編輯
  selectedNodeId: string | null;
  selectNode: (nodeId: string | null) => void;
  moveNode: (nodeId: string, position: CanvasPosition) => void;
  resizeNode: (nodeId: string, width: number, height: number) => void;
  removeNode: (nodeId: string) => void;
  commitInteraction: () => void;
  // ── Phase 3 畫布交互（群組拖動 / 貼上 / 多刪 / 手動連線）
  moveNodes: (moves: { nodeId: string; position: CanvasPosition }[]) => void;
  addNodes: (nodes: CanvasNode[], connections?: CanvasConnection[]) => void;
  /** 同 workflow 重鋪（2026-08-26 模板卡重點=替換）：先刪同 workflow_id 舊節點及其連線，再 add_nodes；一格歷史。 */
  replaceWorkflowNodes: (workflowId: string, nodes: CanvasNode[], connections?: CanvasConnection[]) => void;
  deleteNodes: (nodeIds: string[]) => void;
  addConnection: (fromNodeId: string, toNodeId: string) => void;
  removeConnection: (connectionId: string) => void;
  /**
   * 回跳作廢下游（決策 15）：把該節點全部下游已完成結果清成待生成（一格歷史）。
   * 作廢真權威在網關（updateNode BFS／rerunFrom），本函式是畫布側投影；
   * 重跑交宿主既有 rerun 入口。回傳被作廢的節點 id（BFS 序）。
   */
  revokeDownstream: (nodeId: string) => string[];
  // ── 批次操作（Phase 4）
  addBatchChild: (parentId: string, child: CanvasNode) => void;
  setBatchPrimary: (parentId: string, childId: string) => void;
  /** 節點內容回退：version 省略＝上一版；回退本身也落一版，可再撤銷。 */
  revertNode: (nodeId: string, version?: number) => void;
  deleteBatchChild: (parentId: string, childId: string) => void;
  toggleBatchExpanded: (parentId: string) => void;
  // ── @引用
  addReference: (nodeId: string, referenceNodeId: string) => void;
  removeReference: (nodeId: string, referenceNodeId: string) => void;
  // ── Wave A：就地編輯
  renameNode: (nodeId: string, title: string) => void;
  patchNodeMetadata: (nodeId: string, patch: Partial<CanvasNodeMetadata>, opts?: { history?: boolean }) => void;
  // ── B2：飛行聚焦
  flyTo: (world: CanvasPosition, viewportWidth: number, viewportHeight: number, targetK?: number) => void;
  // ── Wave C：agent 操作畫布（確認閘）
  pendingAgentOps: CanvasAgentOpsEvent | null;
  applyAgentOps: () => { runGeneration: { nodeId: string; prompt?: string; model?: string; size?: string; count?: number }[] };
  dismissAgentOps: (reason?: string) => void;
  // ── 歷史
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  // ── 專案
  projectTitle: string;
  setProjectTitle: (title: string) => void;
  loading: boolean;
  saveState: "idle" | "saving" | "saved" | "error" | "offline";
  loadProject: (project: { nodes?: unknown; connections?: unknown; viewport?: CanvasViewport; backgroundMode?: CanvasBackgroundMode; title?: string; projectType?: unknown; currentStep?: unknown; episodes?: unknown; styleId?: unknown; scriptType?: unknown; narrationVoice?: unknown }) => void;
  exportProject: () => CanvasProject;
  clearCanvas: () => void;
  newCanvasSession: () => void;
  // ── 歷史清單
  savedProjects: CanvasProjectSummary[];
  refreshSavedProjects: () => Promise<void>;
  openSavedCanvas: (id: string) => Promise<void>;
  /** Agent 快照下行回填（resume 到已有歷史的會話）：nodes>0 才落地；不進撤銷棧、清選取。 */
  restoreAgentSnapshot: (snapshot: {
    nodes?: unknown;
    connections?: unknown;
    viewport?: CanvasViewport;
    projectType?: unknown;
    currentStep?: unknown;
    episodes?: unknown;
    styleId?: unknown;
    scriptType?: unknown;
    narrationVoice?: unknown;
  }) => boolean;
  /**
   * REQ-B2 團隊資產空間：讀當前畫布項目 id（尚未建號回 null）。
   * 真源仍是 canvas-project-sync 的 projectIdRef（不新增第二份狀態，避免兩處漂移）。
   */
  getProjectId: () => string | null;
  // ── 作品/劇集三級狀態機（刀 1 前端接線；持久化在 CanvasProject 頂層三欄）
  /** 作品類型：undefined = 未設定。 */
  projectType: CanvasProjectType | undefined;
  /** 7 步流程當前步驟（1..7）；undefined = 未開始。 */
  currentStep: number | undefined;
  /** 劇集分集清單（電影為空陣列）。 */
  episodes: CanvasEpisode[];
  /**
   * 專案級風格綁定（P1-8／對稱差 D34）：`StyleTemplate.id`（`@/lib/style-library` 註冊面）；
   * undefined = 無綁定（舊專案語義）。生成時呼叫端把這個 id 帶進 `/api/canvas/generate` 的 `style_id`。
   */
  styleId: string | undefined;
  /** 解說劇型別（P1-5／D7）：`plot`｜`monologue`（＝解說劇）；undefined＝未宣告。 */
  scriptType: CanvasScriptType | undefined;
  /** 旁白音色（P1-5／D7）：voice-library 的 id；undefined＝用上游預設。 */
  narrationVoice: string | undefined;
  /** 專案級欄位的唯一寫入口（UI 面板與 agent 驅動路徑共用）；欄位傳 undefined 即清除。 */
  setProjectMeta: (patch: { projectType?: CanvasProjectType; currentStep?: number; episodes?: CanvasEpisode[]; styleId?: string; scriptType?: string; narrationVoice?: string }) => void;
  // ── 角色/場景卡（P2 跨鏡頭一致性）：卡列表 + 項目級鎖定
  characterCards: CharacterCard[];
  /** 鎖定到當前畫布項目的卡 id（持久化在 CanvasProject.cardIds）。 */
  activeCardIds: string[];
  /** 鎖定中的卡實體（生成時自動注入：片段前綴 + 參考圖 + 負面詞）。 */
  activeCharacterCards: CharacterCard[];
  /**
   * REQ-B2b：掛用（copy-on-use）產生的本地副本鎖定/解鎖。
   * 項目資產庫面板掛用後把回應的 `localCopyIds` 傳進來（解除掛用則把副本解鎖）。
   * 這是「畫面標已掛用」與「生成真的注入副本」之間唯一的接線。
   */
  applyMountCopyChange: (change: { locked: string[]; unlocked: string[] }) => Promise<void>;
  /** 建卡/更新卡（upsert）。 */
  upsertCharacterCard: (card: CharacterCard) => Promise<boolean>;
  /** 刪卡（同時解除鎖定）。 */
  removeCharacterCard: (id: string) => Promise<boolean>;
  /** 鎖定/解鎖（解鎖=從項目卡列表移除，歷史結果不受影響）。 */
  toggleCharacterCard: (id: string) => void;
  // ── 幾何工具（元件用）
  pathFor: (connection: CanvasConnection) => string | null;
}
