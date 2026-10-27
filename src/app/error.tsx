"use client";

import { AlertCircle } from "lucide-react";

/**
 * 路由级错误页：套站内 lg-sheet + HistoryEmptyState 主 CTA 配方 + ios 字级。
 * 不另造第二套视觉；不把可能含上游细节的 error.message 直甩给用户。
 */
export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center px-6 py-10">
      <div className="lg-sheet relative w-full max-w-[420px] overflow-hidden rounded-ios-3xl">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-90"
        />
        <div className="flex flex-col items-center gap-4 px-5 py-10 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-ios-2xl bg-[rgba(0,0,0,0.04)]">
            <AlertCircle className="h-6 w-6 text-[rgba(0,0,0,0.44)]" aria-hidden="true" />
          </div>
          <div>
            <p className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.88)]">页面出错了</p>
            <p className="mt-1 text-ios-subhead text-[rgba(0,0,0,0.58)]">
              先重试一次；还不行就刷新页面。
            </p>
          </div>
          <button
            type="button"
            onClick={reset}
            className="mt-1 cursor-pointer rounded-full bg-[#007AFF] px-5 py-2.5 text-ios-footnote font-semibold text-white shadow-[0_4px_16px_rgba(0,122,255,0.30)] transition-all hover:bg-[#0066DD] active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]"
          >
            重试
          </button>
        </div>
      </div>
    </div>
  );
}
