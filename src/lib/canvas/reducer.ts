// 畫布 reducer：把 gateway 送出的 canvas.* 事件套用到畫布狀態。
//
// 純函式、無副作用，前端（畫布 store）直接呼叫。每個事件對應一個 reduce 步驟，
// 與 gateway 的 autoCreateCanvasUnit 產出契約一一對齊。node 位置由前端 reducer
// 自動排版（瀑布流/階梯），gateway 不給座標——它不懂版面，版權歸暴君前端。
import type {
  CanvasConnection,
  CanvasNode,
  CanvasNodeConnectedEvent,
  CanvasNodeCreatedEvent,
  CanvasNodeStatus,
  CanvasNodeUpdatedEvent,
  CanvasPlanEvent,
  CanvasPosition,
  CanvasSseEvent,
  CanvasUnit,
} from "./types";
import { CanvasNodeType } from "./types";

export interface CanvasReducerState {
  units: CanvasUnit[]; // 畫布單元（gateway 自動製畫布產出）
  nodes: CanvasNode[]; // 扁平節點清單
  connections: CanvasConnection[]; // 扁平連線清單
}

export const CANVAS_INITIAL_STATE: CanvasReducerState = {
  units: [],
  nodes: [],
  connections: [],
};

/** 節點加入時自動排版的間距與起點。 */
const LAYOUT_GAP_X = 60;
const LAYOUT_GAP_Y = 40;
const LAYOUT_START = { x: 40, y: 40 };

function nextPosition(existing: CanvasNode[]): CanvasPosition {
  const cols = 3;
  const row = Math.floor(existing.length / cols);
  const col = existing.length % cols;
  return {
    x: LAYOUT_START.x + col * (340 + LAYOUT_GAP_X),
    y: LAYOUT_START.y + row * (240 + LAYOUT_GAP_Y),
  };
}

function upsertNode(state: CanvasReducerState, node: CanvasNode): CanvasReducerState {
  const exists = state.nodes.some((n) => n.id === node.id);
  const nodes = exists
    ? state.nodes.map((n) => (n.id === node.id ? node : n))
    : [...state.nodes, { ...node, position: node.position.x || node.position.y ? node.position : nextPosition(state.nodes) }];
  return { ...state, nodes };
}

function upsertConnection(state: CanvasReducerState, connection: CanvasConnection): CanvasReducerState {
  const exists = state.connections.some((c) => c.id === connection.id);
  return {
    ...state,
    connections: exists ? state.connections : [...state.connections, connection],
  };
}

function findUnit(state: CanvasReducerState, unitId: string): CanvasUnit | undefined {
  return state.units.find((u) => u.unitId === unitId);
}

function upsertUnit(state: CanvasReducerState, unit: CanvasUnit): CanvasReducerState {
  const idx = state.units.findIndex((u) => u.unitId === unit.unitId);
  const units =
    idx >= 0 ? state.units.map((u, i) => (i === idx ? unit : u)) : [...state.units, unit];
  return { ...state, units };
}

/** canvas.plan — 記錄計畫（不建節點）。 */
export function reduceCanvasPlan(state: CanvasReducerState, data: CanvasPlanEvent): CanvasReducerState {
  const existing = findUnit(state, data.unit_id);
  if (existing) return state;
  const unit: CanvasUnit = {
    unitId: data.unit_id,
    tool: data.tool,
    nodes: [],
    connections: [],
  };
  return upsertUnit(state, unit);
}

/** canvas.node.created — 建節點（含 target_kind="result" 的結果預留節點）。 */
export function reduceCanvasNodeCreated(state: CanvasReducerState, data: CanvasNodeCreatedEvent): CanvasReducerState {
  const unit = findUnit(state, data.unit_id) ?? {
    unitId: data.unit_id,
    tool: "unknown",
    nodes: [],
    connections: [],
  };
  const existingInUnit = unit.nodes.some((n) => n.id === data.node.id);
  const nextUnit: CanvasUnit = {
    ...unit,
    nodes: existingInUnit ? unit.nodes.map((n) => (n.id === data.node.id ? data.node : n)) : [...unit.nodes, data.node],
  };
  return upsertNode(upsertUnit(state, nextUnit), data.node);
}

