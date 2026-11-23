"use client";

// 赏阅 · 对比查看器。纯展示：不收集参数、不依赖壳。
//   图片  slider 前后滑块 / side 并排同步缩放 / blind 盲选后揭晓 / swap 原位切换
//   视频  swap：两路同一时间点同步播放，B 键无缝切换画面与声音，共用一条进度条
//   音频  swap：同上，只切换发声（A/B 听感对比）
// 视频/音频只有 swap 这一种有意义的对比，传入其它 mode 时按 swap 处理。

import { useCallback, useEffect, useRef, useState } from "react";
import { mmss } from "@/lib/viewer/review";
import type { ViewAsset } from "@/lib/viewer/types";

export type CompareMode = "slider" | "side" | "blind" | "swap";

export interface CompareViewerProps {
  a: ViewAsset;
  b: ViewAsset;
  mode?: CompareMode;
  labels?: [string, string];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const BTN =
  "inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full px-4 text-[13px] font-medium text-white/90 " +
  "transition-colors duration-150 hover:bg-white/20 active:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60";
const BADGE =
  "pointer-events-none rounded-full bg-black/55 px-3 py-1 text-[13px] font-medium text-white backdrop-blur-xl";

const MODE_LABEL: Record<CompareMode, string> = { slider: "滑块", side: "并排", blind: "盲选", swap: "切换" };

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

/** 稳定的伪随机（同一对成品同一轮顺序固定，SSR/水合不会不一致）。 */
function hashParity(s: string): boolean {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h & 1) === 1;
}

interface Size {
  w: number;
  h: number;
}
function priorSize(a: ViewAsset): Size | null {
  return a.width && a.height ? { w: a.width, h: a.height } : null;
}

function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-white/85">
      <span>{what}加载失败</span>
      <button type="button" onClick={onRetry} className={`${BTN} bg-white/15`}>
        重试
      </button>
    </div>
  );
}

/* =========================================================================
 * 图片 · 滑块
 * ========================================================================= */

