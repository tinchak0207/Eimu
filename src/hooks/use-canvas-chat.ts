"use client";

// 畫布 + chat 的整合 hook。
//
// 一條 SSE、兩個狀態機：useAgentChat 管連線與 transcript，這裡管畫布。
// 分流在 use-agent-chat.ts 的 handleSseEvent（onCanvasEvent 出口），
// 所以畫布頁不會另開一個 session —— 開兩個 session 會讓 agent 出的圖
// 落在另一條流上，畫布永遠等不到事件。
//
// 職責邊界：
//   - 事件 → 畫布狀態：normalizeCanvasEvent + reduceCanvasEvent（純函式，已測）
//   - 視口/背景/選取：本地 state，不上送
//   - 專案持久化：debounce 400ms PUT /api/canvas/projects
//   - undo/redo：節點/連線/視口的快照棧

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AgentSseEvent, AgentImageDone } from "@/lib/agent-chat-types";
import { CANVAS_INITIAL_STATE, reduceCanvasEvent, type CanvasReducerState } from "@/lib/canvas/reducer";
import {
  CANVAS_EMPTY_HISTORY,
  CANVAS_READABLE_MIN_SCALE,
  bezierPath,
  clampScale,
  fitToNodes,
  fromCanvasProject,
  normalizeCanvasEvent,
  pushSnapshot,
  redoSnapshot,
  summarizeCanvasState,
  toCanvasProject,
  undoSnapshot,
  type CanvasHistory,
  type CanvasSnapshot,
} from "@/lib/canvas/layout";
import { listCanvasProjects, saveCanvasProject, postCanvasSnapshot, postCanvasOpsResult } from "@/lib/canvas/client";
import {
  deleteCharacterCards as deleteCharacterCardsRemote,
  listCharacterCards as fetchCharacterCardsRemote,
  saveCharacterCard as saveCharacterCardRemote,
} from "@/lib/character-card-client";
import type { CharacterCard } from "@/lib/character-cards";
import { CANVAS_NODE_DEFAULT_SIZE, CanvasNodeType } from "@/lib/canvas/types";
import type {
  CanvasAgentOp,
  CanvasAgentOpsEvent,
  CanvasConnection,
  CanvasNode,
  CanvasNodeMetadata,
  CanvasPlanEvent,
  CanvasPosition,
  CanvasProject,
  CanvasUnit,
  CanvasViewport,
} from "@/lib/canvas/types";

// ─────────────────────────────────────────── 畫布 action

/**
 * reduceCanvasEvent 的簽名是 (state, CanvasSseEvent)，不是標準 reducer。
 * 這裡包一層 adapter，同時容納「本端動作」（載入專案、拖動節點、undo 還原）。
 */
export type CanvasAction =
  | { type: "event"; event: AgentSseEvent }
  | { type: "load"; nodes: CanvasNode[]; connections: CanvasConnection[] }
  | { type: "move"; nodeId: string; position: CanvasPosition }
  | { type: "resize"; nodeId: string; width: number; height: number }
  | { type: "remove"; nodeId: string }
  | { type: "clear" }
  | { type: "batch_add_child"; parentId: string; child: CanvasNode }
  | { type: "batch_set_primary"; parentId: string; childId: string }
  | { type: "batch_delete_child"; parentId: string; childId: string }
  | { type: "batch_toggle_expanded"; parentId: string }
  | { type: "add_reference"; nodeId: string; referenceNodeId: string }
  | { type: "remove_reference"; nodeId: string; referenceNodeId: string }
  // Phase 3 畫布交互：群組拖動 / 貼上插入 / 多刪 / 手動連線
  | { type: "move_many"; moves: { nodeId: string; position: CanvasPosition }[] }
  | { type: "add_nodes"; nodes: CanvasNode[]; connections?: CanvasConnection[] }
  | { type: "delete_many"; nodeIds: string[] }
  | { type: "connect"; fromNodeId: string; toNodeId: string }
  | { type: "disconnect"; connectionId: string }
  // Wave A：就地編輯（改名 / metadata 補丁——文本直編、原地生成回填、字號）
  | { type: "rename"; nodeId: string; title: string }
  | { type: "patch_metadata"; nodeId: string; patch: Partial<CanvasNodeMetadata> }
  // Wave C：agent 批量操作（一次 dispatch = 一格歷史）
  | { type: "agent_ops"; ops: CanvasAgentOp[] };

