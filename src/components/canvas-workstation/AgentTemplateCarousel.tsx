"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";
import { AGENT_TEMPLATE_DOMAIN_LABELS, type AgentPipelineStep, type AgentTemplate } from "@/lib/agent-templates";
import { commitSteps, detent, undetent } from "@/lib/carousel-detent";
import { text } from "@/lib/ui-strings";
import { cn } from "@/lib/utils";
import "../case-showcase.css";
import "./agent-template-carousel.css";
import { AgentTemplateCarouselProps, computeFrame, staticFrame, wrap, nearestAngleFor, rgbTriple, useIsoLayoutEffect, SPRING_SETTLE, SPRING_TRACK, MAX_DT, RADIUS_SCALE, DRAG_CARD_RATIO, FLICK_GAIN, SETTLE_MS, PANEL_MS, SWEEP_WIDE, SWEEP_COMPACT } from "./agent-template-carousel/ring-model";

/* ── 卡面环节选择 + 开工（2026-09-29 重做）──
   旧版反人类处（暴君截图裁定）：默认零选、送出钮灰；16px 勾选框当「全部执行」；
   三种手势靠一行说明文字教；选中/未选只差 20% 透明度；Dock 空白单击 = 隐形全选；
   窄卡横向滚动藏环节；卡面点击另弹确认框，与 Dock 抢点击。

   新模型（零说明文字；暴君 09-29 两次否决「控件铺满卡面遮成片」后定稿）：
   - 卡面默认只有一条顶部页眉：左标题（+副标），右「开始创作 →」「调整环节」。
     成片是主角，中央与下半部不放任何控件；默认全选，整套跑 = 点一下；
   - 「调整环节」展开玻璃托盘（grid-rows 0fr→1fr 过渡）：执行 = 实心浅玻璃，
     跳过 = 细描边空位 + 暗字；单击切换，按住拖过 = 刷子（按下那格切换后的状态刷给扫过的格）；
   - 挑着跑时主按钮带「k/N」，托盘末尾出「恢复全部」；零选时主按钮禁用。

   监听器规范（项目有血的教训，不许砍）：
   - pointer 四件套挂 window **capture 阶段**（轮播壳 stage 的转卡 move 不许拦）；
   - 桌面环节 touch-none 防浏览器抢手势；手机环节 touch-pan-x 让单行托盘能横滑，
     浏览器接管横滑时的 pointercancel 只收尾不切换；
   - 整块禁原生 drag；pointerdown/click 一律不冒泡给 stage（不转卡）。 */
interface PipelineStepSelectorProps {
  steps: AgentPipelineStep[];
  /** 当前执行的环节 indices（升序）；默认 = 全部。 */
  selected: number[];
  /** 整集提交：传入集合即新的执行环节（可为空 = 主按钮禁用）。 */
  onChange: (indices: number[]) => void;
  /** 主按钮：按所选环节开工（空集时按钮 disabled，不会触发）。 */
  onSubmit: () => void;
}

