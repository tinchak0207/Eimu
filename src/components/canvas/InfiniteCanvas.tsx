"use client";

// InfiniteCanvas —— 畫布表面手勢層（行動端軌）。
//
// 行動端（375–430px、觸控、虛擬鍵盤、notch/home indicator）：
//   - touch-action:none + Pointer Events 接管單指平移 / 雙指縮放：瀏覽器滾動、
//     雙擊頁面縮放、pull-to-refresh 全部讓位給畫布（overscroll-behavior 兜底）。
//   - 雙指以兩指中點為錨縮放（同時支援雙指平移）；雙擊以點為錨放大兩倍。
//   - 鬆手後慣性滑行（prefers-reduced-motion 時直接停住，不滑）。
//   - 視口 clamp：有內容時，節點永遠不會被推出可觸及範圍；縮放沿用全域上下限。
//   - visualViewport resize/scroll（虛擬鍵盤彈出收回、方向轉換）後重測容器，
//     尺寸變化時把視口拉回 clamp 範圍。
//   - translate3d + will-change 讓合成器以裝置像素運算，Retina 下不糊。
//
// 桌面補充（Phase 3 交互引擎）：
//   - Shift/Ctrl/⌘ + 空白處拖動 = 框選（觸控不啟用：行動端沒有修飾鍵語境，
//     維持平移）；位移不足視為點擊，命中判定交給 lib/canvas/interaction 純函式。
//   - 右鍵一律擋掉瀏覽器選單；空白處右鍵換算世界座標上報，讓上層開自訂選單。
//
// 邊界：data-canvas-node / data-canvas-interactive（節點表單、縮放手柄）由
// CanvasNodeView（另一軌）負責。這裡只在空白表面接收手勢，互動元素一律放行。

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
  /** 框選完成（世界座標矩形，additive = 按住 Shift 追加選取）。提供此 prop 才啟用框選。 */
  onMarqueeSelect?: (rect: WorldRect, additive: boolean) => void;
  /** 空白處右鍵（螢幕座標 = 相對容器左上，世界座標已換算）。 */
  onCanvasContextMenu?: (screen: { x: number; y: number }, world: { x: number; y: number }) => void;
  /** 桌面雙擊空白：就地建節點（提供此 prop 後桌面雙擊不再放大；觸控不受影響）。 */
  onCanvasDoubleClick?: (screen: { x: number; y: number }, world: { x: number; y: number }) => void;
  className?: string;
  /**
   * 內容層（世界座標、隨 viewport 變換的那層）的附加樣式／data 屬性。
   * 語義縮放用它每幀下發 CSS 變數（--lod-g / --lod-xray…）與狀態屬性，節點靠 CSS 反應、不多 render。
   */
  contentStyle?: React.CSSProperties;
  contentData?: Record<`data-${string}`, string | undefined>;
  children: React.ReactNode;
}

// ── 手勢參數 ──
const PAN_THRESHOLD = 3; // 移動超過此距離才算平移（px）
const MARQUEE_THRESHOLD = 4; // 框選位移低於此視為點擊（px），不觸發 onMarqueeSelect
const DOUBLE_TAP_MS = 300; // 雙擊時間窗（ms）
const DOUBLE_TAP_SLOP = 44; // 兩次點擊的位置容差（px）
const DOUBLE_TAP_ZOOM = 2; // 雙擊放大倍率
const CLAMP_MARGIN = 64; // 內容可被推出視口的最大距離（px）；160 太大，節點被切一半觀感極差
const EMPTY_WORLD_HALF = 600; // 空畫布的原點可觸及半徑（世界座標）
const FLING_MIN_VELOCITY = 0.12; // px/ms，低於此不啟動慣性
const FLING_STOP_VELOCITY = 0.02; // px/ms，低於此停止慣性
const FLING_FRICTION = 0.92; // 每 16.7ms 的衰減係數

