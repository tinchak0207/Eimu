"use client";

// InfiniteCanvas —— 画布表面手势层（行动端轨）。
//
// 行动端（375–430px、触控、虚拟键盘、notch/home indicator）：
//   - touch-action:none + Pointer Events 接管单指平移 / 双指缩放：浏览器滚动、
//     双击页面缩放、pull-to-refresh 全部让位给画布（overscroll-behavior 兜底）。
//   - 双指以两指中点为锚缩放（同时支援双指平移）；双击以点为锚放大两倍。
//   - 松手后惯性滑行（prefers-reduced-motion 时直接停住，不滑）。
//   - 视口 clamp：有内容时，节点永远不会被推出可触及范围；缩放沿用全域上下限。
//   - visualViewport resize/scroll（虚拟键盘弹出收回、方向转换）后重测容器，
//     尺寸变化时把视口拉回 clamp 范围。
//   - translate3d + will-change 让合成器以装置像素运算，Retina 下不糊。
//
// 桌面补充（Phase 3 交互引擎）：
//   - Shift/Ctrl/⌘ + 空白处拖动 = 框选（触控不启用：行动端没有修饰键语境，
//     维持平移）；位移不足视为点击，命中判定交给 lib/canvas/interaction 纯函式。
//   - 右键一律挡掉浏览器选单；空白处右键换算世界座标上报，让上层开自订选单。
//
// 边界：data-canvas-node / data-canvas-interactive（节点表单、缩放手柄）由
// CanvasNodeView（另一轨）负责。这里只在空白表面接收手势，互动元素一律放行。

import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasViewport } from "@/lib/canvas/types";
import { screenRectToWorld, type WorldRect } from "@/lib/canvas/interaction";
import { clampScale, gridBackground, zoomAtPoint } from "@/lib/canvas/layout";
import { quantizeScale } from "@/lib/canvas/lod";
import { cn } from "@/lib/utils";

export interface InfiniteCanvasProps {
  viewport: CanvasViewport;
  onViewportChange: (next: CanvasViewport | ((prev: CanvasViewport) => CanvasViewport)) => void;
  backgroundMode: "dots" | "lines" | "blank";
  /** 空白处按下时调用（用来清空选取） */
  onBackgroundPointerDown?: () => void;
  /** 视口尺寸变化时回报，供 fitView / minimap 用 */
  onSizeChange?: (size: { width: number; height: number }) => void;
  /** 框选完成（世界座标矩形，additive = 按住 Shift 追加选取）。提供此 prop 才启用框选。 */
  onMarqueeSelect?: (rect: WorldRect, additive: boolean) => void;
  /** 空白处右键（萤幕座标 = 相对容器左上，世界座标已换算）。 */
  onCanvasContextMenu?: (screen: { x: number; y: number }, world: { x: number; y: number }) => void;
  /** 桌面双击空白：就地建节点（提供此 prop 后桌面双击不再放大；触控不受影响）。 */
  onCanvasDoubleClick?: (screen: { x: number; y: number }, world: { x: number; y: number }) => void;
  className?: string;
  /**
   * 内容层（世界座标、随 viewport 变换的那层）的附加样式／data 属性。
   * 语义缩放用它每帧下发 CSS 变数（--lod-g / --lod-xray…）与状态属性，节点靠 CSS 反应、不多 render。
   */
  contentStyle?: React.CSSProperties;
  contentData?: Record<`data-${string}`, string | undefined>;
  children: React.ReactNode;
}

// ── 手势参数 ──
const PAN_THRESHOLD = 3; // 移动超过此距离才算平移（px）
const MARQUEE_THRESHOLD = 4; // 框选位移低于此视为点击（px），不触发 onMarqueeSelect
const DOUBLE_TAP_MS = 300; // 双击时间窗（ms）
const DOUBLE_TAP_SLOP = 44; // 两次点击的位置容差（px）
const DOUBLE_TAP_ZOOM = 2; // 双击放大倍率
const CLAMP_MARGIN = 64; // 内容可被推出视口的最大距离（px）；160 太大，节点被切一半观感极差
const EMPTY_WORLD_HALF = 600; // 空画布的原点可触及半径（世界座标）
const FLING_MIN_VELOCITY = 0.12; // px/ms，低于此不启动惯性
const FLING_STOP_VELOCITY = 0.02; // px/ms，低于此停止惯性
const FLING_FRICTION = 0.92; // 每 16.7ms 的衰减系数

