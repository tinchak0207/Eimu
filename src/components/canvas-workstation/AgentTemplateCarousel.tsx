"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { commitSteps, detent, undetent } from "@/lib/carousel-detent";
import { AGENT_TEMPLATE_DOMAIN_LABELS, type AgentTemplate } from "@/lib/agent-templates";
import "../case-showcase.css";
import "./agent-template-carousel.css";

export interface AgentTemplateCarouselProps {
  templates: AgentTemplate[];
  onUseTemplate: (template: AgentTemplate) => void;
}

/* ── 几何常数：与首页 CaseShowcase 同源（computeFrame 一份公式两处用）── */
const TILT = 0.82;
const RADIUS_SCALE = 2;
const TILT_MAX = 80;
const DEPTH = 0.78;
const LIFT = 26;
const LIGHT_DEG = -13;
const GLASS = 0.062;
/** 拖过「卡宽 × 这个比例」= 转一格（与首页一致）。 */
const DRAG_CARD_RATIO = 0.62;
const FLICK_GAIN = 0.34;

/* ── 弹簧（与首页同参数：dt 积分，与刷新率解耦）── */
const SPRING_SETTLE = { k: 168, ratio: 0.74 };
const MAX_DT = 1 / 30;

/** 把角度收进 (−180, 180]。 */
function wrap(deg: number) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

