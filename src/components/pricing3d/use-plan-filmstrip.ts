"use client";

/* ╁━ 選片條：環與選片條是同一批卡的兩個狀態 ╁━
   - 有輸入（拖曳 / 觸控板橫掃 / 箭頭 / 圓點 / 鍵盤）→ 解除 data-rest，卡回到環上轉（縱向滾輪分檔不轉環，見 PricingPlanCarousel）
     （環的幾何、手勢、吸附、彈簧全由 PricingPlanCarousel 原樣負責，這裡一行不碰）；
   - 輸入停止、彈簧落定後 → stage[data-rest="true"]：非正面卡由 CSS 覆蓋位姿，縮成底部一排
     縮圖（pricing-plan-carousel.css 的選片條節）。
   這裡只寫兩類東西：stage 的 data-rest 旗標，與每張非正面卡的選片條槽位 CSS 變數
   （--strip-x / --strip-y / --strip-s）。paint() 每幀寫的 inline transform 不受影響。 */

import { useEffect, type RefObject } from "react";

/** 彈簧 SPRING_SETTLE（k 168、ζ 0.74）約 0.5 秒落定；多等一口氣再收成選片條。 */
const REST_AFTER_MS = 620;
const THUMB_H_WIDE = 72;
const THUMB_H_COMPACT = 56;
const THUMB_GAP = 10;
/** 選片條中心離舞台底緣的距離（舞台下方預留高度在 CSS：.case-stage margin-bottom）。 */
const STRIP_DROP = 12;

export function usePlanFilmstrip(stageRef: RefObject<HTMLDivElement | null>, front: number, count: number) {
  /* 槽位：正面換人 / 檔數變化 / 舞台尺寸變化時重算。 */
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

  /* 靜止旗標。 */
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
    /* 按在選片條縮圖上：先不醒（醒了縮圖會立刻回到環上，點擊命中測試就落空）；
       真的拖起來（> 6px）才醒，鬆手才讓 PricingPlanCarousel 的點擊收口把它轉到正面。 */
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
    /* 2026-10-01：頁面滾動不再轉環（改為滾輪分檔、不轉環的淡入換檔），滾動時也不再把卡叫回環上——
       原本這裡一滾就解除 data-rest，非正面卡（封面照）在頁面滾動途中滿場亂飛。 */

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
