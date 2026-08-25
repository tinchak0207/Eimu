"use client";

import { useCallback, useState } from "react";
import { Loader2, Pencil, ZoomIn, Download, X } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { LOCAL_TEST_MODE } from "@/lib/local-test-mode";
import { PixaiError, resolveToPayload, runEdit, runUpscale, uploadMedia } from "./shared";
import { PixaiSourceInput, type PickedImage } from "./PixaiSourceInput";
import { PixaiModal } from "./PixaiModal";
import { imageHelpers } from "@/lib/image-helpers";
import { cn } from "@/lib/utils";
import { usePricingRevision } from "@/hooks/use-pricing-revision";
import { generationCoins } from "@/lib/generation-model-catalog";
import { PIXAI_EDIT_MODEL_ID } from "@/lib/image-model-ids.js";

type Stage = "idle" | "uploading" | "generating" | "done" | "error";

type RatioKey = "original" | "1:1" | "4:3" | "3:4" | "9:16";

const RATIO_SIZES: Record<Exclude<RatioKey, "original">, string> = {
  "1:1": "1024x1024",
  "4:3": "1024x768",
  "3:4": "768x1024",
  "9:16": "768x1365",
};

const RATIO_CHIPS: RatioKey[] = ["original", "1:1", "4:3", "3:4", "9:16"];

interface EditImagePanelProps {
  open?: boolean;
  onClose: () => void;
  inline?: boolean; // true = 不用 PixaiModal，直接渲染
}

