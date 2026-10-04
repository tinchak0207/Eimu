"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { generationCoins, resolutionFromImageSize } from "@/lib/generation-model-catalog";
import { PIXAI_UPSCALE_MODEL_ID } from "@/lib/image-model-ids.js";
import { imageHelpers } from "@/lib/image-helpers";
import type { PickedImage } from "@/components/pixai-tools/shared";
import { pickSourceFile, type PixaiStage } from "@/components/prompt-input/use-pixai-tools-panel";
import { LABEL_CLASS, RAIL_CLASS, ROW_CLASS } from "@/components/prompt-input/rail-classes";

interface UpscalePanelProps {
  upscaleSource: PickedImage | null;
  setUpscaleSource: Dispatch<SetStateAction<PickedImage | null>>;
  upscaleSourceSize: { width: number; height: number } | null;
  setUpscaleSourceSize: Dispatch<SetStateAction<{ width: number; height: number } | null>>;
  upscaleStage: PixaiStage;
  setUpscaleStage: Dispatch<SetStateAction<PixaiStage>>;
  upscaleError: string;
  setUpscaleError: Dispatch<SetStateAction<string>>;
  upscaleResultUrl: string;
  setUpscaleResultUrl: Dispatch<SetStateAction<string>>;
}

/**
 * 放大面（Task 6 自 PromptInput 抽出）：原图胶囊（onLoad 回填原始尺寸供计价）+
 * 固定 2× chip + 价格/错误/结果行。状态全留父层 usePixaiUpscale，纯 props 驱动。
 */
export function UpscalePanel({
  upscaleSource,
  setUpscaleSource,
  upscaleSourceSize,
  setUpscaleSourceSize,
  upscaleStage,
  setUpscaleStage,
  upscaleError,
  setUpscaleError,
  upscaleResultUrl,
  setUpscaleResultUrl,
}: UpscalePanelProps) {
  // 下载要等整图 fetch 成 blob，转圈期间按钮禁点（瞬态 UI 态，不进父层）。
  const [downloadBusy, setDownloadBusy] = useState(false);
  return (
            <div className="space-y-2.5 pt-1">
              <div className={ROW_CLASS}>
                <span className={LABEL_CLASS}>原图</span>
                <div className={RAIL_CLASS}>
                  {upscaleSource ? (
                    <span className="style-chip gap-1.5 pr-1">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={upscaleSource.previewUrl}
                        alt=""
                        className="h-5 w-5 shrink-0 rounded-md object-cover"
                        onLoad={(e) => {
                          const el = e.currentTarget;
                          if (el.naturalWidth && el.naturalHeight) {
                            setUpscaleSourceSize({ width: el.naturalWidth, height: el.naturalHeight });
                          }
                        }}
                      />
                      <span className="max-w-[120px] truncate">{upscaleSource.label}</span>
                      <button
                        type="button"
                        onClick={() => { setUpscaleSource(null); setUpscaleSourceSize(null); setUpscaleResultUrl(""); setUpscaleError(""); setUpscaleStage("idle"); }}
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full lg-transition hover:bg-[rgba(0,0,0,0.08)] cursor-pointer"
                        aria-label="移除原图"
                        title="移除原图"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ) : (
                    <label className="style-chip cursor-pointer gap-1.5">
                      <ImagePlus className="h-3.5 w-3.5" />
                      上传原图
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          pickSourceFile(e, (image) => {
                            setUpscaleSource(image);
                            setUpscaleResultUrl("");
                            setUpscaleError("");
                            setUpscaleStage("idle");
                          });
                        }}
                      />
                    </label>
                  )}
                </div>
              </div>

              <div className={ROW_CLASS}>
                <span className={LABEL_CLASS}>倍數</span>
                <div className={RAIL_CLASS}>
                  <span className="style-chip active">2×</span>
                </div>
              </div>

              <p className="text-ios-footnote text-[rgba(0,0,0,0.46)]">
                固定 2 倍放大 · 价格{" "}
                {generationCoins(PIXAI_UPSCALE_MODEL_ID, {
                  resolution: upscaleSourceSize
                    ? resolutionFromImageSize(`${upscaleSourceSize.width}x${upscaleSourceSize.height}`)
                    : "1k",
                })}{" "}
                币{upscaleSourceSize ? "（按解析度浮动）" : "起（按解析度浮动）"}
              </p>

              {upscaleStage === "error" && upscaleError && (
                <p className="text-ios-footnote text-[#FF3B30]">{upscaleError}</p>
              )}

              {upscaleStage === "done" && upscaleResultUrl && (
                <div className="flex items-center gap-2 rounded-ios-2xl border border-[rgba(0,0,0,0.08)] p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={upscaleResultUrl} alt="放大结果" className="h-10 w-10 shrink-0 rounded-ios-md object-cover" />
                  <span className="min-w-0 flex-1 truncate text-ios-footnote text-[rgba(0,0,0,0.55)]">放大完成</span>
                  <button
                    type="button"
                    disabled={downloadBusy}
                    onClick={() => {
                      if (downloadBusy) return;
                      setDownloadBusy(true);
                      imageHelpers
                        .download(upscaleResultUrl, "upscale")
                        .catch((error) => console.error("Failed to download image:", error))
                        .finally(() => setDownloadBusy(false));
                    }}
                    className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-[rgba(0,0,0,0.05)] px-3 text-ios-footnote font-medium text-[rgba(0,0,0,0.65)] hover:bg-[rgba(0,0,0,0.09)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {downloadBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    下载
                  </button>
                </div>
              )}
            </div>
  );
}