interface ContentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface BoundsResult {
  /** 畫布上是否有節點（有內容才做平移 clamp，空畫布維持無限平移 = 桌面現狀）。 */
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

/** 平移 clamp：內容永遠保持可觸及；zoom 沿用全域上下限（clampScale）。 */
function clampViewport(vp: CanvasViewport, size: { width: number; height: number }, r: BoundsResult): CanvasViewport {
  const k = clampScale(vp.k);
  if (!r.hasContent || size.width <= 0 || size.height <= 0) return { ...vp, k };
  const b = r.b;
  // 內容的右緣最多被推到視口左緣外 CLAMP_MARGIN，左緣同理 → 永遠摸得到。
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

/** 以某螢幕點為錨縮放（與 zoomAtPoint 同一套錨點數學，直接吃倍率）。 */
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
  // 框選矩形（螢幕座標、相對容器左上）；null = 未在框選。超過門檻才開始渲染。
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  // 最新的 viewport / 回呼存在 ref：原生 listener 只註冊一次，
  // 不因每次 render 重新註冊，也不吃閉包裡的舊值。
  const viewportRef = useRef(viewport);
  const onViewportChangeRef = useRef(onViewportChange);
  const onSizeChangeRef = useRef(onSizeChange);
  const onCanvasDoubleClickRef = useRef(onCanvasDoubleClick);

  // 尺寸存 ref + state（ref 給 ResizeObserver / 手勢用，state 留給需要重渲染的場景）。
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const sizeRef = useRef(size);

  // ── 手勢狀態（全部放 ref，不進 render 路徑）
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

  // 內容範圍快取：讀節點 inline style（世界座標），不觸發 layout。
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

  // 尊重 prefers-reduced-motion：慣性滑行直接停住。
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduceMotionRef.current = mq.matches;
    const onChange = (e: MediaQueryListEvent) => {
      reduceMotionRef.current = e.matches;
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  /** 世界範圍：data-canvas-node 的 left/top/width/height 就是世界座標，直接讀 inline style。 */
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

  // 節點增刪／移動（inline style 變更）→ 內容範圍標髒，下次手勢才重算。
  // 內容層自己的 transform 每幀都在變，callback 裡過濾掉（它不帶 data-canvas-node）。
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

  /** 慣性滑行：指數衰減，每幀 clamp，速度低於門檻即停。 */
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

  /** 點擊：第一次觸發清空選取，300ms 內同一點再點 = 雙擊。
   *  桌面（mouse/pen）有 onCanvasDoubleClick 時雙擊 = 就地建節點；
   *  觸控（或未提供回呼）維持雙擊放大——行動端沒有滾輪，放大手勢不能沒收。 */
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 缺 onBackgroundPointerDown（父層 CanvasEmbed 以 inline arrow 傳入、每次 render 新身分）；硬加會讓 handleTap 每次 render 重建，進而重掛 canvas 手勢監聽。
    [getBounds],
  );

  // ── 平移 / 縮放手勢（Pointer Events + touch-action:none）──
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // 節點本體、節點內的表單/按鈕/縮放手柄：放行給 CanvasNodeView 處理。
    if (target.closest("[data-canvas-node], [data-canvas-interactive]")) return;
    // 框選進行中：忽略後續指針（不切 pinch，框選以第一根指針為準）。
    if (gestureRef.current.mode === "marquee") return;
    stopMomentum();
    const now = performance.now();
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer 已結束時 capture 會拋錯，忽略 */
    }
    const g = gestureRef.current;
    if (pointersRef.current.size === 1) {
      // 修飾鍵 + 非觸控 + 有回呼 → 框選；觸控維持平移（中鍵/右鍵已被 button 檢查擋掉）。
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

    // 框選：更新螢幕座標矩形；超過門檻才開始渲染（Shift+點擊不閃出 1px 矩形）。
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

    // 雙指：以中點為錨縮放，中點位移 = 雙指平移。
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

    // 單指平移：未超過門檻當作點擊候選；順便記錄速度供慣性使用。
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
        // pointercancel（release=false）中止框選：不提交選取也不當點擊。
        if (!release) return;
        const el = containerRef.current;
        if (wasActive && el && onMarqueeSelect) {
          // 兩個角點（螢幕座標）→ 世界座標矩形；Shift = 追加選取。不啟動慣性。
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
          // 位移不足視為點擊：沿用點擊語義（清空選取 / 雙擊縮放）。
          handleTap(e.clientX, e.clientY, e.pointerType);
        }
      }
      return;
    }
    if (g.mode === "pinch") {
      if (count === 1) {
        // 雙指變單指：以剩下的手指繼續平移（不重新過門檻）。
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
  // releasePointerCapture 之後 lostpointercapture 會到（pointer 已從 map 移除，忽略即可）。
  const handleLostPointerCapture = (e: React.PointerEvent<HTMLDivElement>) => finishPointer(e, false);

  // 右鍵：容器統一 preventDefault 擋掉瀏覽器選單。節點 / 互動元素內的右鍵由
  // 節點層自己開自訂選單（這裡不重複上報）；空白處才換算世界座標交給上層。
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

  // 滾輪縮放：React 19 的 onWheel 是 passive，preventDefault 會靜默失敗，
  // 必須用原生 listener + { passive: false }。
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

  // 追蹤容器尺寸，回報給父層（fitView / minimap 用）。
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

  // visualViewport（虛擬鍵盤彈出收回、方向轉換）：重測容器；尺寸真的變了才更新
  // 並把視口拉回 clamp 範圍。iOS 覆蓋式鍵盤不動佈局視口 → 這裡是 no-op。
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

  // 清晰度：will-change:transform 讓 Chrome 把內容層按「開始動時的倍率」柵格化後只做縮放合成——
  // 放大後文字/髮絲線是被拉伸的舊點陣（糊）。只在視口變動中保留提示（合成器快），
  // 停手 160ms 後撤掉並改用 2D transform，讓瀏覽器按當前倍率重新柵格化（清晰）。
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

  // 反向補償變數掛在內容層、會被上千個子元素繼承：每幀改值＝整棵子樹 style recalc（審計 P0-2，佔主線程 28%）。
  // 移動中按 6% 對數格量化（埠/把手/字級誤差 ≤3%），停手寫回精確值。
  const varK = settled ? viewport.k : quantizeScale(viewport.k);
  const background = gridBackground(viewport, backgroundMode);
  const contentStyle = {
    ...extraContentStyle,
    transform: settled
      ? `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`
      : `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.k})`,
    willChange: settled ? "auto" : "transform",
    "--canvas-inverse-scale": String(1 / varK),
    // 1/√k：拆機內容字級用——放大時字在螢幕上溫和變大（與卡片標題保持比例），世界字級仍縮小＝裝得下更多行。
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
        // 關鍵：讓瀏覽器完全不介入畫布上的觸控（滾動 / 縮放 / pull-to-refresh）。
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
        // 框選矩形：螢幕座標、蓋在內容層之上；pointer-events-none 不干擾手勢。
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
