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
// ─────────────────────── 視覺規格（對齊站內畫布，2026-09-20 重寫）───────────────────────
// 前一版是「三個光禿小方塊」——150×58、13px 標題、無標籤無 I/O 描述，縮圖後不可讀。
// 本版改成與用戶在畫布上實際看到的節點卡同構（暴君實證：「渲染出来几乎不可用」）：
//   - 卡片 220px 寬、內容自適應高（頂部色條 3px + 標題列 + 標籤列 + I/O 內文）
//   - 頂部 3px 色條＝kind 色相（一眼認出圖/影片/文字/配置）
//   - 標籤徽章：工具 / 產出 / 文本 / 配置（底色+文字色成對，同站內 badge 規範）
//   - 節點內文：role 與連線關係（↳ 輸入來源 / → 產出目標），讓縮圖能看出這步在做什麼
//   - 背景網格點陣（#D0D5DD），與畫布同視覺語言
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
  /** 背景網格點（畫布視覺語言）。 */
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
 * kind → 卡片視覺：頂部色條 + 標籤（文字色／底色成對）。
 * 色相與站內畫布一致：工具藍、產出紫/綠/橙、文本灰。
 */
interface KindStyle {
  /** 頂部 3px 色條（焦點色）。 */
  accent: string;
  /** 標籤文字色。 */
  tagText: string;
  /** 標籤底色。 */
  tagBg: string;
  /** 標籤文字（中文，讓縮圖看得懂這是什麼）。 */
  tagLabel: string;
}

const KIND_STYLE: Record<string, KindStyle> = {
  text: { accent: "#86909c", tagText: "#4e5969", tagBg: "#f2f3f5", tagLabel: "文本" },
  config: { accent: "#1677ff", tagText: "#1677ff", tagBg: "#e6f4ff", tagLabel: "配置" },
  image: { accent: "#00b578", tagText: "#00b578", tagBg: "#e6fffb", tagLabel: "產出" },
  video: { accent: "#722ed1", tagText: "#722ed1", tagBg: "#f9f0ff", tagLabel: "產出" },
  audio: { accent: "#fa8c16", tagText: "#fa8c16", tagBg: "#fff7e6", tagLabel: "產出" },
  film: { accent: "#f53f3f", tagText: "#f53f3f", tagBg: "#ffece8", tagLabel: "成片" },
};
const KIND_STYLE_FALLBACK: KindStyle = {
  accent: "#86909c",
  tagText: "#4e5969",
  tagBg: "#f2f3f5",
  tagLabel: "節點",
};

// 卡片尺寸對齊站內畫布節點卡（220px 寬 / 內容自適應高）。
const CARD_W = 220;
const CARD_MIN_H = 78;
const ACCENT_H = 3;
const PAD_X = 10;
const TITLE_SIZE = 12.5;
const SUB_SIZE = 10.5;
const IO_SIZE = 10.5;
const TAG_SIZE = 10;

const NODE_RADIUS = 8;

// 系統 sans-serif 堆疊。內層字型名一律用單引號：這個字串會被整段塞進
// SVG 的 font-family="…" 雙引號屬性，若用 \" 轉義會讓 libvips/瀏覽器的
// XML 解析器在屬性中途斷開（sharp 實測 "Couldn't find end of Start Tag svg"）。
const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Noto Sans CJK SC', 'PingFang SC', 'Microsoft YaHei', sans-serif";

/** 邊界留白（像素）：箭頭／cost 徽章不貼邊。 */
const MARGIN = 24;
/** 網格點間距。 */
const GRID = 20;

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

/** 依可用寬度截斷，超出時尾端加省略號（卡片寬度固定，過長標題會溢出）。 */
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

/** role 可讀化：把 snake_case 轉成空格分隔，讓縮圖不必逐字讀底線。 */
function humanizeRole(role: string): string {
  return role.replace(/[_-]+/g, " ").trim() || role;
}

/** 節點卡片的高度：標題 + 標籤 +（有 I/O 時）內文行。 */
function cardHeight(ioLines: number): number {
  const base = ACCENT_H + 8 + 15 + 16 + 10; // 色條 + 上距 + 標題行 + 標籤行 + 下距
  return Math.max(CARD_MIN_H, base + ioLines * 13);
}

