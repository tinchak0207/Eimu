// reduceCanvasEvent 的 adapter（自 use-canvas-chat.ts 外围搬迁，符号名不变）。
//
// reduceCanvasEvent 的签名是 (state, CanvasSseEvent)，不是标准 reducer。
// 这里包一层 adapter，同时容纳「本端动作」（载入专案、拖动节点、undo 还原）。
import type { AgentSseEvent } from "@/lib/agent-chat-types";
import {
  CANVAS_INITIAL_STATE,
  recordCanvasNodeVersion,
  reduceCanvasEvent,
  restoreCanvasNodes,
  revertCanvasNodeToVersion,
  softDeleteCanvasNodes,
  type CanvasReducerState,
} from "@/lib/canvas/reducer";
import { normalizeCanvasEvent } from "@/lib/canvas/layout";
import { isNodeContentChange } from "@/lib/canvas/node-versions";
import { clearShotMediaLinks, invalidatedShotMediaLinks } from "@/lib/canvas/storyboard-invalidation";
import { CANVAS_NODE_DEFAULT_SIZE, CanvasNodeType } from "@/lib/canvas/types";
import type {
  CanvasAgentOp,
  CanvasConnection,
  CanvasNode,
  CanvasNodeMetadata,
  CanvasNodeVersion,
  CanvasPosition,
} from "@/lib/canvas/types";

export type CanvasAction =
  | { type: "event"; event: AgentSseEvent }
  | {
      type: "load";
      nodes: CanvasNode[];
      connections: CanvasConnection[];
      deletedNodes?: CanvasNode[];
      nodeVersions?: CanvasNodeVersion[];
    }
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
  // Phase 3 画布交互：群组拖动 / 贴上插入 / 多删 / 手动连线
  | { type: "move_many"; moves: { nodeId: string; position: CanvasPosition }[] }
  | { type: "add_nodes"; nodes: CanvasNode[]; connections?: CanvasConnection[] }
  | { type: "delete_many"; nodeIds: string[] }
  | { type: "connect"; fromNodeId: string; toNodeId: string }
  | { type: "disconnect"; connectionId: string }
  // Wave A：就地编辑（改名 / metadata 补丁——文本直编、原地生成回填、字号）
  | { type: "rename"; nodeId: string; title: string }
  | { type: "patch_metadata"; nodeId: string; patch: Partial<CanvasNodeMetadata> }
  // 版本历史＋回退（2026-09-27）：软删还原 / 回退到指定版或上一版
  | { type: "restore_nodes"; nodeIds: string[] }
  | { type: "revert_node"; nodeId: string; version?: number }
  // Wave C：agent 批量操作（一次 dispatch = 一格历史）
  | { type: "agent_ops"; ops: CanvasAgentOp[] };

