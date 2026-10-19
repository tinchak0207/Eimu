import { useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  ImageIcon,
  Loader2,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImageLightbox } from "@/components/ImageLightbox";
import { useResolvedImageSrc } from "@/components/image-src";
import { ParticleSeaWaiting } from "@/components/ParticleSeaWaiting";
import { ProviderTiming } from "@/lib/image-types";
import { imageHelpers } from "@/lib/image-helpers";
import { cn } from "@/lib/utils";

interface ImageDisplayProps {
  provider: string;
  image: string | null | undefined;
  imageUrl?: string | null | undefined;
  videoUrl?: string | null | undefined;
  mediaType?: "image" | "video" | "audio";
  timing?: ProviderTiming;
  failed?: boolean;
  fallbackIcon?: React.ReactNode;
  enabled?: boolean;
  modelId: string;
}

export function ImageDisplay({
  provider,
  image,
  imageUrl,
  videoUrl,
  mediaType = "image",
  timing,
  failed,
  fallbackIcon,
  // modelId kept in interface for API compatibility
}: ImageDisplayProps) {
  const [isZoomed, setIsZoomed] = useState(false);
  // 下载要先整图 fetch 成 blob 才触发浏览器保存，这几秒按钮必须给出中间态，
  // 否则用户感知就是「按了没反应」。
  const [isDownloading, setIsDownloading] = useState(false);
  // 复制同样要先 fetch 整图成 blob（还可能转码 PNG），照抄 isDownloading 的
  // 中间态模式，否则用户感知就是「按了没反应」。
  const [isCopying, setIsCopying] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [copyFallbackNotice, setCopyFallbackNotice] = useState(false);
  const hasVideo = mediaType === "video" && Boolean(videoUrl) && !failed;
  const hasImage = mediaType !== "video" && (Boolean(image) || Boolean(imageUrl)) && !failed;
  const hasMedia = hasImage || hasVideo;
  const isRendering = Boolean(timing?.startTime) && !timing?.elapsed && !failed;
  // 专业模式早就用 WeakMap 解决了同一个问题（见 image-src.ts）；标准模式这里
  // 拿到的是裸 base64 字符串，改用按值 memo，避免每次 render 重做多 MB 拼接。
  const resolvedImageSrc = useResolvedImageSrc(image, imageUrl);

  const handleImageClick = (event: React.MouseEvent) => {
    if (hasImage) {
      event.stopPropagation();
      setIsZoomed(true);
    }
  };

  const handleActionClick = async (
    event: React.MouseEvent,
    imageSource: string,
    providerName: string,
  ) => {
    event.stopPropagation();
    if (isDownloading) return;
    setIsDownloading(true);
    try {
      await imageHelpers.download(imageSource, providerName);
    } catch (error) {
      console.error("Failed to download image:", error);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleCopyClick = async (
    event: React.MouseEvent,
    imageSource: string,
    providerName: string,
  ) => {
    event.stopPropagation();
    if (isCopying) return;
    setIsCopying(true);
    try {
      await imageHelpers.copyToClipboard(imageSource);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1500);
    } catch (error) {
      console.error("Failed to copy image:", error);
      // 浏览器不支持/拒绝剪贴板写图片 → 自动退回下载，不让用户空手。
      try {
        await imageHelpers.download(imageSource, providerName);
        setCopyFallbackNotice(true);
        setTimeout(() => setCopyFallbackNotice(false), 2500);
      } catch (downloadError) {
        console.error("Failed to download image:", downloadError);
      }
    } finally {
      setIsCopying(false);
    }
  };

  return (
    <>
      <div
        className={cn(
          // Same lg-card material and 40px radius as the prompt panel so the two
          // columns read as one pair. From xl up (where the two-column grid
          // kicks in) it stretches to the prompt panel's height instead of
          // locking to a square that ended ~50px short of it.
          "lg-card group relative w-full overflow-hidden rounded-ios-3xl",
          // From xl up it stretches to the prompt panel's height so the two
          // columns bottom-align. Below that it sizes to what it holds: a
          // square once there is an image to show, but a compact band while
          // empty — a full-width square of nothing reads as dead space.
          "xl:aspect-auto xl:h-full xl:min-h-[30rem]",
          hasMedia || isRendering ? "aspect-square" : "min-h-[15rem]",
          hasImage ? "cursor-zoom-in" : "",
        )}
        onClick={handleImageClick}
      >
        {/* fix #15: specular top edge */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-90" aria-hidden="true" />

        {/* Only badge a real outcome. The idle "当前可用" chip floated alone in
            the corner with no counterpart on the prompt panel, and the empty
            state below already says the canvas is waiting. */}
        {!isRendering && (failed || hasMedia) && (
        <div className="absolute inset-x-0 top-0 z-10 flex items-start justify-end gap-3 p-4">

          {/* fix #16: unified iOS tint badges */}
          <div
            className={cn(
              "rounded-full px-3 py-1.5 text-ios-caption1 font-semibold whitespace-nowrap",
              failed
                ? "lg-tint-red text-[#FF3B30]"
                : "bg-[rgba(0,0,0,0.52)] text-white",
            )}
          >
              {failed ? "需要重试" : "已完成"}
          </div>
        </div>
        )}

        {hasVideo && videoUrl ? (
          <>
            <video
              src={videoUrl}
              controls
              playsInline
              className="h-full w-full bg-black object-contain"
            />
            <Button
              size="icon"
              variant="outline"
              className="absolute bottom-4 left-4 h-11 w-11 rounded-full border-[rgba(255,255,255,0.52)] bg-[rgba(255,255,255,0.64)] shadow-[0_14px_30px_rgba(45,49,66,0.08)]"
              onClick={(event) => handleActionClick(event, videoUrl, provider)}
              aria-label="下载视频"
              disabled={isDownloading}
            >
              {isDownloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            </Button>
          </>
        ) : hasImage && resolvedImageSrc ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={resolvedImageSrc ?? undefined}
              alt={`${provider} 生成的图片`}
              // object-contain: 展示实际比例，横图/竖图都不裁切（用户反馈
              // 「图片被压缩」）。留边区域不另铺底色——img 盒子撑满整个容器，
              // 任何填充都会盖掉整张卡的 lg-card 玻璃材质；透出卡片本身的
              // rgba(255,255,255,0.72) 玻璃就是最协调的底色，零新色值。
              className="h-full w-full object-contain transition-transform duration-500 group-hover:scale-[1.018]"
            />
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.16)_0%,transparent_28%,transparent_72%,rgba(45,49,66,0.12)_100%)]" />

            <div className="absolute bottom-4 left-4 flex items-center gap-2">
              <Button
                size="icon"
                variant="outline"
                // /52 and /64 aren't on Tailwind's default opacity scale
                // (multiples of 5), so these silently compiled to nothing —
                // the download button had no border or fill at all.
                className="h-11 w-11 rounded-full border-[rgba(255,255,255,0.52)] bg-[rgba(255,255,255,0.64)] shadow-[0_14px_30px_rgba(45,49,66,0.08)] transition-all duration-200 sm:translate-y-1 sm:opacity-0 sm:group-hover:translate-y-0 sm:group-hover:opacity-100"
                onClick={(event) => handleActionClick(event, resolvedImageSrc, provider)}
                aria-label="下载图片"
                disabled={isDownloading}
              >
                {isDownloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              </Button>
              <Button
                size="icon"
                variant="outline"
                className="h-11 w-11 rounded-full border-[rgba(255,255,255,0.52)] bg-[rgba(255,255,255,0.64)] shadow-[0_14px_30px_rgba(45,49,66,0.08)] transition-all duration-200 sm:translate-y-1 sm:opacity-0 sm:group-hover:translate-y-0 sm:group-hover:opacity-100"
                onClick={(event) => handleCopyClick(event, resolvedImageSrc, provider)}
                aria-label="复制图片"
                disabled={isCopying}
              >
                {isCopying ? <Loader2 className="h-4 w-4 animate-spin" /> : isCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>

            {copyFallbackNotice && (
              <div className="pointer-events-none absolute bottom-20 left-4 rounded-full bg-[rgba(0,0,0,0.52)] px-3 py-1.5 text-[13px] font-medium text-white">
                当前浏览器不支持复制，已为你下载
              </div>
            )}

            <div className="absolute bottom-4 right-4 rounded-full bg-[rgba(255,255,255,0.18)] px-3 py-2 text-xs font-medium text-white/90 backdrop-blur-xl">
              点一下放大
            </div>
          </>
        ) : isRendering ? (
          <ParticleSeaWaiting
            visible={isRendering}
            startedAt={timing?.startTime}
            durationMs={timing?.durationMs}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center p-8">
            <div className="flex max-w-[20rem] flex-col items-center text-center">
              {/* fix #9 & #10: larger icon, stronger empty state */}
              <div className="lg-float flex h-20 w-20 items-center justify-center rounded-ios-2xl text-[rgba(0,0,0,0.44)]">
                {failed ? (
                  fallbackIcon || <AlertCircle className="h-9 w-9" />
                ) : (
                  mediaType === "video" ? <Video className="h-9 w-9" /> : <ImageIcon className="h-9 w-9" />
                )}
              </div>

              <h4 className="mt-5 text-ios-title3 font-semibold tracking-tight text-[rgba(0,0,0,0.72)]">
                {failed ? "这次没有成功" : "你的作品，将在这里出现。"}
              </h4>

              <p className="mt-2 text-ios-subhead leading-relaxed text-[rgba(0,0,0,0.58)]">
                {failed
                  ? "换个说法再试一次，通常很快就会恢复。"
                  : "写下想法。第一版画面，随即呈现。"}
              </p>
            </div>
          </div>
        )}
      </div>

      {isZoomed &&
        resolvedImageSrc && (
          <ImageLightbox
            src={resolvedImageSrc}
            alt={`${provider} 生成的图片`}
            onClose={() => setIsZoomed(false)}
            footer={
              <button
                type="button"
                className="lg-float inline-flex cursor-pointer items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium text-[#6f7987] disabled:cursor-not-allowed disabled:opacity-60"
                onClick={(event) => handleCopyClick(event, resolvedImageSrc, provider)}
                aria-label="复制图片"
                disabled={isCopying}
              >
                {isCopying ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : isCopied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                {isCopied ? "已复制" : "复制"}
              </button>
            }
          />
        )}
    </>
  );
}
