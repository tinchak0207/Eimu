// DAG 结构渲染器（纯函式，零 Next.js 依赖）。
//
// 用途：把工作流节点／连线（gateway 的 WorkflowNodeSpec 形状，节点本身无座标）
// 用 dagre 算出分层布局，再输出成完整 <svg> 字串。
//   renderDagSvg(nodes, connections, options) → "<svg …>…</svg>"
//
// 设计理由：
// - 节点没有座标（`deploy-staging/gateway/workflow-templates.ts` 只给 role/kind/title），
//   所以布局必须由 dagre 现算，不能靠呼叫方提供 x/y。
// - 只输出 SVG 字串、不碰 DOM：同一份逻辑要能在 node --test 直接 import，
//   也要能被 server route / 前端透过 svgToDataUrl（src/lib/svg-data-url.ts）喂给 <img>。
// - 因此本档「不」import 任何 `@/` alias 或 app 层模组，只用相对路径＋纯 npm 依赖（dagre）。
//
// ─────────────────────── 视觉规格（对齐站内画布，2026-09-20 重写）───────────────────────
// 前一版是「三个光秃小方块」——150×58、13px 标题、无标签无 I/O 描述，缩图后不可读。
// 本版改成与用户在画布上实际看到的节点卡同构（暴君实证：「渲染出来几乎不可用」）：
//   - 卡片 220px 宽、内容自适应高（顶部色条 3px + 标题列 + 标签列 + I/O 内文）
//   - 顶部 3px 色条＝kind 色相（一眼认出图/影片/文字/配置）
//   - 标签徽章：工具 / 产出 / 文本 / 配置（底色+文字色成对，同站内 badge 规范）
//   - 节点内文：role 与连线关系（↳ 输入来源 / → 产出目标），让缩图能看出这步在做什么
//   - 背景网格点阵（#D0D5DD），与画布同视觉语言
import dagre from "dagre";

export interface DagNodeInput {
  id: string;
  role: string;
  kind: string;
  title: string;
  status?: string;
  costCoins?: number;
  error?: string;
}

export interface DagConnectionInput {
  /** 起点节点 id（不是 role）。 */
  from: string;
  /** 终点节点 id（不是 role）。 */
  to: string;
}

export interface DagRenderOptions {
  /** 外框宽度（像素）；布局比这小则留白置中，比这大则以实际范围为准。 */
  width?: number;
  /** 外框高度（像素）；同上。 */
  height?: number;
  theme?: "light" | "dark";
}

// ───────────────────────── 样式常数 ─────────────────────────

interface Palette {
  bg: string;
  /** 背景网格点（画布视觉语言）。 */
  gridDot: string;
  cardBg: string;
  cardStroke: string;
  title: string;
  subtitle: string;
  edge: string;
  edgeArrow: string;
  muted: string;
  costBg: string;
  costText: string;
  failedStroke: string;
}

const LIGHT: Palette = {
  bg: "#f4f5f7",
  gridDot: "#d0d5dd",
  cardBg: "#ffffff",
  cardStroke: "#eaecf0",
  title: "#1d2129",
  subtitle: "#4e5969",
  edge: "#c9cdd4",
  edgeArrow: "#86909c",
  muted: "#86909c",
  costBg: "#f2f3f5",
  costText: "#4e5969",
  failedStroke: "#f53f3f",
};

const DARK: Palette = {
  bg: "#0f172a",
  gridDot: "#1e293b",
  cardBg: "#1e293b",
  cardStroke: "#334155",
  title: "#e2e8f0",
  subtitle: "#94a3b8",
  edge: "#475569",
  edgeArrow: "#64748b",
  muted: "#64748b",
  costBg: "#334155",
  costText: "#cbd5e1",
  failedStroke: "#ef4444",
};

/**
 * kind → 卡片视觉：顶部色条 + 标签（文字色／底色成对）。
 * 色相与站内画布一致：工具蓝、产出紫/绿/橙、文本灰。
 */
