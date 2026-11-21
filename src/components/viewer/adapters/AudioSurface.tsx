"use client";

// 赏阅 · 听歌舞台（AudioSurface）。
//
// 产品形态对标 Apple Music 的“正在播放”：整面糊开的封面色做背景、一张大封面、细进度条、一个大播放键，
// 歌词整块居中滚动（当前句高亮、远处虚化、点句跳转）。这里只做“欣赏”：没有标记、评审、A-B 循环。
// 歌词解析（标准/增强 LRC、估算滚动、计时与音频对不上时降级）沿用已在真浏览器验证过的实现。
// density="inline"：聊天卡里的横条小播放器；density="full"：沉浸全屏/独立页。

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Download, Loader2, Music2, Pause, Play, RotateCcw, RotateCw, TextQuote, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { downloadAsset } from "@/lib/viewer/download";
import { mmss } from "@/lib/viewer/review";
import type { Locator, ViewerController, ViewerSurfaceProps } from "@/lib/viewer/types";
import { MusicBackdrop } from "../MusicBackdrop";

const PROVISIONAL_FALLBACK_SEC = 4;
const STORE_HOST = "store.tinchak0207.xyz";
const TRACKS_URL = "https://store.tinchak0207.xyz/image-data/files/uploads/ba-deng-liu-zhao/tracks.json";
const ALIGN_POLL_MS = 8000;
const ALIGN_MAX_POLLS = 150;
const PLACEHOLDER_TITLE_RE = /^(?:音频|音乐|音频文件|未命名曲目)\s*#?\d*$/;
const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";

/* ---------------------------------------------------------------- 纯逻辑（歌词） */

interface LrcWord {
  t: number;
  text: string;
  end: number;
}
interface LrcLine {
  t: number;
  text: string;
  words: LrcWord[] | null;
  end: number;
}
type LyricMode = "word" | "line" | "estimated" | "none";
interface LyricModel {
  lines: LrcLine[];
  mode: LyricMode;
  /** 真 LRC 计时与音频对不上，已降级为估算。 */
  suspect: boolean;
}
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const noop = () => {};
const nonEmpty = (s: string | undefined | null): string | undefined => (s && s.trim() ? s : undefined);

function parseLrcTime(mm: string, ss: string, frac?: string): number {
  return Number(mm) * 60 + Number(ss) + (frac ? Number("0." + frac) : 0);
}

/** 标准 LRC 或增强 LRC：[mm:ss.xx]文字，可含 <mm:ss.xx>逐字。 */
function parseLrc(raw: string): LrcLine[] {
  if (!raw) return [];
  const out: LrcLine[] = [];
  String(raw)
    .split(/\r?\n/)
    .forEach((line) => {
      const m = line.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/);
      if (!m) return;
      const t = parseLrcTime(m[1], m[2], m[3]);
      const rest = m[4] || "";
      const words: LrcWord[] = [];
      const wordRe = /<(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?>([^<]*)/g;
      let hasWord = false;
      let wm: RegExpExecArray | null;
      while ((wm = wordRe.exec(rest))) {
        hasWord = true;
        if (wm[4].length) words.push({ t: parseLrcTime(wm[1], wm[2], wm[3]), text: wm[4], end: 0 });
      }
      const plain = hasWord ? words.map((w) => w.text).join("") : rest.trim() || " ";
      out.push({ t, text: plain, words: hasWord ? words : null, end: 0 });
    });
  for (let i = 0; i < out.length; i++) {
    const lineEnd = i + 1 < out.length ? out[i + 1].t : out[i].t + 4;
    out[i].end = lineEnd;
    const ws = out[i].words;
    if (ws) for (let j = 0; j < ws.length; j++) ws[j].end = j + 1 < ws.length ? ws[j + 1].t : lineEnd;
  }
  return out;
}

function isMetaLine(text: string): boolean {
  const s = String(text || "").trim();
  if (/^\[.+\]$/.test(s)) return true;
  return /^(?:Intro|Verse|Chorus|Bridge|Outro|Guitar|Pre-|Post-|Final|Spoken|Whisper|Instrumental)\b/.test(s);
}