function PipelineStepSelector({ steps, selected, onChange, onSubmit }: PipelineStepSelectorProps) {
  /** 刷子手势：target = 按下那一格切换后的状态，扫过的格子统一刷成它。 */
  const gestureRef = useRef<{
    target: boolean;
    visited: Set<number>;
    working: Set<number>;
    /** 触摸：按下先不切换（可能是横滑轨道），抬手没被浏览器接管才算一次点按。 */
    pendingTap: number | null;
  } | null>(null);

  const total = steps.length;
  const count = selected.length;
  const allSelected = total > 0 && count === total;
  const canSubmit = count > 0;
  const allIndices = () => Array.from({ length: total }, (_, i) => i);

  const paint = (index: number): void => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.visited.has(index)) return;
    gesture.visited.add(index);
    if (gesture.target) gesture.working.add(index);
    else gesture.working.delete(index);
    onChange([...gesture.working].sort((a, b) => a - b));
  };

  const stepIndexAt = (target: EventTarget | null): number | null => {
    const hit = (target as Element | null)?.closest?.("[data-step-index]");
    if (!hit) return null;
    const index = Number(hit.getAttribute("data-step-index"));
    return Number.isNaN(index) ? null : index;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation(); // 不交给 stage：不转卡
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const index = stepIndexAt(event.target);
    if (index === null) return;
    const isTouch = event.pointerType === "touch";
    gestureRef.current = {
      target: !selected.includes(index),
      visited: new Set(),
      working: new Set(selected),
      pendingTap: isTouch ? index : null,
    };
    if (!isTouch) paint(index); // 鼠标/触控板按下即切换：立刻看到「收到了」
    window.addEventListener("pointermove", handleWindowMove, true);
    window.addEventListener("pointerup", handleWindowUp, true);
    window.addEventListener("pointercancel", endGesture, true);
  };

  const handleWindowMove = (event: PointerEvent): void => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pendingTap !== null) return; // 触摸不刷，留给横滑
    const index = stepIndexAt(document.elementFromPoint(event.clientX, event.clientY));
    if (index !== null) paint(index);
  };

  const handleWindowUp = (): void => {
    const tap = gestureRef.current?.pendingTap ?? null;
    if (tap !== null) paint(tap);
    endGesture();
  };

  /** pointercancel（浏览器接管横滑）只收尾，不切换。 */
  const endGesture = (): void => {
    gestureRef.current = null;
    window.removeEventListener("pointermove", handleWindowMove, true);
    window.removeEventListener("pointerup", handleWindowUp, true);
    window.removeEventListener("pointercancel", endGesture, true);
  };

  useEffect(() => endGesture, []); // eslint-disable-line react-hooks/exhaustive-deps -- 卸载时摘掉残留监听

  /* 环节托盘默认收起：卡面只留标题 + 一行按钮，成片是主角；
     「调整环节」展开后才出现可切换的环节。 */
  const [open, setOpen] = useState(false);
  const trayId = useId();

  return (
    <div
      className="atc-step-selector"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="atc-step-tray-wrap" data-open={open || undefined}>
        <div className="atc-step-tray-clip">
          <div
            id={trayId}
            role="group"
            aria-label="选择要执行的环节"
            inert={!open}
            className="atc-step-tray"
            onPointerDown={handlePointerDown}
            /* 触控板按住拖动在某些环境触发原生 drag → pointercancel 提前杀手势。 */
            onDragStart={(event) => event.preventDefault()}
            draggable={false}
          >
            {steps.map((step, index) => {
              const isSelected = selected.includes(index);
              return (
                <button
                  key={step.name}
                  type="button"
                  data-step-index={index}
                  aria-pressed={isSelected}
                  aria-label={`第 ${index + 1} 步：${step.name}${isSelected ? "，执行" : "，跳过"}`}
                  title={step.name}
                  onClick={(event) => {
                    /* 鼠标/触摸已在 pointerdown 切换，这里的 click 是兼容补发；
                       键盘合成 click（detail=0）才在这里切换。 */
                    if (event.detail !== 0) return;
                    onChange(
                      isSelected
                        ? selected.filter((i) => i !== index)
                        : [...selected, index].sort((a, b) => a - b),
                    );
                  }}
                  onKeyDown={(event) => {
                    /* 独立焦点目标：方向键/Home/End 不冒泡给 stage 的轮播键盘导航。 */
                    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                      event.stopPropagation();
                    }
                  }}
                  className={cn(
                    "atc-step-chip inline-flex shrink-0 cursor-pointer select-none items-center whitespace-nowrap rounded-full",
                    "touch-none max-md:touch-pan-x",
                    "transition-[background-color,color] duration-200 ease-out motion-reduce:transition-none",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
                    /* 执行 = 实心浅玻璃；跳过 = 只剩细描边的空位，行距对齐不塌。 */
                    isSelected
                      ? "bg-white/[0.2] font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]"
                      : "text-white/45 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)] hover:text-white/75 hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.32)]",
                  )}
                >
                  {step.shortName}
                </button>
              );
            })}
            {!allSelected && (
              <button
                type="button"
                onClick={() => onChange(allIndices())}
                className="atc-step-chip atc-step-reset inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded-full text-white/70 underline decoration-white/30 underline-offset-4 transition-colors duration-200 hover:text-white hover:decoration-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 motion-reduce:transition-none"
              >
                恢复全部
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="atc-step-actions">
        <button
          type="button"
          disabled={!canSubmit}
          aria-label={canSubmit ? `开始创作，执行 ${count}/${total} 个环节` : "至少选 1 个环节才能开始"}
          onClick={onSubmit}
          className={cn(
            "atc-step-submit inline-flex shrink-0 items-center whitespace-nowrap rounded-full font-semibold",
            "transition-[transform,background-color,color] duration-200 ease-out motion-reduce:transition-none",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black/30",
            canSubmit
              ? "cursor-pointer bg-white text-[#1d1d1f] hover:bg-[#f2f2f4] active:scale-[0.97]"
              : "cursor-not-allowed bg-white/25 text-white/60",
          )}
        >
          开始创作
          {canSubmit && !allSelected && (
            <span className="atc-step-count font-medium tabular-nums text-black/45">
              {count}/{total}
            </span>
          )}
          <ArrowRight className="atc-step-arrow" strokeWidth={2.25} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={trayId}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "atc-step-toggle inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded-full font-medium text-white",
            "backdrop-blur-xl transition-colors duration-200 ease-out motion-reduce:transition-none",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
            open ? "bg-white/[0.26]" : "bg-white/[0.14] hover:bg-white/[0.22]",
          )}
        >
          <SlidersHorizontal className="atc-step-toggle-icon" strokeWidth={2} aria-hidden="true" />
          {open ? "收起" : "调整环节"}
        </button>
      </div>
    </div>
  );
}

