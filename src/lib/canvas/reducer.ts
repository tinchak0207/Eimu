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
const LAYOUT_GAP_X = 96;
const LAYOUT_GAP_Y = 40;
const LAYOUT_START = { x: 40, y: 40 };

/**
 * DAG 分層自動排版（2026-08-15 重寫）：左 → 右流水線。
 *
 * 舊版把「層」直着往下疊、層內橫排三欄，結果連線斜穿整張畫布、亂入別的卡片
 * （截圖證據：一團亂麻）。新版做正經的分層佈局：
 *   1. 分層：最長上游路徑深度（DAG；有環在有限次內停）。
 *   2. 交叉最小化：barycenter 兩趟掃描（下行看上游均位、上行看下游均位），
 *      同層順序按鄰層連線的平均索引排序 —— 邊盡量平行，不打叉。
 *   3. 座標：x 按層累加（層寬 = 該層最寬節點），y 層內縱向堆疊並對整圖
 *      垂直置中 —— 邊永遠短距離左進右出，bezierPath 的水平切線剛好貼合。
 *
 * 手動拖動過的節點（moved）不重排，但仍佔用層內排序位（鄰居的邊不亂）。
 */
function layoutGraph(state: CanvasReducerState): CanvasReducerState {
  const { nodes, connections } = state;
  if (nodes.length === 0) return state;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  for (const n of nodes) depth.set(n.id, 0);
  // 迭代求最長上游路徑深度（DAG；有環則停在有限次內，結果仍可用）
  for (let iter = 0; iter < nodes.length; iter++) {
    let changed = false;
    for (const c of connections) {
      if (!byId.has(c.fromNodeId) || !byId.has(c.toNodeId)) continue;
      const nd = (depth.get(c.fromNodeId) ?? 0) + 1;
      if (nd > (depth.get(c.toNodeId) ?? 0)) {
        depth.set(c.toNodeId, nd);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 分層（保持加入序作初始層內順序）
  const maxDepth = Math.max(...[...depth.values()], 0);
  const layers: CanvasNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const n of nodes) layers[depth.get(n.id) ?? 0].push(n);

  // 鄰接表（僅存在的端點）
  const upstream = new Map<string, string[]>();
  const downstream = new Map<string, string[]>();
  for (const c of connections) {
    if (!byId.has(c.fromNodeId) || !byId.has(c.toNodeId)) continue;
    upstream.set(c.toNodeId, [...(upstream.get(c.toNodeId) ?? []), c.fromNodeId]);
    downstream.set(c.fromNodeId, [...(downstream.get(c.fromNodeId) ?? []), c.toNodeId]);
  }

  // barycenter 掃描：鄰層索引均值排序（無鄰居者保持原相對順序 = 穩定排序）
  const sweep = (neighborOf: Map<string, string[]>, neighborLayerOffset: number) => {
    for (let d = 0; d < layers.length; d++) {
      const refLayer = layers[d + neighborLayerOffset];
      if (!refLayer || refLayer.length === 0) continue;
      const refIndex = new Map(refLayer.map((n, i) => [n.id, i]));
      const scored = layers[d].map((n, i) => {
        const neighbors = (neighborOf.get(n.id) ?? []).map((id) => refIndex.get(id)).filter((v): v is number => v !== undefined);
        const bary = neighbors.length > 0 ? neighbors.reduce((a, b) => a + b, 0) / neighbors.length : null;
        return { n, i, bary };
      });
      scored.sort((a, b) => {
        const ka = a.bary ?? a.i;
        const kb = b.bary ?? b.i;
        return ka === kb ? a.i - b.i : ka - kb;
      });
      layers[d] = scored.map((s) => s.n);
    }
  };
  sweep(upstream, -1); // 下行：向上游看齊
  sweep(downstream, +1); // 上行：向下游看齊
  sweep(upstream, -1); // 再一趟下行收斂

  // 座標：x 按層累加、y 層內堆疊 + 對整圖垂直置中
  const layerWidth = layers.map((arr) => Math.max(...arr.map((n) => n.width || 340), 0));
  const layerX: number[] = [];
  let cursorX = LAYOUT_START.x;
  for (let d = 0; d < layers.length; d++) {
    layerX[d] = cursorX;
    cursorX += layerWidth[d] + LAYOUT_GAP_X;
  }
  const layerTotalH = layers.map(
    (arr) => arr.reduce((sum, n) => sum + (n.height || 240), 0) + Math.max(0, arr.length - 1) * LAYOUT_GAP_Y,
  );
  const graphH = Math.max(...layerTotalH, 0);

  const nextPos = new Map<string, CanvasPosition>();
  for (let d = 0; d < layers.length; d++) {
    let y = LAYOUT_START.y + (graphH - layerTotalH[d]) / 2;
    for (const n of layers[d]) {
      nextPos.set(n.id, { x: layerX[d], y });
      y += (n.height || 240) + LAYOUT_GAP_Y;
    }
  }

  const nextNodes = nodes.map((n) => {
    if (n.moved) return n;
    const pos = nextPos.get(n.id);
    return pos ? { ...n, position: pos } : n;
  });
  return { ...state, nodes: nextNodes };
}

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
  let next = state;
  switch (event.name) {
    case "canvas.plan":
      next = reduceCanvasPlan(state, event.data);
      break;
    case "canvas.node.created":
      next = reduceCanvasNodeCreated(state, event.data);
      break;
    case "canvas.node.connected":
      next = reduceCanvasNodeConnected(state, event.data);
      break;
    case "canvas.node.updated":
      next = reduceCanvasNodeUpdated(state, event.data);
      break;
    case "canvas.node.generating":
      next = reduceCanvasNodeGenerating(state, event.data);
      break;
    case "canvas.node.deleted":
      next = reduceCanvasNodeDeleted(state, event.data);
      break;
    default:
      return state;
  }
  // 結構性事件後自動排版：DAG 分層、整齊流水線（手動拖過的節點不重排）。
  return layoutGraph(next);
}

/** 工具：取出單一 unit 的完整節點/連線（含跨 unit 的結果節點）。 */
export function getUnitGraph(state: CanvasReducerState, unitId: string): { nodes: CanvasNode[]; connections: CanvasConnection[] } {
  const unit = findUnit(state, unitId);
  if (!unit) return { nodes: [], connections: [] };
  return { nodes: unit.nodes, connections: unit.connections };
}
