"use client";

// 赏阅 · 视频适配器：自绘控制层的 <video>，经 controllerRef 发布 capture()/reveal()/loop()。
// 只负责「渲染视频 + 此刻指在哪」；标签、反馈措辞、存取、全屏壳、动作按钮都不在这里（见 docs/architecture/viewer.md）。

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  Camera,
  Captions,
  Crop,
  Flag,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  Repeat,
  RotateCcw,
  RotateCw,
  StepBack,
  StepForward,
  TriangleAlert,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { mmss } from "@/lib/viewer/review";
import type { Locator, ViewerController, ViewerSurfaceProps } from "@/lib/viewer/types";

/* ---------------- 常量与小工具 ---------------- */

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const DEFAULT_FPS = 24;
const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60] as const;
const REGION_NEAR_SEC = 0.5;
const UI_IDLE_MS = 2800;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface SelRegion extends NormRect {
  frameT: number;
}
interface AbRange {
  a: number | null;
  b: number | null;
}
interface FitRect {
  left: number;
  top: number;
  w: number;
  h: number;
}

// 非标准的前缀 API（iOS Safari 的视频全屏、旧 WebKit 的元素全屏）。
interface WebkitVideoElement extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
}
interface WebkitFsElement extends HTMLElement {
  webkitRequestFullscreen?: () => void;
}
interface WebkitFsDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
}

/** object-fit: contain 时，视频画面在舞台里的实际矩形（扣掉留边）。 */
function computeFit(stageW: number, stageH: number, vw: number, vh: number): FitRect {
  if (stageW <= 0 || stageH <= 0 || vw <= 0 || vh <= 0) return { left: 0, top: 0, w: stageW, h: stageH };
  const scale = Math.min(stageW / vw, stageH / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { left: (stageW - w) / 2, top: (stageH - h) / 2, w, h };
}

function snapFps(raw: number): number {
  for (const f of COMMON_FPS) if (Math.abs(raw - f) / f < 0.02) return f;
  return Math.round(raw * 100) / 100;
}

function mediaErrorText(code: number | undefined): string {
  switch (code) {
    case 1:
      return "播放被中止";
    case 2:
      return "网络中断，视频没加载完";
    case 3:
      return "视频解码失败";
    case 4:
      return "无法播放：地址失效或格式不支持";
    default:
      return "视频加载失败";
  }
}

/* ---------------- 控制层小件 ---------------- */

function Btn({
  label,
  onClick,
  active,
  disabled,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={(e) => {
        onClick();
        // 鼠标/触控点击后把焦点还给根节点：否则按钮持有焦点，空格会二次触发这个按钮而不是播放/暂停。
        if (e.detail > 0) {
          const btn = e.currentTarget;
          btn.blur();
          btn.closest<HTMLElement>("[data-vs-root]")?.focus({ preventScroll: true });
        }
      }}
      className={cn(
        "inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-full px-2 text-[13px] font-medium text-white/90 transition-colors duration-150",
        "hover:bg-white/15 active:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
        "disabled:cursor-not-allowed disabled:opacity-35 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
        active && "bg-white/20 text-amber-200",
        className,
      )}
    >
      {children}
    </button>
  );
}

interface BarMark {
  a: number;
  b?: number;
}

function ProgressBar({
  duration,
  current,
  buffered,
  ab,
  marks,
  compact,
  onScrub,
}: {
  duration: number;
  current: number;
  buffered: ReadonlyArray<readonly [number, number]>;
  ab: AbRange;
  marks: readonly BarMark[];
  compact: boolean;
  onScrub: (t: number, phase: "start" | "move" | "end") => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const enabled = duration > 0;

  const fracAt = (clientX: number): number => {
    const el = ref.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return r.width > 0 ? clamp01((clientX - r.left) / r.width) : 0;
  };

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    setDrag(true);
    const f = fracAt(e.clientX);
    setHover(f);
    onScrub(f * duration, "start");
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    const f = fracAt(e.clientX);
    setHover(f);
    if (dragging.current) onScrub(f * duration, "move");
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    setDrag(false);
    onScrub(fracAt(e.clientX) * duration, "end");
    if (e.pointerType !== "mouse") setHover(null);
  };

  const pct = (t: number) => `${enabled ? clamp01(t / duration) * 100 : 0}%`;
  const showThumb = !compact || drag || hover != null;

  return (
    <div
      ref={ref}
      role="slider"
      aria-label="播放进度"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(current)}
      aria-valuetext={`${mmss(current)} / ${mmss(duration)}`}
      aria-disabled={!enabled}
      data-vs-bar
      className={cn("group relative flex h-11 w-full items-center", enabled ? "cursor-pointer" : "cursor-default")}
      style={{ touchAction: "none" }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerLeave={() => {
        if (!dragging.current) setHover(null);
      }}
    >
      <div className={cn("relative w-full rounded-full bg-white/25 transition-[height] duration-150", hover != null || drag ? "h-[6px]" : "h-[4px]")}>
        {buffered.map(([s, e], i) => (
          <div key={i} className="absolute inset-y-0 rounded-full bg-white/30" style={{ left: pct(s), width: `calc(${pct(e)} - ${pct(s)})` }} />
        ))}
        {ab.a != null && (
          <div
            className="absolute inset-y-0 bg-sky-400/60"
            style={{ left: pct(ab.a), width: ab.b != null ? `calc(${pct(ab.b)} - ${pct(ab.a)})` : "2px" }}
          />
        )}
        {marks
          .filter((m) => m.b != null && m.b > m.a)
          .map((m, i) => (
            <div key={`r${i}`} className="absolute inset-y-0 rounded-full bg-amber-300/50" style={{ left: pct(m.a), width: `calc(${pct(m.b ?? m.a)} - ${pct(m.a)})` }} />
          ))}
        <div className="absolute inset-y-0 left-0 rounded-full bg-white" style={{ width: pct(current) }} />
        {marks.map((m, i) => (
          <div
            key={`d${i}`}
            className="pointer-events-none absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-300 ring-1 ring-black/50"
            style={{ left: pct(m.a) }}
          />
        ))}
        {showThumb && enabled && (
          <div
            className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_3px_rgba(0,0,0,0.25)]"
            style={{ left: pct(current) }}
          />
        )}
      </div>
      {hover != null && enabled && (
        <div
          className="pointer-events-none absolute bottom-full mb-0.5 -translate-x-1/2 rounded-md bg-black/80 px-2 py-0.5 text-[13px] tabular-nums text-white"
          style={{ left: `${clamp(hover * 100, 4, 96)}%` }}
        >
          {mmss(hover * duration)}
        </div>
      )}
    </div>
  );
}

