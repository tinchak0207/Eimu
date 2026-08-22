"use client";

// CanvasImageEditorDialog —— 畫布圖片編輯全家桶（裁剪 / 切图 / 抠除 / 旋转 / 角度）。
//
// 立場：非破壞性。像素類操作輸出新圖（PNG dataURL），由宿主決定怎麼落畫布
// （作為子節點插回並連線），原節點永遠不動。生成類操作（角度重繪、抠除的
// AI 重绘）不產出像素，改走 onRequestAngleGenerate / onRequestInpaint 回調，
// 由宿主的生成鏈路接手——UI 誠實標註這是 AI 重繪，不假裝本地變換。
//
// 座標系：預覽區用 object-contain 置中，displayScale = 顯示寬 / 自然寬；
// 指標事件的容器座標 × (1/displayScale) 轉回原圖像素座標再進像素操作。
//
// 切图：切割線以原圖像素座標存放（splitXs 縱線 / splitYs 橫線），可拖動、
// 增刪；行列 1-4 快捷鍵 = 重生成均分線。確認時經 computeSplitRectsFromLines
// 算矩形再切片。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crop, Eraser, Grid3X3, Rotate3D, RotateCcw, RotateCw, FlipHorizontal2, FlipVertical2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  buildAnglePrompt,
  clampCropRect,
  computeSplitRectsFromLines,
  cropToDataUrl,
  eraseMaskToDataUrl,
  findLineSpot,
  loadImageBitmap,
  maskToDataUrl,
  rotateFlipToDataUrl,
  rotatedSize,
  splitRectsToDataUrls,
  type PixelRect,
} from "@/lib/canvas/image-edit";

export type CanvasImageEditMode = "crop" | "split" | "mask" | "rotate" | "angle";

export interface CanvasImageEditResult {
  dataUrl: string;
  width: number;
  height: number;
  label: string;
}

export interface CanvasImageEditorDialogProps {
  open: boolean;
  imageUrl: string;
  nodeTitle: string;
  initialMode?: CanvasImageEditMode;
  onClose: () => void;
  /** 產出一或多張結果（切图多張，其餘單張）。由宿主決定怎麼落畫布。 */
  onProduce: (results: CanvasImageEditResult[], mode: CanvasImageEditMode) => void;
  /**
   * 「角度」模式確認回調：不輸出像素，由宿主按 anglePrompt（中文生圖指令）
   * 走 AI 重繪。未提供時「角度」tab 不顯示。
   */
  onRequestAngleGenerate?: (params: { yawDeg: number; pitchDeg: number; distance: number; anglePrompt: string }) => void;
  /**
   * 抠除的「AI 重绘」確認回調：maskDataUrl 為與原圖同尺寸、塗抹區純白不透明、
   * 其餘透明的 PNG；instruction 為用戶輸入的一行指令。未提供時該選項不顯示。
   */
  onRequestInpaint?: (params: { maskDataUrl: string; instruction: string }) => void;
}

const MODE_TABS: { id: CanvasImageEditMode; label: string; icon: React.ReactNode }[] = [
  { id: "crop", label: "裁剪", icon: <Crop className="h-3.5 w-3.5" /> },
  { id: "split", label: "切图", icon: <Grid3X3 className="h-3.5 w-3.5" /> },
  { id: "mask", label: "抠除", icon: <Eraser className="h-3.5 w-3.5" /> },
  { id: "rotate", label: "旋转", icon: <RotateCw className="h-3.5 w-3.5" /> },
];

const ANGLE_TAB: { id: CanvasImageEditMode; label: string; icon: React.ReactNode } = {
  id: "angle",
  label: "角度",
  icon: <Rotate3D className="h-3.5 w-3.5" />,
};

const ASPECT_PRESETS: { label: string; ratio: number | null }[] = [
  { label: "自由", ratio: null },
  { label: "1:1", ratio: 1 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "3:4", ratio: 3 / 4 },
  { label: "16:9", ratio: 16 / 9 },
  { label: "9:16", ratio: 9 / 16 },
];

type CropHandle = "nw" | "ne" | "sw" | "se" | "move";
type SplitLineAxis = "x" | "y";

/** 均分線位：count 份 → count-1 條線（四捨五入到整數像素）。 */
function evenLines(size: number, count: number): number[] {
  const n = Math.max(1, Math.floor(count));
  return Array.from({ length: n - 1 }, (_, i) => Math.round((size * (i + 1)) / n));
}

