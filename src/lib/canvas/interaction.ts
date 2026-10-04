// 画布交互纯函式层：框选几何、复制贴上克隆、对齐 / 均分 / 网格整理。
//
// 为什么独立成层：InfiniteCanvas 只负责手势（DOM 事件流），CanvasEmbed 只负责
// 编排；「矩形扫到谁」「克隆出什么」「对齐后谁动到哪」是可以脱离 DOM 回答的
// 决策。测试 runner 是 node:test（无 jsdom），只有纯函式测得动 —— 这一层因此
// 禁止任何 DOM / React 依赖。
//
// 契约：所有函式不改动输入（含传入的 existingIds）；排列类函式只回传「位置
// 真的变了」的节点，呼叫端可直接喂给移动流程，不产生无意义的 no-op 更新。

import type { CanvasConnection, CanvasNode, CanvasPosition, CanvasViewport } from "./types";

/** 世界座标矩形（已归一化：width/height 恒非负）。 */
export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 排列类函式的输出单位：把 nodeId 移到 position。 */
export interface NodeMove {
  nodeId: string;
  position: CanvasPosition;
}

/**
 * 萤幕座标矩形（两个角点，顺序不拘）→ 世界座标矩形。
 * 与 layout.ts 的 zoomAtPoint 同一套换算：world = (screen - translate) / k。
 * 反向拖动（b 在 a 的左上方）也归一化成非负宽高。
 */