/** reducer 純函式另行匯出：測試直接驅動 action，不用架 React。 */
export function canvasReducer(state: CanvasReducerState, action: CanvasAction): CanvasReducerState {
  switch (action.type) {
    case "event": {
      const normalized = normalizeCanvasEvent(action.event);
      // derive.started / budget.updated 不改畫布結構，由 hook 另存展示狀態。
      if (!normalized) return state;
      return reduceCanvasEvent(state, normalized);
    }
    case "load":
      return { units: [], nodes: action.nodes, connections: action.connections };
    case "move":
      return {
        ...state,
        // 手動拖過＝用戶接管這顆節點的位置，自動排版不再動它。
        nodes: state.nodes.map((n) => (n.id === action.nodeId ? { ...n, position: action.position, moved: true } : n)),
      };
    case "resize":
      return {
        ...state,
        nodes: state.nodes.map((n) =>
          n.id === action.nodeId ? { ...n, width: action.width, height: action.height } : n,
        ),
      };
    case "remove":
      return {
        units: state.units.map((u) => ({
          ...u,
          nodes: u.nodes.filter((n) => n.id !== action.nodeId),
          connections: u.connections.filter((c) => c.fromNodeId !== action.nodeId && c.toNodeId !== action.nodeId),
        })),
        nodes: state.nodes.filter((n) => n.id !== action.nodeId),
        connections: state.connections.filter(
          (c) => c.fromNodeId !== action.nodeId && c.toNodeId !== action.nodeId,
        ),
      };
    case "clear":
      return CANVAS_INITIAL_STATE;
    case "batch_add_child": {
      const { parentId, child } = action;
      const parent = state.nodes.find((n) => n.id === parentId);
      if (!parent) return state;
      const nextChildren = [...(parent.batchChildren ?? []), child.id];
      return {
        ...state,
        // 原位更新父節點（filter+append 會改變節點順序，連帶打亂進場動畫與 z 序）。
        nodes: [
          ...state.nodes.map((n) =>
            n.id === parentId
              ? {
                  ...n,
                  batchChildren: nextChildren,
                  batchExpanded: true,
                  // 首個子節點自動成為主圖：收起時封面才有東西可顯示。
                  batchPrimaryImageId: n.batchPrimaryImageId ?? child.id,
                  metadata: { ...n.metadata, batchTotal: nextChildren.length },
                }
              : n,
          ),
          child,
        ],
      };
    }
    case "batch_set_primary": {
      const { parentId, childId } = action;
      return {
        ...state,
        nodes: state.nodes.map((n) =>
          n.id === parentId ? { ...n, batchPrimaryImageId: childId } : n
        ),
      };
    }
    case "batch_delete_child": {
      const { parentId, childId } = action;
      const parent = state.nodes.find((n) => n.id === parentId);
      if (!parent) return state;
      const newChildren = (parent.batchChildren ?? []).filter((id) => id !== childId);
      return {
        ...state,
        nodes: state.nodes
          .filter((n) => n.id !== childId)
          .map((n) =>
            n.id === parentId
              ? {
                  ...n,
                  batchChildren: newChildren,
                  // 刪掉的是主圖 → fallback 到剩餘第一個子節點（沒有就清空）。
                  batchPrimaryImageId:
                    n.batchPrimaryImageId === childId ? newChildren[0] : n.batchPrimaryImageId,
                  metadata: { ...n.metadata, batchTotal: newChildren.length },
                }
              : n
          ),
        connections: state.connections.filter(
          (c) => c.fromNodeId !== childId && c.toNodeId !== childId
        ),
      };
    }
    case "batch_toggle_expanded": {
      const { parentId } = action;
      return {
        ...state,
        nodes: state.nodes.map((n) =>
          n.id === parentId ? { ...n, batchExpanded: !n.batchExpanded } : n
        ),
      };
    }
    case "add_reference": {
      const { nodeId, referenceNodeId } = action;
      return {
        ...state,
        nodes: state.nodes.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                metadata: {
                  ...n.metadata,
                  referenceNodeIds: [...new Set([...(n.metadata?.referenceNodeIds ?? []), referenceNodeId])],
                },
              }
            : n
        ),
      };
    }
    case "remove_reference": {
      const { nodeId, referenceNodeId } = action;
      return {
        ...state,
        nodes: state.nodes.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                metadata: {
                  ...n.metadata,
                  referenceNodeIds: (n.metadata?.referenceNodeIds ?? []).filter((id) => id !== referenceNodeId),
                },
              }
            : n
        ),
      };
    }
    case "move_many": {
      // 群組拖動：一幀一個 dispatch 移動整組（逐顆 dispatch 會讓 React 重渲染 N 次）。
      const byId = new Map(action.moves.map((m) => [m.nodeId, m.position]));
      if (byId.size === 0) return state;
      return {
        ...state,
        nodes: state.nodes.map((n) => {
          const pos = byId.get(n.id);
          return pos ? { ...n, position: pos, moved: true } : n;
        }),
      };
    }
    case "add_nodes": {
      // 貼上/切圖插入：id 由呼叫端保證不撞（cloneForPaste 已防撞）。撞了就以新值覆蓋，不重複。
      if (action.nodes.length === 0 && !(action.connections?.length)) return state;
      const incomingIds = new Set(action.nodes.map((n) => n.id));
      const keptNodes = state.nodes.filter((n) => !incomingIds.has(n.id));
      const existingConn = new Set(state.connections.map((c) => c.id));
      const newConns = (action.connections ?? []).filter((c) => !existingConn.has(c.id));
      return {
        ...state,
        nodes: [...keptNodes, ...action.nodes],
        connections: [...state.connections, ...newConns],
      };
    }
    case "delete_many": {
      const dead = new Set(action.nodeIds);
      if (dead.size === 0) return state;
      return {
        units: state.units.map((u) => ({
          ...u,
          nodes: u.nodes.filter((n) => !dead.has(n.id)),
          connections: u.connections.filter((c) => !dead.has(c.fromNodeId) && !dead.has(c.toNodeId)),
        })),
        nodes: state.nodes
          .filter((n) => !dead.has(n.id))
          .map((n) => {
            if (!n.batchChildren?.some((id) => dead.has(id))) return n;
            const kept = n.batchChildren.filter((id) => !dead.has(id));
            return {
              ...n,
              batchChildren: kept,
              // 主圖被刪 → fallback 剩餘第一個；全刪光 → 清空。
              batchPrimaryImageId:
                n.batchPrimaryImageId && dead.has(n.batchPrimaryImageId) ? kept[0] : n.batchPrimaryImageId,
              metadata: { ...n.metadata, batchTotal: kept.length },
            };
          }),
        connections: state.connections.filter((c) => !dead.has(c.fromNodeId) && !dead.has(c.toNodeId)),
      };
    }
    case "connect": {
      const { fromNodeId, toNodeId } = action;
      // 自環與空端點拒絕；同向重複連線去重。
      if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return state;
      if (state.connections.some((c) => c.fromNodeId === fromNodeId && c.toNodeId === toNodeId)) return state;
      return {
        ...state,
        connections: [...state.connections, { id: `conn-${fromNodeId}-${toNodeId}`, fromNodeId, toNodeId }],
      };
    }
    case "disconnect": {
      return {
        ...state,
        connections: state.connections.filter((c) => c.id !== action.connectionId),
      };
    }
    case "rename": {
      const title = action.title.trim().slice(0, 120);
      if (!title) return state;
      return {
        ...state,
        nodes: state.nodes.map((n) => (n.id === action.nodeId ? { ...n, title } : n)),
      };
    }
    case "patch_metadata": {
      return {
        ...state,
        nodes: state.nodes.map((n) =>
          n.id === action.nodeId ? { ...n, metadata: { ...n.metadata, ...action.patch } } : n,
        ),
      };
    }
    case "agent_ops": {
      // Agent 批量操作原子套用：一次 dispatch = 撤銷棧一格，中途壞 op 跳過不炸整批。
      let next = state;
      for (const op of action.ops) {
        switch (op.type) {
          case "add_node": {
            const node = normalizeAgentNode(op.node, next.nodes);
            if (node) next = { ...next, nodes: [...next.nodes, node] };
            break;
          }
          case "update_node": {
            next = {
              ...next,
              nodes: next.nodes.map((n) =>
                n.id === op.id
                  ? {
                      ...n,
                      ...(op.patch.title ? { title: op.patch.title.slice(0, 120) } : {}),
                      ...(op.patch.position ? { position: op.patch.position, moved: true } : {}),
                      ...(typeof op.patch.width === "number" ? { width: Math.max(120, op.patch.width) } : {}),
                      ...(typeof op.patch.height === "number" ? { height: Math.max(90, op.patch.height) } : {}),
                      ...(op.patch.metadata ? { metadata: { ...n.metadata, ...op.patch.metadata } } : {}),
                    }
                  : n,
              ),
            };
            break;
          }
          case "delete_nodes":
            next = canvasReducer(next, { type: "delete_many", nodeIds: op.ids });
            break;
          case "connect_nodes":
            for (const c of op.connections) {
              next = canvasReducer(next, { type: "connect", fromNodeId: c.fromNodeId, toNodeId: c.toNodeId });
            }
            break;
          case "delete_connections":
            next = { ...next, connections: next.connections.filter((c) => !op.ids.includes(c.id)) };
            break;
          default:
            // select_nodes / set_viewport / run_generation 不是畫布結構，hook 層處理。
            break;
        }
      }
      return next;
    }
  }
}

