"use client";

// 赏阅 · 图片适配器。只负责：渲染图 + pan/zoom + 区域标记 + 经 controllerRef 发布 capture/reveal。
// 标签、措辞、存取、全屏、动作按钮全在壳与评审层（docs/architecture/viewer.md）。
//
// 坐标约定：视图 = {s, tx, ty}。s＝每个原图像素占几个 CSS 像素（1＝100%＝真实像素）；
// (tx,ty)＝图片中心相对容器中心的位移（CSS px）。区域标记一律存「原图 0–1 归一化」，与视图无关。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, Locator, ViewerSurfaceProps } from "@/lib/viewer/types";

interface Size {
  w: number;
  h: number;
}
interface View {
  /** true＝跟随「适应」（容器尺寸变化时自动重算）；用户一旦缩放/平移就变 false。 */
  fitted: boolean;
  s: number;
  tx: number;
  ty: number;
}
interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 放大上限：每个原图像素最多占 4 个 CSS 像素（再大只是糊，没有新信息）。 */
const MAX_PX_SCALE = 4;
const MIN_DRAG_REGION = 0.004; // 归一化；小于它的拖拽视为误触
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_DIST = 28;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function fitScale(box: Size, nat: Size): number {
  if (!box.w || !box.h || !nat.w || !nat.h) return 1;
  return Math.min(box.w / nat.w, box.h / nat.h);
}
function minScaleOf(fit: number): number {
  // 小图的「适应」可能 >100%；允许缩回到 100%（更诚实），但不允许缩得比适应还小。
  return Math.min(fit, 1);
}
function maxScaleOf(fit: number): number {
  return Math.max(fit, MAX_PX_SCALE);
}
function clampPan(s: number, tx: number, ty: number, box: Size, nat: Size) {
  const limX = Math.max(0, (nat.w * s - box.w) / 2);
  const limY = Math.max(0, (nat.h * s - box.h) / 2);
  return { tx: clamp(tx, -limX, limX), ty: clamp(ty, -limY, limY) };
}

/**
 * 与 review.composeFeedback 同序编号（位置键 + 时间），这样图上的 ① ② 与「发给助理」那段话里的序号一致。
 * 注意：此排序与 review.ts 内私有的 locatorOrder 重复，契约若导出它应改为直接引用（见回报）。
 */
