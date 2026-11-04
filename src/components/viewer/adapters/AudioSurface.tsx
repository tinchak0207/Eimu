"use client";

// 赏阅 · 音频适配器。
//
// 逻辑整段移植自 eval-av-agent-bench/scripts/lyric-align/player/index.html（v2 播放器，已在真浏览器验证），
// 语义不改：parseLrc（含增强逐字）、isMetaLine、逐字高亮、估算歌词（linesFromPlain）、checkLrcSane（计时与音频对不上
// ⇒ 降级为估算并标注）、波形解码（解不了就朴素进度条，不造假）、A-B 循环、倍速、Media Session、键盘、续播、
// 点歌词跳转、「回到当前」、tracks.json 的 aligning 轮询。壳负责标签/反馈措辞/存取/全屏，这里只渲染并发布 capture/reveal。

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Flag, Pause, Play, Repeat, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { mmss } from "@/lib/viewer/review";
import type { Locator, ViewerController, ViewerSurfaceProps } from "@/lib/viewer/types";

/* ---------------------------------------------------------------- 常量 */

const ACCENT = "#ec4141";
const RATES = [0.75, 1, 1.25, 1.5, 2] as const;
const PREF = "eimu-viewer:";
const POS_PREFIX = "eimu-viewer:pos:";
const PROVISIONAL_FALLBACK_SEC = 4;
const STORE_HOST = "store.tinchak0207.xyz";
const TRACKS_URL = "https://store.tinchak0207.xyz/image-data/files/uploads/ba-deng-liu-zhao/tracks.json";
const ALIGN_POLL_MS = 8000;
const ALIGN_MAX_POLLS = 150;
const PLACEHOLDER_TITLE_RE = /^(?:音频|音乐|音频文件|未命名曲目)\s*#?\d*$/;

const LYRIC_MASK: CSSProperties = {
  WebkitMaskImage: "linear-gradient(180deg,transparent 0%,#000 8%,#000 88%,transparent 100%)",
  maskImage: "linear-gradient(180deg,transparent 0%,#000 8%,#000 88%,transparent 100%)",
};

/* ---------------------------------------------------------------- 纯逻辑（自 v2 移植） */

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
interface AbLoop {
  a: number;
  b: number | null;
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

/** 区间内（或此刻所在）的歌词句，至多两句；估算歌词不出摘录。 */
function lyricTextBetween(lines: readonly LrcLine[], mode: LyricMode, a: number, b: number | null): string {
  if (mode === "estimated" || mode === "none" || !lines.length) return "";
  const out: string[] = [];
  for (const l of lines) {
    if (isMetaLine(l.text)) continue;
    if (b != null ? l.t >= a - 0.05 && l.t < b : l.t <= a && a < l.end) out.push(l.text.trim());
    if (out.length >= 2) break;
  }
  return out.join(" / ");
}

/** 此刻正在唱的那一句（v2 buildSnapshot：允许句尾后 0.5s 宽限）。 */
function lyricAt(lines: readonly LrcLine[], mode: LyricMode, t: number): string {
  if (mode === "estimated" || mode === "none" || !lines.length) return "";
  const l = lines[lineIndexAt(lines, t)];
  if (!l || isMetaLine(l.text) || t > l.end + 0.5) return "";
  return l.text.trim();
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

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 隐私模式 / 配额：忽略 */
  }
}
function lsDel(k: string) {
  try {
    localStorage.removeItem(k);
  } catch {
    /* 同上 */
  }
}

/** 峰值缓存：同一 URL 不重复解码。 */
const peaksCache = new Map<string, Float32Array>();

