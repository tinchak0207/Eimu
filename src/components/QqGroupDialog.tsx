"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Check, Copy } from "lucide-react";

interface QqGroupDialogProps {
  open: boolean;
  onClose: () => void;
}

const QQ_GROUP_NUMBER = "980122175";

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(31,34,48,0.45)] p-4 backdrop-blur-md animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="售后/交流群组"
        onClick={(e) => e.stopPropagation()}
        className="lg-sheet relative w-full max-w-[420px] overflow-hidden rounded-ios-3xl p-5 shadow-2xl"
      >
        {/* Specular 顶光线 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-90" />

        {/* 标题与关闭 */}
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-ios-subhead font-bold tracking-tight text-[rgba(0,0,0,0.85)]">
            售后/交流群组
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.44)] transition-colors hover:bg-black/5 hover:text-[rgba(0,0,0,0.72)] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 二维码：白卡衬底正方形 */}
        <div className="mt-3 flex justify-center rounded-ios-2xl bg-white p-3.5 shadow-[0_2px_12px_rgba(0,0,0,0.06)] ring-1 ring-black/5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/qq-group-qrcode.jpg"
            alt="QQ 群二维码"
            width={280}
            height={280}
            className="h-auto w-full max-w-[280px] select-none rounded-ios-md object-contain"
            draggable={false}
          />
        </div>

        {/* 群号 + 一句扫码提示 */}
        <div className="mt-4 flex items-center justify-center gap-2">
          <span className="text-ios-footnote text-[rgba(0,0,0,0.60)]">
            群号 <strong className="font-semibold tabular-nums text-[rgba(0,0,0,0.88)]">{QQ_GROUP_NUMBER}</strong>
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
        <p className="mt-1.5 text-center text-ios-caption1 text-[rgba(0,0,0,0.45)]">
          手机 QQ 扫一扫，加入群聊
        </p>
      </div>
    </div>,
    document.body,
  );
}