export function EditImagePanel({ open = true, onClose, inline }: EditImagePanelProps) {
  const { token, isLoggedIn, user } = useAuth();
  const { toast } = useToast();
  const [source, setSource] = useState<PickedImage | null>(null);
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState<RatioKey>("original");
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [resultSize, setResultSize] = useState<{ width: number; height: number } | null>(null);
  usePricingRevision();

  const editPrice = generationCoins(PIXAI_EDIT_MODEL_ID, { resolution: "1k" });

  const redirectToGithub = useCallback(() => {
    window.location.href = "/api/auth/github/start";
  }, []);

  const handleGenerate = async () => {
    if (!source) {
      toast({ title: "请先选择图片", variant: "destructive" });
      return;
    }
    if (!prompt.trim()) {
      toast({ title: "请描述想改成什么样子", variant: "destructive" });
      return;
    }
    if (!LOCAL_TEST_MODE && !isLoggedIn) {
      redirectToGithub();
      return;
    }
    const tokenValue = token ?? "";
    try {
      setError("");
      setStage("uploading");
      const payload = await resolveToPayload(source.source);
      const mediaId = await uploadMedia(payload, tokenValue, user?.id ?? 0);
      setStage("generating");
      const size = ratio === "original" ? "1024x1024" : RATIO_SIZES[ratio];
      const url = await runEdit({ mediaId, prompt: prompt.trim(), size, token: tokenValue, userId: user?.id ?? 0 });
      setResultUrl(url);
      setStage("done");
    } catch (e) {
      const message = e instanceof PixaiError ? e.message : e instanceof Error ? e.message : "生成失败，请重试";
      setError(message);
      setStage("error");
      toast({ title: "改图失败", description: message, variant: "destructive" });
    }
  };

  const handleUpscaleResult = async () => {
    if (!resultUrl) return;
    if (!LOCAL_TEST_MODE && !isLoggedIn) {
      redirectToGithub();
      return;
    }
    const tokenValue = token ?? "";
    try {
      setError("");
      setStage("uploading");
      // 改图结果是 URL / base64，直接上传换取 mediaId 再放大。
      const payload = await resolveToPayload(
        resultUrl.startsWith("data:")
          ? { kind: "dataUrl", url: resultUrl }
          : { kind: "httpUrl", url: resultUrl },
      );
      const mediaId = await uploadMedia(payload, tokenValue, user?.id ?? 0);
      setStage("generating");
      const sizeLabel = resultSize ? `${resultSize.width}x${resultSize.height}` : undefined;
      const url = await runUpscale({ mediaId, factor: 2, size: sizeLabel, token: tokenValue, userId: user?.id ?? 0 });
      setResultUrl(url);
    } catch (e) {
      const message = e instanceof PixaiError ? e.message : e instanceof Error ? e.message : "放大失败，请重试";
      setError(message);
      setStage("error");
      toast({ title: "放大失败", description: message, variant: "destructive" });
    }
  };

  const reset = () => {
    setSource(null);
    setPrompt("");
    setRatio("original");
    setResultUrl("");
    setResultSize(null);
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
          <h3 className="text-ios-subheadline font-medium text-[rgba(0,0,0,0.85)]">改图完成</h3>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={resultUrl}
            alt="改图结果"
            className="w-full rounded-ios-2xl border border-[rgba(0,0,0,0.08)] object-contain"
            onLoad={(e) => {
              const el = e.currentTarget;
              if (el.naturalWidth && el.naturalHeight) {
                setResultSize({ width: el.naturalWidth, height: el.naturalHeight });
              }
            }}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => imageHelpers.download(resultUrl, "edit")}
              className="inline-flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-ios-xl bg-[#007AFF] px-5 text-ios-body font-semibold text-white transition-all hover:bg-[#0066DD] active:scale-[0.97]"
            >
              <Download className="h-4 w-4" />下载图片
            </button>
            <button
              type="button"
              onClick={handleUpscaleResult}
              disabled={busy}
              className="inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-ios-xl bg-[rgba(0,0,0,0.06)] px-5 text-ios-body font-medium text-[rgba(0,0,0,0.70)] transition-all hover:bg-[rgba(0,0,0,0.10)] disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ZoomIn className="h-4 w-4" />}
              {busy ? "放大中" : "放大"}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <PixaiSourceInput value={source} onChange={setSource} />

          {source && (
            <div className="overflow-hidden rounded-ios-2xl border border-[rgba(0,0,0,0.08)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={source.previewUrl} alt="待改图" className="w-full object-cover" />
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-ios-footnote text-[rgba(0,0,0,0.50)]">描述想改成什么样子</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="描述想改成什么样子..."
              rows={3}
              className="min-h-[88px] w-full resize-none rounded-ios-2xl border-0 bg-[rgba(0,0,0,0.04)] px-4 py-3 text-[15px] leading-5 text-[rgba(0,0,0,0.85)] placeholder:text-[rgba(0,0,0,0.44)] focus:bg-[rgba(0,122,255,0.04)] focus:ring-2 focus:ring-[rgba(0,122,255,0.20)] outline-none"
            />
          </div>

          <div>
            <p className="mb-1.5 text-ios-footnote text-[rgba(0,0,0,0.50)]">比例</p>
            <div className="flex flex-wrap gap-1.5">
              {RATIO_CHIPS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setRatio(key)}
                  className={cn("style-chip", ratio === key && "active")}
                >
                  {key === "original" ? "跟随原图" : key}
                </button>
              ))}
            </div>
          </div>

          <p className="text-ios-footnote text-[rgba(0,0,0,0.46)]">改图 {editPrice} 币起（按解析度浮动）</p>

          {stage === "error" && error && <p className="text-ios-footnote text-[#FF3B30]">{error}</p>}

          <button
            type="button"
            disabled={!source || !prompt.trim() || busy}
            onClick={handleGenerate}
            className="inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-ios-xl bg-[#007AFF] px-6 text-ios-body font-semibold text-white shadow-[0_6px_24px_rgba(0,122,255,0.40)] transition-all hover:bg-[#0066DD] active:scale-[0.97] disabled:cursor-not-allowed disabled:bg-[rgba(0,0,0,0.16)] disabled:shadow-none disabled:scale-100"
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {stage === "uploading" ? "上传中" : "改图中"}
              </>
            ) : (
              <>
                <Pencil className="h-4 w-4" /> 开始改图
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
          <h2 className="text-ios-body font-semibold text-[rgba(0,0,0,0.85)]">改图</h2>
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
    <PixaiModal title="改图" onClose={handleClose}>
      {content}
    </PixaiModal>
  );
}