interface ContentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface BoundsResult {
  /** 画布上是否有节点（有内容才做平移 clamp，空画布维持无限平移 = 桌面现状）。 */
  hasContent: boolean;
  b: ContentBounds;
}

const EMPTY_BOUNDS: ContentBounds = {
  minX: -EMPTY_WORLD_HALF,
  minY: -EMPTY_WORLD_HALF,
  maxX: EMPTY_WORLD_HALF,
  maxY: EMPTY_WORLD_HALF,
};

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** 平移 clamp：内容永远保持可触及；zoom 沿用全域上下限（clampScale）。 */
function clampViewport(vp: CanvasViewport, size: { width: number; height: number }, r: BoundsResult): CanvasViewport {
  const k = clampScale(vp.k);
  if (!r.hasContent || size.width <= 0 || size.height <= 0) return { ...vp, k };
  const b = r.b;
  // 内容的右缘最多被推到视口左缘外 CLAMP_MARGIN，左缘同理 → 永远摸得到。
  const loX = -CLAMP_MARGIN - b.maxX * k;
  const hiX = size.width + CLAMP_MARGIN - b.minX * k;
  const loY = -CLAMP_MARGIN - b.maxY * k;
  const hiY = size.height + CLAMP_MARGIN - b.minY * k;
  return {
    x: loX <= hiX ? clampNum(vp.x, loX, hiX) : vp.x,
    y: loY <= hiY ? clampNum(vp.y, loY, hiY) : vp.y,
    k,
  };
}

/** 以某萤幕点为锚缩放（与 zoomAtPoint 同一套锚点数学，直接吃倍率）。 */
function zoomByFactor(vp: CanvasViewport, factor: number, px: number, py: number): CanvasViewport {
  const k = clampScale(vp.k * factor);
  if (k === vp.k) return vp;
  const wx = (px - vp.x) / vp.k;
  const wy = (py - vp.y) / vp.k;
  return { x: px - wx * k, y: py - wy * k, k };
}

