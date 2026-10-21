import { useEffect, useLayoutEffect } from "react";
import type { AgentTemplate } from "@/lib/agent-templates";

export interface AgentTemplateCarouselProps {
  templates: AgentTemplate[];
  /** 第二参 = 卡面圆环选中的环节 indices（升序；全选 = 全部 index，上层 cropTemplate 零开销）。 */
  onUseTemplate: (template: AgentTemplate, selectedSteps: number[]) => void;
}
/** 卡面转角相对环角的压缩比。1 = 严格贴合圆周切线，但边卡会侧得几乎只剩一条线；
 *  0.82 是「还能看清是什么图」和「有空间纵深」之间的平衡（coverflow 的经典做法）。*/
export const TILT = 0.82;
/** 环半径放大（2026-08-25 暴君裁定：在 CaseShowcase 的 ×2 基础上再翻倍 = ×4），
    不改任何卡片宽高；远景的留白与中心卡的视觉重量因此更干净。 */
export const RADIUS_SCALE = 4;
/** 转角上限。夹住之后没有一张卡面会翻过 90°，所以永远不会出现背面。 */
export const TILT_MAX = 80;
/** z 位移的软化系数。纯几何的 R(cosφ−1) 会让后排缩得太小，0.78 收一收。 */
export const DEPTH = 0.78;
/** 越远越往上抬，环看起来像朝纵深「拱」起，而不是平铺一排。 */
export const LIFT = 26;
/** 整段滚动对应的转角：宽屏一圈，窄屏收敛到 200°（手机上主要靠横滑）。 */
export const SWEEP_WIDE = 360;
export const SWEEP_COMPACT = 200;
/** 拖一张卡的宽度 ≈ 转过一格。 */
/** 拖过「卡宽 × 这个比例」= 转一格。
 *  0.85 太重：手机上一张卡 340px，要拖 289px 才算一格，正常一次滑动只有 0.5 格，
 *  于是「滑了半张又弹回去」。0.62 让一次自然的滑动就足够跨过一格。 */
export const DRAG_CARD_RATIO = 0.62;
/** 末速度 → 外推格数的增益。commit() 会把结果夹在 1 格以内，所以这里只影响
 *  「多快算一次甩动」，不影响「能翻几张」。 */
export const FLICK_GAIN = 0.34;
/** 连续输入停止多久算一段手势结束。太长会让落格显得迟疑，太短会把一次滚动切成两段。 */
export const SETTLE_MS = 130;
export const PANEL_MS = 120;

/* ── 弹簧 ──
   原本这里是 `angle += (target − angle) * 0.2`。两个病灶：
   ① 指数逼近永远不会 overshoot，末端是「爬」到位再突然停 —— 这就是「停靠生硬」
      的数学原因，不是参数没调好。
   ② 每帧固定系数 = 收敛速度随刷新率变，120Hz 上动效快一倍。
   换成二阶弹簧（速度 + 劲度 + 阻尼，按 dt 积分）：甩动的速度能连续交接给弹簧，
   末端有极轻的 overshoot，且屏幕无关。 */
/** 输入进行中（滚动）：硬弹簧，几乎贴着手走。 */
export const SPRING_TRACK = { k: 340, ratio: 0.9 };
/** 放手后落格：软一档、阻尼比 0.74 → ~4% 的极轻 overshoot（「吻上去」的手感）。 */
export const SPRING_SETTLE = { k: 168, ratio: 0.74 };
/** 单帧最大积分步长。切标签页回来时 dt 可能是几百毫秒，直接积分会炸。 */
export const MAX_DT = 1 / 30;

/* ── 光照 ──
   光源固定在左前方。卡片转动时高光带扫过表面 —— 「光随转动移动」是大脑判定
   实体/贴图的首要线索，比任何静态材质都重要。 */
export const LIGHT_DEG = -13;
/** 玻璃厚度相对卡宽的比例，和 CSS 的 --case-bevel-w 必须同值。 */
export const GLASS = 0.062;

/** 把角度收进 (−180, 180]，让 φ 始终表示「离正面多远」。 */
export function wrap(deg: number) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** 转到第 index 格时，选与当前值同侧最近的那个等价角 —— 永远走近路，不倒着绕一圈。
 *  step 作参数传入：案例环的格数会随「用户投稿」合入变化，STEP 只在组件内成立。 */
export function nearestAngleFor(index: number, current: number, step: number) {
  const base = index * step;
  return base + Math.round((current - base) / 360) * 360;
}

