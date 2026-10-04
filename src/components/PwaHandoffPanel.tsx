"use client";

// PWA standalone GitHub 登录交接面板：在常用浏览器完成授权，本面板轮询
// 一次性 ticket，delivered 后 claim 领回会话（服务端 Set-Cookie 种登录态）。
// 仅 standalone PWA 内由登录入口触发，不影响普通浏览器登录链路。
// 轮询/claim 状态机已抽到 usePwaHandoffClaim（2026-10-04），本檔只畫界面。

import { useToast } from "@/hooks/use-toast";
import { usePwaHandoffClaim } from "@/hooks/use-pwa-handoff-claim";

interface PwaHandoffPanelProps {
  loginUrl: string;
  onSuccess: () => void;
  onClose: () => void;
}

export function PwaHandoffPanel({ loginUrl, onSuccess, onClose }: PwaHandoffPanelProps) {
  const { toast } = useToast();
  const { timedOut, claiming } = usePwaHandoffClaim(loginUrl, onSuccess);

  const handleCopy = async () => {
    try {
      const full = loginUrl.startsWith("http") ? loginUrl : `${window.location.origin}${loginUrl}`;
      await navigator.clipboard.writeText(full);
      toast({ title: "已复制，去常用浏览器粘贴打开" });
    } catch {
      toast({ title: "复制失败，请重试" });
    }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 px-4">
      <div className="lg-sheet w-full max-w-sm rounded-ios-2xl p-5">
        <h2 className="text-[17px] font-semibold text-[rgba(0,0,0,0.85)]">登录</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[rgba(0,0,0,0.6)]">
          复制链接到常用浏览器完成登录，回来后自动登录。
        </p>
        <button
          type="button"
          onClick={handleCopy}
          className="mt-3 text-[13px] font-medium text-ios-blue active:opacity-70"
        >
          复制链接
        </button>

        {timedOut ? (
          <p className="mt-4 text-[13px] font-medium text-ios-red">超时，请重试</p>
        ) : claiming ? (
          <p className="mt-4 text-[13px] text-[rgba(0,0,0,0.6)]">正在登录…</p>
        ) : null}

        <div className="mt-4 flex items-center gap-3">
          <a
            href={loginUrl}
            target="_blank"
            rel="noreferrer"
            className="flex-1 rounded-xl bg-[rgba(0,0,0,0.85)] px-4 py-2.5 text-center text-ios-footnote font-semibold text-white active:opacity-80"
          >
            去浏览器打开
          </a>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-black/[0.06] px-4 py-2.5 text-ios-footnote font-medium text-[rgba(0,0,0,0.72)] active:opacity-70"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
