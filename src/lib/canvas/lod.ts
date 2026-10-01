// 語義縮放（Semantic Zoom，2026-09-30）純函式層：
//
//   - nextLod：縮放倍率 k → 渲染抽象層級（LOD），帶遲滯，停在門檻附近不來回跳。
//       LOD 1 導演鳥瞰（k 小）：只看 4 個階段色塊＋進度/審核，節點與連線不掛載。
//       LOD 2 製片協作（預設）：現狀不變。
//       LOD 3 工程透析（k 大）：卡片世界幾何不變，卡內疊工程條，可開透析面板。
//   - classifyStage：節點 → 四階段（01 劇本大綱 / 02 視覺資產·選角 / 03 鏡頭管線 / 04 成品交付）。
//     只讀既有 metadata，不新增任何鍵（雙白名單鐵律）；Group 殼不計數。
//   - summarizeStages：各階段計數＋世界座標 bbox（供 HUD 點擊飛到該階段）。
//   - fitStageViewport：bbox → 視口（k 夾在協作層區間，點擊即落 LOD 2）。
//   - lodBlend：k → 連續轉場係數（gather 聚合 / xray 透析）。**k 是唯一真源**：
//       離散 LOD 只管掛載與指針，視覺轉場全是 k 的連續函數，可被滾輪「刷」、可逆。
//   - interpolateViewport：相機飛行插值（世界中心線性 + k 對數插值，縮放速度感均勻）。
//   - gatherOffsets / hudSlots / engineeringFocusViewport：聚合位移、鳥瞰卡槽位、透析落點。

import { CanvasNodeType, type CanvasNode, type CanvasViewport } from "./types";

export type CanvasLod = 1 | 2 | 3;
export type CanvasStageId = 1 | 2 | 3 | 4;

/**
 * 遲滯門檻：進入與退出分開，中間是緩衝帶。
 * 工程層刻意放在 100% 以上（2026-10-01 暴君回饋）：模板/適應視圖常落在 80–100%，
 * 工程層若從 80% 起跳，日常協作就會意外長出工程條（黑邊）並多掛一堆元素（卡）。
 */
export const LOD_THRESHOLDS = {
  enterOverview: 0.37,
  exitOverview: 0.43,
  enterEngineering: 1.15,
  exitEngineering: 1.05,
} as const;

/** 縮放控制「鸟瞰/协作/工程」三段按鈕的目標倍率。 */
export const LOD_TARGET_SCALE: Record<CanvasLod, number> = { 1: 0.3, 2: 0.6, 3: 1.5 };

export const LOD_LABEL: Record<CanvasLod, string> = { 1: "鸟瞰", 2: "协作", 3: "工程" };

export const CANVAS_STAGES: readonly { id: CanvasStageId; code: string; label: string }[] = [
  { id: 1, code: "01", label: "剧本大纲" },
  { id: 2, code: "02", label: "视觉资产 / 选角" },
  { id: 3, code: "03", label: "镜头管线" },
  { id: 4, code: "04", label: "成品交付" },
];

/**
 * k → 下一個 LOD（帶遲滯）。
 * 進 LOD1 需 k<0.37、退出需 k>0.43；進 LOD3 需 k>1.15、退出需 k<1.05。
 * allowEngineering=false（窄螢幕）時上限 2。
 */
export function nextLod(prev: CanvasLod, k: number, opts: { allowEngineering?: boolean } = {}): CanvasLod {
  const cap: CanvasLod = opts.allowEngineering === false ? 2 : 3;
  let lod: CanvasLod;
  if (prev === 1) {
    lod = k > LOD_THRESHOLDS.exitOverview ? (k > LOD_THRESHOLDS.enterEngineering ? 3 : 2) : 1;
  } else if (prev === 3) {
    lod = k < LOD_THRESHOLDS.enterOverview ? 1 : k < LOD_THRESHOLDS.exitEngineering ? 2 : 3;
  } else {
    lod = k < LOD_THRESHOLDS.enterOverview ? 1 : k > LOD_THRESHOLDS.enterEngineering ? 3 : 2;
  }
  return lod > cap ? cap : lod;
}

/** 首幀（無前值）：以協作層為起點推一次。 */
export function initialLod(k: number, opts: { allowEngineering?: boolean } = {}): CanvasLod {
  return nextLod(2, k, opts);
}

