"use client";

// 历史卡的「分享」对话框：把自己的作品变成一条公开连结 /p/<shareId>。
//
// 三条产品规矩（对应纯函式层的断言，见 src/lib/share-remix.test.ts）：
//   ①预设不公开——打开这个框＝按下分享才建立记录；没建立过就没有公开读取路径。
//   ②shareId 不可枚举（128-bit 随机，由 /api/share 产生），不能从作品 id 推得。
//   ③可撤销——撤销即删记录，同一条连结当场 404。
//
// 面板骨架复用历史页既有语法（RerunDialog / SaveCardDialog 同款：portal + lg-sheet
// 玻璃面板 + iOS 字级）；建立是幂等的，所以重复打开只会回到同一条连结。

import { useCallback, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, EyeOff, Link2, Loader2, Share2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { createShareLink, stationAuthHeaders } from "@/lib/agent-image-share";
import { firstShareableIndex } from "@/lib/share-remix";
import type { HistoryEntry } from "@/lib/history-types";

export interface ShareDialogProps {
  entry: HistoryEntry;
  onClose: () => void;
}

interface SharePayload {
  shareId: string;
  url: string;
  hidePrompt: boolean;
}

export function ShareDialog({ entry, onClose }: ShareDialogProps) {
  const [mounted, setMounted] = useState(false);
  const [share, setShare] = useState<SharePayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const titleId = useId();

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const resultIndex = firstShareableIndex(entry);

  /**
   * 建立（或取回）。POST /api/share 是幂等的——同一件作品再点一次回同一条连结，
   * 使用者贴出去的旧连结不会被悄悄换掉。请求与文案真源都在 createShareLink（媒体卡共用）。
   */
  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    const result = await createShareLink(entry, { resultIndex });
    if (!result.ok) {
      setError(result.message);
      setBusy(false);
      return;
    }
    setShare({ shareId: result.shareId, url: result.url, hidePrompt: result.hidePrompt });
    setBusy(false);
  }, [entry, resultIndex]);

  useEffect(() => {
    void create();
  }, [create]);

  const toggleHidePrompt = useCallback(async () => {
    if (!share || busy) return;
    setBusy(true);
    setError(null);
    const next = !share.hidePrompt;
    try {
      const res = await fetch("/api/share", {
        method: "PATCH",
        headers: stationAuthHeaders(),
        body: JSON.stringify({ shareId: share.shareId, hidePrompt: next }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        message?: string;
        data?: { hidePrompt?: boolean };
      };
      if (!res.ok || payload.success !== true) {
        setError(payload.message ?? "修改失败，请稍后重试。");
        return;
      }
      setShare({ ...share, hidePrompt: payload.data?.hidePrompt === true });
    } catch {
      setError("网络异常，修改没有生效。");
    } finally {
      setBusy(false);
    }
  }, [busy, share]);

  const copyLink = useCallback(async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("复制失败，请手动选中链接复制。");
    }
  }, [share]);

  const revoke = useCallback(async () => {
    if (!share || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/share", {
        method: "DELETE",
        headers: stationAuthHeaders(),
        body: JSON.stringify({ shareId: share.shareId }),
      });
      const payload = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || payload.success !== true) {
        setError(payload.message ?? "撤销失败，请稍后重试。");
        return;
      }
      setShare(null);
      setRevoked(true);
    } catch {
      setError("网络异常，链接没有被撤销。");
    } finally {
      setBusy(false);
    }
  }, [busy, share]);

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-[rgba(31,34,48,0.45)] p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        className="lg-sheet w-full max-w-sm rounded-ios-2xl p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p id={titleId} className="flex items-center gap-1.5 text-ios-subhead font-semibold text-foreground">
              <Share2 className="h-4 w-4 text-[rgba(0,0,0,0.44)]" />
              分享这件作品
            </p>
            <p className="mt-1 text-ios-footnote text-[rgba(0,0,0,0.55)]">
              生成一条公开链接，别人打开就能看到图，还能一键做同款。只有你分享过的作品才有链接。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.44)] transition-colors hover:bg-black/5 hover:text-[rgba(0,0,0,0.72)] focus:outline-none focus:ring-2 focus:ring-ring/20"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {revoked ? (
          <p className="mt-4 rounded-ios-xl bg-[rgba(0,0,0,0.04)] px-3 py-3 text-ios-footnote text-[rgba(0,0,0,0.62)]">
            链接已撤销，原来的网址现在是 404。再点一次分享会生成新的链接。
          </p>
        ) : (
          <>
            <div className="mt-4">
              <span className="text-ios-caption1 font-medium text-[rgba(0,0,0,0.62)]">公开链接</span>
              <div className="mt-1.5 flex items-center gap-2 rounded-ios-xl bg-[rgba(0,0,0,0.04)] px-3 py-2.5">
                <Link2 className="h-3.5 w-3.5 shrink-0 text-[rgba(0,0,0,0.44)]" aria-hidden="true" />
                {share ? (
                  <span className="min-w-0 flex-1 truncate text-ios-footnote text-[rgba(0,0,0,0.72)]">
                    {share.url}
                  </span>
                ) : (
                  <span className="flex-1 text-ios-footnote text-[rgba(0,0,0,0.44)]">
                    {busy ? "正在生成…" : "尚未生成"}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void copyLink()}
                  disabled={!share}
                  aria-label="复制链接"
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors",
                    share
                      ? "cursor-pointer text-[#007AFF] hover:bg-[rgba(0,122,255,0.10)]"
                      : "cursor-default text-[rgba(0,0,0,0.30)]",
                  )}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
              <p className="mt-1.5 text-ios-caption1 text-[rgba(0,0,0,0.45)]">
                链接带来源标记，方便知道人是从哪件作品来的。
              </p>
            </div>

            <button
              type="button"
              onClick={() => void toggleHidePrompt()}
              disabled={!share || busy}
              aria-pressed={share?.hidePrompt === true}
              className={cn(
                "mt-3 flex w-full cursor-pointer items-center justify-between gap-2 rounded-ios-xl px-3 py-3 text-left transition-colors",
                "bg-[rgba(0,0,0,0.04)] hover:bg-[rgba(0,0,0,0.07)]",
                "focus:outline-none focus:ring-2 focus:ring-ring/20",
                (!share || busy) && "cursor-default opacity-70",
              )}
            >
              <span className="flex items-center gap-2 text-ios-footnote text-[rgba(0,0,0,0.72)]">
                <EyeOff className="h-3.5 w-3.5 text-[rgba(0,0,0,0.44)]" aria-hidden="true" />
                隐藏提示词
              </span>
              <span
                className={cn(
                  "text-ios-caption1 font-medium",
                  share?.hidePrompt ? "text-[#007AFF]" : "text-[rgba(0,0,0,0.44)]",
                )}
              >
                {share?.hidePrompt ? "已隐藏" : "公开"}
              </span>
            </button>

            {error && (
              <p role="alert" className="mt-3 text-ios-footnote text-[#FF3B30]">
                {error}
              </p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              {busy && <Loader2 className="mt-2 h-4 w-4 animate-spin text-[rgba(0,0,0,0.30)]" aria-hidden="true" />}
              <button
                type="button"
                onClick={() => void revoke()}
                disabled={!share || busy}
                className={cn(
                  "rounded-ios-xl px-4 py-2.5 text-ios-footnote font-medium text-[#FF3B30] transition-colors",
                  share && !busy ? "cursor-pointer hover:bg-[rgba(255,59,48,0.10)]" : "cursor-default opacity-60",
                )}
              >
                撤销分享
              </button>
              <button
                type="button"
                onClick={() => void copyLink()}
                disabled={!share}
                className={cn(
                  "rounded-ios-xl bg-[#007AFF] px-4 py-2.5 text-ios-footnote font-medium text-white",
                  "shadow-[0_4px_12px_rgba(0,122,255,0.32)] transition-all duration-200",
                  "hover:bg-[#0066D6] active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-ring/30",
                  share ? "cursor-pointer" : "cursor-default opacity-60 active:scale-100",
                )}
              >
                {copied ? "已复制" : "复制链接"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