function InfiniteCanvas({
  viewport,
  onViewportChange,
  backgroundMode,
  onBackgroundPointerDown,
  onSizeChange,
  onMarqueeSelect,
  onCanvasContextMenu,
  onCanvasDoubleClick,
  className,
  contentStyle: extraContentStyle,
  contentData,
  children,
}: InfiniteCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  // 框选矩形（萤幕座标、相对容器左上）；null = 未在框选。超过门槛才开始渲染。
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  // 最新的 viewport / 回呼存在 ref：原生 listener 只注册一次，
  // 不因每次 render 重新注册，也不吃闭包里的旧值。
  const viewportRef = useRef(viewport);
  const onViewportChangeRef = useRef(onViewportChange);
  const onSizeChangeRef = useRef(onSizeChange);
  const onCanvasDoubleClickRef = useRef(onCanvasDoubleClick);

  // 尺寸存 ref + state（ref 给 ResizeObserver / 手势用，state 留给需要重渲染的场景）。
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const sizeRef = useRef(size);

  // ── 手势状态（全部放 ref，不进 render 路径）
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef({
    mode: "idle" as "idle" | "pan" | "pinch" | "marquee",
    panActive: false,
    marqueeActive: false,
    marqueeStartX: 0,
    marqueeStartY: 0,
    panStartX: 0,
    panStartY: 0,
    panLastX: 0,
    panLastY: 0,
    panLastT: 0,
    velX: 0,
    velY: 0,
    pinchStartDist: 1,
    pinchStartMidX: 0,
    pinchStartMidY: 0,
    pinchStartViewport: { x: 0, y: 0, k: 1 } as CanvasViewport,
  });
  const momentumRef = useRef<number | null>(null);
  const lastTapRef = useRef<{ px: number; py: number; time: number } | null>(null);
  const reduceMotionRef = useRef(false);

  // 内容范围快取：读节点 inline style（世界座标），不触发 layout。
  const boundsCacheRef = useRef<BoundsResult | null>(null);
  const boundsDirtyRef = useRef(true);

  useEffect(() => {
    viewportRef.current = viewport;
  });
  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  });
  useEffect(() => {
    onSizeChangeRef.current = onSizeChange;
  });
  useEffect(() => {
    onCanvasDoubleClickRef.current = onCanvasDoubleClick;
  });

  // 尊重 prefers-reduced-motion：惯性滑行直接停住。
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduceMotionRef.current = mq.matches;
    const onChange = (e: MediaQueryListEvent) => {
      reduceMotionRef.current = e.matches;
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  /** 世界范围：data-canvas-node 的 left/top/width/height 就是世界座标，直接读 inline style。 */
  const getBounds = useCallback((): BoundsResult => {
    if (!boundsDirtyRef.current && boundsCacheRef.current) return boundsCacheRef.current;
    const el = containerRef.current;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    if (el) {
      const nodes = el.querySelectorAll<HTMLElement>("[data-canvas-node]");
      for (const n of nodes) {
        const s = n.style;
        const x = parseFloat(s.left);
        const y = parseFloat(s.top);
        const w = parseFloat(s.width);
        const h = parseFloat(s.height);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x + w > maxX) maxX = x + w;
        if (y + h > maxY) maxY = y + h;
      }
    }
    const hasContent = Number.isFinite(minX);
    const r: BoundsResult = { hasContent, b: hasContent ? { minX, minY, maxX, maxY } : EMPTY_BOUNDS };
    boundsCacheRef.current = r;
    boundsDirtyRef.current = false;
    return r;
  }, []);

  // 节点增删／移动（inline style 变更）→ 内容范围标脏，下次手势才重算。
  // 内容层自己的 transform 每帧都在变，callback 里过滤掉（它不带 data-canvas-node）。
  useEffect(() => {
    const layer = contentRef.current;
    if (!layer) return;
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "childList") {
          for (const n of r.addedNodes) {
            if (n instanceof Element && (n.matches("[data-canvas-node]") || n.querySelector("[data-canvas-node]"))) {
              boundsDirtyRef.current = true;
              return;
            }
          }
          for (const n of r.removedNodes) {
            if (n instanceof Element && (n.matches("[data-canvas-node]") || n.querySelector("[data-canvas-node]"))) {
              boundsDirtyRef.current = true;
              return;
            }
          }
        } else {
          const t = r.target as HTMLElement;
          if (typeof t.closest === "function" && t.closest("[data-canvas-node]")) {
            boundsDirtyRef.current = true;
            return;
          }
        }
      }
    });
    mo.observe(layer, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    return () => mo.disconnect();
  }, []);

  const stopMomentum = useCallback(() => {
    if (momentumRef.current !== null) {
      cancelAnimationFrame(momentumRef.current);
      momentumRef.current = null;
    }
  }, []);

  /** 惯性滑行：指数衰减，每帧 clamp，速度低于门槛即停。 */
  const startMomentum = useCallback(() => {
    if (reduceMotionRef.current) return;
    const g = gestureRef.current;
    const speed = Math.hypot(g.velX, g.velY);
    if (speed < FLING_MIN_VELOCITY) return;
    let vx = g.velX;
    let vy = g.velY;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(now - last, 40);
      last = now;
      const f = Math.pow(FLING_FRICTION, dt / 16.667);
      vx *= f;
      vy *= f;
      const el = containerRef.current;
      if (!el) {
        momentumRef.current = null;
        return;
      }
      onViewportChangeRef.current((prev) =>
        clampViewport({ ...prev, x: prev.x + vx * dt, y: prev.y + vy * dt }, sizeRef.current, getBounds()),
      );
      if (Math.hypot(vx, vy) < FLING_STOP_VELOCITY) {
        momentumRef.current = null;
        return;
      }
      momentumRef.current = requestAnimationFrame(step);
    };
    stopMomentum();
    momentumRef.current = requestAnimationFrame(step);
  }, [getBounds, stopMomentum]);

  /** 点击：第一次触发清空选取，300ms 内同一点再点 = 双击。
   *  桌面（mouse/pen）有 onCanvasDoubleClick 时双击 = 就地建节点；
   *  触控（或未提供回呼）维持双击放大——行动端没有滚轮，放大手势不能没收。 */
  const handleTap = useCallback(
    (clientX: number, clientY: number, pointerType?: string) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const now = performance.now();
      const last = lastTapRef.current;
      if (last && now - last.time <= DOUBLE_TAP_MS && Math.hypot(px - last.px, py - last.py) <= DOUBLE_TAP_SLOP) {
        lastTapRef.current = null;
        const dblCreate = onCanvasDoubleClickRef.current;
        if (dblCreate && pointerType !== "touch") {
          const vp = viewportRef.current;
          dblCreate({ x: px, y: py }, { x: (px - vp.x) / vp.k, y: (py - vp.y) / vp.k });
          return;
        }
        onViewportChangeRef.current((prev) =>
          clampViewport(zoomByFactor(prev, DOUBLE_TAP_ZOOM, px, py), sizeRef.current, getBounds()),
        );
        return;
      }
      lastTapRef.current = { px, py, time: now };
      onBackgroundPointerDown?.();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 缺 onBackgroundPointerDown（父层 CanvasEmbed 以 inline arrow 传入、每次 render 新身分）；硬加会让 handleTap 每次 render 重建，进而重挂 canvas 手势监听。
    [getBounds],
  );

  // ── 平移 / 缩放手势（Pointer Events + touch-action:none）──
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // 节点本体、节点内的表单/按钮/缩放手柄：放行给 CanvasNodeView 处理。
    if (target.closest("[data-canvas-node], [data-canvas-interactive]")) return;
    // 框选进行中：忽略后续指针（不切 pinch，框选以第一根指针为准）。
    if (gestureRef.current.mode === "marquee") return;
    stopMomentum();
    const now = performance.now();
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer 已结束时 capture 会抛错，忽略 */
    }
    const g = gestureRef.current;
    if (pointersRef.current.size === 1) {
      // 修饰键 + 非触控 + 有回呼 → 框选；触控维持平移（中键/右键已被 button 检查挡掉）。
      if (onMarqueeSelect && e.pointerType !== "touch" && (e.shiftKey || e.ctrlKey || e.metaKey)) {
        const rect = e.currentTarget.getBoundingClientRect();
        g.mode = "marquee";
        g.marqueeActive = false;
        g.marqueeStartX = e.clientX - rect.left;
        g.marqueeStartY = e.clientY - rect.top;
        return;
      }
      g.mode = "pan";
      g.panActive = false;
      g.panStartX = g.panLastX = e.clientX;
      g.panStartY = g.panLastY = e.clientY;
      g.panLastT = now;
      g.velX = 0;
      g.velY = 0;
    } else if (pointersRef.current.size === 2) {
      g.mode = "pinch";
      g.panActive = false;
      setIsPanning(true);
      const pts = [...pointersRef.current.values()];
      const [pa, pb] = pts;
      g.pinchStartDist = Math.max(1, Math.hypot(pb.x - pa.x, pb.y - pa.y));
      g.pinchStartMidX = (pa.x + pb.x) / 2;
      g.pinchStartMidY = (pa.y + pb.y) / 2;
      g.pinchStartViewport = viewportRef.current;
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    const p = pointersRef.current.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;

    // 框选：更新萤幕座标矩形；超过门槛才开始渲染（Shift+点击不闪出 1px 矩形）。
    if (g.mode === "marquee") {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      if (!g.marqueeActive) {
        if (Math.hypot(px - g.marqueeStartX, py - g.marqueeStartY) < MARQUEE_THRESHOLD) return;
        g.marqueeActive = true;
      }
      setMarqueeRect({
        x: Math.min(g.marqueeStartX, px),
        y: Math.min(g.marqueeStartY, py),
        width: Math.abs(px - g.marqueeStartX),
        height: Math.abs(py - g.marqueeStartY),
      });
      return;
    }

    // 双指：以中点为锚缩放，中点位移 = 双指平移。
    if (g.mode === "pinch" && pointersRef.current.size >= 2) {
      const pts = [...pointersRef.current.values()];
      const [pa, pb] = pts;
      const dist = Math.max(1, Math.hypot(pb.x - pa.x, pb.y - pa.y));
      const midX = (pa.x + pb.x) / 2;
      const midY = (pa.y + pb.y) / 2;
      const start = g.pinchStartViewport;
      const k = clampScale(start.k * (dist / g.pinchStartDist));
      const el = containerRef.current;
      const rect = el ? el.getBoundingClientRect() : { left: 0, top: 0 };
      const wx = (g.pinchStartMidX - start.x) / start.k;
      const wy = (g.pinchStartMidY - start.y) / start.k;
      onViewportChangeRef.current(
        clampViewport({ x: midX - rect.left - wx * k, y: midY - rect.top - wy * k, k }, sizeRef.current, getBounds()),
      );
      return;
    }

    // 单指平移：未超过门槛当作点击候选；顺便记录速度供惯性使用。
    if (g.mode === "pan" && pointersRef.current.size === 1) {
      if (!g.panActive) {
        if (Math.hypot(e.clientX - g.panStartX, e.clientY - g.panStartY) <= PAN_THRESHOLD) return;
        g.panActive = true;
        setIsPanning(true);
      }
      const now = performance.now();
      const dt = Math.max(1, now - g.panLastT);
      const dx = e.clientX - g.panLastX;
      const dy = e.clientY - g.panLastY;
      const instVx = dx / dt;
      const instVy = dy / dt;
      g.velX = g.velX * 0.8 + instVx * 0.2;
      g.velY = g.velY * 0.8 + instVy * 0.2;
      g.panLastX = e.clientX;
      g.panLastY = e.clientY;
      g.panLastT = now;
      onViewportChangeRef.current((prev) =>
        clampViewport({ ...prev, x: prev.x + dx, y: prev.y + dy }, sizeRef.current, getBounds()),
      );
    }
  };

  const finishPointer = (e: React.PointerEvent<HTMLDivElement>, release: boolean) => {
    const g = gestureRef.current;
    const had = pointersRef.current.delete(e.pointerId);
    if (!had) return;
    if (release) {
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    }
    const count = pointersRef.current.size;
    if (g.mode === "marquee") {
      if (count === 0) {
        const wasActive = g.marqueeActive;
        g.mode = "idle";
        g.marqueeActive = false;
        setMarqueeRect(null);
        // pointercancel（release=false）中止框选：不提交选取也不当点击。
        if (!release) return;
        const el = containerRef.current;
        if (wasActive && el && onMarqueeSelect) {
          // 两个角点（萤幕座标）→ 世界座标矩形；Shift = 追加选取。不启动惯性。
          const rect = el.getBoundingClientRect();
          onMarqueeSelect(
            screenRectToWorld(
              { x: g.marqueeStartX, y: g.marqueeStartY },
              { x: e.clientX - rect.left, y: e.clientY - rect.top },
              viewportRef.current,
            ),
            e.shiftKey,
          );
        } else if (!wasActive) {
          // 位移不足视为点击：沿用点击语义（清空选取 / 双击缩放）。
          handleTap(e.clientX, e.clientY, e.pointerType);
        }
      }
      return;
    }
    if (g.mode === "pinch") {
      if (count === 1) {
        // 双指变单指：以剩下的手指继续平移（不重新过门槛）。
        const [p] = [...pointersRef.current.values()];
        g.mode = "pan";
        g.panActive = true;
        g.panLastX = p.x;
        g.panLastY = p.y;
        g.panLastT = performance.now();
        g.velX = 0;
        g.velY = 0;
        setIsPanning(true);
      } else if (count === 0) {
        g.mode = "idle";
        setIsPanning(false);
      }
      return;
    }
    if (g.mode === "pan" && count === 0) {
      const wasActive = g.panActive;
      g.mode = "idle";
      setIsPanning(false);
      if (wasActive) startMomentum();
      else handleTap(e.clientX, e.clientY, e.pointerType);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => finishPointer(e, true);
  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => finishPointer(e, false);
  // releasePointerCapture 之后 lostpointercapture 会到（pointer 已从 map 移除，忽略即可）。
  const handleLostPointerCapture = (e: React.PointerEvent<HTMLDivElement>) => finishPointer(e, false);

  // 右键：容器统一 preventDefault 挡掉浏览器选单。节点 / 互动元素内的右键由
  // 节点层自己开自订选单（这里不重复上报）；空白处才换算世界座标交给上层。
  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const target = e.target as HTMLElement;
    if (target.closest("[data-canvas-node], [data-canvas-interactive]")) return;
    if (!onCanvasContextMenu) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const vp = viewportRef.current;
    onCanvasContextMenu(screen, { x: (screen.x - vp.x) / vp.k, y: (screen.y - vp.y) / vp.k });
  };

  // 滚轮缩放：React 19 的 onWheel 是 passive，preventDefault 会静默失败，
  // 必须用原生 listener + { passive: false }。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopMomentum();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      onViewportChangeRef.current((prev) =>
        clampViewport(zoomAtPoint(prev, e.deltaY, px, py), sizeRef.current, getBounds()),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [getBounds, stopMomentum]);

  // 追踪容器尺寸，回报给父层（fitView / minimap 用）。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const next = { width, height };
        sizeRef.current = next;
        setSize(next);
        onSizeChangeRef.current?.(next);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // visualViewport（虚拟键盘弹出收回、方向转换）：重测容器；尺寸真的变了才更新
  // 并把视口拉回 clamp 范围。iOS 覆盖式键盘不动布局视口 → 这里是 no-op。
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let raf = 0;
    const onVVChange = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = containerRef.current;
        if (!el) return;
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (w === sizeRef.current.width && h === sizeRef.current.height) return;
        const next = { width: w, height: h };
        sizeRef.current = next;
        setSize(next);
        onSizeChangeRef.current?.(next);
        onViewportChangeRef.current((prev) => clampViewport(prev, next, getBounds()));
      });
    };
    vv.addEventListener("resize", onVVChange);
    vv.addEventListener("scroll", onVVChange);
    return () => {
      vv.removeEventListener("resize", onVVChange);
      vv.removeEventListener("scroll", onVVChange);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [getBounds]);

  // 清晰度：will-change:transform 让 Chrome 把内容层按「开始动时的倍率」栅格化后只做缩放合成——
  // 放大后文字/发丝线是被拉伸的旧点阵（糊）。只在视口变动中保留提示（合成器快），
  // 停手 160ms 后撤掉并改用 2D transform，让浏览器按当前倍率重新栅格化（清晰）。
  const [settled, setSettled] = useState(true);
  const lastViewportRef = useRef(viewport);
  useEffect(() => {
    const prev = lastViewportRef.current;
    lastViewportRef.current = viewport;
    if (prev.x === viewport.x && prev.y === viewport.y && prev.k === viewport.k) return;
    setSettled(false);
    const t = window.setTimeout(() => setSettled(true), 160);
    return () => window.clearTimeout(t);
  }, [viewport]);

  // 反向补偿变数挂在内容层、会被上千个子元素继承：每帧改值＝整棵子树 style recalc（审计 P0-2，占主线程 28%）。
  // 移动中按 6% 对数格量化（埠/把手/字级误差 ≤3%），停手写回精确值。
  const varK = settled ? viewport.k : quantizeScale(viewport.k);
  const background = gridBackground(viewport, backgroundMode);
  const contentStyle = {
    ...extraContentStyle,
    transform: settled
      ? `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`
      : `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.k})`,
    willChange: settled ? "auto" : "transform",
    "--canvas-inverse-scale": String(1 / varK),
    // 1/√k：拆机内容字级用——放大时字在萤幕上温和变大（与卡片标题保持比例），世界字级仍缩小＝装得下更多行。
    "--canvas-inverse-sqrt": String(1 / Math.sqrt(varK)),
  } as React.CSSProperties;

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative h-full w-full cursor-grab select-none overflow-hidden",
        isPanning && "cursor-grabbing",
        className,
      )}
      style={{
        ...background,
        // 关键：让浏览器完全不介入画布上的触控（滚动 / 缩放 / pull-to-refresh）。
        touchAction: "none",
        overscrollBehavior: "none",
        WebkitTapHighlightColor: "transparent",
        WebkitTouchCallout: "none",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handleLostPointerCapture}
      onContextMenu={handleContextMenu}
    >
      <div ref={contentRef} className="absolute origin-top-left" style={contentStyle} {...contentData}>
        {children}
      </div>
      {marqueeRect ? (
        // 框选矩形：萤幕座标、盖在内容层之上；pointer-events-none 不干扰手势。
        <div
          className="pointer-events-none absolute border border-ios-blue/80 bg-ios-blue/10"
          style={{
            left: marqueeRect.x,
            top: marqueeRect.y,
            width: marqueeRect.width,
            height: marqueeRect.height,
          }}
        />
      ) : null}
    </div>
  );
}

export { InfiniteCanvas };
export default InfiniteCanvas;
