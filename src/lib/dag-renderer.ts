// DAG 結構渲染器（純函式，零 Next.js 依賴）。
//
// 用途：把工作流節點／連線（gateway 的 WorkflowNodeSpec 形狀，節點本身無座標）
// 用 dagre 算出分層佈局，再輸出成完整 <svg> 字串。
//   renderDagSvg(nodes, connections, options) → "<svg …>…</svg>"
//
// 設計理由：
// - 節點沒有座標（`deploy-staging/gateway/workflow-templates.ts` 只給 role/kind/title），
//   所以佈局必須由 dagre 現算，不能靠呼叫方提供 x/y。
// - 只輸出 SVG 字串、不碰 DOM：同一份邏輯要能在 node --test 直接 import，
//   也要能被 server route / 前端透過 svgToDataUrl（src/lib/svg-data-url.ts）餵給 <img>。
// - 因此本檔「不」import 任何 `@/` alias 或 app 層模組，只用相對路徑＋純 npm 依賴（dagre）。
//
// 渲染規格：圓角矩形節點，主標題 = title、次要小字 = kind；依 kind 上色（柔和淺色系）；
// status === "failed" 加紅色外框；costCoins 有值時右下角顯示幣數；連線帶箭頭 marker。
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
  /** 起點節點 id（不是 role）。 */
  from: string;
  /** 終點節點 id（不是 role）。 */
  to: string;
}

export interface DagRenderOptions {
  /** 外框寬度（像素）；佈局比這小則留白置中，比這大則以實際範圍為準。 */
  width?: number;
  /** 外框高度（像素）；同上。 */
  height?: number;
  theme?: "light" | "dark";
}

// ───────────────────────── 樣式常數 ─────────────────────────

interface Palette {
  bg: string;
  nodeExtra: string;
  title: string;
  subtitle: string;
  edge: string;
  muted: string;
  costBg: string;
  costText: string;
  failedStroke: string;
}

const LIGHT: Palette = {
  bg: "#ffffff",
  nodeExtra: "#eef2f7",
  title: "#1f2937",
  subtitle: "#6b7280",
  edge: "#94a3b8",
  muted: "#cbd5e1",
  costBg: "#f1f5f9",
  costText: "#475569",
  failedStroke: "#dc2626",
};

const DARK: Palette = {
  bg: "#0f172a",
  nodeExtra: "#1e293b",
  title: "#e2e8f0",
  subtitle: "#94a3b8",
  edge: "#64748b",
  muted: "#334155",
  costBg: "#1e293b",
  costText: "#cbd5e1",
  failedStroke: "#ef4444",
};

/**
 * kind → 節點填色（柔和淺色系，同一家族跨 kind 仍可辨識）。
 * text/config 是「設定類」，image/video/audio/film 是「產出類」，色相刻意分開。
 */
const KIND_FILL: Record<string, string> = {
  text: "#e0e7ff", // 靛藍
  config: "#e2e8f0", // 灰藍
  image: "#d1fae5", // 綠
  video: "#fef3c7", // 琥珀
  audio: "#fce7f3", // 粉
  film: "#ede9fe", // 紫
};
const KIND_FILL_FALLBACK = "#e5e7eb";

const NODE_W = 150;
const NODE_H = 58;
const NODE_RADIUS = 8;
// 系統 sans-serif 堆疊。內層字型名一律用單引號：這個字串會被整段塞進
// SVG 的 font-family="…" 雙引號屬性，若用 \" 轉義會讓 libvips/瀏覽器
// 的 XML 解析器在屬性中途斷開（sharp 實測 "Couldn't find end of Start Tag svg"）。
const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Noto Sans CJK SC', 'PingFang SC', 'Microsoft YaHei', sans-serif";

/** 邊界留白（像素）：箭頭／cost 徽章不貼邊。 */
const MARGIN = 16;

// ───────────────────────── 工具函式 ─────────────────────────

/** XML 文字轉義：標題與錯誤訊息是外部資料，必須逐字元轉義再進 SVG。 */
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

