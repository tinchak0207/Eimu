"use client";

/* ╁━ 选片条：环与选片条是同一批卡的两个状态 ╁━
   - 有输入（拖曳 / 触控板横扫 / 箭头 / 圆点 / 键盘）→ 解除 data-rest，卡回到环上转（纵向滚轮分档不转环，见 PricingPlanCarousel）
     （环的几何、手势、吸附、弹簧全由 PricingPlanCarousel 原样负责，这里一行不碰）；
   - 输入停止、弹簧落定后 → stage[data-rest="true"]：非正面卡由 CSS 覆盖位姿，缩成底部一排
     缩图（pricing-plan-carousel.css 的选片条节）。
   这里只写两类东西：stage 的 data-rest 旗标，与每张非正面卡的选片条槽位 CSS 变数
   （--strip-x / --strip-y / --strip-s）。paint() 每帧写的 inline transform 不受影响。 */

import { useEffect, type RefObject } from "react";

/** 弹簧 SPRING_SETTLE（k 168、ζ 0.74）约 0.5 秒落定；多等一口气再收成选片条。 */
const REST_AFTER_MS = 620;
const THUMB_H_WIDE = 72;
const THUMB_H_COMPACT = 56;
const THUMB_GAP = 10;
/** 选片条中心离舞台底缘的距离（舞台下方预留高度在 CSS：.case-stage margin-bottom）。 */
const STRIP_DROP = 12;

export function usePlanFilmstrip(stageRef: RefObject<HTMLDivElement | null>, front: number, count: number) {
  /* 槽位：正面换人 / 档数变化 / 舞台尺寸变化时重算。 */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const place = () => {
      const cardW = Number.parseFloat(stage.style.getPropertyValue("--case-card-w")) || 520;
      const cardH = Number.parseFloat(stage.style.getPropertyValue("--case-card-h")) || 390;
      const compact = window.matchMedia("(max-width: 767px)").matches;
      const thumbH = compact ? THUMB_H_COMPACT : THUMB_H_WIDE;
      const scale = thumbH / cardH;
      const thumbW = cardW * scale;
      const slabs = Array.from(stage.querySelectorAll<HTMLElement>(":scope > .case-slab"));
      const others = slabs.filter((_, index) => index !== front);
      const y = cardH * 0.6 + STRIP_DROP + thumbH / 2;
      others.forEach((slab, j) => {
        const x = (j - (others.length - 1) / 2) * (thumbW + THUMB_GAP);
        slab.style.setProperty("--strip-x", `${x.toFixed(1)}px`);
        slab.style.setProperty("--strip-y", `${y.toFixed(1)}px`);
        slab.style.setProperty("--strip-s", scale.toFixed(4));
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stageRef, front, count]);

  /* 静止旗标。 */
  useEffect(() => {
    const stage = stageRef.current;
    const section = stage?.closest<HTMLElement>(".pricing-plan-carousel") ?? null;
    if (!stage || !section) return;
    let timer = 0;
    let holding = false;

    const rest = () => {
      timer = 0;
      if (!holding) stage.dataset.rest = "true";
    };
    const wake = (settle: boolean) => {
      if (stage.dataset.rest) delete stage.dataset.rest;
      window.clearTimeout(timer);
      timer = settle ? window.setTimeout(rest, REST_AFTER_MS) : 0;
    };

    const isControl = (target: EventTarget | null) =>
      target instanceof Element && target.closest("[data-pricing-control]") !== null;
    /* 按在选片条缩图上：先不醒（醒了缩图会立刻回到环上，点击命中测试就落空）；
       真的拖起来（> 6px）才醒，松手才让 PricingPlanCarousel 的点击收口把它转到正面。 */
    let pending: { x: number; y: number } | null = null;
    const onDown = (event: PointerEvent) => {
      if (isControl(event.target)) return;
      holding = true;
      const onStrip =
        stage.dataset.rest === "true" &&
        event.target instanceof Element &&
        event.target.closest('.case-slab[data-front="false"]') !== null;
      if (onStrip) {
        pending = { x: event.clientX, y: event.clientY };
        window.clearTimeout(timer);
        return;
      }
      wake(false);
    };
    const onMove = (event: PointerEvent) => {
      if (!pending || Math.hypot(event.clientX - pending.x, event.clientY - pending.y) <= 6) return;
      pending = null;
      wake(false);
    };
    const onUp = () => {
      if (!holding) return;
      holding = false;
      pending = null;
      wake(true);
    };
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) wake(true);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.target === stage && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) wake(true);
    };
    const onControlClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".case-arrow, .case-dot")) wake(true);
    };
    /* 2026-10-01：页面滚动不再转环（改为滚轮分档、不转环的淡入换档），滚动时也不再把卡叫回环上——
       原本这里一滚就解除 data-rest，非正面卡（封面照）在页面滚动途中满场乱飞。 */

    stage.addEventListener("pointerdown", onDown, { passive: true });
    stage.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onUp, { passive: true });
    window.addEventListener("pointercancel", onUp, { passive: true });
    stage.addEventListener("wheel", onWheel, { passive: true });
    stage.addEventListener("keydown", onKey);
    section.addEventListener("click", onControlClick);
    timer = window.setTimeout(rest, REST_AFTER_MS);

    return () => {
      window.clearTimeout(timer);
      stage.removeEventListener("pointerdown", onDown);
      stage.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("keydown", onKey);
      section.removeEventListener("click", onControlClick);
      delete stage.dataset.rest;
    };
  }, [stageRef]);
}
