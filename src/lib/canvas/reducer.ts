// 画布 reducer：把 gateway 送出的 canvas.* 事件套用到画布状态。
//
// 纯函式、无副作用，前端（画布 store）直接呼叫。每个事件对应一个 reduce 步骤，
// 与 gateway 的 autoCreateCanvasUnit 产出契约一一对齐。node 位置由前端 reducer
// 自动排版（瀑布流/阶梯），gateway 不给座标——它不懂版面，版权归项目负责人前端。
import type {
  CanvasConnection,
  CanvasNode,
  CanvasNodeConnectedEvent,
  CanvasNodeCreatedEvent,
  CanvasNodeStatus,
  CanvasNodeUpdatedEvent,
  CanvasNodeVersion,
  CanvasNodeVersionReason,
  CanvasPlanEvent,
  CanvasPosition,
  CanvasSseEvent,
  CanvasUnit,
} from "./types";
import { CanvasNodeType } from "./types";
import {
  appendNodeVersion,
  applyNodeVersion,
  createNodeVersion,
  isNodeContentChange,
  latestNodeVersion,
  previousNodeVersion,
  selectNodeVersion,
} from "./node-versions";

export interface CanvasReducerState {
  units: CanvasUnit[]; // 画布单元（gateway 自动制画布产出）
  nodes: CanvasNode[]; // 扁平节点清单（**不含**已软删节点）
  connections: CanvasConnection[]; // 扁平连线清单
  /**
   * 软删节点（2026-09-27）：不进 `nodes`，因此既有呼叫端（渲染/连线/批次）
   * 看到的行为与旧硬删一致；资料仍在，可经 `restoreCanvasNodes` 还原。
   * optional＝向后相容（旧 state 没有此栏视为空）。
   */
  deletedNodes?: CanvasNode[];
  /** 节点版本历史（快照清单）；optional＝向后相容。 */
  nodeVersions?: CanvasNodeVersion[];
}

export const CANVAS_INITIAL_STATE: CanvasReducerState = {
  units: [],
  nodes: [],
  connections: [],
};

/** 节点加入时自动排版的间距与起点。 */
const LAYOUT_GAP_X = 60;
const LAYOUT_GAP_Y = 40;
const LAYOUT_START = { x: 40, y: 40 };

/**
 * DAG 分层自动排版（2026-08-15 重写）：左 → 右流水线。
 *
 * 旧版把「层」直着往下叠、层内横排三栏，结果连线斜穿整张画布、乱入别的卡片
 * （截图证据：一团乱麻）。新版做正经的分层布局：
 *   1. 分层：最长上游路径深度（DAG；有环在有限次内停）。
 *   2. 交叉最小化：barycenter 两趟扫描（下行看上游均位、上行看下游均位），
 *      同层顺序按邻层连线的平均索引排序 —— 边尽量平行，不打叉。
 *   3. 座标：x 按层累加（层宽 = 该层最宽节点），y 层内纵向堆叠并对整图
 *      垂直置中 —— 边永远短距离左进右出，bezierPath 的水平切线刚好贴合。
 *
 * 手动拖动过的节点（moved）不重排，但仍占用层内排序位（邻居的边不乱）。
 *
 * 汇出给旧会话回放（use-canvas-chat restoreAgentSnapshot）：gateway 上行的
 * canvas_state 摘要刻意不带座标，回填时必须跑同一套排版，否则全部叠在原点。
 */