/** GLSL 的 smoothstep：两端导数为 0，所以是「平台 → 断崖 → 平台」而不是单调衰减。 */
export function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 一张卡在环角 φ 处的完整位姿与光照。
 *  几何量返回的是「R 的倍率」和「卡宽的倍率」而不是像素 —— 因为这一份公式要同时
 *  服务两个调用方：paint() 乘上实测 R，SSR 的 staticFrame() 交给 CSS calc() 去解。
 *  以前这两处各抄一份，必然分叉。 */
export function computeFrame(phi: number) {
  const rad = (phi * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const depth = (cos + 1) / 2; // 1 = 正对镜头，0 = 环的背面
  const tilt = Math.max(-TILT_MAX, Math.min(TILT_MAX, phi * TILT));
  const tiltRad = (tilt * Math.PI) / 180;

  /* 镜面对齐度：卡面法线与「视线⊕光源」的半角向量的夹角余弦。
     三次方是收窄高光的经典做法（Phong 的 shininess）；0.22 是环境光底噪，
     否则转到侧面的卡会黑成一片死板。 */
  const align = Math.max(0, Math.cos(tiltRad - (LIGHT_DEG * Math.PI) / 180));
  const sheen = 0.22 + 0.78 * Math.pow(align, 3);

  /* ── 侧壁宽度：为什么是 tan 而不是 sin ──
     一块厚 T 的板转 θ 之后，投影轮廓宽 = W·cosθ + T·sinθ。也就是侧面出现在
     **正面投影之外**，轮廓因此变宽。上一版把侧面画在卡面「里面」（scaleX），
     轮廓永远等于正面投影 —— 那正是「从侧面看还是像一张纸」的数学原因，
     不是渐层调得不够好。

     这条带子和卡面一起吃了 rotateY 的 cosθ 压缩，所以要在卡面座标里给
     T·tanθ，投影出来才刚好是 T·sinθ。tan 在 θ→90° 发散，夹在 1.5（≈56°）:
     再侧的卡不透明度只剩 0.07，本来就看不见。 */
  const wall = Math.min(Math.abs(Math.tan(tiltRad)), 1.5) * GLASS;

  return {
    /** ×R */ xF: sin,
    /** ×R */ zF: DEPTH * (cos - 1),
    lift: (-LIFT * (1 - cos)) / 2,
    tilt,
    depth,
    /* 静止时：正面 1.0、相邻 ±60° 落在 0.21、背面 0.07 —— 侧卡不抢镜头（原始需求）。
       但 pow(depth, 7) 在 30° 就掉到 0.64：拖动途中两张卡同时半透明叠在浅色背景上
       → 整片发灰，正是使用者截图里那张惨白的卡。smoothstep 给的是**平台加断崖**，
       0~30° 几乎不掉（30° → 0.90），45° 才开始让位，60° 准时交棒。 */
    opacity: 0.07 + 0.93 * smoothstep(0.34, 1, Math.max(0, 2 * depth - 1)),
    /* 模糊量化到 0.5px：filter 每次变化都要重新栅格化这一层。 */
    blur: Math.round((1 - depth) * 8) / 2,
    zIndex: Math.round(depth * 1000),
    sheen,
    /** ×卡宽：高光带随倾角横向扫过 */
    sheenXF: (tilt / TILT_MAX) * 0.55,
    /** ×卡宽：侧壁在卡面座标里的宽度。rotateY(+θ) 时右缘转离视线 → 露出左侧面。 */
    sideLF: tilt > 0 ? wall : 0,
    sideRF: tilt < 0 ? wall : 0,
    /* 迎光侧的棱线。左切面同时是迎光侧，所以左棱更亮。 */
    rimL: tilt > 0 ? 0.20 + 0.42 * Math.abs(Math.sin(tiltRad)) : 0.12 * (1 - Math.abs(Math.sin(tiltRad))),
    rimR: tilt < 0 ? 0.14 + 0.28 * Math.abs(Math.sin(tiltRad)) : 0.07 * (1 - Math.abs(Math.sin(tiltRad))),
    /* ×卡宽：照片沉在玻璃背面，侧看时反向错开。错开量必须小于 .case-photo 的
       scale 余量（1.075 → 每侧 3.75%），否则侧看时照片边缘会露出容器底。 */
    parallaxF: -Math.sin(tiltRad) * GLASS * 0.25,
  };
}

/** θ=0 时第 index 张卡的位姿，用于首帧和无 JS 状态。
 *  没有这一步，六张卡会先叠在正中央闪一帧，水合后才散开。
 *  step 作参数传入：用户投稿案例合入后格数变化，STATIC_FRAMES 随 cases 重建。 */
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

export const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

