import type { CanvasNode, CanvasPosition, CanvasViewport } from "../types";

// ─────────────────────────────────────────── 视口几何

export const CANVAS_MIN_SCALE = 0.05;
export const CANVAS_MAX_SCALE = 5;
export const CANVAS_GRID_BASE = 48;

export function clampScale(k: number): number {
  if (!Number.isFinite(k)) return 1;
  return Math.min(CANVAS_MAX_SCALE, Math.max(CANVAS_MIN_SCALE, k));
}

/** 滚轮缩放：factor = 1.1^(-deltaY/100)，锚点固定在游标下的世界座标。 */
export function zoomAtPoint(vp: CanvasViewport, deltaY: number, px: number, py: number): CanvasViewport {
  const factor = Math.pow(1.1, -deltaY / 100);
  const k = clampScale(vp.k * factor);
  if (k === vp.k) return vp;
  // 游标下的世界点在缩放前后必须落在同一个萤幕位置：
  //   world = (screen - translate) / k  → translate' = screen - world * k'
  const worldX = (px - vp.x) / vp.k;
  const worldY = (py - vp.y) / vp.k;
  return { x: px - worldX * k, y: py - worldY * k, k };
}

export function screenToWorld(vp: CanvasViewport, px: number, py: number): CanvasPosition {
  return { x: (px - vp.x) / vp.k, y: (py - vp.y) / vp.k };
}

export function worldToScreen(vp: CanvasViewport, wx: number, wy: number): CanvasPosition {
  return { x: wx * vp.k + vp.x, y: wy * vp.k + vp.y };
}