/* ---------------- 主体 ---------------- */

export default function VideoSurface(props: ViewerSurfaceProps) {
  // 换成品/换地址＝整套状态重来（时间、A-B、框选、错误态都不应串到下一件）。
  return <VideoSurfaceInner key={`${props.asset.id}|${props.asset.url ?? ""}`} {...props} />;
}

function VideoSurfaceInner({ asset, density, annotations, controllerRef, onRequestMark, active }: ViewerSurfaceProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLTrackElement>(null);

  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(asset.durationSec && asset.durationSec > 0 ? asset.durationSec : 0);
  const [buffered, setBuffered] = useState<Array<[number, number]>>([]);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [everPlayed, setEverPlayed] = useState(false);
  const [metaReady, setMetaReady] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cors, setCors] = useState<"anonymous" | undefined>("anonymous");
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fsActive, setFsActive] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);
  const [capsOn, setCapsOn] = useState(false);
  const [capText, setCapText] = useState("");
  const [ab, setAbState] = useState<AbRange>({ a: null, b: null });
  const [regionMode, setRegionMode] = useState(false);
  const [sel, setSelState] = useState<SelRegion | null>(null);
  const [draft, setDraft] = useState<NormRect | null>(null);
  const [highlight, setHighlight] = useState<NormRect | null>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [vdim, setVdim] = useState<{ w: number; h: number } | null>(null);
  const [uiVisible, setUiVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const d: "inline" | "full" = fsActive ? "full" : density;
  const full = d === "full";

  // 给事件处理器读「最新值」的镜像（处理器只注册一次，不能闭包到旧 state）。
  const abRef = useRef<AbRange>({ a: null, b: null });
  const selRef = useRef<SelRegion | null>(null);
  const curRef = useRef(0);
  const durRef = useRef(duration);
  const fpsRef = useRef(DEFAULT_FPS);
  const scrubRef = useRef(false);
  const corsRef = useRef<"anonymous" | undefined>("anonymous");
  const metaReadyRef = useRef(false);
  const resumeRef = useRef(0);
  const autoplayRef = useRef(false);
  const revealTimer = useRef<number | null>(null);
  const highlightTimer = useRef<number | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const uiTimer = useRef<number | null>(null);
  const activeRef = useRef(active);
  const densityRef = useRef(d);
  const onMarkRef = useRef(onRequestMark);
  const menuOpenRef = useRef(false);
  const playingRef = useRef(false);
  const hoverRootRef = useRef(false);

  useEffect(() => {
    activeRef.current = active;
    densityRef.current = d;
    onMarkRef.current = onRequestMark;
    menuOpenRef.current = menuOpen;
    playingRef.current = playing;
    durRef.current = duration;
  });

  const setAB = useCallback((next: AbRange) => {
    abRef.current = next;
    setAbState(next);
  }, []);
  const setSel = useCallback((next: SelRegion | null) => {
    selRef.current = next;
    setSelState(next);
  }, []);

  const flash = useCallback((msg: string, ms = 2600) => {
    setNotice(msg);
    if (noticeTimer.current != null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), ms);
  }, []);

  const showUi = useCallback(() => {
    setUiVisible(true);
    if (uiTimer.current != null) window.clearTimeout(uiTimer.current);
    uiTimer.current = window.setTimeout(() => {
      if (playingRef.current && !menuOpenRef.current && !scrubRef.current) setUiVisible(false);
    }, UI_IDLE_MS);
  }, []);

  const cancelReveal = useCallback(() => {
    if (revealTimer.current != null) {
      window.clearTimeout(revealTimer.current);
      revealTimer.current = null;
    }
  }, []);

  const clearHighlight = useCallback(() => {
    if (highlightTimer.current != null) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = null;
    setHighlight(null);
  }, []);

  /* ---- 基础动作 ---- */

  const play = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    cancelReveal();
    void v.play().catch(() => {
      /* 被浏览器策略打断/来源失效：error 事件会接管，不在这里报 */
    });
  }, [cancelReveal]);

  const pause = useCallback(() => {
    cancelReveal();
    videoRef.current?.pause();
  }, [cancelReveal]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) play();
    else pause();
  }, [play, pause]);

  /** user=true：用户主动改位置（清掉框选/高亮/定时停留）；false：内部循环跳转。 */
  const seekTo = useCallback(
    (t: number, user = true) => {
      const v = videoRef.current;
      if (!v) return;
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : durRef.current;
      const next = clamp(t, 0, dur > 0 ? dur : Math.max(0, t));
      v.currentTime = next;
      curRef.current = next;
      setCurrent(next);
      if (user) {
        cancelReveal();
        setSel(null);
        clearHighlight();
      }
    },
    [cancelReveal, setSel, clearHighlight],
  );

  const stepFrame = useCallback(
    (dir: 1 | -1) => {
      const v = videoRef.current;
      if (!v) return;
      if (!v.paused) {
        flash("逐帧需要先暂停");
        return;
      }
      const fps = fpsRef.current;
      const n = Math.floor(v.currentTime * fps + 1e-4);
      seekTo((n + dir + 0.5) / fps);
    },
    [flash, seekTo],
  );

  const setRateTo = useCallback(
    (r: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.defaultPlaybackRate = r;
      v.playbackRate = r;
      v.preservesPitch = true;
      setRate(r);
      flash(`倍速 ${r}×`, 1200);
    },
    [flash],
  );

  const rateStep = useCallback(
    (dir: 1 | -1) => {
      const v = videoRef.current;
      const cur = v ? v.playbackRate : 1;
      let idx = 0;
      RATES.forEach((r, i) => {
        if (Math.abs(r - cur) < Math.abs(RATES[idx] - cur)) idx = i;
      });
      setRateTo(RATES[clamp(idx + dir, 0, RATES.length - 1)]);
    },
    [setRateTo],
  );

  const adjustVolume = useCallback(
    (delta: number) => {
      const v = videoRef.current;
      if (!v) return;
      if (delta > 0 && v.muted) v.muted = false;
      v.volume = clamp01(Math.round((v.volume + delta) * 100) / 100);
      flash(`音量 ${Math.round(v.volume * 100)}%`, 1000);
    },
    [flash],
  );

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (v) v.muted = !v.muted;
  }, []);

  /** L 键三态：设 A → 设 B → 取消。 */
  const cycleAB = useCallback(() => {
    const t = curRef.current;
    const { a, b } = abRef.current;
    if (a == null) {
      setAB({ a: t, b: null });
      flash(`已设 A 点 ${mmss(t)}`);
    } else if (b == null) {
      const lo = Math.min(a, t);
      const hi = Math.max(a, t);
      if (hi - lo < 0.3) {
        flash("B 点离 A 点太近，请再往后选");
        return;
      }
      setAB({ a: lo, b: hi });
      flash(`循环 ${mmss(lo)}–${mmss(hi)}`);
    } else {
      setAB({ a: null, b: null });
      flash("已取消 A-B 循环");
    }
  }, [setAB, flash]);

  const toggleFullscreen = useCallback(() => {
    const root = rootRef.current as WebkitFsElement | null;
    const v = videoRef.current as WebkitVideoElement | null;
    const doc = document as WebkitFsDocument;
    const cur = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    if (cur) {
      if (doc.exitFullscreen) void doc.exitFullscreen().catch(() => undefined);
      else doc.webkitExitFullscreen?.();
      return;
    }
    if (root?.requestFullscreen) {
      void root.requestFullscreen().catch(() => flash("无法进入全屏"));
    } else if (root?.webkitRequestFullscreen) {
      root.webkitRequestFullscreen();
    } else if (v?.webkitEnterFullscreen) {
      // iOS 只允许 <video> 自身全屏（会换成系统控件）；我们的控制层此时不可用，这是平台限制。
      v.webkitEnterFullscreen();
    } else {
      flash("当前浏览器不支持全屏");
    }
  }, [flash]);

  const togglePip = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => undefined);
    } else {
      void v.requestPictureInPicture().catch(() => flash("画中画不可用"));
    }
  }, [flash]);

  const captureFrame = useCallback(() => {
    const v = videoRef.current;
    if (!v || v.videoWidth <= 0 || v.videoHeight <= 0) {
      flash("画面尚未就绪，无法截帧");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      flash("截帧失败：浏览器不支持画布");
      return;
    }
    const t = v.currentTime;
    try {
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      // 跨域且无 CORS 时画布被污染，导出会抛 SecurityError——如实告知，不假装成功。
      canvas.toBlob((blob) => {
        if (!blob) {
          flash("截帧失败");
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const base = (asset.title?.trim() || "frame").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
        a.download = `${base}-${mmss(t).replace(":", "m")}s.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 4000);
        flash(`已截取 ${mmss(t)} 处的画面`);
      }, "image/png");
    } catch (err) {
      if (err instanceof DOMException && err.name === "SecurityError") flash("该来源不允许截帧");
      else flash("截帧失败");
    }
  }, [asset.title, flash]);

  const retry = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    resumeRef.current = curRef.current;
    autoplayRef.current = true;
    setError(null);
    setMetaReady(false);
    metaReadyRef.current = false;
    setWaiting(false);
    v.load();
  }, []);

  const replay = useCallback(() => {
    seekTo(0);
    play();
  }, [seekTo, play]);

  const toggleRegionMode = useCallback(() => {
    setRegionMode((on) => {
      const next = !on;
      if (next) {
        videoRef.current?.pause();
        flash("在画面上拖动框选", 3500);
      }
      return next;
    });
  }, [flash]);

  /* ---- 原生事件（一次注册，卸载清理） ---- */

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;

    const syncBuffered = () => {
      const out: Array<[number, number]> = [];
      for (let i = 0; i < v.buffered.length; i++) out.push([v.buffered.start(i), v.buffered.end(i)]);
      setBuffered(out);
    };
    const syncDuration = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) setDuration(v.duration);
    };
    const tick = () => {
      const t = v.currentTime;
      curRef.current = t;
      if (!scrubRef.current) setCurrent(t);
      const { a, b } = abRef.current;
      if (a != null && b != null && !v.paused && t >= b && t < b + 0.6) {
        v.currentTime = a;
        curRef.current = a;
      }
    };
    const loop = () => {
      raf = requestAnimationFrame(loop);
      tick();
    };
    const startRaf = () => {
      if (!raf) raf = requestAnimationFrame(loop);
    };
    const stopRaf = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const on: Array<[string, () => void]> = [
      [
        "play",
        () => {
          setPlaying(true);
          setEnded(false);
          setEverPlayed(true);
          setSel(null);
          setRegionMode(false);
          clearHighlight();
          startRaf();
        },
      ],
      [
        "pause",
        () => {
          setPlaying(false);
          setWaiting(false);
          stopRaf();
          tick();
        },
      ],
      [
        "ended",
        () => {
          setPlaying(false);
          setEnded(true);
          stopRaf();
          tick();
          setUiVisible(true);
        },
      ],
      ["waiting", () => setWaiting(true)],
      ["playing", () => setWaiting(false)],
      ["canplay", () => setWaiting(false)],
      ["seeking", () => setEnded(false)],
      [
        "seeked",
        () => {
          setWaiting(false);
          tick();
          syncBuffered();
        },
      ],
      [
        "loadedmetadata",
        () => {
          metaReadyRef.current = true;
          setMetaReady(true);
          setError(null);
          syncDuration();
          if (v.videoWidth > 0) setVdim({ w: v.videoWidth, h: v.videoHeight });
          v.preservesPitch = true;
          if (resumeRef.current > 0) {
            v.currentTime = resumeRef.current;
            curRef.current = resumeRef.current;
            setCurrent(resumeRef.current);
            resumeRef.current = 0;
          }
          if (autoplayRef.current) {
            autoplayRef.current = false;
            void v.play().catch(() => undefined);
          }
        },
      ],
      ["durationchange", syncDuration],
      ["resize", () => v.videoWidth > 0 && setVdim({ w: v.videoWidth, h: v.videoHeight })],
      ["progress", syncBuffered],
      [
        "timeupdate",
        () => {
          tick();
          syncBuffered();
        },
      ],
      [
        "volumechange",
        () => {
          setVolume(v.volume);
          setMuted(v.muted);
        },
      ],
      ["ratechange", () => setRate(v.playbackRate)],
      [
        "error",
        () => {
          const t = v.currentTime;
          // 跨域源不带 CORS 头时，crossOrigin=anonymous 会让播放本身失败；先去掉它再试一次（代价：之后无法截帧）。
          if (corsRef.current === "anonymous" && !metaReadyRef.current) {
            resumeRef.current = Math.max(resumeRef.current, t);
            corsRef.current = undefined;
            setCors(undefined);
            return;
          }
          curRef.current = Math.max(curRef.current, t);
          setError(mediaErrorText(v.error?.code));
          setPlaying(false);
          setWaiting(false);
          stopRaf();
          setUiVisible(true);
        },
      ],
    ];
    for (const [name, fn] of on) v.addEventListener(name, fn);

    // fps 估算：连续帧的 mediaTime 差的中位数；浏览器没有 requestVideoFrameCallback 就保持 24。
    let rv = 0;
    let lastFrame: { mt: number; pf: number } | null = null;
    const samples: number[] = [];
    const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (lastFrame && meta.presentedFrames - lastFrame.pf === 1) {
        const delta = meta.mediaTime - lastFrame.mt;
        if (delta > 1 / 125 && delta < 1 / 10) samples.push(delta);
        if (samples.length > 15) samples.shift();
      } else if (lastFrame && meta.presentedFrames - lastFrame.pf !== 1) {
        samples.length = 0;
      }
      lastFrame = { mt: meta.mediaTime, pf: meta.presentedFrames };
      if (samples.length >= 8) {
        const sorted = [...samples].sort((x, y) => x - y);
        fpsRef.current = snapFps(1 / sorted[Math.floor(sorted.length / 2)]);
        if (samples.length >= 15) return; // 估稳了，不再每帧回调
      }
      rv = v.requestVideoFrameCallback(onFrame);
    };
    if ("requestVideoFrameCallback" in v) rv = v.requestVideoFrameCallback(onFrame);

    return () => {
      for (const [name, fn] of on) v.removeEventListener(name, fn);
      stopRaf();
      if (rv && "cancelVideoFrameCallback" in v) v.cancelVideoFrameCallback(rv);
    };
  }, [setSel, clearHighlight]);

  // 去掉 crossOrigin 后属性已写入 DOM，需重新加载才生效。
  useEffect(() => {
    if (cors === undefined && corsRef.current === undefined) {
      const v = videoRef.current;
      if (!v) return;
      autoplayRef.current = autoplayRef.current || !v.paused;
      v.load();
    }
  }, [cors]);

  // 画中画 / 全屏状态同步 + 舞台尺寸。
  useEffect(() => {
    const v = videoRef.current;
    const root = rootRef.current;
    const stage = stageRef.current;
    const doc = document as WebkitFsDocument;
    setPipSupported(!!document.pictureInPictureEnabled && !!v && typeof v.requestPictureInPicture === "function" && !v.disablePictureInPicture);
    const onFs = () => {
      const el = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
      setFsActive(!!root && el === root);
    };
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    let ro: ResizeObserver | null = null;
    if (stage && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver((entries) => {
        const r = entries[0]?.contentRect;
        if (r) setStageSize({ w: r.width, h: r.height });
      });
      ro.observe(stage);
    }
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onFs);
      ro?.disconnect();
    };
  }, []);

  // 字幕：自己渲染 cue（隐藏模式也会触发 cuechange），避免原生字幕被我们的控制条盖住。
  useEffect(() => {
    const el = trackRef.current;
    if (!el || !asset.captionsUrl) return;
    const tr = el.track;
    tr.mode = "hidden";
    const onCue = () => {
      const cues = tr.activeCues;
      const parts: string[] = [];
      if (cues) {
        for (let i = 0; i < cues.length; i++) {
          const c = cues[i];
          if (typeof VTTCue !== "undefined" && c instanceof VTTCue) parts.push(c.text.replace(/<[^>]+>/g, ""));
        }
      }
      setCapText(parts.join("\n"));
    };
    tr.addEventListener("cuechange", onCue);
    return () => tr.removeEventListener("cuechange", onCue);
  }, [asset.captionsUrl, cors]);

  // active=false：必须暂停。
  useEffect(() => {
    if (!active) {
      cancelReveal();
      videoRef.current?.pause();
    }
  }, [active, cancelReveal]);

  // 全屏沉浸：挂载且 active 时把焦点放到根，让快捷键直接生效。
  useEffect(() => {
    if (density === "full" && active) rootRef.current?.focus({ preventScroll: true });
  }, [density, active]);

  // 卸载清理定时器。
  useEffect(
    () => () => {
      for (const r of [revealTimer, highlightTimer, noticeTimer, uiTimer]) {
        if (r.current != null) window.clearTimeout(r.current);
      }
      videoRef.current?.pause();
    },
    [],
  );

  // 控制柄。
  useEffect(() => {
    const controller: ViewerController = {
      capture() {
        const s = selRef.current;
        if (s) return { locator: { t: "region", x: s.x, y: s.y, w: s.w, h: s.h, frameT: s.frameT } satisfies Locator };
        const { a, b } = abRef.current;
        if (a != null && b != null) return { locator: { t: "time", a, b } satisfies Locator };
        const v = videoRef.current;
        return { locator: { t: "time", a: v ? v.currentTime : curRef.current } satisfies Locator };
      },
      reveal(loc) {
        const v = videoRef.current;
        if (!v) return;
        if (loc.t === "time") {
          clearHighlight();
          seekTo(loc.a);
          void v.play().catch(() => undefined);
          revealTimer.current = window.setTimeout(() => {
            revealTimer.current = null;
            videoRef.current?.pause();
          }, 1000);
        } else if (loc.t === "region") {
          v.pause();
          seekTo(loc.frameT ?? v.currentTime);
          setHighlight({ x: loc.x, y: loc.y, w: loc.w, h: loc.h });
          highlightTimer.current = window.setTimeout(() => {
            highlightTimer.current = null;
            setHighlight(null);
          }, 5000);
        }
      },
      loop(range) {
        if (range && range.b > range.a) {
          setAB({ a: range.a, b: range.b });
          seekTo(range.a, false);
          void videoRef.current?.play().catch(() => undefined);
        } else {
          setAB({ a: null, b: null });
        }
      },
      play,
      pause,
    };
    controllerRef.current = controller;
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [controllerRef, seekTo, setAB, clearHighlight, play, pause]);

  // 键盘：窗口捕获阶段，种类内语义优先（←/→ 是时间步进）；Esc 不处理，交给壳。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!activeRef.current) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
        // 壳里别的按钮持有焦点时，空格/回车留给它自己的激活语义。
        if ((e.key === " " || e.key === "Enter") && tag === "BUTTON" && !rootRef.current?.contains(target)) return;
      }
      if (densityRef.current === "inline") {
        const root = rootRef.current;
        const inRoot = !!root && !!target && root.contains(target);
        if (!inRoot && !hoverRootRef.current) return;
      }
      const v = videoRef.current;
      if (!v) return;
      const big = e.shiftKey ? 15 : 5;
      let handled = true;
      switch (e.key) {
        case " ":
          togglePlay();
          break;
        case "ArrowLeft":
          seekTo(v.currentTime - big);
          break;
        case "ArrowRight":
          seekTo(v.currentTime + big);
          break;
        case "ArrowUp":
          adjustVolume(0.1);
          break;
        case "ArrowDown":
          adjustVolume(-0.1);
          break;
        case "m":
        case "M":
          toggleMute();
          break;
        case "[":
          rateStep(-1);
          break;
        case "]":
          rateStep(1);
          break;
        case "f":
        case "F":
          onMarkRef.current();
          break;
        case "l":
        case "L":
          cycleAB();
          break;
        case ",":
          stepFrame(-1);
          break;
        case ".":
          stepFrame(1);
          break;
        default:
          if (/^[0-9]$/.test(e.key) && !e.shiftKey) {
            const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : durRef.current;
            if (dur > 0) seekTo((Number(e.key) / 10) * dur);
          } else {
            handled = false;
          }
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        showUi();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [togglePlay, seekTo, adjustVolume, toggleMute, rateStep, cycleAB, stepFrame, showUi]);

  // 倍速菜单：点外面关闭。
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-vs-menu]")) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [menuOpen]);

  /* ---- 进度条拖动 ---- */

  const onScrub = useCallback(
    (t: number, phase: "start" | "move" | "end") => {
      if (phase === "start") {
        scrubRef.current = true;
        setUiVisible(true);
      }
      seekTo(t);
      if (phase === "end") {
        scrubRef.current = false;
        showUi();
      }
    },
    [seekTo, showUi],
  );

  /* ---- 画面层：点按播放/暂停 + 框选 ---- */

  const fit = useMemo(() => {
    const w = vdim?.w ?? asset.width ?? 0;
    const h = vdim?.h ?? asset.height ?? 0;
    return computeFit(stageSize.w, stageSize.h, w, h);
  }, [stageSize.w, stageSize.h, vdim, asset.width, asset.height]);

  const drawRef = useRef<{ sx: number; sy: number } | null>(null);
  const tapRef = useRef<{ x: number; y: number } | null>(null);

  const toNorm = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const r = stageRef.current?.getBoundingClientRect();
      if (!r || fit.w <= 0 || fit.h <= 0) return { x: 0, y: 0 };
      return { x: clamp01((clientX - r.left - fit.left) / fit.w), y: clamp01((clientY - r.top - fit.top) / fit.h) };
    },
    [fit],
  );

  const rectOf = (p0: { x: number; y: number }, p1: { x: number; y: number }): NormRect => ({
    x: Math.min(p0.x, p1.x),
    y: Math.min(p0.y, p1.y),
    w: Math.abs(p1.x - p0.x),
    h: Math.abs(p1.y - p0.y),
  });

  const onStageDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const v = videoRef.current;
    showUi();
    const wantsDraw = full && !!v && metaReady && (regionMode || (e.shiftKey && v.paused));
    if (wantsDraw) {
      e.currentTarget.setPointerCapture(e.pointerId);
      const p = toNorm(e.clientX, e.clientY);
      drawRef.current = { sx: p.x, sy: p.y };
      setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
      return;
    }
    tapRef.current = { x: e.clientX, y: e.clientY };
  };
  const onStageMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    showUi();
    const dr = drawRef.current;
    if (dr) setDraft(rectOf({ x: dr.sx, y: dr.sy }, toNorm(e.clientX, e.clientY)));
  };
  const onStageUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const dr = drawRef.current;
    if (dr) {
      drawRef.current = null;
      setDraft(null);
      const r = rectOf({ x: dr.sx, y: dr.sy }, toNorm(e.clientX, e.clientY));
      setRegionMode(false);
      if (r.w < 0.01 || r.h < 0.01) {
        setSel(null);
        return;
      }
      const t = videoRef.current?.currentTime ?? curRef.current;
      setSel({ ...r, frameT: t });
      flash("已框选，按 F 或点「标记」记录这一处", 3500);
      return;
    }
    const tap = tapRef.current;
    tapRef.current = null;
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 10) togglePlay();
  };
  const onStageCancel = () => {
    drawRef.current = null;
    tapRef.current = null;
    setDraft(null);
  };

  /* ---- 派生渲染数据 ---- */

  const marks = useMemo<BarMark[]>(
    () =>
      annotations.flatMap((a) => (a.locator.t === "time" ? [{ a: a.locator.a, b: a.locator.b }] : [])),
    [annotations],
  );
  const nearRegions = useMemo(
    () =>
      annotations.flatMap((a) => {
        const l = a.locator;
        return l.t === "region" && l.frameT != null && Math.abs(l.frameT - current) <= REGION_NEAR_SEC
          ? [{ id: a.id, x: l.x, y: l.y, w: l.w, h: l.h }]
          : [];
      }),
    [annotations, current],
  );

  const boxStyle = (r: NormRect) => ({
    left: fit.left + r.x * fit.w,
    top: fit.top + r.y * fit.h,
    width: r.w * fit.w,
    height: r.h * fit.h,
  });

  const hasCaps = !!asset.captionsUrl;
  const url = asset.url ?? "";
  const src = url && !asset.cover && !url.includes("#") ? `${url}#t=0.001` : url; // 无封面：靠首帧当海报（iOS 需要媒体片段才渲染首帧）
  const spinner = !error && ((!metaReady && (everPlayed || full)) || waiting);
  const controlsShown = uiVisible || !playing || !!error || ended || menuOpen;
  const bigPlay = !playing && !ended && !error && !spinner && (!everPlayed || !full);
  const aspect = asset.width && asset.height ? `${asset.width} / ${asset.height}` : "16 / 9";
  const timeText = `${mmss(current)} / ${duration > 0 ? mmss(duration) : "--:--"}`;
  const VolIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  if (!url) {
    return (
      <div className="flex min-h-[160px] w-full items-center justify-center rounded-[18px] bg-black px-4 text-[13px] text-white/70">
        没有可播放的视频地址
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-vs-root
      tabIndex={0}
      aria-label={asset.title ? `视频：${asset.title}` : "视频播放器"}
      className={cn(
        "relative isolate select-none overflow-hidden bg-black text-white outline-none [-webkit-tap-highlight-color:transparent]",
        fsActive
          ? "h-full w-full"
          : full
            ? "h-full min-h-[240px] w-full"
            : "max-h-[min(420px,52dvh)] w-full rounded-[18px]",
        !controlsShown && playing && "cursor-none",
      )}
      style={!full && !fsActive ? { aspectRatio: aspect } : undefined}
      onPointerEnter={() => {
        hoverRootRef.current = true;
      }}
      onPointerLeave={() => {
        hoverRootRef.current = false;
      }}
      onPointerMove={showUi}
    >
      <div ref={stageRef} className="absolute inset-0">
        <video
          ref={videoRef}
          src={src}
          poster={asset.cover}
          crossOrigin={cors}
          preload="metadata"
          playsInline
          className="h-full w-full bg-black object-contain"
        >
          {hasCaps && <track ref={trackRef} kind="subtitles" src={asset.captionsUrl} srcLang="zh" label="字幕" />}
        </video>

        {/* 画面层：点按播放、框选、标记框 */}
        <div
          className="absolute inset-0 z-10"
          style={{ touchAction: regionMode ? "none" : "manipulation", cursor: regionMode ? "crosshair" : undefined }}
          onPointerDown={onStageDown}
          onPointerMove={onStageMove}
          onPointerUp={onStageUp}
          onPointerCancel={onStageCancel}
          onDoubleClick={() => {
            if (!regionMode) toggleFullscreen();
          }}
        >
          {nearRegions.map((r) => (
            <div key={r.id} className="pointer-events-none absolute rounded-[2px] border-2 border-amber-300 bg-amber-300/10" style={boxStyle(r)} />
          ))}
          {highlight && (
            <div className="pointer-events-none absolute animate-pulse rounded-[2px] border-[3px] border-amber-300 bg-amber-300/15" style={boxStyle(highlight)} />
          )}
          {sel && !draft && (
            <div className="pointer-events-none absolute rounded-[2px] border-2 border-dashed border-sky-300 bg-sky-300/10" style={boxStyle(sel)} />
          )}
          {draft && (
            <div className="pointer-events-none absolute rounded-[2px] border-2 border-dashed border-sky-300 bg-sky-300/15" style={boxStyle(draft)} />
          )}
        </div>
      </div>

      {/* 字幕 */}
      {hasCaps && capsOn && capText && (
        <div
          className={cn(
            "pointer-events-none absolute inset-x-4 z-20 flex justify-center transition-[bottom] duration-200",
            controlsShown ? (full ? "bottom-28" : "bottom-14") : "bottom-6",
          )}
        >
          <p className="max-w-[90%] whitespace-pre-line rounded-lg bg-black/70 px-3 py-1 text-center text-[15px] leading-snug text-white">{capText}</p>
        </div>
      )}

      {/* 状态层 */}
      {spinner && (
        <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2">
          <Loader2 className="h-9 w-9 animate-spin text-white/90" aria-hidden="true" />
          {waiting && metaReady && <span className="rounded-full bg-black/60 px-3 py-1 text-[13px] text-white/90">缓冲中…</span>}
        </div>
      )}
      {bigPlay && (
        <button
          type="button"
          aria-label="播放"
          onClick={togglePlay}
          className="absolute left-1/2 top-1/2 z-20 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-md transition-transform duration-150 hover:bg-black/65 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 [touch-action:manipulation]"
        >
          <Play className="ml-1 h-8 w-8" fill="currentColor" aria-hidden="true" />
        </button>
      )}
      {ended && !error && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/35">
          <button
            type="button"
            onClick={replay}
            className="flex h-12 items-center gap-2 rounded-full bg-white/20 px-5 text-[14px] font-medium text-white backdrop-blur-md transition-colors hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 [touch-action:manipulation]"
          >
            <RotateCcw className="h-5 w-5" aria-hidden="true" />
            重播
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/80 p-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/20 text-red-300">
            <TriangleAlert className="h-6 w-6" aria-hidden="true" />
          </div>
          <p className="text-[14px] font-medium text-white">{error}</p>
          {curRef.current > 0 && <p className="text-[13px] text-white/60">重试会回到 {mmss(curRef.current)}</p>}
          <button
            type="button"
            onClick={retry}
            className="flex h-11 items-center gap-1.5 rounded-full bg-white/20 px-5 text-[14px] font-medium text-white backdrop-blur-md transition-colors hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 [touch-action:manipulation]"
          >
            <RotateCw className="h-4 w-4" aria-hidden="true" />
            重试
          </button>
        </div>
      )}

      {/* 提示条 */}
      {notice && (
        <div role="status" aria-live="polite" className="pointer-events-none absolute left-1/2 top-3 z-40 max-w-[88%] -translate-x-1/2 rounded-full bg-black/75 px-3.5 py-1.5 text-center text-[13px] text-white backdrop-blur-md">
          {notice}
        </div>
      )}
      {regionMode && (
        <div className="pointer-events-none absolute left-1/2 top-12 z-30 -translate-x-1/2 rounded-full bg-sky-500/80 px-3 py-1 text-[13px] text-white">框选模式：在画面上拖动</div>
      )}

      {/* 控制层 */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-2 pb-[max(0.25rem,env(safe-area-inset-bottom))] transition-opacity duration-200",
          full ? "pt-12" : "pt-8",
          controlsShown ? "opacity-100" : "opacity-0",
          !controlsShown && "[&>*]:!pointer-events-none",
        )}
      >
        {full ? (
          <div className="pointer-events-auto">
            <ProgressBar duration={duration} current={current} buffered={buffered} ab={ab} marks={marks} compact={false} onScrub={onScrub} />
            <div className="flex flex-wrap items-center justify-between gap-x-1">
              <div className="flex items-center">
                <Btn label={playing ? "暂停（空格）" : "播放（空格）"} onClick={togglePlay}>
                  {playing ? <Pause className="h-5 w-5" fill="currentColor" aria-hidden="true" /> : <Play className="h-5 w-5" fill="currentColor" aria-hidden="true" />}
                </Btn>
                <Btn label="上一帧（,）" onClick={() => stepFrame(-1)} disabled={playing || !metaReady}>
                  <StepBack className="h-5 w-5" aria-hidden="true" />
                </Btn>
                <Btn label="下一帧（.）" onClick={() => stepFrame(1)} disabled={playing || !metaReady}>
                  <StepForward className="h-5 w-5" aria-hidden="true" />
                </Btn>
                <span className="px-2 text-[13px] tabular-nums text-white/90">{timeText}</span>
              </div>
              <div className="flex flex-wrap items-center">
                <Btn label={ab.a == null ? "A-B 循环：设 A 点（L）" : ab.b == null ? "A-B 循环：设 B 点（L）" : "取消 A-B 循环（L）"} onClick={cycleAB} active={ab.a != null}>
                  <Repeat className="h-5 w-5" aria-hidden="true" />
                  {ab.a != null && <span className="tabular-nums">{ab.b == null ? "A" : "A-B"}</span>}
                </Btn>
                <Btn label="标记这一处（F）" onClick={() => onRequestMark()}>
                  <Flag className="h-5 w-5" aria-hidden="true" />
                </Btn>
                <Btn label={regionMode ? "退出框选" : "框选画面区域（或按住 Shift 拖动）"} onClick={toggleRegionMode} active={regionMode || !!sel}>
                  <Crop className="h-5 w-5" aria-hidden="true" />
                </Btn>
                {sel && (
                  <Btn label="清除框选" onClick={() => setSel(null)}>
                    <X className="h-5 w-5" aria-hidden="true" />
                  </Btn>
                )}
                <Btn label="截取当前帧为图片" onClick={captureFrame} disabled={!metaReady}>
                  <Camera className="h-5 w-5" aria-hidden="true" />
                </Btn>
                {hasCaps && (
                  <Btn label={capsOn ? "关闭字幕" : "打开字幕"} onClick={() => setCapsOn((v) => !v)} active={capsOn}>
                    <Captions className="h-5 w-5" aria-hidden="true" />
                  </Btn>
                )}
                <div className="relative" data-vs-menu>
                  <Btn label="倍速（[ ]）" onClick={() => setMenuOpen((o) => !o)} active={menuOpen} className="tabular-nums">
                    {rate}×
                  </Btn>
                  {menuOpen && (
                    <div role="menu" className="absolute bottom-full right-0 mb-2 w-24 rounded-2xl bg-black/85 p-1 shadow-xl backdrop-blur-xl">
                      {RATES.map((r) => (
                        <button
                          key={r}
                          type="button"
                          role="menuitemradio"
                          aria-checked={r === rate}
                          onClick={() => {
                            setRateTo(r);
                            setMenuOpen(false);
                            rootRef.current?.focus({ preventScroll: true });
                          }}
                          className={cn(
                            "flex h-11 w-full items-center justify-center rounded-xl text-[14px] tabular-nums transition-colors [touch-action:manipulation]",
                            r === rate ? "bg-white/20 text-amber-200" : "text-white/90 hover:bg-white/10",
                          )}
                        >
                          {r}×
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <Btn label={muted ? "取消静音（M）" : "静音（M）"} onClick={toggleMute}>
                  <VolIcon className="h-5 w-5" aria-hidden="true" />
                </Btn>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  aria-label="音量"
                  onChange={(e) => {
                    const v = videoRef.current;
                    if (!v) return;
                    v.muted = false;
                    v.volume = Number(e.target.value);
                  }}
                  onPointerUp={() => rootRef.current?.focus({ preventScroll: true })}
                  className="hidden h-11 w-20 cursor-pointer accent-white sm:block"
                />
                {pipSupported && (
                  <Btn label="画中画" onClick={togglePip}>
                    <PictureInPicture2 className="h-5 w-5" aria-hidden="true" />
                  </Btn>
                )}
                <Btn label={fsActive ? "退出全屏" : "全屏"} onClick={toggleFullscreen}>
                  {fsActive ? <Minimize className="h-5 w-5" aria-hidden="true" /> : <Maximize className="h-5 w-5" aria-hidden="true" />}
                </Btn>
              </div>
            </div>
          </div>
        ) : (
          <div className="pointer-events-auto flex items-center gap-1">
            <Btn label={playing ? "暂停" : "播放"} onClick={togglePlay}>
              {playing ? <Pause className="h-5 w-5" fill="currentColor" aria-hidden="true" /> : <Play className="h-5 w-5" fill="currentColor" aria-hidden="true" />}
            </Btn>
            <div className="min-w-0 flex-1">
              <ProgressBar duration={duration} current={current} buffered={buffered} ab={ab} marks={marks} compact onScrub={onScrub} />
            </div>
            <span className="shrink-0 px-1 text-[13px] tabular-nums text-white/90">{timeText}</span>
            <Btn label="全屏" onClick={toggleFullscreen}>
              <Maximize className="h-5 w-5" aria-hidden="true" />
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}
