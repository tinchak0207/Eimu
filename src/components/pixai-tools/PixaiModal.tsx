"use client";

import { X } from "lucide-react";

interface PixaiModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

/** 改图 / 放大共用的居中覆盖弹层，与全站 iOS 风格一致。 */
export function PixaiModal({ title, onClose, children }: PixaiModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[rgba(0,0,0,0.35)] backdrop-blur-sm sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        className="lg-card relative mb-0 max-h-[92dvh] w-full overflow-y-auto rounded-ios-4xl p-5 sm:mb-0 sm:max-w-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-ios-body font-semibold text-[rgba(0,0,0,0.85)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:bg-[rgba(0,0,0,0.05)] hover:text-[rgba(0,0,0,0.72)]"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4">{children}</div>
      </div>
    </div>
  );
}