/** reducer 纯函式另行汇出：测试直接驱动 action，不用架 React。 */
export function canvasReducer(state: CanvasReducerState, action: CanvasAction): CanvasReducerState {
  switch (action.type) {
    case "event": {
      const normalized = normalizeCanvasEvent(action.event);
      // derive.started / budget.updated 不改画布结构，由 hook 另存展示状态。
      if (!normalized) return state;
      return reduceCanvasEvent(state, normalized);
    }
    case "load":
      return {
        units: [],
        nodes: action.nodes,
        connections: action.connections,
        ...(action.deletedNodes && action.deletedNodes.length > 0 ? { deletedNodes: action.deletedNodes } : {}),
        ...(action.nodeVersions && action.nodeVersions.length > 0 ? { nodeVersions: action.nodeVersions } : {}),
      };
    case "move":
      return {
        ...state,
        // 手动拖过＝用户接管这颗节点的位置，自动排版不再动它。
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
      // 软删（2026-09-27）：节点离开 nodes（呼叫端语义不变），但可经 restore_nodes 还原。
      return softDeleteCanvasNodes(state, [action.nodeId]);
    case "clear":
      return CANVAS_INITIAL_STATE;
    case "batch_add_child": {
      const { parentId, child } = action;
      const parent = state.nodes.find((n) => n.id === parentId);
      if (!parent) return state;
      const nextChildren = [...(parent.batchChildren ?? []), child.id];
      return {
        ...state,
        // 原位更新父节点（filter+append 会改变节点顺序，连带打乱进场动画与 z 序）。
        nodes: [
          ...state.nodes.map((n) =>
            n.id === parentId
              ? {
                  ...n,
                  batchChildren: nextChildren,
                  batchExpanded: true,
                  // 首个子节点自动成为主图：收起时封面才有东西可显示。
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
                  // 删掉的是主图 → fallback 到剩余第一个子节点（没有就清空）。
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
      // 群组拖动：一帧一个 dispatch 移动整组（逐颗 dispatch 会让 React 重渲染 N 次）。
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
      // 贴上/切图插入：id 由呼叫端保证不撞（cloneForPaste 已防撞）。撞了就以新值覆盖，不重复。
      if (action.nodes.length === 0 && !(action.connections?.length)) return state;
      const incomingIds = new Set(action.nodes.map((n) => n.id));
      const keptNodes = state.nodes.filter((n) => !incomingIds.has(n.id));
      const existingConn = new Set(state.connections.map((c) => c.id));
      const newConns = (action.connections ?? []).filter((c) => !existingConn.has(c.id));
      let next: CanvasReducerState = {
        ...state,
        nodes: [...keptNodes, ...action.nodes],
        connections: [...state.connections, ...newConns],
      };
      // 新节点逐颗落一版 created 快照（贴上是内容事件的起点）。
      for (const node of action.nodes) next = recordCanvasNodeVersion(next, node.id, "created");
      return next;
    }
    case "delete_many": {
      // 软删（2026-09-27）：与旧硬删对呼叫端同语义（nodes 不含、连线断、批次清理），
      // 差别是收进 deletedNodes 可还原。
      return softDeleteCanvasNodes(state, action.nodeIds);
    }
    case "connect": {
      const { fromNodeId, toNodeId } = action;
      // 自环与空端点拒绝；同向重复连线去重。
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
      const prev = state.nodes.find((n) => n.id === action.nodeId);
      if (!prev) return state;
      const renamed: CanvasNode = { ...prev, title };
      const next: CanvasReducerState = {
        ...state,
        nodes: state.nodes.map((n) => (n.id === action.nodeId ? renamed : n)),
      };
      // 改名是内容变更 → 落一版（版本历史看得到改名轨迹）。
      return isNodeContentChange(prev, renamed)
        ? recordCanvasNodeVersion(next, action.nodeId, "edited")
        : next;
    }
    case "patch_metadata": {
      // 契约（metadata 直通）：此处 patch 原样并入节点 metadata，不过白名单。
      // **本 op 没有 agent 入口**：`CanvasAgentOp`（types.ts:427 起的九个 op）里没有
      // patch_metadata——agent 只能经 agent_ops 的 add_node/update_node 写画布；
      // 本 action 的呼叫端全是前端/工具层（use-canvas-chat 的 patchNodeMetadata、
      // revokeDownstream 下游作废、CanvasEmbed 的批准/prompt/字号回填）。
      // 为什么要有白名单（理由不变）：session 内任意键可见、重载后只剩白名单键活著
      //（唯一还原路径 fromCanvasProject → normalizeCanvasNode → toNodeMetadata）。
      //
      // 2026-09-25 实测裁定：**不能收紧成「过一次 toNodeMetadata」**——本 action 的
      // payload 里有白名单外但**被读**的键，收紧＝当场弄坏功能（非重载才坏）：
      //   · `fontSize`：context-menu-items.ts:155/156 写（放大/缩小字号）→ NodeBody.tsx:431 读
      //   · `approval`：CanvasEmbed.tsx:683 写（分镜批准闸）→ assets/ShotReviewPanel.tsx:144 读
      //   · `bytes`/`mimeType`：use-canvas-interaction.ts:443 写（上传回填；目前查无读者）
      // 要收紧的前提＝先把这些键加进 `layout.ts` 的 `toNodeMetadata`（白名单真源不在本档）。
      const prev = state.nodes.find((n) => n.id === action.nodeId);
      if (!prev) return state;
      // W2（2026-09-30）：分镜内容变更 → 该镜旧关联媒体失效。本 op 是分镜内容 patch 的
      // **唯一写入漏斗**（agent 走 agent_ops，进不到这里）。before 取**合并前**现值；
      // 要清哪些键的唯一依据＝`storyboard-invalidation` 的纯函式输出（不在此扩张范围）。
      // patch 显式带了新关联 id 的栏位由该纯函式让路（规则⑤），先清后并不会清掉新值。
      // 版本帐仍由既有节点版本机制承载（`recordCanvasNodeVersion`），此处只补关联失效。
      // 两次宽化是形状事实：`CanvasNodeMetadata` 是 interface，无 index signature，
      // 音轨关联键（dialogueAudioId/…）刻意不在其内（同 WS-审查 approval 的写法）。
      const mediaBefore = (prev.metadata ?? {}) as Record<string, unknown>;
      const invalidated = invalidatedShotMediaLinks(mediaBefore, action.patch as Record<string, unknown>);
      const patched: CanvasNode = {
        ...prev,
        metadata: { ...clearShotMediaLinks(mediaBefore, invalidated), ...action.patch } as CanvasNodeMetadata,
      };
      const next: CanvasReducerState = {
        ...state,
        nodes: state.nodes.map((n) => (n.id === action.nodeId ? patched : n)),
      };
      // 内容/metadata 真的变了才落版（纯 status 抖动等瞬态由 isNodeContentChange 过滤）。
      const reason = isNodeContentChange(prev, patched);
      return reason ? recordCanvasNodeVersion(next, action.nodeId, reason) : next;
    }
    // ── 版本历史＋回退（2026-09-27）
    case "restore_nodes":
      return restoreCanvasNodes(state, action.nodeIds);
    case "revert_node":
      return revertCanvasNodeToVersion(state, action.nodeId, action.version);
    case "agent_ops": {
      // Agent 批量操作原子套用：一次 dispatch = 撤销栈一格，中途坏 op 跳过不炸整批。
      // 契约（metadata 直通，2026-09-24 WS11）：本分派的 add_node（normalizeAgentNode 的
      // raw.metadata）与 update_node（op.patch.metadata）都是**原始 metadata 直通，刻意不过
      // 白名单**——agent 在同一 session 内可写任意键；重载后只有存在于两处白名单
      //（layout.ts toNodeMetadata ＋ canvas-chat-types.ts compactMetadataForAgent）的键会活
      // 下来，因为 fromCanvasProject → normalizeCanvasNode → toNodeMetadata 是唯一还原路径。
      // 消费端自行清洗（例：agent-output-cards.emittedEntityOf 对非法 kind 回 null）。
      //
      // 2026-09-25 实测裁定（逐键清点后）：**不能照「过一次 toNodeMetadata」收紧**——差集里
      // 有被读的键，且不只 LLM 乱塞的键，还有**设计上必须透传**的 DSL 通道：
      //   · workflow-dsl/compile.ts:328-343 经本分派发 add_node/update_node，metadata 由
      //     buildStepMetadata 组装（compile.ts:129-131 写 `workflow_ns` / `stepId` /
      //     `stepIndex`）＋ `step.meta` 任意键透传（compile.ts:139-141）；反推端
      //     decompile.ts:87/102 读回 `workflow_ns`/`stepId`/`stepIndex`/meta 做画布→DSL
      //     还原（workflow-dsl.test.ts:266 钉死「meta 透传＝白名单外剩余」）。
      //     白名单外键一剥＝这条双向契约单边断（AI 笔 workflow_write 通道为活路：
      //     /api/v1/workflow/compile → canvas_apply_ops）。
      //   · 其余白名单外**被读**的键（NodeBody.tsx:396/397/406/621 读 description/
      //     key_features/locked/inputFrom；CanvasNodeView.tsx:335/390/391 读 role/
      //     shot_size/camera_move；CanvasEmbed.tsx:395/412 与 use-canvas-chat.ts:333 读
      //     session_id；use-canvas-generation.ts:304 读 referenceNodeIds）。
      // 收紧的唯一正解＝先把要放行的键加进 `layout.ts` 的 `toNodeMetadata`（白名单真源不在
      // 本档），再回来把这里改成过白名单。在那之前维持直通，消费端自行清洗。
      // 未列举白名单外且无读者的死资料：batchIndex / batchTotal / storageKey / stepName / toolIds。
      let next = state;
      for (const op of action.ops) {
        switch (op.type) {
          case "add_node": {
            const node = normalizeAgentNode(op.node, next.nodes);
            if (node) {
              next = { ...next, nodes: [...next.nodes, node] };
              // agent 落节点也是内容事件的起点 → 落 created 版。
              next = recordCanvasNodeVersion(next, node.id, "created");
            }
            break;
          }
          case "update_node": {
            const prevNode = next.nodes.find((n) => n.id === op.id);
            if (!prevNode) break;
            const updated: CanvasNode = {
              ...prevNode,
              ...(op.patch.title ? { title: op.patch.title.slice(0, 120) } : {}),
              ...(op.patch.position ? { position: op.patch.position, moved: true } : {}),
              ...(typeof op.patch.width === "number" ? { width: Math.max(120, op.patch.width) } : {}),
              ...(typeof op.patch.height === "number" ? { height: Math.max(90, op.patch.height) } : {}),
              // 契约：op.patch.metadata 原样并入（不过白名单）——2026-09-25 逐键清点后
              // 确认收紧会剥掉被读键，维持直通，理由见 agent_ops 开头注释。
              ...(op.patch.metadata ? { metadata: { ...prevNode.metadata, ...op.patch.metadata } } : {}),
            };
            next = {
              ...next,
              nodes: next.nodes.map((n) => (n.id === op.id ? updated : n)),
            };
            // agent 的内容/meta 变更 → 落一版（位置/尺寸改动不算内容，由分类器过滤）。
            const reason = isNodeContentChange(prevNode, updated);
            if (reason) next = recordCanvasNodeVersion(next, op.id, reason);
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
            // 专案级栏位（projectType/currentStep/episodes）在 CanvasProject 顶层，
            // 不在 reducer state 里，且不进撤销栈（CanvasSnapshot 只有 nodes/connections/
            // viewport）——由 hook 层 applyAgentOps 呼叫 setProjectMeta 执行。
            // 这里显式列出而非落 default：新增 op 时若误以为 reducer 会处理，行为会静默消失。
            break;
          case "revert_node":
            // 版本回退（2026-10-03）：直接复用 reducer 既有回退语义（只还原 title+metadata，
            // 座标/尺寸不动；回退本身 append 一版 reason="revert"）。agent 读 node_versions
            // 索引后指名版本即可，不必把旧 metadata 抄进上下文。
            next = revertCanvasNodeToVersion(next, op.nodeId, op.version);
            break;
          default:
            // select_nodes / set_viewport / run_generation 不是画布结构，hook 层处理。
            break;
        }
      }
      return next;
    }
  }
}

/** agent add_node → 完整 CanvasNode：缺尺寸取型别预设、id 撞号丢弃、type 不认识降级文本。 */
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
    // 契约：raw metadata 原始直通（不过白名单）——2026-09-25 逐键清点后确认
    // 收紧会剥掉被读键（含 DSL 通道的 step.meta 透传），维持直通，见 agent_ops 开头注释。
    ...(raw.metadata ? { metadata: raw.metadata } : {}),
    moved: true,
  };
}