/** canvas.node.connected — 建連線（跨 unit 也可）。 */
export function reduceCanvasNodeConnected(state: CanvasReducerState, data: CanvasNodeConnectedEvent): CanvasReducerState {
  const unit = findUnit(state, data.unit_id);
  const nextState = upsertConnection(state, data.connection);
  if (!unit) return nextState;
  const nextUnit: CanvasUnit = {
    ...unit,
    connections: unit.connections.some((c) => c.id === data.connection.id)
      ? unit.connections
      : [...unit.connections, data.connection],
  };
  return upsertUnit(nextState, nextUnit);
}

/** canvas.node.updated — 更新節點（結果落地：status/content/url/cost）。 */
export function reduceCanvasNodeUpdated(state: CanvasReducerState, data: CanvasNodeUpdatedEvent): CanvasReducerState {
  const node = state.nodes.find((n) => n.id === data.node_id);
  if (!node) return state;
  const nextNode: CanvasNode = {
    ...node,
    metadata: {
      ...node.metadata,
      ...data.patch,
      ...(data.url ? { content: data.url } : {}),
      ...(typeof data.cost_coins === "number" ? { cost_coins: data.cost_coins } : {}),
    },
  };
  const nodes = state.nodes.map((n) => (n.id === data.node_id ? nextNode : n));
  const units = state.units.map((u) =>
    u.unitId === data.unit_id
      ? { ...u, nodes: u.nodes.map((n) => (n.id === data.node_id ? nextNode : n)) }
      : u,
  );
  return { ...state, nodes, units };
}

/** canvas.node.generating — 節點進生成態。 */
export function reduceCanvasNodeGenerating(
  state: CanvasReducerState,
  data: { unit_id: string; node_id: string; status: string; progress?: number },
): CanvasReducerState {
  return reduceCanvasNodeUpdated(state, {
    unit_id: data.unit_id,
    node_id: data.node_id,
    patch: { status: data.status as CanvasNodeStatus, progress: data.progress },
  });
}

/** canvas.node.deleted — 移除節點與其連線。 */
export function reduceCanvasNodeDeleted(
  state: CanvasReducerState,
  data: { unit_id: string; node_id?: string },
): CanvasReducerState {
  if (!data.node_id) return state;
  const nodes = state.nodes.filter((n) => n.id !== data.node_id);
  const connections = state.connections.filter((c) => c.fromNodeId !== data.node_id && c.toNodeId !== data.node_id);
  const units = state.units.map((u) =>
    u.unitId === data.unit_id
      ? {
          ...u,
          nodes: u.nodes.filter((n) => n.id !== data.node_id),
          connections: u.connections.filter((c) => c.fromNodeId !== data.node_id && c.toNodeId !== data.node_id),
        }
      : u,
  );
  return { nodes, connections, units };
}

/** 主入口：把一個 canvas.* 事件套用到畫布狀態。未知事件原樣返回。 */
export function reduceCanvasEvent(state: CanvasReducerState, event: CanvasSseEvent): CanvasReducerState {
  switch (event.name) {
    case "canvas.plan":
      return reduceCanvasPlan(state, event.data);
    case "canvas.node.created":
      return reduceCanvasNodeCreated(state, event.data);
    case "canvas.node.connected":
      return reduceCanvasNodeConnected(state, event.data);
    case "canvas.node.updated":
      return reduceCanvasNodeUpdated(state, event.data);
    case "canvas.node.generating":
      return reduceCanvasNodeGenerating(state, event.data);
    case "canvas.node.deleted":
      return reduceCanvasNodeDeleted(state, event.data);
    default:
      return state;
  }
}

/** 工具：取出單一 unit 的完整節點/連線（含跨 unit 的結果節點）。 */
export function getUnitGraph(state: CanvasReducerState, unitId: string): { nodes: CanvasNode[]; connections: CanvasConnection[] } {
  const unit = findUnit(state, unitId);
  if (!unit) return { nodes: [], connections: [] };
  return { nodes: unit.nodes, connections: unit.connections };
}
