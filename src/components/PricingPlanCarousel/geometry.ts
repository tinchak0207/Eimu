import type React from "react";

/** 卡面转角相对环角的压缩比。1 = 严格贴合圆周切线，但边卡会侧得几乎只剩一条线；
 *  0.82 是「还能看清是什么图」和「有空间纵深」之间的平衡（coverflow 的经典做法）。*/
const TILT = 0.82;
/** 环半径放大（模板廊同款，不改任何卡片宽高）。 */
export const RADIUS_SCALE = 4;
/** 转角上限。夹住之后没有一张卡面会翻过 90°，所以永远不会出现背面。 */
const TILT_MAX = 80;
/** z 位移的软化系数。纯几何的 R(cosφ−1) 会让后排缩得太小，0.78 收一收。 */
const DEPTH = 0.78;
/** 越远越往上抬，环看起来像朝纵深「拱」起，而不是平铺一排。 */
const LIFT = 26;
/** 整段滚动对应的转角：宽屏一圈，窄屏收敛到 200°（手机上主要靠横滑）。 */
/** 换档淡入时长（与 CSS .case-stage[data-switch] 配对）。 */
export const SWITCH_FADE_MS = 420;
/** 拖一张卡的宽度 ≈ 转过一格。 */
/** 拖过「卡宽 × 这个比例」= 转过一格。0.62 让一次自然的滑动就足够跨过一格。 */
export const DRAG_CARD_RATIO = 0.62;
/** 末速度 → 外推格数的增益。commit() 会把结果夹在 1 格以内，所以这里只影响
 *  「多快算一次甩动」，不影响「能翻几张」。 */
export const FLICK_GAIN = 0.34;
/** 连续输入停止多久算一段手势结束。太长会让落格显得迟疑，太短会把一次滚动切成两段。 */
export const SETTLE_MS = 130;
export const PANEL_MS = 120;

/* ── 弹簧（模板廊原样）── */
/** 输入进行中（滚动）：硬弹簧，几乎贴着手走。 */
export const SPRING_TRACK = { k: 340, ratio: 0.9 };
/** 放手后落格：软一档、阻尼比 0.74 → ~4% 的极轻 overshoot（「吻上去」的手感）。 */
export const SPRING_SETTLE = { k: 168, ratio: 0.74 };
/** 单帧最大积分步长。切标签页回来时 dt 可能是几百毫秒，直接积分会炸。 */
export const MAX_DT = 1 / 30;

/* ── 光照（模板廊原样）── */
const LIGHT_DEG = -13;
/** 玻璃厚度相对卡宽的比例，和 CSS 的 --case-bevel-w 必须同值。 */
const GLASS = 0.062;

/** 把角度收进 (−180, 180]，让 φ 始终表示「离正面多远」。 */
export function wrap(deg: number) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** 转到第 index 格时，选与当前值同侧最近的那个等价角 —— 永远走近路，不倒着绕一圈。 */
export function nearestAngleFor(index: number, current: number, step: number) {
  const base = index * step;
  return base + Math.round((current - base) / 360) * 360;
}

/** GLSL 的 smoothstep：两端导数为 0，所以是「平台 → 断崖 → 平台」而不是单调衰减。 */
function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 一张卡在环角 φ 处的完整位姿与光照（模板廊原样，一字未动）。 */
export function computeFrame(phi: number) {
  const rad = (phi * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const depth = (cos + 1) / 2; // 1 = 正对镜头，0 = 环的背面
  const tilt = Math.max(-TILT_MAX, Math.min(TILT_MAX, phi * TILT));
  const tiltRad = (tilt * Math.PI) / 180;

  /* 镜面对齐度：卡面法线与「视线⊕光源」的半角向量的夹角余弦。
     三次方是收窄高光的经典做法（Phong 的 shininess）；0.22 是环境光底噪。 */
  const align = Math.max(0, Math.cos(tiltRad - (LIGHT_DEG * Math.PI) / 180));
  const sheen = 0.22 + 0.78 * Math.pow(align, 3);

  /* ── 侧壁宽度：为什么是 tan 而不是 sin ──
     一块厚 T 的板转 θ 之后，投影轮廓宽 = W·cosθ + T·sinθ。 */
  const wall = Math.min(Math.abs(Math.tan(tiltRad)), 1.5) * GLASS;

  return {
    /** ×R */ xF: sin,
    /** ×R */ zF: DEPTH * (cos - 1),
    lift: (-LIFT * (1 - cos)) / 2,
    tilt,
    depth,
    /* smoothstep 给的是**平台加断崖**：0~30° 几乎不掉，45° 才开始让位，60° 准时交棒。 */
    opacity: 0.07 + 0.93 * smoothstep(0.34, 1, Math.max(0, 2 * depth - 1)),
    /* 模糊量化到 0.5px：filter 每次变化都要重新栅格化这一层。 */
    blur: Math.round((1 - depth) * 8) / 2,
    zIndex: Math.round(depth * 1000),
    sheen,
    /** ×卡宽：高光带随倾角横向扫过 */
    sheenXF: (tilt / TILT_MAX) * 0.55,
    /** ×卡宽：侧壁在卡面座标里的宽度。 */
    sideLF: tilt > 0 ? wall : 0,
    sideRF: tilt < 0 ? wall : 0,
    /* 迎光侧的棱线。 */
    rimL: tilt > 0 ? 0.20 + 0.42 * Math.abs(Math.sin(tiltRad)) : 0.12 * (1 - Math.abs(Math.sin(tiltRad))),
    rimR: tilt < 0 ? 0.14 + 0.28 * Math.abs(Math.sin(tiltRad)) : 0.07 * (1 - Math.abs(Math.sin(tiltRad))),
    /* ×卡宽：照片沉在玻璃背面，侧看时反向错开。 */
    parallaxF: -Math.sin(tiltRad) * GLASS * 0.25,
  };
}

/** θ=0 时第 index 张卡的位姿，用于首帧和无 JS 状态。 */
export function staticFrame(index: number, step: number) {
  const f = computeFrame(wrap(index * step));
  return {
    transform: `translate3d(calc(var(--case-radius) * ${f.xF.toFixed(4)}), ${f.lift.toFixed(2)}px, calc(var(--case-radius) * ${f.zF.toFixed(4)})) rotateY(${f.tilt.toFixed(2)}deg)`,
    opacity: f.opacity.toFixed(3),
    zIndex: f.zIndex,
    "--case-depth": f.depth.toFixed(3),
    "--case-blur": `${f.blur}px`,
    "--case-sheen": f.sheen.toFixed(3),
    "--case-sheen-x": `calc(var(--case-card-w) * ${f.sheenXF.toFixed(4)})`,
    "--case-side-l": `calc(var(--case-card-w) * ${f.sideLF.toFixed(4)})`,
    "--case-side-r": `calc(var(--case-card-w) * ${f.sideRF.toFixed(4)})`,
    "--case-rim-l": f.rimL.toFixed(3),
    "--case-rim-r": f.rimR.toFixed(3),
    "--case-parallax": `calc(var(--case-card-w) * ${f.parallaxF.toFixed(4)})`,
  } as React.CSSProperties;
}

export function rgbTriple(hex: string) {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`;
}
