// 语义缩放（Semantic Zoom，2026-09-30）纯函式层：
//
//   - nextLod：缩放倍率 k → 渲染抽象层级（LOD），带迟滞，停在门槛附近不来回跳。
//       LOD 0 画布层（2026-10-09，k 最小）：每个画布一格，跨画布切换。
//       LOD 1 导演鸟瞰（k 小）：只看 4 个阶段色块＋进度/审核，节点与连线不挂载。
//       LOD 2 制片协作（预设）：现状不变。
//       LOD 3 工程透析（k 大）：卡片世界几何不变，卡内叠工程条，可开透析面板。
//   - classifyStage：节点 → 四阶段（01 剧本大纲 / 02 视觉资产·选角 / 03 镜头管线 / 04 成品交付）。
//     只读既有 metadata，不新增任何键（双白名单铁律）；Group 壳不计数。
//   - summarizeStages：各阶段计数＋世界座标 bbox（供 HUD 点击飞到该阶段）。
//   - fitStageViewport：bbox → 视口（k 夹在协作层区间，点击即落 LOD 2）。
//   - lodBlend：k → 连续转场系数（gather 聚合 / xray 透析 / board 画布层）。**k 是唯一真源**：
//       离散 LOD 只管挂载与指针，视觉转场全是 k 的连续函数，可被滚轮「刷」、可逆。
//   - interpolateViewport：相机飞行插值（世界中心线性 + k 对数插值，缩放速度感均匀）。
//   - gatherOffsets / hudSlots / boardLayout / engineeringFocusViewport：聚合位移、鸟瞰卡槽位、画布格槽位、透析落点。

import { CanvasNodeType, type CanvasNode, type CanvasViewport } from "./types";

export type CanvasLod = 0 | 1 | 2 | 3;
export type CanvasStageId = 1 | 2 | 3 | 4;

/**
 * 迟滞门槛：进入与退出分开，中间是缓冲带。
 * 工程层刻意放在 100% 以上（2026-10-01 项目负责人回馈）：模板/适应视图常落在 80–100%，
 * 工程层若从 80% 起跳，日常协作就会意外长出工程条（黑边）并多挂一堆元素（卡）。
 * 画布层（2026-10-09）接在鸟瞰之下：进 0.18／出 0.22——比鸟瞰更缩才换层，
 * 放大回来要越过 0.22 才回鸟瞰，不会在 0.2 附近来回跳。
 */
export const LOD_THRESHOLDS = {
  enterBoard: 0.18,
  exitBoard: 0.22,
  enterOverview: 0.37,
  exitOverview: 0.43,
  enterEngineering: 1.15,
  exitEngineering: 1.05,
} as const;

/** 缩放控制「画布/鸟瞰/协作/工程」四段按钮的目标倍率。 */
export const LOD_TARGET_SCALE: Record<CanvasLod, number> = { 0: 0.1, 1: 0.3, 2: 0.6, 3: 1.5 };

export const LOD_LABEL: Record<CanvasLod, string> = { 0: "画布", 1: "鸟瞰", 2: "协作", 3: "工程" };

export const CANVAS_STAGES: readonly { id: CanvasStageId; code: string; label: string }[] = [
  { id: 1, code: "01", label: "剧本大纲" },
  { id: 2, code: "02", label: "视觉资产 / 选角" },
  { id: 3, code: "03", label: "镜头管线" },
  { id: 4, code: "04", label: "成品交付" },
];

/**
 * k → 下一个 LOD（带迟滞）。
 * 进 LOD0 需 k<0.18、退出需 k>0.22；进 LOD1 需 k<0.37、退出需 k>0.43；
 * 进 LOD3 需 k>1.15、退出需 k<1.05。
 * allowEngineering=false（窄萤幕）时 cap=2（**上限**语义：仍可下探到 LOD0/1）。
 */
