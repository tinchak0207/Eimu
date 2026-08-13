"use client";

import Link from "next/link";
import { AlertCircle, ImageIcon, LogIn, SearchX } from "lucide-react";

export type HistoryEmptyReason = "empty" | "filtered" | "logged-out" | "error";

export interface HistoryEmptyStateProps {
  reason: HistoryEmptyReason;
  message?: string | null;
  onClearFilters?: () => void;
  onRetry?: () => void;
}

const PRESETS = {
  empty: {
    icon: ImageIcon,
    title: "还没有生成记录",
    hint: "做完图会自动出现在这里",
  },
  filtered: {
    icon: SearchX,
    title: "没有符合条件的记录",
    hint: "换个关键词，或清除筛选看看",
  },
  "logged-out": {
    icon: LogIn,
    title: "登录后查看生成历史",
    hint: "记录跟随账号，换设备也在",
  },
  error: {
    icon: AlertCircle,
    title: "历史记录加载失败",
    hint: "可能是网络波动，重试一次",
  },
} as const;

export function HistoryEmptyState({ reason, message, onClearFilters, onRetry }: HistoryEmptyStateProps) {
  const preset = PRESETS[reason];
  const Icon = preset.icon;

  return (
    // rounded-ios-3xl matches HistoryStats and the selection bar on this same
    // page — 48px was the one outlier corner, the exact bug we already fixed
    // on the homepage card/canvas pair.
    <div className="lg-card relative overflow-hidden rounded-ios-3xl">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-70" />

      <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-ios-2xl bg-[rgba(0,0,0,0.04)]">
          <Icon className="h-6 w-6 text-[rgba(0,0,0,0.44)]" />
        </div>

        <div>
          <p className="text-ios-body font-medium text-[rgba(0,0,0,0.85)]">{preset.title}</p>
          <p className="mt-1 text-ios-footnote text-[rgba(0,0,0,0.58)]">{message || preset.hint}</p>
        </div>

        {reason === "empty" && (
          <Link
            href="/"
            className="mt-1 inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-[#007AFF] px-5 py-2 text-ios-footnote font-semibold text-white shadow-[0_4px_16px_rgba(0,122,255,0.30)] transition-all hover:bg-[#0066DD] active:scale-[0.98]"
          >
            去做图
          </Link>
        )}

        {reason === "filtered" && onClearFilters && (
          <button
            type="button"
            onClick={onClearFilters}
            className="mt-1 cursor-pointer rounded-full bg-[rgba(0,0,0,0.06)] px-5 py-2 text-ios-footnote font-medium text-[rgba(0,0,0,0.56)] transition-all hover:bg-[rgba(0,0,0,0.10)] active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
          >
            清除筛选
          </button>
        )}

        {reason === "error" && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 cursor-pointer rounded-full bg-[#007AFF] px-5 py-2 text-ios-footnote font-semibold text-white shadow-[0_4px_16px_rgba(0,122,255,0.30)] transition-all hover:bg-[#0066DD] active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
          >
            重试
          </button>
        )}

        {reason === "logged-out" && (
          <Link
            href="/"
            className="mt-1 inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-[#007AFF] px-5 py-2 text-ios-footnote font-semibold text-white shadow-[0_4px_16px_rgba(0,122,255,0.30)] transition-all hover:bg-[#0066DD] active:scale-[0.98]"
          >
            返回登录
          </Link>
        )}
      </div>
    </div>
  );
}
