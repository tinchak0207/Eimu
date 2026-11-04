"use client";

// 赏阅 · 分镜适配器：接触印样网格 + 「逐镜播放」animatic（图停 2.5s、视频播完）。
// 成员＝asset.children（image/video，按顺序）。点成员＝onOpenChild；capture 给「第N镜 标题」摘录。
// 键盘（种类内语义优先，会 stopPropagation 不让壳切成员）：←/→ 切镜，空格 播放/暂停，F 标记。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { mmss } from "@/lib/viewer/review";
import type { ViewAsset, ViewerController, ViewerSurfaceProps } from "@/lib/viewer/types";
import { cn } from "@/lib/utils";

const IMAGE_HOLD_MS = 2500;

function durationLabel(sec: number | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  return sec < 60 ? `${sec.toFixed(1)}s` : mmss(sec);
}

function shotLabel(child: ViewAsset | undefined, idx: number): string {
  const t = child?.title?.trim();
  return t ? `第${idx + 1}镜 ${t}` : `第${idx + 1}镜`;
}

/** 缩略图：只用该成员自己的封面/画面；没有就文字卡，绝不拿别的成员的图占位。 */
function Thumb({ child, idx, hovering }: { child: ViewAsset; idx: number; hovering: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isVideo = child.kind === "video";
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (hovering) void v.play().catch(() => undefined);
    else {
      v.pause();
      v.currentTime = 0;
    }
  }, [hovering]);

  const still = child.cover ?? (child.kind === "image" ? child.url : undefined);
  if (isVideo && child.url) {
    return (
      <video
        ref={videoRef}
        src={`${child.url}#t=0.1`}
        poster={child.cover}
        muted
        playsInline
        preload="metadata"
        className="h-full w-full object-cover"
      />
    );
  }
  if (still) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={still} alt={shotLabel(child, idx)} loading="lazy" className="h-full w-full object-cover" />;
  }
  return (
    <div className="flex h-full w-full items-center justify-center bg-white/5 px-2 text-center text-[13px] text-white/60">
      {child.title?.trim() || "无画面"}
    </div>
  );
}

