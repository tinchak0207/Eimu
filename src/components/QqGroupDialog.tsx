"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Check, Copy } from "lucide-react";

interface QqGroupDialogProps {
  open: boolean;
  onClose: () => void;
}

const QQ_GROUP_NUMBER = "980122175";

/** QQ 群二维码弹窗：一张码 + 一行群号，再无其他语义（入口按钮已说明语境）。 */
export function QqGroupDialog({ open, onClose }: QqGroupDialogProps) {
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!mounted || !open) return null;

  const handleCopyGroupNumber = async () => {
    try {
      await navigator.clipboard.writeText(QQ_GROUP_NUMBER);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-[rgba(31,34,48,0.45)] p-4 backdrop-blur-md animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="QQ 交流群二维码"
        onClick={(e) => e.stopPropagation()}
        className="lg-sheet relative flex max-h-[calc(100dvh-2rem)] w-full max-w-[460px] flex-col overflow-hidden rounded-ios-3xl p-4 shadow-2xl"
      >
        {/* Specular 顶光线 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-90" />

        {/* 关闭：浮在二维码右上角，不占内容行 */}
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-[rgba(255,255,255,0.70)] text-[rgba(0,0,0,0.55)] shadow-sm backdrop-blur transition-colors hover:bg-white hover:text-[rgba(0,0,0,0.80)] focus:outline-none focus:ring-2 focus:ring-ring/30"
        >
          <X className="h-4 w-4" />
        </button>

        {/* 二维码：直接铺满面板宽度，无内嵌卡。高度封顶 60vh 防小视口竖向溢出
            （正方形图，max-h + mx-auto 保持居中不变形）。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/qq-group-qrcode.jpg"
          alt="QQ 群二维码"
          className="mx-auto block h-auto max-h-[60dvh] w-full min-w-0 select-none rounded-ios-2xl object-contain"
          draggable={false}
        />

        {/* 群号一行：数字 + 复制 */}
        <div className="mt-3.5 flex shrink-0 items-center justify-center gap-2.5">
          <span className="text-ios-footnote text-[rgba(0,0,0,0.60)]">
            QQ 群 <strong className="font-semibold tabular-nums text-[rgba(0,0,0,0.88)]">{QQ_GROUP_NUMBER}</strong>
          </span>
          <button
            type="button"
            onClick={handleCopyGroupNumber}
            className="inline-flex items-center gap-1 rounded-full bg-[rgba(0,0,0,0.05)] px-2.5 py-1 text-ios-caption1 font-medium text-[rgba(0,0,0,0.75)] transition-colors hover:bg-[rgba(0,0,0,0.08)] active:scale-95"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-ios-green" />
                <span>已复制</span>
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                <span>复制</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