export function nextLod(prev: CanvasLod, k: number, opts: { allowEngineering?: boolean } = {}): CanvasLod {
  const cap: CanvasLod = opts.allowEngineering === false ? 2 : 3;
  let lod: CanvasLod;
  switch (prev) {
    // 由画布层放大：越过 exitBoard 才离层；再往上按各层进入门槛判定。
    case 0:
      lod = k > LOD_THRESHOLDS.exitBoard
        ? k > LOD_THRESHOLDS.enterOverview
          ? k > LOD_THRESHOLDS.enterEngineering
            ? 3
            : 2
          : 1
        : 0;
      break;
    // 由鸟瞰缩小：低于 enterBoard 即入画布层；放大越过 exitOverview 才离鸟瞰。
    case 1:
      lod = k < LOD_THRESHOLDS.enterBoard
        ? 0
        : k > LOD_THRESHOLDS.exitOverview
          ? k > LOD_THRESHOLDS.enterEngineering
            ? 3
            : 2
          : 1;
      break;
    case 2:
      lod = k < LOD_THRESHOLDS.enterBoard
        ? 0
        : k < LOD_THRESHOLDS.enterOverview
          ? 1
          : k > LOD_THRESHOLDS.enterEngineering
            ? 3
            : 2;
      break;
    default:
      // case 3：缩小逐层退出（出工程 1.05→2、进鸟瞰 0.37→1、进画布 0.18→0）。
      lod = k < LOD_THRESHOLDS.enterBoard
        ? 0
        : k < LOD_THRESHOLDS.enterOverview
          ? 1
          : k < LOD_THRESHOLDS.exitEngineering
            ? 2
            : 3;
      break;
  }
  return lod > cap ? cap : lod;
}

/** 首帧（无前值）：以协作层为起点推一次。 */
export function initialLod(k: number, opts: { allowEngineering?: boolean } = {}): CanvasLod {
  return nextLod(2, k, opts);
}

/** 带分镜归属指针 = 属于镜头管线。 */
function hasShotPointer(node: CanvasNode): boolean {
  const m = node.metadata;
  return !!(m?.shotId || m?.directorStageId || m?.shotCandidates || m?.storyboardShot);
}

/**
 * 节点 → 阶段。判定顺序（先中先得，确定性）：
 *   1. Group → null（壳层不计数）
 *   2. pipelineCard tool|gate|step_head → 03（工具/门禁/步骤头是管线本体）
 *   3. deliverable → 04
 *   4. Video / Audio → 04
 *   5. CharacterCard / SceneCard / Reference / Scene3d → 02
 *   6. Text / Prompt / Config / Director（含 pipelineCard director|note、storyboardScene、纯文本 storyboardShot）→ 01
 *   7. Image：无分镜指针且带 entityCardId / referenceRole → 02；其余 → 03
 *   8. 其他未知类型：有分镜指针 → 03，否则 01
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

/** 鸟瞰卡缩图：真实产出（图片或影片首帧），不造假图。 */
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
  /** 世界座标外框；total=0 时为 null。 */
  bbox: CanvasStageBBox | null;
  /** 世界座标质心（各节点中心的平均）；total=0 时为 null。聚合转场的收束点。 */
  centroid: { x: number; y: number } | null;
  /** 成功产出的缩图（最多 4，按位置由上而下、由左而右）。 */
  previews: CanvasStagePreview[];
  /** 阶段 1 摘录：第一个文本节点正文前 60 字（无则缺席）。 */
  excerpt?: string;
  /** 第一个「非空且未全部完成」的阶段＝进行中（全域至多一个）。 */
  current: boolean;
  /** 非空且全部完成。 */
  complete: boolean;
  /** 第一个待审节点 id（CTA「需要你审核」飞到它）；无待审则缺席。 */
  firstPendingNodeId?: string;
  /** 逐节点状态珠（按位置排序，最多 BEAD_LIMIT 颗）：无产出缩图时用点阵一眼看清进度。 */
  beads: CanvasStageBead[];
}

