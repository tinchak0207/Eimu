// 畫布 chat 的展示型類型與介面（自 use-canvas-chat.ts 外圍搬遷，符號名不變）。
// use-canvas-chat.ts 仍是唯一匯出點（barrel），消費端 import 路徑零改動。
import { CARD_NAME_KEYS, cleanEmitsEntity, toCardMetadataName, toNodeFontSize } from "@/lib/canvas/layout";
import type { AgentSseEvent } from "@/lib/agent-chat-types";
import type { CharacterCard } from "@/lib/character-cards";
import { compactStoryboardShot } from "@/lib/storyboard-contract";
import type {
  CanvasAgentOp,
  CanvasAgentOpsEvent,
  CanvasConnection,
  CanvasEpisode,
  CanvasNode,
  CanvasNodeMetadata,
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

/** CanvasProject[] → 清單摘要，依 updatedAt 由新到舊。 */
export function toProjectSummaries(projects: CanvasProject[]): CanvasProjectSummary[] {
  return projects
    .map((p) => ({
      id: p.id,
      title: p.title || "未命名画布",
      updatedAt: p.updatedAt,
      nodeCount: Array.isArray(p.nodes) ? p.nodes.length : 0,
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

/** agent 快照的 metadata 壓縮：content 超 240 字截 120、prompt 截 120，不餵 base64 長文。 */
export function compactMetadataForAgent(metadata: CanvasNodeMetadata | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, unknown> = {};
  if (metadata.content) {
    out.content = metadata.content.length > 240 ? `${metadata.content.slice(0, 120)}…` : metadata.content;
  }
  if (metadata.prompt) out.prompt = metadata.prompt.slice(0, 120);
  if (metadata.model) out.model = metadata.model;
  if (metadata.size) out.size = metadata.size;
  if (metadata.status) out.status = metadata.status;
  // reference 節點角色讓 agent 知道「這張圖以什麼身份參與生成」。
  if (metadata.referenceRole) out.referenceRole = metadata.referenceRole;
  // 後端 workflow 骨架節點：產出合同/驗收門禁各一行透傳——agent 讀畫布狀態時
  // 也該看到本步的合同與門禁（漏傳 = 下行還原後骨架失語義）。
  if (metadata.deliverable) out.deliverable = metadata.deliverable;
  if (metadata.gate) out.gate = metadata.gate;
  if (typeof metadata.count === "number") out.count = metadata.count;
  if (typeof metadata.cost_coins === "number") out.cost_coins = metadata.cost_coins;
  // derived 工具卡/門禁卡/配方卡（後端 pipelineCard:"tool"|"gate"|"note"，kind=text）：
  // 六欄透傳——agent 讀畫布狀態時也該看到工具調用與「harness 未接上游」標記
  //（漏傳 = 下行還原後工具卡失語義，2026-09-03 director 空殼事故同構）。
  // note（配方卡）只有 content 一欄（上方 content 截斷已帶），pipelineCard 標記本身
  // 透傳才知下行還原時該鋪成配方卡。
  if (metadata.pipelineCard === "tool" || metadata.pipelineCard === "gate" || metadata.pipelineCard === "note") {
    out.pipelineCard = metadata.pipelineCard;
    if (metadata.toolId) out.toolId = metadata.toolId;
    if (metadata.toolInput) out.toolInput = metadata.toolInput;
    if (metadata.toolOutput) out.toolOutput = metadata.toolOutput;
    if (typeof metadata.unsupported === "boolean") out.unsupported = metadata.unsupported;
    if (metadata.requiredCapability) out.requiredCapability = metadata.requiredCapability;
  }
  // director 節點：只回傳指針欄位，SVG（可達 48KB×2）維持排除——agent 用 director 工具
  // 讀工程真值、不讀 SVG；回傳會吃 512KB 快照額度。缺指針的後果（2026-09-03 事故）：
  // 刷新/恢復後下行還原出空殼 director 節點，NodeBody 落到「示意图未同步」兜底。
  // 有 directorSessionId + revision 即可：小視口經 /director/state 拉 gateway 持久化的
  // 工程重渲染 3D 白模，SVG 僅在 WebGL 失敗時才需要（屆時顯示降級佔位，可接受）。
  if (metadata.pipelineCard === "director") {
    out.pipelineCard = "director";
    if (metadata.directorSessionId) out.directorSessionId = metadata.directorSessionId;
    if (metadata.planName !== undefined) out.planName = metadata.planName;
    if (typeof metadata.shotCount === "number") out.shotCount = metadata.shotCount;
    if (typeof metadata.healthOk === "boolean") out.healthOk = metadata.healthOk;
    if (typeof metadata.revision === "number") out.revision = metadata.revision;
  }
  // 3D 場景卡節點（Astra PRD P1-3）：sceneCard 欄位族整族透傳——六欄全是小指針
  // （URL/路徑/一句摘要/時長），無 SVG 級重料；漏傳 = 刷新後 3D 場景卡變空殼
  //（2026-09-03 快照壓縮器 director 事故同構）。往復合同測試釘死。
  if (metadata.sceneCard) {
    out.sceneCard = metadata.sceneCard;
  }
  // 分鏡實體（2026-09-15 刀 2）：AID 21 欄整族透傳（逐欄截 STORYBOARD_SNAPSHOT_FIELD_CHARS）。
  // 同屬「漏傳 = 刷新/換裝置後空殼」病灶（2026-09-03 director 事故同構）：agent 產的
  // 21 欄分鏡經 canvas_apply_ops 寫進節點後，這份快照是回舊會話時
  // restoreAgentSnapshot 的唯一資料源。
  // 為何不在這裡寫 21 個 if：欄位清單只准一份（storyboard-contract.ts），壓縮下放純函數
  //（compactStoryboardShot），未來加欄自動跟上、不製造第二個漂移點。
  if (metadata.storyboardShot) {
    out.storyboardShot = compactStoryboardShot(metadata.storyboardShot);
  }
  if (metadata.storyboardScene) {
    out.storyboardScene = metadata.storyboardScene;
  }
  // 分鏡實體的卡引用＋自動落卡標記（WS7 收口，2026-09-24）：與 storyboardShot 同族的
  // 雙白名單欄位——漏傳 = 回舊會話/換裝置還原後分鏡節點失去卡引用、落卡標記消失
  //（同 2026-09-03 director 空殼病灶）。往復合同測試釘死。
  const characterCardIds = cleanIdList(metadata.characterCardIds);
  const sceneCardIds = cleanIdList(metadata.sceneCardIds);
  const propCardIds = cleanIdList(metadata.propCardIds);
  if (characterCardIds) out.characterCardIds = characterCardIds;
  if (sceneCardIds) out.sceneCardIds = sceneCardIds;
  if (propCardIds) out.propCardIds = propCardIds;
  if (metadata.entityCardId) out.entityCardId = metadata.entityCardId;
  // 模板交付自動落卡（2026-09-24）：emitsEntity（結構化物件，走與讀取端
  // `layout.toNodeMetadata` **同一份**清洗）＋卡名三鍵（`nameFrom:"input"` 的來源）。
  // 與上面 storyboardShot/卡引用同族的雙白名單欄位——漏傳 = 上行後實體宣告自快照
  // 消失、還原時一卡都落不成（同 2026-09-03 director 空殼病灶）。
  // 型別註記：`CanvasNodeMetadata` 尚未宣告這四鍵（本刀擁有清單不含 types.ts），
  // 故以寬化袋子讀；寫進 `out`（Record<string, unknown>）不受影響。
  const bag = metadata as Record<string, unknown>;
  const emitsEntity = cleanEmitsEntity(bag.emitsEntity);
  if (emitsEntity) out.emitsEntity = emitsEntity;
  for (const key of CARD_NAME_KEYS) {
    const name = toCardMetadataName(bag[key]);
    if (name) out[key] = name;
  }
  // 文本節點字號（2026-09-25）：與還原端同一把尺（有限數、整數、10..28）——漏此端＝
  // 回舊會話/換裝置後字號憑空回到 14.5（讀取端 NodeBody.tsx:431 讀的就是本鍵）。
  const fontSize = toNodeFontSize(bag.fontSize);
  if (fontSize !== undefined) out.fontSize = fontSize;
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
  loadProject: (project: { nodes?: unknown; connections?: unknown; viewport?: CanvasViewport; backgroundMode?: CanvasBackgroundMode; title?: string; projectType?: unknown; currentStep?: unknown; episodes?: unknown }) => void;
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
  /** 三欄的唯一寫入口（UI 面板與 agent 驅動路徑共用）；欄位傳 undefined 即清除。 */
  setProjectMeta: (patch: { projectType?: CanvasProjectType; currentStep?: number; episodes?: CanvasEpisode[] }) => void;
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
