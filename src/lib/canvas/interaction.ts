// 畫布交互純函式層：框選幾何、複製貼上克隆、對齊 / 均分 / 網格整理。
//
// 為什麼獨立成層：InfiniteCanvas 只負責手勢（DOM 事件流），CanvasEmbed 只負責
// 編排；「矩形掃到誰」「克隆出什麼」「對齊後誰動到哪」是可以脫離 DOM 回答的
// 決策。測試 runner 是 node:test（無 jsdom），只有純函式測得動 —— 這一層因此
// 禁止任何 DOM / React 依賴。
//
// 契約：所有函式不改動輸入（含傳入的 existingIds）；排列類函式只回傳「位置
// 真的變了」的節點，呼叫端可直接餵給移動流程，不產生無意義的 no-op 更新。

import type { CanvasConnection, CanvasNode, CanvasPosition, CanvasViewport } from "./types";

/** 世界座標矩形（已歸一化：width/height 恆非負）。 */
export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 排列類函式的輸出單位：把 nodeId 移到 position。 */
export interface NodeMove {
  nodeId: string;
  position: CanvasPosition;
}

/**
 * 螢幕座標矩形（兩個角點，順序不拘）→ 世界座標矩形。
 * 與 layout.ts 的 zoomAtPoint 同一套換算：world = (screen - translate) / k。
 * 反向拖動（b 在 a 的左上方）也歸一化成非負寬高。
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

/** 節點與世界矩形是否相交（含觸邊：框到邊緣也算命中，寧可多選不漏選）。 */
export function nodeIntersectsRect(node: CanvasNode, rect: WorldRect): boolean {
  return (
    node.position.x <= rect.x + rect.width &&
    node.position.x + node.width >= rect.x &&
    node.position.y <= rect.y + rect.height &&
    node.position.y + node.height >= rect.y
  );
}

/** 框選命中：回傳與矩形相交的節點 id（維持 nodes 原順序，結果穩定可預期）。 */
export function nodesInRect(nodes: CanvasNode[], rect: WorldRect): string[] {
  const hit: string[] = [];
  for (const node of nodes) {
    if (nodeIntersectsRect(node, rect)) hit.push(node.id);
  }
  return hit;
}

// ─────────────────────────────────────────── 複製貼上

/** 預設貼上偏移：副本錯開一步，不完全蓋住原件。 */
const PASTE_OFFSET: { x: number; y: number } = { x: 32, y: 32 };

/**
 * 分配不撞號的克隆 id：`${base}-c${序號}`，序號從 1 遞增直到避開 used。
 * used 同時涵蓋畫布既有 id 與本批已分配的 id（連貼多次自然得到 -c2、-c3…）。
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
 * 複製貼上：把選中節點（含彼此之間的內部連線）克隆為新 id 的副本。
 *
 * - moved: true —— 副本是用戶明確擺放的，不再參與 reducer 自動排版。
 * - 只克隆內部連線（from/to 都在選中集合內）：跨出選區的連線語義屬於原件，
 *   複製它會讓副本平白掛到不相干的節點上。連線 id 同樣走防撞分配。
 * - 剝掉 batchChildren / batchExpanded / batchPrimaryImageId 與
 *   metadata.imageTaskId —— 副本不是批次父節點，也不繼承生成任務的身份
 *   （否則任務回報會同時落到原件與副本上）。
 */
export function cloneForPaste(
  nodes: CanvasNode[],
  connections: CanvasConnection[],
  selectedIds: string[],
  existingIds: Set<string>,
  offset: { x: number; y: number } = PASTE_OFFSET,
): { nodes: CanvasNode[]; connections: CanvasConnection[] } {
  const selected = new Set(selectedIds);
  const used = new Set(existingIds); // 複本：不改動呼叫端的集合
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
    if (!from || !to) continue; // 外部連線：任一端不在選中集合 → 不克隆
    clonedConnections.push({ id: allocCloneId(connection.id, used), fromNodeId: from, toNodeId: to });
  }

  return { nodes: clonedNodes, connections: clonedConnections };
}

// ─────────────────────────────────────────── 對齊 / 均分 / 整理

export type AlignMode = "left" | "right" | "top" | "bottom" | "center-h" | "center-v";

function pickSelected(nodes: CanvasNode[], selectedIds: string[]): CanvasNode[] {
  const selected = new Set(selectedIds);
  return nodes.filter((n) => selected.has(n.id));
}

/** 選中節點的包圍盒（呼叫端保證至少一個節點）。 */
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
 * 對齊：以「選中節點的包圍盒」為基準（不是畫布原點、也不是某個主節點）。
 * center-h = 各節點中心對齊包圍盒的垂直中線（動 x）；center-v 對齊水平中線（動 y）。
 * 少於 2 個節點沒有對齊語義，回空；位置沒變的節點不回傳。
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
 * 均分：按軸向座標排序後首尾錨定，中間節點以相等的「盒與盒間距」重排。
 * 間距可為負（總尺寸超過首尾跨距時均勻重疊，與主流設計工具一致）。
 * 少於 3 個沒有「中間」可分，回空；首尾錨定所以永遠不出現在結果裡。
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

/** 整理排列的預設間距：與貼上偏移同一步幅，視覺上是同一套節奏。 */
const GRID_DEFAULT_GAP = 32;

/**
 * 整理排列：按目前視覺順序（先上後下、再左後右）排成網格，錨定於選區包圍盒
 * 左上（整理不把東西搬去遠方，只在原地收拾）。欄寬取該欄最寬、行高取該行
 * 最高 —— 尺寸不一的節點也能對出整齊的格線。cols 預設 ≈ √n（接近方形）。
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

  // 兩趟：先量測每欄 / 每行的最大尺寸，再回填座標。
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
