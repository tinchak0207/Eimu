"use client";

/* ╁━ /pricing 3D 舞台宿主（輕量殼：不 import three）╁━
   秒載入（2026-09-26 暴君：「要秒載入，而不是先出卡片再幹嘛幹嘛」）：
   - 首幀 = SSR 的夢境底圖 + 價格玻璃層；正面卡不放靜態封面，所以沒有「先一張卡、再換 3D」；
   - 本模組一被瀏覽器執行就開始拉 engine chunk（不等 idle、不等 effect），掛載即建引擎；
   - 透明畫布淡入，卡堆直接落進夢境（進場掉落本來就是這一幕的開場）；
   - 3D 不可用 → section[data-pricing3d="off"]，CSS 退回封面卡。無任何 loading 遮罩。

   生命週期（CaseGlassWebGL 同款紀律）：
   - 全頁只有這一個 WebGL context；
   - 離屏（IntersectionObserver）/ 分頁隱藏（visibilitychange）→ 停 rAF；
   - 卸載 → engine.dispose()（幾何/材質/貼圖/PMREM/renderer 全數釋放 + forceContextLoss）；
   - saveData / deviceMemory ≤ 2 → 不接管；prefers-reduced-motion → 靜止構圖、不做動態。

   互動全部是「旁聽」：監聽器掛在 case-stage 上、passive、不 stopPropagation、不
   preventDefault —— 環的拖曳/吸附/彈簧手勢一行未動，3D 只是聽同一隻手在做什麼。 */

import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import type { Pricing3DEngine } from "./engine";
import { createPricingSound, readSoundPreference, type PricingSound } from "./sound";
import { WORLD_IDS, isWorldId, type WorldId } from "./worlds";
import { LITE_STAGE_IMAGES, detectPricingStageMode, type PricingStageMode } from "./device-tier";

interface PricingStage3DProps {
  /** 當前主角档（= 環正面那張卡的 plan id）。 */
  planId: string;
  /** 當前档金幣額度（plans / customPlanFor() 派生，catalog 驅動）。 */
  coins: number;
}

/** 模組求值時就開始下載 three + engine（和 hydration 並行，不排在 idle 之後）。 */
let enginePromise: Promise<typeof import("./engine")> | null = null;
function loadEngine() {
  enginePromise ??= import("./engine");
  return enginePromise;
}
/** 離線產靜態圖用（只在開發環境生效）：?p3d=capture 強制 3D、減少動態（卡堆直接落定），暴露截圖函式。 */
const CAPTURE = process.env.NODE_ENV !== "production" && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("p3d") === "capture";
function initialMode(): PricingStageMode {
  return CAPTURE ? "3d" : detectPricingStageMode();
}
/* 低端機（靜態圖）／封面卡模式不下載 three：判斷在模組求值時就做完。 */
if (typeof window !== "undefined" && initialMode() === "3d") void loadEngine().catch(() => undefined);
const DRAG_PULSE_MS = 90;
const TAP_SLOP_PX = 5;

function toWorld(planId: string): WorldId {
  return isWorldId(planId) ? planId : "popular";
}