/** 帶分鏡歸屬指針 = 屬於鏡頭管線。 */
function hasShotPointer(node: CanvasNode): boolean {
  const m = node.metadata;
  return !!(m?.shotId || m?.directorStageId || m?.shotCandidates || m?.storyboardShot);
}

/**
 * 節點 → 階段。判定順序（先中先得，確定性）：
 *   1. Group → null（殼層不計數）
 *   2. pipelineCard tool|gate|step_head → 03（工具/門禁/步驟頭是管線本體）
 *   3. deliverable → 04
 *   4. Video / Audio → 04
 *   5. CharacterCard / SceneCard / Reference / Scene3d → 02
 *   6. Text / Prompt / Config / Director（含 pipelineCard director|note、storyboardScene、純文本 storyboardShot）→ 01
 *   7. Image：無分鏡指針且帶 entityCardId / referenceRole → 02；其餘 → 03
 *   8. 其他未知類型：有分鏡指針 → 03，否則 01
 */
export function classifyStage(node: CanvasNode): CanvasStageId | null {
  const m = node.metadata;
  if (node.type === CanvasNodeType.Group) return null;
  if (m?.pipelineCard === "tool" || m?.pipelineCard === "gate" || m?.pipelineCard === "step_head") return 3;
  if (m?.deliverable) return 4;
  switch (node.type) {
    case CanvasNodeType.Video:
    case CanvasNodeType.Audio:
      return 4;
    case CanvasNodeType.CharacterCard:
    case CanvasNodeType.SceneCard:
    case CanvasNodeType.Reference:
    case CanvasNodeType.Scene3d:
      return 2;
    case CanvasNodeType.Text:
    case CanvasNodeType.Prompt:
    case CanvasNodeType.Config:
    case CanvasNodeType.Director:
      return 1;
    case CanvasNodeType.Image:
      if (!hasShotPointer(node) && (m?.entityCardId || m?.referenceRole)) return 2;
      return 3;
    default:
      return hasShotPointer(node) ? 3 : 1;
  }
}

export interface CanvasStageBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 鳥瞰卡縮圖：真實產出（圖片或影片首幀），不造假圖。 */
export interface CanvasStagePreview {
  url: string;
  kind: "image" | "video";
}

export interface CanvasStageSummary {
  id: CanvasStageId;
  code: string;
  label: string;
  total: number;
  done: number;
  running: number;
  failed: number;
  pendingReview: number;
  /** 世界座標外框；total=0 時為 null。 */
  bbox: CanvasStageBBox | null;
  /** 世界座標質心（各節點中心的平均）；total=0 時為 null。聚合轉場的收束點。 */
  centroid: { x: number; y: number } | null;
  /** 成功產出的縮圖（最多 4，按位置由上而下、由左而右）。 */
  previews: CanvasStagePreview[];
  /** 階段 1 摘錄：第一個文本節點正文前 60 字（無則缺席）。 */
  excerpt?: string;
  /** 第一個「非空且未全部完成」的階段＝進行中（全域至多一個）。 */
  current: boolean;
  /** 非空且全部完成。 */
  complete: boolean;
  /** 第一個待審節點 id（CTA「需要你审核」飛到它）；無待審則缺席。 */
  firstPendingNodeId?: string;
  /** 逐節點狀態珠（按位置排序，最多 BEAD_LIMIT 顆）：無產出縮圖時用點陣一眼看清進度。 */
  beads: CanvasStageBead[];
}

export type CanvasStageBead = "done" | "running" | "failed" | "review" | "idle";

export const BEAD_LIMIT = 64;

const GENERATIVE_TYPES: ReadonlySet<CanvasNodeType> = new Set([CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio]);

/**
 * 節點狀態珠（也是階段完成度的唯一口徑）：
 *   · 待審優先（門禁/素材待裁決）；
 *   · 生成類（圖/影/音）只有 status=success 才算完成；
 *   · 非生成類（劇本文本、提示詞、參考、設定卡…）本身就是交付物：存在且未失敗/未運行即算完成
 *     ——否則沒有 status 的提示詞節點會讓「剧本大纲」永遠卡在進行中。
 */
export function beadOf(node: CanvasNode): CanvasStageBead {
  if (isPendingReview(node)) return "review";
  const status = node.metadata?.status;
  if (status === "loading") return "running";
  if (status === "error") return "failed";
  if (status === "success") return "done";
  return GENERATIVE_TYPES.has(node.type) ? "idle" : "done";
}