/** 无时间轴歌词：按行数比例铺满时长（时长未知时每行 4 秒）。 */
function linesFromPlain(text: string, span: number): LrcLine[] {
  const raw = String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !isMetaLine(s));
  if (!raw.length) return [];
  const n = raw.length;
  const useSpan = span > 0;
  const out: LrcLine[] = raw.map((txt, i) => ({
    t: useSpan ? span * (i / n) : i * PROVISIONAL_FALLBACK_SEC,
    text: txt,
    words: null,
    end: 0,
  }));
  for (let j = 0; j < out.length; j++) {
    out[j].end = j + 1 < out.length ? out[j + 1].t : useSpan ? span : out[j].t + PROVISIONAL_FALLBACK_SEC;
  }
  return out;
}

/**
 * checkLrcSane + applyLyrics：真 LRC 的最后一句唱词开始得远早于音频一半 ⇒ 计时是坏的，
 * 不照单全收，退回按比例估算滚动并如实标注。trackDur 优先于 audioDur（v2 currentDuration）。
 */

function buildLyricModel(lrc: string | undefined, plain: string | undefined, trackDur: number, audioDur: number): LyricModel {
  if (lrc) {
    const lines = parseLrc(lrc);
    if (lines.length) {
      if (audioDur > 40) {
        let last = 0;
        const texts: string[] = [];
        for (const l of lines) {
          if (!isMetaLine(l.text)) {
            texts.push(l.text.trim());
            if (l.t > last) last = l.t;
          }
        }
        if (texts.length && last < audioDur * 0.5) {
          return { lines: linesFromPlain(texts.join("\n"), audioDur), mode: "estimated", suspect: true };
        }
      }
      return { lines, mode: lines.some((l) => l.words) ? "word" : "line", suspect: false };
    }
  }
  if (plain) {
    const span = trackDur > 0 ? trackDur : audioDur > 0 ? audioDur : 0;
    const lines = linesFromPlain(plain, span);
    if (lines.length) return { lines, mode: "estimated", suspect: false };
  }
  return { lines: [], mode: "none", suspect: false };
}

function lineIndexAt(lines: readonly LrcLine[], t: number): number {
  let cur = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= t) cur = i;
    else break;
  }
  return cur;
}


function cleanTitle(name: string | undefined): string {
  const s = String(name == null ? "" : name).trim();
  if (!s || PLACEHOLDER_TITLE_RE.test(s)) return "";
  return s;
}

function normUrl(u: string): string {
  try {
    const x = new URL(u, typeof location !== "undefined" ? location.href : "http://localhost/");
    return (x.pathname || "") + (x.search || "");
  } catch {
    return String(u || "");
  }
}

/** 可交给 <audio> 的地址：非空，且协议只能是 http(s)/blob/data（或无协议的相对路径）。 */
function isPlayableUrl(u: string): boolean {
  const s = u.trim();
  if (!s) return false;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (!m) return true;
  return ["http", "https", "blob", "data"].includes(m[1].toLowerCase());
}

/** tracks.json 只属于「八灯流照」专辑目录：只有这个目录下的 store 音频才值得去查（别处查必然 404/CORS 红字）。 */
function isAlbumTracksUrl(u: string): boolean {
  try {
    const x = new URL(u);
    return x.hostname === STORE_HOST && x.pathname.includes("/ba-deng-liu-zhao/");
  } catch {
    return false;
  }
}

function isStoreUrl(u: string): boolean {
  try {
    return new URL(u).hostname === STORE_HOST;
  } catch {
    return false;
  }
}

function asStoreTracks(json: unknown): StoreTrack[] {
  if (!Array.isArray(json)) return [];
  const out: StoreTrack[] = [];
  for (const it of json) {
    if (it && typeof it === "object") {
      const o = it as Record<string, unknown>;
      out.push({
        url: typeof o.url === "string" ? o.url : undefined,
        lrc: typeof o.lrc === "string" ? o.lrc : undefined,
        lyric_status: typeof o.lyric_status === "string" ? o.lyric_status : undefined,
      });
    }
  }
  return out;
}

