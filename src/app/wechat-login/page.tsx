"use client";

import { useCallback } from "react";
import { MessageCircle } from "lucide-react";
import { useWechatScanLogin } from "@/hooks/use-wechat-scan-login";
import { WechatScanQr } from "@/components/WechatScanQr";
import { clearPendingTrial } from "@/components/promo/promo-gate";

/**
 * 微信掃碼登入頁（Navbar 以 popup 開；popup 被擋或手機同窗口時整頁進來）。
 *
 * 2026-09-30：取消驗證碼——掃到帶參數二維碼就直接登入。
 * 收尾兩條路都要有回應（舊版同窗口進來時停在「正在返回…」永遠不返回）：
 * - popup：通知 opener（它會 refresh 登入態並補送待送的那句話）後自己關；
 * - 同窗口：直接回首頁，首頁的「登入態翻真 → 補送」接手。
 */
export default function WechatLoginPage() {
  const handleDone = useCallback(() => {
    const opener = window.opener as Window | null;
    if (opener && !opener.closed) {
      try {
        opener.postMessage({ type: "wechat-auth-complete" }, window.location.origin);
      } catch {
        // opener 不可達：token 已在共享 localStorage，opener 的輪詢兜底會接住。
      }
      window.setTimeout(() => window.close(), 400);
      // 有些手機瀏覽器不讓腳本關分頁：關不掉就自己回首頁，不留在成功畫面發呆。
      // 這個分頁的 sessionStorage 是開窗時從 opener 複製來的，待送那句話也在裡面：
      // 先清掉，否則 opener 與這裡各補送一次＝同一句話送兩遍。
      window.setTimeout(() => {
        if (window.closed) return;
        clearPendingTrial(window.sessionStorage);
        window.location.replace("/");
      }, 1200);
      return;
    }
    window.setTimeout(() => window.location.replace("/"), 400);
  }, []);
  const login = useWechatScanLogin({ onDone: handleDone });

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#f5f5f7] px-4">
      <div className="w-[380px] max-w-full rounded-[20px] bg-white p-7 text-center shadow-[0_12px_40px_rgba(0,0,0,0.08)]">
        <span className="mx-auto mb-3 flex h-[52px] w-[52px] items-center justify-center rounded-2xl bg-[#07C160]">
          <MessageCircle size={26} color="#fff" aria-hidden="true" />
        </span>
        <h1 className="mb-1 text-[18px] font-semibold text-foreground">微信扫码登录</h1>
        <p className="mb-5 text-[13px] text-muted-foreground">扫码即登录，无需验证码</p>
        <WechatScanQr login={login} size={220} />
      </div>
    </main>
  );
}