/** 待審：門禁卡 gateConfirm 待裁決，或素材卡 approval 待審。 */
function isPendingReview(node: CanvasNode): boolean {
  const m = node.metadata;
  return m?.gateConfirm?.status === "pending" || m?.approval?.status === "pending";
}

const PREVIEW_LIMIT = 4;
const EXCERPT_LIMIT = 60;

function isMediaUrl(value: string | undefined): value is string {
  return !!value && (value.startsWith("http") || value.startsWith("data:") || value.startsWith("blob:"));
}

/** 節點 → 縮圖（只收成功的真實產出）。 */
function previewOf(node: CanvasNode): CanvasStagePreview | null {
  const m = node.metadata;
  if (m?.status !== undefined && m.status !== "success") return null;
  if (!isMediaUrl(m?.content)) return null;
  switch (node.type) {
    case CanvasNodeType.Image:
    case CanvasNodeType.Reference:
    case CanvasNodeType.CharacterCard:
    case CanvasNodeType.SceneCard:
      return { url: m!.content!, kind: "image" };
    case CanvasNodeType.Video:
      return { url: m!.content!, kind: "video" };
    default:
      return null;
  }
}

function byPosition(a: CanvasNode, b: CanvasNode): number {
  return a.position.y - b.position.y || a.position.x - b.position.x;
}

export function summarizeStages(nodes: readonly CanvasNode[]): CanvasStageSummary[] {
  const acc = CANVAS_STAGES.map((s) => ({
    ...s,
    total: 0,
    done: 0,
    running: 0,
    failed: 0,
    pendingReview: 0,
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    sumCx: 0,
    sumCy: 0,
    members: [] as CanvasNode[],
  }));
  for (const node of nodes) {
    const stage = classifyStage(node);
    if (stage === null) continue;
    const a = acc[stage - 1];
    a.total += 1;
    a.members.push(node);
    const bead = beadOf(node);
    if (bead === "done") a.done += 1;
    else if (bead === "running") a.running += 1;
    else if (bead === "failed") a.failed += 1;
    if (isPendingReview(node)) a.pendingReview += 1;
    a.minX = Math.min(a.minX, node.position.x);
    a.minY = Math.min(a.minY, node.position.y);
    a.maxX = Math.max(a.maxX, node.position.x + node.width);
    a.maxY = Math.max(a.maxY, node.position.y + node.height);
    a.sumCx += node.position.x + node.width / 2;
    a.sumCy += node.position.y + node.height / 2;
  }
  const currentIndex = acc.findIndex((a) => a.total > 0 && a.done < a.total);
  return acc.map(({ minX, minY, maxX, maxY, sumCx, sumCy, members, ...rest }, index) => {
    const sorted = [...members].sort(byPosition);
    const previews: CanvasStagePreview[] = [];
    for (const n of sorted) {
      if (previews.length >= PREVIEW_LIMIT) break;
      const p = previewOf(n);
      if (p) previews.push(p);
    }
    const textNode =
      rest.id === 1
        ? sorted.find((n) => (n.type === CanvasNodeType.Text || n.type === CanvasNodeType.Prompt) && !!n.metadata?.content?.trim())
        : undefined;
    const excerptRaw = textNode?.metadata?.content?.trim().replace(/\s+/g, " ");
    const pending = sorted.find(isPendingReview);
    return {
      ...rest,
      bbox: rest.total > 0 ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null,
      centroid: rest.total > 0 ? { x: sumCx / rest.total, y: sumCy / rest.total } : null,
      previews,
      ...(excerptRaw ? { excerpt: excerptRaw.length > EXCERPT_LIMIT ? `${excerptRaw.slice(0, EXCERPT_LIMIT)}…` : excerptRaw } : {}),
      current: index === currentIndex,
      complete: rest.total > 0 && rest.done === rest.total,
      ...(pending ? { firstPendingNodeId: pending.id } : {}),
      beads: sorted.slice(0, BEAD_LIMIT).map(beadOf),
    };
  });
}

/** 全域進度（鳥瞰標題列「整体 62% · 待审 3」）。 */
export function overallProgress(stages: readonly CanvasStageSummary[]): { percent: number; pendingReview: number } {
  let total = 0;
  let done = 0;
  let pendingReview = 0;
  for (const s of stages) {
    total += s.total;
    done += s.done;
    pendingReview += s.pendingReview;
  }
  return { percent: total > 0 ? Math.round((done / total) * 100) : 0, pendingReview };
}