export function AgentTemplateCarousel({ templates, onUseTemplate }: AgentTemplateCarouselProps) {
  /* 案例环数据：只吃官方模板（templates）。「用户投稿案例」为已裁定不做的能力
     （不接受任何自定义用户发布内容，见 src/lib/showcase-user-cases.ts 档头警示），
     本组件不读取、不合并任何用户发布内容。 */
  const cases = templates;
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

  /* 每张卡的 GL draw()。玻璃是静物，但玻璃上的**光**要跟著转动走，所以由这个
     本来就在跑的手势回圈推它重画 —— 事件驱动，GL 那边不自己开 rAF。 */
  const glDrawRefs = useRef<Array<((tiltDeg: number) => void) | null>>([]);
  const glTiltRefs = useRef<number[]>([]);

  /* 环角只活在 ref 里 —— 每帧 setState 会把 6 张卡的 React 树重算 60 次/秒。
     rAF 直接写 DOM style，React 只在「正面换人」时才 render。 */
  const targetRef = useRef(0);
  const angleRef = useRef(0);
  const paintedRef = useRef(Number.NaN);
  const rafRef = useRef(0);
  const frontRef = useRef(0);
  const prevCountRef = useRef(COUNT);

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

  /* ── 环节选择（2026-09-29 重做）：每张卡独立记忆执行的环节 indices ──
     key 缺失 = 全部执行（默认态，大按钮直接开工）；选了部分存升序数组，
     空数组 = 一个都不跑（主按钮禁用）；刷回全量即删 key 归默认态。 */
  const [selectedStepsByTemplate, setSelectedStepsByTemplate] = useState<Record<string, number[]>>({});
  const handleStepsChange = useCallback(
    (templateId: string, count: number) => (indices: number[]) => {
      setSelectedStepsByTemplate((prev) => {
        const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < count).sort((a, b) => a - b);
        if (sorted.length === count) {
          const rest = { ...prev };
          delete rest[templateId];
          return rest;
        }
        return { ...prev, [templateId]: sorted };
      });
    },
    [],
  );

  /** 卡片尺寸、环半径、滚动灵敏度全从舞台实测宽度推出来，写成 CSS 变量。 */
  const measure = useCallback(() => {
    const stage = stageRef.current;
    const section = sectionRef.current;
    if (!stage) return;

    const stageWidth = stage.clientWidth || 1024;
    const compact = window.matchMedia("(max-width: 767px)").matches;
    /* 2026-08-25 暴君裁定：卡片放大 75%（桌面）。2026-08-27 手机端返工：
       SIZE_GAIN 只给桌面——compact 下 340×1.75=595px 塞 390px 视口，
       内容左右截断装不下。手机端用紧凑尺寸（0.78 系数 + 340 上限原样）。 */
    const SIZE_GAIN = compact ? 1 : 1.75;
    const cardW = compact
      ? Math.min(stageWidth * 0.78, 340)
      : Math.min(Math.max(stageWidth * 0.42, 300), 580) * SIZE_GAIN;
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
      /* 景深模糊移到 .case-face（正面那一叠）。留在 .case-slab 上的话，侧壁作为
         溢出子节点会被 filter 的作用范围裁掉 —— 而侧壁是厚度的唯一证据。 */
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

      /* 把倾角推进 shader：高光滑过玻璃、受光侧的边变厚，都是这个值在驱动。
         门槛 0.4° + 只重画看得见的两三张（depth > 0.5）—— 拖动时 GPU 上的
         实际负担是一到两张卡，不是六张。 */
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
  }, [cases, COUNT, STEP]);

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
  }, [snap, STEP]);

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

  /* 案例数量变化后每格角度改变：环回到第一张，避免旧角度在新格距下错位落格。
     模板环 cases 是 props 直传，数量变化时同样需要重置。 */
  useEffect(() => {
    if (COUNT === prevCountRef.current) return;
    prevCountRef.current = COUNT;
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
  }, [cases, paint, COUNT]);

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
     全程不 preventDefault 纵向滚动：页面永远滚得动，环只是顺带转起来。
     教学拖拽演示期间（atc-tour-locking，2026-08-27 轨迹瞬移返工）短路：
     driver.js 高亮/平滑滚动会顶起 scroll 事件 → drive() 转卡 → data-front
     换卡 → 演示目标漂移。只锁转卡手势，页面滚动本身照常。 */
  useEffect(() => {
    const onScroll = () => {
      if (sectionRef.current?.classList.contains("atc-tour-locking")) return;
      const y = window.scrollY;
      const delta = y - lastScrollRef.current;
      lastScrollRef.current = y;
      if (!engagedRef.current || draggingRef.current || reduceRef.current) return;
      drive(delta * degPerPxRef.current);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [drive]);

  /* 触控板横扫 / Shift+滚轮。2026-09-12 性能审计（09-11 OOM note）：改
     { passive: true } 并移除 preventDefault——非 passive 的 wheel 监听会把
     stage 上的滚轮事件卡在主线程，拖累合成器滚动。仍只在横向分量占优时
     drive() 转卡，纵向一律放行。已知缺口：横扫时防页面横向漂移/滑动导航
     需要 stage 上的 overscroll-behavior-x CSS，那在共用样式档（本片禁改），
     待后续片补。教学演示期间（atc-tour-locking）同样短路转卡。 */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (stage.classList.contains("atc-tour-locking")) return;
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      drive(event.deltaX * dragDegPerPxRef.current);
    };
    stage.addEventListener("wheel", onWheel, { passive: true });
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

    /* 2026-08-25 点击根因修复：setPointerCapture 会把后续 pointer 事件（含衍生
       click）重定向到舞台——卡片的 onClick 在多数浏览器根本收不到，这就是
       「点卡进不去」反覆修不掉的原因。改成 pointerup 收口：手指没动过 =
       一次点击，对释放点做命中测试找到卡，激活逻辑原地执行。
       movedRef 先置 true：若浏览器仍补发 click，onCardClick 会直接闭嘴。 */
    if (!movedRef.current) {
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const slab = hit instanceof Element ? hit.closest(".case-slab") : null;
      const index = slab ? cardRefs.current.indexOf(slab as HTMLDivElement) : -1;
      if (index >= 0) {
        movedRef.current = true;
        /* 正面卡不再整卡启动（2026-09-29）：开工只走卡面主按钮，免误触。 */
        if (index !== front) goTo(index);
      }
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

  /* 点边卡 = 把它转到正面；正面卡点击不做事——开工只走卡面主按钮。 */
  const onCardClick = (index: number) => {
    if (movedRef.current) return;
    if (index !== front) goTo(index);
  };

  return (
    <section className="case-viewport agent-template-carousel pb-12" aria-label="助理模板" ref={sectionRef}>
      {/* 2026-08-25 用户裁定：零文案。页头标题/胶囊、底部标题+痛点+启动按钮+
          「查看初始提示词」全部删除——卡面已带全部信息，正面卡点击即启动。 */}

      {/* 2026-09-24 用户版面方案·刀1：包一层紧贴 stage 的定位宿主。
          根 section 是满版 flex 置中容器（顶到视口底），控制行若 absolute
          于根，bottom:16px 会落在卡外之下；wrap 高 = stage 高，卡片几何
          （stage = 1.2×cardH）全部由既有 JS measure() 驱动，此层零逻辑。 */}
      <div className="atc-stage-wrap">
      <div
        ref={stageRef}
        className="case-stage"
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
            {/* ── 侧壁：厚度的唯一真证据 ──
                必须是 .case-face 的**兄弟**而不是子节点：它要伸出正面之外才能
                把轮廓撑宽（一块厚 T 的板转 θ，投影宽 = W·cosθ + T·sinθ），
                而 .case-face 带 filter，filter 会把溢出的子节点裁掉。 */}
            <div className="case-side case-side-l" aria-hidden="true" />
            <div className="case-side case-side-r" aria-hidden="true" />

            {/* ── 液态玻璃层：整张卡由 shader 成像 ──
                必须是 .case-slab 的**直接子节点**，两个理由：
                ① 它的轮廓要外凸、起伏、伸出侧壁，全都落在卡框之外，挂进带
                   filter 的 .case-face 会被裁成直边 —— 那就又是圆角矩形。
                ② 元件靠 host.parentElement 读卡片的版面尺寸与四角半径。
                就绪后它会给 .case-slab 挂上 data-glass="on"，把下面那一叠
                矩形的 HTML 图层收掉。 */}
            {/* 模板卡：海报区 = 模范级 AI 成片封面照 + 领域渐变叠底（保证文字可读）
                + 大字水印 + 模板名称与流水线步骤链。2026-08-26：纯渐变 placeholder
                换成真实 AI 成片素材（八卡各一条模范作品封面帧）。 */}
            <div className="case-face">
              <div className="case-media">
                <div className="case-photo">
                  {item.showcaseImage ? (
                    <div className={cn("absolute inset-0 bg-gradient-to-br", item.accent)}>
                      {/* 素材影片（2026-08-26 用户裁定：卡面必须是真影片）：8 秒静音循环。
                          poster = 封面帧 webp（影片未载入/还在缓冲时不空白）；
                          muted+playsInline+preload=metadata 才允许自动播放，
                          aria-hidden（纯视觉层）。 */}
                      {/* 2026-09-12 性能审计落地（09-11 OOM note 待修①）：只有正面卡挂
                          <video>——换卡由 paint() 的 setFront 触发本图层重渲染，新正面卡
                          挂载即 autoPlay（play），离去卡卸载整个元素（等价 pause+卸 src
                          还解码器），8 路软解 → 1 路。启停完全钩进既有 data-front 变更点，
                          不新增事件监听。非正面卡走下面现成的封面帧兜底路径。 */}
                      {item.showcaseVideo && index === front && (
                        /* eslint-disable-next-line jsx-a11y/media-has-caption, @next/next/no-img-element -- 静态 public 资产背景层 */
                        <video
                          src={item.showcaseVideo}
                          poster={item.showcaseImage}
                          autoPlay
                          loop
                          muted
                          playsInline
                          preload="metadata"
                          aria-hidden="true"
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      )}
                      {/* 静态兜底：封面帧 webp。原为「无影片时的兜底」，2026-09-12 起
                          兼作「非正面卡」的常态渲染路径。object-cover 铺满。 */}
                      {(!item.showcaseVideo || index !== front) && (
                        /* eslint-disable-next-line @next/next/no-img-element -- 静态 public 资产，case-photo 是背景层不走 next/image */
                        <img
                          src={item.showcaseImage}
                          alt=""
                          aria-hidden="true"
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      )}
                      {/* 2026-08-26 用户裁定：真影片素材上不再叠领域大字水印——
                          那是无素材时代的 placeholder 装饰，叠在真成片上就是噪音。 */}
                    </div>
                  ) : (
                  <div className={cn("absolute inset-0 bg-gradient-to-br", item.accent)}>
                    <span className="atc-watermark" aria-hidden="true">
                      {AGENT_TEMPLATE_DOMAIN_LABELS[item.domain]}
                    </span>
                  </div>
                  )}
                  {/* 卡面页眉（2026-09-29 改锚卡顶）：左标题/副标、右按钮，中央让给成片。
                      （2026-08-27 回滚：eyebrow/tagline/珠链是错误 scope 的改动，
                      用户指定的是画布节点卡，不是 carousel 卡面。） */}
                  <div className="atc-info">
                    <div className="atc-title">{item.name}</div>
                    {/* P0-1 剧本入口曝光（2026-09-28）：只在 novel_film 正面卡上补一行
                        「有文本就丢进来」的提示。零新轮子——沿用 atc-info 既有排版与
                        卡面字影规范，纯文案加一行，不碰轮播几何/手势/事件。 */}
                    {item.harnessTemplateId === "novel_film" && (
                      <div className="atc-script-entry">{text("templates.scriptEntry.hint")}</div>
                    )}
                    <PipelineStepSelector
                      steps={item.pipeline.steps}
                      selected={
                        selectedStepsByTemplate[item.id] ??
                        Array.from({ length: item.pipeline.steps.length }, (_, i) => i)
                      }
                      onChange={handleStepsChange(item.id, item.pipeline.steps.length)}
                      onSubmit={() => {
                        const picked =
                          selectedStepsByTemplate[item.id] ??
                          Array.from({ length: item.pipeline.steps.length }, (_, i) => i);
                        if (picked.length > 0) onUseTemplate(item, picked);
                      }}
                    />
                  </div>
                </div>
              </div>
              {/* 最外缘那条掠射亮线。厚玻璃正对镜头时唯一「白」的地方就是这里
                  （Fresnel≈1），只有 1px，没有任何面积 —— 上一版给了它 43px 的
                  面积，做出来的是塑胶相框。 */}
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

      {/* 2026-08-25 用户裁定：底部文案区全删（标题/痛点/启动按钮/查看初始提示词）。
          sr-only 播报保留（无障碍不牺牲），交互入口 = 正面卡点击 + 箭头/圆点。 */}
      <p className="sr-only" aria-live="polite">{`第 ${panel + 1} 张，共 ${COUNT} 张：${cases[panel].name}`}</p>

      <div className="atc-controls mt-4 flex items-center justify-center gap-3 max-md:gap-1.5">
        {/* 桌面保留箭头；移动端 swipe 转卡即可，箭头只占黄金区（毒舌一审裁定）。 */}
        <button type="button" className="case-arrow lg-float max-md:hidden" onClick={() => step(-1)} aria-label="上一个模板">
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        {/* 移动端：N/M 紧凑指示（9 个圆点在手机上是噪点）；桌面保留圆点。 */}
        <div
          role="tablist"
          aria-label={`模板进度：第 ${front + 1} 张，共 ${COUNT} 张`}
          className="max-md:rounded-full max-md:bg-black/[0.35] max-md:px-3 max-md:py-1.5 max-md:text-[11px] max-md:font-semibold max-md:text-white/85 max-md:[text-shadow:0_1px_2px_rgba(0,0,0,0.6)] flex items-center gap-1"
        >
          {cases.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={`case-dot ${index !== front ? "max-md:hidden" : ""}`}
              aria-current={index === front}
              aria-label={`第 ${index + 1} 个模板：${item.name}`}
              onClick={() => goTo(index)}
            >
              {index === front && <span className="max-md:inline hidden">{front + 1}/{COUNT}</span>}
            </button>
          ))}
        </div>
        <button type="button" className="case-arrow lg-float max-md:hidden" onClick={() => step(1)} aria-label="下一个模板">
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
      </div>{/* end .atc-stage-wrap：分页控制行收进卡内的定位宿主（2026-09-24 刀1） */}

      {/* 这里曾经挂著 SVG 位移滤镜 #case-liquid-edge，已移除。
          它是使用者看到的「明显分层」的成因：feMorphology 的结构元素是**矩形**，
          用它侵蚀一个圆角矩形，得到的遮罩带方角；再把这块「锐利核心」盖回一份
          位移过的副本上，两者的交界就是画面里那个硬边直角框。stdDeviation="3"
          远不足以糊掉它。边缘折射现在由 CaseGlassWebGL 用真 Snell 折射计算，
          几何厚度由 .case-side 撑出轮廓 —— 两者都不需要拿矩形核去切圆角。 */}

    </section>
  );
}