/** agent add_node → 完整 CanvasNode：缺尺寸取型別預設、id 撞號丟棄、type 不認識降級文本。 */
function normalizeAgentNode(
  raw: Partial<CanvasNode> & { id: string; type: CanvasNodeType | string },
  existing: CanvasNode[],
): CanvasNode | null {
  if (!raw.id || existing.some((n) => n.id === raw.id)) return null;
  const type = (Object.values(CanvasNodeType) as string[]).includes(String(raw.type))
    ? (raw.type as CanvasNodeType)
    : CanvasNodeType.Text;
  const preset = CANVAS_NODE_DEFAULT_SIZE[type];
  return {
    id: raw.id,
    type,
    title: (raw.title ?? preset.title).slice(0, 120),
    position: raw.position ?? { x: 40, y: 40 },
    width: raw.width ?? preset.width,
    height: raw.height ?? preset.height,
    ...(raw.metadata ? { metadata: raw.metadata } : {}),
    moved: true,
  };
}

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
function toProjectSummaries(projects: CanvasProject[]): CanvasProjectSummary[] {
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

/** agent 快照的 metadata 壓縮：content 超 240 字截 120、prompt 截 120，不餵 base64 長文。 */
function compactMetadataForAgent(metadata: CanvasNodeMetadata | undefined): Record<string, unknown> | undefined {
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
  if (typeof metadata.count === "number") out.count = metadata.count;
  if (typeof metadata.cost_coins === "number") out.cost_coins = metadata.cost_coins;
  return Object.keys(out).length > 0 ? out : undefined;
}

const SAVE_DEBOUNCE_MS = 400;
const PLAN_CARD_LIMIT = 30;
const DERIVE_CARD_LIMIT = 20;
/** 進度節流窗（行動端）：canvas.node.generating 可能高頻送達（後端進度流），
 *  低階裝置上每幀整張畫布重渲染會掉幀。同節點每窗最多落地一次 reducer，
 *  窗內只留最新一筆、窗末補送——最後的 progress 不會遺失。 */
const PROGRESS_THROTTLE_MS = 120;

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
  deleteNodes: (nodeIds: string[]) => void;
  addConnection: (fromNodeId: string, toNodeId: string) => void;
  removeConnection: (connectionId: string) => void;
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
  loadProject: (project: { nodes?: unknown; connections?: unknown; viewport?: CanvasViewport; backgroundMode?: CanvasBackgroundMode; title?: string }) => void;
  exportProject: () => CanvasProject;
  clearCanvas: () => void;
  newCanvasSession: () => void;
  // ── 歷史清單
  savedProjects: CanvasProjectSummary[];
  refreshSavedProjects: () => Promise<void>;
  openSavedCanvas: (id: string) => Promise<void>;
  // ── 角色/場景卡（P2 跨鏡頭一致性）：卡列表 + 項目級鎖定
  characterCards: CharacterCard[];
  /** 鎖定到當前畫布項目的卡 id（持久化在 CanvasProject.cardIds）。 */
  activeCardIds: string[];
  /** 鎖定中的卡實體（生成時自動注入：片段前綴 + 參考圖 + 負面詞）。 */
  activeCharacterCards: CharacterCard[];
  /** 建卡/更新卡（upsert）。 */
  upsertCharacterCard: (card: CharacterCard) => Promise<boolean>;
  /** 刪卡（同時解除鎖定）。 */
  removeCharacterCard: (id: string) => Promise<boolean>;
  /** 鎖定/解鎖（解鎖=從項目卡列表移除，歷史結果不受影響）。 */
  toggleCharacterCard: (id: string) => void;
  // ── 幾何工具（元件用）
  pathFor: (connection: CanvasConnection) => string | null;
}

