"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { Check, Copy, ImagePlus, Loader2, X } from "lucide-react";
import { generationCoins } from "@/lib/generation-model-catalog";
import { PIXAI_EDIT_MODEL_ID } from "@/lib/image-model-ids.js";
import { imageHelpers } from "@/lib/image-helpers";
import { cn } from "@/lib/utils";
import type { PickedImage } from "@/components/pixai-tools/PixaiSourceInput";
import { PIXAI_RATIO_CHIPS, pickSourceFile, type PixaiRatioKey, type PixaiStage } from "@/components/prompt-input/use-pixai-tools-panel";
import { LABEL_CLASS, RAIL_CLASS, ROW_CLASS } from "@/components/prompt-input/rail-classes";

interface EditPanelProps {
  editSource: PickedImage | null;
  setEditSource: Dispatch<SetStateAction<PickedImage | null>>;
  editRatio: PixaiRatioKey;
  setEditRatio: Dispatch<SetStateAction<PixaiRatioKey>>;
  editStage: PixaiStage;
  setEditStage: Dispatch<SetStateAction<PixaiStage>>;
  editError: string;
  setEditError: Dispatch<SetStateAction<string>>;
  editResultUrl: string;
  setEditResultUrl: Dispatch<SetStateAction<string>>;
}

/**
 * 改图面（Task 6 自 PromptInput 抽出）：原图胶囊 + 比例 chips + 价格/错误/结果行。
 * 状态全留父层 usePixaiEdit（模式切换只换控件区、状态保留），本组件纯 props 驱动。
 */
export function EditPanel({
  editSource,
  setEditSource,
  editRatio,
  setEditRatio,
  editStage,
  setEditStage,
  editError,
  setEditError,
  editResultUrl,
  setEditResultUrl,
}: EditPanelProps) {
  // 下载要等整图 fetch 成 blob，转圈期间按钮禁点（瞬态 UI 态，不进父层）。
  const [downloadBusy, setDownloadBusy] = useState(false);
  // 复制同链路 fetch 整图，照抄 downloadBusy 的中间态模式。
  const [copyBusy, setCopyBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFallbackNotice, setCopyFallbackNotice] = useState(false);

  const handleCopy = () => {
    if (copyBusy) return;
    setCopyBusy(true);
    imageHelpers
      .copyToClipboard(editResultUrl)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch((error) => {
        console.error("Failed to copy image:", error);
        // 浏览器不支持/拒绝剪贴板写图片 → 自动退回下载，不让用户空手。
        return imageHelpers
          .download(editResultUrl, "edit")
          .then(() => {
            setCopyFallbackNotice(true);
            setTimeout(() => setCopyFallbackNotice(false), 2500);
          })
          .catch((downloadError) => console.error("Failed to download image:", downloadError));
      })
      .finally(() => setCopyBusy(false));
  };
  return (
            <div className="space-y-2.5 pt-1">
              {/* 原图：胶囊即上传入口，选中后变为缩略图胶囊，可移除 */}
              <div className={ROW_CLASS}>
                <span className={LABEL_CLASS}>原图</span>
                <div className={RAIL_CLASS}>
                  {editSource ? (
                    <span className="style-chip gap-1.5 pr-1">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={editSource.previewUrl} alt="" className="h-5 w-5 shrink-0 rounded-md object-cover" />
                      <span className="max-w-[120px] truncate">{editSource.label}</span>
                      <button
                        type="button"
                        onClick={() => { setEditSource(null); setEditResultUrl(""); setEditError(""); setEditStage("idle"); }}
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
                            setEditSource(image);
                            setEditResultUrl("");
                            setEditError("");
                            setEditStage("idle");
                          });
                        }}
                      />
                    </label>
                  )}
                </div>
              </div>

              <div className={ROW_CLASS}>
                <span className={LABEL_CLASS}>比例</span>
                <div className={RAIL_CLASS}>
                  {PIXAI_RATIO_CHIPS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setEditRatio(key)}
                      className={cn("style-chip", editRatio === key && "active")}
                    >
                      {key === "original" ? "跟随原图" : key}
                    </button>
                  ))}
                </div>
              </div>

              <p className="text-ios-footnote text-[rgba(0,0,0,0.46)]">
                改图 {generationCoins(PIXAI_EDIT_MODEL_ID, { resolution: "1k" })} 币起（按解析度浮动）
              </p>

              {editStage === "error" && editError && (
                <p className="text-ios-footnote text-[#FF3B30]">{editError}</p>
              )}

              {editStage === "done" && editResultUrl && (
                <div className="flex items-center gap-2 rounded-ios-2xl border border-[rgba(0,0,0,0.08)] p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={editResultUrl} alt="改图结果" className="h-10 w-10 shrink-0 rounded-ios-md object-cover" />
                  <span className="min-w-0 flex-1 truncate text-ios-footnote text-[rgba(0,0,0,0.55)]">
                    {copyFallbackNotice ? "当前浏览器不支持复制，已为你下载" : "改图完成"}
                  </span>
                  <button
                    type="button"
                    disabled={copyBusy}
                    onClick={handleCopy}
                    className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-[rgba(0,0,0,0.05)] px-3 text-ios-footnote font-medium text-[rgba(0,0,0,0.65)] hover:bg-[rgba(0,0,0,0.09)] disabled:cursor-not-allowed disabled:opacity-60"
                    aria-label="复制图片"
                  >
                    {copyBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    复制
                  </button>
                  <button
                    type="button"
                    disabled={downloadBusy}
                    onClick={() => {
                      if (downloadBusy) return;
                      setDownloadBusy(true);
                      imageHelpers
                        .download(editResultUrl, "edit")
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
