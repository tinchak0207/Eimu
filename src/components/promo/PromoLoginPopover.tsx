"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Github } from "lucide-react";
import { getStoredToken } from "@/lib/new-api-client";
import { useAuth } from "@/hooks/use-auth";

/**
 * 宣傳片結尾送出時，從送出鈕上方長出來的登入小對話框（2026-09-27 暴君裁定）。
 *
 * 為什麼不是全屏彈窗：全屏遮罩把剛播完的結尾畫面蓋掉＝把人的注意力從「這部片」
 * 挪到「一個登入牆」，還沒登入就先把興致打斷（暴君原話：「不要遮盖……不然用户
 * 会丧失兴趣」）。所以改成：送出鈕先轉圈 0.2 秒（＝正在開跑的反饋），然後在鈕的
 * 正上方長出這一小格，只遮住牠上面那一小塊，畫面其餘部分（封面、輸入框、那句話）
 * 都還在原地。
 *
 * 兩條登入鏈路都是站上現成的（不重寫）：
 * ①GitHub＝同窗口跳轉 `/api/auth/github/start`——popup 在套殼/內嵌 webview 會
 *   變成停在 about:blank 的死窗（2026-09-05 教訓）；跳走前那句話已寫進
 *   sessionStorage，回來落 / 自動補送。
 * ②微信＝開既有 `/wechat-login` 彈窗頁（與 Navbar 同一個開窗參數）；完成信號
 *   雙路：postMessage 主通道 ＋ token 落地輪詢兜底（message 遺失但 token 已寫進
 *   共享 localStorage 時照樣收工）；popup 被擋則退回同窗口。
 * 登入態一翻真，ImagePlayground 的補送 effect 就把那句話送進真會話（這裡不重複做）。
 */

interface PromoLoginPopoverProps {
  /** 使用者放棄登入（關掉這格）：上層要清掉待送的那句話。 */
  onDismiss: () => void;
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

export function PromoLoginPopover({ onDismiss }: PromoLoginPopoverProps) {
  const { refresh } = useAuth();
  const [waiting, setWaiting] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const timersRef = useRef<number[]>([]);

  const stopWaiting = useCallback(() => {
    timersRef.current.forEach((id) => window.clearInterval(id));
    timersRef.current = [];
    popupRef.current = null;
    setWaiting(false);
  }, []);

  useEffect(() => stopWaiting, [stopWaiting]);

  /** 登入態落地：刷新即可——待送的那句話由 ImagePlayground 的補送 effect 接手。 */
  const finish = useCallback(async () => {
    stopWaiting();
    await refresh();
  }, [refresh, stopWaiting]);

  // postMessage 主通道：/wechat-login 成功後對 opener 發 wechat-auth-complete。
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "wechat-auth-complete") void finish();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [finish]);

  const startGithub = useCallback(() => {
    window.location.href = "/api/auth/github/start";
  }, []);

  const startWechat = useCallback(() => {
    const popup = window.open("/wechat-login", "wechat_oauth", "popup,width=440,height=640");
    if (!popup) {
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

  return (
    <div
      role="dialog"
      aria-label="登录后开拍"
      onClick={(event) => event.stopPropagation()}
      className="lg-float relative w-[min(336px,calc(100vw-2rem))] rounded-ios-2xl p-4 shadow-[0_18px_44px_rgba(45,49,66,0.22)] animate-in fade-in slide-in-from-bottom-1 duration-150"
    >
      {/* 指向下方送出鈕的小尖角：位置＝對話框水平中心，鈕在畫面正中間那條線上。 */}
      <div className="pointer-events-none absolute -bottom-[6px] left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 rounded-[2px] bg-[inherit] shadow-[3px_3px_8px_rgba(45,49,66,0.10)]" />

      <p className="text-[14px] font-semibold text-foreground">登录后开拍</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
        你刚说的那句已经存好了，登录完成就开一个新对话、直接送进产线。
      </p>

      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          onClick={startGithub}
          className="flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-[#1f2328] text-[13.5px] font-semibold text-white lg-transition hover:bg-[#16181c] active:scale-[0.99]"
        >
          <Github className="h-[17px] w-[17px]" aria-hidden="true" />
          使用 GitHub 登录
        </button>
        <button
          type="button"
          onClick={startWechat}
          className="flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-[#07C160] text-[13.5px] font-semibold text-white lg-transition hover:bg-[#06AD56] active:scale-[0.99]"
        >
          <WechatLogo className="h-[18px] w-[18px]" />
          使用微信登录
        </button>
      </div>

      <p className="mt-2.5 text-center text-[11.5px] text-muted-foreground">
        {waiting ? "已打开微信扫码窗口，扫完自动开跑。" : <button
          type="button"
          onClick={onDismiss}
          className="cursor-pointer font-medium text-muted-foreground lg-transition hover:text-foreground"
        >
          先不登录
        </button>}
      </p>
    </div>
  );
}