export function useCanvasChat(sessionId?: string | null): UseCanvasChatReturn {
  const [canvas, dispatchCanvas] = useReducer(canvasReducer, CANVAS_INITIAL_STATE);
  const [plans, setPlans] = useState<CanvasPlanCard[]>([]);
  const [derives, setDerives] = useState<CanvasDeriveCard[]>([]);
  const [budget, setBudget] = useState<CanvasBudget | null>(null);
  const [viewport, setViewportState] = useState<CanvasViewport>({ x: 0, y: 0, k: 1 });
  const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("dots");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [history, setHistory] = useState<CanvasHistory>(CANVAS_EMPTY_HISTORY);
  const [projectTitle, setProjectTitle] = useState("未命名画布");
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<UseCanvasChatReturn["saveState"]>("idle");
  const [savedProjects, setSavedProjects] = useState<CanvasProjectSummary[]>([]);
  // Wave C：agent 下發、待確認/執行的批量畫布操作。
  const [pendingAgentOps, setPendingAgentOps] = useState<CanvasAgentOpsEvent | null>(null);
  // P2：角色/場景卡。characterCards = 用戶全部卡；activeCardIds = 鎖定到本畫布項目的卡。
  const [characterCards, setCharacterCards] = useState<CharacterCard[]>([]);
  const [activeCardIds, setActiveCardIds] = useState<string[]>([]);

  // ── refs：給不參與 render 的路徑讀最新值
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const backgroundRef = useRef(backgroundMode);
  backgroundRef.current = backgroundMode;
  const prevSessionIdRef = useRef<string | null | undefined>(null);
  const titleRef = useRef(projectTitle);
  titleRef.current = projectTitle;
  const budgetRef = useRef(budget);
  budgetRef.current = budget;
  const selectedNodeIdRef = useRef(selectedNodeId);
  selectedNodeIdRef.current = selectedNodeId;
  const pendingAgentOpsRef = useRef(pendingAgentOps);
  pendingAgentOpsRef.current = pendingAgentOps;
  const characterCardsRef = useRef(characterCards);
  characterCardsRef.current = characterCards;
  const activeCardIdsRef = useRef(activeCardIds);
  activeCardIdsRef.current = activeCardIds;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  /** flyTo 動畫的 rAF 句柄（新動畫/卸載時取消）。 */
  const flyRafRef = useRef<number | null>(null);

  const projectIdRef = useRef<string | null>(null);
  const createdAtRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  // 進度節流用的兩張表：node_id → 計時器 / 最新待送事件。
  const progressTimerRef = useRef<Map<string, number>>(new Map());
  const progressPendingRef = useRef<Map<string, AgentSseEvent>>(new Map());
  const mountedRef = useRef(true);
  // 載入完成前不要存：初始空畫布會把雲端那份覆蓋成空的。
  const hydratedRef = useRef(false);
  // 撤銷/重做正在還原時不推快照，否則按一下撤銷會先把自己存進 past。
  const restoringRef = useRef(false);
  // 畫布是否曾有節點：空專案不存，避免歷史清單塞滿剛開又關的空殼。
  const everHadNodesRef = useRef(false);
  // 最終一致性收斂：image.done 的 URL 佇列，供 settleStaleNodes 對賬用。
  const imageDoneQueueRef = useRef<AgentImageDone[]>([]);

  // ─────────────────────── 角色/場景卡（P2 跨鏡頭一致性）

  /** 進頁載入用戶全部卡。失敗靜默：卡是順手鎖定的配置，不打擾創作。 */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetchCharacterCardsRemote();
      if (!cancelled && res.ok && res.data) setCharacterCards(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 鎖定中的卡實體：生成時注入的就是這份（applyCharacterCards 按 id 序冪等注入）。 */
  const activeCharacterCards = useMemo(
    () => characterCards.filter((c) => activeCardIds.includes(c.id)),
    [characterCards, activeCardIds],
  );

  const upsertCharacterCard = useCallback(async (card: CharacterCard): Promise<boolean> => {
    const res = await saveCharacterCardRemote(card);
    if (!res.ok) return false;
    setCharacterCards((prev) => [card, ...prev.filter((c) => c.id !== card.id)]);
    return true;
  }, []);

  const removeCharacterCard = useCallback(async (id: string): Promise<boolean> => {
    const res = await deleteCharacterCardsRemote([id]);
    if (!res.ok) return false;
    setCharacterCards((prev) => prev.filter((c) => c.id !== id));
    // 刪卡同時解除鎖定（該 id 不再出現在項目 cardIds）。
    setActiveCardIds((prev) => prev.filter((x) => x !== id));
    return true;
  }, []);

  const toggleCharacterCard = useCallback((id: string) => {
    setActiveCardIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  // ─────────────────────── 換畫布 / 歷史清單

  /** 開一張全新畫布（換 session 或使用者手動「新建画布」）。 */
  const newCanvasSession = useCallback(() => {
    // 舊的 debounce 存檔若還掛著，會拿新 projectId 存出空畫布、或拿舊 projectId
    // 覆蓋掉剛開的新畫布 —— 換畫布前先把它作廢。
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    dispatchCanvas({ type: "clear" });
    setPlans([]);
    setDerives([]);
    setBudget(null);
    setSelectedNodeId(null);
    setHistory(CANVAS_EMPTY_HISTORY);
    setProjectTitle("未命名画布");
    setViewportState({ x: 0, y: 0, k: 1 });
    // 新畫布 = 新項目：卡鎖定是項目級配置，隨舊項目留在歷史裡。
    setActiveCardIds([]);
    // 新畫布要有新身份：後續存檔才會寫進新的一份，而不是覆寫上一張。
    projectIdRef.current = `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createdAtRef.current = new Date().toISOString();
    everHadNodesRef.current = false;
    // 舊節點的進度幀不能再落地到新畫布（否則 loading 會憑空冒出來）。
    for (const t of progressTimerRef.current.values()) window.clearTimeout(t);
    progressTimerRef.current.clear();
    progressPendingRef.current.clear();
  }, []);

  const refreshSavedProjects = useCallback(async () => {
    const res = await listCanvasProjects();
    if (!mountedRef.current) return;
    if (res.ok && res.data) setSavedProjects(toProjectSummaries(res.data));
    // 失敗時靜默保留舊值：清單是「順手看」，不值得為網路抖動清空畫面。
  }, []);

  const openSavedCanvas = useCallback(async (id: string) => {
    const res = await listCanvasProjects();
    if (!mountedRef.current) return;
    const target = res.ok && res.data ? res.data.find((p) => p.id === id) : undefined;
    if (!target) return;
    // 指向舊專案身份：之後的存檔覆寫它，而不是另存一份新畫布。
    projectIdRef.current = target.id;
    createdAtRef.current = target.createdAt;
    everHadNodesRef.current = target.nodes && target.nodes.length > 0;
    const restored = fromCanvasProject(target);
    dispatchCanvas({ type: "load", nodes: restored.nodes, connections: restored.connections });
    setViewportState(target.viewport ?? { x: 0, y: 0, k: 1 });
    setBackgroundMode(target.backgroundMode ?? "dots");
    setProjectTitle(target.title || "未命名画布");
    setActiveCardIds(Array.isArray(target.cardIds) ? target.cardIds.filter(Boolean) : []);
    if (target.budget) {
      setBudget({
        usedCoins: target.budget.usedCoins,
        remainingCoins: Math.max(0, target.budget.totalCoins - target.budget.usedCoins),
        updatedAt: Date.now(),
      });
    } else {
      setBudget(null);
    }
    // 換載入的畫布是一條全新時間線：歷史、選取、展示卡都歸零。
    setHistory(CANVAS_EMPTY_HISTORY);
    setSelectedNodeId(null);
    setPlans([]);
    setDerives([]);
  }, []);

  // 監聽 sessionId 變化：換 agent 會話 = 換一張畫布，避免舊畫布跑進新會話。
  useEffect(() => {
    if (!sessionId) return;
    if (sessionId === prevSessionIdRef.current) return;
    const isFirst = prevSessionIdRef.current == null;
    prevSessionIdRef.current = sessionId;
    // 首次拿到 session：畫布本來就是空的（已不再自動還原），不必重置，
    // 否則會白白丟掉 mount 時 mint 的 projectId。
    if (isFirst) return;
    newCanvasSession();
  }, [sessionId, newCanvasSession]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      if (flyRafRef.current !== null) cancelAnimationFrame(flyRafRef.current);
      for (const t of progressTimerRef.current.values()) window.clearTimeout(t);
      progressTimerRef.current.clear();
      progressPendingRef.current.clear();
    };
  }, []);

  // ─────────────────────── 快照

  const snapshotNow = useCallback((): CanvasSnapshot => {
    return {
      nodes: canvasRef.current.nodes,
      connections: canvasRef.current.connections,
      viewport: viewportRef.current,
    };
  }, []);

  /** 動作前推一格快照。事件驅動的變更也推，這樣「撤銷」能收回 agent 剛加的節點。 */
  const pushHistory = useCallback(() => {
    if (restoringRef.current) return;
    setHistory((prev) => pushSnapshot(prev, snapshotNow()));
  }, [snapshotNow]);

  // ─────────────────────── SSE 畫布事件入口

  const handleCanvasEvent = useCallback(
    (event: AgentSseEvent) => {
      // ── 最終一致性收斂（2026-08-16 根因修復）──
      // gateway 對「上游無 task_id」的工具結果只發 image.done、不發
      // canvas.node.updated，畫布節點會永久卡 loading。這裡用 image.done 的
      // url 把節點落地：task_id 配對優先，回合結束時按序配對兜底。
      const isPendingSettledNode = (n: CanvasNode): boolean =>
        (n.type === CanvasNodeType.Image || n.type === CanvasNodeType.Video) &&
        !n.metadata?.content &&
        (!n.metadata?.status || n.metadata.status === "loading");

      const settleNodeWithUrl = (nodeId: string, url: string, costCoins?: number) => {
        // 落地與 canvas.node.updated 同語義：該節點排隊中的進度幀作廢；
        // 結果落地不可撤（與 gateway 的 updated 事件一致，不推歷史快照）。
        const t = progressTimerRef.current.get(nodeId);
        if (t !== undefined) {
          window.clearTimeout(t);
          progressTimerRef.current.delete(nodeId);
          progressPendingRef.current.delete(nodeId);
        }
        dispatchCanvas({
          type: "event",
          event: {
            name: "canvas.node.updated",
            event_id: 0,
            data: {
              unit_id: "",
              node_id: nodeId,
              patch: { status: "success" as const },
              url,
              ...(typeof costCoins === "number" ? { cost_coins: costCoins } : {}),
            },
          },
        });
      };

      const settleCandidateNode = (done: AgentImageDone) => {
        if (!done.url) return;
        const state = canvasRef.current;
        const target = state.nodes.find(
          (n) => isPendingSettledNode(n) && !!n.metadata?.imageTaskId && n.metadata.imageTaskId === done.task_id,
        );
        if (!target) return;
        const queue = imageDoneQueueRef.current;
        const idx = queue.findIndex((q) => q.url === done.url);
        if (idx >= 0) queue.splice(idx, 1);
        settleNodeWithUrl(target.id, done.url, done.cost_coins);
      };

      const settleStaleNodes = () => {
        const queue = imageDoneQueueRef.current;
        if (queue.length === 0) return;
        const pending = canvasRef.current.nodes.filter(isPendingSettledNode);
        if (pending.length === 0) return;
        const settled = new Set<string>();
        // 第一輪：task_id 精確配對。
        for (const node of pending) {
          const taskId = node.metadata?.imageTaskId;
          if (!taskId) continue;
          const idx = queue.findIndex((q) => q.task_id === taskId);
          if (idx >= 0) {
            const [hit] = queue.splice(idx, 1);
            settleNodeWithUrl(node.id, hit.url, hit.cost_coins);
            settled.add(node.id);
          }
        }
        // 第二輪：剩餘節點按序配對（gateway 建節點與發 image.done 同順序）。
        for (const node of pending) {
          if (settled.has(node.id)) continue;
          const hit = queue.shift();
          if (!hit) break;
          settleNodeWithUrl(node.id, hit.url, hit.cost_coins);
        }
        // 回合已結束：殘留的 url 不再跨回合污染（節點都不存在了，url 無家可歸）。
        imageDoneQueueRef.current.length = 0;
      };

      // Wave C：agent 批量操作先落確認閘（不直接進 reducer）。
      if (event.name === "canvas.ops") {
        if (event.data?.request_id && Array.isArray(event.data?.ops)) {
          setPendingAgentOps(event.data);
        }
        return;
      }
      switch (event.name) {
        case "canvas.plan":
          setPlans((prev) => {
            if (prev.some((p) => p.unit_id === event.data.unit_id)) return prev;
            const next = [...prev, { ...event.data, receivedAt: Date.now() }];
            return next.slice(Math.max(0, next.length - PLAN_CARD_LIMIT));
          });
          return;
        case "canvas.derive.started":
          setDerives((prev) => {
            const next = [
              ...prev,
              {
                unitId: event.data.unit_id,
                sourceNodeId: event.data.source_node_id,
                instruction: event.data.instruction,
                ...(event.data.interpretation ? { interpretation: event.data.interpretation } : {}),
                receivedAt: Date.now(),
              },
            ];
            return next.slice(Math.max(0, next.length - DERIVE_CARD_LIMIT));
          });
          return;
        case "canvas.budget.updated":
          setBudget({
            usedCoins: event.data.used_coins,
            remainingCoins: event.data.remaining_coins,
            updatedAt: Date.now(),
          });
          return;
        case "image.done": {
          // 圖完成訊號：入隊並立即嘗試用 task_id 配對落地，卡 loading 的節點
          // 不依賴 gateway 一定發 canvas.node.updated（上游無 task_id 時 gateway
          // 只發 image.done，畫布會永遠轉圈 —— 見 2026-08-16 根因分析）。
          imageDoneQueueRef.current.push(event.data);
          settleCandidateNode(event.data);
          return;
        }
        case "turn.done":
        case "session.closed":
          // 回合/會話結束：最後收斂，把仍卡 loading 的節點按序配對落地。
          settleStaleNodes();
          return;
        default:
          break;
      }
      // 結構性事件：進 reducer。節點增刪是可撤銷的動作，所以先存一格。
      if (event.name === "canvas.node.created" || event.name === "canvas.node.deleted" || event.name === "canvas.node.connected") {
        pushHistory();
      }

      // 進度節流（行動端）：canvas.node.generating 是高頻進度流（同節點每秒
      // 可能多幀）。每節點最多每 PROGRESS_THROTTLE_MS 落地一次 reducer，
      // 窗內只留最新一筆、窗末補送，最後的 progress 不會遺失。
      if (event.name === "canvas.node.generating") {
        const nodeId = event.data.node_id;
        progressPendingRef.current.set(nodeId, event);
        if (progressTimerRef.current.has(nodeId)) return;
        const timer = window.setTimeout(() => {
          progressTimerRef.current.delete(nodeId);
          const latest = progressPendingRef.current.get(nodeId);
          progressPendingRef.current.delete(nodeId);
          if (latest) dispatchCanvas({ type: "event", event: latest });
        }, PROGRESS_THROTTLE_MS);
        progressTimerRef.current.set(nodeId, timer);
        dispatchCanvas({ type: "event", event });
        return;
      }

      // 節點層級的新狀態落地（結果/刪除/新建）＝該節點排隊中的進度幀作廢，
      // 避免「結果都落地了又被舊進度幀蓋回 loading」。
      const supersededNodeId =
        event.name === "canvas.node.updated" || event.name === "canvas.node.deleted"
          ? event.data.node_id
          : event.name === "canvas.node.created"
            ? event.data.node.id
            : null;
      if (supersededNodeId) {
        const t = progressTimerRef.current.get(supersededNodeId);
        if (t !== undefined) {
          window.clearTimeout(t);
          progressTimerRef.current.delete(supersededNodeId);
          progressPendingRef.current.delete(supersededNodeId);
        }
      }

      dispatchCanvas({ type: "event", event });
    },
    [pushHistory],
  );

  // 對外事件入口：外部 chat（AgentChatSurface 的 onCanvasEvent）呼叫。
  const feedCanvasEvent = handleCanvasEvent;
  // 對外摘要提供者（外部 chat 的 canvasStateProvider 用）。空畫布回 undefined。
  // 附帶用戶當前選區與視口縮放：agent 不再是瞎子，能圍繞「用戶正在看的節點」幹活。
  const summarize = () => {
    const state = canvasRef.current;
    const lockedCards = characterCardsRef.current.filter((c) => activeCardIdsRef.current.includes(c.id));
    if (state.nodes.length === 0 && state.units.length === 0 && lockedCards.length === 0) return undefined;
    const base = summarizeCanvasState(state) as unknown as Record<string, unknown>;
    const selected = selectedNodeIdRef.current;
    if (selected) base.selected_node_id = selected;
    base.viewport_scale = Math.round(viewportRef.current.k * 100) / 100;
    // P2：鎖定卡進上行摘要（agent 可見——知道哪些外觀/場景約束已生效）。
    base.character_cards = lockedCards.map((c) => ({
      id: c.id,
      kind: c.kind,
      name: c.name,
      prompt: c.prompt,
      ...(c.negativePrompt ? { negative_prompt: c.negativePrompt } : {}),
      reference_count: c.references.length,
      ...(c.loraIds?.length ? { lora_ids: c.loraIds } : {}),
    }));
    return base;
  };

  // ─────────────────────── 進頁初始化（只抓歷史清單，不自動還原畫布）

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await listCanvasProjects();
      if (cancelled || !mountedRef.current) return;
      if (res.ok && res.data) {
        setSavedProjects(toProjectSummaries(res.data));
      } else if (res.reason === "not_authenticated") {
        // 沒登入：畫布照常能用，只是不存雲端。不擋路、也不假裝存了。
        setSaveState("offline");
      }
      // 進頁永遠開一張全新畫布：不還原最近一份 —— 那正是新舊 session 混淆的根源。
      projectIdRef.current = `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createdAtRef.current = new Date().toISOString();
      hydratedRef.current = true;
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ─────────────────────── 專案儲存（debounce 400ms）

  const buildProject = useCallback((): CanvasProject => {
    const id = projectIdRef.current ?? `canvas-${Date.now()}`;
    const b = budgetRef.current;
    return toCanvasProject(
      { id, title: titleRef.current, ...(createdAtRef.current ? { createdAt: createdAtRef.current } : {}) },
      canvasRef.current,
      viewportRef.current,
      backgroundRef.current,
      b ? { totalCoins: b.usedCoins + b.remainingCoins, usedCoins: b.usedCoins } : undefined,
      activeCardIdsRef.current,
    );
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    if (saveState === "offline") return;
    // 有節點才記住「曾經有過」；空畫布從不寫入歷史（避免塞滿剛開又關的空殼）。
    if (canvas.nodes.length > 0) everHadNodesRef.current = true;
    if (canvas.nodes.length === 0 && !everHadNodesRef.current) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      const project = buildProject();
      setSaveState("saving");
      void saveCanvasProject(project).then((res) => {
        if (!mountedRef.current) return;
        if (res.ok) setSaveState("saved");
        else setSaveState(res.reason === "not_authenticated" ? "offline" : "error");
      });
    }, SAVE_DEBOUNCE_MS);
    // 依賴畫布本體與視口/背景/標題：任何一項變化都該落盤。
    // saveState 刻意不進依賴 —— 它由這個 effect 自己寫，進去會變成自觸發循環。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas, viewport, backgroundMode, projectTitle, activeCardIds, buildProject]);

  // ─────────────────────── Wave C1：壓縮快照上行（agent 的眼睛）
  // 300ms 尾隨防抖：持續平移/拖動期間不上報，停手才推最新一幀。失敗靜默。
  useEffect(() => {
    if (!sessionId) return;
    const t = window.setTimeout(() => {
      void postCanvasSnapshot(sessionId, {
        nodes: canvas.nodes.map((n) => ({
          id: n.id,
          type: String(n.type),
          title: n.title,
          position: n.position,
          width: n.width,
          height: n.height,
          ...(compactMetadataForAgent(n.metadata) ? { metadata: compactMetadataForAgent(n.metadata) } : {}),
        })),
        connections: canvas.connections,
        selectedNodeIds: selectedNodeId ? [selectedNodeId] : [],
        viewport,
        // P2：鎖定卡進快照（agent 的 canvas_get_state 讀這份）。
        character_cards: activeCharacterCards.map((c) => ({
          id: c.id,
          kind: c.kind,
          name: c.name,
          prompt: c.prompt,
          ...(c.negativePrompt ? { negative_prompt: c.negativePrompt } : {}),
          reference_count: c.references.length,
          ...(c.loraIds?.length ? { lora_ids: c.loraIds } : {}),
        })),
      });
    }, 300);
    return () => window.clearTimeout(t);
  }, [sessionId, canvas.nodes, canvas.connections, selectedNodeId, viewport, activeCharacterCards]);

  // ─────────────────────── 視口

  const setViewport = useCallback((next: CanvasViewport | ((prev: CanvasViewport) => CanvasViewport)) => {
    setViewportState((prev) => (typeof next === "function" ? next(prev) : next));
  }, []);

  const cycleBackground = useCallback(() => {
    setBackgroundMode((prev) => (prev === "dots" ? "lines" : prev === "lines" ? "blank" : "dots"));
  }, []);

  const fitView = useCallback(
    (width: number, height: number) => {
      pushHistory();
      setViewportState(fitToNodes(canvasRef.current.nodes, width, height, 80, CANVAS_READABLE_MIN_SCALE));
    },
    [pushHistory],
  );

  const centerOn = useCallback((world: CanvasPosition, viewportWidth: number, viewportHeight: number) => {
    setViewportState((prev) => ({
      ...prev,
      x: viewportWidth / 2 - world.x * prev.k,
      y: viewportHeight / 2 - world.y * prev.k,
    }));
  }, []);

  // ─────────────────────── 節點編輯

  const selectNode = useCallback((nodeId: string | null) => setSelectedNodeId(nodeId), []);

  /**
   * 拖動/縮放中的每一帧都不推快照 —— 一次拖動會產生上百帧，
   * 全推進去等於把撤銷棧當成錄影。互動結束時由 commitInteraction 推一格。
   */
  const moveNode = useCallback((nodeId: string, position: CanvasPosition) => {
    dispatchCanvas({
      type: "move",
      nodeId,
      position,
    });
  }, []);

  const resizeNode = useCallback((nodeId: string, width: number, height: number) => {
    dispatchCanvas({ type: "resize", nodeId, width, height });
  }, []);

  const removeNode = useCallback(
    (nodeId: string) => {
      pushHistory();
      dispatchCanvas({ type: "remove", nodeId });
      setSelectedNodeId((prev) => (prev === nodeId ? null : prev));
    },
    [pushHistory],
  );

  /** 互動（拖動/縮放）開始前呼叫：把互動前的狀態存成一格。 */
  const commitInteraction = useCallback(() => {
    pushHistory();
  }, [pushHistory]);

  // ─────────────────────── Phase 3 畫布交互

  /** 群組拖動：每幀一次 dispatch 移整組。不推 history（由 commitInteraction 收口）。 */
  const moveNodes = useCallback((moves: { nodeId: string; position: CanvasPosition }[]) => {
    if (moves.length === 0) return;
    dispatchCanvas({ type: "move_many", moves });
  }, []);

  const addNodes = useCallback(
    (nodes: CanvasNode[], connections?: CanvasConnection[]) => {
      if (nodes.length === 0 && !(connections?.length)) return;
      pushHistory();
      dispatchCanvas({ type: "add_nodes", nodes, ...(connections ? { connections } : {}) });
    },
    [pushHistory],
  );

  const deleteNodes = useCallback(
    (nodeIds: string[]) => {
      if (nodeIds.length === 0) return;
      pushHistory();
      dispatchCanvas({ type: "delete_many", nodeIds });
      setSelectedNodeId((prev) => (prev && nodeIds.includes(prev) ? null : prev));
    },
    [pushHistory],
  );

  const addConnection = useCallback(
    (fromNodeId: string, toNodeId: string) => {
      pushHistory();
      dispatchCanvas({ type: "connect", fromNodeId, toNodeId });
    },
    [pushHistory],
  );

  const removeConnection = useCallback(
    (connectionId: string) => {
      pushHistory();
      dispatchCanvas({ type: "disconnect", connectionId });
    },
    [pushHistory],
  );

  // ─────────────────────── Wave A：就地編輯

  const renameNode = useCallback(
    (nodeId: string, title: string) => {
      pushHistory();
      dispatchCanvas({ type: "rename", nodeId, title });
    },
    [pushHistory],
  );

  /** metadata 補丁（文本直編提交、原地生成回填、字號、重試狀態）。history 預設推一格。 */
  const patchNodeMetadata = useCallback(
    (nodeId: string, patch: Partial<CanvasNodeMetadata>, opts?: { history?: boolean }) => {
      if (opts?.history !== false) pushHistory();
      dispatchCanvas({ type: "patch_metadata", nodeId, patch });
    },
    [pushHistory],
  );

  // ─────────────────────── B2：飛行聚焦（450ms easeOutCubic）

  const flyTo = useCallback((world: CanvasPosition, viewportWidth: number, viewportHeight: number, targetK?: number) => {
    const start = viewportRef.current;
    const endK = clampScale(targetK ?? Math.max(start.k, 0.85));
    const endX = viewportWidth / 2 - world.x * endK;
    const endY = viewportHeight / 2 - world.y * endK;
    if (flyRafRef.current !== null) cancelAnimationFrame(flyRafRef.current);
    const t0 = performance.now();
    const DURATION = 450;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / DURATION);
      const e = 1 - Math.pow(1 - t, 3);
      setViewportState({
        x: start.x + (endX - start.x) * e,
        y: start.y + (endY - start.y) * e,
        k: start.k + (endK - start.k) * e,
      });
      flyRafRef.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    flyRafRef.current = requestAnimationFrame(step);
  }, []);

  // ─────────────────────── Wave C：agent 操作的確認/執行/拒絕

  /** 批准並執行 agent 待審操作。回傳 run_generation 清單交宿主觸發生成。 */
  const applyAgentOps = useCallback((): { runGeneration: { nodeId: string; prompt?: string; model?: string; size?: string; count?: number }[] } => {
    const pending = pendingAgentOpsRef.current;
    const result = { runGeneration: [] as { nodeId: string; prompt?: string; model?: string; size?: string; count?: number }[] };
    if (!pending) return result;
    pushHistory();
    dispatchCanvas({ type: "agent_ops", ops: pending.ops });
    for (const op of pending.ops) {
      if (op.type === "select_nodes") {
        setSelectedNodeId(op.ids[0] ?? null);
      } else if (op.type === "set_viewport") {
        setViewportState((prev) => ({ ...prev, ...op.viewport, k: clampScale(op.viewport.k ?? prev.k) }));
      } else if (op.type === "run_generation") {
        result.runGeneration.push({ nodeId: op.node_id, prompt: op.prompt, model: op.model, size: op.size, count: op.count });
      }
    }
    setPendingAgentOps(null);
    const sid = sessionIdRef.current;
    if (sid) {
      const createdIds = pending.ops.filter((o): o is Extract<CanvasAgentOp, { type: "add_node" }> => o.type === "add_node").map((o) => o.node.id);
      void postCanvasOpsResult(sid, pending.request_id, { ok: true, ...(createdIds.length ? { created_node_ids: createdIds } : {}) });
    }
    return result;
  }, [pushHistory]);

  /** 拒絕 agent 待審操作（結果回報 gateway，讓工具調用拿到明確拒絕而非超時）。 */
  const dismissAgentOps = useCallback((reason?: string) => {
    const pending = pendingAgentOpsRef.current;
    setPendingAgentOps(null);
    const sid = sessionIdRef.current;
    if (pending && sid) {
      void postCanvasOpsResult(sid, pending.request_id, { ok: false, error: reason ?? "用户拒绝了此次画布操作" });
    }
  }, []);

  // ─────────────────────── undo / redo

  const applySnapshot = useCallback((snapshot: CanvasSnapshot) => {
    restoringRef.current = true;
    dispatchCanvas({ type: "load", nodes: snapshot.nodes, connections: snapshot.connections });
    setViewportState(snapshot.viewport);
    // 還原是同步 dispatch，但 React 批次更新到下一帧才落地；
    // 用 microtask 解鎖，避免同一輪裡的 pushHistory 把還原也記成一步。
    void Promise.resolve().then(() => {
      restoringRef.current = false;
    });
  }, []);

  const undo = useCallback(() => {
    const result = undoSnapshot(history, snapshotNow());
    if (!result) return;
    setHistory(result.history);
    applySnapshot(result.snapshot);
  }, [history, snapshotNow, applySnapshot]);

  const redo = useCallback(() => {
    const result = redoSnapshot(history, snapshotNow());
    if (!result) return;
    setHistory(result.history);
    applySnapshot(result.snapshot);
  }, [history, snapshotNow, applySnapshot]);

  // ─────────────────────── 專案匯入/匯出/清空

  const loadProject = useCallback(
    (project: {
      nodes?: unknown;
      connections?: unknown;
      viewport?: CanvasViewport;
      backgroundMode?: CanvasBackgroundMode;
      title?: string;
    }) => {
      pushHistory();
      const restored = fromCanvasProject(project);
      dispatchCanvas({ type: "load", nodes: restored.nodes, connections: restored.connections });
      if (project.viewport) setViewportState(project.viewport);
      if (project.backgroundMode) setBackgroundMode(project.backgroundMode);
      if (project.title) setProjectTitle(project.title);
      setSelectedNodeId(null);
    },
    [pushHistory],
  );

  const exportProject = useCallback((): CanvasProject => buildProject(), [buildProject]);

  const clearCanvas = useCallback(() => {
    pushHistory();
    dispatchCanvas({ type: "clear" });
    setPlans([]);
    setDerives([]);
    setSelectedNodeId(null);
  }, [pushHistory]);

  // ─────────────────────── 幾何

  const nodeIndex = useMemo(() => {
    const map = new Map<string, CanvasNode>();
    for (const n of canvas.nodes) map.set(n.id, n);
    return map;
  }, [canvas.nodes]);

  const pathFor = useCallback(
    (connection: CanvasConnection): string | null => {
      const from = nodeIndex.get(connection.fromNodeId);
      const to = nodeIndex.get(connection.toNodeId);
      if (!from || !to) return null;
      return bezierPath(from, to);
    },
    [nodeIndex],
  );

  // ─────────────────────── 批次操作

  const addBatchChild = useCallback(
    (parentId: string, child: CanvasNode) => {
      pushHistory();
      dispatchCanvas({ type: "batch_add_child", parentId, child });
    },
    [pushHistory],
  );

  const setBatchPrimary = useCallback(
    (parentId: string, childId: string) => {
      pushHistory();
      dispatchCanvas({ type: "batch_set_primary", parentId, childId });
    },
    [pushHistory],
  );

  const deleteBatchChild = useCallback(
    (parentId: string, childId: string) => {
      pushHistory();
      dispatchCanvas({ type: "batch_delete_child", parentId, childId });
    },
    [pushHistory],
  );

  const toggleBatchExpanded = useCallback(
    (parentId: string) => {
      pushHistory();
      dispatchCanvas({ type: "batch_toggle_expanded", parentId });
    },
    [pushHistory],
  );

  // ─────────────────────── @引用操作

  const addReference = useCallback(
    (nodeId: string, referenceNodeId: string) => {
      pushHistory();
      dispatchCanvas({ type: "add_reference", nodeId, referenceNodeId });
    },
    [pushHistory],
  );

  const removeReference = useCallback(
    (nodeId: string, referenceNodeId: string) => {
      pushHistory();
      dispatchCanvas({ type: "remove_reference", nodeId, referenceNodeId });
    },
    [pushHistory],
  );

  return {
    feedCanvasEvent,
    summarize,
    nodes: canvas.nodes,
    connections: canvas.connections,
    units: canvas.units,
    plans,
    derives,
    budget,
    viewport,
    setViewport,
    backgroundMode,
    cycleBackground,
    fitView,
    centerOn,
    selectedNodeId,
    selectNode,
    moveNode,
    resizeNode,
    removeNode,
    commitInteraction,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    undo,
    redo,
    projectTitle,
    setProjectTitle,
    loading,
    saveState,
    loadProject,
    exportProject,
    clearCanvas,
    newCanvasSession,
    savedProjects,
    refreshSavedProjects,
    openSavedCanvas,
    pathFor,
    moveNodes,
    addNodes,
    deleteNodes,
    addConnection,
    removeConnection,
    addBatchChild,
    setBatchPrimary,
    deleteBatchChild,
    toggleBatchExpanded,
    addReference,
    removeReference,
    renameNode,
    patchNodeMetadata,
    flyTo,
    pendingAgentOps,
    applyAgentOps,
    dismissAgentOps,
    characterCards,
    activeCardIds,
    activeCharacterCards,
    upsertCharacterCard,
    removeCharacterCard,
    toggleCharacterCard,
  };
}
