"use client";

import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, Copy, Sparkles } from "lucide-react";
import { CaseGlassWebGL } from "@/components/CaseGlassWebGL";
import { SHOWCASE_CASES, type ShowcaseCase } from "@/lib/showcase-cases";
import { mergeShowcaseCases, readUserShowcaseCases } from "@/lib/showcase-user-cases";
import { commitSteps, detent, undetent } from "@/lib/carousel-detent";
import type { StylePreset } from "@/lib/prompt-enhancer";
import { cn } from "@/lib/utils";
import "./case-showcase.css";

interface CaseShowcaseProps {
  onUsePrompt: (prompt: string, style: StylePreset) => void;
  /**
   * 「用此工作流打开」：把案例携带的完整配方（ShowcaseRecipe）交给上层，
   * 由上层走 workflow-recall 通道灌入专业工作台。案例没有配方时不渲染按钮。
   */
  onOpenWorkflow?: (item: ShowcaseCase) => void;
}
/** 卡面转角相对环角的压缩比。1 = 严格贴合圆周切线，但边卡会侧得几乎只剩一条线；
 *  0.82 是「还能看清是什么图」和「有空间纵深」之间的平衡（coverflow 的经典做法）。*/
const TILT = 0.82;
/** 環半徑放大，不改任何卡片寬高；遠景的留白與中心卡的視覺重量因此更乾淨。 */
const RADIUS_SCALE = 2;
/** 转角上限。夹住之后没有一张卡面会翻过 90°，所以永远不会出现背面。 */
const TILT_MAX = 80;
/** z 位移的软化系数。纯几何的 R(cosφ−1) 会让后排缩得太小，0.78 收一收。 */
const DEPTH = 0.78;
/** 越远越往上抬，环看起来像朝纵深「拱」起，而不是平铺一排。 */
const LIFT = 26;
/** 整段滚动对应的转角：宽屏一圈，窄屏收敛到 200°（手机上主要靠横滑）。 */
const SWEEP_WIDE = 360;
const SWEEP_COMPACT = 200;
/** 拖一张卡的宽度 ≈ 转过一格。 */
/** 拖过「卡宽 × 这个比例」= 转一格。
 *  0.85 太重：手机上一张卡 340px，要拖 289px 才算一格，正常一次滑动只有 0.5 格，
 *  于是「滑了半张又弹回去」。0.62 让一次自然的滑动就足够跨过一格。 */
const DRAG_CARD_RATIO = 0.62;
/** 末速度 → 外推格数的增益。commit() 会把结果夹在 1 格以内，所以这里只影响
 *  「多快算一次甩动」，不影响「能翻几张」。 */
const FLICK_GAIN = 0.34;
/** 连续输入停止多久算一段手势结束。太长会让落格显得迟疑，太短会把一次滚动切成两段。 */
const SETTLE_MS = 130;
const PANEL_MS = 120;

/* ── 弹簧 ──
   原本这里是 `angle += (target − angle) * 0.2`。两个病灶：
   ① 指数逼近永远不会 overshoot，末端是「爬」到位再突然停 —— 这就是「停靠生硬」
      的数学原因，不是参数没调好。
   ② 每帧固定系数 = 收敛速度随刷新率变，120Hz 上动效快一倍。
   换成二阶弹簧（速度 + 劲度 + 阻尼，按 dt 积分）：甩动的速度能连续交接给弹簧，
   末端有极轻的 overshoot，且屏幕无关。 */
/** 输入进行中（滚动）：硬弹簧，几乎贴着手走。 */
const SPRING_TRACK = { k: 340, ratio: 0.9 };
/** 放手后落格：软一档、阻尼比 0.74 → ~4% 的极轻 overshoot（「吻上去」的手感）。 */
const SPRING_SETTLE = { k: 168, ratio: 0.74 };
/** 单帧最大积分步长。切标签页回来时 dt 可能是几百毫秒，直接积分会炸。 */
const MAX_DT = 1 / 30;

/* ── 光照 ──
   光源固定在左前方。卡片转动时高光带扫过表面 —— 「光随转动移动」是大脑判定
   实体/贴图的首要线索，比任何静态材质都重要。 */
const LIGHT_DEG = -13;
/** 玻璃厚度相对卡宽的比例，和 CSS 的 --case-bevel-w 必须同值。 */
const GLASS = 0.062;

