"use client";

// 新人礼首登弹窗：登录后第一眼把「已到账 5 币」讲清楚，并给一条一步就能开跑的入口。
//
// 本档只做容器与两颗按钮，**不含任何运营文案**：标题/正文/币数/张数全部来自 props
// （服务端由 welcome-gift 的具名常量推導，见 welcome-gift-modal.ts 的契约）。这样文案
// 改一处就全站一致，客户端不会偷偷长出第二份写死的数字。
//
// 结构逐字沿用 AnnouncementDialog 的弹窗骨架（portal + 点外关闭 + Escape + lg-sheet
// 玻璃面板 + specular 顶线 + 右上角关闭钮），只换内容与按钮区。禁 emoji。

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export interface WelcomeGiftDialogProps {
  /** 打开与否由上层决定（每设备只弹一次的辅助闸门也在上层）。 */
  open: boolean;
  /** 弹窗标题（服务端文案，单一来源）。 */
  title: string;
  /** 弹窗正文（服务端文案，单一来源）。 */
  body: string;
  /** 主按钮：关窗 + 聚焦主输入框 + 预填示例 prompt。 */
  onStart: () => void;
  /** 次按钮「稍后」：关窗（已展示的回执照记，不再弹第二次）。 */
  onLater: () => void;
}

export function WelcomeGiftDialog({
  open,
  title,
  body,
  onStart,
  onLater,
}: WelcomeGiftDialogProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onLater();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onLater]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="animate-in fade-in fixed inset-0 z-[95] flex items-center justify-center bg-[rgba(31,34,48,0.45)] p-4 backdrop-blur-md duration-200"
      onClick={onLater}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        className="lg-sheet animate-lg-appear relative flex max-h-[calc(100dvh-2rem)] w-full max-w-[420px] flex-col overflow-hidden rounded-ios-3xl"
      >
        {/* Specular 顶光线 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-90" />

        <button
          type="button"
          onClick={onLater}
          aria-label="关闭"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-[rgba(255,255,255,0.70)] text-[rgba(0,0,0,0.55)] shadow-sm backdrop-blur transition-colors hover:bg-white hover:text-[rgba(0,0,0,0.80)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>

        <div className="shrink-0 px-5 pb-3 pr-12 pt-6">
          <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.88)]">{title}</h2>
        </div>
        <div className="px-5">
          <p className="text-ios-subhead text-[rgba(0,0,0,0.72)]">{body}</p>
        </div>

        {/* 手机上按钮改为竖排（点按区够大），宽屏并排；次序恒为「主在上/在左」。 */}
        <div className="mt-5 flex flex-col-reverse gap-2 px-5 pb-5 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onLater}
            className="flex h-11 cursor-pointer items-center justify-center rounded-ios-2xl px-5 text-ios-subhead font-medium text-[rgba(0,0,0,0.60)] transition-colors hover:bg-[rgba(0,0,0,0.04)] hover:text-[rgba(0,0,0,0.80)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] sm:h-10"
          >
            稍后
          </button>
          <button
            type="button"
            onClick={onStart}
            className="flex h-11 cursor-pointer items-center justify-center rounded-ios-2xl bg-[#007AFF] px-5 text-ios-subhead font-semibold text-white shadow-sm transition-colors hover:bg-[#0069DB] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] sm:h-10"
          >
            马上生成第一张
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
