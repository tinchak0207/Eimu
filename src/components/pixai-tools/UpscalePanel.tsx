"use client";

import { useCallback, useState } from "react";
import { Download, Loader2, ZoomIn, X } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { LOCAL_TEST_MODE } from "@/lib/sub2api";
import {
  PixaiError,
  resolveToPayload,
  runUpscale,
  uploadMedia,
} from "./shared";
import { PixaiSourceInput, type PickedImage } from "./PixaiSourceInput";
import { PixaiModal } from "./PixaiModal";
import { imageHelpers } from "@/lib/image-helpers";
import { usePricingRevision } from "@/hooks/use-pricing-revision";
import { generationCoins, resolutionFromImageSize } from "@/lib/generation-model-catalog";
import { PIXAI_UPSCALE_MODEL_ID } from "@/lib/image-model-ids.js";

type Stage = "idle" | "uploading" | "generating" | "done" | "error";

interface UpscalePanelProps {
  open?: boolean;
  onClose: () => void;
  inline?: boolean; // true = 不用 PixaiModal，直接渲染
}

export function UpscalePanel({ open = true, onClose, inline }: UpscalePanelProps) {
  const { token, isLoggedIn, user } = useAuth();
  const { toast } = useToast();
  const [source, setSource] = useState<PickedImage | null>(null);
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  usePricingRevision();

  const sizeLabel = sourceSize ? `${sourceSize.width}x${sourceSize.height}` : undefined;
  const price = generationCoins(PIXAI_UPSCALE_MODEL_ID, {
    resolution: resolutionFromImageSize(sizeLabel),
  });

  const redirectToGithub = useCallback(() => {
    window.location.href = "/api/auth/github/start";
  }, []);

  const handleGenerate = async () => {
    if (!source) {
      toast({ title: "请先选择图片", variant: "destructive" });
      return;
    }
    if (!LOCAL_TEST_MODE && !isLoggedIn) {
      // 保留 blob ref，登入回来继续
      redirectToGithub();
      return;
    }
    const tokenValue = token ?? "";
    try {
      setError("");
      const payload = await resolveToPayload(source.source);
      if (source.source.kind === "file") {
        setStage("uploading");
      }
      const mediaId = await uploadMedia(payload, tokenValue, user?.id ?? 0);
      setStage("generating");
      const url = await runUpscale({ mediaId, factor: 2, size: sizeLabel, token: tokenValue, userId: user?.id ?? 0 });
      setResultUrl(url);
      setStage("done");
    } catch (e) {
      const message = e instanceof PixaiError ? e.message : e instanceof Error ? e.message : "生成失败，请重试";
      setError(message);
      setStage("error");
      toast({ title: "放大失败", description: message, variant: "destructive" });
    }
  };

  const reset = () => {
    setSource(null);
    setSourceSize(null);
    setResultUrl("");
    setError("");
    setStage("idle");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  if (!inline && !open) return null;

  const busy = stage === "uploading" || stage === "generating";

  const content = (
    <>
      {stage === "done" && resultUrl ? (
        <div className="space-y-3">
          <h3 className="text-ios-subheadline font-medium text-[rgba(0,0,0,0.85)]">放大完成</h3>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={resultUrl}
            alt="放大结果"
            className="w-full rounded-ios-2xl border border-[rgba(0,0,0,0.08)] object-contain"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => imageHelpers.download(resultUrl, "upscale")}
              className="inline-flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-ios-xl bg-[#007AFF] px-5 text-ios-body font-semibold text-white transition-all hover:bg-[#0066DD] active:scale-[0.97]"
            >
              <Download className="h-4 w-4" />下载图片
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="h-11 shrink-0 cursor-pointer rounded-ios-xl bg-[rgba(0,0,0,0.06)] px-5 text-ios-body font-medium text-[rgba(0,0,0,0.70)] transition-all hover:bg-[rgba(0,0,0,0.10)]"
            >
              完成
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <PixaiSourceInput value={source} onChange={setSource} />

          {source && (
            <div className="overflow-hidden rounded-ios-2xl border border-[rgba(0,0,0,0.08)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={source.previewUrl}
                alt="待处理图片"
                className="w-full object-cover"
                onLoad={(e) => {
                  const el = e.currentTarget;
                  if (el.naturalWidth && el.naturalHeight) {
                    setSourceSize({ width: el.naturalWidth, height: el.naturalHeight });
                  }
                }}
              />
            </div>
          )}

          <p className="text-ios-footnote text-[rgba(0,0,0,0.46)]">
            固定 2 倍放大 · 价格 {price} 币{sourceSize ? "（按解析度浮动）" : "起（按解析度浮动）"}
          </p>

          {stage === "error" && error && (
            <p className="text-ios-footnote text-[#FF3B30]">{error}</p>
          )}

          <button
            type="button"
            disabled={!source || busy}
            onClick={handleGenerate}
            className="inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-ios-xl bg-[#007AFF] px-6 text-ios-body font-semibold text-white shadow-[0_6px_24px_rgba(0,122,255,0.40)] transition-all hover:bg-[#0066DD] active:scale-[0.97] disabled:cursor-not-allowed disabled:bg-[rgba(0,0,0,0.16)] disabled:shadow-none disabled:scale-100"
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {stage === "uploading" ? "上传中" : "放大中"}
              </>
            ) : (
              <>
                <ZoomIn className="h-4 w-4" /> 开始放大
              </>
            )}
          </button>
        </div>
      )}
    </>
  );

  if (inline) {
    return (
      <section className="lg-card relative overflow-x-clip rounded-ios-3xl p-5 pb-6 sm:p-6 sm:pb-7">
        {/* 顶部标题列 */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-ios-body font-semibold text-[rgba(0,0,0,0.85)]">高清放大</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-[rgba(0,0,0,0.45)] hover:bg-[rgba(0,0,0,0.06)] lg-transition cursor-pointer"
            aria-label="返回生图模式"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {content}
      </section>
    );
  }

  return (
    <PixaiModal title="高清放大" onClose={handleClose}>
      {content}
    </PixaiModal>
  );
}