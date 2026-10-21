"use client";

/* ╁━ /pricing 3D 舞台宿主（轻量壳：不 import three）╁━
   秒载入（2026-09-26 暴君：「要秒载入，而不是先出卡片再干嘛干嘛」）：
   - 首帧 = SSR 的梦境底图 + 价格玻璃层；正面卡不放静态封面，所以没有「先一张卡、再换 3D」；
   - 本模组一被浏览器执行就开始拉 engine chunk（不等 idle、不等 effect），挂载即建引擎；
   - 透明画布淡入，卡堆直接落进梦境（进场掉落本来就是这一幕的开场）；
   - 3D 不可用 → section[data-pricing3d="off"]，CSS 退回封面卡。无任何 loading 遮罩。

   生命周期（CaseGlassWebGL 同款纪律）：
   - 全页只有这一个 WebGL context；
   - 离屏（IntersectionObserver）/ 分页隐藏（visibilitychange）→ 停 rAF；
   - 卸载 → engine.dispose()（几何/材质/贴图/PMREM/renderer 全数释放 + forceContextLoss）；
   - saveData / deviceMemory ≤ 2 → 不接管；prefers-reduced-motion → 静止构图、不做动态。

   互动全部是「旁听」：监听器挂在 case-stage 上、passive、不 stopPropagation、不
   preventDefault —— 环的拖曳/吸附/弹簧手势一行未动，3D 只是听同一只手在做什么。 */

import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import type { Pricing3DEngine } from "./engine";
import { createPricingSound, readSoundPreference, type PricingSound } from "./sound";
import { WORLD_IDS, isWorldId, type WorldId } from "./worlds";
import { LITE_STAGE_IMAGES, detectPricingStageMode, type PricingStageMode } from "./device-tier";

interface PricingStage3DProps {
  /** 当前主角档（= 环正面那张卡的 plan id）。 */
  planId: string;
  /** 当前档金币额度（plans / customPlanFor() 派生，catalog 驱动）。 */
  coins: number;
}

/** 模组求值时就开始下载 three + engine（和 hydration 并行，不排在 idle 之后）。 */
let enginePromise: Promise<typeof import("./engine")> | null = null;
function loadEngine() {
  enginePromise ??= import("./engine");
  return enginePromise;
}
/** 离线产静态图用（只在开发环境生效）：?p3d=capture 强制 3D、减少动态（卡堆直接落定），暴露截图函式。 */
const CAPTURE = process.env.NODE_ENV !== "production" && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("p3d") === "capture";
function initialMode(): PricingStageMode {
  return CAPTURE ? "3d" : detectPricingStageMode();
}
/* 低端机（静态图）／封面卡模式不下载 three：判断在模组求值时就做完。 */
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
  /* 舞台模式：SSR 与首帧一律当 3D（不闪封面）；挂载后判定低端机 → 静态场景图。 */
  const [mode, setMode] = useState<PricingStageMode>("3d");
  const [soundOn, setSoundOn] = useState(true);

  worldRef.current = toWorld(planId);
  coinsRef.current = coins;

  /* ① 挂载即判定：低端机（Intel 核显／软体渲染／少核小记忆体／省流量）→ 静态场景图；
     WebGL 不可用 → 标记 off，CSS 退回封面卡；其余武装 3D。 */
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

  /* 静态场景图模式：与 3D 同一套版面（data-pricing3d="on"：正面卡透明、只留价格玻璃层），
     首张图解码完才亮，避免空舞台闪一下。 */
  const [liteReady, setLiteReady] = useState(false);
  useEffect(() => {
    if (mode !== "lite" || !liteReady) return;
    const section = hostRef.current?.closest<HTMLElement>(".pricing-plan-carousel");
    if (section) section.dataset.pricing3d = "on";
  }, [mode, liteReady]);

  /* ② 动态 import three + 建引擎；所有监听与观察者都在这一个 effect 里建、在这里拆。 */
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

    /* 首次用户手势才开声卡（自动播放政策；也不在没人碰的时候出声）。 */
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
            /* 执行中才发现跑不动（解析度降到地板仍 < 24fps）→ 换静态场景图，不再硬撑。 */
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
        /* import 期间用户可能已切档 / 拖了滑杆：以最新值对齐一次。 */
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

        /* ── 旁听手势（passive，不拦任何事件）── */
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

        /* 自订滑杆：拖动中 = 原地伸缩（props 驱动）；松手（原生 change）= 落一轮。 */
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
        /* chunk 载入失败 = 退回封面卡，不打扰用户。 */
        if (!cancelled && section) section.dataset.pricing3d = "off";
      });

    return () => {
      cancelled = true;
      teardown();
      sound.dispose();
      soundRef.current = null;
    };
  }, [armed, mode]);

  /* ③ 切档 = 硬剪接 + 重落；同档额度变化（自订滑杆拖动）= 原地伸缩。 */
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
        /* 无痕模式：只在本页生效 */
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
                /* 快取命中时图可能在水合前就载完（onLoad 不会再触发）：挂上时补查一次 complete。 */
                ref={(el) => {
                  if (!el) return;
                  if (el.complete && el.naturalWidth > 0 && id === world) setLiteReady(true);
                  /* 其余档提前解码，切过去时直接上屏。 */
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
      {/* 没有 JS 就不会有 3D：退回封面卡。 */}
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