// ───────────────────────── 主函式 ─────────────────────────

/**
 * dagre 分層布局 + SVG 字串輸出。回傳完整 `<svg>` 字串（開頭必須是 `<svg`）。
 *
 * 空節點陣列 → 回傳一個最小合法 SVG（底 + 一句提示），不拋錯。
 * 連線指向不存在的節點 id → 該條連線略過（gateway 資料可能有孤兒邊）。
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

  const byId = new Map<string, DagNodeInput>();
  for (const node of nodes) {
    if (byId.has(node.id)) continue; // 重複 id 只認首見：dagre 同 id 重設會覆蓋座標
    byId.set(node.id, node);
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
  }

  // 每個節點的 I/O 描述行：連線關係是「這步吃什麼、吐什麼」的唯一線索，
  // 縮圖上一眼看出流程走向靠它（前一版沒有這行，節點全是孤立方塊）。
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

  // dagre 座標是節點中心；記下包圍盒後決定最終 viewBox。
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
  body.push(gridPattern(canvasW, canvasH, palette));

  // 先畫邊（在節點下層，箭頭自然被節點蓋住末端）。
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

  // 再畫節點卡片。
  for (const { node, x, y, h } of placed) {
    const left = x - CARD_W / 2 + offsetX;
    const top = y - h / 2 + offsetY;
    const style = KIND_STYLE[node.kind] ?? KIND_STYLE_FALLBACK;
    const failed = node.status === "failed";
    const stroke = failed ? palette.failedStroke : palette.cardStroke;

    // 卡片本體 + 頂部色條（頂部兩角同卡片圓角，故用 clip 語義的 path 疊一張圓角矩形）。
    body.push(
      `<rect x="${fmt(left)}" y="${fmt(top)}" width="${CARD_W}" height="${fmt(h)}" rx="${NODE_RADIUS}" ry="${NODE_RADIUS}" fill="${palette.cardBg}" stroke="${stroke}" stroke-width="${failed ? 2 : 1}"/>`,
    );
    body.push(
      `<path d="${accentPath(left, top, CARD_W)}" fill="${style.accent}"/>`,
    );

    // 標題（左對齊，超寬截斷）＝節點中文名；下方小字＝role（snake_case 轉空白）。
    let cursorY = top + ACCENT_H + 8;
    const title = truncate(node.title || node.role || node.id, TITLE_SIZE, CARD_W - PAD_X * 2);
    body.push(
      `<text x="${fmt(left + PAD_X)}" y="${fmt(cursorY + 11)}" font-size="${TITLE_SIZE}" font-weight="600" fill="${palette.title}">${esc(title)}</text>`,
    );
    cursorY += 15;

    // 標籤列：kind 標籤徽章（左）＋ role 小字（右）。
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

    // I/O 內文行（↳ 輸入來源 / → 產出目標）。
    for (const line of ioLinesFor.get(node.id) ?? []) {
      const text = truncate(line, IO_SIZE, CARD_W - PAD_X * 2);
      body.push(
        `<text x="${fmt(left + PAD_X)}" y="${fmt(cursorY + 9)}" font-size="${IO_SIZE}" fill="${palette.subtitle}">${esc(text)}</text>`,
      );
      cursorY += 13;
    }

    // costCoins 有值（含 0）→ 右下角幣數徽章。0 也要顯示：0 幣是事實，不是缺值。
    if (typeof node.costCoins === "number" && Number.isFinite(node.costCoins)) {
      const label = esc(`${fmtCoins(node.costCoins)} 幣`);
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

/** 頂部色條：只有上方兩角跟隨卡片圓角，下緣平直。 */
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

/** 背景網格點陣（與站內畫布同視覺語言；純裝飾，不影響節點可讀性）。 */
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
    `<defs><marker id="dag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
    `<path d="M0,0 L10,5 L0,10 z" fill="${palette.edgeArrow}"/></marker></defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(outW)}" height="${fmt(outH)}" viewBox="0 0 ${fmt(viewW)} ${fmt(viewH)}" font-family="${FONT_STACK}">${defs}${body}</svg>`;
}