export function screenRectToWorld(
  a: { x: number; y: number },
  b: { x: number; y: number },
  viewport: CanvasViewport,
): WorldRect {
  const ax = (a.x - viewport.x) / viewport.k;
  const ay = (a.y - viewport.y) / viewport.k;
  const bx = (b.x - viewport.x) / viewport.k;
  const by = (b.y - viewport.y) / viewport.k;
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

/** 节点与世界矩形是否相交（含触边：框到边缘也算命中，宁可多选不漏选）。 */
export function nodeIntersectsRect(node: CanvasNode, rect: WorldRect): boolean {
  return (
    node.position.x <= rect.x + rect.width &&
    node.position.x + node.width >= rect.x &&
    node.position.y <= rect.y + rect.height &&
    node.position.y + node.height >= rect.y
  );
}

/** 框选命中：回传与矩形相交的节点 id（维持 nodes 原顺序，结果稳定可预期）。 */
export function nodesInRect(nodes: CanvasNode[], rect: WorldRect): string[] {
  const hit: string[] = [];
  for (const node of nodes) {
    if (nodeIntersectsRect(node, rect)) hit.push(node.id);
  }
  return hit;
}

// ─────────────────────────────────────────── 复制贴上

/** 预设贴上偏移：副本错开一步，不完全盖住原件。 */
const PASTE_OFFSET: { x: number; y: number } = { x: 32, y: 32 };

/**
 * 分配不撞号的克隆 id：`${base}-c${序号}`，序号从 1 递增直到避开 used。
 * used 同时涵盖画布既有 id 与本批已分配的 id（连贴多次自然得到 -c2、-c3…）。
 */
function allocCloneId(base: string, used: Set<string>): string {
  let seq = 1;
  let candidate = `${base}-c${seq}`;
  while (used.has(candidate)) {
    seq += 1;
    candidate = `${base}-c${seq}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * 复制贴上：把选中节点（含彼此之间的内部连线）克隆为新 id 的副本。
 *
 * - moved: true —— 副本是用户明确摆放的，不再参与 reducer 自动排版。
 * - 只克隆内部连线（from/to 都在选中集合内）：跨出选区的连线语义属于原件，
 *   复制它会让副本平白挂到不相干的节点上。连线 id 同样走防撞分配。
 * - 剥掉 batchChildren / batchExpanded / batchPrimaryImageId 与
 *   metadata.imageTaskId —— 副本不是批次父节点，也不继承生成任务的身份
 *   （否则任务回报会同时落到原件与副本上）。
 */
export function cloneForPaste(
  nodes: CanvasNode[],
  connections: CanvasConnection[],
  selectedIds: string[],
  existingIds: Set<string>,
  offset: { x: number; y: number } = PASTE_OFFSET,
): { nodes: CanvasNode[]; connections: CanvasConnection[] } {
  const selected = new Set(selectedIds);
  const used = new Set(existingIds); // 复本：不改动呼叫端的集合
  const idMap = new Map<string, string>(); // 原 id → 克隆 id
  const clonedNodes: CanvasNode[] = [];

  for (const node of nodes) {
    if (!selected.has(node.id)) continue;
    const cloneId = allocCloneId(node.id, used);
    idMap.set(node.id, cloneId);
    const { batchChildren: _bc, batchExpanded: _be, batchPrimaryImageId: _bp, metadata, ...rest } = node;
    let cloneMeta = metadata;
    if (metadata) {
      const { imageTaskId: _task, ...restMeta } = metadata;
      cloneMeta = restMeta;
    }
    clonedNodes.push({
      ...rest,
      id: cloneId,
      position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
      moved: true,
      ...(cloneMeta !== undefined ? { metadata: cloneMeta } : {}),
    });
  }

  const clonedConnections: CanvasConnection[] = [];
  for (const connection of connections) {
    const from = idMap.get(connection.fromNodeId);
    const to = idMap.get(connection.toNodeId);
    if (!from || !to) continue; // 外部连线：任一端不在选中集合 → 不克隆
    clonedConnections.push({ id: allocCloneId(connection.id, used), fromNodeId: from, toNodeId: to });
  }

  return { nodes: clonedNodes, connections: clonedConnections };
}

// ─────────────────────────────────────────── 对齐 / 均分 / 整理

export type AlignMode = "left" | "right" | "top" | "bottom" | "center-h" | "center-v";

function pickSelected(nodes: CanvasNode[], selectedIds: string[]): CanvasNode[] {
  const selected = new Set(selectedIds);
  return nodes.filter((n) => selected.has(n.id));
}

/** 选中节点的包围盒（呼叫端保证至少一个节点）。 */
function selectionBounds(selected: CanvasNode[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of selected) {
    if (n.position.x < minX) minX = n.position.x;
    if (n.position.y < minY) minY = n.position.y;
    if (n.position.x + n.width > maxX) maxX = n.position.x + n.width;
    if (n.position.y + n.height > maxY) maxY = n.position.y + n.height;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 对齐：以「选中节点的包围盒」为基准（不是画布原点、也不是某个主节点）。
 * center-h = 各节点中心对齐包围盒的垂直中线（动 x）；center-v 对齐水平中线（动 y）。
 * 少于 2 个节点没有对齐语义，回空；位置没变的节点不回传。
 */
export function alignNodes(nodes: CanvasNode[], selectedIds: string[], mode: AlignMode): NodeMove[] {
  const selected = pickSelected(nodes, selectedIds);
  if (selected.length < 2) return [];
  const { minX, minY, maxX, maxY } = selectionBounds(selected);
  const moves: NodeMove[] = [];
  for (const n of selected) {
    let x = n.position.x;
    let y = n.position.y;
    switch (mode) {
      case "left":
        x = minX;
        break;
      case "right":
        x = maxX - n.width;
        break;
      case "top":
        y = minY;
        break;
      case "bottom":
        y = maxY - n.height;
        break;
      case "center-h":
        x = (minX + maxX) / 2 - n.width / 2;
        break;
      case "center-v":
        y = (minY + maxY) / 2 - n.height / 2;
        break;
    }
    if (x !== n.position.x || y !== n.position.y) moves.push({ nodeId: n.id, position: { x, y } });
  }
  return moves;
}

/**
 * 均分：按轴向座标排序后首尾锚定，中间节点以相等的「盒与盒间距」重排。
 * 间距可为负（总尺寸超过首尾跨距时均匀重叠，与主流设计工具一致）。
 * 少于 3 个没有「中间」可分，回空；首尾锚定所以永远不出现在结果里。
 */
export function distributeNodes(nodes: CanvasNode[], selectedIds: string[], axis: "h" | "v"): NodeMove[] {
  const selected = pickSelected(nodes, selectedIds);
  if (selected.length < 3) return [];
  const pos = (n: CanvasNode) => (axis === "h" ? n.position.x : n.position.y);
  const size = (n: CanvasNode) => (axis === "h" ? n.width : n.height);
  const sorted = [...selected].sort((m, n) => pos(m) - pos(n));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const start = pos(first);
  const span = pos(last) + size(last) - start;
  const total = sorted.reduce((acc, n) => acc + size(n), 0);
  const gap = (span - total) / (sorted.length - 1);
  const moves: NodeMove[] = [];
  let cursor = start + size(first) + gap;
  for (let i = 1; i < sorted.length - 1; i += 1) {
    const n = sorted[i];
    const next = axis === "h" ? { x: cursor, y: n.position.y } : { x: n.position.x, y: cursor };
    if (next.x !== n.position.x || next.y !== n.position.y) moves.push({ nodeId: n.id, position: next });
    cursor += size(n) + gap;
  }
  return moves;
}

/** 整理排列的预设间距：与贴上偏移同一步幅，视觉上是同一套节奏。 */
const GRID_DEFAULT_GAP = 32;

/**
 * 整理排列：按目前视觉顺序（先上后下、再左后右）排成网格，锚定于选区包围盒
 * 左上（整理不把东西搬去远方，只在原地收拾）。栏宽取该栏最宽、行高取该行
 * 最高 —— 尺寸不一的节点也能对出整齐的格线。cols 预设 ≈ √n（接近方形）。
 */
export function arrangeGrid(
  nodes: CanvasNode[],
  selectedIds: string[],
  opts?: { cols?: number; gapX?: number; gapY?: number },
): NodeMove[] {
  const selected = pickSelected(nodes, selectedIds);
  if (selected.length === 0) return [];
  const cols = Math.max(1, Math.floor(opts?.cols ?? Math.ceil(Math.sqrt(selected.length))));
  const gapX = opts?.gapX ?? GRID_DEFAULT_GAP;
  const gapY = opts?.gapY ?? GRID_DEFAULT_GAP;
  const { minX, minY } = selectionBounds(selected);
  const sorted = [...selected].sort((m, n) => m.position.y - n.position.y || m.position.x - n.position.x);

  // 两趟：先量测每栏 / 每行的最大尺寸，再回填座标。
  const colWidths: number[] = [];
  const rowHeights: number[] = [];
  sorted.forEach((n, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    colWidths[c] = Math.max(colWidths[c] ?? 0, n.width);
    rowHeights[r] = Math.max(rowHeights[r] ?? 0, n.height);
  });
  const colX: number[] = [];
  let cx = minX;
  for (let c = 0; c < colWidths.length; c += 1) {
    colX[c] = cx;
    cx += colWidths[c] + gapX;
  }
  const rowY: number[] = [];
  let cy = minY;
  for (let r = 0; r < rowHeights.length; r += 1) {
    rowY[r] = cy;
    cy += rowHeights[r] + gapY;
  }

  const moves: NodeMove[] = [];
  sorted.forEach((n, i) => {
    const next = { x: colX[i % cols], y: rowY[Math.floor(i / cols)] };
    if (next.x !== n.position.x || next.y !== n.position.y) moves.push({ nodeId: n.id, position: next });
  });
  return moves;
}