function SliderCompare({ a, b, labels }: { a: ViewAsset; b: ViewAsset; labels: [string, string] }) {
  const [pos, setPos] = useState(50);
  const [natA, setNatA] = useState<Size | null>(null);
  const [natB, setNatB] = useState<Size | null>(null);
  const [errA, setErrA] = useState(false);
  const [errB, setErrB] = useState(false);
  const [rk, setRk] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const setFromEvent = (clientX: number) => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r || !r.width) return;
    setPos(clamp(((clientX - r.left) / r.width) * 100, 0, 100));
  };
  const aspect = natA ?? priorSize(a) ?? { w: 4, h: 3 };

  if (errA || errB) {
    return (
      <LoadError
        what={errA && errB ? "两张图" : errA ? labels[0] : labels[1]}
        onRetry={() => {
          setErrA(false);
          setErrB(false);
          setRk((k) => k + 1);
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={boxRef}
        role="slider"
        tabIndex={0}
        aria-label={`拖动对比 ${labels[0]} 与 ${labels[1]}，左右方向键微调`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pos)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          e.currentTarget.focus({ preventScroll: true });
          setFromEvent(e.clientX);
        }}
        onPointerMove={(e) => dragging.current && setFromEvent(e.clientX)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 10 : 2;
          if (e.key === "ArrowLeft") setPos((p) => clamp(p - step, 0, 100));
          else if (e.key === "ArrowRight") setPos((p) => clamp(p + step, 0, 100));
          else if (e.key === "Home") setPos(0);
          else if (e.key === "End") setPos(100);
          else return;
          e.preventDefault();
        }}
        className="relative w-full max-h-[75dvh] select-none overflow-hidden rounded-ios-md bg-black/40 outline-none focus-visible:ring-2 focus-visible:ring-[#007aff]"
        style={{ aspectRatio: `${aspect.w} / ${aspect.h}`, touchAction: "pan-y" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={`b${rk}`}
          src={b.url}
          alt={labels[1]}
          draggable={false}
          onLoad={(e) => setNatB({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setErrB(true)}
          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
        />
        <div className="pointer-events-none absolute inset-0" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={`a${rk}`}
            src={a.url}
            alt={labels[0]}
            draggable={false}
            onLoad={(e) => setNatA({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setErrA(true)}
            className="absolute inset-0 h-full w-full object-contain"
          />
        </div>
        <div
          className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.25)]"
          style={{ left: `${pos}%` }}
        >
          <span className="absolute left-1/2 top-1/2 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-[15px] text-black shadow-lg">
            ⇄
          </span>
        </div>
        <span className={`${BADGE} absolute left-2 top-2`}>{labels[0]}</span>
        <span className={`${BADGE} absolute right-2 top-2`}>{labels[1]}</span>
      </div>
      <SizeLine items={[[labels[0], natA], [labels[1], natB]]} />
    </div>
  );
}

function SizeLine({ items }: { items: [string, Size | null][] }) {
  const known = items.filter(([, s]) => s);
  if (!known.length) return null;
  return (
    <p className="text-[13px] text-white/70">
      {known.map(([l, s]) => `${l} ${s!.w}×${s!.h}px`).join("　")}
    </p>
  );
}

/* =========================================================================
 * 图片 · 同步缩放平移的并排窗格（side / blind / swap 共用）
 * ========================================================================= */

interface PaneItem {
  asset: ViewAsset;
  /** 不传＝不显示标签（盲选）。 */
  label?: string;
}
interface Xf {
  z: number;
  tx: number;
  ty: number;
}
const Z_MAX = 8;

function SyncPanes({ items, onNat }: { items: PaneItem[]; onNat?: (assetId: string, size: Size) => void }) {
  const n = items.length;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [xf, setXf] = useState<Xf>({ z: 1, tx: 0, ty: 0 });
  const xfRef = useRef(xf);
  const [firstNat, setFirstNat] = useState<{ id: string; size: Size } | null>(null);
  const [errId, setErrId] = useState<string | null>(null);
  const [rk, setRk] = useState(0);

  const apply = useCallback((z: number, tx: number, ty: number, pw: number, ph: number) => {
    const zz = clamp(z, 1, Z_MAX);
    const limX = ((zz - 1) * pw) / 2;
    const limY = ((zz - 1) * ph) / 2;
    const next = { z: zz, tx: zz === 1 ? 0 : clamp(tx, -limX, limX), ty: zz === 1 ? 0 : clamp(ty, -limY, limY) };
    xfRef.current = next;
    setXf(next);
  }, []);

  /** clientXY → (窗格序号, 相对该窗格中心的坐标, 窗格尺寸)。 */
  const locate = useCallback(
    (cx: number, cy: number, forceIdx?: number) => {
      const r = wrapRef.current!.getBoundingClientRect();
      const pw = r.width / n;
      const idx = forceIdx ?? clamp(Math.floor((cx - r.left) / pw), 0, n - 1);
      return { idx, x: cx - r.left - idx * pw - pw / 2, y: cy - r.top - r.height / 2, pw, ph: r.height };
    },
    [n],
  );

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const g = useRef<
    | { k: "none" }
    | { k: "pan"; x0: number; y0: number; tx0: number; ty0: number; moved: boolean }
    | { k: "pinch"; idx: number; d0: number; z0: number; q: { x: number; y: number } }
  >({ k: "none" });
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  const begin = useCallback(() => {
    const pts = [...pointers.current.values()];
    const cur = xfRef.current;
    if (pts.length >= 2) {
      const [p1, p2] = pts;
      const idx = locate(p1.x, p1.y).idx;
      const m = locate((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, idx);
      g.current = {
        k: "pinch",
        idx,
        d0: Math.max(1, Math.hypot(p1.x - p2.x, p1.y - p2.y)),
        z0: cur.z,
        q: { x: (m.x - cur.tx) / cur.z, y: (m.y - cur.ty) / cur.z },
      };
    } else if (pts.length === 1) {
      g.current = { k: "pan", x0: pts[0].x, y0: pts[0].y, tx0: cur.tx, ty0: cur.ty, moved: false };
    } else g.current = { k: "none" };
  }, [locate]);

  // 滚轮（非 passive）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const k = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0016));
      const cur = xfRef.current;
      const z2 = clamp(cur.z * k, 1, Z_MAX);
      const p = locate(e.clientX, e.clientY);
      apply(z2, p.x - (p.x - cur.tx) * (z2 / cur.z), p.y - (p.y - cur.ty) * (z2 / cur.z), p.pw, p.ph);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [apply, locate, n]);

  const first = items[0].asset;
  const aspect = (firstNat?.id === first.id ? firstNat.size : null) ?? priorSize(first) ?? { w: 4, h: 3 };

  if (errId) {
    return <LoadError what="图片" onRetry={() => { setErrId(null); setRk((k) => k + 1); }} />;
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={wrapRef}
        tabIndex={0}
        aria-label="并排对比，滚轮或双指捏合同步缩放，拖拽同步平移"
        onPointerDown={(e) => {
          if (e.pointerType === "mouse" && e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          begin();
        }}
        onPointerMove={(e) => {
          if (!pointers.current.has(e.pointerId)) return;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          const gs = g.current;
          const cur = xfRef.current;
          if (gs.k === "pinch" && pointers.current.size >= 2) {
            const [p1, p2] = [...pointers.current.values()];
            const m = locate((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, gs.idx);
            const z = clamp(gs.z0 * (Math.hypot(p1.x - p2.x, p1.y - p2.y) / gs.d0), 1, Z_MAX);
            apply(z, m.x - gs.q.x * z, m.y - gs.q.y * z, m.pw, m.ph);
          } else if (gs.k === "pan") {
            const dx = e.clientX - gs.x0;
            const dy = e.clientY - gs.y0;
            if (!gs.moved && Math.hypot(dx, dy) > 4) gs.moved = true;
            if (gs.moved && cur.z > 1) {
              const r = wrapRef.current!.getBoundingClientRect();
              apply(cur.z, gs.tx0 + dx, gs.ty0 + dy, r.width / n, r.height);
            }
          }
        }}
        onPointerUp={(e) => {
          if (!pointers.current.has(e.pointerId)) return;
          pointers.current.delete(e.pointerId);
          const gs = g.current;
          if (gs.k === "pan" && !gs.moved && pointers.current.size === 0) {
            const now = performance.now();
            const lt = lastTap.current;
            if (lt && now - lt.t < 320 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 28) {
              lastTap.current = null;
              const p = locate(e.clientX, e.clientY);
              const cur = xfRef.current;
              if (cur.z > 1.01) apply(1, 0, 0, p.pw, p.ph);
              else apply(2.5, p.x - p.x * 2.5, p.y - p.y * 2.5, p.pw, p.ph);
            } else lastTap.current = { t: now, x: e.clientX, y: e.clientY };
          }
          begin();
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          begin();
        }}
        className={`relative grid w-full max-h-[75dvh] select-none overflow-hidden rounded-ios-md bg-black/40 outline-none focus-visible:ring-2 focus-visible:ring-[#007aff] ${
          xf.z > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"
        }`}
        style={{
          gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`,
          aspectRatio: `${aspect.w * n} / ${aspect.h}`,
          touchAction: "none",
        }}
      >
        {items.map(({ asset, label }, i) => (
          <div key={`${asset.id}-${i}-${rk}`} className={`relative overflow-hidden ${i > 0 ? "border-l border-white/60" : ""}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={asset.url}
              alt={label ?? `候选 ${i + 1}`}
              draggable={false}
              onLoad={(e) => {
                const size = { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight };
                if (i === 0) setFirstNat({ id: asset.id, size });
                onNat?.(asset.id, size);
              }}
              onError={() => setErrId(asset.id)}
              className="pointer-events-none absolute inset-0 h-full w-full object-contain"
              style={{ transform: `translate(${xf.tx}px, ${xf.ty}px) scale(${xf.z})`, willChange: "transform" }}
            />
            {label ? <span className={`${BADGE} absolute left-2 top-2`}>{label}</span> : null}
          </div>
        ))}
      </div>
      <div className="flex min-h-[44px] items-center justify-between gap-3 text-[13px] text-white/70">
        <span>滚轮 / 双指缩放，拖拽平移，双击放大{n > 1 ? "（两张同步）" : ""}</span>
        {xf.z > 1 ? (
          <button type="button" onClick={() => apply(1, 0, 0, 1, 1)} className={`${BTN} bg-white/15`}>
            复位 {Math.round(xf.z * 100)}%
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* =========================================================================
 * 图片 · 盲选
 * ========================================================================= */

function BlindCompare({ a, b, labels }: { a: ViewAsset; b: ViewAsset; labels: [string, string] }) {
  const [round, setRound] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [nats, setNats] = useState<Record<string, Size>>({});
  const swapped = hashParity(`${a.id}|${b.id}|${round}`);
  const shown = swapped ? [b, a] : [a, b];
  const labelOf = (x: ViewAsset) => (x === a ? labels[0] : labels[1]);
  const revealed = picked != null;

  return (
    <div className="flex flex-col gap-2">
      <SyncPanes
        items={shown.map((asset, i) => ({ asset, label: revealed ? labelOf(asset) : `候选 ${i + 1}` }))}
        onNat={(id, size) => setNats((m) => (m[id] ? m : { ...m, [id]: size }))}
      />
      {revealed ? (
        <div className="flex flex-col gap-2 text-[13px] text-white">
          <p>
            你选了「{labelOf(shown[picked])}」
            {picked === 0 ? "（左）" : "（右）"}；另一张是「{labelOf(shown[1 - picked])}」。
          </p>
          <SizeLine items={shown.map((x) => [labelOf(x), nats[x.id] ?? null])} />
          <button
            type="button"
            onClick={() => {
              setPicked(null);
              setRound((r) => r + 1);
            }}
            className={`${BTN} self-start bg-white/15`}
          >
            再盲选一次
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-white/70">不告诉你哪张是哪张，凭观感选：</span>
          <button type="button" onClick={() => setPicked(0)} className={`${BTN} bg-white/20`}>
            选左边
          </button>
          <button type="button" onClick={() => setPicked(1)} className={`${BTN} bg-white/20`}>
            选右边
          </button>
        </div>
      )}
    </div>
  );
}

/* =========================================================================
 * 图片 · 原位切换（B 键）
 * ========================================================================= */

function ImageSwap({ a, b, labels }: { a: ViewAsset; b: ViewAsset; labels: [string, string] }) {
  const [side, setSide] = useState<0 | 1>(0);
  const [nats, setNats] = useState<Record<string, Size>>({});
  const cur = side === 0 ? a : b;
  return (
    <div
      className="flex flex-col gap-2 outline-none"
      tabIndex={0}
      onKeyDown={(e) => {
        if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === "b" || e.key === "B") {
          setSide((s) => (s === 0 ? 1 : 0));
          e.preventDefault();
        }
      }}
    >
      <SyncPanes
        items={[{ asset: cur, label: labels[side] }]}
        onNat={(id, size) => setNats((m) => (m[id] ? m : { ...m, [id]: size }))}
      />
      <div className="flex flex-wrap items-center gap-2">
        {([a, b] as const).map((x, i) => (
          <button
            key={i}
            type="button"
            aria-pressed={side === i}
            onClick={() => setSide(i as 0 | 1)}
            className={`${BTN} ${side === i ? "bg-[#007aff] text-white" : "bg-white/15"}`}
          >
            {labels[i]}
          </button>
        ))}
        <span className="text-[13px] text-white/70">按 B 切换</span>
      </div>
      <SizeLine items={[[labels[0], nats[a.id] ?? null], [labels[1], nats[b.id] ?? null]]} />
    </div>
  );
}

/* =========================================================================
 * 视频 / 音频 · 同步 A/B 切换
 * ========================================================================= */

function MediaSwap({ a, b, labels }: { a: ViewAsset; b: ViewAsset; labels: [string, string] }) {
  const isVideo = a.kind === "video";
  const aRef = useRef<HTMLMediaElement | null>(null);
  const bRef = useRef<HTMLMediaElement | null>(null);
  const [side, setSide] = useState<0 | 1>(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [durs, setDurs] = useState<[number, number]>([a.durationSec ?? 0, b.durationSec ?? 0]);
  const [errs, setErrs] = useState<[boolean, boolean]>([false, false]);
  const [rk, setRk] = useState(0);

  const sideRef = useRef(side);
  const playingRef = useRef(playing);
  useEffect(() => {
    sideRef.current = side;
    playingRef.current = playing;
  });

  const finite = durs.filter((d) => Number.isFinite(d) && d > 0);
  const dur = finite.length ? Math.min(...finite) : 0;
  const durRef = useRef(dur);
  useEffect(() => {
    durRef.current = dur;
  });

  const pair = useCallback(() => [aRef.current, bRef.current] as const, []);

  const pause = useCallback(() => {
    const [x, y] = pair();
    x?.pause();
    y?.pause();
    setPlaying(false);
  }, [pair]);

  const seek = useCallback(
    (t: number) => {
      const [x, y] = pair();
      const tt = clamp(t, 0, durRef.current || t);
      if (x) x.currentTime = tt;
      if (y) y.currentTime = tt;
      setTime(tt);
    },
    [pair],
  );

  const play = useCallback(async () => {
    const [x, y] = pair();
    if (!x || !y) return;
    // 到尾再播＝从头
    if (durRef.current && x.currentTime >= durRef.current - 0.05) {
      x.currentTime = 0;
      y.currentTime = 0;
    } else y.currentTime = x.currentTime;
    try {
      await Promise.all([x.play(), y.play()]);
      setPlaying(true);
    } catch {
      x.pause();
      y.pause();
      setPlaying(false);
    }
  }, [pair]);

  const switchSide = useCallback(
    (next?: 0 | 1) => {
      const target = next ?? (sideRef.current === 0 ? 1 : 0);
      const [x, y] = pair();
      const master = sideRef.current === 0 ? x : y;
      const incoming = target === 0 ? x : y;
      // 无缝：先把将要发声的一路对齐到此刻，再切换静音/可见
      if (master && incoming && Math.abs(incoming.currentTime - master.currentTime) > 0.03) {
        incoming.currentTime = master.currentTime;
      }
      setSide(target);
    },
    [pair],
  );

  // 播放期间：以发声的一路为时钟，驱动进度条并纠偏另一路
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const [x, y] = pair();
      const master = sideRef.current === 0 ? x : y;
      const slave = sideRef.current === 0 ? y : x;
      if (master && slave) {
        const t = master.currentTime;
        setTime((p) => (Math.abs(p - t) > 0.03 ? t : p));
        if (Math.abs(slave.currentTime - t) > 0.12) slave.currentTime = t;
        if (master.ended || (durRef.current && t >= durRef.current - 0.03)) {
          x?.pause();
          y?.pause();
          setPlaying(false);
          setTime(durRef.current || t);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, pair]);

  useEffect(() => {
    const x = aRef.current;
    const y = bRef.current;
    return () => {
      x?.pause();
      y?.pause();
    };
  }, []);

  const onMeta = (i: 0 | 1) => (e: React.SyntheticEvent<HTMLMediaElement>) => {
    const d = e.currentTarget.duration;
    if (Number.isFinite(d) && d > 0) setDurs((p) => (i === 0 ? [d, p[1]] : [p[0], d]));
  };
  const onErr = (i: 0 | 1) => () => {
    pause();
    setErrs((p) => (i === 0 ? [true, p[1]] : [p[0], true]));
  };

  if (errs[0] || errs[1]) {
    return (
      <LoadError
        what={errs[0] && errs[1] ? "两路媒体" : errs[0] ? labels[0] : labels[1]}
        onRetry={() => {
          setErrs([false, false]);
          setPlaying(false);
          setTime(0);
          setRk((k) => k + 1);
        }}
      />
    );
  }

  const common = { preload: "metadata" as const, playsInline: true };
  const aspect = priorSize(a) ?? priorSize(b) ?? { w: 16, h: 9 };

  return (
    <div
      className="flex flex-col gap-3 outline-none"
      tabIndex={0}
      aria-label="A/B 同步对比，空格播放暂停，B 键切换"
      onKeyDown={(e) => {
        if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
        const onControl = e.target instanceof HTMLButtonElement;
        if (e.key === " " && !onControl) {
          if (playingRef.current) pause();
          else void play();
        } else if (e.key === "b" || e.key === "B") switchSide();
        else if (e.key === "ArrowLeft") seek(time - (e.shiftKey ? 15 : 5));
        else if (e.key === "ArrowRight") seek(time + (e.shiftKey ? 15 : 5));
        else return;
        e.preventDefault();
      }}
    >
      {isVideo ? (
        <div
          className="relative w-full max-h-[75dvh] overflow-hidden rounded-ios-md bg-black"
          style={{ aspectRatio: `${aspect.w} / ${aspect.h}` }}
          onClick={() => (playing ? pause() : void play())}
        >
          {([a, b] as const).map((x, i) => (
            <video
              key={`${i}-${rk}`}
              ref={(el) => {
                (i === 0 ? aRef : bRef).current = el;
              }}
              src={x.url}
              poster={x.cover}
              muted={side !== i}
              onLoadedMetadata={onMeta(i as 0 | 1)}
              onError={onErr(i as 0 | 1)}
              {...common}
              className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-100 ${side === i ? "opacity-100" : "pointer-events-none opacity-0"}`}
            />
          ))}
          <span className={`${BADGE} absolute left-2 top-2`}>正在看 {labels[side]}</span>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {([a, b] as const).map((x, i) => (
            <button
              key={i}
              type="button"
              aria-pressed={side === i}
              onClick={() => switchSide(i as 0 | 1)}
              className={`flex min-h-[96px] flex-col items-start justify-center gap-1 rounded-ios-md border-2 p-4 text-left transition-colors ${
                side === i ? "border-[#007aff] bg-[rgba(0,122,255,0.18)] text-white" : "border-white/15 bg-white/5 text-white/80"
              }`}
            >
              <span className="text-[15px] font-semibold">{labels[i]}</span>
              {x.title ? <span className="line-clamp-1 text-[13px] text-white/70">{x.title}</span> : null}
              <span className="text-[13px]">{side === i ? "正在发声" : "点击切换"}</span>
            </button>
          ))}
          {([a, b] as const).map((x, i) => (
            <audio
              key={`${i}-${rk}`}
              ref={(el) => {
                (i === 0 ? aRef : bRef).current = el;
              }}
              src={x.url}
              muted={side !== i}
              onLoadedMetadata={onMeta(i as 0 | 1)}
              onError={onErr(i as 0 | 1)}
              {...common}
              className="hidden"
            />
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 rounded-full bg-white/10 p-1 pr-4">
        <button
          type="button"
          onClick={() => (playing ? pause() : void play())}
          aria-label={playing ? "暂停" : "播放"}
          className={`${BTN} bg-white/20`}
        >
          {playing ? "暂停" : "播放"}
        </button>
        <span className="w-[4.5rem] shrink-0 text-center text-[13px] tabular-nums text-white/85">{mmss(time)}</span>
        <input
          type="range"
          min={0}
          max={dur || 1}
          step={0.01}
          value={Math.min(time, dur || 1)}
          disabled={!dur}
          aria-label="共用进度条"
          onChange={(e) => seek(Number(e.target.value))}
          className="h-11 min-w-0 flex-1 accent-[#007aff]"
        />
        <span className="w-[4.5rem] shrink-0 text-center text-[13px] tabular-nums text-white/60">{dur ? mmss(dur) : "--:--"}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {([0, 1] as const).map((i) => (
          <button
            key={i}
            type="button"
            aria-pressed={side === i}
            onClick={() => switchSide(i)}
            className={`${BTN} ${side === i ? "bg-[#007aff] text-white" : "bg-white/15"}`}
          >
            {labels[i]}
          </button>
        ))}
        <span className="text-[13px] text-white/70">按 B 在两路间无缝切换（同一时间点）</span>
      </div>
    </div>
  );
}

/* =========================================================================
 * 入口
 * ========================================================================= */

export function CompareViewer({ a, b, mode, labels }: CompareViewerProps) {
  const lb: [string, string] = labels ?? ["A", "B"];
  const [picked, setPicked] = useState<CompareMode>("slider");

  let body: React.ReactNode;
  let showModes = false;

  if (!a.url || !b.url) {
    body = <p className="p-4 text-[13px] text-white/80">缺少可对比的资源地址。</p>;
  } else if (a.kind === "image" && b.kind === "image") {
    const m = mode ?? picked;
    showModes = mode === undefined;
    body =
      m === "side" ? (
        <SyncPanes items={[{ asset: a, label: lb[0] }, { asset: b, label: lb[1] }]} />
      ) : m === "blind" ? (
        <BlindCompare a={a} b={b} labels={lb} />
      ) : m === "swap" ? (
        <ImageSwap a={a} b={b} labels={lb} />
      ) : (
        <SliderCompare a={a} b={b} labels={lb} />
      );
  } else if (a.kind === b.kind && (a.kind === "video" || a.kind === "audio")) {
    body = <MediaSwap a={a} b={b} labels={lb} />;
  } else {
    body = <p className="p-4 text-[13px] text-white/80">这两件成品种类不同，无法对比。</p>;
  }

  return (
    <div className="flex w-full flex-col gap-2 rounded-ios-lg bg-[#14161f] p-2 text-white" data-viewer-compare="">
      {showModes ? (
        <div role="group" aria-label="对比方式" className="flex flex-wrap gap-1">
          {(["slider", "side", "blind", "swap"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={picked === m}
              onClick={() => setPicked(m)}
              className={`${BTN} ${picked === m ? "bg-white/25" : ""}`}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      ) : null}
      {body}
    </div>
  );
}
