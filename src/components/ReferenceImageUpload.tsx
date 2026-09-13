"use client";

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { useDropzone } from "react-dropzone";
import { ImageLightbox } from "@/components/ImageLightbox";
import type { ReferenceImage } from "@/lib/image-types";
import { cn } from "@/lib/utils";
import { extractWorkflowFromPng } from "@/lib/workflow-png";

export const MAX_REFERENCE_IMAGES = 6;

/** 暴露给外部的句柄，用于 PromptInput 从容器拖拽/粘贴直接喂文件。 */
export interface ReferenceImageUploadHandle {
  acceptFiles: (files: File[]) => Promise<void>;
}

interface ReferenceImageUploadProps {
  value: ReferenceImage[];
  onChange: (images: ReferenceImage[]) => void;
  compact?: boolean;
  variant?: "panel" | "prompt";
  /** 拖入的 PNG 內嵌工作流時回傳其中 JSON，讓父層走還原路徑而非當參考圖。 */
  onWorkflowDetected?: (workflowJson: string) => void;
}

function createReferenceId(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`;
}

/** 讀取 blob URL 的自然尺寸（為「跟隨參考圖比例」鋪樁）；載入失敗回 null 不阻塞入列。 */
function measureNaturalSize(url: string): Promise<{ naturalWidth: number; naturalHeight: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * memo 是必需的，不是优化余量：专业工作站在同一棵树里同时挂了两份
 * （画面描述区的 variant="prompt" 与素材面板的 compact），父组件每次 render
 * 都会让两份各自重跑一次 useDropzone()。props（value / onChange）本来就是
 * 稳定引用，浅比较能直接命中。
 */
export const ReferenceImageUpload = memo(
  forwardRef<ReferenceImageUploadHandle, ReferenceImageUploadProps>(function ReferenceImageUpload(
    { value, onChange, compact, variant = "panel", onWorkflowDetected },
    ref,
  ) {
    const [isProcessing, setIsProcessing] = useState(false);
    /** 缩图点击 → ImageLightbox 全屏灯箱（与生成图「点一下放大」同一组件）。 */
    const [lightboxImage, setLightboxImage] = useState<ReferenceImage | null>(null);
    const [pendingCount, setPendingCount] = useState(0);
    const valueRef = useRef(value);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const onDrop = useCallback(async (files: File[]) => {
    if (!files.length) return;
    const remainingSlots = Math.max(0, MAX_REFERENCE_IMAGES - valueRef.current.length);
    const selectedFiles = files.slice(0, remainingSlots);
    if (!selectedFiles.length) return;

    // 先探測 PNG 是否內嵌工作流：命中就走還原路徑，該檔不再當參考圖；其餘檔照舊。
    let detectedWorkflow: string | null = null;
    const referenceCandidates: File[] = [];
    for (const file of selectedFiles) {
      const isPng = file.type === "image/png" || file.name.toLowerCase().endsWith(".png");
      if (isPng) {
        try {
          const workflow = extractWorkflowFromPng(new Uint8Array(await file.arrayBuffer()));
          if (workflow) {
            detectedWorkflow ??= workflow;
            continue;
          }
        } catch {
          // 壞 PNG 就當普通圖處理
        }
      }
      referenceCandidates.push(file);
    }
    if (detectedWorkflow) {
      onWorkflowDetected?.(detectedWorkflow);
      if (referenceCandidates.length === 0) return;
    }

    setPendingCount(referenceCandidates.length);
    setIsProcessing(true);
    try {
      const { default: imageCompression } = await import("browser-image-compression");
      const processed = await Promise.all(
        referenceCandidates.map(async (file) => {
          const compressed = await imageCompression(file, {
            maxSizeMB: 1.1,
            maxWidthOrHeight: 1600,
            useWebWorker: true,
          });
          const imageFile = compressed instanceof File
            ? compressed
            : new File([compressed], file.name, { type: file.type || "image/png" });
          // 先建 blob URL 再異步測量自然尺寸；測量在 pending 骨架期間進行，不阻塞入列。
          const previewUrl = URL.createObjectURL(imageFile);
          const naturalSize = await measureNaturalSize(previewUrl);
          return {
            id: createReferenceId(imageFile),
            name: file.name,
            file: imageFile,
            previewUrl,
            size: imageFile.size,
            ...(naturalSize ?? {}),
          };
        }),
      );
      onChange([...valueRef.current, ...processed]);
    } finally {
      setPendingCount(0);
      setIsProcessing(false);
    }
  }, [onChange, onWorkflowDetected]);

  // 暴露给外部：PromptInput 的容器拖拽 / Ctrl+V 粘贴拿到文件后，
  // 走同一条处理管道（工作流探测 + 压缩 + 入列），而不是另起一套逻辑。
  useImperativeHandle(ref, () => ({ acceptFiles: onDrop }), [onDrop]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { "image/*": [] },
    multiple: true,
    maxFiles: MAX_REFERENCE_IMAGES,
    disabled: isProcessing || value.length >= MAX_REFERENCE_IMAGES,
    onDrop,
  });

  const removeImage = (id: string) => {
    const target = value.find((image) => image.id === id);
    if (target) URL.revokeObjectURL(target.previewUrl);
    if (lightboxImage?.id === id) setLightboxImage(null);
    onChange(value.filter((image) => image.id !== id));
  };

  if (variant === "prompt") {
    return (
      <div className="absolute bottom-3 left-3 z-20 flex min-w-0 max-w-[calc(100%-64px)] items-center gap-2 overflow-visible">
        <div {...getRootProps()} className="flex shrink-0 items-center justify-center">
          <input {...getInputProps()} />
          {/* 樣式對齊 AI 助理 composer 的附件鈕（AgentComposer）：同一顆藍底圓鈕語法。 */}
          <button
            type="button"
            disabled={isProcessing || value.length >= MAX_REFERENCE_IMAGES}
            aria-label="上传参考图"
            title="上传参考图"
            className={cn(
              "flex h-11 w-11 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-full",
              "bg-ios-blue/10 text-ios-blue transition-colors",
              "touch-manipulation [-webkit-tap-highlight-color:transparent]",
              "hover:bg-ios-blue/[0.16] active:bg-ios-blue/[0.22] focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30",
              "disabled:cursor-not-allowed disabled:bg-transparent disabled:text-foreground/45",
            )}
          >
            {isProcessing ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <ImagePlus className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>

        {/* 內聯縮圖（Gemini 式）：上傳鈕＋縮圖列是唯一語義，點縮圖開全屏燈箱。 */}
        {(value.length > 0 || pendingCount > 0) && (
          <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {/* rounded-ios-md 圓角方＝內容語言（對齊 AgentComposer 附件縮圖
                h-16 rounded-ios-md），不竄用動作鈕的圓形語言。 */}
            {value.map((image) => (
              <div key={image.id} className="group relative h-12 w-12 shrink-0 overflow-hidden rounded-ios-md bg-black/5">
                <button type="button" onClick={() => setLightboxImage(image)} className="h-full w-full" title={`预览 ${image.name}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {/* 單張 object-contain＋淺底保留原比例認知；多張（≥2）object-cover 方格。 */}
                  <img src={image.previewUrl} alt={image.name} className={cn("h-full w-full", value.length >= 2 ? "object-cover" : "object-contain")} />
                </button>
                <button type="button" onClick={() => removeImage(image.id)} aria-label="移除参考图" className="absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {Array.from({ length: pendingCount }).map((_, index) => (
              <div key={`pending-inline-${index}`} role="status" className="relative h-12 w-12 shrink-0 overflow-hidden rounded-ios-md bg-black/[0.045]">
                <div className="absolute inset-0 animate-pulse bg-black/[0.045]" />
                <Loader2 className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 animate-spin text-black/30" />
              </div>
            ))}
          </div>
        )}

        {lightboxImage && (
          <ImageLightbox
            src={lightboxImage.previewUrl}
            alt={lightboxImage.name}
            onClose={() => setLightboxImage(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div className={cn("box-border w-full min-w-0 max-w-full overflow-hidden space-y-3", compact && "space-y-2")}>
      <div
        {...getRootProps()}
        className={cn(
          "group box-border flex w-full min-w-0 max-w-full cursor-pointer items-center gap-3 overflow-hidden rounded-ios-2xl border border-dashed border-[rgba(0,0,0,0.10)] bg-[rgba(255,255,255,0.44)] px-4 py-3 text-left transition-all duration-200 backdrop-blur-[28px]",
          "hover:border-[rgba(0,122,255,0.28)] hover:bg-[rgba(0,122,255,0.06)]",
          isDragActive && "border-[rgba(0,122,255,0.46)] bg-[rgba(0,122,255,0.10)]",
          value.length >= MAX_REFERENCE_IMAGES && "cursor-default opacity-64",
        )}
      >
        <input {...getInputProps()} />
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-ios-xl bg-[rgba(255,255,255,0.62)] text-[rgba(0,122,255,0.82)] shadow-[inset_0_1px_0_rgba(255,255,255,0.84)]">
          {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">
            {value.length ? `参考图 ${value.length}/${MAX_REFERENCE_IMAGES}` : "添加参考图"}
          </p>
          <p className="truncate text-ios-caption1 text-[rgba(0,0,0,0.58)]">
            支持多张图片，生成前会自动压缩。
          </p>
        </div>
      </div>

      {value.length > 0 && !compact && (
        <div className="grid w-full min-w-0 max-w-full grid-cols-3 gap-2 overflow-hidden sm:grid-cols-6">
              {value.map((image) => (
            <div key={image.id} className="group relative aspect-square overflow-hidden rounded-ios-xl bg-[rgba(255,255,255,0.46)] shadow-[0_8px_24px_rgba(45,49,66,0.06)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.previewUrl} alt={image.name} className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => removeImage(image.id)}
                className="absolute -right-1 -top-1 flex min-h-11 min-w-11 items-start justify-end p-1.5 text-white opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
                aria-label="移除参考图"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[rgba(0,0,0,0.52)]"><X className="h-3.5 w-3.5" /></span>
              </button>
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[rgba(0,0,0,0.52)] to-transparent p-1.5">
                <p className="truncate text-[10px] font-medium text-white/90">{image.name}</p>
              </div>
                </div>
              ))}
        </div>
      )}
    </div>
  );
  }),
);