function orderKey(a: Annotation): number {
  const l = a.locator;
  return l.t === "region" ? (l.frameT ?? l.y * 1000 + l.x) : 0;
}
function numberedRegions(list: readonly Annotation[]): { ann: Annotation; n: number; r: Region }[] {
  const sorted = [...list].sort((a, b) => orderKey(a) - orderKey(b) || a.at - b.at);
  const out: { ann: Annotation; n: number; r: Region }[] = [];
  sorted.forEach((ann, i) => {
    if (ann.locator.t === "region") {
      const { x, y, w, h } = ann.locator;
      out.push({ ann, n: i + 1, r: { x, y, w, h } });
    }
  });
  return out;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

const BTN =
  "inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full px-3 sm:px-4 whitespace-nowrap text-[13px] font-medium text-white/90 " +
  "transition-colors duration-150 hover:bg-white/20 active:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60";

export default function ImageSurface(props: ViewerSurfaceProps) {
  const { asset, density, annotations, controllerRef, onRequestMark, active } = props;
  const full = density === "full";

  const [retryKey, setRetryKey] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [nat, setNat] = useState<Size | null>(null);
  const [box, setBox] = useState<Size>({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ fitted: true, s: 1, tx: 0, ty: 0 });
  const [markMode, setMarkMode] = useState(false);
  const [sel, setSel] = useState<Region | null>(null);
  const [flash, setFlash] = useState<Region | null>(null);

  // asset 切换：整体重置（渲染期调整 state，避免 effect 里 setState 闪一帧旧图）。
  const [seenUrl, setSeenUrl] = useState(asset.url);
  if (seenUrl !== asset.url) {
    setSeenUrl(asset.url);
    setStatus("loading");
    setNat(null);
    setView({ fitted: true, s: 1, tx: 0, ty: 0 });
    setSel(null);
    setFlash(null);
    setMarkMode(false);
  }

  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // 手势/控制柄读最新值走 ref（事件处理器不随渲染重建）。
  const viewRef = useRef(view);
  const boxRef = useRef(box);
  const natRef = useRef(nat);
  const selRef = useRef(sel);
  const markModeRef = useRef(markMode);
  useEffect(() => {
    viewRef.current = view;
    boxRef.current = box;
    natRef.current = nat;
    selRef.current = sel;
    markModeRef.current = markMode;
  });

  const animRef = useRef<number | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopAnim = useCallback(() => {
    if (animRef.current != null) cancelAnimationFrame(animRef.current);
    animRef.current = null;
  }, []);

  /** 当前有效视图（fitted 时按容器尺寸实时算）。 */
  const effective = useCallback((): { s: number; tx: number; ty: number } => {
    const v = viewRef.current;
    const n = natRef.current;
    if (v.fitted && n) return { s: fitScale(boxRef.current, n), tx: 0, ty: 0 };
    return { s: v.s, tx: v.tx, ty: v.ty };
  }, []);

  const commit = useCallback((s: number, tx: number, ty: number) => {
    const n = natRef.current;
    const b = boxRef.current;
    if (!n) return;
    const fit = fitScale(b, n);
    const ss = clamp(s, minScaleOf(fit), maxScaleOf(fit));
    const p = clampPan(ss, tx, ty, b, n);
    const next: View = { fitted: false, s: ss, tx: p.tx, ty: p.ty };
    viewRef.current = next;
    setView(next);
  }, []);

  const commitFit = useCallback(() => {
    const next: View = { fitted: true, s: 1, tx: 0, ty: 0 };
    viewRef.current = next;
    setView(next);
  }, []);

  /** 带缓动的程序化视图切换（按钮/键盘/双击/reveal）。手势会 stopAnim 打断。 */
  const animateTo = useCallback(
    (target: { s: number; tx: number; ty: number } | "fit") => {
      const n = natRef.current;
      if (!n) return;
      stopAnim();
      const from = effective();
      const fit = fitScale(boxRef.current, n);
      const to = target === "fit" ? { s: fit, tx: 0, ty: 0 } : target;
      const t0 = performance.now();
      const dur = 200;
      const step = (now: number) => {
        const k = clamp((now - t0) / dur, 0, 1);
        const e = 1 - Math.pow(1 - k, 3);
        if (k >= 1) {
          animRef.current = null;
          if (target === "fit") commitFit();
          else commit(to.s, to.tx, to.ty);
          return;
        }
        // s 用对数插值，缩放观感匀速
        const s = Math.exp(Math.log(from.s) + (Math.log(to.s) - Math.log(from.s)) * e);
        commit(s, from.tx + (to.tx - from.tx) * e, from.ty + (to.ty - from.ty) * e);
        animRef.current = requestAnimationFrame(step);
      };
      animRef.current = requestAnimationFrame(step);
    },
    [commit, commitFit, effective, stopAnim],
  );

  /** 以容器内某点（相对容器中心）为锚缩放到 s2。 */
  const zoomAt = useCallback(
    (s2: number, px: number, py: number, smooth: boolean) => {
      const n = natRef.current;
      if (!n) return;
      const cur = effective();
      const fit = fitScale(boxRef.current, n);
      const ss = clamp(s2, minScaleOf(fit), maxScaleOf(fit));
      const r = ss / cur.s;
      const tx = px - (px - cur.tx) * r;
      const ty = py - (py - cur.ty) * r;
      if (smooth) {
        const p = clampPan(ss, tx, ty, boxRef.current, n);
        animateTo({ s: ss, tx: p.tx, ty: p.ty });
      } else commit(ss, tx, ty);
    },
    [animateTo, commit, effective],
  );

  const toggleFit100 = useCallback(
    (px: number, py: number) => {
      const n = natRef.current;
      if (!n) return;
      const cur = effective();
      const fit = fitScale(boxRef.current, n);
      const atFit = viewRef.current.fitted || Math.abs(cur.s - fit) < 1e-3;
      if (!atFit) return animateTo("fit");
      // 适应 → 100%；若适应本身就≈100%，改去 200%，否则按钮看起来没反应
      const target = Math.abs(fit - 1) < 0.02 ? 2 : 1;
      zoomAt(target, px, py, true);
    },
    [animateTo, effective, zoomAt],
  );

  const goFit = useCallback(() => animateTo("fit"), [animateTo]);
  const go100 = useCallback(() => zoomAt(1, 0, 0, true), [zoomAt]);
  const stepZoom = useCallback(
    (factor: number) => zoomAt(effective().s * factor, 0, 0, true),
    [effective, zoomAt],
  );

  /* ---------- 容器尺寸 ---------- */
  useEffect(() => {
    if (!full) return;
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox((prev) => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [full]);

  // 容器变化后，非 fitted 视图要重新夹紧（否则旋转屏幕/调整窗口后图会飘出）。
  useEffect(() => {
    const v = viewRef.current;
    if (v.fitted || !natRef.current) return;
    commit(v.s, v.tx, v.ty);
  }, [box, commit]);

  /* ---------- 图片加载 ---------- */
  const readNatural = useCallback((img: HTMLImageElement) => {
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setNat({ w: img.naturalWidth, h: img.naturalHeight });
      setStatus("ready");
    }
  }, []);
  useEffect(() => {
    // 缓存命中时 onLoad 可能在挂载前已触发
    const img = imgRef.current;
    if (img && img.complete) readNatural(img);
  }, [retryKey, asset.url, readNatural]);

  /* ---------- 坐标换算 ---------- */
  const localPoint = useCallback((clientX: number, clientY: number) => {
    const r = containerRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
  }, []);
  /** 容器内点（相对中心）→ 原图归一化 0–1（夹到图内）。 */
  const toNorm = useCallback(
    (px: number, py: number) => {
      const n = natRef.current;
      if (!n) return { x: 0, y: 0 };
      const v = effective();
      return {
        x: clamp((px - v.tx) / v.s / n.w + 0.5, 0, 1),
        y: clamp((py - v.ty) / v.s / n.h + 0.5, 0, 1),
      };
    },
    [effective],
  );

  /* ---------- 手势：拖拽平移 / 捏合 / 框选 / 双击 ---------- */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { kind: "none" }
    | { kind: "pan"; x0: number; y0: number; tx0: number; ty0: number; moved: boolean }
    | { kind: "pinch"; d0: number; s0: number; q: { x: number; y: number } }
    | { kind: "mark"; a: { x: number; y: number }; moved: boolean }
  >({ kind: "none" });
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  const startPinchOrPan = useCallback(() => {
    const pts = [...pointers.current.values()];
    const v = effective();
    if (pts.length >= 2) {
      const [p1, p2] = pts;
      const mid = localPoint((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
      gesture.current = {
        kind: "pinch",
        d0: Math.max(1, Math.hypot(p1.x - p2.x, p1.y - p2.y)),
        s0: v.s,
        // 起手时中点下面的那个「图上点」（相对图中心，图像素级），之后始终让它跟着中点走
        q: { x: (mid.x - v.tx) / v.s, y: (mid.y - v.ty) / v.s },
      };
    } else if (pts.length === 1) {
      gesture.current = { kind: "pan", x0: pts[0].x, y0: pts[0].y, tx0: v.tx, ty0: v.ty, moved: false };
    } else gesture.current = { kind: "none" };
  }, [effective, localPoint]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!full || !natRef.current || status !== "ready") return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    stopAnim();
    containerRef.current?.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size >= 2) {
      startPinchOrPan();
      return;
    }
    if (e.shiftKey || markModeRef.current) {
      const p = localPoint(e.clientX, e.clientY);
      const a = toNorm(p.x, p.y);
      gesture.current = { kind: "mark", a, moved: false };
      setSel({ x: a.x, y: a.y, w: 0, h: 0 });
    } else startPinchOrPan();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const n = natRef.current;
    if (!n) return;
    if (g.kind === "pinch" && pointers.current.size >= 2) {
      const [p1, p2] = [...pointers.current.values()];
      const mid = localPoint((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const fit = fitScale(boxRef.current, n);
      const s = clamp(g.s0 * (d / g.d0), minScaleOf(fit), maxScaleOf(fit));
      commit(s, mid.x - g.q.x * s, mid.y - g.q.y * s);
    } else if (g.kind === "pan") {
      const dx = e.clientX - g.x0;
      const dy = e.clientY - g.y0;
      if (!g.moved && Math.hypot(dx, dy) > 4) g.moved = true;
      if (g.moved) {
        const v = effective();
        commit(v.s, g.tx0 + dx, g.ty0 + dy);
      }
    } else if (g.kind === "mark") {
      const p = localPoint(e.clientX, e.clientY);
      const b = toNorm(p.x, p.y);
      g.moved = true;
      setSel({
        x: Math.min(g.a.x, b.x),
        y: Math.min(g.a.y, b.y),
        w: Math.abs(b.x - g.a.x),
        h: Math.abs(b.y - g.a.y),
      });
    }
  };

  const endPointer = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g.kind === "mark") {
      gesture.current = { kind: "none" };
      const s = selRef.current;
      if (!cancelled && s && s.w >= MIN_DRAG_REGION && s.h >= MIN_DRAG_REGION) {
        setMarkMode(false);
        onRequestMark();
      } else setSel(null);
      return;
    }
    if (g.kind === "pan" && !g.moved && !cancelled && pointers.current.size === 0) {
      // 一次点按：清选区；两次点按＝双击
      const now = performance.now();
      const lt = lastTap.current;
      const p = localPoint(e.clientX, e.clientY);
      if (lt && now - lt.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < DOUBLE_TAP_DIST) {
        lastTap.current = null;
        toggleFit100(p.x, p.y);
      } else {
        lastTap.current = { t: now, x: e.clientX, y: e.clientY };
        setSel(null);
      }
    }
    startPinchOrPan(); // 剩一指继续平移；全抬起则归 none
  };

  /* ---------- 滚轮（必须非 passive 才能 preventDefault） ---------- */
  useEffect(() => {
    if (!full) return;
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!natRef.current) return;
      e.preventDefault();
      stopAnim();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dy = e.deltaY * unit;
      const k = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016));
      const p = localPoint(e.clientX, e.clientY);
      zoomAt(effective().s * k, p.x, p.y, false);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [full, effective, localPoint, stopAnim, zoomAt]);

  /* ---------- 键盘：+ − 0 1（Esc/←/→ 留给壳） ---------- */
  useEffect(() => {
    if (!full || !active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      switch (e.key) {
        case "+":
        case "=":
          stepZoom(1.25);
          break;
        case "-":
        case "_":
          stepZoom(0.8);
          break;
        case "0":
          goFit();
          break;
        case "1":
          go100();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [full, active, stepZoom, goFit, go100]);

  /* ---------- 控制柄 ---------- */
  const flashRegion = useCallback((r: Region) => {
    setFlash(r);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 1800);
  }, []);

  useEffect(() => {
    controllerRef.current = {
      capture() {
        const s = selRef.current;
        if (s && s.w >= MIN_DRAG_REGION && s.h >= MIN_DRAG_REGION) {
          const r = (v: number) => Math.round(v * 10000) / 10000;
          return { locator: { t: "region", x: r(s.x), y: r(s.y), w: r(s.w), h: r(s.h) } };
        }
        return { locator: { t: "whole" } };
      },
      reveal(locator: Locator) {
        const n = natRef.current;
        const b = boxRef.current;
        if (!n || locator.t !== "region") {
          if (locator.t === "whole") animateTo("fit");
          return;
        }
        const { x, y, w, h } = locator;
        flashRegion({ x, y, w, h });
        if (!b.w || !b.h) return;
        const fit = fitScale(b, n);
        const want = Math.min((b.w * 0.8) / Math.max(1, w * n.w), (b.h * 0.8) / Math.max(1, h * n.h));
        const s = clamp(want, minScaleOf(fit), maxScaleOf(fit));
        const tx = -((x + w / 2 - 0.5) * n.w) * s;
        const ty = -((y + h / 2 - 0.5) * n.h) * s;
        const p = clampPan(s, tx, ty, b, n);
        animateTo({ s, tx: p.tx, ty: p.ty });
      },
    };
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef, animateTo, flashRegion]);

  // 新标记落库（数量变化）后清掉临时选区：它已变成一个带编号的框。
  const annCount = annotations.length;
  const prevCount = useRef(annCount);
  useEffect(() => {
    if (annCount !== prevCount.current) setSel(null);
    prevCount.current = annCount;
  }, [annCount]);

  useEffect(
    () => () => {
      stopAnim();
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [stopAnim],
  );

  const regions = useMemo(() => numberedRegions(annotations), [annotations]);

  const retry = () => {
    setStatus("loading");
    setRetryKey((k) => k + 1);
  };

  if (!asset.url || status === "error") {
    return (
      <div
        role="alert"
        className={`flex flex-col items-center justify-center gap-3 rounded-ios-md bg-black/40 p-6 text-center text-[13px] text-white/85 ${
          full ? "h-full w-full" : "min-h-[160px] w-full"
        }`}
      >
        <span>{asset.url ? "图片加载失败" : "这件成品没有图片地址"}</span>
        {asset.url ? (
          <button type="button" onClick={retry} className={`${BTN} bg-white/15`}>
            重试
          </button>
        ) : null}
      </div>
    );
  }

  /* ---------- inline：自适应容器，无工具条，点击不做事 ---------- */
  if (!full) {
    return (
      <div className="relative flex w-full justify-center">
        <div className="relative inline-block max-w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={retryKey}
            ref={imgRef}
            src={asset.url}
            alt={asset.title ?? "成品图片"}
            draggable={false}
            onLoad={(e) => readNatural(e.currentTarget)}
            onError={() => setStatus("error")}
            className="block h-auto max-h-[70dvh] max-w-full rounded-ios-md"
          />
          {status === "ready"
            ? regions.map(({ ann, n, r }) => (
                <span
                  key={ann.id}
                  aria-hidden
                  className="pointer-events-none absolute border-2 border-[#ff9f0a]"
                  style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
                >
                  <span className="absolute -left-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center bg-[#ff9f0a] px-1 text-[11px] font-semibold leading-none text-black">
                    {n}
                  </span>
                </span>
              ))
            : null}
        </div>
      </div>
    );
  }

  /* ---------- full ---------- */
  const v = nat ? (view.fitted ? { s: fitScale(box, nat), tx: 0, ty: 0 } : view) : { s: 1, tx: 0, ty: 0 };
  const fit = nat ? fitScale(box, nat) : 1;
  const atFit = !nat || view.fitted || Math.abs(v.s - fit) < 1e-3;
  const at100 = !!nat && Math.abs(v.s - 1) < 1e-3;
  const toScreen = (r: Region) => {
    if (!nat) return { left: 0, top: 0, width: 0, height: 0 };
    return {
      left: box.w / 2 + v.tx + (r.x - 0.5) * nat.w * v.s,
      top: box.h / 2 + v.ty + (r.y - 0.5) * nat.h * v.s,
      width: r.w * nat.w * v.s,
      height: r.h * nat.h * v.s,
    };
  };
  const stop = (e: React.PointerEvent) => e.stopPropagation();

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      aria-label={`${asset.title ?? "成品图片"}，可缩放平移`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endPointer(e, false)}
      onPointerCancel={(e) => endPointer(e, true)}
      className={`relative h-full min-h-[240px] w-full select-none overflow-hidden outline-none ${
        markMode ? "cursor-crosshair" : !atFit ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"
      }`}
      style={{ touchAction: "none" }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={retryKey}
        ref={imgRef}
        src={asset.url}
        alt={asset.title ?? "成品图片"}
        draggable={false}
        onLoad={(e) => readNatural(e.currentTarget)}
        onError={() => setStatus("error")}
        className="pointer-events-none absolute left-1/2 top-1/2 max-w-none select-none"
        style={
          nat
            ? {
                width: nat.w,
                height: nat.h,
                marginLeft: -nat.w / 2,
                marginTop: -nat.h / 2,
                transform: `translate(${v.tx}px, ${v.ty}px) scale(${v.s})`,
                transformOrigin: "center center",
                // 放大到 >200% 时让像素边界清晰可辨，而不是被平滑糊掉（诚实：看得出分辨率）
                imageRendering: v.s >= 2 ? "pixelated" : "auto",
                willChange: "transform",
              }
            : { opacity: 0 }
        }
      />

      {status === "loading" ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-white/70">
          加载中…
        </div>
      ) : null}

      {/* 叠层：标记框 / 当前选区 / reveal 高亮（屏幕坐标，边框不随缩放变粗） */}
      {nat && status === "ready" ? (
        <>
          {regions.map(({ ann, n, r }) => {
            const p = toScreen(r);
            return (
              <div key={ann.id} className="pointer-events-none absolute border-2 border-[#ff9f0a]" style={p}>
                <button
                  type="button"
                  aria-label={`定位到第 ${n} 处标记`}
                  onPointerDown={stop}
                  onClick={() => controllerRef.current?.reveal(ann.locator)}
                  className="pointer-events-auto absolute -left-0.5 -top-0.5 flex h-[26px] min-w-[26px] items-center justify-center bg-[#ff9f0a] px-1 text-[13px] font-semibold leading-none text-black before:absolute before:-inset-2.5 before:content-['']"
                >
                  {n}
                </button>
              </div>
            );
          })}
          {flash ? (
            <div
              className="pointer-events-none absolute animate-pulse border-[3px] border-white shadow-[0_0_0_2px_rgba(255,159,10,0.9),0_0_24px_rgba(255,159,10,0.6)]"
              style={toScreen(flash)}
            />
          ) : null}
          {sel ? (
            <div
              className="pointer-events-none absolute border-2 border-dashed border-white bg-[rgba(0,122,255,0.18)] shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
              style={toScreen(sel)}
            />
          ) : null}
        </>
      ) : null}

      {/* 真实像素徽章：诚实面 */}
      {nat ? (
        <div
          className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/55 px-3 py-1.5 text-[13px] text-white/90 backdrop-blur-xl"
          title="图片真实像素尺寸"
        >
          {nat.w} × {nat.h} px · {Math.round(v.s * 100)}%
        </div>
      ) : null}

      {/* 工具条 */}
      {nat ? (
        <div
          onPointerDown={stop}
          onPointerUp={stop}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-white/15 p-1 backdrop-blur-xl"
          role="toolbar"
          aria-label="图片查看工具"
        >
          <button
            type="button"
            onClick={goFit}
            aria-pressed={atFit}
            className={`${BTN} ${atFit ? "bg-white/25" : ""}`}
            title="适应窗口（0）"
          >
            适应
          </button>
          <button
            type="button"
            onClick={go100}
            aria-pressed={at100}
            className={`${BTN} ${at100 ? "bg-white/25" : ""}`}
            title="真实像素 100%（1）"
          >
            100%
          </button>
          <button
            type="button"
            onClick={() => setMarkMode((m) => !m)}
            aria-pressed={markMode}
            className={`${BTN} ${markMode ? "bg-[#007aff] text-white hover:bg-[#0a84ff]" : ""}`}
            title="框选一块区域并标记（也可按住 Shift 拖拽）"
          >
            {markMode ? "框选中…" : "框选"}
          </button>
          {sel && !markMode ? (
            <button type="button" onClick={() => setSel(null)} className={BTN} title="清除当前选区">
              清除选区
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
