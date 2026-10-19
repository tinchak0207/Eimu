"use client";

// 公告详情弹窗：一条公告的标题 + 正文，再无其他语义。
//
// 本档只做容器，**不含任何运营文案**：内容全部来自 props（服务端 announcement）。
// 结构逐字沿用 QqGroupDialog 的弹窗骨架（portal + 点外关闭 + Escape + lg-sheet
// 玻璃面板 + specular 顶线 + 右上角关闭钮），只换内容与尺寸。

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { Announcement } from "@/lib/notification-store";

export interface AnnouncementDialogProps {
  open: boolean;
  announcement: Announcement | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
}

/** ISO → 可读时间（本地时区，简化中文）。仅供公告元信息行使用。 */
function formatStamp(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function AnnouncementDialog({
  open,
  announcement,
  loading = false,
  error = null,
  onClose,
}: AnnouncementDialogProps) {
  const [mounted, setMounted] = useState(false);

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

  return createPortal(
    <div
      className="animate-in fade-in fixed inset-0 z-[95] flex items-center justify-center bg-[rgba(31,34,48,0.45)] p-4 backdrop-blur-md duration-200"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={announcement?.title ?? "公告详情"}
        onClick={(event) => event.stopPropagation()}
        className="lg-sheet animate-lg-appear relative flex max-h-[calc(100dvh-2rem)] w-full max-w-[540px] flex-col overflow-hidden rounded-ios-3xl"
      >
        {/* Specular 顶光线 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-90" />

        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-[rgba(255,255,255,0.70)] text-[rgba(0,0,0,0.55)] shadow-sm backdrop-blur transition-colors hover:bg-white hover:text-[rgba(0,0,0,0.80)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>

        {loading ? (
          <div className="flex items-center justify-center gap-2 px-5 py-14 text-ios-footnote text-[rgba(0,0,0,0.55)]">
            <Spinner className="h-4 w-4" />
            正在读取…
          </div>
        ) : error ? (
          <div className="px-5 py-14 text-center text-ios-footnote text-[rgba(0,0,0,0.60)]">{error}</div>
        ) : announcement ? (
          <>
            <div className="shrink-0 px-5 pb-3 pr-12 pt-5">
              <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.88)]">
                {announcement.title}
              </h2>
              {formatStamp(announcement.createdAt) ? (
                <p className="mt-1 text-ios-caption1 tabular-nums text-[rgba(0,0,0,0.48)]">
                  {formatStamp(announcement.createdAt)}
                </p>
              ) : null}
            </div>
            {/* 分隔用 1px 底线而不是双层描边：面板已是 lg-sheet，再叠卡就是鬼卡。 */}
            <div className="mx-5 h-px shrink-0 bg-[rgba(0,0,0,0.07)]" />
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <p className="whitespace-pre-wrap text-ios-subhead text-[rgba(0,0,0,0.72)]">
                {announcement.body}
              </p>
            </div>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