export default function StoryboardSurface({
  asset,
  density,
  annotations,
  controllerRef,
  onRequestMark,
  active,
  onOpenChild,
}: ViewerSurfaceProps) {
  const full = density === "full";
  const shots = useMemo(() => asset.children ?? [], [asset.children]);
  const n = shots.length;
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [videoFailed, setVideoFailed] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const idxRef = useRef(0);
  idxRef.current = idx;
  const shotsRef = useRef(shots);
  shotsRef.current = shots;

  const cur: ViewAsset | undefined = shots[Math.min(idx, Math.max(0, n - 1))];

  // 成员数变化时收敛下标
  useEffect(() => {
    if (idx > Math.max(0, n - 1)) setIdx(Math.max(0, n - 1));
  }, [n, idx]);

  useEffect(() => {
    const controller: ViewerController = {
      capture() {
        const i = idxRef.current;
        return { locator: { t: "whole" }, excerpt: shotLabel(shotsRef.current[i], i) };
      },
      reveal() {
        /* 分镜无位置语义 */
      },
      play: () => setPlaying(true),
      pause: () => setPlaying(false),
    };
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef]);

  // 壳切走 → 暂停
  useEffect(() => {
    if (!active) setPlaying(false);
  }, [active]);

  useEffect(() => {
    if (full && active) rootRef.current?.focus({ preventScroll: true });
  }, [full, active]);

  const advance = useCallback(() => {
    if (idxRef.current < shotsRef.current.length - 1) setIdx(idxRef.current + 1);
    else setPlaying(false);
  }, []);

  // 图片（或视频不可播时）定时前进
  const curIsPlayableVideo = cur?.kind === "video" && !!cur.url && videoFailed !== cur.id;
  useEffect(() => {
    if (!playing || !active || n === 0 || curIsPlayableVideo) return;
    const t = window.setTimeout(advance, IMAGE_HOLD_MS);
    return () => window.clearTimeout(t);
  }, [playing, active, idx, n, curIsPlayableVideo, advance]);

  // 视频：随 playing 播放/暂停
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing && active) void v.play().catch(() => setVideoFailed(cur?.id ?? null));
    else v.pause();
  }, [playing, active, idx, cur?.id]);

  const go = useCallback(
    (to: number) => {
      if (n === 0) return;
      setIdx(Math.min(n - 1, Math.max(0, to)));
    },
    [n],
  );

  const togglePlay = useCallback(() => {
    if (n === 0) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    // 已到末镜：从头再播
    if (idxRef.current >= n - 1 && n > 1) setIdx(0);
    setPlaying(true);
  }, [n, playing]);

  const markedShots = useMemo(() => {
    const s = new Set<number>();
    for (const a of annotations) {
      const m = a.excerpt?.match(/^第(\d+)镜/);
      if (m) s.add(Number(m[1]) - 1);
    }
    return s;
  }, [annotations]);

  const totalSec = useMemo(() => {
    if (n === 0 || shots.some((s) => !(s.durationSec && s.durationSec > 0))) return null;
    return shots.reduce((sum, s) => sum + (s.durationSec ?? 0), 0);
  }, [shots, n]);

  if (n === 0) {
    return (
      <div className="flex min-h-[200px] w-full items-center justify-center bg-[#0b0f14] p-6 text-[14px] text-white/70">
        这份分镜还没有镜头
      </div>
    );
  }

  const stageMedia = (() => {
    if (!cur) return null;
    if (cur.kind === "video" && cur.url) {
      return (
        <video
          key={cur.id}
          ref={videoRef}
          src={cur.url}
          poster={cur.cover}
          muted={muted}
          playsInline
          preload="auto"
          onEnded={() => playing && advance()}
          onError={() => setVideoFailed(cur.id)}
          className="h-full w-full object-contain"
        />
      );
    }
    const still = cur.kind === "image" ? (cur.url ?? cur.cover) : cur.cover;
    if (still) {
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={still} alt={shotLabel(cur, idx)} className="h-full w-full object-contain" />;
    }
    return (
      <div className="flex h-full w-full items-center justify-center px-4 text-center text-[14px] text-white/60">
        {cur.title?.trim() || "这一镜没有画面"}
      </div>
    );
  })();

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      aria-label={`分镜：${asset.title ?? "未命名"}，共 ${n} 镜。左右方向键切镜，空格播放或暂停，F 标记当前镜`}
      onKeyDown={(e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          e.stopPropagation();
          go(idx - 1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          go(idx + 1);
        } else if (e.key === " " && target === e.currentTarget) {
          e.preventDefault();
          e.stopPropagation();
          togglePlay();
        } else if (e.key === "f" || e.key === "F") {
          e.preventDefault();
          e.stopPropagation();
          onRequestMark();
        }
      }}
      className={cn("flex w-full flex-col bg-[#0b0f14] text-white outline-none", full ? "h-full min-h-[320px]" : "")}
    >
      {/* animatic 舞台 */}
      <div className={cn("relative bg-black", full ? "min-h-0 flex-[3]" : "aspect-video")}>
        <div className="absolute inset-0">{stageMedia}</div>
        <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/60 px-3 py-1 text-[13px]">
          {shotLabel(cur, idx)}
          {durationLabel(cur?.durationSec) ? ` · ${durationLabel(cur?.durationSec)}` : ""}
        </div>
        {cur?.kind === "video" && videoFailed === cur.id && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-[13px] text-amber-300">
            这一镜的视频无法播放，已按 2.5 秒跳过
          </div>
        )}
      </div>

      {/* 进度条：每镜一段，点击跳镜 */}
      <div className="flex gap-0.5 px-3 pt-2" role="group" aria-label="镜头进度">
        {shots.map((s, i) => (
          <button
            key={s.id}
            type="button"
            onClick={() => go(i)}
            aria-label={`跳到${shotLabel(s, i)}`}
            aria-current={i === idx}
            className="group flex min-h-[44px] flex-1 items-center"
          >
            <span
              className={cn(
                "h-1.5 w-full rounded-full transition-colors group-hover:bg-white/60",
                i === idx ? "bg-white" : i < idx ? "bg-white/50" : "bg-white/20",
              )}
            />
          </button>
        ))}
      </div>

      {/* 控制条 */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
        <button
          type="button"
          onClick={() => go(idx - 1)}
          disabled={idx <= 0}
          aria-label="上一镜"
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full hover:bg-white/10 disabled:opacity-40"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={togglePlay}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-white px-5 text-[14px] font-medium text-black hover:bg-white/90"
        >
          {playing ? <Pause className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
          {playing ? "暂停" : "逐镜播放"}
        </button>
        <button
          type="button"
          onClick={() => go(idx + 1)}
          disabled={idx >= n - 1}
          aria-label="下一镜"
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full hover:bg-white/10 disabled:opacity-40"
        >
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setMuted((m) => !m)}
          aria-label={muted ? "取消静音" : "静音"}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full hover:bg-white/10"
        >
          {muted ? <VolumeX className="h-4 w-4" aria-hidden="true" /> : <Volume2 className="h-4 w-4" aria-hidden="true" />}
        </button>
        <span className="text-[13px] text-white/60">
          第 {idx + 1}/{n} 镜{totalSec != null ? ` · 共约 ${mmss(totalSec)}` : ""}
        </span>
        <button
          type="button"
          onClick={onRequestMark}
          className="ml-auto inline-flex min-h-[44px] items-center rounded-full bg-white/15 px-4 text-[14px] hover:bg-white/25"
        >
          标记这一镜
        </button>
      </div>

      {/* 接触印样 */}
      <div
        role="list"
        aria-label="镜头印样"
        className={cn(
          "grid gap-2 overflow-y-auto border-t border-white/10 p-3",
          full ? "min-h-0 flex-[2] grid-cols-2 sm:grid-cols-3 lg:grid-cols-5" : "max-h-[240px] grid-cols-3",
        )}
      >
        {shots.map((s, i) => {
          const dur = durationLabel(s.durationSec);
          return (
            <div key={s.id} role="listitem" className="relative">
              <button
                type="button"
                onClick={() => {
                  setIdx(i);
                  onOpenChild?.(s);
                }}
                onPointerEnter={() => active && s.kind === "video" && setHoverId(s.id)}
                onPointerLeave={() => setHoverId((h) => (h === s.id ? null : h))}
                aria-label={`打开${shotLabel(s, i)}`}
                className={cn(
                  "block w-full overflow-hidden rounded-lg text-left ring-1 transition",
                  i === idx ? "ring-2 ring-white" : "ring-white/15 hover:ring-white/50",
                )}
              >
                <span className="relative block aspect-video bg-black">
                  <Thumb child={s} idx={i} hovering={hoverId === s.id} />
                  <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 text-[13px] leading-5">{i + 1}</span>
                  {dur && <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 text-[13px] leading-5">{dur}</span>}
                  {markedShots.has(i) && (
                    <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-amber-400" aria-label="已有标记" />
                  )}
                </span>
                {s.title?.trim() && <span className="block truncate px-2 py-1.5 text-[13px] text-white/80">{s.title}</span>}
              </button>
              <button
                type="button"
                onClick={() => {
                  setIdx(i);
                  setPlaying(true);
                }}
                aria-label={`从${shotLabel(s, i)}开始播放`}
                className="absolute bottom-7 left-1 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-black/50 text-white/80 hover:bg-black/70 hover:text-white"
              >
                <Play className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