/** v2 resolveDeepLink 的 url 匹配：全等 / 路径相等 / 互相包含。 */
function findStoreTrack(tracks: readonly StoreTrack[], want: string): StoreTrack | null {
  const nu = normUrl(want);
  for (const t of tracks) {
    const tu = t.url || "";
    if (!tu) continue;
    if (tu === want || normUrl(tu) === nu || tu.indexOf(want) >= 0 || want.indexOf(tu) >= 0) return t;
  }
  return null;
}

type WordState = "wait" | "on" | "done" | "partial";
function wordStyle(w: LrcWord, t: number): CSSProperties {
  let st: WordState;
  let kp = 0;
  if (t >= w.end) st = "done";
  else if (t >= w.t) {
    const p = (t - w.t) / Math.max(0.05, w.end - w.t);
    if (p > 0.85 || w.text.length <= 1) st = "on";
    else {
      st = "partial";
      kp = Math.round(p * 100);
    }
  } else st = "wait";
  switch (st) {
    case "done":
      return { color: "rgba(255,255,255,.92)" };
    case "on":
      return { color: "#fff" };
    case "wait":
      return { color: "rgba(255,255,255,.32)" };
    case "partial":
      return {
        backgroundImage: `linear-gradient(90deg,#fff ${kp}%,rgba(255,255,255,.32) ${kp}%)`,
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
        WebkitTextFillColor: "transparent",
      };
  }
}


interface StoreTrack {
  url?: string;
  lrc?: string;
  lyric_status?: string;
}
interface StoreLyric {
  lrc?: string;
  status?: string;
  capped?: boolean;
}

/* ---------------------------------------------------------------- 歌词行 */

const LyricLine = memo(function LyricLine({
  line,
  index,
  cur,
  dist,
  wordT,
  onPick,
  setRef,
}: {
  line: LrcLine;
  index: number;
  cur: boolean;
  dist: number;
  wordT: number;
  onPick(t: number): void;
  setRef(i: number, el: HTMLParagraphElement | null): void;
}) {
  const meta = isMetaLine(line.text);
  return (
    <p
      ref={(el) => setRef(index, el)}
      data-cur={cur ? "1" : undefined}
      onClick={() => onPick(line.t)}
      className={cn(
        "origin-left cursor-pointer select-none py-[0.4em] text-[26px] font-bold leading-[1.25] tracking-[-0.01em] transition-[opacity,filter,transform] duration-500 md:text-[34px]",
        meta && "text-[15px] font-medium uppercase tracking-[0.14em] md:text-[15px]",
        cur ? "scale-100 text-white" : "scale-[0.96] text-white/35 hover:text-white/60",
      )}
      style={{
        transitionTimingFunction: SPRING,
        filter: cur || dist <= 1 ? undefined : `blur(${Math.min(3, (dist - 1) * 0.8)}px)`,
      }}
    >
      {cur && line.words
        ? line.words.map((w, i) => (
            <span key={i} style={wordStyle(w, wordT)}>
              {w.text}
            </span>
          ))
        : line.text}
    </p>
  );
});

/* ---------------------------------------------------------------- 进度条 */

