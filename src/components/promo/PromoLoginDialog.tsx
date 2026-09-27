"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Github, X } from "lucide-react";
import { getStoredToken } from "@/lib/new-api-client";
import { useAuth } from "@/hooks/use-auth";

/**
 * 宣傳片結尾「送出」時的登入彈窗（2026-09-27 暴君第三輪裁定）。
 *
 * 為什麼必須有這一層：宣傳片的觀眾大半是沒登入的訪客（片就是給他們的），
 * 而那句話要真的變成生產任務（開一個真會話、真的送進產線），前提是登入態。
 * 沒登入時把話直接吞掉＝漏斗斷在最後一格；把人丟去「登入頁」＝離開當下的畫面。
 * 所以在結尾原地彈一個窗，講清楚「你說的這句已經存好，登入完自動開跑」。
 *
 * 只用 GitHub 與微信兩種（暴君指定）：站上這兩條鏈路都是現成的——
 * ① GitHub 一律**同窗口跳轉** `/api/auth/github/start`（2026-09-05 的教訓：
 *    popup 在套殼/內嵌 webview 會變成停在 about:blank 的死窗）；
 *    跳走前那句話已經寫進 sessionStorage，回來落 / 時自動補送。
 * ② 微信走 `/wechat-login` 彈窗頁（與 Navbar 逐行同構的開窗參數），
 *    完成信號＝postMessage 主通道 ＋ token 落地輪詢兜底（message 遺失時，
 *    只要 popup 已把 token 寫進共享 localStorage，這裡偵測到就 refresh）。
 *
 * 不重寫 QR 流程：彈窗內容是既有的 /wechat-login 頁（改由它自己演）。
 */

interface PromoLoginDialogProps {
  open: boolean;
  onClose: () => void;
}

/** 微信官方白綠雙對話框 + 眼睛圓點 + 尾巴（逐字取自 SplitLoginButton，勿改）。 */
function WechatLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M9.5 3C5.91 3 3 5.58 3 8.75c0 1.76.88 3.33 2.26 4.38L4.75 15l2.3-1.05A7.28 7.28 0 0 0 9.5 14.5c.26 0 .52-.01.77-.04A5.12 5.12 0 0 1 10 12.5c0-2.9 2.69-5.25 6-5.25.2 0 .4.01.59.03C15.9 5.24 12.97 3 9.5 3Z"
        fill="white"
      />
      <circle cx="7.75" cy="8.5" r="0.85" fill="#07C160" />
      <circle cx="11.25" cy="8.5" r="0.85" fill="#07C160" />
      <path
        d="M16 8.5c-3.03 0-5.5 2.02-5.5 4.5s2.47 4.5 5.5 4.5c.6 0 1.17-.08 1.7-.23L20 18.5l-.9-1.98A4.22 4.22 0 0 0 21.5 13c0-2.48-2.47-4.5-5.5-4.5Z"
        fill="white"
      />
      <circle cx="14.5" cy="13" r="0.75" fill="#07C160" />
      <circle cx="17.5" cy="13" r="0.75" fill="#07C160" />
    </svg>
  );
}

export function PromoLoginDialog({ open, onClose }: PromoLoginDialogProps) {
  const { refresh } = useAuth();
  const [mounted, setMounted] = useState(false);
  /** 微信彈窗已開、等掃碼中（給人一個「正在等」的交代）。 */
  const [waiting, setWaiting] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const stopWaiting = useCallback(() => {
    timersRef.current.forEach((id) => window.clearInterval(id));
    timersRef.current = [];
    popupRef.current = null;
    setWaiting(false);
  }, []);

  useEffect(() => {
    if (!open) stopWaiting();
  }, [open, stopWaiting]);

  useEffect(() => stopWaiting, [stopWaiting]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  /** 登入態已落地：刷新（isLoggedIn 翻真後，待送的那句話由 ImagePlayground 補送）。 */
  const finish = useCallback(async () => {
    stopWaiting();
    await refresh();
    onClose();
  }, [onClose, refresh, stopWaiting]);

  // postMessage 主通道：/wechat-login 成功後對 opener 發 wechat-auth-complete。
  useEffect(() => {
    if (!open) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "wechat-auth-complete") void finish();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open, finish]);

  /** GitHub：同窗口跳轉（跳走前那句話已在 sessionStorage，回來自動補送）。 */
  const startGithub = useCallback(() => {
    window.location.href = "/api/auth/github/start";
  }, []);

  /** 微信：彈窗開既有登入頁 ＋ token 輪詢兜底（與 Navbar 同構）。 */
  const startWechat = useCallback(() => {
    const popup = window.open("/wechat-login", "wechat_oauth", "popup,width=440,height=640");
    if (!popup) {
      // 彈窗被擋（部分套殼/內嵌瀏覽器）：退回同窗口，行為仍是登入後補送。
      window.location.href = "/wechat-login";
      return;
    }
    popupRef.current = popup;
    setWaiting(true);
    const startedAt = Date.now();
    const pollId = window.setInterval(() => {
      if (getStoredToken()) {
        void finish();
        return;
      }
      if (popupRef.current?.closed && Date.now() - startedAt > 5000) stopWaiting();
    }, 700);
    timersRef.current.push(pollId);
  }, [finish, stopWaiting]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-[rgba(31,34,48,0.45)] p-4 backdrop-blur-md animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="登录后开始试玩"
        onClick={(event) => event.stopPropagation()}
        className="lg-sheet relative flex w-full max-w-[420px] flex-col overflow-hidden rounded-ios-3xl p-6 shadow-2xl"
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-90" />

        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-[rgba(255,255,255,0.70)] text-[rgba(0,0,0,0.55)] shadow-sm backdrop-blur transition-colors hover:bg-white hover:text-[rgba(0,0,0,0.80)] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.30)]"
        >
          <X className="h-4 w-4" />
        </button>

        <h2 className="pr-8 text-[17px] font-semibold text-foreground">登录后开始试玩</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          你刚说的那句已经先存好了。登录完成就自动开一个新对话，把这句话送进产线开跑。
        </p>

        <div className="mt-5 flex flex-col gap-2.5">
          <button
            type="button"
            onClick={startGithub}
            className="flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-[#1f2328] text-[14px] font-semibold text-white lg-transition hover:bg-[#16181c] active:scale-[0.99]"
          >
            <Github className="h-[18px] w-[18px]" aria-hidden="true" />
            使用 GitHub 登录
          </button>
          <button
            type="button"
            onClick={startWechat}
            className="flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-[#07C160] text-[14px] font-semibold text-white lg-transition hover:bg-[#06AD56] active:scale-[0.99]"
          >
            <WechatLogo className="h-[19px] w-[19px]" />
            使用微信登录
          </button>
        </div>

        {waiting && (
          <p className="mt-3 text-center text-[12px] text-muted-foreground">
            已打开微信扫码窗口，扫完自动开始。
          </p>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-4 cursor-pointer text-[13px] font-medium text-muted-foreground lg-transition hover:text-foreground"
        >
          先不登录，继续逛
        </button>
      </div>
    </div>,
    document.body,
  );
}