function nearestAngleFor(index: number, current: number, step: number) {
  const base = index * step;
  return base + Math.round((current - base) / 360) * 360;
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 一张卡在环角 φ 处的完整位姿与光照 —— 从 CaseShowcase.computeFrame 原样精简（去 GL 相关注释）。
 *  几何量返回「R 的倍率 / 卡宽的倍率」，SSR 的 staticFrame 交给 CSS calc() 解。 */
function computeFrame(phi: number) {
  const rad = (phi * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const depth = (cos + 1) / 2;
  const tilt = Math.max(-TILT_MAX, Math.min(TILT_MAX, phi * TILT));
  const tiltRad = (tilt * Math.PI) / 180;

  const align = Math.max(0, Math.cos(tiltRad - (LIGHT_DEG * Math.PI) / 180));
  const sheen = 0.22 + 0.78 * Math.pow(align, 3);
  const wall = Math.min(Math.abs(Math.tan(tiltRad)), 1.5) * GLASS;

  return {
    xF: sin,
    zF: DEPTH * (cos - 1),
    lift: (-LIFT * (1 - cos)) / 2,
    tilt,
    depth,
    opacity: 0.07 + 0.93 * smoothstep(0.34, 1, Math.max(0, 2 * depth - 1)),
    blur: Math.round((1 - depth) * 8) / 2,
    zIndex: Math.round(depth * 1000),
    sheen,
    sheenXF: (tilt / TILT_MAX) * 0.55,
    sideLF: tilt > 0 ? wall : 0,
    sideRF: tilt < 0 ? wall : 0,
    rimL: tilt > 0 ? 0.2 + 0.42 * Math.abs(Math.sin(tiltRad)) : 0.12 * (1 - Math.abs(Math.sin(tiltRad))),
    rimR: tilt < 0 ? 0.14 + 0.28 * Math.abs(Math.sin(tiltRad)) : 0.07 * (1 - Math.abs(Math.sin(tiltRad))),
    parallaxF: -Math.sin(tiltRad) * GLASS * 0.25,
  };
}

/** θ=0 时第 index 张卡的位姿（首帧 / 无 JS / 测试锚点）。 */
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

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function pipelineSummary(template: AgentTemplate) {
  const steps = template.pipeline.steps.length;
  const gates = template.pipeline.steps.filter((s) => s.gate).length;
  return gates > 0 ? `${steps} 步流水线 · ${gates} 道门禁` : `${steps} 步流水线`;
}

export function AgentTemplateCarousel({ templates, onUseTemplate }: AgentTemplateCarouselProps) {
  if (templates.length === 0) {
    return (
      <div className="atc-empty">
        <p>暂无助理模板</p>
      </div>
    );
  }
  return <CarouselRing templates={templates} onUseTemplate={onUseTemplate} />;
}

function CarouselRing({ templates, onUseTemplate }: AgentTemplateCarouselProps) {
  const COUNT = templates.length;
  const STEP = 360 / COUNT;

  const STATIC_FRAMES = useMemo(
    () => templates.map((_, index) => staticFrame(index, STEP)),
    [templates, STEP],
  );

  const stageRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);

  /* 环角只活在 ref 里；rAF 直写 DOM style，React 只在「正面换人」时 render。 */
  const targetRef = useRef(0);
  const angleRef = useRef(0);
  const paintedRef = useRef(Number.NaN);
  const rafRef = useRef(0);
  const frontRef = useRef(0);
  const rawRef = useRef(0);
  const originRef = useRef(0);

  const velRef = useRef(0);
  const springRef = useRef(SPRING_SETTLE);
  const lastTsRef = useRef(0);
  const reduceRef = useRef(false);

  const radiusRef = useRef(468);
  const cardWRef = useRef(400);
  const dragDegPerPxRef = useRef(0.14);

  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const dragXRef = useRef(0);
  const velocityRef = useRef(0);
  const lastMoveAtRef = useRef(0);

  const [front, setFront] = useState(0);

  /** 面板内嵌场景：卡宽比首页小一档，其余几何量从卡宽推出。 */
  const measure = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const stageWidth = stage.clientWidth || 420;
    const cardW = Math.min(Math.max(stageWidth * 0.72, 260), 420);
    const cardH = Math.round(cardW * 1.18);
    const radius = cardW * 0.78 * RADIUS_SCALE;

    radiusRef.current = radius;
    cardWRef.current = cardW;
    dragDegPerPxRef.current = STEP / (cardW * DRAG_CARD_RATIO);

    stage.style.setProperty("--case-card-w", `${Math.round(cardW)}px`);
    stage.style.setProperty("--case-card-h", `${cardH}px`);
    stage.style.setProperty("--case-radius", `${Math.round(radius)}px`);
    stage.style.height = `${Math.round(cardH * 1.2)}px`;
  }, [STEP]);

  /** 每帧唯一的写 DOM 处（无 GL，纯 HTML 图层）。 */
  const paint = useCallback(
    (angle: number) => {
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
      }
    },
    [COUNT, STEP],
  );

  /** 弹簧积分器（同首页：ẍ = −k(x−target) − c·ẋ，dt 积分）。 */
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

  /** 落格：按「从手势起点走了几格」决定，不 round 到最近。 */
  const commit = useCallback(
    (flickSteps: number) => {
      const travel = (rawRef.current - originRef.current) / STEP;
      const steps = commitSteps(travel, flickSteps);
      const landing = originRef.current + steps * STEP;
      rawRef.current = landing;
      targetRef.current = landing;
      springRef.current = SPRING_SETTLE;
      schedule();
    },
    [schedule, STEP],
  );

  /** 离散跳转（键盘）。 */
  const snap = useCallback(
    (value: number) => {
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      rawRef.current = value;
      originRef.current = Math.round(value / STEP) * STEP;
      targetRef.current = value;
      springRef.current = SPRING_SETTLE;
      schedule();
    },
    [schedule, STEP],
  );

  /** 拖曳期间手指就是位置本身：不过弹簧，画的是 detent() 拧过的角度。 */
  const dragBy = useCallback(
    (deltaDeg: number) => {
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
    },
    [paint, STEP],
  );

  const goTo = useCallback(
    (index: number) => {
      snap(nearestAngleFor(index, targetRef.current, STEP));
    },
    [snap, STEP],
  );

  const stepBy = useCallback(
    (dir: number) => {
      snap(Math.round(targetRef.current / STEP) * STEP + dir * STEP);
    },
    [snap, STEP],
  );

  useIsoLayoutEffect(() => {
    measure();
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

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    },
    [],
  );

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
    /* 半空中接手：屏幕上是 detent() 拧过的角度，拖曳累加的是原始角度。 */
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

    /* 内容往左拖 = 下一张转到正面，取 −dx。 */
    dragBy(-dx * dragDegPerPxRef.current);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    stageRef.current?.removeAttribute("data-dragging");
    if (stageRef.current?.hasPointerCapture(event.pointerId)) {
      stageRef.current.releasePointerCapture(event.pointerId);
    }

    /* 末速度换算成「格/秒」再乘增益；甩动只表达方向，翻几张由拖过的距离说话。 */
    const idle = event.timeStamp - lastMoveAtRef.current > 90;
    const flickSteps = idle
      ? 0
      : (-velocityRef.current * 1000 * dragDegPerPxRef.current * FLICK_GAIN) / STEP;
    commit(flickSteps);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      stepBy(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepBy(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      goTo(0);
    } else if (event.key === "End") {
      event.preventDefault();
      goTo(COUNT - 1);
    }
  };

  /** 只有正面卡可启动模板：侧卡点击是「转到正面」，拖过的手势不算点击。 */
  const onCardClick = (index: number) => {
    if (movedRef.current || draggingRef.current) return;
    if (index === front) {
      onUseTemplate(templates[front]);
    } else {
      goTo(index);
    }
  };

  return (
    /* 宿主 .canvas-ws-overlay 是 fixed + h-[100dvh] 的普通 div（非 flex 容器），
       case-stage 直接進去 top 會貼 0。atc-frame 負責在 overlay 裡鋪滿並垂直
       置中，stage 保持自身 position:relative + width，接觸影（.case-stage::after）
       跟著 stage 走，隨之置中。 */
    <div className="atc-frame">
      <div
        ref={stageRef}
        className="case-stage atc-stage"
        role="group"
        aria-roledescription="轮播"
        aria-label={`助理模板，共 ${COUNT} 张`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <div className="case-glow" aria-hidden="true" />
        {templates.map((template, index) => (
        <div
          key={template.id}
          ref={(node) => {
            cardRefs.current[index] = node;
          }}
          className="case-slab"
          style={STATIC_FRAMES[index]}
          data-front={index === 0 ? "true" : "false"}
          onClick={() => onCardClick(index)}
        >
          <div className="case-side case-side-l" aria-hidden="true" />
          <div className="case-side case-side-r" aria-hidden="true" />
          <div className="case-face">
            <div className="atc-media">
              {/* 上半海報區：領域漸變 + 大字水印 + 步驟鏈。視覺主體在這裡——
                  純文字卡讀起來像沒載入完（2026-08-25 用戶驗收）。 */}
              <div className={`atc-poster bg-gradient-to-br ${template.accent}`}>
                <span className="atc-watermark" aria-hidden="true">
                  {AGENT_TEMPLATE_DOMAIN_LABELS[template.domain]}
                </span>
                <span className="atc-flow" aria-hidden="true">
                  {template.pipeline.steps.map((s) => s.name).join(" → ")}
                </span>
              </div>
              {/* 下半文字區：垂直置中，不再頭重腳輕。 */}
              <div className="atc-body">
                <span className="atc-chip">{AGENT_TEMPLATE_DOMAIN_LABELS[template.domain]}</span>
                <h3 className="atc-name">{template.name}</h3>
                <p className="atc-pain">{template.painPoint}</p>
                <p className="atc-meta">{pipelineSummary(template)}</p>
              </div>
            </div>
            {/* 材質層棧照抄首頁（CaseShowcase L775-781）：掠射亮線 + 表面光層。
                paint() 每幀寫的 --case-sheen/--case-sheen-x/--case-rim-l/--case-rim-r
                由這兩層消費——沒有它們，光照四件套寫了等於白寫。 */}
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
    </div>
  );
}
