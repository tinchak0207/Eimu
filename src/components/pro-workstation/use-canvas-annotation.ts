"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_REFERENCE_IMAGES } from "@/components/ReferenceImageUpload";
import type { ImageResult, ReferenceImageRole } from "@/lib/image-types";
import {
  ANNOTATION_CONTEXT_NOTE,
  type AnnotationStroke,
  type CanvasTool,
  type NoticeLevel,
  useEventCallback,
} from "./workstation-constants";

/**
 * 标注图层导出成 PNG 的硬上限（毫秒）。
 *
 * `canvas.toBlob` 是回调式 API、没有任何事件或错误通道：回调不触发就永久 pending。
 * `exportAnnotationToReference` 依靠它把标注合成成参考图，一旦 toBlob 卡住，用户点了
 * 「设为参考图」就永远没有下文（也没有错误可 catch）。形态对齐 `video-frames.captureFrame`：
 * settled 标志 + timer 具名 reject + clearTimeout。上限取 10s，与取帧/视频定位同档。
 */
export const ANNOTATION_EXPORT_TIMEOUT_MS = 10_000;

/**
 * 把 canvas 导出成 PNG blob；toBlob 永不回调时隔 `timeoutMs` 具名 reject（不留永久 pending）。
 * 导出以便 node:test 注入缩短值复现「toBlob 永不回调」。逾时/空白由调用端 catch 落成
 * 「标注保存失败，请重试。」
 */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  timeoutMs: number = ANNOTATION_EXPORT_TIMEOUT_MS,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("导出标注图超时，请重试。"));
    }, timeoutMs);
    try {
      canvas.toBlob((blob) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (blob) resolve(blob);
        else reject(new Error("标注图导出失败：空白图像。"));
      }, "image/png");
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

export interface CanvasAnnotationApi {
  /** 原图模式的容器 ref：滚轮缩放要拿到真实 DOM 才能绑非 passive 监听。 */
  canvasViewportRef: React.RefObject<HTMLDivElement | null>;
  annotationCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  baseImageRef: React.RefObject<HTMLImageElement | null>;
  hasAnnotation: boolean;
  brushSize: number;
  setBrushSize: (size: number) => void;
  strokeCount: number;
  zoomScale: number;
  panOffset: { x: number; y: number };
  isPanning: boolean;
  zoomAtPointer: (factor: number) => void;
  resetZoom: () => void;
  startPan: (event: React.PointerEvent<HTMLDivElement>) => void;
  movePan: (event: React.PointerEvent<HTMLDivElement>) => void;
  endPan: (event: React.PointerEvent<HTMLDivElement>) => void;
  handleAnnotationPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  handleAnnotationPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  handleAnnotationPointerUp: () => void;
  undoAnnotation: () => void;
  clearAnnotation: () => void;
  exportAnnotationToReference: () => Promise<void>;
}

/**
 * 画布标注层（2026-08-22 从 InvokeInspiredWorkstation 拆出）。
 *
 * 拥有标注/缩放/平移的全部 refs 与 state（笔迹撤销栈、笔粗、缩放倍率、平移位移、
 * grabbing 光标），以及 9 个 ref 驱动的绘制函数与三个 effect（zoom 复位 ×2、
 * 非 passive wheel 监听）。canvasZoom（fit/actual 档位）与 activeCanvasTool
 * （工具选择影响整块画布 UI）仍归入口所有，作为参数传入。
 */