export type CanvasStageBead = "done" | "running" | "failed" | "review" | "idle";

export const BEAD_LIMIT = 64;

const GENERATIVE_TYPES: ReadonlySet<CanvasNodeType> = new Set([CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio]);

/**
 * 节点状态珠（也是阶段完成度的唯一口径）：
 *   · 待审优先（门禁/素材待裁决）；
 *   · 生成类（图/影/音）只有 status=success 才算完成；
 *   · 非生成类（剧本文本、提示词、参考、设定卡…）本身就是交付物：存在且未失败/未运行即算完成
 *     ——否则没有 status 的提示词节点会让「剧本大纲」永远卡在进行中。
 */
export function beadOf(node: CanvasNode): CanvasStageBead {
  if (isPendingReview(node)) return "review";
  const status = node.metadata?.status;
  if (status === "loading") return "running";
  if (status === "error") return "failed";
  if (status === "success") return "done";
  return GENERATIVE_TYPES.has(node.type) ? "idle" : "done";
}

/** 待审：门禁卡 gateConfirm 待裁决，或素材卡 approval 待审。 */
function isPendingReview(node: CanvasNode): boolean {
  const m = node.metadata;
  return m?.gateConfirm?.status === "pending" || m?.approval?.status === "pending";
}

const PREVIEW_LIMIT = 4;
const EXCERPT_LIMIT = 60;

function isMediaUrl(value: string | undefined): value is string {
  return !!value && (value.startsWith("http") || value.startsWith("data:") || value.startsWith("blob:"));
}

/** 节点 → 缩图（只收成功的真实产出）。 */
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

/** 全域进度（鸟瞰标题列「整体 62% · 待审 3」）。 */
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
 * 聚合位移：节点中心 → 所属阶段质心的世界向量（g=1 时节点收束到质心）。
 * 静态量（只依节点列表），转场每帧只变 CSS 变数 --lod-g，不重算。
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

/** 飞到某阶段时 k 的夹取区间：≥0.5 保证落 LOD 2，≤0.8 不越过工程层门槛。 */
export const STAGE_FIT_MIN_SCALE = 0.5;
export const STAGE_FIT_MAX_SCALE = 0.8;
const STAGE_FIT_PADDING = 0.9;

/** bbox → 视口：尽量整段入镜、置中；k 夹在协作层区间（放不下就以 bbox 中心为准）。 */
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

/** 节点是否有可透析的工程资料（任务 id / 工具输入输出 / 模型）。 */
export function hasEngineeringData(node: CanvasNode): boolean {
  const m = node.metadata;
  return !!(m?.imageTaskId || m?.toolInput || m?.toolOutput || m?.model);
}

// ─────────────────────────────────────────── 连续转场（k 是唯一真源）

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Hermite smoothstep；e0 > e1 时反向（k 越小越接近 1）。 */
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

/** 聚合带：k 0.50 → 0.36（鸟瞰 LOD1 进入门槛 0.37 之前收束完成）。 */
export const GATHER_RANGE = { start: 0.5, end: 0.36 } as const;
/** 透析带：k 1.10 → 1.35（LOD3 进入门槛 1.15 落在带内，挂载时工程条已开始滑出）。 */
export const XRAY_RANGE = { start: 1.1, end: 1.35 } as const;
/**
 * 画布带：k 0.26 → 0.13。
 * 带起点略高于 LOD0 进入门槛（enterBoard 0.18）——换层瞬间 board≈0.43，画布层已成形近半，
 * 交接不落空（单挂载切换下把「穿空」压到最小）；带终点 0.13 在门槛之下，滚到底＝画布层全成形。
 */
export const BOARD_RANGE = { start: 0.26, end: 0.13 } as const;

function logRamp(from: number, to: number, k: number): number {
  // `+ 0`：把 0/负数 产生的 -0 正规化成 +0。
  return clamp01((Math.log(k) - Math.log(from)) / (Math.log(to) - Math.log(from))) + 0;
}