/**
 * 聚合位移：節點中心 → 所屬階段質心的世界向量（g=1 時節點收束到質心）。
 * 靜態量（只依節點列表），轉場每幀只變 CSS 變數 --lod-g，不重算。
 */
export function gatherOffsets(
  nodes: readonly CanvasNode[],
  stages: readonly CanvasStageSummary[],
): Map<string, { x: number; y: number; stage: CanvasStageId }> {
  const out = new Map<string, { x: number; y: number; stage: CanvasStageId }>();
  for (const node of nodes) {
    const stage = classifyStage(node);
    if (stage === null) continue;
    const c = stages[stage - 1]?.centroid;
    if (!c) continue;
    out.set(node.id, {
      x: c.x - (node.position.x + node.width / 2),
      y: c.y - (node.position.y + node.height / 2),
      stage,
    });
  }
  return out;
}

/** 飛到某階段時 k 的夾取區間：≥0.5 保證落 LOD 2，≤0.8 不越過工程層門檻。 */
export const STAGE_FIT_MIN_SCALE = 0.5;
export const STAGE_FIT_MAX_SCALE = 0.8;
const STAGE_FIT_PADDING = 0.9;

/** bbox → 視口：盡量整段入鏡、置中；k 夾在協作層區間（放不下就以 bbox 中心為準）。 */
export function fitStageViewport(bbox: CanvasStageBBox, size: { width: number; height: number }): CanvasViewport {
  const fitK =
    bbox.width > 0 && bbox.height > 0
      ? Math.min(size.width / bbox.width, size.height / bbox.height) * STAGE_FIT_PADDING
      : STAGE_FIT_MAX_SCALE;
  const k = Math.min(STAGE_FIT_MAX_SCALE, Math.max(STAGE_FIT_MIN_SCALE, fitK));
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  return { x: size.width / 2 - cx * k, y: size.height / 2 - cy * k, k };
}

/** 節點是否有可透析的工程資料（任務 id / 工具輸入輸出 / 模型）。 */
export function hasEngineeringData(node: CanvasNode): boolean {
  const m = node.metadata;
  return !!(m?.imageTaskId || m?.toolInput || m?.toolOutput || m?.model);
}

// ─────────────────────────────────────────── 連續轉場（k 是唯一真源）

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Hermite smoothstep；e0 > e1 時反向（k 越小越接近 1）。 */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** 聚合帶：k 0.50 → 0.36（鳥瞰 LOD1 進入門檻 0.37 之前收束完成）。 */
export const GATHER_RANGE = { start: 0.5, end: 0.36 } as const;
/** 透析帶：k 1.10 → 1.35（LOD3 進入門檻 1.15 落在帶內，掛載時工程條已開始滑出）。 */
export const XRAY_RANGE = { start: 1.1, end: 1.35 } as const;

function logRamp(from: number, to: number, k: number): number {
  // `+ 0`：把 0/負數 產生的 -0 正規化成 +0。
  return clamp01((Math.log(k) - Math.log(from)) / (Math.log(to) - Math.log(from))) + 0;
}

/** 相機飛行預設 easing：比 cubic 起步快，不在帶前空轉。 */
export function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;
}

/** k → 轉場係數。gather=1 ＝完全鳥瞰；xray=1 ＝完全透析。兩帶不重疊。 */
export function lodBlend(k: number): { gather: number; xray: number } {
  return {
    // 帶內線性（對 log k）：平滑交給相機飛行的 easing＋帶內減速；smoothstep 會把形變擠在帶中段一閃而過。
    gather: logRamp(GATHER_RANGE.start, GATHER_RANGE.end, k),
    xray: logRamp(XRAY_RANGE.start, XRAY_RANGE.end, k),
  };
}

/**
 * 聚合態下節點的視覺參數（g＝lodBlend.gather 原值）。
 * 節點的整段戲都在 phase A（g 0→0.6）演完，與徽章浮現同步：
 *   move（位移係數）/ scale 走 easeInOut；opacity 到 A 段後 45% 才開始淡——
 *   節點要「飛進徽章」而不是原地消失，否則中段會出現只剩兩顆小徽章的空鏡。
 */
export function gatherVisuals(g: number): { move: number; scale: number; opacity: number; blur: number } {
  const a = clamp01(g / 0.6);
  const m = easeInOutCubic(a);
  return {
    move: m,
    scale: 1 - 0.72 * m,
    opacity: 1 - smoothstep(0.55, 1, a),
    blur: a > 0.7 ? ((a - 0.7) / 0.3) * 3 : 0,
  };
}