/** 把角度收进 (−180, 180]，让 φ 始终表示「离正面多远」。 */
function wrap(deg: number) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** 转到第 index 格时，选与当前值同侧最近的那个等价角 —— 永远走近路，不倒着绕一圈。
 *  step 作参数传入：案例环的格数会随「用户投稿」合入变化，STEP 只在组件内成立。 */
function nearestAngleFor(index: number, current: number, step: number) {
  const base = index * step;
  return base + Math.round((current - base) / 360) * 360;
}

/** GLSL 的 smoothstep：兩端導數為 0，所以是「平台 → 斷崖 → 平台」而不是單調衰減。 */
function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 一张卡在环角 φ 处的完整位姿与光照。
 *  几何量返回的是「R 的倍率」和「卡宽的倍率」而不是像素 —— 因为这一份公式要同时
 *  服务两个调用方：paint() 乘上实测 R，SSR 的 staticFrame() 交给 CSS calc() 去解。
 *  以前这两处各抄一份，必然分叉。 */
function computeFrame(phi: number) {
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

  /* ── 側壁寬度：為什麼是 tan 而不是 sin ──
     一塊厚 T 的板轉 θ 之後，投影輪廓寬 = W·cosθ + T·sinθ。也就是側面出現在
     **正面投影之外**，輪廓因此變寬。上一版把側面畫在卡面「裡面」（scaleX），
     輪廓永遠等於正面投影 —— 那正是「從側面看還是像一張紙」的數學原因，
     不是漸層調得不夠好。

     這條帶子和卡面一起吃了 rotateY 的 cosθ 壓縮，所以要在卡面座標裡給
     T·tanθ，投影出來才剛好是 T·sinθ。tan 在 θ→90° 發散，夾在 1.5（≈56°）:
     再側的卡不透明度只剩 0.07，本來就看不見。 */
  const wall = Math.min(Math.abs(Math.tan(tiltRad)), 1.5) * GLASS;

  return {
    /** ×R */ xF: sin,
    /** ×R */ zF: DEPTH * (cos - 1),
    lift: (-LIFT * (1 - cos)) / 2,
    tilt,
    depth,
    /* 靜止時：正面 1.0、相鄰 ±60° 落在 0.21、背面 0.07 —— 側卡不搶鏡頭（原始需求）。
       但 pow(depth, 7) 在 30° 就掉到 0.64：拖動途中兩張卡同時半透明疊在淺色背景上
       → 整片發灰，正是使用者截圖裡那張慘白的卡。smoothstep 給的是**平台加斷崖**，
       0~30° 幾乎不掉（30° → 0.90），45° 才開始讓位，60° 準時交棒。 */
    opacity: 0.07 + 0.93 * smoothstep(0.34, 1, Math.max(0, 2 * depth - 1)),
    /* 模糊量化到 0.5px：filter 每次变化都要重新栅格化这一层。 */
    blur: Math.round((1 - depth) * 8) / 2,
    zIndex: Math.round(depth * 1000),
    sheen,
    /** ×卡宽：高光带随倾角横向扫过 */
    sheenXF: (tilt / TILT_MAX) * 0.55,
    /** ×卡宽：側壁在卡面座標裡的寬度。rotateY(+θ) 时右缘转离视线 → 露出左侧面。 */
    sideLF: tilt > 0 ? wall : 0,
    sideRF: tilt < 0 ? wall : 0,
    /* 迎光侧的棱线。左切面同时是迎光侧，所以左棱更亮。 */
    rimL: tilt > 0 ? 0.20 + 0.42 * Math.abs(Math.sin(tiltRad)) : 0.12 * (1 - Math.abs(Math.sin(tiltRad))),
    rimR: tilt < 0 ? 0.14 + 0.28 * Math.abs(Math.sin(tiltRad)) : 0.07 * (1 - Math.abs(Math.sin(tiltRad))),
    /* ×卡宽：照片沉在玻璃背面，侧看时反向错开。錯開量必須小於 .case-photo 的
       scale 餘量（1.075 → 每側 3.75%），否則側看時照片邊緣會露出容器底。 */
    parallaxF: -Math.sin(tiltRad) * GLASS * 0.25,
  };
}

/** θ=0 时第 index 张卡的位姿，用于首帧和无 JS 状态。
 *  没有这一步，六张卡会先叠在正中央闪一帧，水合后才散开。
 *  step 作参数传入：用户投稿案例合入后格数变化，STATIC_FRAMES 随 cases 重建。 */
