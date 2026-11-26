"use client";

import { AlertCircle } from "lucide-react";
import { describeRouteError } from "@/lib/route-error-recovery";
import "./globals.css";

/**
 * 根布局级错误页：无 layout 时仍走同一套 lg-sheet / 主 CTA / ios 字级。
 * 必须自带 html/body；材料与文案与 error.tsx 对齐，不另起视觉语言。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const view = describeRouteError(error);
  return (
    <html lang="zh-CN">
      <body>
        <div className="flex min-h-[100dvh] items-center justify-center px-6 py-10">
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
                <p className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.88)]">{view.title}</p>
                <p className="mt-1 text-ios-subhead text-[rgba(0,0,0,0.58)]">
                  {view.hint}
                </p>
                {view.supportRef ? (
                  <p className="mt-2 text-ios-caption2 text-[rgba(0,0,0,0.38)]">工单号 {view.supportRef}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => (view.needsReload ? window.location.reload() : reset())}
                className="mt-1 cursor-pointer rounded-full bg-[#007AFF] px-5 py-2.5 text-ios-footnote font-semibold text-white shadow-[0_4px_16px_rgba(0,122,255,0.30)] transition-all hover:bg-[#0066DD] active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]"
              >
                {view.action}
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
