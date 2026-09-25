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
      // 契約（metadata 直通）：此處 patch 原樣併入節點 metadata，不過白名單。
      // **本 op 沒有 agent 入口**：`CanvasAgentOp`（types.ts:427 起的九個 op）裡沒有
      // patch_metadata——agent 只能經 agent_ops 的 add_node/update_node 寫畫布；
      // 本 action 的呼叫端全是前端/工具層（use-canvas-chat 的 patchNodeMetadata、
      // revokeDownstream 下游作廢、CanvasEmbed 的批准/prompt/字號回填）。
      // 為什麼要有白名單（理由不變）：session 內任意鍵可見、重載後只剩白名單鍵活著
      //（唯一還原路徑 fromCanvasProject → normalizeCanvasNode → toNodeMetadata）。
      //
      // 2026-09-25 實測裁定：**不能收緊成「過一次 toNodeMetadata」**——本 action 的
      // payload 裡有白名單外但**被讀**的鍵，收緊＝當場弄壞功能（非重載才壞）：
      //   · `fontSize`：context-menu-items.ts:155/156 寫（放大/縮小字號）→ NodeBody.tsx:431 讀
      //   · `approval`：CanvasEmbed.tsx:683 寫（分鏡批准閘）→ assets/ShotReviewPanel.tsx:144 讀
      //   · `bytes`/`mimeType`：use-canvas-interaction.ts:443 寫（上傳回填；目前查無讀者）
      // 要收緊的前提＝先把這些鍵加進 `layout.ts` 的 `toNodeMetadata`（白名單真源不在本檔）。
      return {
        ...state,
        nodes: state.nodes.map((n) =>
          n.id === action.nodeId ? { ...n, metadata: { ...n.metadata, ...action.patch } } : n,
        ),
      };
    }
    case "agent_ops": {
      // Agent 批量操作原子套用：一次 dispatch = 撤銷棧一格，中途壞 op 跳過不炸整批。
      // 契約（metadata 直通，2026-09-24 WS11）：本分派的 add_node（normalizeAgentNode 的
      // raw.metadata）與 update_node（op.patch.metadata）都是**原始 metadata 直通，刻意不過
      // 白名單**——agent 在同一 session 內可寫任意鍵；重載後只有存在於兩處白名單
      //（layout.ts toNodeMetadata ＋ canvas-chat-types.ts compactMetadataForAgent）的鍵會活
      // 下來，因為 fromCanvasProject → normalizeCanvasNode → toNodeMetadata 是唯一還原路徑。
      // 消費端自行清洗（例：agent-output-cards.emittedEntityOf 對非法 kind 回 null）。
      //
      // 2026-09-25 實測裁定（逐鍵清點後）：**不能照「過一次 toNodeMetadata」收緊**——差集裡
      // 有被讀的鍵，且不只 LLM 亂塞的鍵，還有**設計上必須透傳**的 DSL 通道：
      //   · workflow-dsl/compile.ts:328-343 經本分派發 add_node/update_node，metadata 由
      //     buildStepMetadata 組裝（compile.ts:129-131 寫 `workflow_ns` / `stepId` /
      //     `stepIndex`）＋ `step.meta` 任意鍵透傳（compile.ts:139-141）；反推端
      //     decompile.ts:87/102 讀回 `workflow_ns`/`stepId`/`stepIndex`/meta 做畫布→DSL
      //     還原（workflow-dsl.test.ts:266 釘死「meta 透傳＝白名單外剩餘」）。
      //     白名單外鍵一剝＝這條雙向契約單邊斷（AI 筆 workflow_write 通道為活路：
      //     /api/v1/workflow/compile → canvas_apply_ops）。
      //   · 其餘白名單外**被讀**的鍵（NodeBody.tsx:396/397/406/621 讀 description/
      //     key_features/locked/inputFrom；CanvasNodeView.tsx:335/390/391 讀 role/
      //     shot_size/camera_move；CanvasEmbed.tsx:395/412 與 use-canvas-chat.ts:333 讀
      //     session_id；use-canvas-generation.ts:304 讀 referenceNodeIds）。
      // 收緊的唯一正解＝先把要放行的鍵加進 `layout.ts` 的 `toNodeMetadata`（白名單真源不在
      // 本檔），再回來把這裡改成過白名單。在那之前維持直通，消費端自行清洗。
      // 未列舉白名單外且無讀者的死資料：batchIndex / batchTotal / storageKey / stepName / toolIds。
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
                      // 契約：op.patch.metadata 原樣併入（不過白名單）——2026-09-25 逐鍵清點後
                      // 確認收緊會剝掉被讀鍵，維持直通，理由見 agent_ops 開頭註釋。
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
          case "set_project_meta":
            // 專案級欄位（projectType/currentStep/episodes）在 CanvasProject 頂層，
            // 不在 reducer state 裡，且不進撤銷棧（CanvasSnapshot 只有 nodes/connections/
            // viewport）——由 hook 層 applyAgentOps 呼叫 setProjectMeta 執行。
            // 這裡顯式列出而非落 default：新增 op 時若誤以為 reducer 會處理，行為會靜默消失。
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
    // 契約：raw metadata 原始直通（不過白名單）——2026-09-25 逐鍵清點後確認
    // 收緊會剝掉被讀鍵（含 DSL 通道的 step.meta 透傳），維持直通，見 agent_ops 開頭註釋。
    ...(raw.metadata ? { metadata: raw.metadata } : {}),
    moved: true,
  };
}