export function layoutGraph(state: CanvasReducerState): CanvasReducerState {
  const { nodes, connections } = state;
  if (nodes.length === 0) return state;
  if (connections.length === 0) {
    const placed = nodes.filter((node) => node.moved);
    return {
      ...state,
      nodes: nodes.map((node) => {
        if (node.moved) return node;
        const positioned = { ...node, position: nextPosition(placed, node.width, node.height) };
        placed.push(positioned);
        return positioned;
      }),
    };
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  for (const n of nodes) depth.set(n.id, 0);
  // 迭代求最长上游路径深度（DAG；有环则停在有限次内，结果仍可用）
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

  // 分层（保持加入序作初始层内顺序）
  const maxDepth = Math.max(...[...depth.values()], 0);
  const layers: CanvasNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const n of nodes) layers[depth.get(n.id) ?? 0].push(n);

  // 邻接表（仅存在的端点）
  const upstream = new Map<string, string[]>();
  const downstream = new Map<string, string[]>();
  for (const c of connections) {
    if (!byId.has(c.fromNodeId) || !byId.has(c.toNodeId)) continue;
    upstream.set(c.toNodeId, [...(upstream.get(c.toNodeId) ?? []), c.fromNodeId]);
    downstream.set(c.fromNodeId, [...(downstream.get(c.fromNodeId) ?? []), c.toNodeId]);
  }

  // barycenter 扫描：邻层索引均值排序（无邻居者保持原相对顺序 = 稳定排序）
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
  sweep(upstream, -1); // 下行：向上游看齐
  sweep(downstream, +1); // 上行：向下游看齐
  sweep(upstream, -1); // 再一趟下行收敛

  // 座标：x 按层累加、y 层内堆叠 + 对整图垂直置中
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

  const placed = nodes.filter((n) => n.moved);
  const nextNodes = nodes.map((n) => {
    if (n.moved) return n;
    const pos = nextPos.get(n.id);
    const positioned = pos ? { ...n, position: nextPosition(placed, n.width, n.height, pos) } : n;
    placed.push(positioned);
    return positioned;
  });
  return { ...state, nodes: nextNodes };
}

export function nextPosition(
  existing: CanvasNode[],
  width = 340,
  height = 240,
  preferred?: CanvasPosition,
): CanvasPosition {
  const cols = 3;
  const row = Math.floor(existing.length / cols);
  const col = existing.length % cols;
  const position = preferred ? { ...preferred } : {
    x: LAYOUT_START.x + col * (340 + LAYOUT_GAP_X),
    y: LAYOUT_START.y + row * (240 + LAYOUT_GAP_Y),
  };
  // 以真实卡片尺寸与占位排版；既有节点（尤其人工移动的）只作障碍，不挪动。
  // 每轮只向下跨过一个或多个障碍，最多 existing.length 轮即找到空位。
  for (let pass = 0; pass <= existing.length; pass++) {
    let nextY = position.y;
    for (const node of existing) {
      if (
        position.x < node.position.x + node.width + LAYOUT_GAP_X &&
        position.x + width + LAYOUT_GAP_X > node.position.x &&
        position.y < node.position.y + node.height + LAYOUT_GAP_Y &&
        position.y + height + LAYOUT_GAP_Y > node.position.y
      ) nextY = Math.max(nextY, node.position.y + node.height + LAYOUT_GAP_Y);
    }
    if (nextY === position.y) break;
    position.y = nextY;
  }
  return position;
}

function upsertNode(state: CanvasReducerState, node: CanvasNode): CanvasReducerState {
  const exists = state.nodes.some((n) => n.id === node.id);
  const nodes = exists
    ? state.nodes.map((n) => (n.id === node.id ? { ...node, position: n.position, moved: n.moved } : n))
    : [...state.nodes, {
        ...node,
        position: nextPosition(state.nodes, node.width, node.height, node.position.x || node.position.y ? node.position : undefined),
      }];
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

/** canvas.plan — 记录计画（不建节点）；cost_hint 为数字时挂到 unit（C-FE）。 */
export function reduceCanvasPlan(state: CanvasReducerState, data: CanvasPlanEvent): CanvasReducerState {
  const existing = findUnit(state, data.unit_id);
  if (existing) return state;
  const unit: CanvasUnit = {
    unitId: data.unit_id,
    tool: data.tool,
    nodes: [],
    connections: [],
    ...(typeof data.cost_hint === "number" ? { costHint: data.cost_hint } : {}),
  };
  return upsertUnit(state, unit);
}

/** canvas.node.created — 建节点（含 target_kind="result" 的结果预留节点）。 */
export function reduceCanvasNodeCreated(state: CanvasReducerState, data: CanvasNodeCreatedEvent): CanvasReducerState {
  const unit = findUnit(state, data.unit_id) ?? {
    unitId: data.unit_id,
    tool: "unknown",
    nodes: [],
    connections: [],
  };
  // C-FE：plan 的 cost_hint 盖章到本单元的生成卡（image/video）——
  // 节点卡以它显示「预估 N 币」角标，实际 cost_coins 落地后由实际角标接班。
  // workflow 计画例外（tool 以 "workflow:" 开头）：它的 cost_hint 是整张工作流
  // 的总估价（estimateGraphCoins），逐卡盖章会把全图总额贴到每张卡上
  //（2026-08-29 事故：5 张 pixai 图 + 1 段 5 秒影片 → 全场卡片显示 25.005 币）。
  // 总额只在侧栏「预计 N 币」展示。
  const stamped: CanvasNode =
    unit.costHint !== undefined &&
    !unit.tool.startsWith("workflow:") &&
    (data.node.type === CanvasNodeType.Image || data.node.type === CanvasNodeType.Video)
      ? { ...data.node, metadata: { ...data.node.metadata, cost_hint: unit.costHint } }
      : data.node;
  const existingInUnit = unit.nodes.some((n) => n.id === stamped.id);
  const nextUnit: CanvasUnit = {
    ...unit,
    nodes: existingInUnit ? unit.nodes.map((n) => (n.id === stamped.id ? stamped : n)) : [...unit.nodes, stamped],
  };
  const nextState = upsertNode(upsertUnit(state, nextUnit), stamped);
  // 新节点落一版 created 快照；已存在的节点被重送 create 时不重复落版。
  return state.nodes.some((n) => n.id === stamped.id)
    ? nextState
    : recordCanvasNodeVersion(nextState, stamped.id, "created");
}

/** canvas.node.connected — 建连线（跨 unit 也可）。 */
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

/** canvas.node.updated — 更新节点（结果落地：status/content/url/cost）。 */
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
  const nextState: CanvasReducerState = { ...state, nodes, units };
  // 内容变更即落一版快照；进度/花费等瞬态抖动由 isNodeContentChange 过滤为 null。
  const reason = isNodeContentChange(node, nextNode);
  return reason ? recordCanvasNodeVersion(nextState, data.node_id, reason) : nextState;
}