/** 相机飞行预设 easing：比 cubic 起步快，不在带前空转。 */
export function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;
}

/**
 * k → 转场系数。gather=1 ＝完全鸟瞰；xray=1 ＝完全透析；board=1 ＝完全画布层。
 * 三带互不重叠（board 在 gather 之下）。**k 仍是唯一真源**：画布层的转场不是新增状态机，
 * 只是同一函数多一条带——可被滚轮刷、可逆，与 gather/xray 同构。
 */
export function lodBlend(k: number): { gather: number; xray: number; board: number } {
  return {
    // 带内线性（对 log k）：平滑交给相机飞行的 easing＋带内减速；smoothstep 会把形变挤在带中段一闪而过。
    gather: logRamp(GATHER_RANGE.start, GATHER_RANGE.end, k),
    xray: logRamp(XRAY_RANGE.start, XRAY_RANGE.end, k),
    board: logRamp(BOARD_RANGE.start, BOARD_RANGE.end, k),
  };
}

/**
 * 聚合态下节点的视觉参数（g＝lodBlend.gather 原值）。
 * 节点的整段戏都在 phase A（g 0→0.6）演完，与徽章浮现同步：
 *   move（位移系数）/ scale 走 easeInOut；opacity 到 A 段后 45% 才开始淡——
 *   节点要「飞进徽章」而不是原地消失，否则中段会出现只剩两颗小徽章的空镜。
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
 * 相机插值：视口中心的世界点线性插值、k 走对数插值（每帧缩放比例恒定，
 * 不会「前段猛缩、后段拖」）；t=0/1 精确落在起讫。
 */
/** 形变带（log k 区间）在相机飞行中的时间权重：带内每单位 log k 花 BAND_TIME_WEIGHT 倍时间。 */
const BAND_TIME_WEIGHT = 6;
const WARP_SAMPLES = 96;

function inMorphBand(k: number): boolean {
  return (
    (k <= GATHER_RANGE.start && k >= GATHER_RANGE.end) ||
    (k >= XRAY_RANGE.start && k <= XRAY_RANGE.end) ||
    (k <= BOARD_RANGE.start && k >= BOARD_RANGE.end)
  );
}

/**
 * 相机飞行的「带内减速」时间重映射：飞行参数 u 对 log k 线性，但穿过聚合带/透析带时放慢，
 * 让形变占据飞行的大半时间，而不是在 easeInOut 最快的中段 100ms 内一闪而过（硬切感的根因）。
 * 回传 u∈[0,1]（给 interpolateViewport）；k 不变或未穿带时等于输入。
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
  // 锚点插值（不是世界中心线性插值）：放大时锚＝目的中心，它在萤幕上沿直线匀速走到视口中心；
  // 缩小时锚＝起点中心，它沿直线匀速离开中心。世界中心线性插值会让目标在萤幕上先偏后折（飞行抖一下）。
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

/** 以视口中心为锚缩放到 k（三段按钮的目标视口）。 */
export function zoomAroundCenter(vp: CanvasViewport, k: number, size: { width: number; height: number }): CanvasViewport {
  const cx = size.width / 2;
  const cy = size.height / 2;
  const wx = (cx - vp.x) / vp.k;
  const wy = (cy - vp.y) / vp.k;
  return { x: cx - wx * k, y: cy - wy * k, k };
}

/** 把某世界点置于视口中心、倍率 k。 */
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
 * 鸟瞰卡尺寸与安全区：右侧让出缩放控件轨（44px 宽＋右距 16＋呼吸 28），
 * 顶部让出画布顶部薄条（标题胶囊、预算条）。
 * 两种排法：安全区够宽＝一行四张（row，232×268）；不够（画布与对话并排的常态）＝2×2（grid）。
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

