"use client";

import { useCallback, useEffect, useState } from "react";
import { useDropzone } from "react-dropzone";
import { ImagePlus } from "lucide-react";
import { useHistoryStore } from "@/hooks/use-history";
import { PIXAI_MAX_BYTES, PIXAI_MIN_BYTES, type PixaiImageSource } from "./shared";
import { cn } from "@/lib/utils";

export interface PickedImage {
  /** 生成时需要的图片来源描述。 */
  source: PixaiImageSource;
  /** 本地/远程预览 url。上传文件是 URL.createObjectURL，历史图是原 url。 */
  previewUrl: string;
  label: string;
}

interface PixaiSourceInputProps {
  value: PickedImage | null;
  onChange: (image: PickedImage | null) => void;
}

/**
 * 图片来源选择器：拖拽/点击上传本地图片，或从最近历史（最多 20 张）挑一张。
 * 只做本地预览（URL.createObjectURL），真正上传留给「生成」时调 /v1/uploads。
 */
export function PixaiSourceInput({ value, onChange }: PixaiSourceInputProps) {
  const history = useHistoryStore();
  const [historyImages, setHistoryImages] = useState<PickedImage[]>([]);

  useEffect(() => {
    const withImage = history.entries.flatMap((entry) => entry.results).filter((r) => r.image || r.imageUrl);
    const seen = new Set<string>();
    const unique = withImage
      .map((r) => {
        const url = (r.imageUrl ?? r.image) as string;
        const kind: PixaiImageSource["kind"] = url.startsWith("data:") ? "dataUrl" : "httpUrl";
        return {
          source: { kind, url } as PixaiImageSource,
          previewUrl: url,
          label: "历史图",
        };
      })
      .filter((i) => {
        if (seen.has(i.previewUrl)) return false;
        seen.add(i.previewUrl);
        return true;
      })
      .slice(0, 20);
    setHistoryImages(unique);
  }, [history.entries]);

  const onDrop = useCallback(
    (files: File[]) => {
      const file = files[0];
      if (!file) return;
      if (file.size > PIXAI_MAX_BYTES) {
        alert("图片不能超过 20MB");
        return;
      }
      if (file.size < PIXAI_MIN_BYTES) {
        alert("图片过小（需大于 4KB）");
        return;
      }
      onChange({
        source: { kind: "file", file, mimeType: file.type || "image/png" },
        previewUrl: URL.createObjectURL(file),
        label: file.name,
      });
    },
    [onChange],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "image/*": [] },
    multiple: false,
    maxSize: PIXAI_MAX_BYTES + 1,
  });

  return (
    <div className="space-y-2">
      <div
        {...getRootProps()}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-ios-2xl border border-dashed border-[rgba(0,0,0,0.16)] bg-[rgba(0,0,0,0.03)] px-4 py-6 text-center transition-colors",
          isDragActive && "border-[#007AFF] bg-[rgba(0,122,255,0.06)]",
        )}
      >
        <input {...getInputProps()} />
        <ImagePlus className="h-5 w-5 text-[rgba(0,0,0,0.50)]" />
        <p className="text-ios-footnote text-[rgba(0,0,0,0.58)]">{isDragActive ? "松开以选择图片" : "拖入图片，或点击选择"}</p>
        <p className="text-ios-caption1 text-[rgba(0,0,0,0.44)]">支持 4KB – 20MB</p>
      </div>

      {historyImages.length > 0 && (
        <div>
          <p className="mb-1.5 text-ios-caption1 text-[rgba(0,0,0,0.46)]">从最近历史选择</p>
          <div className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {historyImages.map((img, idx) => {
              const active = value != null && value.previewUrl === img.previewUrl;
              return (
                <button
                  key={`${img.previewUrl}-${idx}`}
                  type="button"
                  onClick={() => onChange({ ...img })}
                  className={cn(
                    "relative h-14 w-14 shrink-0 overflow-hidden rounded-ios-md border transition-all",
                    active
                      ? "border-[#007AFF] ring-2 ring-[rgba(0,122,255,0.30)]"
                      : "border-[rgba(0,0,0,0.08)] hover:border-[rgba(0,0,0,0.20)]",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.previewUrl} alt="历史图" className="h-full w-full object-cover" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}