/** canvas.node.generating — 节点进生成态。 */
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

/**
 * canvas.node.deleted — **软删**节点（2026-09-27 版本历史＋回退）。
 *
 * 语义与旧硬删对呼叫端一致：节点离开 `nodes`（列表不含）、连线断开；差别是节点被
 * 收进 `deletedNodes` 并盖 `deletedAt`，可经 `restoreCanvasNodes` / restore API 还原。
 */
export function reduceCanvasNodeDeleted(
  state: CanvasReducerState,
  data: { unit_id: string; node_id?: string },
): CanvasReducerState {
  if (!data.node_id) return state;
  return softDeleteCanvasNodes(state, [data.node_id]);
}

/**
 * 批量软删（`delete_nodes` op 与 UI 删除的单一执行体）。
 *
 * 逐条保留旧硬删的可观察行为：节点离开 `nodes`/`units`、连线全断、批次父节点的
 * `batchChildren` 清掉死子并把主图 fallback 到剩余第一个（全删光则清空）。
 */
export function softDeleteCanvasNodes(
  state: CanvasReducerState,
  ids: readonly string[],
  deletedAt: string = new Date().toISOString(),
): CanvasReducerState {
  const dead = new Set(ids.filter(Boolean));
  if (dead.size === 0) return state;
  const removed = state.nodes.filter((n) => dead.has(n.id)).map((n) => ({ ...n, deletedAt }));
  const existing = state.deletedNodes ?? [];
  const existingIds = new Set(existing.map((n) => n.id));
  const deletedNodes = [...existing, ...removed.filter((n) => !existingIds.has(n.id))];
  return {
    ...state,
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
          // 主图被删 → fallback 剩余第一个；全删光 → 清空。
          batchPrimaryImageId:
            n.batchPrimaryImageId && dead.has(n.batchPrimaryImageId) ? kept[0] : n.batchPrimaryImageId,
          metadata: { ...n.metadata, batchTotal: kept.length },
        };
      }),
    connections: state.connections.filter((c) => !dead.has(c.fromNodeId) && !dead.has(c.toNodeId)),
    deletedNodes,
  };
}

/**
 * 批量还原软删节点：把 `deletedNodes` 里的目标搬回 `nodes` 并清掉 `deletedAt`。
 * `ids` 为空＝不回任何节点（不制造「静默全还原」）。找不到的 id 略过，不捏造节点。
 * 还原后跑一次 `layoutGraph`：回来的节点与既有版面一起重排（与事件路径一致）。
 */