export function useCanvasAnnotation(options: {
  canvasZoom: "fit" | "actual";
  selectedSlotId: string | null;
  activeCanvasTool: CanvasTool;
  setActiveCanvasTool: (tool: CanvasTool) => void;
  referenceImages: Array<{ id: string }>;
  visibleResult: ImageResult | undefined;
  setCanvasNotice: (text: string, level?: NoticeLevel) => void;
  appendReferenceImage: (
    file: File,
    role: ReferenceImageRole,
    strength?: number,
  ) => void;
  setContextPrompt: (updater: (current: string) => string) => void;
  appendUniqueText: (current: string, next: string) => string;
}): CanvasAnnotationApi {
  const {
    canvasZoom,
    selectedSlotId,
    activeCanvasTool,
    setActiveCanvasTool,
    referenceImages,
    visibleResult,
    setCanvasNotice,
    appendReferenceImage,
    setContextPrompt,
    appendUniqueText,
  } = options;

  const [hasAnnotation, setHasAnnotation] = useState(false);
  /** 标注笔粗细。旧版硬编码 6px（擦除 26px），小物件太粗、大区域太钝。 */
  const [brushSize, setBrushSize] = useState(6);
  /** 撤销栈深度，只为渲染「撤销」按钮的可用态；笔迹本体在 strokesRef 里。 */
  const [strokeCount, setStrokeCount] = useState(0);
  /** 原图模式的缩放倍率与平移。旧版只有「适应 / 原图大小」二值，检查细节等于用吸管看画。 */
  const [zoomScale, setZoomScale] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  /** 只用于切换 grabbing 光标：拖拽位移本身走 ref，不靠这个 state 驱动。 */
  const [isPanning, setIsPanning] = useState(false);

  /** 原图模式的容器与拖拽状态，滚轮缩放要拿到真实 DOM 才能绑非 passive 监听。 */
  const canvasViewportRef = useRef<HTMLDivElement | null>(null);
  const panDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  /** 撤销栈：每笔存 points + width + mode，切缩放/改栏宽后靠它重绘，不再静默丢失。 */
  const strokesRef = useRef<AnnotationStroke[]>([]);
  const currentStrokeRef = useRef<AnnotationStroke | null>(null);
  const canvasSizeRef = useRef<{ width: number; height: number } | null>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement>(null);
  const baseImageRef = useRef<HTMLImageElement>(null);
  const isDrawingRef = useRef(false);
  const hasAnnotationRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  /** 把一笔画到 context 上；缩放系数用于画布尺寸变化后的等比重绘。 */
  const paintStroke = (
    context: CanvasRenderingContext2D,
    stroke: AnnotationStroke,
    scaleX: number,
    scaleY: number,
  ) => {
    if (stroke.points.length === 0) return;
    const scale = Math.min(scaleX, scaleY);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over";
    context.lineWidth = Math.max(1, stroke.width * scale);
    context.strokeStyle = stroke.mode === "erase" ? "rgba(0,0,0,1)" : "rgba(255, 59, 48, 0.85)";
    context.beginPath();
    const first = stroke.points[0];
    context.moveTo(first.x * scaleX, first.y * scaleY);
    if (stroke.points.length === 1) {
      context.lineTo(first.x * scaleX + 0.01, first.y * scaleY + 0.01);
    } else {
      for (const point of stroke.points.slice(1)) {
        context.lineTo(point.x * scaleX, point.y * scaleY);
      }
    }
    context.stroke();
    context.globalCompositeOperation = "source-over";
  };

  /** 按 strokesRef 重画整层。撤销、尺寸变化、切缩放模式都走这里。 */
  const repaintAnnotations = () => {
    const canvas = annotationCanvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of strokesRef.current) {
      const scaleX = stroke.canvasWidth ? canvas.width / stroke.canvasWidth : 1;
      const scaleY = stroke.canvasHeight ? canvas.height / stroke.canvasHeight : 1;
      paintStroke(context, stroke, scaleX, scaleY);
    }
    const hasDrawn = strokesRef.current.some((stroke) => stroke.mode === "draw");
    hasAnnotationRef.current = hasDrawn;
    setHasAnnotation(hasDrawn);
  };

  /**
   * 画布尺寸变化时按比例重绘，而不是丢掉标注。
   *
   * 旧版一改栏宽、一切「原图大小」，canvas 的 client 尺寸变化就直接把位图清零，
   * 用户刚圈好的区域凭空消失且没有任何提示。现在每笔都记在 strokesRef 里，
   * 尺寸变了就等比重画。
   */
  const syncAnnotationCanvasSize = () => {
    const canvas = annotationCanvasRef.current;
    if (!canvas) return;
    const { clientWidth, clientHeight } = canvas;
    if (clientWidth === 0 || clientHeight === 0) return;
    if (canvas.width !== clientWidth || canvas.height !== clientHeight) {
      canvas.width = clientWidth;
      canvas.height = clientHeight;
      canvasSizeRef.current = { width: clientWidth, height: clientHeight };
      repaintAnnotations();
    }
  };

  const annotationPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  /**
   * 原图模式的滚轮缩放与拖拽平移。
   *
   * 旧版缩放只有「适应 / 原图大小」两档：想看清一只眼睛的细节，只能切原图后
   * 用滚动条一格格找，找到了也没法再放大 —— 等于用吸管看画。现在滚轮（或触控板
   * 双指）缩放 0.25×–8×，按住拖动平移，双击回 100%。
   */
  const zoomAtPointer = useEventCallback((factor: number) => {
    const next = Math.min(8, Math.max(0.25, zoomScale * factor));
    if (next === zoomScale) return;
    // 缩放围绕画布中心，同时等比拉伸已有位移，视觉焦点不会跳走
    const ratio = next / zoomScale;
    setZoomScale(next);
    setPanOffset((current) => ({ x: current.x * ratio, y: current.y * ratio }));
  });

  const resetZoom = useEventCallback(() => {
    setZoomScale(1);
    setPanOffset({ x: 0, y: 0 });
  });

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (canvasZoom !== "actual" || activeCanvasTool !== "select") return;
    panDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: panOffset.x,
      originY: panOffset.y,
    };
    setIsPanning(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setPanOffset({
      x: drag.originX + (event.clientX - drag.startX),
      y: drag.originY + (event.clientY - drag.startY),
    });
  };

  const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (panDragRef.current?.pointerId !== event.pointerId) return;
    panDragRef.current = null;
    setIsPanning(false);
  };

  // 切回「适应」或换图时复位，否则下次进原图模式还停在上一张的放大位置
  useEffect(() => {
    if (canvasZoom === "fit") resetZoom();
  }, [canvasZoom, resetZoom]);

  useEffect(() => {
    resetZoom();
  }, [selectedSlotId, resetZoom]);

  /**
   * wheel 必须用非 passive 的原生监听。
   *
   * React 的 onWheel 走 passive 通道，里面的 preventDefault 被浏览器忽略：
   * 缩放会连带把整个左栏/页面一起滚走。所以这里手动绑，且只在原图模式下绑。
   */
  useEffect(() => {
    if (canvasZoom !== "actual") return;
    const node = canvasViewportRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // deltaY 单位随设备差异很大，只取方向，每格固定 1.12 倍
      zoomAtPointer(event.deltaY < 0 ? 1.12 : 1 / 1.12);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [canvasZoom, zoomAtPointer]);

  const drawAnnotationSegment = (
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) => {
    const canvas = annotationCanvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    // 擦除半径跟随笔粗（约 3 倍），不再是与笔粗脱钩的固定 26px
    const width = activeCanvasTool === "erase" ? brushSize * 3 : brushSize;
    context.lineCap = "round";
    context.lineJoin = "round";
    if (activeCanvasTool === "erase") {
      context.globalCompositeOperation = "destination-out";
      context.strokeStyle = "rgba(0,0,0,1)";
    } else {
      context.globalCompositeOperation = "source-over";
      context.strokeStyle = "rgba(255, 59, 48, 0.85)";
    }
    context.lineWidth = width;
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x + 0.01, to.y + 0.01);
    context.stroke();
    context.globalCompositeOperation = "source-over";
    // 首段标注只 setState 一次，后续笔迹零重渲染（绘制全在 canvas 位图上）
    if (activeCanvasTool === "annotate" && !hasAnnotationRef.current) {
      hasAnnotationRef.current = true;
      setHasAnnotation(true);
    }
  };

  const handleAnnotationPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activeCanvasTool === "select") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    syncAnnotationCanvasSize();
    isDrawingRef.current = true;
    const point = annotationPoint(event);
    lastPointRef.current = point;
    const canvas = annotationCanvasRef.current;
    currentStrokeRef.current = {
      points: [point],
      width: activeCanvasTool === "erase" ? brushSize * 3 : brushSize,
      mode: activeCanvasTool === "erase" ? "erase" : "draw",
      canvasWidth: canvas?.width ?? 0,
      canvasHeight: canvas?.height ?? 0,
    };
    drawAnnotationSegment(point, point);
  };

  const handleAnnotationPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current || activeCanvasTool === "select") return;
    const point = annotationPoint(event);
    drawAnnotationSegment(lastPointRef.current ?? point, point);
    lastPointRef.current = point;
    currentStrokeRef.current?.points.push(point);
  };

  const handleAnnotationPointerUp = () => {
    isDrawingRef.current = false;
    lastPointRef.current = null;
    const stroke = currentStrokeRef.current;
    currentStrokeRef.current = null;
    if (!stroke || stroke.points.length === 0) return;
    // 上限 200 笔：撤销栈够长，又不会在长时间标注后吃掉内存
    strokesRef.current = [...strokesRef.current, stroke].slice(-200);
    setStrokeCount(strokesRef.current.length);
  };

  /** 撤销最后一笔（Ctrl/Cmd+Z）。旧版只有「清空」，画错一笔要全部重来。 */
  const undoAnnotation = useEventCallback(() => {
    if (strokesRef.current.length === 0) {
      setCanvasNotice("没有可撤销的标注。");
      return;
    }
    strokesRef.current = strokesRef.current.slice(0, -1);
    setStrokeCount(strokesRef.current.length);
    repaintAnnotations();
  });

  const clearAnnotation = () => {
    const canvas = annotationCanvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
    strokesRef.current = [];
    currentStrokeRef.current = null;
    setStrokeCount(0);
    hasAnnotationRef.current = false;
    setHasAnnotation(false);
    setCanvasNotice("已清空标注。");
  };

  const exportAnnotationToReference = async () => {
    const canvas = annotationCanvasRef.current;
    if (!canvas || !hasAnnotation) {
      setCanvasNotice("先用标注笔圈出区域。");
      return;
    }
    if (referenceImages.length >= MAX_REFERENCE_IMAGES) {
      setCanvasNotice(`参考图已达上限，最多 ${MAX_REFERENCE_IMAGES} 张。`);
      return;
    }

    const buildAnnotationOnlyBlob = async () => {
      const fallbackCanvas = document.createElement("canvas");
      fallbackCanvas.width = canvas.width;
      fallbackCanvas.height = canvas.height;
      const context = fallbackCanvas.getContext("2d");
      if (!context) throw new Error("no context");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, fallbackCanvas.width, fallbackCanvas.height);
      context.drawImage(canvas, 0, 0);
      return canvasToBlob(fallbackCanvas);
    };

    let blob: Blob;
    let annotationOnly = false;
    const baseImage = baseImageRef.current;
    try {
      if (visibleResult && baseImage?.naturalWidth) {
        const exportCanvas = document.createElement("canvas");
        exportCanvas.width = baseImage.naturalWidth;
        exportCanvas.height = baseImage.naturalHeight;
        const context = exportCanvas.getContext("2d");
        if (!context) throw new Error("no context");
        context.drawImage(baseImage, 0, 0);
        const scale = Math.min(canvas.width / baseImage.naturalWidth, canvas.height / baseImage.naturalHeight);
        const displayWidth = baseImage.naturalWidth * scale;
        const displayHeight = baseImage.naturalHeight * scale;
        const offsetX = (canvas.width - displayWidth) / 2;
        const offsetY = (canvas.height - displayHeight) / 2;
        context.drawImage(
          canvas,
          offsetX, offsetY, displayWidth, displayHeight,
          0, 0, baseImage.naturalWidth, baseImage.naturalHeight,
        );
        blob = await canvasToBlob(exportCanvas);
      } else {
        annotationOnly = true;
        blob = await buildAnnotationOnlyBlob();
      }
    } catch {
      try {
        annotationOnly = true;
        blob = await buildAnnotationOnlyBlob();
      } catch {
        setCanvasNotice("标注保存失败，请重试。");
        return;
      }
    }

    const file = new File([blob], `标注-${Date.now().toString().slice(-6)}.png`, { type: "image/png" });
    appendReferenceImage(file, "composition", 90);
    setContextPrompt((current) => appendUniqueText(current, ANNOTATION_CONTEXT_NOTE));
    clearAnnotation();
    setActiveCanvasTool("select");
    // 两个分支必须说不同的话：只有笔迹的那张（白底红线）对模型的作用和
    // 「原图 + 笔迹」完全不同，旧版两边同一句「已将标注设为参考图」，
    // 用户不会知道底图没被合进去，只会觉得模型没听懂圈的位置。
    setCanvasNotice(annotationOnly
      ? "已把标注单独设为参考图（未含底图）：模型只看到白底上的笔迹，建议在描述里补一句要改的位置。"
      : "已把「原图 + 标注」设为参考图。", annotationOnly ? "warn" : "info");
  };

  return {
    canvasViewportRef,
    annotationCanvasRef,
    baseImageRef,
    hasAnnotation,
    brushSize,
    setBrushSize,
    strokeCount,
    zoomScale,
    panOffset,
    isPanning,
    zoomAtPointer,
    resetZoom,
    startPan,
    movePan,
    endPan,
    handleAnnotationPointerDown,
    handleAnnotationPointerMove,
    handleAnnotationPointerUp,
    undoAnnotation,
    clearAnnotation,
    exportAnnotationToReference,
  };
}