function staticFrame(index: number, step: number) {
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



function rgbTriple(hex: string) {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`;
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** 案例提示词明文（PromptHero 式可读可复制）。随 <details key> 每换案例重挂，复制态自动复位。 */
function CasePromptReveal({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板不可用（非安全上下文/权限拒绝）：保持按钮原样，不抛错。
    }
  };
  return (
    <div className="mt-2 flex items-start justify-between gap-3">
      <p className="min-w-0 break-words text-[rgba(0,0,0,0.66)]">{prompt}</p>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? "已复制提示词" : "复制提示词"}
        className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-[rgba(0,122,255,0.10)] px-3 text-ios-footnote font-medium text-[#007AFF] transition-colors duration-200 hover:bg-[rgba(0,122,255,0.16)]"
      >
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

export function CaseShowcase({ onUsePrompt, onOpenWorkflow }: CaseShowcaseProps) {
  /* 案例环数据：官方六例 + 本机发布的「用户投稿」案例（showcase-user-cases）。
     用户案例合入后每格角度改变，由下方的 reset effect 把环拉回第一张。 */
  const [cases, setCases] = useState<ShowcaseCase[]>(SHOWCASE_CASES);
  const COUNT = cases.length;
  const STEP = 360 / COUNT;
  /* 静态帧（首帧/无 JS）：cases 不变时引用稳定，React 的 style diff 直接跳过，
     不会覆写 paint() 每帧写进 node.style 的那份值。 */
  const STATIC_FRAMES = useMemo(
    () => cases.map((_, index) => staticFrame(index, STEP)),
    [cases, STEP],
  );

  const sectionRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const glowRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);

  /* 每張卡的 GL draw()。玻璃是靜物，但玻璃上的**光**要跟著轉動走，所以由這個
     本來就在跑的手勢迴圈推它重畫 —— 事件驅動，GL 那邊不自己開 rAF。 */
  const glDrawRefs = useRef<Array<((tiltDeg: number) => void) | null>>([]);
  const glTiltRefs = useRef<number[]>([]);

  /* 环角只活在 ref 里 —— 每帧 setState 会把 6 张卡的 React 树重算 60 次/秒。
     rAF 直接写 DOM style，React 只在「正面换人」时才 render。 */
  const targetRef = useRef(0);
  const angleRef = useRef(0);
  const paintedRef = useRef(Number.NaN);
  const rafRef = useRef(0);
  const frontRef = useRef(0);

  /* 磁力需要三个角度而不是一个，混用就会得到「不够 sticky」：
       rawRef    —— 手指/滚轮真实累加的原始角度，**不带** detent 形变。
                    落格判定必须用它：形变过的角度会低报用户实际走了多远。
       angleRef  —— 屏幕上这一帧的角度（detent 拧过 / 弹簧积分出来的）。
       originRef —— 本次手势起点所在的卡位。落格 = origin + 走过的格数。 */
  const rawRef = useRef(0);
  const originRef = useRef(0);

  /* 二阶弹簧的状态：角速度 + 当前劲度/阻尼档位 + 上一帧时刻。
     dt 积分而不是每帧固定 lerp —— 120Hz 屏和 60Hz 屏必须跑出同一条曲线。 */
  const velRef = useRef(0);
  const springRef = useRef(SPRING_SETTLE);
  const lastTsRef = useRef(0);

  const engagedRef = useRef(false);
  const lastScrollRef = useRef(0);
  const degPerPxRef = useRef(0.3);
  const radiusRef = useRef(812);
  const cardWRef = useRef(520);
  const dragDegPerPxRef = useRef(0.14);
  const reduceRef = useRef(false);

  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const dragXRef = useRef(0);
  const velocityRef = useRef(0);
  const lastMoveAtRef = useRef(0);

  const [front, setFront] = useState(0);
  const [panel, setPanel] = useState(0);

  /* 六張卡都要走 shader，否則正面是有機輪廓、側卡是矩形 <img>，切換時輪廓會
     突然「變形」。但六個 program 一起編譯會壓在首屏上，所以正面先點火，其餘
     五張等到瀏覽器空閒再補 —— 使用者看到的第一張永遠是玻璃。 */
  const [glassAll, setGlassAll] = useState(false);
  useEffect(() => {
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number })
      .requestIdleCallback;
    if (idle) {
      const id = idle(() => setGlassAll(true));
      return () => (window as Window & { cancelIdleCallback?: (h: number) => void })
        .cancelIdleCallback?.(id);
    }
    const timer = setTimeout(() => setGlassAll(true), 900);
    return () => clearTimeout(timer);
  }, []);

  /** 卡片尺寸、环半径、滚动灵敏度全从舞台实测宽度推出来，写成 CSS 变量。 */
  const measure = useCallback(() => {
    const stage = stageRef.current;
    const section = sectionRef.current;
    if (!stage) return;

    const stageWidth = stage.clientWidth || 1024;
    const compact = window.matchMedia("(max-width: 767px)").matches;
    const cardW = compact
      ? Math.min(stageWidth * 0.78, 340)
      : Math.min(Math.max(stageWidth * 0.42, 300), 580);
    const cardH = Math.round(cardW * 0.75);
    const radius = cardW * (compact ? 0.84 : 0.78) * RADIUS_SCALE;

    radiusRef.current = radius;
    cardWRef.current = cardW;
    dragDegPerPxRef.current = STEP / (cardW * DRAG_CARD_RATIO);

    stage.style.setProperty("--case-card-w", `${Math.round(cardW)}px`);
    stage.style.setProperty("--case-card-h", `${cardH}px`);
    stage.style.setProperty("--case-radius", `${Math.round(radius)}px`);
    stage.style.height = `${Math.round(cardH * 1.2)}px`;

    const travel = (section?.offsetHeight ?? 640) + window.innerHeight;
    degPerPxRef.current = (compact ? SWEEP_COMPACT : SWEEP_WIDE) / Math.max(travel, 1);
  }, [STEP]);

  /** 每帧唯一的写 DOM 处。React 不参与：它只在「正面换人」时 render 一次。 */
  const paint = useCallback((angle: number) => {
    if (angle === paintedRef.current) return;
    paintedRef.current = angle;

    const radius = radiusRef.current;
    const cardW = cardWRef.current;
    let frontIndex = 0;
    let frontDepth = -1;

    for (let i = 0; i < COUNT; i += 1) {
      const node = cardRefs.current[i];
      if (!node) continue;

      const f = computeFrame(wrap(i * STEP - angle));
      const s = node.style;

      s.transform = `translate3d(${(radius * f.xF).toFixed(2)}px, ${f.lift.toFixed(2)}px, ${(radius * f.zF).toFixed(2)}px) rotateY(${f.tilt.toFixed(2)}deg)`;
      s.opacity = f.opacity.toFixed(3);
      /* 景深模糊移到 .case-face（正面那一疊）。留在 .case-slab 上的話，側壁作為
         溢出子節點會被 filter 的作用範圍裁掉 —— 而側壁是厚度的唯一證據。 */
      s.zIndex = String(f.zIndex);
      s.pointerEvents = f.depth > 0.4 ? "auto" : "none";
      s.setProperty("--case-depth", f.depth.toFixed(3));
      s.setProperty("--case-blur", `${f.blur}px`);
      /* 光照四件套。这些是「光随转动移动」的实现 —— 静态材质做不出实体感。 */
      s.setProperty("--case-sheen", f.sheen.toFixed(3));
      s.setProperty("--case-sheen-x", `${(cardW * f.sheenXF).toFixed(2)}px`);
      s.setProperty("--case-side-l", `${(cardW * f.sideLF).toFixed(2)}px`);
      s.setProperty("--case-side-r", `${(cardW * f.sideRF).toFixed(2)}px`);
      s.setProperty("--case-rim-l", f.rimL.toFixed(3));
      s.setProperty("--case-rim-r", f.rimR.toFixed(3));
      s.setProperty("--case-parallax", `${(cardW * f.parallaxF).toFixed(2)}px`);

      /* 把傾角推進 shader：高光滑過玻璃、受光側的邊變厚，都是這個值在驅動。
         門檻 0.4° + 只重畫看得見的兩三張（depth > 0.5）—— 拖動時 GPU 上的
         實際負擔是一到兩張卡，不是六張。 */
      const glDraw = glDrawRefs.current[i];
      if (glDraw && f.depth > 0.5 && Math.abs(f.tilt - (glTiltRefs.current[i] ?? 999)) > 0.4) {
        glTiltRefs.current[i] = f.tilt;
        glDraw(f.tilt);
      }

      if (f.depth > frontDepth) {
        frontDepth = f.depth;
        frontIndex = i;
      }
    }

    for (let i = 0; i < COUNT; i += 1) {
      const node = cardRefs.current[i];
      const flag = i === frontIndex ? "true" : "false";
      if (node && node.dataset.front !== flag) node.dataset.front = flag;
    }

    if (frontIndex !== frontRef.current) {
      frontRef.current = frontIndex;
      setFront(frontIndex);
      glowRef.current?.style.setProperty("--case-glow-rgb", rgbTriple(cases[frontIndex].glow));
      /* 面板文案比圆点晚一步落地：快速转两圈时不该把六个标题全闪一遍。 */
      if (panelTimerRef.current) clearTimeout(panelTimerRef.current);
      panelTimerRef.current = setTimeout(() => setPanel(frontIndex), PANEL_MS);
    }
  }, [cases]);

  /* ── 弹簧积分器 ──
     ẍ = −k(x−target) − c·ẋ，c = 2ζ√k。ζ<1 让末端有极轻的 overshoot，
     这是「吻上去」和「爬到位再突然停」的全部区别。dt 积分 → 和刷新率解耦。 */
  const tick = useCallback(() => {
    rafRef.current = 0;

    if (reduceRef.current) {
      angleRef.current = targetRef.current;
      velRef.current = 0;
      paint(targetRef.current);
      return;
    }

    const now = performance.now();
    const dt = Math.min((now - lastTsRef.current) / 1000, MAX_DT);
    lastTsRef.current = now;

    const { k, ratio } = springRef.current;
    const c = 2 * ratio * Math.sqrt(k);
    const target = targetRef.current;
    let angle = angleRef.current;
    let vel = velRef.current;

    /* 一次最多追一圈：整段被飞快滚过时不该空转好几圈补进度。 */
    if (Math.abs(target - angle) > 360) angle = target - Math.sign(target - angle) * 360;

    vel += (-k * (angle - target) - c * vel) * dt;
    angle += vel * dt;

    /* 位移和速度必须同时进阈值才算静止 —— 只看位移会把 overshoot 提前截断。 */
    if (Math.abs(target - angle) < 0.02 && Math.abs(vel) < 0.6) {
      angleRef.current = target;
      velRef.current = 0;
      paint(target);
      return;
    }

    angleRef.current = angle;
    velRef.current = vel;
    paint(angle);
    rafRef.current = requestAnimationFrame(tick);
  }, [paint]);

  const schedule = useCallback(() => {
    if (rafRef.current) return;
    lastTsRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  /** 落格：按「从手势起点走了几格」决定，而不是 round 到最近的一格。
   *  round 到最近 = 滑了 0.4 张会弹回原位（等于白滑），也允许 flick 凭空多翻一张。
   *  两种症状用户都碰到了，根因是同一个判定。 */
  const commit = useCallback((flickSteps: number) => {
    const travel = (rawRef.current - originRef.current) / STEP;
    const steps = commitSteps(travel, flickSteps);
    const landing = originRef.current + steps * STEP;
    rawRef.current = landing;
    targetRef.current = landing;
    springRef.current = SPRING_SETTLE;
    schedule();
  }, [schedule, STEP]);

  /** 连续输入（滚动 / 触控板横扫）：接收增量。
   *  原始角度累加进 rawRef，屏幕上呈现的是 detent() 拧过的版本 —— 环在卡位附近发黏、
   *  格间快速掠过，这就是「磁力」的可见部分。停手 SETTLE_MS 后按手势落格。 */
  const drive = useCallback((deltaDeg: number) => {
    // 一段滚动 = 一次手势。settle 定时器在，说明还在同一段里，起点不重取。
    if (!settleTimerRef.current) {
      originRef.current = Math.round(rawRef.current / STEP) * STEP;
    }
    rawRef.current += deltaDeg;
    targetRef.current = detent(rawRef.current, STEP);
    springRef.current = SPRING_TRACK;
    schedule();
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      commit(0); // 滚动的惯性已经体现在走过的距离里，不再额外外推
    }, SETTLE_MS);
  }, [schedule, commit, STEP]);

  /** 离散跳转（箭头 / 圆点 / 键盘）：软弹簧，末端极轻回弹。 */
  const snap = useCallback((value: number) => {
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    rawRef.current = value;
    originRef.current = Math.round(value / STEP) * STEP;
    targetRef.current = value;
    springRef.current = SPRING_SETTLE;
    schedule();
  }, [schedule, STEP]);

  /** 拖曳期间手指就是位置本身：不过弹簧、不排 rAF，直接写角度立刻画。
   *  这是「跟手延迟」的解 —— 原本拖曳也要过一遍插值，手和卡永远隔着 ~80ms。
   *  但画出去的是 detent() 版本：手指能摸到卡位的阻力。 */
  const dragBy = useCallback((deltaDeg: number) => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    velRef.current = 0;
    rawRef.current += deltaDeg;
    const warped = detent(rawRef.current, STEP);
    angleRef.current = warped;
    targetRef.current = warped;
    paint(warped);
  }, [paint, STEP]);

  const goTo = useCallback((index: number) => {
    snap(nearestAngleFor(index, targetRef.current, STEP));
  }, [snap]);

  const step = useCallback((dir: number) => {
    snap(Math.round(targetRef.current / STEP) * STEP + dir * STEP);
  }, [snap, STEP]);

  useIsoLayoutEffect(() => {
    measure();
    glowRef.current?.style.setProperty("--case-glow-rgb", rgbTriple(cases[0].glow));
    paintedRef.current = Number.NaN;
    paint(angleRef.current);

    const stage = stageRef.current;
    const observer = new ResizeObserver(() => {
      measure();
      paintedRef.current = Number.NaN;
      paint(angleRef.current);
    });
    if (stage) observer.observe(stage);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, paint]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      reduceRef.current = query.matches;
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  /* 用户投稿案例合入（仅本机 localStorage）：历史里「发布为案例」后，回到首页即进入案例环。 */
  useEffect(() => {
    const user = readUserShowcaseCases();
    if (user.length) setCases(mergeShowcaseCases(SHOWCASE_CASES, user));
  }, []);

  /* 案例数量变化后每格角度改变：环回到第一张，避免旧角度在新格距下错位落格。 */
  useEffect(() => {
    if (cases === SHOWCASE_CASES) return;
    targetRef.current = 0;
    angleRef.current = 0;
    rawRef.current = 0;
    originRef.current = 0;
    velRef.current = 0;
    paintedRef.current = Number.NaN;
    if (frontRef.current !== 0) {
      frontRef.current = 0;
      setFront(0);
      setPanel(0);
    }
    glowRef.current?.style.setProperty("--case-glow-rgb", rgbTriple(cases[0].glow));
    paint(0);
  }, [cases, paint]);

  /* 只在这一段进入视野时累计滚动量；离开视野后滚动与它无关。 */
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        engagedRef.current = entry.isIntersecting;
        if (entry.isIntersecting) lastScrollRef.current = window.scrollY;
      },
      { rootMargin: "-12% 0px -12% 0px" },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  /* 滚动驱动旋转 —— 注意是 passive 监听、纯读取 scrollY 的增量。
     全程不 preventDefault 纵向滚动：页面永远滚得动，环只是顺带转起来。 */
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      const delta = y - lastScrollRef.current;
      lastScrollRef.current = y;
      if (!engagedRef.current || draggingRef.current || reduceRef.current) return;
      drive(delta * degPerPxRef.current);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [drive]);

  /* 触控板横扫 / Shift+滚轮。React 的 onWheel 是 passive 注册，preventDefault
     会被忽略，所以必须手动挂 { passive: false }。且只有横向分量占优时才接管，
     纵向一律放行。 */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      drive(event.deltaX * dragDegPerPxRef.current);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [drive]);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    if (panelTimerRef.current) clearTimeout(panelTimerRef.current);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    draggingRef.current = true;
    movedRef.current = false;
    dragXRef.current = event.clientX;
    velocityRef.current = 0;
    lastMoveAtRef.current = event.timeStamp;

    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    /* 半空中接手：屏幕上是 detent() 拧过的角度，拖曳累加的是原始角度。
       不换算回去，手指一按就会跳一下。 */
    rawRef.current = undetent(angleRef.current, STEP);
    originRef.current = Math.round(rawRef.current / STEP) * STEP;

    stageRef.current?.setAttribute("data-dragging", "true");
    stageRef.current?.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const dx = event.clientX - dragXRef.current;
    if (Math.abs(dx) < 1) return;
    if (Math.abs(dx) > 3) movedRef.current = true;
    dragXRef.current = event.clientX;

    const dt = Math.max(event.timeStamp - lastMoveAtRef.current, 1);
    lastMoveAtRef.current = event.timeStamp;
    velocityRef.current = dx / dt;

    /* 内容往左拖 = 下一张转到正面，所以取 −dx。
       拖曳期间不走弹簧：手指就是位置本身，任何插值都是延迟。 */
    dragBy(-dx * dragDegPerPxRef.current);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    stageRef.current?.removeAttribute("data-dragging");
    if (stageRef.current?.hasPointerCapture(event.pointerId)) {
      stageRef.current.releasePointerCapture(event.pointerId);
    }

    /* 末速度换算成「格/秒」再乘增益 —— commit() 会把它夹在 1 格以内。
       甩动只表达「方向 + 我确实想翻」，翻几张由真实拖过的距离说话。 */
    const idle = event.timeStamp - lastMoveAtRef.current > 90;
    const flickSteps = idle
      ? 0
      : (-velocityRef.current * 1000 * dragDegPerPxRef.current * FLICK_GAIN) / STEP;
    commit(flickSteps);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      goTo(0);
    } else if (event.key === "End") {
      event.preventDefault();
      goTo(COUNT - 1);
    }
  };

  /* 点边卡 = 把它转到正面（coverflow 的通用预期）。正面那张不接管点击 ——
     否则用户只是想看大图，页面却跳到顶部。带入生成器由下方面板的按钮负责。 */
  const onCardClick = (index: number) => {
    if (movedRef.current || index === front) return;
    goTo(index);
  };

  const active = cases[panel];

  return (
    <section className="case-viewport page-shell pb-24" aria-labelledby="case-showcase-title" ref={sectionRef}>
      <div className="mx-auto mb-8 max-w-[40rem] text-center sm:mb-10">
        <div className="mb-3 inline-flex min-h-8 items-center gap-1.5 rounded-full bg-[rgba(0,122,255,0.09)] px-3.5 text-ios-caption1 font-semibold text-[#007AFF]">
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          精品案例库
        </div>
        <h2 id="case-showcase-title" className="mx-auto max-w-[32rem] text-ios-title1 font-semibold text-[rgba(0,0,0,0.88)] sm:text-ios-largetitle" style={{ wordBreak: 'keep-all' }}>
          看见第一张，下一步自然清晰。
        </h2>
        <p className="mx-auto mt-3 max-w-[34rem] text-ios-callout text-[rgba(0,0,0,0.54)]">
          每个案例，都是一个创意起点。滚动、拖动或轻轻<br />滑动，找到方向，再换成你的产品与故事。
        </p>
      </div>

      <div
        ref={stageRef}
        className="case-stage"
        role="group"
        aria-roledescription="轮播"
        aria-label={`精品案例，共 ${COUNT} 张`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <div ref={glowRef} className="case-glow" aria-hidden="true" />
        {cases.map((item, index) => (
          <div
            key={item.id}
            ref={(node) => {
              cardRefs.current[index] = node;
            }}
            className="case-slab"
            style={STATIC_FRAMES[index]}
            onClick={() => onCardClick(index)}
          >
            {/* ── 側壁：厚度的唯一真證據 ──
                必須是 .case-face 的**兄弟**而不是子節點：它要伸出正面之外才能
                把輪廓撐寬（一塊厚 T 的板轉 θ，投影寬 = W·cosθ + T·sinθ），
                而 .case-face 帶 filter，filter 會把溢出的子節點裁掉。 */}
            <div className="case-side case-side-l" aria-hidden="true" />
            <div className="case-side case-side-r" aria-hidden="true" />

            {/* ── 液態玻璃層：整張卡由 shader 成像 ──
                必須是 .case-slab 的**直接子節點**，兩個理由：
                ① 它的輪廓要外凸、起伏、伸出側壁，全都落在卡框之外，掛進帶
                   filter 的 .case-face 會被裁成直邊 —— 那就又是圓角矩形。
                ② 元件靠 host.parentElement 讀卡片的版面尺寸與四角半徑。
                就緒後它會給 .case-slab 掛上 data-glass="on"，把下面那一疊
                矩形的 HTML 圖層收掉。 */}
            {/* 用户投稿的成片来自任意图床/历史 URL：跨域纹理会污染 WebGL 上下文，
                只走 HTML 图层；官方精选才上 GL 折射。 */}
            {item.image && item.source !== "community" && (
              <CaseGlassWebGL
                enabled={index === front || glassAll}
                imageSrc={item.image}
                seed={index * 1.7 + 0.35}
                registerDraw={(draw) => {
                  glDrawRefs.current[index] = draw;
                }}
              />
            )}

            {/* 正面那一疊。GL 缺席時它就是全部；GL 就緒後整疊隱形。 */}
            <div className="case-face">
              <div className="case-media">
                <div className="case-photo">
                  {item.image ? (
                    item.source === "community" ? (
                      /* 投稿 URL 不受 next/image 域名配置约束，直出 <img>。 */
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={item.image}
                        alt={item.title}
                        className="absolute inset-0 h-full w-full object-cover"
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <Image
                        src={item.image}
                        alt={item.title}
                        fill
                        sizes="(min-width: 768px) 580px, 78vw"
                        className="object-cover"
                        priority={index === 0}
                      />
                    )
                  ) : (
                    <div className={cn("absolute inset-0 bg-gradient-to-br", item.gradient)} />
                  )}
                </div>
              </div>
              {/* 最外緣那條掠射亮線。厚玻璃正對鏡頭時唯一「白」的地方就是這裡
                  （Fresnel≈1），只有 1px，沒有任何面積 —— 上一版給了它 43px 的
                  面積，做出來的是塑膠相框。 */}
              <div className="case-edge" aria-hidden="true" />
              <div className="case-surface" aria-hidden="true">
                <div className="case-sheen" />
                <div className="case-rim case-rim-l" />
                <div className="case-rim case-rim-r" />
              </div>
            </div>
            </div>
        ))}
      </div>

      <div className="case-panel mt-9 sm:mt-11">
        <div key={active.id} className="case-panel-swap">
          <h3 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.88)]">{active.title}</h3>
          <p className="mx-auto mt-2 max-w-[36rem] text-ios-footnote text-[rgba(0,0,0,0.58)]">
            {active.resultNote.split('\n').flatMap((line, i, arr) =>
              i < arr.length - 1 ? [line, <br key={i} />] : [line]
            )}
          </p>
        </div>
        <p className="sr-only" aria-live="polite">{`第 ${panel + 1} 张，共 ${COUNT} 张：${active.title}`}</p>

        <div className="mt-5 flex flex-col items-center gap-3">
          {onOpenWorkflow && active.recipe && (
            <button
              type="button"
              onClick={() => onOpenWorkflow(active)}
              title="把这个案例的完整配方（提示词、模型、版位、参数）灌入专业工作台"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[9999px] bg-[#2d3142] px-6 py-5 text-ios-footnote font-semibold text-white transition-colors duration-300 hover:bg-[#3a4152] focus:outline-none focus:ring-2 focus:ring-[rgba(45,49,66,0.32)]"
            >
              用此工作流打开
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onUsePrompt(active.prompt, active.style)}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[rgba(0,122,255,0.10)] px-6 text-ios-footnote font-semibold text-[#007AFF] transition hover:bg-[rgba(0,122,255,0.16)] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.28)]"
          >
            带入生成器
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </button>
          <details key={`prompt-${active.id}`} className="group/details w-full max-w-[36rem] rounded-ios-2xl bg-[rgba(255,255,255,0.42)] px-3 py-2.5 text-left text-ios-footnote text-[rgba(0,0,0,0.64)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.70)]">
            <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-3 text-[rgba(0,0,0,0.58)]">
              <span>查看提示词</span>
              <ChevronDown className="h-4 w-4 transition group-open/details:rotate-180" aria-hidden="true" />
            </summary>
            <CasePromptReveal prompt={active.prompt} />
          </details>
        </div>
      </div>

      <div className="mt-7 flex items-center justify-center gap-2">
        <button type="button" className="case-arrow lg-float" onClick={() => step(-1)} aria-label="上一个案例">
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        <div className="flex items-center gap-1">
          {cases.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className="case-dot"
              aria-current={index === front}
              aria-label={`第 ${index + 1} 个案例：${item.title}`}
              onClick={() => goTo(index)}
            />
          ))}
        </div>
        <button type="button" className="case-arrow lg-float" onClick={() => step(1)} aria-label="下一个案例">
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      {/* 這裡曾經掛著 SVG 位移滤镜 #case-liquid-edge，已移除。
          它是使用者看到的「明顯分層」的成因：feMorphology 的結構元素是**矩形**，
          用它侵蝕一個圓角矩形，得到的遮罩帶方角；再把這塊「銳利核心」蓋回一份
          位移過的副本上，兩者的交界就是畫面裡那個硬邊直角框。stdDeviation="3"
          遠不足以糊掉它。邊緣折射現在由 CaseGlassWebGL 用真 Snell 折射計算，
          幾何厚度由 .case-side 撐出輪廓 —— 兩者都不需要拿矩形核去切圓角。 */}
    </section>
  );
}
