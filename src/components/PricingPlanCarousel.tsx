"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatCoins, gptImage2EquivalentImages } from "@/lib/plans";
import type { PricingPlan } from "@/lib/plans";
import { commitSteps, detent, undetent } from "@/lib/carousel-detent";
import { createWheelStepper } from "@/lib/wheel-stepper";
import { PricingStage3D } from "@/components/pricing3d/PricingStage3D";
import { usePlanFilmstrip } from "@/components/pricing3d/use-plan-filmstrip";
import { TIER_COPY, WORLD_POSTERS, isWorldId } from "@/components/pricing3d/worlds";
import { DRAG_CARD_RATIO, FLICK_GAIN, MAX_DT, PANEL_MS, RADIUS_SCALE, SETTLE_MS, SPRING_SETTLE, SPRING_TRACK, SWITCH_FADE_MS, computeFrame, nearestAngleFor, rgbTriple, staticFrame, wrap } from "./PricingPlanCarousel/geometry";
import { PLAN_GLOWS, PLAN_TINTS, CustomFace, PlanFace, ladderFill, worldOf } from "./PricingPlanCarousel/card-faces";
import { formatCustomCoins } from "./PricingPlanCarousel/slider-math";
import { customPlanForPlaceholder } from "./PricingPlanCarousel/plan-placeholder";
import type { CarouselItem, PricingPlanCarouselProps } from "./PricingPlanCarousel/types";
import "./case-showcase.css";
import "./pricing-plan-carousel.css";
import "./pricing3d/pricing3d.css";

/* ╁━ 充值方案环（2026-09-07 暴君裁定：/pricing 三列并排 → AI 助理模板同款 carousel）╁━
   本组件是 canvas-workstation/AgentTemplateCarousel.tsx 的逐行复制（复用=整复制改
   白名单，禁造轮子）。几何/物理/手势/吸附/弹簧全部原样未动；白名单改动仅限：
   ① 数据源 = 套餐档（plans prop）+ 自定义档（isCustom 卡，Log Scale 滑杆）；
   ② 卡面内容渲染 = 充值卡（价格/额度换算/卡内收银台），替换模板卡的封面照与环节 Dock；
   ③ 模板专属件移除：PipelineStepSelector、driver.js 教学、确认弹窗、showcase 影片。
   自定义档计价 = coins × 0.045 RMB（唯一权威在 plans.ts 的 customPlanPrice()）。

   ── 2026-09-11 卡面重做（视觉验收：四档卡面全数不合 DESIGN.md）──
   材料/字级/控件/构图四层一起收口，几何与物理仍未动：
   ① 材料：满版粉彩渐变 → .lg-card 白玻璃 + 方案色低透明度晕染（Design.md §2/§5）；
   ② 字级：calc(卡宽×0.068) 的 44px → Dynamic Type 尺度（title3 / largetitle）；
   ③ 控件：原生 accent-color 蓝滑杆 → 自绘轨道/滑块（pricing-plan-carousel.css）；
      未选中 CTA 的 rgba(0,0,0,0.05) 灰底 → 白玻璃胶囊（灰底读起来像禁用态）；
   ④ 构图：三带（头/中/尾），中带吸收卡高余量，卡面中间不再留 140–200px 空洞。
   卡面比例属于白名单②（卡面渲染）：桌面 0.82（卡高下限 384px）、手机 1.45
   （模板卡 0.75 的横构图是给封面照的，充值卡内容竖排且字级固定，需要的高度不同；
   环半径随卡宽等比缩放，物理不变）。

   ── 2026-09-26 卡面 3D 化（白名单②卡面渲染，几何/物理/手势/吸附/弹簧仍一行未动）──
   ① 拆掉 .lg-card 外壳：卡面 = 3D 满版（pricing3d/，手写 three，透明画布叠在 SSR 梦境底图上）；
      正面卡不放静态封面（避免「先出卡片再换 3D」），3D 到位时卡堆直接落进梦境；
   ② 卡面只留价格 + 支付 CTA（浮在 3D 之上的 DOM 玻璃层 .ppc-glass）；额度文字从卡面删除，
      只留在 sr-only 描述里（3D 卡堆是纯视觉，读屏用户仍要拿到额度与换算口径）；
   ③ 选片条：环停下后非正面卡缩成底部一排缩图（usePlanFilmstrip + CSS 覆盖位姿，
      paint() 写的 inline 位姿不动）；拖曳时它们回到环上转；
   ④ 初始停在梦影（popular）：只改环的「起始角」（= 状态初值，不是几何），
      首帧静态位姿以同一起始角求值，SSR 首屏即是梦影。 */