export function restoreCanvasNodes(state: CanvasReducerState, ids: readonly string[]): CanvasReducerState {
  const wanted = new Set(ids.filter(Boolean));
  if (wanted.size === 0) return state;
  const deleted = state.deletedNodes ?? [];
  const restored: CanvasNode[] = [];
  for (const n of deleted) {
    if (!wanted.has(n.id)) continue;
    const { deletedAt: _dropped, ...rest } = n;
    restored.push(rest);
  }
  if (restored.length === 0) return state;
  const alive = new Set(state.nodes.map((n) => n.id));
  const nodes = [...state.nodes, ...restored.filter((n) => !alive.has(n.id))];
  const deletedNodes = deleted.filter((n) => !restored.some((r) => r.id === n.id));
  return layoutGraph({ ...state, nodes, deletedNodes });
}

/**
 * 对当前节点落一版快照。
 *
 * 去重：若与该节点最新一版的内容无差（`isNodeContentChange` 回 null），不重复落版
 * （呼叫端可能对同一 patch 重送；版本历史不该被同内容灌满）。
 */
export function recordCanvasNodeVersion(
  state: CanvasReducerState,
  nodeId: string,
  reason: CanvasNodeVersionReason = "edited",
  createdAt?: string,
): CanvasReducerState {
  const node = state.nodes.find((n) => n.id === nodeId);
  if (!node) return state;
  const versions = state.nodeVersions ?? [];
  const latest = latestNodeVersion(versions, nodeId);
  if (latest) {
    const pseudoPrev: CanvasNode = { ...node, title: latest.title, metadata: latest.metadata };
    if (isNodeContentChange(pseudoPrev, node) === null) return state;
  }
  const entry = createNodeVersion(node, reason, versions, createdAt);
  return { ...state, nodeVersions: appendNodeVersion(versions, entry) };
}

/**
 * 回退节点到某一版：`version` 有值＝指定版；省略＝上一版（`previousNodeVersion`）。
 *
 * 回退本身也落一版（reason `revert`）——版本历史 append-only，回退可再被回退。
 * 只还原 title＋metadata（`applyNodeVersion`），座标/尺寸不动。
 * 没有可回的版本、或该版与当前内容无差 → 原样返回（不制造空版本）。
 */
export function revertCanvasNodeToVersion(
  state: CanvasReducerState,
  nodeId: string,
  version?: number,
  createdAt?: string,
): CanvasReducerState {
  const node = state.nodes.find((n) => n.id === nodeId);
  if (!node) return state;
  const versions = state.nodeVersions ?? [];
  const entry = version === undefined ? previousNodeVersion(versions, nodeId) : selectNodeVersion(versions, nodeId, version);
  if (!entry) return state;
  const reverted = applyNodeVersion(node, entry);
  if (isNodeContentChange(node, reverted) === null) return state;
  const nodes = state.nodes.map((n) => (n.id === nodeId ? reverted : n));
  const units = state.units.map((u) => ({
    ...u,
    nodes: u.nodes.map((n) => (n.id === nodeId ? reverted : n)),
  }));
  const recorded = createNodeVersion(reverted, "revert", versions, createdAt);
  return { ...state, nodes, units, nodeVersions: appendNodeVersion(versions, recorded) };
}

/** canvas.node.disconnected — 移除 from->to 连线（不断节点）。 */
export function reduceCanvasNodeDisconnected(
  state: CanvasReducerState,
  data: { unit_id: string; from: string; to: string },
): CanvasReducerState {
  const connections = state.connections.filter((c) => !(c.fromNodeId === data.from && c.toNodeId === data.to));
  const units = state.units.map((u) =>
    u.unitId === data.unit_id
      ? { ...u, connections: u.connections.filter((c) => !(c.fromNodeId === data.from && c.toNodeId === data.to)) }
      : u,
  );
  return { ...state, connections, units };
}

/** 主入口：把一个 canvas.* 事件套用到画布状态。未知事件原样返回。 */
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
    case "canvas.node.disconnected":
      next = reduceCanvasNodeDisconnected(state, event.data);
      break;
    default:
      return state;
  }
  // 结构性事件后自动排版：DAG 分层、整齐流水线（手动拖过的节点不重排）。
  return layoutGraph(next);
}

/** 工具：取出单一 unit 的完整节点/连线（含跨 unit 的结果节点）。 */
export function getUnitGraph(state: CanvasReducerState, unitId: string): { nodes: CanvasNode[]; connections: CanvasConnection[] } {
  const unit = findUnit(state, unitId);
  if (!unit) return { nodes: [], connections: [] };
  return { nodes: unit.nodes, connections: unit.connections };
}