/** 解码音频取 480 柱 RMS 峰值；跨域无 CORS / 过大 / 解码失败一律抛错，由调用方退化成朴素进度条。 */
async function decodePeaks(url: string, isCancelled: () => boolean): Promise<Float32Array | null> {
  const AC =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  const r = await fetch(url);
  if (!r.ok) throw new Error("http " + r.status);
  const len = Number(r.headers.get("content-length")) || 0;
  if (len > 30e6) throw new Error("too large");
  const buf = await r.arrayBuffer();
  if (isCancelled()) return null;
  const ctx = new AC();
  let ab: AudioBuffer;
  try {
    ab = await ctx.decodeAudioData(buf);
  } finally {
    try {
      void ctx.close();
    } catch {
      /* 已关 */
    }
  }
  if (isCancelled()) return null;
  const N = 480;
  const out = new Float32Array(N);
  const bin = ab.length / N;
  for (let c = 0; c < ab.numberOfChannels; c++) {
    const data = ab.getChannelData(c);
    for (let i = 0; i < N; i++) {
      const s = Math.floor(i * bin);
      const e = Math.min(ab.length, Math.floor((i + 1) * bin));
      let sum = 0;
      let cnt = 0;
      for (let j = s; j < e; j += 6) {
        sum += data[j] * data[j];
        cnt++;
      }
      const rms = cnt ? Math.sqrt(sum / cnt) : 0;
      if (rms > out[i]) out[i] = rms;
    }
  }
  let max = 0;
  for (let k = 0; k < N; k++) if (out[k] > max) max = out[k];
  if (max <= 0) return null;
  for (let m = 0; m < N; m++) out[m] = Math.pow(out[m] / max, 0.75);
  return out;
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

/* ---------------------------------------------------------------- 歌词行 */

interface LyricLineProps {
  line: LrcLine;
  index: number;
  meta: boolean;
  cur: boolean;
  passed: boolean;
  inAb: boolean;
  /** 仅当前行传真实时间，其余恒 -1（让 memo 命中）。 */
  wordT: number;
  onPick(line: LrcLine): void;
  setRef(i: number, el: HTMLParagraphElement | null): void;
}

const LyricLine = memo(function LyricLine({ line, index, meta, cur, passed, inAb, wordT, onPick, setRef }: LyricLineProps) {
  const base = "m-0 break-words rounded-xl px-2 py-3 leading-[1.55] tracking-[.02em] transition-[color,transform,font-size] duration-300";
  let cls: string;
  if (meta) cls = `${base} cursor-default py-2 text-xs font-normal text-white/20`;
  else if (cur)
    cls = `${base} scale-100 cursor-pointer text-[24px] font-bold text-white [text-shadow:0_2px_18px_rgba(0,0,0,.35)] min-[900px]:text-[34px]`;
  else
    cls = `${base} scale-[.96] cursor-pointer text-[18px] font-[450] ${passed ? "text-white/50" : "text-white/35"} hover:text-white/70 min-[900px]:text-2xl min-[900px]:font-semibold`;
  if (inAb) cls += " bg-[#ec4141]/15";
  const useWords = cur && !meta && line.words && line.words.length > 0 && wordT >= 0;
  return (
    <p ref={(el) => setRef(index, el)} data-line={index} onClick={() => onPick(line)} className={cls}>
      {useWords && line.words
        ? line.words.map((w, i) => (
            <span key={i} style={wordStyle(w, wordT)} className="transition-colors duration-75">
              {w.text}
            </span>
          ))
        : line.text}
    </p>
  );
});

/* ---------------------------------------------------------------- 键盘 */

interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

/* ---------------------------------------------------------------- 组件 */

export default function AudioSurface(props: ViewerSurfaceProps) {
  // 每件成品一个干净实例：换件即重挂（AB/错误/轮询状态都不串）。
  return <AudioSurfaceInner key={props.asset.id} {...props} />;
}

function AudioSurfaceInner(props: ViewerSurfaceProps) {
  const { asset, density, annotations, controllerRef, onRequestMark, active } = props;
  const full = density === "full";
  const rawUrl = asset.url || "";
  // 空 / 非法地址＝没有可播放的音频：显示错误态，不渲染可点的播放键，也不把非法值塞给 <audio>。
  const hasSource = isPlayableUrl(rawUrl);
  const url = hasSource ? rawUrl.trim() : "";

  const audioRef = useRef<HTMLAudioElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const cvRef = useRef<HTMLCanvasElement>(null);
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([]);

  const [audioDur, setAudioDur] = useState(0);
  const [curSec, setCurSec] = useState(0);
  const [curLine, setCurLine] = useState(0);
  const [wordT, setWordT] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [rate, setRateState] = useState(1);
  const [volume, setVolumeState] = useState(1);
  const [muted, setMuted] = useState(false);
  const [ab, setAbState] = useState<AbLoop | null>(null);
  const [tip, setTip] = useState<{ left: number; text: string } | null>(null);
  const [showFollow, setShowFollow] = useState(false);
  const [toastMsg, setToastMsg] = useState("");
  const [store, setStore] = useState<StoreLyric | null>(null);
  const [coverOk, setCoverOk] = useState(true);
  const [wantWave, setWantWave] = useState(full);

  const pendingSeekRef = useRef(0);
  const resumedAtRef = useRef(0);
  const dragRef = useRef<number | null>(null);
  const userScrollUntilRef = useRef(0);
  const peaksRef = useRef<Float32Array | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const rafRef = useRef(0);
  const lastSaveRef = useRef(0);
  const lastPosPushRef = useRef(0);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---- 歌词模型 ---- */
  const lrcText = nonEmpty(asset.lyrics?.lrc) ?? nonEmpty(store?.lrc);
  const plainText = nonEmpty(asset.lyrics?.plain);
  const trackDur = asset.durationSec && asset.durationSec > 0 ? asset.durationSec : 0;
  const model = useMemo(() => buildLyricModel(lrcText, plainText, trackDur, audioDur), [lrcText, plainText, trackDur, audioDur]);
  const metaFlags = useMemo(() => model.lines.map((l) => isMetaLine(l.text)), [model.lines]);
  const awaiting = !lrcText && (asset.lyrics?.status === "aligning" || store?.status === "aligning");

  // 「最新值」引用：事件回调 / rAF / controller 都从这里读，不闭包过期状态。
  const live = useRef({ lines: model.lines, mode: model.mode, ab, annotations, onRequestMark });
  live.current = { lines: model.lines, mode: model.mode, ab, annotations, onRequestMark };

  const title = cleanTitle(asset.title) || "未命名曲目";
  const cover = asset.cover && coverOk ? asset.cover : "";
  const durShown = audioDur || trackDur;

  const flash = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMsg(""), 2200);
  }, []);

  /* ---- 画波形（命令式，rAF 驱动） ---- */
  const sizeWave = useCallback(() => {
    const wave = waveRef.current;
    const cv = cvRef.current;
    if (!wave || !cv) return;
    const r = wave.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    sizeRef.current = { w, h, dpr };
  }, []);

  const drawWave = useCallback(() => {
    const cv = cvRef.current;
    const a = audioRef.current;
    if (!cv || !a) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const { w: W, h: H, dpr } = sizeRef.current;
    if (W < 2) return;
    ctx.clearRect(0, 0, W, H);
    const d = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
    const c = dragRef.current ?? (a.currentTime || 0);
    const step = Math.max(3, Math.round(3.4 * dpr));
    const bw = Math.max(2, Math.round(2 * dpr));
    const n = Math.max(1, Math.floor(W / step));
    const frac = d > 0 ? c / d : 0;
    const loop = live.current.ab;
    if (loop && loop.b != null && d > 0) {
      ctx.fillStyle = "rgba(236,65,65,.2)";
      ctx.fillRect((loop.a / d) * W, 0, ((loop.b - loop.a) / d) * W, H);
    }
    const peaks = peaksRef.current;
    for (let i = 0; i < n; i++) {
      let p = 0.06;
      if (peaks) {
        const s = Math.floor((i / n) * peaks.length);
        const e = Math.max(s + 1, Math.floor(((i + 1) / n) * peaks.length));
        let m = 0;
        for (let k = s; k < e && k < peaks.length; k++) if (peaks[k] > m) m = peaks[k];
        p = m;
      }
      const h = Math.max(2 * dpr, p * H * 0.92);
      ctx.fillStyle = (i + 0.5) / n <= frac ? "#fff" : "rgba(255,255,255,.3)";
      ctx.fillRect(i * step, (H - h) / 2, bw, h);
    }
    if (loop && d > 0) {
      ctx.fillStyle = ACCENT;
      ctx.fillRect((loop.a / d) * W, 0, 2 * dpr, H);
      if (loop.b != null) ctx.fillRect((loop.b / d) * W - 2 * dpr, 0, 2 * dpr, H);
    }
    if (d > 0) {
      for (const an of live.current.annotations) {
        const loc = an.locator;
        if (loc.t !== "time") continue;
        const good = an.tags.includes("best");
        if (loc.b != null && loc.b > loc.a) {
          ctx.fillStyle = good ? "rgba(52,199,89,.7)" : "rgba(255,210,74,.7)";
          ctx.fillRect((loc.a / d) * W, H - 3 * dpr, ((loc.b - loc.a) / d) * W, 3 * dpr);
        }
        ctx.fillStyle = good ? "#34c759" : "#ffd24a";
        ctx.beginPath();
        ctx.arc((loc.a / d) * W, 4 * dpr, 3.2 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, []);

  /* ---- 时间推进 ---- */
  const applyTime = useCallback((t: number) => {
    setCurSec(Math.floor(t));
    const lines = live.current.lines;
    if (!lines.length) return;
    const i = lineIndexAt(lines, t);
    setCurLine(i);
    setWordT(lines[i] && lines[i].words ? t : -1);
  }, []);

  const loopRef = useRef<() => void>(noop);
  const kick = useCallback(() => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(() => loopRef.current());
  }, []);
  loopRef.current = () => {
    rafRef.current = 0;
    const a = audioRef.current;
    if (!a) return;
    const running = !a.paused || dragRef.current != null;
    if (running) {
      const lp = live.current.ab;
      if (dragRef.current == null && lp && lp.b != null && a.currentTime >= lp.b) a.currentTime = lp.a;
      applyTime(dragRef.current ?? a.currentTime);
    }
    drawWave();
    if (running) rafRef.current = requestAnimationFrame(() => loopRef.current());
  };

  /* ---- 播放控制 ---- */
  const seekTo = useCallback(
    (sec: number, play?: boolean) => {
      const a = audioRef.current;
      if (!a) return;
      const d = a.duration;
      if (!Number.isFinite(d) || d <= 0) {
        pendingSeekRef.current = Math.max(0, sec);
        if (play) void a.play().catch(noop);
        return;
      }
      a.currentTime = clamp(sec, 0, d);
      applyTime(a.currentTime);
      kick();
      if (play && a.paused) void a.play().catch(noop);
    },
    [applyTime, kick],
  );
  const seekBy = useCallback((delta: number) => seekTo((audioRef.current?.currentTime || 0) + delta), [seekTo]);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a || !hasSource) return;
    if (a.paused) void a.play().catch(noop);
    else a.pause();
  }, [hasSource]);

  const setRate = useCallback((r: number) => {
    const a = audioRef.current;
    if (!a) return;
    const v = clamp(r, 0.5, 2);
    a.defaultPlaybackRate = v;
    a.playbackRate = v;
    a.preservesPitch = true;
    setRateState(v);
    lsSet(PREF + "rate", String(v));
  }, []);
  const stepRate = useCallback(
    (dir: -1 | 0 | 1) => {
      const a = audioRef.current;
      const cur = a ? a.playbackRate : 1;
      let i = 0;
      for (let k = 0; k < RATES.length; k++) if (Math.abs(RATES[k] - cur) < 0.01) i = k;
      const n = dir === 0 ? (i + 1) % RATES.length : clamp(i + dir, 0, RATES.length - 1);
      setRate(RATES[n]);
    },
    [setRate],
  );

  const setVolume = useCallback((v: number) => {
    const a = audioRef.current;
    if (!a) return;
    const x = clamp(v, 0, 1);
    a.volume = x;
    a.muted = false;
    setVolumeState(x);
    setMuted(false);
    lsSet(PREF + "vol", String(x));
  }, []);
  const toggleMute = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    a.muted = !a.muted;
    setMuted(a.muted);
    flash(a.muted ? "静音" : "取消静音");
  }, [flash]);

  /* ---- A-B 循环 ---- */
  const commitAB = useCallback(
    (next: AbLoop | null) => {
      live.current.ab = next;
      setAbState(next);
      kick();
    },
    [kick],
  );
  const cycleAB = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    const t = a.currentTime || 0;
    const cur = live.current.ab;
    if (!cur) {
      commitAB({ a: t, b: null });
      flash(`已设 A 点 ${mmss(t)}，再按一次设 B 点`);
    } else if (cur.b == null) {
      if (t - cur.a < 1) {
        flash("B 点要比 A 点晚至少 1 秒");
        return;
      }
      commitAB({ a: cur.a, b: t });
      flash(`循环 ${mmss(cur.a)} – ${mmss(t)}`);
    } else {
      commitAB(null);
      flash("已取消循环");
    }
  }, [commitAB, flash]);

  /* ---- 续播位置 ---- */
  const posKey = POS_PREFIX + asset.id;
  const savePos = useCallback(
    (force: boolean) => {
      const a = audioRef.current;
      if (!a) return;
      const now = Date.now();
      if (!force && now - lastSaveRef.current < 2000) return;
      lastSaveRef.current = now;
      const d = a.duration;
      const c = a.currentTime || 0;
      if (Number.isFinite(d) && d > 0 && (c < 3 || c > d - 3)) lsDel(posKey);
      else lsSet(posKey, String(Math.floor(c)));
    },
    [posKey],
  );

  /* ---- Media Session 位置 ---- */
  const pushPosition = useCallback(() => {
    if (!full || typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const a = audioRef.current;
    if (!a || !navigator.mediaSession.setPositionState) return;
    const d = a.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        playbackRate: a.playbackRate || 1,
        position: clamp(a.currentTime || 0, 0, d),
      });
    } catch {
      /* 某些浏览器对 rate/position 组合严格：忽略 */
    }
  }, [full]);

  /* ---- 音频事件 ---- */
  const onMeta = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    setAudioDur(Number.isFinite(a.duration) ? a.duration : 0);
    const p = pendingSeekRef.current;
    if (p > 0 && Number.isFinite(a.duration) && p < a.duration - 1) {
      a.currentTime = p;
      if (resumedAtRef.current > 0 && Math.abs(p - resumedAtRef.current) < 0.5) flash(`已回到上次听到的 ${mmss(p)}`);
    }
    pendingSeekRef.current = 0;
    applyTime(a.currentTime || 0);
    kick();
    pushPosition();
  }, [applyTime, flash, kick, pushPosition]);

  const onTime = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    const c = a.currentTime || 0;
    const lp = live.current.ab;
    if (lp && lp.b != null && c >= lp.b) {
      a.currentTime = lp.a;
      return;
    }
    if (dragRef.current == null) applyTime(c);
    savePos(false);
    if (Date.now() - lastPosPushRef.current > 3000) {
      lastPosPushRef.current = Date.now();
      pushPosition();
    }
    if (a.paused) kick();
  }, [applyTime, kick, pushPosition, savePos]);

  const retry = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    const at = a.currentTime || pendingSeekRef.current || 0;
    setFailed(false);
    a.load();
    pendingSeekRef.current = at;
    void a.play().catch(noop);
  }, []);

  /* ---- 挂载：偏好 / 续播 / 水合前错过的媒体事件 ---- */
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const sr = parseFloat(lsGet(PREF + "rate") || "");
    setRate(Number.isFinite(sr) && sr >= 0.5 && sr <= 2 ? sr : 1);
    const sv = parseFloat(lsGet(PREF + "vol") || "");
    const vol = Number.isFinite(sv) ? clamp(sv, 0, 1) : 1;
    a.volume = vol;
    setVolumeState(vol);
    const saved = parseFloat(lsGet(posKey) || "");
    if (Number.isFinite(saved) && saved > 3) {
      pendingSeekRef.current = saved;
      resumedAtRef.current = saved;
    }
    // SSR 的 <audio> 可能在水合前就已拿到元数据 / 报错，React 事件补不到。
    if (a.error) setFailed(true);
    else if (a.readyState >= 1) onMeta();
    sizeWave();
    drawWave();
    return () => {
      savePos(true);
      a.pause();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      if (followTimerRef.current) clearTimeout(followTimerRef.current);
    };
    // 仅挂载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onHide = () => savePos(true);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [savePos]);

  // 壳不再显示本件：必须暂停。
  useEffect(() => {
    if (!active) audioRef.current?.pause();
  }, [active]);

  // 尺寸 / 标记 / 循环变化：重画。
  useEffect(() => {
    const wave = waveRef.current;
    if (!wave) return;
    let ro: ResizeObserver | null = null;
    const onResize = () => {
      sizeWave();
      kick();
    };
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(onResize);
      ro.observe(wave);
    } else window.addEventListener("resize", onResize);
    return () => {
      if (ro) ro.disconnect();
      else window.removeEventListener("resize", onResize);
    };
  }, [kick, sizeWave]);
  useEffect(() => {
    kick();
  }, [annotations, ab, kick]);

  /* ---- 波形解码（同源 / 有 CORS 才画；inline 到首次播放才解，省聊天里的流量） ---- */
  useEffect(() => {
    if (!url || !active || !wantWave) return;
    const cached = peaksCache.get(url);
    if (cached) {
      peaksRef.current = cached;
      kick();
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      decodePeaks(url, () => cancelled)
        .then((p) => {
          if (!p || cancelled) return;
          peaksCache.set(url, p);
          peaksRef.current = p;
          kick();
        })
        .catch(() => {
          /* 跨域 / 解码失败：保持朴素进度条，不伪造波形 */
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url, active, wantWave, kick]);

  /* ---- 命中 store 专辑 tracks.json：取真 LRC / 轮询 aligning（向后兼容，失败静默） ---- */
  const assetAligning = asset.lyrics?.status === "aligning";
  const hasAssetLrc = !!nonEmpty(asset.lyrics?.lrc);
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
        if (cancelled || !hit) return; // 命不中就不轮询
        const nlrc = nonEmpty(hit.lrc);
        if (nlrc) {
          // 无缝换成真 LRC：不重载音频、不 seek。
          waitingPoll = false;
          setStore({ lrc: nlrc, status: hit.lyric_status });
          return;
        }
        setStore((s) => (s && s.status === hit.lyric_status ? s : { status: hit.lyric_status }));
        waitingPoll = assetAligning || hit.lyric_status === "aligning";
      } catch {
        // 失败静默：已在轮询中就继续试，首次失败则放弃
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

  /* ---- 歌词滚动居中 ---- */
  const centerLine = useCallback((el: HTMLElement | null, smooth: boolean) => {
    const box = boxRef.current;
    if (!el || !box) return;
    const br = box.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const delta = er.top + er.height / 2 - (br.top + br.height / 2);
    if (Math.abs(delta) < 2) return;
    if (smooth) box.scrollTo({ top: box.scrollTop + delta, behavior: "smooth" });
    else box.scrollTop += delta;
  }, []);

  useEffect(() => {
    if (!full) return;
    if (Date.now() > userScrollUntilRef.current) centerLine(lineRefs.current[curLine] ?? null, true);
  }, [curLine, full, centerLine]);

  // 歌词换了一份（含估算→真 LRC 无缝替换）：先把当前句摆正，不动画。
  useEffect(() => {
    if (!full) return;
    const a = audioRef.current;
    const t = a ? a.currentTime || 0 : 0;
    if (a) applyTime(t);
    const raf = requestAnimationFrame(() => {
      const target =
        t > 0
          ? lineRefs.current[lineIndexAt(model.lines, t)]
          : lineRefs.current[metaFlags.findIndex((m) => !m) >= 0 ? metaFlags.findIndex((m) => !m) : 0];
      centerLine(target ?? null, false);
    });
    return () => cancelAnimationFrame(raf);
  }, [model.lines, metaFlags, full, applyTime, centerLine]);

  const markUserScroll = useCallback(() => {
    userScrollUntilRef.current = Date.now() + 4000;
    setShowFollow(live.current.lines.length > 0);
    if (followTimerRef.current) clearTimeout(followTimerRef.current);
    followTimerRef.current = setTimeout(() => setShowFollow(false), 4200);
  }, []);
  const backToCurrent = useCallback(() => {
    userScrollUntilRef.current = 0;
    setShowFollow(false);
    centerLine(lineRefs.current[curLine] ?? null, true);
  }, [centerLine, curLine]);

  const pickLine = useCallback(
    (line: LrcLine) => {
      if (isMetaLine(line.text)) return;
      userScrollUntilRef.current = 0;
      setShowFollow(false);
      seekTo(line.t, true);
    },
    [seekTo],
  );
  const setLineRef = useCallback((i: number, el: HTMLParagraphElement | null) => {
    lineRefs.current[i] = el;
  }, []);

  /* ---- 进度条拖动 ---- */
  const ratioFrom = (clientX: number): number => {
    const wave = waveRef.current;
    if (!wave) return 0;
    const r = wave.getBoundingClientRect();
    return clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
  };
  const audioDuration = () => {
    const d = audioRef.current?.duration ?? 0;
    return Number.isFinite(d) && d > 0 ? d : 0;
  };
  const onWaveDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button > 0) return;
    const d = audioDuration();
    if (!d) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件无捕获：忽略 */
    }
    dragRef.current = ratioFrom(e.clientX) * d;
    applyTime(dragRef.current);
    kick();
    e.preventDefault();
  };
  const onWaveMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = audioDuration();
    const r = ratioFrom(e.clientX);
    if (d && (e.pointerType === "mouse" || dragRef.current != null)) setTip({ left: r * 100, text: mmss(r * d) });
    if (dragRef.current != null && d) {
      dragRef.current = r * d;
      applyTime(dragRef.current);
      kick();
    }
  };
  const onWaveUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current == null) return;
    const d = audioDuration();
    dragRef.current = null;
    setTip(null);
    seekTo(ratioFrom(e.clientX) * d);
  };
  const onWaveCancel = () => {
    dragRef.current = null;
    setTip(null);
    kick();
  };

  /* ---- 键盘（full：窗口级；inline：卡片聚焦时） ---- */
  const keyRef = useRef<(e: KeyLike) => void>(noop);
  keyRef.current = (e: KeyLike) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tg = e.target instanceof HTMLElement ? e.target : null;
    const tag = tg ? tg.tagName : "";
    const inputType = tg instanceof HTMLInputElement ? tg.type : "";
    if ((tag === "INPUT" && inputType !== "range") || tag === "TEXTAREA" || tag === "SELECT" || tg?.isContentEditable) return;
    const k = e.key;
    const a = audioRef.current;
    const big = e.shiftKey ? 15 : 5;
    let handled = true;
    if (k === " " || k === "Spacebar") {
      if (tag === "BUTTON") return; // 聚焦在按钮上时让按钮自己响应
      togglePlay();
    } else if (k === "ArrowLeft") seekBy(-big);
    else if (k === "ArrowRight") seekBy(big);
    else if (k === "ArrowUp" || k === "ArrowDown") {
      if (tag === "INPUT" || !a) return;
      setVolume(a.volume + (k === "ArrowUp" ? 0.05 : -0.05));
      flash(`音量 ${Math.round(a.volume * 100)}%`);
    } else if (k === "m" || k === "M") toggleMute();
    else if (k === "[") stepRate(-1);
    else if (k === "]") stepRate(1);
    else if (k === "l" || k === "L") cycleAB();
    else if (k === "f" || k === "F") live.current.onRequestMark();
    else if (/^[0-9]$/.test(k)) {
      const d = audioDuration();
      if (d) seekTo((d * Number(k)) / 10);
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  useEffect(() => {
    if (!full || !active) return;
    const h = (e: KeyboardEvent) => keyRef.current(e);
    // 捕获阶段：种类内语义（←/→ 步进）优先于壳的切换成员。
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [full, active]);

  const onRootKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!full && active) keyRef.current(e);
  };
  const onRootClickCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    // 鼠标 / 触摸点按钮后立刻失焦，让空格继续是「播放/暂停」而不是再点一次这个按钮。
    if (e.detail > 0 && e.target instanceof Element) {
      const b = e.target.closest("button");
      if (b) {
        b.blur();
        if (!full) rootRef.current?.focus({ preventScroll: true });
      }
    }
  };

  /* ---- Media Session（仅 full） ---- */
  useEffect(() => {
    if (!full || !active || typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.metadata = new MediaMetadata({
        title,
        artist: "",
        album: "",
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
  }, [full, active, title, cover, seekBy, seekTo]);

  /* ---- 发布 controller ---- */
  useEffect(() => {
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const ctl: ViewerController = {
      capture() {
        const a = audioRef.current;
        const { ab: lp, lines, mode } = live.current;
        if (lp && lp.b != null) {
          const text = lyricTextBetween(lines, mode, lp.a, lp.b);
          return { locator: { t: "time", a: r1(lp.a), b: r1(lp.b) }, ...(text ? { excerpt: text } : {}) };
        }
        const t = a ? a.currentTime || 0 : 0;
        const text = lyricAt(lines, mode, t);
        return { locator: { t: "time", a: r1(t) }, ...(text ? { excerpt: text } : {}) };
      },
      reveal(loc: Locator) {
        if (loc.t === "time") seekTo(loc.a, true);
      },
      loop(range) {
        if (!range) {
          commitAB(null);
          return;
        }
        commitAB({ a: Math.max(0, range.a), b: range.b });
        seekTo(range.a, true);
        flash(`循环 ${mmss(range.a)} – ${mmss(range.b)}`);
      },
      play() {
        void audioRef.current?.play().catch(noop);
      },
      pause() {
        audioRef.current?.pause();
      },
    };
    controllerRef.current = ctl;
    return () => {
      if (controllerRef.current === ctl) controllerRef.current = null;
    };
  }, [controllerRef, seekTo, commitAB, flash]);

  /* ---------------------------------------------------------------- 渲染 */

  const chip = (() => {
    if (model.mode === "estimated") return "估算歌词";
    if (model.mode === "word") return "逐字歌词";
    if (model.mode === "line") return "同步歌词";
    if (awaiting) return store?.capped ? "歌词计时还没生成好" : "歌词计时中";
    return "";
  })();
  const banner = model.suspect
    ? "这首的歌词计时与音频对不上，已改为估算滚动"
    : model.mode === "estimated" && awaiting
      ? store?.capped
        ? "歌词计时还没生成好"
        : "歌词计时中，先按比例滚动"
      : "";
  const emptyLyric = awaiting ? (store?.capped ? "歌词计时还没生成好" : "歌词计时中…") : "本曲暂无歌词";

  const abLabel = !ab ? "循环A-B" : ab.b == null ? `A ${mmss(ab.a)} …` : `${mmss(ab.a)}–${mmss(ab.b)}`;
  const rateLabel = `${rate.toFixed(2).replace(/0+$/, "").replace(/\.$/, ".0")}×`;
  const timeAnnotations = annotations.filter((a) => a.locator.t === "time").length;
  const inlineLine = (() => {
    const l = model.lines[curLine];
    if (l && !metaFlags[curLine]) return l.text.trim();
    return model.lines.length ? "" : awaiting ? "歌词计时中…" : "";
  })();

  const playBtn = (
    <button
      type="button"
      onClick={togglePlay}
      disabled={!hasSource}
      aria-label={playing ? "暂停" : "播放"}
      title={hasSource ? "播放/暂停 (空格)" : "没有可播放的音频"}
      className={`relative grid flex-none touch-manipulation place-items-center rounded-full text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 ${
        full ? "h-16 w-16 shadow-[0_8px_24px_rgba(236,65,65,.45)]" : "h-11 w-11"
      }`}
      style={{ background: hasSource ? ACCENT : "#4b4b52" }}
    >
      {playing ? (
        <Pause className={full ? "h-7 w-7" : "h-5 w-5"} fill="currentColor" aria-hidden />
      ) : (
        <Play className={full ? "h-7 w-7" : "h-5 w-5"} fill="currentColor" aria-hidden />
      )}
      {waiting && playing && (
        <span className="pointer-events-none absolute -inset-1 animate-spin rounded-full border-2 border-transparent border-t-white" aria-hidden />
      )}
    </button>
  );

  const markBtn = (
    <button
      type="button"
      onClick={onRequestMark}
      aria-label="标记听感"
      title="标记听感 (F)"
      className={`relative flex min-h-11 min-w-11 flex-none touch-manipulation items-center justify-center rounded-xl text-white/70 transition hover:text-white active:opacity-70 ${
        full ? "flex-col gap-0.5 px-3 text-[13px]" : ""
      }`}
    >
      <Flag className={full ? "h-[22px] w-[22px]" : "h-5 w-5"} aria-hidden />
      {full && <span>标记</span>}
      {timeAnnotations > 0 && (
        <b
          className="absolute right-1 top-0.5 min-w-4 rounded-lg px-1 text-center text-[11px] font-bold leading-4 text-white"
          style={{ background: ACCENT }}
        >
          {timeAnnotations}
        </b>
      )}
    </button>
  );

  const waveEl = (
    <div
      ref={waveRef}
      role="slider"
      tabIndex={0}
      aria-label="播放进度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={durShown > 0 ? Math.round((curSec / durShown) * 100) : 0}
      aria-valuetext={`${mmss(curSec)} / ${mmss(durShown)}`}
      onPointerDown={onWaveDown}
      onPointerMove={onWaveMove}
      onPointerUp={onWaveUp}
      onPointerCancel={onWaveCancel}
      onPointerLeave={() => {
        if (dragRef.current == null) setTip(null);
      }}
      className={`relative cursor-pointer touch-none select-none ${full ? "h-12 min-[900px]:h-16" : "h-11"}`}
    >
      <canvas ref={cvRef} className="block h-full w-full" />
      {tip && (
        <div
          className="pointer-events-none absolute -top-7 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/75 px-2 py-0.5 text-[13px] tabular-nums"
          style={{ left: `${tip.left}%` }}
        >
          {tip.text}
        </div>
      )}
    </div>
  );

  const timesEl = (
    <div className="mt-0.5 flex justify-between px-px text-[13px] tabular-nums text-white/60">
      <span>{mmss(curSec)}</span>
      <span>{mmss(durShown)}</span>
    </div>
  );

  const coverEl = cover ? (
    // eslint-disable-next-line @next/next/no-img-element -- 平台直链封面，尺寸不定
    <img
      src={cover}
      alt="封面"
      onError={() => setCoverOk(false)}
      className={
        full
          ? "h-[52px] w-[52px] flex-none rounded-[10px] bg-neutral-800 object-cover shadow-[0_6px_20px_rgba(0,0,0,.45)] min-[900px]:aspect-square min-[900px]:h-auto min-[900px]:w-full min-[900px]:rounded-[18px] min-[900px]:shadow-[0_24px_60px_rgba(0,0,0,.55)]"
          : "h-12 w-12 flex-none rounded-lg bg-neutral-800 object-cover"
      }
    />
  ) : null;

  const chipEl = chip ? (
    <span className="flex-none self-start rounded-full border border-white/20 px-2 py-0.5 text-[13px] leading-[1.35] text-white/75">{chip}</span>
  ) : null;

  const errorEl = failed || !hasSource ? (
    <div role="alert" className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/70 p-4 text-center text-[15px] text-[#ffb4b4]">
      <span>{hasSource ? "音频加载失败，可能是网络波动" : "没有可播放的音频"}</span>
      {hasSource && (
        <button
          type="button"
          onClick={retry}
          className="min-h-11 touch-manipulation rounded-full border border-white/20 px-5 text-white active:opacity-70"
        >
          重试
        </button>
      )}
    </div>
  ) : null;

  const toastEl = toastMsg ? (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute left-1/2 top-3 z-20 max-w-[88%] -translate-x-1/2 rounded-xl bg-black/80 px-4 py-2.5 text-center text-[13px] text-white"
    >
      {toastMsg}
    </div>
  ) : null;

  const audioEl = (
    <audio
      ref={audioRef}
      src={url || undefined}
      preload="metadata"
      playsInline
      onPlay={() => {
        setPlaying(true);
        setWantWave(true);
        kick();
        pushPosition();
      }}
      onPause={() => {
        setPlaying(false);
        setWaiting(false);
        savePos(true);
        kick();
        pushPosition();
      }}
      onWaiting={() => {
        if (audioRef.current && !audioRef.current.paused) setWaiting(true);
      }}
      onPlaying={() => {
        setWaiting(false);
        setFailed(false);
      }}
      onCanPlay={() => setWaiting(false)}
      onSeeked={() => {
        pushPosition();
        kick();
      }}
      onRateChange={() => {
        if (audioRef.current) setRateState(audioRef.current.playbackRate);
        pushPosition();
      }}
      onTimeUpdate={onTime}
      onLoadedMetadata={onMeta}
      onDurationChange={() => {
        const a = audioRef.current;
        if (a) setAudioDur(Number.isFinite(a.duration) ? a.duration : 0);
      }}
      onError={() => {
        if (audioRef.current?.getAttribute("src")) setFailed(true);
      }}
      onEnded={() => {
        // 不自动跳下一首（那是壳 / 集合的事）：回到开头停住。
        lsDel(posKey);
        setPlaying(false);
        const a = audioRef.current;
        if (a) {
          a.currentTime = 0;
          applyTime(0);
        }
        kick();
      }}
    />
  );

  /* ---- inline：单列紧凑卡 ---- */
  if (!full) {
    return (
      <div
        ref={rootRef}
        tabIndex={0}
        onKeyDown={onRootKeyDown}
        onClickCapture={onRootClickCapture}
        className="relative w-full overflow-hidden rounded-2xl bg-[#141416] text-white outline-none ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <div className="flex items-center gap-3 p-2.5">
          {coverEl}
          {playBtn}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</p>
              {chipEl}
            </div>
            {waveEl}
            {timesEl}
          </div>
          {markBtn}
        </div>
        {inlineLine && <p className="truncate px-3 pb-2.5 text-[13px] text-white/60">{inlineLine}</p>}
        {toastEl}
        {errorEl}
        {audioEl}
      </div>
    );
  }

  /* ---- full：桌面双栏 / 手机单列 ---- */
  return (
    <div ref={rootRef} onClickCapture={onRootClickCapture} className="relative isolate flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#0a0a0a] text-white">
      {cover && (
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element -- 背景虚化封面 */}
          <img
            src={cover}
            alt=""
            className="absolute -inset-[12%] h-[124%] w-[124%] max-w-none scale-[1.08] object-cover blur-[52px] brightness-[.55] saturate-[1.25]"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-black/20 to-black/80" />
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col min-[900px]:flex-row-reverse min-[900px]:px-6 min-[900px]:pb-6">
        <div className="relative mb-1 min-h-0 flex-1 min-[900px]:mb-0">
          <div
            ref={boxRef}
            style={LYRIC_MASK}
            aria-label="歌词"
            onWheel={markUserScroll}
            onTouchStart={markUserScroll}
            className="h-full overflow-y-auto overscroll-contain px-5 py-[28vh] text-center [scrollbar-width:none] min-[900px]:mx-auto min-[900px]:max-w-[860px] min-[900px]:px-14 min-[900px]:text-left [&::-webkit-scrollbar]:hidden"
          >
            {model.lines.length ? (
              model.lines.map((l, i) => (
                <LyricLine
                  key={i}
                  line={l}
                  index={i}
                  meta={metaFlags[i]}
                  cur={i === curLine}
                  passed={i < curLine}
                  inAb={!!(ab && ab.b != null && l.t >= ab.a - 0.05 && l.t < ab.b)}
                  wordT={i === curLine ? wordT : -1}
                  onPick={pickLine}
                  setRef={setLineRef}
                />
              ))
            ) : (
              <p className="m-0 px-2 py-2 text-[13px] text-white/40">{emptyLyric}</p>
            )}
          </div>
          {showFollow && (
            <button
              type="button"
              onClick={backToCurrent}
              className="absolute bottom-3.5 right-3.5 z-[3] min-h-11 touch-manipulation rounded-full border border-white/12 bg-white/15 px-4 text-[13px] backdrop-blur-md"
            >
              回到当前
            </button>
          )}
        </div>
        <div className="flex-none px-4 pb-[calc(10px+env(safe-area-inset-bottom,0px))] pt-1 min-[900px]:w-[440px] min-[900px]:self-center min-[900px]:px-6 min-[900px]:pb-0">
          {banner && (
            <div className="mb-1.5 rounded-[10px] border border-white/12 bg-white/[.07] px-3 py-1.5 text-[13px] leading-snug text-white/65 min-[900px]:mb-3">
              {banner}
            </div>
          )}
          <div className="flex items-center gap-3 min-[900px]:mb-3 min-[900px]:flex-col min-[900px]:items-stretch min-[900px]:gap-3.5">
            {coverEl}
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <h1 className="m-0 min-w-0 flex-1 truncate text-base font-bold min-[900px]:text-2xl">{title}</h1>
              {chipEl}
            </div>
          </div>
          {waveEl}
          {timesEl}
          <div className="flex items-center justify-center gap-[18px] pt-1">
            <button
              type="button"
              onClick={() => seekTo(0)}
              aria-label="回到开头"
              title="回到开头"
              className="grid h-12 w-12 touch-manipulation place-items-center rounded-full text-white/85 active:opacity-70"
            >
              <RotateCcw className="h-6 w-6" aria-hidden />
            </button>
            {playBtn}
            <button
              type="button"
              onClick={() => stepRate(0)}
              aria-label="倍速"
              title="倍速 ([ ])"
              className={`grid h-11 min-w-12 touch-manipulation place-items-center rounded-full border px-3 text-[13px] font-bold tabular-nums active:opacity-70 ${
                rate !== 1 ? "border-[#ec4141]/50 bg-[#ec4141]/15 text-white" : "border-white/12 text-white/85"
              }`}
            >
              {rateLabel}
            </button>
          </div>
          <div className="flex items-start justify-around pt-1.5">
            <button
              type="button"
              onClick={cycleAB}
              aria-label="循环 A-B"
              title="循环 A-B (L)"
              className={`flex min-h-11 min-w-16 touch-manipulation flex-col items-center gap-0.5 rounded-xl px-1.5 py-1 text-[13px] ${
                ab ? "text-white" : "text-white/60 hover:text-white"
              }`}
            >
              <Repeat className="h-[22px] w-[22px]" style={ab ? { color: ACCENT } : undefined} aria-hidden />
              <span>{abLabel}</span>
            </button>
            {markBtn}
            <label className="hidden items-center gap-1.5 text-white/60 min-[900px]:flex">
              <button
                type="button"
                onClick={toggleMute}
                aria-label={muted ? "取消静音" : "静音"}
                className="grid min-h-11 min-w-11 place-items-center"
              >
                {muted || volume === 0 ? <VolumeX className="h-5 w-5" aria-hidden /> : <Volume2 className="h-5 w-5" aria-hidden />}
              </button>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round((muted ? 0 : volume) * 100)}
                onChange={(e) => setVolume(Number(e.target.value) / 100)}
                aria-label="音量"
                className="w-[84px] accent-white"
              />
            </label>
          </div>
        </div>
      </div>
      {toastEl}
      {errorEl}
      {audioEl}
    </div>
  );
}