interface KindStyle {
  /** 顶部 3px 色条（焦点色）。 */
  accent: string;
  /** 标签文字色。 */
  tagText: string;
  /** 标签底色。 */
  tagBg: string;
  /** 标签文字（中文，让缩图看得懂这是什么）。 */
  tagLabel: string;
}

const KIND_STYLE: Record<string, KindStyle> = {
  text: { accent: "#86909c", tagText: "#4e5969", tagBg: "#f2f3f5", tagLabel: "文本" },
  config: { accent: "#1677ff", tagText: "#1677ff", tagBg: "#e6f4ff", tagLabel: "配置" },
  image: { accent: "#00b578", tagText: "#00b578", tagBg: "#e6fffb", tagLabel: "产出" },
  video: { accent: "#722ed1", tagText: "#722ed1", tagBg: "#f9f0ff", tagLabel: "产出" },
  audio: { accent: "#fa8c16", tagText: "#fa8c16", tagBg: "#fff7e6", tagLabel: "产出" },
  film: { accent: "#f53f3f", tagText: "#f53f3f", tagBg: "#ffece8", tagLabel: "成片" },
};
const KIND_STYLE_FALLBACK: KindStyle = {
  accent: "#86909c",
  tagText: "#4e5969",
  tagBg: "#f2f3f5",
  tagLabel: "节点",
};

// 卡片尺寸对齐站内画布节点卡（220px 宽 / 内容自适应高）。
const CARD_W = 220;
const CARD_MIN_H = 78;
const ACCENT_H = 3;
const PAD_X = 10;
const TITLE_SIZE = 12.5;
const SUB_SIZE = 10.5;
const IO_SIZE = 10.5;
const TAG_SIZE = 10;

const NODE_RADIUS = 8;

// 系统 sans-serif 堆叠。内层字型名一律用单引号：这个字串会被整段塞进
// SVG 的 font-family="…" 双引号属性，若用 \" 转义会让 libvips/浏览器的
// XML 解析器在属性中途断开（sharp 实测 "Couldn't find end of Start Tag svg"）。
const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Noto Sans CJK SC', 'PingFang SC', 'Microsoft YaHei', sans-serif";

/** 边界留白（像素）：箭头／cost 徽章不贴边。 */
const MARGIN = 24;
/** 网格点间距。 */
const GRID = 20;

// ───────────────────────── 工具函式 ─────────────────────────

/** XML 文字转义：标题与错误讯息是外部资料，必须逐字元转义再进 SVG。 */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function fmt(n: number): string {
  return Number(n.toFixed(2)).toString();
}

/** 文字宽度粗估（CJK 全形算 1em、其余算 0.55em），用来截断过长标题。 */
function textWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) units += ch.charCodeAt(0) > 0x2e7f ? 1 : 0.55;
  return units * fontSize;
}

