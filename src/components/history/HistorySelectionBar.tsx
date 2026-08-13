"use client";

import { Download, Star, Trash2, X } from "lucide-react";

export interface HistorySelectionBarProps {
  count: number;
  busy: boolean;
  onDownload: () => void;
  onStar: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

/**
 * 多选时浮在底部的操作条。
 * 用 lg-bar 而不是 lg-card —— 它是工具栏，材质上应该跟顶部导航同族。
 */
export function HistorySelectionBar({
  count,
  busy,
  onDownload,
  onStar,
  onDelete,
  onCancel,
}: HistorySelectionBarProps) {
  if (count === 0) return null;

  return (
    <div
      role="toolbar"
      aria-label="批量操作"
      className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4"
    >
      <div className="lg-bar relative flex items-center gap-1 overflow-hidden rounded-ios-3xl px-2 py-2 shadow-[0_20px_60px_rgba(0,0,0,0.10)]">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-70" />

        <span className="px-3 text-ios-footnote font-semibold tabular-nums text-[rgba(0,0,0,0.72)]">
          已选 {count} 张
        </span>

        <button
          type="button"
          onClick={onDownload}
          disabled={busy}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-ios-xl px-3 py-2 text-ios-footnote font-medium text-[rgba(0,0,0,0.60)] transition-all duration-200 hover:bg-[rgba(0,0,0,0.06)] active:scale-[0.97] disabled:cursor-default disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
        >
          <Download className="h-3.5 w-3.5" />
          打包下载
        </button>

        <button
          type="button"
          onClick={onStar}
          disabled={busy}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-ios-xl px-3 py-2 text-ios-footnote font-medium text-[rgba(0,0,0,0.60)] transition-all duration-200 hover:bg-[rgba(0,0,0,0.06)] active:scale-[0.97] disabled:cursor-default disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
        >
          <Star className="h-3.5 w-3.5" />
          收藏
        </button>

        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-ios-xl px-3 py-2 text-ios-footnote font-medium text-[#FF3B30] transition-all duration-200 hover:bg-[rgba(255,59,48,0.10)] active:scale-[0.97] disabled:cursor-default disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-[rgba(255,59,48,0.20)]"
        >
          <Trash2 className="h-3.5 w-3.5" />
          删除
        </button>

        <button
          type="button"
          onClick={onCancel}
          aria-label="退出多选"
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.46)] transition-all duration-200 hover:bg-[rgba(0,0,0,0.06)] hover:text-[rgba(0,0,0,0.72)] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