/** 环的起始档（2026-09-26：初始停在梦影 = 主力档；该档不在当前周期视图里时退回第一张）。 */
const HOME_PLAN_ID = "popular";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function PricingPlanCarousel({
  plans,
  includeCustom,
  customPlan,
  selectedPlanId,
  referenceCoinsPerImage,
  payMethod,
  payOpened,
  refreshingBalance,
  onSelect,
  onCustomCoinsChange,
  onMethodChange,
  onPay,
  onRefreshBalance,
  onFrontChange,
}: PricingPlanCarouselProps) {
  /* 环数据：静态套餐 + 追加自定义档。items 引用必须稳定——滑杆拖动只更新
     customPlan 的内容，不重建本数组（否则每帧触发环回位 reset）。 */
  const items = useMemo<CarouselItem[]>(() => {
    const list: CarouselItem[] = plans.map((plan) => ({
      id: plan.id,
      plan,
      isCustom: false,
      glow: PLAN_GLOWS[plan.id] ?? "#007AFF",
    }));
    if (includeCustom) {
      list.push({
        id: "custom",
        plan: customPlanForPlaceholder(),
        isCustom: true,
        glow: PLAN_GLOWS.custom,
      });
    }
    return list;
    // customPlanForPlaceholder 只占位（卡面渲染用 props.customPlan），故不入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans, includeCustom]);
  const cases = items;
  /* 票面与档位梯的对照基准 = 金币最少的静态档；徽章：主推档「最多人选」，每金币最便宜的档「单价最低」
     （自定义档按滑杆当前额度现算，admin 改价后自动换人）。 */
  const baseline = useMemo(() => plans.reduce<PricingPlan | null>((min, p) => (!min || p.coins < min.coins ? p : min), null), [plans]);
  let cheapestId: string | null = null;
  let cheapestRate = Infinity;
  for (const item of cases) {
    const plan = item.isCustom ? customPlan : item.plan;
    const rate = plan.coins > 0 ? plan.price / plan.coins : Infinity;
    if (rate < cheapestRate - 1e-9) {
      cheapestRate = rate;
      cheapestId = item.id;
    }
  }
  const badgeFor = (item: CarouselItem) => (!item.isCustom && item.plan.highlight ? "最多人选" : item.id === cheapestId ? "单价最低" : null);
  const COUNT = cases.length;
  const STEP = 360 / COUNT;
  /* 环的起始档（状态初值）：首帧静态位姿、各 ref 初值、档数变化后的回位都用它。 */
  const HOME = Math.max(0, cases.findIndex((item) => item.id === HOME_PLAN_ID));
  /* 静态帧（首帧/无 JS）：cases 不变时引用稳定，React 的 style diff 直接跳过
     ——paint() 每帧写的 transform/opacity 因此不会被 React 覆盖回静态位姿。
     方案色（--ppc-tint，供卡面晕染与滑杆着色）挂在这里：它只随档位变化，
     不参与逐帧计算，放静态帧里正好。 */
  const STATIC_FRAMES = useMemo(
    () =>
      cases.map(
        (item, index) =>
          ({
            ...staticFrame(index - HOME, STEP),
            "--ppc-tint": PLAN_TINTS[item.id] ?? "0 122 255",
          }) as React.CSSProperties,
      ),
    [cases, STEP, HOME],
  );

  const sectionRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const glowRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);

  /* 每张卡的 GL draw() 占位（模板廊原样：GL 层未挂载时为 null，paint 跳过）。 */
  const glDrawRefs = useRef<Array<((tiltDeg: number) => void) | null>>([]);
  const glTiltRefs = useRef<number[]>([]);

  /* 环角只活在 ref 里 —— 每帧 setState 会把卡的 React 树重算 60 次/秒。 */
  const targetRef = useRef(HOME * STEP);
  const angleRef = useRef(HOME * STEP);
  const paintedRef = useRef(Number.NaN);
  const rafRef = useRef(0);
  const frontRef = useRef(HOME);
  const prevCountRef = useRef(COUNT);

  /* 磁力三角度（模板廊原样）：rawRef 原始累加、angleRef 屏幕角度、originRef 手势起点卡位。 */
  const rawRef = useRef(HOME * STEP);
  const originRef = useRef(HOME * STEP);

  /* 二阶弹簧状态（模板廊原样）。 */
  const velRef = useRef(0);
  const springRef = useRef(SPRING_SETTLE);
  const lastTsRef = useRef(0);

  const switchTimerRef = useRef(0);
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

  const [front, setFront] = useState(HOME);
  const [panel, setPanel] = useState(HOME);

  /** 卡片尺寸、环半径、滚动灵敏度全从舞台实测宽度推出来，写成 CSS 变量。（模板廊原样）
   *  卡宽/卡高与模板廊不同：模板卡是封面照（1.75 倍放大、4:3 横构图），充值卡是
   *  竖排信息的 UI 卡。卡面文字已回到设计系统字级（不随卡宽放大），所以卡高要有
   *  下限：卡面内容堆叠约 330px，低于 384px 就没有留白了。
   *  环半径 = 卡宽 × 0.78 × RADIUS_SCALE，随卡宽等比缩放，物理量一个没动。 */
  const measure = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const stageWidth = stage.clientWidth || 1024;
    const compact = window.matchMedia("(max-width: 767px)").matches;
    /* 卡面尺寸（白名单②）：2026-09-26 暴君实机「一进来看到的是截断态」（1536×~800 的笔电视口，
       票面与支付钮落在首屏外）→ 宽屏卡高再受「首屏剩余高度」约束：舞台（= 卡高 × 1.2）必须在首屏内
       放得下，票面永远首屏可见。只改尺寸输入，几何/物理公式一行未动。 */
    const stageTop = stage.getBoundingClientRect().top + window.scrollY;
    const foldBudget = Math.max(0, window.innerHeight - stageTop - 12) / 1.2;
    const cardW = compact
      ? Math.min(stageWidth * 0.78, 340)
      : Math.min(Math.max(stageWidth * 0.52, 320), 620, Math.max(foldBudget, 380) / 0.82);
    const cardH = compact
      ? Math.round(cardW * 1.45)
      : Math.max(Math.round(cardW * 0.82), 340);
    const radius = cardW * (compact ? 0.84 : 0.78) * RADIUS_SCALE;

    radiusRef.current = radius;
    cardWRef.current = cardW;
    dragDegPerPxRef.current = STEP / (cardW * DRAG_CARD_RATIO);

    stage.style.setProperty("--case-card-w", `${Math.round(cardW)}px`);
    stage.style.setProperty("--case-card-h", `${cardH}px`);
    stage.style.setProperty("--case-radius", `${Math.round(radius)}px`);
    stage.style.height = `${Math.round(cardH * 1.2)}px`;

  }, [STEP]);

  /** 每帧唯一的写 DOM 处。React 不参与：它只在「正面换人」时 render 一次。（模板廊原样） */
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
      s.zIndex = String(f.zIndex);
      s.pointerEvents = f.depth > 0.4 ? "auto" : "none";
      s.setProperty("--case-depth", f.depth.toFixed(3));
      s.setProperty("--case-blur", `${f.blur}px`);
      s.setProperty("--case-sheen", f.sheen.toFixed(3));
      s.setProperty("--case-sheen-x", `${(cardW * f.sheenXF).toFixed(2)}px`);
      s.setProperty("--case-side-l", `${(cardW * f.sideLF).toFixed(2)}px`);
      s.setProperty("--case-side-r", `${(cardW * f.sideRF).toFixed(2)}px`);
      s.setProperty("--case-rim-l", f.rimL.toFixed(3));
      s.setProperty("--case-rim-r", f.rimR.toFixed(3));
      s.setProperty("--case-parallax", `${(cardW * f.parallaxF).toFixed(2)}px`);

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
      if (panelTimerRef.current) clearTimeout(panelTimerRef.current);
      panelTimerRef.current = setTimeout(() => setPanel(frontIndex), PANEL_MS);
    }
  }, [cases, COUNT, STEP]);

  /* ── 弹簧积分器（模板廊原样：dt 积分，与刷新率解耦）── */
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

    if (Math.abs(target - angle) > 360) angle = target - Math.sign(target - angle) * 360;

    vel += (-k * (angle - target) - c * vel) * dt;
    angle += vel * dt;

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

  /** 落格：按「从手势起点走了几格」决定。（模板廊原样） */
  const commit = useCallback((flickSteps: number) => {
    const travel = (rawRef.current - originRef.current) / STEP;
    const steps = commitSteps(travel, flickSteps);
    const landing = originRef.current + steps * STEP;
    rawRef.current = landing;
    targetRef.current = landing;
    springRef.current = SPRING_SETTLE;
    schedule();
  }, [schedule, STEP]);

  /** 连续输入（滚动 / 触控板横扫）：接收增量 + 磁力 + SETTLE 落格。（模板廊原样） */
  const drive = useCallback((deltaDeg: number) => {
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
      commit(0);
    }, SETTLE_MS);
  }, [schedule, commit, STEP]);

  /** 离散跳转（箭头 / 圆点 / 键盘）：软弹簧落格。（模板廊原样） */
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

  /** 拖曳期间手指就是位置本身：不过弹簧、不排 rAF，直接写角度立刻画。（模板廊原样） */
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
  }, [snap, STEP]);

  const step = useCallback((dir: number) => {
    snap(Math.round(targetRef.current / STEP) * STEP + dir * STEP);
  }, [snap, STEP]);

  /** 不转环的换档（滚轮分档用）：直接落到目标角度，正面卡由 CSS 交叉淡入（stage[data-switch]），
   *  非正面卡停在选片条（隐去）不露脸。 */
  const fadeTo = useCallback((index: number) => {
    const stage = stageRef.current;
    if (index < 0 || index >= COUNT) return;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    const value = nearestAngleFor(index, targetRef.current, STEP);
    if (stage) {
      stage.dataset.switch = "fade";
      window.clearTimeout(switchTimerRef.current);
      switchTimerRef.current = window.setTimeout(() => {
        delete stage.dataset.switch;
      }, SWITCH_FADE_MS);
    }
    rawRef.current = value;
    originRef.current = value;
    targetRef.current = value;
    angleRef.current = value;
    velRef.current = 0;
    paint(value);
  }, [COUNT, STEP, paint]);

  useIsoLayoutEffect(() => {
    measure();
    glowRef.current?.style.setProperty("--case-glow-rgb", rgbTriple((cases[frontRef.current] ?? cases[0]).glow));
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

  /* 档数变化（周期切换）后每格角度改变：环回到起始档，避免旧角度错位落格。
     （模板廊原样；回位目标由「第一张」改为起始档 HOME——状态初值，不是几何。） */
  useEffect(() => {
    if (COUNT === prevCountRef.current) return;
    prevCountRef.current = COUNT;
    const home = HOME * STEP;
    targetRef.current = home;
    angleRef.current = home;
    rawRef.current = home;
    originRef.current = home;
    velRef.current = 0;
    paintedRef.current = Number.NaN;
    if (frontRef.current !== HOME) {
      frontRef.current = HOME;
      setFront(HOME);
      setPanel(HOME);
    }
    glowRef.current?.style.setProperty("--case-glow-rgb", rgbTriple(cases[HOME].glow));
    paint(home);
  }, [cases, paint, HOME, STEP, COUNT]);

  /* 正面卡换人 → 回报 plan id（整页氛围）；3D 舞台与选片条跟着同一个 front。 */
  const frontItem = cases[front] ?? cases[0];
  useEffect(() => {
    if (frontItem) onFrontChange?.(frontItem.id);
  }, [frontItem, onFrontChange]);
  usePlanFilmstrip(stageRef, front, COUNT);

  /* 滚轮分档（2026-10-01 暴君实机：「我的机子滚动灵敏度高，一滑就直接跑过四个阶段，根本没 regulate」；
     中间态「一堆莫名其妙的东西跑出来」）。原本页面滚动量连续驱动转环：一次带惯性的触控板滑动 = 转过全部档位，
     途中非正面卡回到环上露脸。改成：
       - 首屏舞台完整在视野内时，纵向滚轮由环接管，一次手势（含触控板惯性尾巴）只换一档
         （第二版 2026-10-01：判定移到 lib/wheel-stepper，修「滑几次失效」「往回滑无效」）；
       - 到头（梦芽往上 / 自定义往下）或舞台不在视野内 → 放行页面滚动；
       - 换档不转环：直接落到目标档，正面卡与舞台（3D / 静态图）交叉淡入，非正面卡全程不露脸。
     页面普通滚动不再转环。 */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    /* 手势判定（锁定、重新武装、到头放行）全在 wheel-stepper 状态机里，这里只接线。 */
    const stepper = createWheelStepper();
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || draggingRef.current) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return; // 横向交给下方的横扫接管
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
      const decision = stepper.feed({ t: event.timeStamp, delta: event.deltaY * scale }, (dir) => {
        /* 「在视野内」＝整段（含上方档位梯）与舞台都在屏内；且这个方向还有下一档。 */
        const rect = stage.getBoundingClientRect();
        const sectionTop = sectionRef.current?.getBoundingClientRect().top ?? rect.top;
        const inView = sectionTop >= -8 && rect.top >= -8 && rect.bottom <= window.innerHeight + 8;
        const current = frontRef.current;
        return inView && (dir > 0 ? current < COUNT - 1 : current > 0);
      });
      if (decision === "pass") return;
      event.preventDefault();
      if (typeof decision === "object") fadeTo(frontRef.current + decision.step);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [COUNT, fadeTo]);

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
    window.clearTimeout(switchTimerRef.current);
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
    /* 半空中接手：屏幕上是 detent() 拧过的角度，拖曳累加的是原始角度。（模板廊原样） */
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

    dragBy(-dx * dragDegPerPxRef.current);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    stageRef.current?.removeAttribute("data-dragging");
    if (stageRef.current?.hasPointerCapture(event.pointerId)) {
      stageRef.current.releasePointerCapture(event.pointerId);
    }

    /* 点击收口（模板廊原样）：setPointerCapture 会把衍生 click 重定向到舞台，
       改成 pointerup 命中测试——没动过 = 一次点击，前卡 = 选中该方案。 */
    if (!movedRef.current) {
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const slab = hit instanceof Element ? hit.closest(".case-slab") : null;
      const index = slab ? cardRefs.current.indexOf(slab as HTMLDivElement) : -1;
      if (index >= 0) {
        movedRef.current = true;
        if (index === front) {
          const item = cases[front];
          onSelect(item.isCustom ? "custom" : item.id);
        } else {
          goTo(index);
        }
      }
    }

    /* 末速度换算成「格/秒」再乘增益，commit() 夹在 1 格以内。（模板廊原样） */
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

  /* 点边卡 = 把它转到正面；前卡 onClick 兜底（键盘路径），pointerup 收口为主路径。 */
  const onCardClick = (index: number) => {
    if (movedRef.current) return;
    if (index === front) {
      const item = cases[front];
      onSelect(item.isCustom ? "custom" : item.id);
      return;
    }
    goTo(index);
  };

  const isSelected = (item: CarouselItem) => (item.isCustom ? selectedPlanId === "custom" : selectedPlanId === item.id);

  return (
    <section className="case-viewport pricing-plan-carousel pb-12" aria-label="充值方案" ref={sectionRef}>
      {/* 档位梯（取代圆点，放在舞台之上——任何视口首屏都看得到全部四档）：额度条按对数刻度
          一档比一档长，一眼看出递进、能画多少、多少钱；点哪档环就转到哪档（goTo，环物理原样）。 */}
      <div className="ppc-ladder-wrap">
        <div
          role="tablist"
          aria-label={`方案进度：第 ${front + 1} 档，共 ${COUNT} 档`}
          className="ppc-ladder"
          style={{ "--ppc-tiers": COUNT, "--ppc-active": front } as React.CSSProperties}
        >
          <span className="ppc-ladder-lens" aria-hidden="true" />
          {cases.map((item, index) => {
            const plan = item.isCustom ? customPlan : item.plan;
            const world = worldOf(item.id);
            const images = gptImage2EquivalentImages(plan, referenceCoinsPerImage);
            const badge = badgeFor(item);
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={index === front}
                className="ppc-tier"
                data-world={world}
                aria-label={`第 ${index + 1} 档：${item.isCustom ? "自定义 · 自由额度" : item.plan.name}，约 ${images} 张图，${plan.price} 元`}
                onClick={() => goTo(index)}
              >
                {badge && <span className="ppc-tier-badge" data-kind={badge === "单价最低" ? "value" : "hot"}>{badge}</span>}
                <span className="ppc-tier-top">
                  <span className="ppc-tier-name">{TIER_COPY[world].short}</span>
                  <span className="ppc-tier-price">¥{plan.price}</span>
                </span>
                <span className="ppc-tier-bar" aria-hidden="true">
                  <span style={{ width: `${(ladderFill(plan.coins) * 100).toFixed(1)}%` }} />
                </span>
                <span className="ppc-tier-quota">
                  <span className="max-md:hidden">约 </span>
                  {images >= 10_000 ? `${Number((images / 10_000).toFixed(1))} 万` : images.toLocaleString("en-US")} 张
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div
        ref={stageRef}
        className="case-stage"
        role="group"
        aria-roledescription="轮播"
        aria-label={`充值方案，共 ${COUNT} 档`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <div ref={glowRef} className="case-glow" aria-hidden="true" />
        {/* 3D 舞台：全页唯一 WebGL context；透明画布叠在梦境底图上，挂载即载入（不等 idle）。 */}
        {frontItem && (
          <PricingStage3D
            planId={frontItem.id}
            coins={frontItem.isCustom ? customPlan.coins : frontItem.plan.coins}
          />
        )}
        {cases.map((item, index) => (
          <div
            key={item.id}
            ref={(node) => {
              cardRefs.current[index] = node;
            }}
            className="case-slab focus-visible:ring-2 focus-visible:ring-ring"
            style={STATIC_FRAMES[index]}
            data-plan={item.id}
            /* SSR 首帧就标出正面卡（之后由 paint() 每帧维护）：首屏正面卡不闪一张封面。 */
            data-front={index === HOME ? "true" : "false"}
            role="radio"
            aria-checked={isSelected(item)}
            aria-label={item.isCustom ? `自定义方案，当前 ${formatCustomCoins(customPlan.coins)} 金币，${customPlan.price} 元` : `${item.plan.name}，${formatCoins(item.plan.coins)} 金币 ${item.plan.price} 元`}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(item.isCustom ? "custom" : item.id);
              }
            }}
            onClick={() => onCardClick(index)}
          >
            {/* ── 侧壁：厚度的唯一真证据（模板廊原样，必须是 .case-face 的兄弟）── */}
            <div className="case-side case-side-l" aria-hidden="true" />
            <div className="case-side case-side-r" aria-hidden="true" />

            <div className="case-face">
              <div className="case-media">
                <div className="case-photo">
                  {/* 卡面：无 .lg-card 外壳。底层是封面（真实生成图 = 主角卡本身；选片条缩图也用它），
                      上层是价格玻璃层。 */}
                  <div className="ppc-face">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      className="ppc-poster"
                      src={WORLD_POSTERS[isWorldId(item.id) ? item.id : "popular"]}
                      alt=""
                      draggable={false}
                      decoding="async"
                      loading={index === HOME ? "eager" : "lazy"}
                    />
                    {item.isCustom ? (
                      <CustomFace
                        plan={customPlan}
                        baseline={baseline}
                        selected={isSelected(item)}
                        referenceCoinsPerImage={referenceCoinsPerImage}
                        payMethod={payMethod}
                        payOpened={payOpened}
                        refreshingBalance={refreshingBalance}
                        onSelect={onSelect}
                        onCustomCoinsChange={onCustomCoinsChange}
                        onMethodChange={onMethodChange}
                        onPay={onPay}
                        onRefreshBalance={onRefreshBalance}
                      />
                    ) : (
                      <PlanFace
                        plan={item.plan}
                        baseline={baseline}
                        selected={isSelected(item)}
                        referenceCoinsPerImage={referenceCoinsPerImage}
                        payMethod={payMethod}
                        payOpened={payOpened}
                        refreshingBalance={refreshingBalance}
                        onSelect={onSelect}
                        onMethodChange={onMethodChange}
                        onPay={onPay}
                        onRefreshBalance={onRefreshBalance}
                      />
                    )}
                  </div>
                </div>
              </div>
              {/* 最外缘那条掠射亮线（模板廊原样）。 */}
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

      {/* sr-only 播报（模板廊原样，文案换方案语义）。 */}
      <p className="sr-only" aria-live="polite">{`第 ${panel + 1} 档，共 ${COUNT} 档：${cases[panel] ? (cases[panel].isCustom ? "自定义 · 自由额度" : cases[panel].plan.name) : ""}`}</p>

    </section>
  );
}