/**
 * 相機插值：視口中心的世界點線性插值、k 走對數插值（每幀縮放比例恆定，
 * 不會「前段猛縮、後段拖」）；t=0/1 精確落在起訖。
 */
/** 形變帶（log k 區間）在相機飛行中的時間權重：帶內每單位 log k 花 BAND_TIME_WEIGHT 倍時間。 */
const BAND_TIME_WEIGHT = 6;
const WARP_SAMPLES = 96;

function inMorphBand(k: number): boolean {
  return (k <= GATHER_RANGE.start && k >= GATHER_RANGE.end) || (k >= XRAY_RANGE.start && k <= XRAY_RANGE.end);
}

/**
 * 相機飛行的「帶內減速」時間重映射：飛行參數 u 對 log k 線性，但穿過聚合帶/透析帶時放慢，
 * 讓形變佔據飛行的大半時間，而不是在 easeInOut 最快的中段 100ms 內一閃而過（硬切感的根因）。
 * 回傳 u∈[0,1]（給 interpolateViewport）；k 不變或未穿帶時等於輸入。
 */
export function warpFlightProgress(fromK: number, toK: number, e: number): number {
  const t = clamp01(e);
  if (fromK === toK || t === 0 || t === 1) return t;
  const l0 = Math.log(fromK);
  const l1 = Math.log(toK);
  const cum: number[] = [0];
  for (let i = 1; i <= WARP_SAMPLES; i++) {
    const mid = Math.exp(l0 + (l1 - l0) * ((i - 0.5) / WARP_SAMPLES));
    cum.push(cum[i - 1] + (inMorphBand(mid) ? BAND_TIME_WEIGHT : 1));
  }
  const total = cum[WARP_SAMPLES];
  if (total === WARP_SAMPLES) return t;
  const goal = t * total;
  let i = 1;
  while (i < WARP_SAMPLES && cum[i] < goal) i++;
  const seg = cum[i] - cum[i - 1];
  return (i - 1 + (seg > 0 ? (goal - cum[i - 1]) / seg : 0)) / WARP_SAMPLES;
}

export function interpolateViewport(
  from: CanvasViewport,
  to: CanvasViewport,
  t: number,
  size: { width: number; height: number },
): CanvasViewport {
  const e = clamp01(t);
  if (e === 0) return from;
  if (e === 1) return to;
  const hw = size.width / 2;
  const hh = size.height / 2;
  const c0x = (hw - from.x) / from.k;
  const c0y = (hh - from.y) / from.k;
  const c1x = (hw - to.x) / to.k;
  const c1y = (hh - to.y) / to.k;
  const k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e);
  // 錨點插值（不是世界中心線性插值）：放大時錨＝目的中心，它在螢幕上沿直線勻速走到視口中心；
  // 縮小時錨＝起點中心，它沿直線勻速離開中心。世界中心線性插值會讓目標在螢幕上先偏後折（飛行抖一下）。
  let cx: number;
  let cy: number;
  if (to.k >= from.k) {
    const f = ((1 - e) * from.k) / k;
    cx = c1x - (c1x - c0x) * f;
    cy = c1y - (c1y - c0y) * f;
  } else {
    const f = (e * to.k) / k;
    cx = c0x - (c0x - c1x) * f;
    cy = c0y - (c0y - c1y) * f;
  }
  return { x: hw - cx * k, y: hh - cy * k, k };
}

/** 以視口中心為錨縮放到 k（三段按鈕的目標視口）。 */
export function zoomAroundCenter(vp: CanvasViewport, k: number, size: { width: number; height: number }): CanvasViewport {
  const cx = size.width / 2;
  const cy = size.height / 2;
  const wx = (cx - vp.x) / vp.k;
  const wy = (cy - vp.y) / vp.k;
  return { x: cx - wx * k, y: cy - wy * k, k };
}

/** 把某世界點置於視口中心、倍率 k。 */
export function centerViewport(world: { x: number; y: number }, k: number, size: { width: number; height: number }): CanvasViewport {
  return { x: size.width / 2 - world.x * k, y: size.height / 2 - world.y * k, k };
}

export interface HudRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 鳥瞰卡尺寸與安全區：右側讓出縮放控件軌（44px 寬＋右距 16＋呼吸 28），
 * 頂部讓出畫布頂部薄條（標題膠囊、預算條）。
 * 兩種排法：安全區夠寬＝一行四張（row，232×268）；不夠（畫布與對話並排的常態）＝2×2（grid）。
 */