/** 拖動切割線：clamp 在相鄰線（或圖界）±8px 之間；空間不足時原地不動。 */
function moveLineWithin(lines: number[], index: number, value: number, size: number): number[] {
  const min = (index > 0 ? lines[index - 1] : 0) + 8;
  const max = (index < lines.length - 1 ? lines[index + 1] : size) - 8;
  if (min > max) return lines;
  const next = [...lines];
  next[index] = Math.round(Math.min(max, Math.max(min, value)));
  return next;
}

export function CanvasImageEditorDialog({
  open,
  imageUrl,
  nodeTitle,
  initialMode = "crop",
  onClose,
  onProduce,
  onRequestAngleGenerate,
  onRequestInpaint,
}: CanvasImageEditorDialogProps) {
  const [mode, setMode] = useState<CanvasImageEditMode>(initialMode);
  const [bmp, setBmp] = useState<ImageBitmap | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // 裁剪態
  const [cropRect, setCropRect] = useState<PixelRect | null>(null);
  const [aspect, setAspect] = useState<number | null>(null);
  // 切图態：自定義切割線（原圖像素座標；縱線 xs 橫拖、橫線 ys 縱拖）
  const [splitXs, setSplitXs] = useState<number[]>([]);
  const [splitYs, setSplitYs] = useState<number[]>([]);
  const [selectedLine, setSelectedLine] = useState<{ axis: SplitLineAxis; index: number } | null>(null);
  const lineDragRef = useRef<{ pointerId: number; axis: SplitLineAxis; index: number } | null>(null);
  // 旋转態
  const [deg, setDeg] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  // 抠除態
  const [brushSize, setBrushSize] = useState(24);
  const [eraserMode, setEraserMode] = useState(false);
  const [maskOutput, setMaskOutput] = useState<"erase" | "inpaint">("erase");
  const [inpaintInstruction, setInpaintInstruction] = useState("");
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskDisplayRef = useRef<HTMLCanvasElement | null>(null);
  const paintingRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
  // 角度態（純預覽參數，確認時交宿主 AI 重繪）
  const [yawDeg, setYawDeg] = useState(0);
  const [pitchDeg, setPitchDeg] = useState(0);
  const [distance, setDistance] = useState(1);

  // 預覽量測
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 });
  const cropDragRef = useRef<{
    pointerId: number;
    handle: CropHandle;
    startX: number;
    startY: number;
    startRect: PixelRect;
  } | null>(null);

  // 未提供角度回調時，「角度」tab 不存在——就算 initialMode 傳了 angle 也回退裁剪。
  const activeMode: CanvasImageEditMode = mode === "angle" && !onRequestAngleGenerate ? "crop" : mode;
  // 未提供 inpaint 回調時，抠除固定走透明輸出。
  const effectiveMaskOutput: "erase" | "inpaint" = onRequestInpaint ? maskOutput : "erase";
  const modeTabs = onRequestAngleGenerate ? [...MODE_TABS, ANGLE_TAB] : MODE_TABS;

  // 載圖成功後的統一初始化（開啟載入與失敗重試共用）
  const initFromBitmap = useCallback((bitmap: ImageBitmap) => {
    setBmp(bitmap);
    // 預設裁剪框：置中 80%
    setCropRect(
      clampCropRect(
        {
          x: Math.round(bitmap.width * 0.1),
          y: Math.round(bitmap.height * 0.1),
          width: Math.round(bitmap.width * 0.8),
          height: Math.round(bitmap.height * 0.8),
        },
        bitmap.width,
        bitmap.height,
      ),
    );
    // 切图預設：2x2 均分線
    setSplitXs(evenLines(bitmap.width, 2));
    setSplitYs(evenLines(bitmap.height, 2));
    setSelectedLine(null);
    // 抠除 mask：與原圖同尺寸的離屏 canvas
    const mask = document.createElement("canvas");
    mask.width = bitmap.width;
    mask.height = bitmap.height;
    maskCanvasRef.current = mask;
    setLoading(false);
  }, []);

  // 開啟時載圖 + 重置各模式狀態
  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setBmp(null);
    setLoadError(null);
    setLoading(true);
    setCropRect(null);
    setAspect(null);
    setSplitXs([]);
    setSplitYs([]);
    setSelectedLine(null);
    setDeg(0);
    setFlipH(false);
    setFlipV(false);
    setEraserMode(false);
    setMaskOutput("erase");
    setInpaintInstruction("");
    setYawDeg(0);
    setPitchDeg(0);
    setDistance(1);
    let cancelled = false;
    loadImageBitmap(imageUrl)
      .then((bitmap) => {
        if (cancelled) return;
        initFromBitmap(bitmap);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "图片加载失败");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, imageUrl, initialMode, initFromBitmap]);

  // Escape 關閉
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 預覽區尺寸追蹤
  useEffect(() => {
    if (!open) return;
    const el = viewRef.current;
    if (!el) return;
    const update = () => setViewSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, bmp]);

  // object-contain 幾何：圖片在預覽區內的實際顯示矩形
  const display = useMemo(() => {
    if (!bmp || viewSize.width === 0 || viewSize.height === 0) return null;
    const scale = Math.min(viewSize.width / bmp.width, viewSize.height / bmp.height, 1);
    const width = bmp.width * scale;
    const height = bmp.height * scale;
    return {
      scale,
      width,
      height,
      left: (viewSize.width - width) / 2,
      top: (viewSize.height - height) / 2,
    };
  }, [bmp, viewSize]);

  // 顯示座標（相對圖片左上）→ 原圖像素
  const toPixel = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const el = viewRef.current;
      if (!el || !display) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: (clientX - rect.left - display.left) / display.scale,
        y: (clientY - rect.top - display.top) / display.scale,
      };
    },
    [display],
  );

  // ── 裁剪框拖動/調角 ──
  const startCropDrag = (e: React.PointerEvent, handle: CropHandle) => {
    if (!cropRect) return;
    e.stopPropagation();
    e.preventDefault();
    cropDragRef.current = {
      pointerId: e.pointerId,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      startRect: cropRect,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const moveCropDrag = (e: React.PointerEvent) => {
    const d = cropDragRef.current;
    if (!d || d.pointerId !== e.pointerId || !bmp || !display) return;
    const dx = (e.clientX - d.startX) / display.scale;
    const dy = (e.clientY - d.startY) / display.scale;
    const r = d.startRect;
    let next: PixelRect;
    if (d.handle === "move") {
      next = { ...r, x: r.x + dx, y: r.y + dy };
    } else {
      const fromLeft = d.handle === "nw" || d.handle === "sw";
      const fromTop = d.handle === "nw" || d.handle === "ne";
      let width = fromLeft ? r.width - dx : r.width + dx;
      let height = fromTop ? r.height - dy : r.height + dy;
      if (aspect) height = width / aspect;
      width = Math.max(8, width);
      height = Math.max(8, height);
      next = {
        x: fromLeft ? r.x + r.width - width : r.x,
        y: fromTop ? r.y + r.height - height : r.y,
        width,
        height,
      };
    }
    setCropRect(clampCropRect({
      x: Math.round(next.x),
      y: Math.round(next.y),
      width: Math.round(next.width),
      height: Math.round(next.height),
    }, bmp.width, bmp.height));
  };

  const endCropDrag = (e: React.PointerEvent) => {
    if (cropDragRef.current?.pointerId === e.pointerId) cropDragRef.current = null;
  };

  // 比例切換：以當前框中心套用新比例
  const applyAspect = (ratio: number | null) => {
    setAspect(ratio);
    if (!ratio || !cropRect || !bmp) return;
    const cx = cropRect.x + cropRect.width / 2;
    const cy = cropRect.y + cropRect.height / 2;
    let width = cropRect.width;
    let height = width / ratio;
    if (height > bmp.height) {
      height = bmp.height;
      width = height * ratio;
    }
    setCropRect(clampCropRect({
      x: Math.round(cx - width / 2),
      y: Math.round(cy - height / 2),
      width: Math.round(width),
      height: Math.round(height),
    }, bmp.width, bmp.height));
  };

  // ── 切图：切割線增刪與拖動 ──
  // 行/列 1-4 快捷鍵：點擊 = 重生成該方向的均分線（丟棄手動微調）。
  const applySplitQuick = (axis: SplitLineAxis, count: number) => {
    if (!bmp) return;
    setSelectedLine(null);
    if (axis === "x") setSplitXs(evenLines(bmp.width, count));
    else setSplitYs(evenLines(bmp.height, count));
  };

  // 在最大空隙中點加一條線並選中；findLineSpot 回 null（無空隙）時按鈕已 disabled。
  const addSplitLine = (axis: SplitLineAxis) => {
    if (!bmp) return;
    const size = axis === "x" ? bmp.width : bmp.height;
    const lines = axis === "x" ? splitXs : splitYs;
    const spot = findLineSpot(size, lines);
    if (spot === null) return;
    const next = [...lines, spot].sort((a, b) => a - b);
    if (axis === "x") setSplitXs(next);
    else setSplitYs(next);
    setSelectedLine({ axis, index: next.indexOf(spot) });
  };

  const deleteSelectedLine = useCallback(() => {
    if (!selectedLine) return;
    if (selectedLine.axis === "x") setSplitXs((prev) => prev.filter((_, i) => i !== selectedLine.index));
    else setSplitYs((prev) => prev.filter((_, i) => i !== selectedLine.index));
    setSelectedLine(null);
  }, [selectedLine]);

  // Del / Backspace 刪除選中線（避開輸入框焦點場景）
  useEffect(() => {
    if (!open || activeMode !== "split" || !selectedLine) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input,textarea,[contenteditable='true']")) return;
      e.preventDefault();
      deleteSelectedLine();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, activeMode, selectedLine, deleteSelectedLine]);

  const startLineDrag = (e: React.PointerEvent, axis: SplitLineAxis, index: number) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedLine({ axis, index });
    lineDragRef.current = { pointerId: e.pointerId, axis, index };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const moveLineDrag = (e: React.PointerEvent) => {
    const d = lineDragRef.current;
    if (!d || d.pointerId !== e.pointerId || !bmp) return;
    const p = toPixel(e.clientX, e.clientY);
    if (!p) return;
    // 拖動期間 clamp 在相鄰線之間，順序不變，index 穩定。
    if (d.axis === "x") setSplitXs((prev) => moveLineWithin(prev, d.index, p.x, bmp.width));
    else setSplitYs((prev) => moveLineWithin(prev, d.index, p.y, bmp.height));
  };

  const endLineDrag = (e: React.PointerEvent) => {
    if (lineDragRef.current?.pointerId === e.pointerId) lineDragRef.current = null;
  };

  // ── 抠除塗抹 ──
  const paintAt = useCallback(
    (px: number, py: number, lastX?: number, lastY?: number) => {
      const mask = maskCanvasRef.current;
      const displayMask = maskDisplayRef.current;
      if (!mask) return;
      const brush = brushSize;
      for (const canvas of [mask, displayMask]) {
        if (!canvas) continue;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        const sx = canvas.width / mask.width;
        ctx.globalCompositeOperation = eraserMode ? "destination-out" : "source-over";
        ctx.strokeStyle = "rgba(255,59,48,0.55)";
        ctx.fillStyle = "rgba(255,59,48,0.55)";
        ctx.lineWidth = brush * sx;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        if (lastX !== undefined && lastY !== undefined) {
          ctx.beginPath();
          ctx.moveTo(lastX * sx, lastY * sx);
          ctx.lineTo(px * sx, py * sx);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(px * sx, py * sx, (brush / 2) * sx, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    },
    [brushSize, eraserMode],
  );

  const onMaskPointerDown = (e: React.PointerEvent) => {
    const p = toPixel(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    paintingRef.current = { pointerId: e.pointerId, lastX: p.x, lastY: p.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    paintAt(p.x, p.y);
  };
  const onMaskPointerMove = (e: React.PointerEvent) => {
    const s = paintingRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const p = toPixel(e.clientX, e.clientY);
    if (!p) return;
    paintAt(p.x, p.y, s.lastX, s.lastY);
    s.lastX = p.x;
    s.lastY = p.y;
  };
  const onMaskPointerUp = (e: React.PointerEvent) => {
    if (paintingRef.current?.pointerId === e.pointerId) paintingRef.current = null;
  };

  const clearMask = () => {
    for (const canvas of [maskCanvasRef.current, maskDisplayRef.current]) {
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  // 顯示層 mask canvas 尺寸同步（顯示尺寸變化時重置顯示層——已塗內容仍在離屏 mask 上，
  // 但顯示層會清空；簡化處理：把離屏 mask 重繪到顯示層）。
  useEffect(() => {
    if (activeMode !== "mask" || !display || !bmp) return;
    const displayMask = maskDisplayRef.current;
    const mask = maskCanvasRef.current;
    if (!displayMask || !mask) return;
    displayMask.width = Math.max(1, Math.round(display.width));
    displayMask.height = Math.max(1, Math.round(display.height));
    const ctx = displayMask.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, displayMask.width, displayMask.height);
      ctx.drawImage(mask, 0, 0, mask.width, mask.height, 0, 0, displayMask.width, displayMask.height);
    }
  }, [activeMode, display, bmp]);

  // ── 確認產出 ──
  const handleConfirm = () => {
    if (!bmp || busy) return;
    setBusy(true);
    try {
      if (activeMode === "crop") {
        if (!cropRect) return;
        const r = clampCropRect(cropRect, bmp.width, bmp.height);
        onProduce([{ dataUrl: cropToDataUrl(bmp, r), width: r.width, height: r.height, label: `裁剪 ${r.width}x${r.height}` }], "crop");
      } else if (activeMode === "split") {
        const rects = computeSplitRectsFromLines(bmp.width, bmp.height, splitXs, splitYs);
        const results = splitRectsToDataUrls(bmp, rects).map((item, i) => ({
          dataUrl: item.dataUrl,
          width: item.rect.width,
          height: item.rect.height,
          label: `切图 第${i + 1}张`,
        }));
        onProduce(results, "split");
      } else if (activeMode === "mask") {
        const mask = maskCanvasRef.current;
        if (!mask) return;
        if (effectiveMaskOutput === "inpaint" && onRequestInpaint) {
          const instruction = inpaintInstruction.trim();
          if (!instruction) return;
          onRequestInpaint({ maskDataUrl: maskToDataUrl(mask, bmp.width, bmp.height), instruction });
        } else {
          onProduce([{ dataUrl: eraseMaskToDataUrl(bmp, mask), width: bmp.width, height: bmp.height, label: "抠除结果" }], "mask");
        }
      } else if (activeMode === "angle") {
        if (!onRequestAngleGenerate) return;
        onRequestAngleGenerate({ yawDeg, pitchDeg, distance, anglePrompt: buildAnglePrompt(yawDeg, pitchDeg, distance) });
      } else {
        const size = rotatedSize(bmp.width, bmp.height, deg);
        onProduce([{ dataUrl: rotateFlipToDataUrl(bmp, deg, flipH, flipV), width: size.width, height: size.height, label: "旋转/翻转" }], "rotate");
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const splitRects = bmp && activeMode === "split" ? computeSplitRectsFromLines(bmp.width, bmp.height, splitXs, splitYs) : [];
  const splitCount = (splitXs.length + 1) * (splitYs.length + 1);
  // 加線按鈕可用性：無 >=16px 的空隙時 disabled
  const vSpot = bmp ? findLineSpot(bmp.width, splitXs) : null;
  const hSpot = bmp ? findLineSpot(bmp.height, splitYs) : null;
  // 角度預覽：純 CSS 示意（阻尼係數讓滿角不至於翻爛畫面），真正產圖走 AI 重繪。
  const anglePreviewTransform = `perspective(900px) rotateY(${yawDeg * -0.45}deg) rotateX(${pitchDeg * 0.35}deg) scale(${Math.max(0.5, Math.min(1.7, 1 / distance)).toFixed(3)})`;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4" data-canvas-interactive>
      <div className="flex h-[min(88vh,720px)] w-[min(92vw,960px)] flex-col overflow-hidden rounded-2xl lg-sheet">
        {/* 頂欄：標題 + tab + 關閉 */}
        <div className="flex items-center gap-3 border-b px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate text-ios-subhead font-semibold text-foreground">
            编辑图片 · {nodeTitle}
          </span>
          <div className="flex items-center gap-1 rounded-lg bg-black/5 p-0.5">
            {modeTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setMode(tab.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors",
                  activeMode === tab.id ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-full text-foreground/45 hover:bg-black/5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 預覽區 */}
        <div ref={viewRef} className="relative min-h-0 flex-1 overflow-hidden bg-[#111]">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/25 border-t-white" aria-hidden="true" />
            </div>
          )}
          {loadError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-[13.5px] leading-relaxed text-white/80">{loadError}</p>
              <button
                type="button"
                onClick={() => {
                  setLoadError(null);
                  setLoading(true);
                  loadImageBitmap(imageUrl)
                    .then(initFromBitmap)
                    .catch((error: unknown) => {
                      setLoadError(error instanceof Error ? error.message : "图片加载失败");
                      setLoading(false);
                    });
                }}
                className="rounded-full bg-white px-4 py-1.5 text-ios-footnote font-medium text-foreground"
              >
                重试
              </button>
            </div>
          )}
          {bmp && display && (
            <>
              <img
                src={imageUrl}
                alt={nodeTitle}
                draggable={false}
                className="pointer-events-none absolute select-none"
                style={{
                  left: display.left,
                  top: display.top,
                  width: display.width,
                  height: display.height,
                  transform:
                    activeMode === "rotate"
                      ? `rotate(${deg}deg) scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1})`
                      : activeMode === "angle"
                        ? anglePreviewTransform
                        : undefined,
                }}
              />

              {/* 裁剪覆蓋層 */}
              {activeMode === "crop" && cropRect && (
                <div
                  className="absolute"
                  style={{ left: display.left, top: display.top, width: display.width, height: display.height }}
                >
                  {/* 半透明遮罩四塊（上/下/左/右） */}
                  {(() => {
                    const s = display.scale;
                    const rx = cropRect.x * s;
                    const ry = cropRect.y * s;
                    const rw = cropRect.width * s;
                    const rh = cropRect.height * s;
                    const shade = "absolute bg-black/50";
                    return (
                      <>
                        <div className={shade} style={{ left: 0, top: 0, width: "100%", height: ry }} />
                        <div className={shade} style={{ left: 0, top: ry + rh, width: "100%", height: Math.max(0, display.height - ry - rh) }} />
                        <div className={shade} style={{ left: 0, top: ry, width: rx, height: rh }} />
                        <div className={shade} style={{ left: rx + rw, top: ry, width: Math.max(0, display.width - rx - rw), height: rh }} />
                        {/* 裁剪框本體：可拖動 */}
                        <div
                          className="absolute cursor-move border-2 border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
                          style={{ left: rx, top: ry, width: rw, height: rh, touchAction: "none" }}
                          onPointerDown={(e) => startCropDrag(e, "move")}
                          onPointerMove={moveCropDrag}
                          onPointerUp={endCropDrag}
                          onPointerCancel={endCropDrag}
                        >
                          <span className="absolute bottom-1 right-1.5 rounded bg-black/60 px-1.5 py-0.5 text-ios-caption2 tabular-nums text-white">
                            {cropRect.width}×{cropRect.height}
                          </span>
                        </div>
                        {/* 四角手柄 */}
                        {(["nw", "ne", "sw", "se"] as const).map((h) => (
                          <div
                            key={h}
                            className="absolute h-4 w-4 rounded-sm border-2 border-white bg-ios-blue"
                            style={{
                              left: (h === "nw" || h === "sw" ? rx : rx + rw) - 8,
                              top: (h === "nw" || h === "ne" ? ry : ry + rh) - 8,
                              cursor: h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize",
                              touchAction: "none",
                            }}
                            onPointerDown={(e) => startCropDrag(e, h)}
                            onPointerMove={moveCropDrag}
                            onPointerUp={endCropDrag}
                            onPointerCancel={endCropDrag}
                          />
                        ))}
                      </>
                    );
                  })()}
                </div>
              )}

              {/* 切图：編號標籤 + 可拖動切割線 */}
              {activeMode === "split" && (
                <div
                  className="absolute"
                  style={{ left: display.left, top: display.top, width: display.width, height: display.height }}
                  onPointerDown={() => setSelectedLine(null)}
                >
                  {splitRects.map((r, i) => (
                    <span
                      key={`n-${i}`}
                      className="pointer-events-none absolute rounded bg-black/50 px-1 text-ios-caption2 font-medium leading-4 text-white/90"
                      style={{ left: r.x * display.scale + 3, top: r.y * display.scale + 3 }}
                    >
                      {i + 1}
                    </span>
                  ))}
                  {/* 縱線：橫向拖動（12px 寬命中區，中央 2px 實線） */}
                  {splitXs.map((x, i) => {
                    const isSelected = selectedLine?.axis === "x" && selectedLine.index === i;
                    return (
                      <div
                        key={`x-${i}`}
                        className="group absolute inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize"
                        style={{ left: x * display.scale, touchAction: "none" }}
                        onPointerDown={(e) => startLineDrag(e, "x", i)}
                        onPointerMove={moveLineDrag}
                        onPointerUp={endLineDrag}
                        onPointerCancel={endLineDrag}
                      >
                        <div
                          className={cn(
                            "absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 transition-colors",
                            isSelected
                              ? "bg-ios-blue shadow-[0_0_8px_rgba(0,122,255,0.9)]"
                              : "bg-white/75 group-hover:bg-white group-hover:shadow-[0_0_6px_rgba(255,255,255,0.8)]",
                          )}
                        />
                      </div>
                    );
                  })}
                  {/* 橫線：縱向拖動 */}
                  {splitYs.map((y, i) => {
                    const isSelected = selectedLine?.axis === "y" && selectedLine.index === i;
                    return (
                      <div
                        key={`y-${i}`}
                        className="group absolute inset-x-0 h-3 -translate-y-1/2 cursor-ns-resize"
                        style={{ top: y * display.scale, touchAction: "none" }}
                        onPointerDown={(e) => startLineDrag(e, "y", i)}
                        onPointerMove={moveLineDrag}
                        onPointerUp={endLineDrag}
                        onPointerCancel={endLineDrag}
                      >
                        <div
                          className={cn(
                            "absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 transition-colors",
                            isSelected
                              ? "bg-ios-blue shadow-[0_0_8px_rgba(0,122,255,0.9)]"
                              : "bg-white/75 group-hover:bg-white group-hover:shadow-[0_0_6px_rgba(255,255,255,0.8)]",
                          )}
                        />
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 抠除塗抹層 */}
              {activeMode === "mask" && (
                <canvas
                  ref={maskDisplayRef}
                  className="absolute cursor-crosshair"
                  style={{ left: display.left, top: display.top, width: display.width, height: display.height, touchAction: "none" }}
                  onPointerDown={onMaskPointerDown}
                  onPointerMove={onMaskPointerMove}
                  onPointerUp={onMaskPointerUp}
                  onPointerCancel={onMaskPointerUp}
                />
              )}
            </>
          )}
        </div>

        {/* 模式參數列 */}
        <div className="border-t px-4 py-2.5">
          {activeMode === "crop" && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-ios-caption1 text-foreground/45">比例</span>
              {ASPECT_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyAspect(p.ratio)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-ios-caption1 font-medium transition-colors",
                    aspect === p.ratio ? "bg-primary text-primary-foreground" : "bg-black/5 text-muted-foreground hover:bg-black/10",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
          {activeMode === "split" && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              {([
                ["行", splitYs.length + 1, "y"],
                ["列", splitXs.length + 1, "x"],
              ] as const).map(([label, current, axis]) => (
                <div key={label} className="flex items-center gap-1.5">
                  <span className="text-ios-caption1 text-foreground/45">{label}</span>
                  {[1, 2, 3, 4].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => applySplitQuick(axis, n)}
                      className={cn(
                        "h-7 w-7 rounded-md text-[12.5px] font-medium transition-colors",
                        current === n ? "bg-primary text-primary-foreground" : "bg-black/5 text-muted-foreground hover:bg-black/10",
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              ))}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => addSplitLine("x")}
                  disabled={vSpot === null}
                  className="rounded-full bg-black/5 px-2.5 py-1 text-ios-caption1 font-medium text-muted-foreground transition-colors hover:bg-black/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-black/5"
                >
                  + 竖线
                </button>
                <button
                  type="button"
                  onClick={() => addSplitLine("y")}
                  disabled={hSpot === null}
                  className="rounded-full bg-black/5 px-2.5 py-1 text-ios-caption1 font-medium text-muted-foreground transition-colors hover:bg-black/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-black/5"
                >
                  + 横线
                </button>
                <button
                  type="button"
                  onClick={deleteSelectedLine}
                  disabled={!selectedLine}
                  className="rounded-full bg-black/5 px-2.5 py-1 text-ios-caption1 font-medium text-muted-foreground transition-colors hover:bg-black/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-black/5"
                >
                  删除此线
                </button>
              </div>
              <span className="text-ios-caption1 text-foreground/45">共 {splitCount} 张 · 可拖动分割线，选中后按 Del 删除</span>
            </div>
          )}
          {activeMode === "mask" && (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-ios-caption1 text-foreground/45">
                笔刷
                <input
                  type="range"
                  min={8}
                  max={64}
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                  className="w-28"
                />
                <span className="w-6 tabular-nums text-muted-foreground">{brushSize}</span>
              </label>
              <button
                type="button"
                onClick={() => setEraserMode((v) => !v)}
                aria-pressed={eraserMode}
                className={cn(
                  "rounded-full px-2.5 py-1 text-ios-caption1 font-medium transition-colors",
                  eraserMode ? "bg-primary text-primary-foreground" : "bg-black/5 text-muted-foreground hover:bg-black/10",
                )}
              >
                橡皮擦
              </button>
              <button
                type="button"
                onClick={clearMask}
                className="rounded-full bg-black/5 px-2.5 py-1 text-ios-caption1 font-medium text-muted-foreground hover:bg-black/10"
              >
                清除全部
              </button>
              {onRequestInpaint && (
                <div className="flex items-center gap-0.5 rounded-lg bg-black/5 p-0.5">
                  {([
                    ["erase", "抠除(透明)"],
                    ["inpaint", "AI 重绘(实验)"],
                  ] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setMaskOutput(id)}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-ios-caption1 font-medium transition-colors",
                        effectiveMaskOutput === id ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {effectiveMaskOutput === "inpaint" ? (
                <input
                  type="text"
                  value={inpaintInstruction}
                  onChange={(e) => setInpaintInstruction(e.target.value)}
                  placeholder="把涂抹区域改成什么…"
                  className="h-8 min-w-44 flex-1 rounded-lg border border-input bg-white px-2.5 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ios-blue"
                />
              ) : (
                <span className="text-ios-caption1 text-foreground/45">涂抹区域将变为透明</span>
              )}
            </div>
          )}
          {activeMode === "rotate" && (
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setDeg((d) => (d + 270) % 360)} className="flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground hover:bg-black/10">
                <RotateCcw className="h-3.5 w-3.5" /> 左转 90°
              </button>
              <button type="button" onClick={() => setDeg((d) => (d + 90) % 360)} className="flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground hover:bg-black/10">
                <RotateCw className="h-3.5 w-3.5" /> 右转 90°
              </button>
              <button type="button" onClick={() => setFlipH((v) => !v)} aria-pressed={flipH} className={cn("flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium", flipH ? "bg-primary text-primary-foreground" : "bg-black/5 text-muted-foreground hover:bg-black/10")}>
                <FlipHorizontal2 className="h-3.5 w-3.5" /> 水平翻转
              </button>
              <button type="button" onClick={() => setFlipV((v) => !v)} aria-pressed={flipV} className={cn("flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium", flipV ? "bg-primary text-primary-foreground" : "bg-black/5 text-muted-foreground hover:bg-black/10")}>
                <FlipVertical2 className="h-3.5 w-3.5" /> 垂直翻转
              </button>
              <span className="text-ios-caption1 tabular-nums text-foreground/45">当前 {deg}°</span>
            </div>
          )}
          {activeMode === "angle" && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
              <label className="flex items-center gap-2 text-ios-caption1 text-foreground/45">
                水平旋转
                <input
                  type="range"
                  min={-60}
                  max={60}
                  step={1}
                  value={yawDeg}
                  onChange={(e) => setYawDeg(Number(e.target.value))}
                  className="w-32"
                />
                <span className="w-9 text-right tabular-nums text-muted-foreground">{yawDeg}°</span>
              </label>
              <label className="flex items-center gap-2 text-ios-caption1 text-foreground/45">
                俯仰
                <input
                  type="range"
                  min={-45}
                  max={45}
                  step={1}
                  value={pitchDeg}
                  onChange={(e) => setPitchDeg(Number(e.target.value))}
                  className="w-28"
                />
                <span className="w-9 text-right tabular-nums text-muted-foreground">{pitchDeg}°</span>
              </label>
              <label className="flex items-center gap-2 text-ios-caption1 text-foreground/45">
                距离
                <input
                  type="range"
                  min={0.6}
                  max={1.6}
                  step={0.05}
                  value={distance}
                  onChange={(e) => setDistance(Number(e.target.value))}
                  className="w-28"
                />
                <span className="w-10 text-right tabular-nums text-muted-foreground">{distance.toFixed(2)}x</span>
              </label>
              <button
                type="button"
                onClick={() => {
                  setYawDeg(0);
                  setPitchDeg(0);
                  setDistance(1);
                }}
                className="rounded-full bg-black/5 px-2.5 py-1 text-ios-caption1 font-medium text-muted-foreground hover:bg-black/10"
              >
                复位
              </button>
              <span className="basis-full text-ios-caption1 text-foreground/45">预览为示意，确认后由 AI 按角度重绘生成新图</span>
            </div>
          )}
        </div>

        {/* 底部按鈕 */}
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-[13.5px] font-medium text-muted-foreground hover:bg-black/5"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!bmp || busy || (activeMode === "mask" && effectiveMaskOutput === "inpaint" && inpaintInstruction.trim() === "")}
            className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-[13.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
            {activeMode === "split"
              ? `生成 ${splitCount} 张`
              : activeMode === "angle"
                ? "AI 生成"
                : activeMode === "mask" && effectiveMaskOutput === "inpaint"
                  ? "AI 重绘"
                  : "确认"}
          </button>
        </div>
      </div>
    </div>
  );
}