/** 鸟瞰卡槽位（萤幕座标）＝ hudLayout(...).slots。 */
export function hudSlots(size: { width: number; height: number }, count = CANVAS_STAGES.length): HudRect[] {
  return hudLayout(size, count).slots;
}

/**
 * 画布层（LOD0）卡尺寸与安全区：与鸟瞰同一套安全区尺度（右让缩放轨、上让标题条），
 * 但格子数不固定（1~N），故卡尺寸自适应：先试「一格一行」（最多列），放不下再折列。
 * 只给布局同款范式，不另造 CSS 布局体系。
 */
export const BOARD_CARD = {
  maxWidth: 300,
  ratio: 1.18,
  minWidth: 150,
  minHeight: 176,
  gap: 24,
  leftInset: 28,
  rightInset: 88,
  topInset: 64,
  headerSpace: 44,
} as const;

/** N 个画布格 → 槽位：优先一行铺开，超宽就折列；都塞不下退回单列（窄屏由容器滚动接管）。 */
export function boardLayout(size: { width: number; height: number }, count: number): { mode: HudLayoutMode; slots: HudRect[] } {
  const { gap, leftInset, rightInset, topInset, headerSpace, maxWidth, ratio, minWidth, minHeight } = BOARD_CARD;
  const areaWidth = Math.max(0, size.width - leftInset - rightInset);
  const areaHeight = Math.max(0, size.height - topInset - headerSpace);
  const n = Math.max(1, count);
  let cols = n;
  let rows = 1;
  let width = 0;
  let height = 0;
  for (let c = n; c >= 1; c--) {
    const r = Math.ceil(n / c);
    const cw = (areaWidth - gap * (c - 1)) / c;
    const ch = (areaHeight - gap * (r - 1)) / r;
    let w = Math.min(maxWidth, cw);
    let h = w * ratio;
    if (h > ch) {
      h = ch;
      w = h / ratio;
    }
    if (w < minWidth || h < minHeight) continue;
    cols = c;
    rows = r;
    width = w;
    height = h;
    break;
  }
  if (width <= 0) {
    cols = 1;
    rows = n;
    width = Math.max(minWidth, Math.min(maxWidth, areaWidth));
    height = minHeight;
  }
  const blockWidth = width * cols + gap * (cols - 1);
  const blockHeight = height * rows + gap * (rows - 1);
  const left = leftInset + Math.max(0, (areaWidth - blockWidth) / 2);
  const top = topInset + headerSpace + Math.max(0, (areaHeight - blockHeight) / 2);
  return {
    mode: cols >= n ? "row" : "grid",
    slots: Array.from({ length: n }, (_, i) => ({
      x: left + (i % cols) * (width + gap),
      y: top + Math.floor(i / cols) * (height + gap),
      width,
      height,
    })),
  };
}

/**
 * 透析落点：卡片置中于「面板左侧的可见区」（free＝视口座标的左右界；缺省＝整个视口的左 2/3），
 * k 取「卡宽占可见区 80%」与「不低于当前、至少 1」的较小者，下限 0.86（透析面板开著时宿主强制全透析，不依赖 LOD3）。
 * 窄画布（与对话并排）时面板会吃掉大半宽度，固定左 1/3 会让卡片被面板盖住。
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
 * 视口移动中的量化倍率（2026-10-01 效能）：按 6% 对数格取整。
 * 用途：会被整棵子树继承的反向补偿变数、memo 节点的 scale prop——移动中只在跨格时变，
 * 不必每帧重算样式/重渲染；误差 ≤3%（埠/把手/字级肉眼不可辨）。停手时呼叫端改用精确值。
 */
const SCALE_QUANT_STEP = Math.log(1.06);
export function quantizeScale(k: number): number {
  if (!(k > 0) || !Number.isFinite(k)) return 1;
  return Math.exp(Math.round(Math.log(k) / SCALE_QUANT_STEP) * SCALE_QUANT_STEP);
}