/** 文字寬度粗估（CJK 全形算 1em、其餘算 0.55em），用來截斷過長標題。 */
function textWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) units += ch.charCodeAt(0) > 0x2e7f ? 1 : 0.55;
  return units * fontSize;
}

/** 依可用寬度截斷，超出時尾端加省略號（節點寬度固定，過長標題會溢出）。 */
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

/** 幣數顯示：整數不帶小數，有零頭才留一位，避免「3.00 幣」這種噪音。 */
function fmtCoins(coins: number): string {
  return Number.isInteger(coins) ? String(coins) : coins.toFixed(1);
}

// ───────────────────────── 主函式 ─────────────────────────

/**
 * dagre 分層布局 + SVG 字串輸出。回傳完整 `<svg>` 字串（開頭必須是 `<svg`）。
 *
 * 空節點陣列 → 回傳一個最小合法 SVG（白／深底 + 一句提示），不拋錯。
 * 連線指向不存在的節點 id → 該條連線略過（gateway 資料可能有孤兒邊）。
 */
export function renderDagSvg(
  nodes: DagNodeInput[],
  connections: DagConnectionInput[],
  options?: DagRenderOptions,
): string {
  const theme = options?.theme === "dark" ? "dark" : "light";
  const palette = theme === "dark" ? DARK : LIGHT;
  const requestedW = options?.width ?? 640;
  const requestedH = options?.height ?? 400;

  // 空圖：dagre 對無節點圖回 width/height = null，不能進佈局流程，直接短路。
  if (!nodes || nodes.length === 0) {
    return wrapSvg(
      requestedW,
      requestedH,
      requestedW,
      requestedH,
      palette,
      `<rect width="${requestedW}" height="${requestedH}" fill="${palette.bg}"/>` +
        `<text x="${fmt(requestedW / 2)}" y="${fmt(requestedH / 2)}" font-size="13" fill="${palette.subtitle}" text-anchor="middle">暫無節點</text>`,
    );
  }

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({
    rankdir: "LR",
    nodesep: 30,
    ranksep: 64,
    marginx: MARGIN,
    marginy: MARGIN,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  const byId = new Map<string, DagNodeInput>();
  for (const node of nodes) {
    if (byId.has(node.id)) continue; // 重複 id 只認首見：dagre 同 id 重設會覆蓋座標
    byId.set(node.id, node);
    graph.setNode(node.id, { width: NODE_W, height: NODE_H });
  }

  // 連線只收兩端都存在、且非自環的邊（自環在 LR 分層圖畫出來是零長度箭頭，只會污染版面）。
  const edges: DagConnectionInput[] = [];
  const seenEdge = new Set<string>();
  for (const conn of connections ?? []) {
    if (!byId.has(conn.from) || !byId.has(conn.to)) continue;
    if (conn.from === conn.to) continue;
    const key = `${conn.from}→${conn.to}`;
    if (seenEdge.has(key)) continue; // 重複邊會讓 dagre 疊線，去重
    seenEdge.add(key);
    edges.push(conn);
    graph.setEdge(conn.from, conn.to);
  }

  dagre.layout(graph);

  // dagre 座標是節點中心；記下包圍盒後決定最終 viewBox。
  const placed: Array<{ node: DagNodeInput; x: number; y: number }> = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of byId.values()) {
    const pos = graph.node(node.id) as { x: number; y: number } | undefined;
    if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") continue;
    placed.push({ node, x: pos.x, y: pos.y });
    minX = Math.min(minX, pos.x - NODE_W / 2);
    maxX = Math.max(maxX, pos.x + NODE_W / 2);
    minY = Math.min(minY, pos.y - NODE_H / 2);
    maxY = Math.max(maxY, pos.y + NODE_H / 2);
  }

  // 實測範圍（含留白）比要求尺寸小 → 以要求尺寸為畫布、內容置中；
  // 比要求尺寸大 → 依實測範圍出圖（不硬切，dagre 說多寬就多寬）。
  const contentW = maxX - minX;
  const contentH = maxY - minY;
  const canvasW = Math.max(requestedW, Math.ceil(contentW + MARGIN * 2));
  const canvasH = Math.max(requestedH, Math.ceil(contentH + MARGIN * 2));
  const offsetX = (canvasW - contentW) / 2 - minX;
  const offsetY = (canvasH - contentH) / 2 - minY;

  const body: string[] = [];
  body.push(`<rect width="${canvasW}" height="${canvasH}" fill="${palette.bg}"/>`);

  // 先畫邊（在節點下層，箭頭自然被節點蓋住末端）。
  for (const edge of edges) {
    const info = graph.edge(edge.from, edge.to) as { points?: Array<{ x: number; y: number }> } | undefined;
    const points = info?.points ?? [];
    if (points.length < 2) continue;
    const d = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${fmt(p.x + offsetX)},${fmt(p.y + offsetY)}`)
      .join(" ");
    body.push(`<path d="${d}" fill="none" stroke="${palette.edge}" stroke-width="1.5" marker-end="url(#dag-arrow)"/>`);
  }

  // 再畫節點。
  for (const { node, x, y } of placed) {
    const left = x - NODE_W / 2 + offsetX;
    const top = y - NODE_H / 2 + offsetY;
    const failed = node.status === "failed";
    const fill = KIND_FILL[node.kind] ?? KIND_FILL_FALLBACK;
    const stroke = failed ? palette.failedStroke : theme === "dark" ? "#334155" : "#cbd5e1";
    const strokeWidth = failed ? 2.5 : 1;

    body.push(
      `<rect x="${fmt(left)}" y="${fmt(top)}" width="${NODE_W}" height="${NODE_H}" rx="${NODE_RADIUS}" ry="${NODE_RADIUS}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`,
    );

    // 標題（置中，超寬截斷）與 kind 小字（置中偏下）。
    const title = truncate(node.title || node.role || node.id, 13, NODE_W - 20);
    body.push(
      `<text x="${fmt(x + offsetX)}" y="${fmt(top + 24)}" font-size="13" font-weight="600" fill="${palette.title}" text-anchor="middle">${esc(title)}</text>`,
    );
    body.push(
      `<text x="${fmt(x + offsetX)}" y="${fmt(top + 42)}" font-size="10" fill="${palette.subtitle}" text-anchor="middle">${esc(node.kind)}</text>`,
    );

    // costCoins 有值（含 0）→ 右下角幣數徽章。0 也要顯示：0 幣是事實，不是缺值。
    if (typeof node.costCoins === "number" && Number.isFinite(node.costCoins)) {
      const label = esc(`${fmtCoins(node.costCoins)} 幣`);
      const badgeW = Math.max(34, textWidth(label, 10) + 10);
      body.push(
        `<rect x="${fmt(left + NODE_W - badgeW)}" y="${fmt(top + NODE_H - 16)}" width="${fmt(badgeW)}" height="15" rx="7" ry="7" fill="${palette.costBg}"/>`,
      );
      body.push(
        `<text x="${fmt(left + NODE_W - badgeW / 2)}" y="${fmt(top + NODE_H - 5)}" font-size="10" fill="${palette.costText}" text-anchor="middle">${label}</text>`,
      );
    }
  }

  return wrapSvg(canvasW, canvasH, canvasW, canvasH, palette, body.join(""));
}

/** 統一的 <svg> 外殼：箭頭 marker 與字型堆疊在此宣告一次。 */
function wrapSvg(
  viewW: number,
  viewH: number,
  outW: number,
  outH: number,
  palette: Palette,
  body: string,
): string {
  const defs =
    `<defs><marker id="dag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M0,0 L10,5 L0,10 z" fill="${palette.edge}"/></marker></defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(outW)}" height="${fmt(outH)}" viewBox="0 0 ${fmt(viewW)} ${fmt(viewH)}" font-family="${FONT_STACK}">${defs}${body}</svg>`;
}