export interface CanvasBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/** 小地图的世界范围：节点 min/max 各留 pad（PRD §7.4 预设 ±500）。 */
export function computeWorldBounds(nodes: CanvasNode[], pad = 500): CanvasBounds {
  if (nodes.length === 0) {
    return { minX: -pad, minY: -pad, maxX: pad, maxY: pad, width: pad * 2, height: pad * 2 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + n.width);
    maxY = Math.max(maxY, n.position.y + n.height);
  }
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * 「可读缩放」下限：全图 fit 低于它时宁可不显示全部，也要保证节点文字可读。
 * 暴君原则：一进来就要看到清楚的内容，而不是缩成一团的整张图。
 */
export const CANVAS_READABLE_MIN_SCALE = 0.85;

/** 把整张画布带进视口（含边距），回新的 viewport。
 *  minScale > 0 时是「可读优先」模式：全图 fit 的缩放低于 minScale，
 *  改用 minScale 并把视口对齐内容开头（第一个/上游节点清晰可见），
 *  其余节点平移查看——不会出现「小到看不清」的整图缩略。 */
export function fitToNodes(
  nodes: CanvasNode[],
  viewportWidth: number,
  viewportHeight: number,
  padding = 80,
  minScale = 0,
): CanvasViewport {
  if (nodes.length === 0 || viewportWidth <= 0 || viewportHeight <= 0) return { x: 0, y: 0, k: 1 };
  const b = computeWorldBounds(nodes, 0);
  const kFit = clampScale(
    Math.min((viewportWidth - padding * 2) / Math.max(b.width, 1), (viewportHeight - padding * 2) / Math.max(b.height, 1)),
  );
  const k = clampScale(Math.max(kFit, minScale));
  if (k === kFit) {
    return {
      x: viewportWidth / 2 - (b.minX + b.width / 2) * k,
      y: viewportHeight / 2 - (b.minY + b.height / 2) * k,
      k,
    };
  }
  // 全图 fit 太小：放大到可读缩放，视口对齐内容左上（padding 边距），
  // 让上游第一个节点（剧本/描述）清晰可见。
  return {
    x: padding - b.minX * k,
    y: padding - b.minY * k,
    k,
  };
}

/** 贝兹连线：方向自适应（水平邻居走侧出侧入、垂直重叠邻居走底出顶入、
    长距离前向跳线走顶部拱桥，消除垂直节点反折大耳朵与长线拦腰穿透中间卡片；
    反向连线不再绕一大圈回来）。 */
export function bezierPath(from: CanvasNode, to: CanvasNode): string {
  const fromRight = from.position.x + from.width;
  const toRight = to.position.x + to.width;
  const fromBottom = from.position.y + from.height;
  const toBottom = to.position.y + to.height;

  // 垂直相邻/重叠判断：两节点水平范围有交集（例如同列堆叠），且垂直有间隔
  const horizontalOverlap = !(fromRight <= to.position.x || toRight <= from.position.x);
  if (horizontalOverlap && (fromBottom <= to.position.y || toBottom <= from.position.y)) {
    const downward = fromBottom <= to.position.y;
    const x1 = from.position.x + from.width / 2;
    const y1 = downward ? fromBottom : from.position.y;
    const x2 = to.position.x + to.width / 2;
    const y2 = downward ? to.position.y : toBottom;
    const c = Math.min(Math.max(Math.abs(y2 - y1) * 0.5, 30), 120);
    const dir = downward ? 1 : -1;
    return `M ${x1} ${y1} C ${x1} ${y1 + dir * c}, ${x2} ${y2 - dir * c}, ${x2} ${y2}`;
  }

  // 长距离前向跳线（边缘净距塞得下一整张卡）：水平中线直连会拦腰穿透中间
  // 栏位的卡片——改走顶部拱桥（顶心出、拱顶跨越、顶心入），上方净空零穿透。
  const forward = from.position.x + from.width / 2 <= to.position.x + to.width / 2;
  const xExit = forward ? fromRight : from.position.x;
  const xEnter = forward ? to.position.x : toRight;
  if (forward && xEnter - xExit > 340) {
    const x1 = from.position.x + from.width / 2;
    const y1 = from.position.y;
    const x2 = to.position.x + to.width / 2;
    const y2 = to.position.y;
    const peak = Math.min(y1, y2) - Math.min(200, 80 + Math.abs(x2 - x1) * 0.08);
    return `M ${x1} ${y1} C ${x1} ${peak}, ${x2} ${peak}, ${x2} ${y2}`;
  }

  const y1 = from.position.y + from.height / 2;
  const y2 = to.position.y + to.height / 2;
  const x1 = forward ? fromRight : from.position.x;
  const x2 = forward ? to.position.x : toRight;
  const c = Math.min(Math.max(Math.abs(x2 - x1) * 0.5, 50), 200);
  const dir = forward ? 1 : -1;
  return `M ${x1} ${y1} C ${x1 + dir * c} ${y1}, ${x2 - dir * c} ${y2}, ${x2} ${y2}`;
}

/** 网格背景：gridSize 跟著缩放走，backgroundPosition 取视口的模，格线才不会漂。 */
export function gridBackground(vp: CanvasViewport, mode: "dots" | "lines" | "blank"): {
  backgroundImage?: string;
  backgroundSize?: string;
  backgroundPosition?: string;
} {
  if (mode === "blank") return {};
  const size = CANVAS_GRID_BASE * vp.k;
  if (size < 6) return {}; // 缩太小时格线变噪点，直接不画
  const offsetX = ((vp.x % size) + size) % size;
  const offsetY = ((vp.y % size) + size) % size;
  if (mode === "lines") {
    return {
      backgroundImage:
        "linear-gradient(to right, rgba(0,0,0,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,0,0,0.06) 1px, transparent 1px)",
      backgroundSize: `${size}px ${size}px`,
      backgroundPosition: `${offsetX}px ${offsetY}px`,
    };
  }
  return {
    backgroundImage: "radial-gradient(circle, rgba(0,0,0,0.13) 1px, transparent 1px)",
    backgroundSize: `${size}px ${size}px`,
    backgroundPosition: `${offsetX}px ${offsetY}px`,
  };
}