export function PricingStage3D({ planId, coins }: PricingStage3DProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<Pricing3DEngine | null>(null);
  const soundRef = useRef<PricingSound | null>(null);
  const worldRef = useRef<WorldId>(toWorld(planId));
  const coinsRef = useRef(coins);
  const shownWorldRef = useRef<WorldId | null>(null);
  const [armed, setArmed] = useState(false);
  const [live, setLive] = useState(false);
  /* 舞台模式：SSR 與首幀一律當 3D（不閃封面）；掛載後判定低端機 → 靜態場景圖。 */
  const [mode, setMode] = useState<PricingStageMode>("3d");
  const [soundOn, setSoundOn] = useState(true);

  worldRef.current = toWorld(planId);
  coinsRef.current = coins;

  /* ① 掛載即判定：低端機（Intel 核顯／軟體渲染／少核小記憶體／省流量）→ 靜態場景圖；
     WebGL 不可用 → 標記 off，CSS 退回封面卡；其餘武裝 3D。 */
  useEffect(() => {
    const decided = initialMode();
    if (decided === "off") {
      const section = hostRef.current?.closest<HTMLElement>(".pricing-plan-carousel");
      if (section) section.dataset.pricing3d = "off";
      return;
    }
    if (decided === "lite") {
      setMode("lite");
      return;
    }
    setSoundOn(readSoundPreference());
    setArmed(true);
  }, []);

  /* 靜態場景圖模式：與 3D 同一套版面（data-pricing3d="on"：正面卡透明、只留價格玻璃層），
     首張圖解碼完才亮，避免空舞台閃一下。 */
  const [liteReady, setLiteReady] = useState(false);
  useEffect(() => {
    if (mode !== "lite" || !liteReady) return;
    const section = hostRef.current?.closest<HTMLElement>(".pricing-plan-carousel");
    if (section) section.dataset.pricing3d = "on";
  }, [mode, liteReady]);

  /* ② 動態 import three + 建引擎；所有監聽與觀察者都在這一個 effect 裡建、在這裡拆。 */
  useEffect(() => {
    if (!armed || mode !== "3d") return;
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const stage = host?.parentElement ?? null;
    const section = host?.closest<HTMLElement>(".pricing-plan-carousel") ?? null;
    if (!host || !canvas || !stage) return;

    let cancelled = false;
    let engine: Pricing3DEngine | null = null;
    const sound = createPricingSound();
    soundRef.current = sound;
    const cleanups: Array<() => void> = [];
    const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const compact = window.matchMedia("(max-width: 767px)").matches || window.matchMedia("(pointer: coarse)").matches;

    const teardown = (failed = false) => {
      for (const fn of cleanups.splice(0)) fn();
      engine?.dispose();
      engine = null;
      engineRef.current = null;
      shownWorldRef.current = null;
      setLive(false);
      if (!section) return;
      if (failed) section.dataset.pricing3d = "off";
      else delete section.dataset.pricing3d;
    };

    /* 首次用戶手勢才開聲卡（自動播放政策；也不在沒人碰的時候出聲）。 */
    const unlock = () => sound.unlock();
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    cleanups.push(() => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    });

    loadEngine()
      .then(({ createPricing3DEngine }) => {
        if (cancelled) return;
        const coins0 = coinsRef.current;
        try {
          engine = createPricing3DEngine({
            canvas,
            compact,
            reducedMotion: reduceQuery.matches,
            world: worldRef.current,
            coins: coins0,
            sound,
            onFirstFrame: () => {
              if (cancelled) return;
              if (section) section.dataset.pricing3d = "on";
              setLive(true);
            },
            onFailure: () => {
              if (!cancelled) teardown(true);
            },
            /* 執行中才發現跑不動（解析度降到地板仍 < 24fps）→ 換靜態場景圖，不再硬撐。 */
            onSlow: CAPTURE
              ? undefined
              : () => {
                  if (!cancelled) setMode("lite");
                },
          });
        } catch {
          engine = null;
          if (section) section.dataset.pricing3d = "off";
          return;
        }
        engineRef.current = engine;
        shownWorldRef.current = worldRef.current;
        const e = engine;
        if (CAPTURE) {
          e.setReducedMotion(true);
          (window as Window & { __p3dSnapshot?: () => string }).__p3dSnapshot = () => e.snapshot("image/png");
          cleanups.push(() => {
            delete (window as Window & { __p3dSnapshot?: () => string }).__p3dSnapshot;
          });
        }
        /* import 期間用戶可能已切档 / 拖了滑桿：以最新值對齊一次。 */
        if (coinsRef.current !== coins0) e.setCoinsLive(coinsRef.current);

        const rect = host.getBoundingClientRect();
        e.resize(rect.width, rect.height);
        const resizer = new ResizeObserver(([entry]) => {
          const box = entry.contentRect;
          e.resize(box.width, box.height);
        });
        resizer.observe(host);
        cleanups.push(() => resizer.disconnect());

        let onScreen = true;
        const sync = () => e.setActive(onScreen && document.visibilityState === "visible");
        const io = new IntersectionObserver(([entry]) => {
          onScreen = entry.isIntersecting;
          sync();
        });
        io.observe(host);
        document.addEventListener("visibilitychange", sync);
        cleanups.push(() => {
          io.disconnect();
          document.removeEventListener("visibilitychange", sync);
        });

        const onReduce = () => e.setReducedMotion(reduceQuery.matches);
        reduceQuery.addEventListener("change", onReduce);
        cleanups.push(() => reduceQuery.removeEventListener("change", onReduce));

        /* ── 旁聽手勢（passive，不攔任何事件）── */
        const ndc = (clientX: number, clientY: number) => {
          const r = canvas.getBoundingClientRect();
          return [((clientX - r.left) / Math.max(1, r.width)) * 2 - 1, -(((clientY - r.top) / Math.max(1, r.height)) * 2 - 1)] as const;
        };
        const isControl = (target: EventTarget | null) =>
          target instanceof Element && target.closest("[data-pricing-control]") !== null;
        const onFront = (target: EventTarget | null) =>
          target instanceof Element && target.closest('.case-slab[data-front="true"], .p3d-host') !== null;

        let down: { x: number; y: number; t: number; id: number } | null = null;
        let lastX = 0;
        let lastT = 0;
        let vel = 0;
        let lastPulse = 0;

        const onDown = (ev: PointerEvent) => {
          if (isControl(ev.target)) return;
          down = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp, id: ev.pointerId };
          lastX = ev.clientX;
          lastT = ev.timeStamp;
          vel = 0;
        };
        const onMove = (ev: PointerEvent) => {
          if (down && ev.pointerId === down.id) {
            const dt = Math.max(1, ev.timeStamp - lastT);
            const v = (ev.clientX - lastX) / dt;
            vel = vel * 0.6 + v * 0.4;
            lastX = ev.clientX;
            lastT = ev.timeStamp;
            if (ev.timeStamp - lastPulse > DRAG_PULSE_MS && Math.abs(ev.clientX - down.x) > TAP_SLOP_PX) {
              lastPulse = ev.timeStamp;
              e.swipe(vel * 0.3);
            }
            return;
          }
          if (ev.pointerType !== "mouse" || isControl(ev.target) || !onFront(ev.target)) {
            e.hover(null, 0);
            return;
          }
          const [x, y] = ndc(ev.clientX, ev.clientY);
          e.hover(x, y);
        };
        const onUp = (ev: PointerEvent) => {
          if (!down || ev.pointerId !== down.id) return;
          const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
          const quick = ev.timeStamp - down.t < 450;
          down = null;
          if (moved <= TAP_SLOP_PX && quick && onFront(document.elementFromPoint(ev.clientX, ev.clientY))) {
            const [x, y] = ndc(ev.clientX, ev.clientY);
            e.tap(x, y);
          } else if (moved > TAP_SLOP_PX && ev.timeStamp - lastT < 90) {
            e.swipe(vel);
          }
        };
        const onCancel = () => {
          down = null;
        };
        const onLeave = () => e.hover(null, 0);

        /* 自訂滑桿：拖動中 = 原地伸縮（props 驅動）；鬆手（原生 change）= 落一輪。 */
        let dropTimer = 0;
        const onChange = (ev: Event) => {
          if (!(ev.target instanceof HTMLInputElement) || !ev.target.classList.contains("ppc-slider")) return;
          window.clearTimeout(dropTimer);
          dropTimer = window.setTimeout(() => e.redrop(), 220);
        };

        stage.addEventListener("pointerdown", onDown, { passive: true });
        stage.addEventListener("pointermove", onMove, { passive: true });
        stage.addEventListener("pointerup", onUp, { passive: true });
        stage.addEventListener("pointercancel", onCancel, { passive: true });
        stage.addEventListener("pointerleave", onLeave, { passive: true });
        stage.addEventListener("change", onChange);
        cleanups.push(() => {
          window.clearTimeout(dropTimer);
          stage.removeEventListener("pointerdown", onDown);
          stage.removeEventListener("pointermove", onMove);
          stage.removeEventListener("pointerup", onUp);
          stage.removeEventListener("pointercancel", onCancel);
          stage.removeEventListener("pointerleave", onLeave);
          stage.removeEventListener("change", onChange);
        });
      })
      .catch(() => {
        /* chunk 載入失敗 = 退回封面卡，不打擾用戶。 */
        if (!cancelled && section) section.dataset.pricing3d = "off";
      });

    return () => {
      cancelled = true;
      teardown();
      sound.dispose();
      soundRef.current = null;
    };
  }, [armed, mode]);

  /* ③ 切档 = 硬剪接 + 重落；同档額度變化（自訂滑桿拖動）= 原地伸縮。 */
  const world = toWorld(planId);
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    if (shownWorldRef.current !== world) {
      shownWorldRef.current = world;
      e.setWorld(world, coins);
    } else {
      e.setCoinsLive(coins);
    }
  }, [world, coins, live]);

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    if (soundRef.current) soundRef.current.setEnabled(next);
    else {
      try {
        window.localStorage.setItem("pricing3d.sound", next ? "on" : "off");
      } catch {
        /* 無痕模式：只在本頁生效 */
      }
    }
  };

  return (
    <>
      <div ref={hostRef} className="p3d-host" data-world={world} data-mode={mode} aria-hidden="true">
        {mode === "lite" ? (
          WORLD_IDS.map((id) => (
            <picture key={id} className="p3d-still" data-on={id === world ? "true" : "false"}>
              <source media="(max-width: 767px)" srcSet={LITE_STAGE_IMAGES[id].tall} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={LITE_STAGE_IMAGES[id].wide}
                srcSet={`${LITE_STAGE_IMAGES[id].wide} 1x, ${LITE_STAGE_IMAGES[id].wide2x} 2x`}
                alt=""
                draggable={false}
                decoding="async"
                fetchPriority={id === world ? "high" : "low"}
                /* 快取命中時圖可能在水合前就載完（onLoad 不會再觸發）：掛上時補查一次 complete。 */
                ref={(el) => {
                  if (!el) return;
                  if (el.complete && el.naturalWidth > 0 && id === world) setLiteReady(true);
                  /* 其餘档提前解碼，切過去時直接上屏。 */
                  void el.decode().catch(() => undefined);
                }}
                onLoad={id === world ? () => setLiteReady(true) : undefined}
              />
            </picture>
          ))
        ) : (
          <canvas ref={canvasRef} className="p3d-canvas" />
        )}
      </div>
      {/* 沒有 JS 就不會有 3D：退回封面卡。 */}
      <noscript>
        <style>{`.pricing-plan-carousel .case-slab[data-front="true"] .ppc-poster{opacity:1!important}`}</style>
      </noscript>
      {live && (
        <button
          type="button"
          data-pricing-control
          className="p3d-sound lg-float"
          aria-label={soundOn ? "关闭卡片音效" : "开启卡片音效"}
          aria-pressed={soundOn}
          title={soundOn ? "关闭卡片音效" : "开启卡片音效"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            toggleSound();
          }}
        >
          {soundOn ? <Volume2 className="h-4 w-4" aria-hidden="true" /> : <VolumeX className="h-4 w-4" aria-hidden="true" />}
        </button>
      )}
    </>
  );
}