function Scrubber({
  cur,
  dur,
  onSeek,
  compact,
  light,
}: {
  cur: number;
  dur: number;
  onSeek(t: number): void;
  compact?: boolean;
  /** 浅色玻璃宿主（聊天气泡内嵌卡）：深色轨道/填充/时间字，不是深色舞台的白色。 */
  light?: boolean;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? cur;
  const pct = dur > 0 ? clamp((shown / dur) * 100, 0, 100) : 0;
  return (
    <div data-no-swipe className={cn("w-full", light && "relative")}>
      <div className="group relative flex h-6 items-center">
        <div className={cn("pointer-events-none absolute inset-x-0 overflow-hidden rounded-full transition-[height]", light ? "bg-foreground/[0.12]" : "bg-white/25", compact ? "h-1" : "h-1 group-hover:h-[7px] group-active:h-[7px]")}>
          <div className={cn("h-full rounded-full", light ? "bg-foreground/80" : "bg-white")} style={{ width: `${pct}%` }} />
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(1, Math.floor(dur * 10) / 10)}
          step={0.1}
          value={Math.min(shown, dur || 0)}
          disabled={!(dur > 0)}
          aria-label="播放进度"
          aria-valuetext={`${mmss(shown)} / ${mmss(dur)}`}
          onChange={(e) => setDrag(Number(e.target.value))}
          onPointerUp={() => {
            if (drag != null) onSeek(drag);
            setDrag(null);
          }}
          onKeyUp={(e) => {
            if (drag != null && (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End")) {
              onSeek(drag);
              setDrag(null);
            }
          }}
          onBlur={() => {
            if (drag != null) {
              onSeek(drag);
              setDrag(null);
            }
          }}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
        />
      </div>
      <div className={cn("flex justify-between whitespace-nowrap text-[12px] font-medium tabular-nums", light ? "pointer-events-none absolute inset-x-0 top-[26px] text-muted-foreground" : "mt-0.5 text-white/55")}>
        <span>{mmss(shown)}</span>
        <span>{dur > 0 ? `-${mmss(Math.max(0, dur - shown))}` : "--:--"}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 适配器 */

export default function AudioSurface(props: ViewerSurfaceProps) {
  // 每件成品一个干净实例：换件即重挂（错误/轮询状态都不串）。
  return <AudioSurfaceInner key={props.asset.id} {...props} />;
}

function AudioSurfaceInner({ asset, density, controllerRef, active }: ViewerSurfaceProps) {
  const full = density === "full";
  const rawUrl = asset.url || "";
  const hasSource = isPlayableUrl(rawUrl);
  const url = hasSource ? rawUrl.trim() : "";

  const audioRef = useRef<HTMLAudioElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const lyricBoxRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const userScrollUntilRef = useRef(0);
  const rafRef = useRef(0);

  const [audioDur, setAudioDur] = useState(0);
  const [curSec, setCurSec] = useState(0);
  const [wordT, setWordT] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [coverOk, setCoverOk] = useState(true);
  const [store, setStore] = useState<StoreLyric | null>(null);
  const [lyricsView, setLyricsView] = useState(false); // 窄屏：封面 / 歌词二选一
  const [dl, setDl] = useState<"idle" | "loading" | "failed">("idle");

  /* ---- 歌词模型 ---- */
  const hasAssetLrc = !!nonEmpty(asset.lyrics?.lrc);
  const assetAligning = asset.lyrics?.status === "aligning";
  const lrcText = nonEmpty(asset.lyrics?.lrc) ?? nonEmpty(store?.lrc);
  const plainText = nonEmpty(asset.lyrics?.plain);
  const trackDur = asset.durationSec && asset.durationSec > 0 ? asset.durationSec : 0;
  const model = useMemo(() => buildLyricModel(lrcText, plainText, trackDur, audioDur), [lrcText, plainText, trackDur, audioDur]);
  const awaiting = !lrcText && (assetAligning || store?.status === "aligning");
  const hasLyrics = model.lines.length > 0;
  const curLine = useMemo(() => (model.lines.length ? lineIndexAt(model.lines, curSec) : 0), [model.lines, curSec]);

  const title = cleanTitle(asset.title) || "未命名曲目";
  const cover = asset.cover && coverOk ? asset.cover : "";
  const dur = audioDur || trackDur;
  const subtitle = [asset.provenance?.model, asset.provenance?.take ? `第 ${asset.provenance.take} 版` : ""].filter(Boolean).join(" · ");

  /* ---- 播放控制 ---- */
  const seekTo = useCallback((t: number) => {
    const a = audioRef.current;
    if (!a) return;
    const d = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : Infinity;
    const next = clamp(t, 0, d);
    try {
      a.currentTime = next;
    } catch {
      return;
    }
    setCurSec(next);
  }, []);
  const seekBy = useCallback((d: number) => seekTo((audioRef.current?.currentTime ?? 0) + d), [seekTo]);
  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a || failed) return;
    if (a.paused) void a.play().catch(noop);
    else a.pause();
  }, [failed]);

  // 播放中用 rAF 推进（逐字歌词要 60fps 级的时间），暂停时靠 timeupdate/seeked。
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const a = audioRef.current;
      if (a) {
        setCurSec(a.currentTime);
        setWordT(a.currentTime);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing]);

  // 壳不再显示本件：暂停。
  useEffect(() => {
    if (!active) audioRef.current?.pause();
  }, [active]);

  // 进全屏就开唱（用户刚点开，浏览器放行；被拦下就停在播放键上）。
  useEffect(() => {
    if (!full || !active || !hasSource) return;
    const a = audioRef.current;
    if (!a) return;
    const go = () => void a.play().catch(noop);
    if (a.readyState >= 2) go();
    else a.addEventListener("canplay", go, { once: true });
    return () => a.removeEventListener("canplay", go);
  }, [full, active, hasSource]);

  useEffect(() => {
    const a = audioRef.current;
    if (a) a.volume = muted ? 0 : volume;
  }, [volume, muted]);

  /* ---- 键盘（仅 full；输入框里不抢） ---- */
  useEffect(() => {
    if (!full || !active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (el?.closest('[role="dialog"]') && el.closest('[role="dialog"]') !== rootRef.current?.closest('[role="dialog"]')) return;
      if (e.key === " " || e.key === "k") toggle();
      else if (e.key === "ArrowLeft") seekBy(-5);
      else if (e.key === "ArrowRight") seekBy(5);
      else if (e.key === "m" || e.key === "M") setMuted((v) => !v);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full, active, toggle, seekBy]);

  /* ---- 专辑目录的歌词（tracks.json），对齐中则轮询 ---- */
  useEffect(() => {
    if (!active || hasAssetLrc || !url || !isStoreUrl(url) || !isAlbumTracksUrl(url)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let count = 0;
    let waitingPoll = false;
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const tick = async () => {
      timer = null;
      try {
        const r = await fetch(`${TRACKS_URL}?v=${Date.now()}`, { cache: "no-cache" });
        if (!r.ok) return;
        const hit = findStoreTrack(asStoreTracks(await r.json()), url);
        if (cancelled || !hit) return;
        const nlrc = nonEmpty(hit.lrc);
        if (nlrc) {
          waitingPoll = false;
          setStore({ lrc: nlrc, status: hit.lyric_status });
          return;
        }
        setStore((s) => (s && s.status === hit.lyric_status ? s : { status: hit.lyric_status }));
        waitingPoll = assetAligning || hit.lyric_status === "aligning";
      } catch {
        if (!waitingPoll) return;
      }
      if (!waitingPoll || cancelled) return;
      count++;
      if (count >= ALIGN_MAX_POLLS) {
        setStore((s) => ({ ...(s || {}), capped: true }));
        waitingPoll = false;
        return;
      }
      if (!document.hidden) timer = setTimeout(() => void tick(), ALIGN_POLL_MS);
    };
    const onVis = () => {
      if (!waitingPoll) return;
      stop();
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVis);
    void tick();
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [active, assetAligning, hasAssetLrc, url]);

  /* ---- 歌词居中滚动 ---- */
  const setLineRef = useCallback((i: number, el: HTMLParagraphElement | null) => {
    lineRefs.current[i] = el;
  }, []);
  const centerLine = useCallback((smooth: boolean) => {
    const box = lyricBoxRef.current;
    const el = lineRefs.current[curLine];
    if (!box || !el) return;
    const top = el.offsetTop - box.clientHeight * 0.34 + el.offsetHeight / 2;
    box.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
  }, [curLine]);
  useEffect(() => {
    if (Date.now() < userScrollUntilRef.current) return;
    centerLine(true);
  }, [centerLine]);
  // 切到歌词页 / 歌词到位后立即对齐一次（不要动画）。
  useEffect(() => {
    if (hasLyrics) centerLine(false);
  }, [lyricsView, hasLyrics]); // eslint-disable-line react-hooks/exhaustive-deps
  const holdFollow = () => {
    userScrollUntilRef.current = Date.now() + 3500;
  };

  /* ---- Media Session ---- */
  useEffect(() => {
    if (!full || !active || typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.metadata = new MediaMetadata({
        title,
        artist: subtitle,
        album: "Eimu",
        artwork: cover ? [{ src: cover, sizes: "512x512" }] : [],
      });
    } catch {
      /* 旧浏览器无 MediaMetadata */
    }
    const set = (name: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(name, fn);
      } catch {
        /* 该动作不被支持 */
      }
    };
    set("play", () => void audioRef.current?.play().catch(noop));
    set("pause", () => audioRef.current?.pause());
    set("seekbackward", (d) => seekBy(-(d.seekOffset || 10)));
    set("seekforward", (d) => seekBy(d.seekOffset || 10));
    set("seekto", (d) => {
      if (d.seekTime != null) seekTo(d.seekTime);
    });
    return () => {
      (["play", "pause", "seekbackward", "seekforward", "seekto"] as const).forEach((n) => set(n, null));
      try {
        ms.metadata = null;
      } catch {
        /* 忽略 */
      }
    };
  }, [full, active, title, subtitle, cover, seekBy, seekTo]);

  /* ---- 控制柄（分享链接 t= 跳到指定秒；其余按钮不挂） ---- */
  useEffect(() => {
    const ctl: ViewerController = {
      capture() {
        const a = audioRef.current;
        return { locator: { t: "time", a: Math.round((a?.currentTime ?? 0) * 10) / 10 } as Locator };
      },
      reveal(loc) {
        if (loc.t === "time") seekTo(loc.a);
      },
      play: () => void audioRef.current?.play().catch(noop),
      pause: () => audioRef.current?.pause(),
    };
    controllerRef.current = ctl;
    return () => {
      if (controllerRef.current === ctl) controllerRef.current = null;
    };
  }, [controllerRef, seekTo]);

  const onDownload = async () => {
    if (dl === "loading") return;
    setDl("loading");
    const ok = await downloadAsset(asset).catch(() => false);
    if (ok) setDl("idle");
    else {
      setDl("failed");
      setTimeout(() => setDl("idle"), 2000);
    }
  };

  /* ---- 零件 ---- */
  const audioEl = hasSource ? (
    <audio
      ref={audioRef}
      src={url}
      preload="metadata"
      onLoadedMetadata={(e) => {
        const d = e.currentTarget.duration;
        if (Number.isFinite(d) && d > 0) setAudioDur(d);
        setFailed(false);
      }}
      onDurationChange={(e) => {
        const d = e.currentTarget.duration;
        if (Number.isFinite(d) && d > 0) setAudioDur(d);
      }}
      onTimeUpdate={(e) => setCurSec(e.currentTarget.currentTime)}
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onEnded={() => {
        setPlaying(false);
        setCurSec(0);
        const a = audioRef.current;
        if (a) a.currentTime = 0;
      }}
      onWaiting={() => setWaiting(true)}
      onPlaying={() => setWaiting(false)}
      onCanPlay={() => setWaiting(false)}
      onError={() => setFailed(true)}
    />
  ) : null;

  const playBtn = (size: "lg" | "sm", light = false) => (
    <button
      type="button"
      onClick={toggle}
      disabled={!hasSource || failed}
      aria-label={playing ? "暂停" : "播放"}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full transition-transform hover:scale-105 active:scale-95 focus:outline-none focus-visible:ring-2 disabled:opacity-40 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
        light
          ? "bg-foreground text-background shadow-[0_4px_14px_rgba(0,0,0,0.18)] focus-visible:ring-ring focus-visible:ring-offset-2"
          : "bg-white text-[#14161c] shadow-[0_8px_28px_rgba(0,0,0,0.35)] focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black/40",
        size === "lg" ? "h-[72px] w-[72px]" : light ? "h-11 w-11" : "h-12 w-12",
      )}
      style={{ transitionTimingFunction: SPRING }}
    >
      {waiting && playing ? (
        <Loader2 className={cn("animate-spin", size === "lg" ? "h-8 w-8" : "h-5 w-5")} aria-hidden="true" />
      ) : playing ? (
        <Pause className={cn("fill-current", size === "lg" ? "h-8 w-8" : "h-5 w-5")} aria-hidden="true" />
      ) : (
        <Play className={cn("ml-0.5 fill-current", size === "lg" ? "h-8 w-8" : "h-5 w-5")} aria-hidden="true" />
      )}
    </button>
  );

  const glassBtn =
    "flex h-11 w-11 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/12 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent] disabled:opacity-40";

  const downloadBtn = (light = false) => (
    <button type="button" onClick={() => void onDownload()} disabled={!hasSource || dl === "loading"} aria-label={dl === "failed" ? "下载失败，点击重试" : "下载"} title={dl === "failed" ? "下载失败，点击重试" : "下载这首歌"} className={cn(light ? "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-foreground/65 transition-colors hover:bg-foreground/[0.08] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 [touch-action:manipulation]" : glassBtn, dl === "failed" && (light ? "text-destructive" : "text-[#ff8a80]"))}>
      {dl === "loading" ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <Download className="h-5 w-5" aria-hidden="true" />}
    </button>
  );

  const artwork = (
    <div
      className="relative aspect-square w-full overflow-hidden rounded-[28px] bg-white/10 shadow-[0_30px_80px_rgba(0,0,0,0.55)] ring-1 ring-white/15 transition-transform duration-500"
      style={{ transform: playing ? "scale(1)" : "scale(0.88)", transitionTimingFunction: SPRING }}
    >
      {cover ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cover} alt={`${title} 封面`} className="h-full w-full object-cover" draggable={false} onError={() => setCoverOk(false)} />
      ) : (
        <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
          <MusicBackdrop seed={title} className="!bg-transparent" />
          <Music2 className="relative h-1/4 w-1/4 text-white/70" strokeWidth={1.25} aria-hidden="true" />
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-70" />
    </div>
  );

  /* ================= 内嵌：聊天/历史里的音乐卡 =================
   * 宿主是 Eimu 的浅色玻璃（.lg-float / 白 0.56），所以这里是浅色卡：深色字、深色主按钮（--primary）、
   * 墨绿×靛蓝封面块；不再是黑底白字的「Apple Music 夜场」块嵌进白气泡。
   * 两行：①封面＋曲名/副标题（右上留给「放大」钮）②播放键＋整宽进度条（时间同一行不折行）＋下载。 */
  if (!full) {
    const line = model.mode !== "estimated" && hasLyrics ? model.lines[curLine]?.text.trim() : "";
    const hue = 158 + (() => { let h = 0; for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0; return h % 70; })();
    return (
      <div ref={rootRef} className="relative isolate text-foreground">
        {audioEl}
        <div className="flex flex-col gap-3 p-3.5">
          <div className="flex items-center gap-3 pr-9">
            <div
              className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[14px] ring-1 ring-black/5"
              style={cover ? undefined : { background: `linear-gradient(135deg, hsl(${hue} 30% 42%), hsl(${hue + 62} 34% 36%))` }}
            >
              {cover ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={cover} alt="" className="h-full w-full object-cover" draggable={false} onError={() => setCoverOk(false)} />
              ) : (
                <Music2 className="h-6 w-6 text-white/90" strokeWidth={1.5} aria-hidden="true" />
              )}
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-ios-subhead font-semibold text-foreground" title={title}>{title}</div>
              <div className="truncate text-ios-footnote text-muted-foreground">{failed ? "这首歌暂时放不出来" : line || subtitle || (awaiting ? "歌词对齐中…" : "Eimu 音乐")}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {playBtn("sm", true)}
            <div className="min-w-0 flex-1">
              <Scrubber cur={curSec} dur={dur} onSeek={seekTo} compact light />
            </div>
            {downloadBtn(true)}
          </div>
        </div>
      </div>
    );
  }

  /* ================= 全屏：听歌舞台 ================= */
  const showLyricsCol = hasLyrics || awaiting;
  return (
    <div ref={rootRef} className="relative isolate flex h-full w-full flex-col overflow-hidden text-white">
      {audioEl}
      <div className={cn("mx-auto grid min-h-0 w-full max-w-[1180px] flex-1 gap-6 px-5 pb-4 md:gap-14 md:px-10 md:pb-6", showLyricsCol ? "md:grid-cols-[minmax(320px,440px)_minmax(0,1fr)]" : "md:grid-cols-1 md:max-w-[460px]")}>
        {/* 左：封面 + 信息 + 控制 */}
        <div className={cn("flex min-h-0 flex-col justify-center gap-5", lyricsView && showLyricsCol && "max-md:hidden")}>
          <div className="mx-auto w-full max-w-[min(100%,40dvh)]">{artwork}</div>
          <div>
            <h2 className="line-clamp-2 text-[24px] font-bold leading-tight tracking-[-0.01em] md:text-[28px]">{title}</h2>
            {subtitle && <p className="mt-1 truncate text-[15px] text-white/60">{subtitle}</p>}
          </div>
          <Scrubber cur={curSec} dur={dur} onSeek={seekTo} />
          {failed ? (
            <p role="alert" className="rounded-2xl bg-white/10 px-4 py-3 text-[14px] text-white/85">
              这首歌暂时放不出来。可以先下载到本地听。
            </p>
          ) : null}
          <div className="flex items-center justify-center gap-5">
            <button type="button" onClick={() => seekBy(-15)} aria-label="后退 15 秒" className={glassBtn}>
              <RotateCcw className="h-6 w-6" aria-hidden="true" />
            </button>
            {playBtn("lg")}
            <button type="button" onClick={() => seekBy(15)} aria-label="快进 15 秒" className={glassBtn}>
              <RotateCw className="h-6 w-6" aria-hidden="true" />
            </button>
          </div>
          <div className="relative mx-auto flex w-full max-w-[420px] items-center gap-1 rounded-full border border-white/15 bg-white/10 px-2 py-1 backdrop-blur-xl">
            <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent" />
            <button type="button" onClick={() => setMuted((v) => !v)} aria-label={muted ? "取消静音" : "静音"} className={glassBtn}>
              {muted || volume === 0 ? <VolumeX className="h-5 w-5" aria-hidden="true" /> : <Volume2 className="h-5 w-5" aria-hidden="true" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              aria-label="音量"
              data-no-swipe
              onChange={(e) => {
                setVolume(Number(e.target.value));
                setMuted(false);
              }}
              className="h-1 min-w-0 flex-1 cursor-pointer accent-white"
            />
            {showLyricsCol && (
              <button
                type="button"
                onClick={() => setLyricsView(true)}
                aria-label="看歌词"
                className={cn(glassBtn, "md:hidden")}
              >
                <TextQuote className="h-5 w-5" aria-hidden="true" />
              </button>
            )}
            {downloadBtn()}
          </div>
        </div>

        {/* 右：歌词 */}
        {showLyricsCol && (
          <div className={cn("relative min-h-0 flex-col", lyricsView ? "flex" : "max-md:hidden md:flex")}>
            {lyricsView && (
              <button
                type="button"
                onClick={() => setLyricsView(false)}
                aria-label="回到封面"
                className="mb-2 flex h-10 items-center gap-2 self-start rounded-full bg-white/12 px-4 text-[14px] font-medium text-white/90 backdrop-blur-xl md:hidden"
              >
                <Music2 className="h-4 w-4" aria-hidden="true" />
                <span className="max-w-[60vw] truncate">{title}</span>
              </button>
            )}
            <div
              ref={lyricBoxRef}
              data-no-swipe
              onWheel={holdFollow}
              onTouchMove={holdFollow}
              onKeyDown={(e: ReactKeyboardEvent) => e.stopPropagation()}
              tabIndex={0}
              aria-label="歌词"
              className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-[28dvh] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden focus:outline-none"
              style={{
                WebkitMaskImage: "linear-gradient(180deg,transparent 0%,#000 14%,#000 82%,transparent 100%)",
                maskImage: "linear-gradient(180deg,transparent 0%,#000 14%,#000 82%,transparent 100%)",
              }}
            >
              {hasLyrics ? (
                model.lines.map((l, i) => (
                  <LyricLine
                    key={i}
                    line={l}
                    index={i}
                    cur={i === curLine}
                    dist={Math.abs(i - curLine)}
                    wordT={i === curLine ? wordT : -1}
                    onPick={(t) => {
                      userScrollUntilRef.current = 0;
                      seekTo(t);
                      if (audioRef.current?.paused) void audioRef.current.play().catch(noop);
                    }}
                    setRef={setLineRef}
                  />
                ))
              ) : (
                <p className="text-[22px] font-semibold text-white/55">歌词对齐中…稍后自动出现</p>
              )}
            </div>
            {model.mode === "estimated" && hasLyrics && (
              <p className="pointer-events-none absolute bottom-1 left-1 text-[12px] text-white/45">
                {model.suspect ? "歌词时间轴与音频对不上，已按比例估算滚动" : "歌词按时长估算滚动，不一定逐句对准"}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
