// reduceCanvasEvent 的 adapter（自 use-canvas-chat.ts 外圍搬遷，符號名不變）。
//
// reduceCanvasEvent 的簽名是 (state, CanvasSseEvent)，不是標準 reducer。
// 這裡包一層 adapter，同時容納「本端動作」（載入專案、拖動節點、undo 還原）。
import type { AgentSseEvent } from "@/lib/agent-chat-types";
import { CANVAS_INITIAL_STATE, reduceCanvasEvent, type CanvasReducerState } from "@/lib/canvas/reducer";
import { normalizeCanvasEvent } from "@/lib/canvas/layout";
import { CANVAS_NODE_DEFAULT_SIZE, CanvasNodeType } from "@/lib/canvas/types";
import type {
  CanvasAgentOp,
  CanvasConnection,
  CanvasNode,
  CanvasNodeMetadata,
  CanvasPosition,
} from "@/lib/canvas/types";

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