/** 依可用宽度截断，超出时尾端加省略号（卡片宽度固定，过长标题会溢出）。 */
function truncate(text: string, fontSize: number, maxWidth: number): string {
  if (textWidth(text, fontSize) <= maxWidth) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = ch.charCodeAt(0) > 0x2e7f ? 1 : 0.55;
    if ((used + w) * fontSize > maxWidth - fontSize * 0.8) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

/** 币数显示：整数不带小数，有零头才留一位，避免「3.00 币」这种噪音。 */
function fmtCoins(coins: number): string {
  return Number.isInteger(coins) ? String(coins) : coins.toFixed(1);
}

/** role 可读化：把 snake_case 转成空格分隔，让缩图不必逐字读底线。 */
function humanizeRole(role: string): string {
  return role.replace(/[_-]+/g, " ").trim() || role;
}

/** 节点卡片的高度：标题 + 标签 +（有 I/O 时）内文行。 */
function cardHeight(ioLines: number): number {
  const base = ACCENT_H + 8 + 15 + 16 + 10; // 色条 + 上距 + 标题行 + 标签行 + 下距
  return Math.max(CARD_MIN_H, base + ioLines * 13);
}

// ───────────────────────── 主函式 ─────────────────────────

/**
 * dagre 分层布局 + SVG 字串输出。回传完整 `<svg>` 字串（开头必须是 `<svg`）。
 *
 * 空节点阵列 → 回传一个最小合法 SVG（底 + 一句提示），不抛错。
 * 连线指向不存在的节点 id → 该条连线略过（gateway 资料可能有孤儿边）。
 */
export function renderDagSvg(
  nodes: DagNodeInput[],
  connections: DagConnectionInput[],
  options?: DagRenderOptions,
): string {
  const theme = options?.theme === "dark" ? "dark" : "light";
  const palette = theme === "dark" ? DARK : LIGHT;
  const requestedW = options?.width ?? 960;
  const requestedH = options?.height ?? 540;

  // 空图：dagre 对无节点图回 width/height = null，不能进布局流程，直接短路。
  if (!nodes || nodes.length === 0) {
    return wrapSvg(
      requestedW,
      requestedH,
      requestedW,
      requestedH,
      palette,
      `<rect width="${requestedW}" height="${requestedH}" fill="${palette.bg}"/>` +
        `<text x="${fmt(requestedW / 2)}" y="${fmt(requestedH / 2)}" font-size="13" fill="${palette.subtitle}" text-anchor="middle">暂无节点</text>`,
    );
  }

  const byId = new Map<string, DagNodeInput>();
  for (const node of nodes) {
    if (byId.has(node.id)) continue; // 重复 id 只认首见：dagre 同 id 重设会覆盖座标
    byId.set(node.id, node);
  }

  // 连线只收两端都存在、且非自环的边（自环在 LR 分层图画出来是零长度箭头，只会污染版面）。
  const edges: DagConnectionInput[] = [];
  const seenEdge = new Set<string>();
  for (const conn of connections ?? []) {
    if (!byId.has(conn.from) || !byId.has(conn.to)) continue;
    if (conn.from === conn.to) continue;
    const key = `${conn.from}→${conn.to}`;
    if (seenEdge.has(key)) continue; // 重复边会让 dagre 叠线，去重
    seenEdge.add(key);
    edges.push(conn);
  }

  // 每个节点的 I/O 描述行：连线关系是「这步吃什么、吐什么」的唯一线索，
  // 缩图上一眼看出流程走向靠它（前一版没有这行，节点全是孤立方块）。
  const ioLinesFor = new Map<string, string[]>();
  for (const node of byId.values()) {
    const lines: string[] = [];
    const incoming = edges.filter((e) => e.to === node.id).map((e) => byId.get(e.from));
    const outgoing = edges.filter((e) => e.from === node.id).map((e) => byId.get(e.to));
    if (incoming.length) {
      lines.push(`↳ ${incoming.slice(0, 2).map((n) => humanizeRole(n?.role ?? n?.id ?? "")).join(", ")}`);
    }
    if (outgoing.length) {
      lines.push(`→ ${outgoing.slice(0, 2).map((n) => humanizeRole(n?.role ?? n?.id ?? "")).join(", ")}`);
    }
    ioLinesFor.set(node.id, lines);
  }

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({
    rankdir: "LR",
    nodesep: 36,
    ranksep: 80,
    marginx: MARGIN,
    marginy: MARGIN,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of byId.values()) {
    graph.setNode(node.id, { width: CARD_W, height: cardHeight(ioLinesFor.get(node.id)?.length ?? 0) });
  }
  for (const edge of edges) graph.setEdge(edge.from, edge.to);

  dagre.layout(graph);

  // dagre 座标是节点中心；记下包围盒后决定最终 viewBox。
  const placed: Array<{ node: DagNodeInput; x: number; y: number; h: number }> = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of byId.values()) {
    const pos = graph.node(node.id) as { x: number; y: number } | undefined;
    if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") continue;
    const h = cardHeight(ioLinesFor.get(node.id)?.length ?? 0);
    placed.push({ node, x: pos.x, y: pos.y, h });
    minX = Math.min(minX, pos.x - CARD_W / 2);
    maxX = Math.max(maxX, pos.x + CARD_W / 2);
    minY = Math.min(minY, pos.y - h / 2);
    maxY = Math.max(maxY, pos.y + h / 2);
  }

  // 实测范围（含留白）比要求尺寸小 → 以要求尺寸为画布、内容置中；
  // 比要求尺寸大 → 依实测范围出图（不硬切，dagre 说多宽就多宽）。
  const contentW = maxX - minX;
  const contentH = maxY - minY;
  const canvasW = Math.max(requestedW, Math.ceil(contentW + MARGIN * 2));
  const canvasH = Math.max(requestedH, Math.ceil(contentH + MARGIN * 2));
  const offsetX = (canvasW - contentW) / 2 - minX;
  const offsetY = (canvasH - contentH) / 2 - minY;

  const body: string[] = [];
  body.push(`<rect width="${canvasW}" height="${canvasH}" fill="${palette.bg}"/>`);
  body.push(gridPattern(canvasW, canvasH, palette));

  // 先画边（在节点下层，箭头自然被节点盖住末端）。
  for (const edge of edges) {
    const info = graph.edge(edge.from, edge.to) as { points?: Array<{ x: number; y: number }> } | undefined;
    const points = info?.points ?? [];
    if (points.length < 2) continue;
    const d = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${fmt(p.x + offsetX)},${fmt(p.y + offsetY)}`)
      .join(" ");
    body.push(
      `<path d="${d}" fill="none" stroke="${palette.edge}" stroke-width="1.5" marker-end="url(#dag-arrow)"/>`,
    );
  }

  // 再画节点卡片。
  for (const { node, x, y, h } of placed) {
    const left = x - CARD_W / 2 + offsetX;
    const top = y - h / 2 + offsetY;
    const style = KIND_STYLE[node.kind] ?? KIND_STYLE_FALLBACK;
    const failed = node.status === "failed";
    const stroke = failed ? palette.failedStroke : palette.cardStroke;

    // 卡片本体 + 顶部色条（顶部两角同卡片圆角，故用 clip 语义的 path 叠一张圆角矩形）。
    body.push(
      `<rect x="${fmt(left)}" y="${fmt(top)}" width="${CARD_W}" height="${fmt(h)}" rx="${NODE_RADIUS}" ry="${NODE_RADIUS}" fill="${palette.cardBg}" stroke="${stroke}" stroke-width="${failed ? 2 : 1}"/>`,
    );
    body.push(
      `<path d="${accentPath(left, top, CARD_W)}" fill="${style.accent}"/>`,
    );

    // 标题（左对齐，超宽截断）＝节点中文名；下方小字＝role（snake_case 转空白）。
    let cursorY = top + ACCENT_H + 8;
    const title = truncate(node.title || node.role || node.id, TITLE_SIZE, CARD_W - PAD_X * 2);
    body.push(
      `<text x="${fmt(left + PAD_X)}" y="${fmt(cursorY + 11)}" font-size="${TITLE_SIZE}" font-weight="600" fill="${palette.title}">${esc(title)}</text>`,
    );
    cursorY += 15;

    // 标签列：kind 标签徽章（左）＋ role 小字（右）。
    const tagW = textWidth(style.tagLabel, TAG_SIZE) + 12;
    body.push(
      `<rect x="${fmt(left + PAD_X)}" y="${fmt(cursorY)}" width="${fmt(tagW)}" height="14" rx="4" ry="4" fill="${style.tagBg}"/>`,
    );
    body.push(
      `<text x="${fmt(left + PAD_X + tagW / 2)}" y="${fmt(cursorY + 10.5)}" font-size="${TAG_SIZE}" fill="${style.tagText}" text-anchor="middle">${esc(style.tagLabel)}</text>`,
    );
    const roleText = truncate(humanizeRole(node.role || ""), SUB_SIZE, CARD_W - PAD_X * 2 - tagW - 8);
    if (roleText) {
      body.push(
        `<text x="${fmt(left + PAD_X + tagW + 6)}" y="${fmt(cursorY + 10.5)}" font-size="${SUB_SIZE}" fill="${palette.muted}">${esc(roleText)}</text>`,
      );
    }
    cursorY += 16 + 4;

    // I/O 内文行（↳ 输入来源 / → 产出目标）。
    for (const line of ioLinesFor.get(node.id) ?? []) {
      const text = truncate(line, IO_SIZE, CARD_W - PAD_X * 2);
      body.push(
        `<text x="${fmt(left + PAD_X)}" y="${fmt(cursorY + 9)}" font-size="${IO_SIZE}" fill="${palette.subtitle}">${esc(text)}</text>`,
      );
      cursorY += 13;
    }

    // costCoins 有值（含 0）→ 右下角币数徽章。0 也要显示：0 币是事实，不是缺值。
    if (typeof node.costCoins === "number" && Number.isFinite(node.costCoins)) {
      const label = esc(`${fmtCoins(node.costCoins)} 币`);
      const badgeW = Math.max(40, textWidth(label, TAG_SIZE) + 12);
      body.push(
        `<rect x="${fmt(left + CARD_W - badgeW - PAD_X)}" y="${fmt(top + h - 19)}" width="${fmt(badgeW)}" height="14" rx="4" ry="4" fill="${palette.costBg}"/>`,
      );
      body.push(
        `<text x="${fmt(left + CARD_W - badgeW / 2 - PAD_X)}" y="${fmt(top + h - 8.5)}" font-size="${TAG_SIZE}" fill="${palette.costText}" text-anchor="middle">${label}</text>`,
      );
    }
  }

  return wrapSvg(canvasW, canvasH, canvasW, canvasH, palette, body.join(""));
}

/** 顶部色条：只有上方两角跟随卡片圆角，下缘平直。 */
function accentPath(left: number, top: number, w: number): string {
  const r = NODE_RADIUS;
  return (
    `M${fmt(left)},${fmt(top + r)}` +
    `a${r},${r} 0 0 1 ${r},${-r}` +
    `h${fmt(w - r * 2)}` +
    `a${r},${r} 0 0 1 ${r},${r}` +
    `v${fmt(ACCENT_H - r)}` +
    `h${fmt(-w)}` +
    `z`
  );
}

/** 背景网格点阵（与站内画布同视觉语言；纯装饰，不影响节点可读性）。 */
function gridPattern(w: number, h: number, palette: Palette): string {
  const id = "dag-grid";
  const dots: string[] = [];
  for (let y = GRID; y < h; y += GRID) {
    for (let x = GRID; x < w; x += GRID) {
      dots.push(`<circle cx="${x}" cy="${y}" r="0.9"/>`);
    }
  }
  return (
    `<defs><pattern id="${id}" width="${GRID}" height="${GRID}" patternUnits="userSpaceOnUse">` +
    `<circle cx="1" cy="1" r="0.9" fill="${palette.gridDot}"/></pattern></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#${id})" opacity="0.85"/>`
  );
}

/** 统一的 <svg> 外壳：箭头 marker 与字型堆叠在此宣告一次。 */
function wrapSvg(
  viewW: number,
  viewH: number,
  outW: number,
  outH: number,
  palette: Palette,
  body: string,
): string {
  const defs =
    `<defs><marker id="dag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
    `<path d="M0,0 L10,5 L0,10 z" fill="${palette.edgeArrow}"/></marker></defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(outW)}" height="${fmt(outH)}" viewBox="0 0 ${fmt(viewW)} ${fmt(viewH)}" font-family="${FONT_STACK}">${defs}${body}</svg>`;
}