export const HUD_CARD = {
  width: 232,
  height: 268,
  gridMaxWidth: 300,
  gridHeight: 228,
  gap: 24,
  leftInset: 28,
  rightInset: 88,
  topInset: 64,
  headerSpace: 44,
} as const;

export type HudLayoutMode = "row" | "grid";

export function hudLayout(size: { width: number; height: number }, count = CANVAS_STAGES.length): { mode: HudLayoutMode; slots: HudRect[] } {
  const { gap, leftInset, rightInset, topInset, headerSpace } = HUD_CARD;
  const areaWidth = Math.max(0, size.width - leftInset - rightInset);
  const areaHeight = Math.max(0, size.height - topInset);
  const rowNeeds = HUD_CARD.width * count + gap * (count - 1);
  if (areaWidth >= rowNeeds || count < 4) {
    const width = Math.max(120, Math.min(HUD_CARD.width, (areaWidth - gap * (count - 1)) / count));
    const height = Math.round((width * HUD_CARD.height) / HUD_CARD.width);
    const rowWidth = width * count + gap * (count - 1);
    const left = leftInset + (areaWidth - rowWidth) / 2;
    const top = topInset + Math.max(headerSpace, (areaHeight - (headerSpace + height)) / 2 + headerSpace);
    return { mode: "row", slots: Array.from({ length: count }, (_, i) => ({ x: left + i * (width + gap), y: top, width, height })) };
  }
  const cols = 2;
  const rows = Math.ceil(count / cols);
  const width = Math.max(140, Math.min(HUD_CARD.gridMaxWidth, (areaWidth - gap) / cols));
  const height = HUD_CARD.gridHeight;
  const blockWidth = width * cols + gap;
  const blockHeight = height * rows + gap * (rows - 1);
  const left = leftInset + (areaWidth - blockWidth) / 2;
  const top = topInset + Math.max(headerSpace, (areaHeight - (headerSpace + blockHeight)) / 2 + headerSpace);
  return {
    mode: "grid",
    slots: Array.from({ length: count }, (_, i) => ({
      x: left + (i % cols) * (width + gap),
      y: top + Math.floor(i / cols) * (height + gap),
      width,
      height,
    })),
  };
}

/** 鳥瞰卡槽位（螢幕座標）＝ hudLayout(...).slots。 */
export function hudSlots(size: { width: number; height: number }, count = CANVAS_STAGES.length): HudRect[] {
  return hudLayout(size, count).slots;
}

/**
 * 透析落點：卡片置中於「面板左側的可見區」（free＝視口座標的左右界；缺省＝整個視口的左 2/3），
 * k 取「卡寬佔可見區 80%」與「不低於當前、至少 1」的較小者，下限 0.86（透析面板開著時宿主強制全透析，不依賴 LOD3）。
 * 窄畫布（與對話並排）時面板會吃掉大半寬度，固定左 1/3 會讓卡片被面板蓋住。
 */
export function engineeringFocusViewport(
  node: Pick<CanvasNode, "position" | "width" | "height">,
  size: { width: number; height: number },
  currentK: number,
  free?: { left: number; right: number },
): CanvasViewport {
  const left = free?.left ?? 0;
  const right = free?.right ?? (size.width * 2) / 3;
  const freeWidth = Math.max(1, right - left);
  const fitK = (freeWidth * 0.8) / Math.max(1, node.width);
  const k = Math.max(0.86, Math.min(Math.max(1, currentK), fitK));
  const cx = node.position.x + node.width / 2;
  const cy = node.position.y + node.height / 2;
  return { x: (left + right) / 2 - cx * k, y: size.height / 2 - cy * k, k };
}

/**
 * 視口移動中的量化倍率（2026-10-01 效能）：按 6% 對數格取整。
 * 用途：會被整棵子樹繼承的反向補償變數、memo 節點的 scale prop——移動中只在跨格時變，
 * 不必每幀重算樣式/重渲染；誤差 ≤3%（埠/把手/字級肉眼不可辨）。停手時呼叫端改用精確值。
 */
const SCALE_QUANT_STEP = Math.log(1.06);
export function quantizeScale(k: number): number {
  if (!(k > 0) || !Number.isFinite(k)) return 1;
  return Math.exp(Math.round(Math.log(k) / SCALE_QUANT_STEP) * SCALE_QUANT_STEP);
}
