"use client";

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ImagePlus, Images, Loader2, Plus, X } from "lucide-react";
import { useDropzone } from "react-dropzone";
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
    const [isExpanded, setIsExpanded] = useState(false);
    const [activePreview, setActivePreview] = useState<ReferenceImage | null>(null);
    const [pendingCount, setPendingCount] = useState(0);
    const valueRef = useRef(value);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (!activePreview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActivePreview(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [activePreview]);

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
    setIsExpanded(true);
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
          return {
            id: createReferenceId(imageFile),
            name: file.name,
            file: imageFile,
            previewUrl: URL.createObjectURL(imageFile),
            size: imageFile.size,
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
    if (activePreview?.id === id) setActivePreview(null);
    onChange(value.filter((image) => image.id !== id));
  };

  const previewCount = value.length + pendingCount;
  const promptGridColumns = previewCount === 1 ? "grid-cols-1" : previewCount === 2 ? "grid-cols-2" : "grid-cols-3";

  if (variant === "prompt") {
    return (
      <div className="absolute inset-x-3 bottom-3 z-20 flex min-w-0 max-w-full items-center gap-2 overflow-visible">
        {isExpanded && (value.length > 0 || pendingCount > 0) && (
          <div className="absolute -bottom-3 inset-x-0 w-auto max-w-[22rem] max-h-[min(46dvh,16rem)] overflow-y-auto overscroll-contain rounded-ios-2xl bg-white/95 p-3 shadow-[0_18px_50px_rgba(31,35,48,0.18)] backdrop-blur-xl [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="sticky top-0 z-10 -mx-3 -mt-3 mb-2 flex items-center justify-between bg-[rgba(255,255,255,0.92)] px-4 py-3 backdrop-blur-xl">
              <span className="text-ios-caption1 font-semibold text-black/60">参考图 {previewCount}/{MAX_REFERENCE_IMAGES}</span>
              <button type="button" onClick={() => setIsExpanded(false)} title="收起预览" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-black/45 transition-colors hover:bg-black/[0.08] hover:text-black/70"><X className="h-3.5 w-3.5" /></button>
            </div>
            <div className={cn("grid gap-2", promptGridColumns)}>
              {value.map((image) => (
                <div key={image.id} className={cn("group relative overflow-hidden rounded-ios-xl bg-black/5", previewCount === 1 ? "aspect-video" : "aspect-square")}>
                  <button type="button" onClick={() => setActivePreview(image)} className="h-full w-full" title={`预览 ${image.name}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={image.previewUrl} alt={image.name} className="h-full w-full object-cover" />
                  </button>
                  <button type="button" onClick={() => removeImage(image.id)} aria-label="移除参考图" className="absolute -right-1 -top-1 flex min-h-11 min-w-11 items-start justify-end p-1.5 text-white opacity-100 sm:opacity-0 sm:group-hover:opacity-100"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-black/60"><X className="h-3 w-3" /></span></button>
                </div>
              ))}
              {Array.from({ length: pendingCount }).map((_, index) => (
                <div key={`pending-${index}`} role="status" className={cn("relative overflow-hidden rounded-ios-xl bg-black/[0.045]", previewCount === 1 ? "aspect-video" : "aspect-square")}>
                  <div className="absolute inset-0 animate-pulse bg-black/[0.045]" />
                  <Loader2 className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 animate-spin text-black/30" />
                </div>
              ))}
            </div>
          </div>
        )}

        <div {...getRootProps()} className="flex h-11 w-11 shrink-0 items-center justify-center">
          <input {...getInputProps()} />
          <button
            type="button"
            disabled={isProcessing || value.length >= MAX_REFERENCE_IMAGES}
            aria-label="上传参考图"
            title="上传参考图"
            className="flex min-h-11 min-w-11 items-center justify-center text-black/55 transition-colors hover:text-black disabled:opacity-40"
          >
            <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-white/85 shadow-[0_2px_10px_rgba(0,0,0,0.10)] transition-colors hover:bg-white">
              {isProcessing ? <Loader2 className="h-2 w-2 animate-spin" /> : <Plus className="h-2 w-2" />}
            </span>
          </button>
        </div>

        {value.length > 0 && (
          <button
            type="button"
            onClick={() => setIsExpanded((current) => !current)}
            aria-label="展开参考图预览"
            title="展开参考图预览"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-white/85 px-3 text-ios-caption1 font-semibold text-black/55 shadow-[0_2px_10px_rgba(0,0,0,0.10)] hover:bg-white hover:text-black"
          >
            <Images className="h-3.5 w-3.5" />{value.length}
          </button>
        )}

        {activePreview && (
          <div role="dialog" aria-modal="true" aria-label="参考图大图预览" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-5" onClick={() => setActivePreview(null)}>
            <button type="button" title="关闭预览" className="absolute right-5 top-5 flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"><X className="h-5 w-5" /></button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={activePreview.previewUrl} alt={activePreview.name} className="max-h-[88vh] max-w-[92vw] object-contain" onClick={(event) => event.stopPropagation()} />
          </div>
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
