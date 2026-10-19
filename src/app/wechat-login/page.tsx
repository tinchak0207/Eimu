"use client";

import { useCallback } from "react";
import { MessageCircle } from "lucide-react";
import { useWechatScanLogin } from "@/hooks/use-wechat-scan-login";
import { WechatScanQr } from "@/components/WechatScanQr";
import { clearPendingTrial } from "@/components/promo/promo-gate";

/**
 * 微信扫码登入页（Navbar 以 popup 开；popup 被挡或手机同窗口时整页进来）。
 *
 * 2026-09-30：取消验证码——扫到带参数二维码就直接登入。
 * 收尾两条路都要有回应（旧版同窗口进来时停在「正在返回…」永远不返回）：
 * - popup：通知 opener（它会 refresh 登入态并补送待送的那句话）后自己关；
 * - 同窗口：直接回首页，首页的「登入态翻真 → 补送」接手。
 */
export default function WechatLoginPage() {
  const handleDone = useCallback(() => {
    const opener = window.opener as Window | null;
    if (opener && !opener.closed) {
      try {
        opener.postMessage({ type: "wechat-auth-complete" }, window.location.origin);
      } catch {
        // opener 不可达：token 已在共享 localStorage，opener 的轮询兜底会接住。
      }
      window.setTimeout(() => window.close(), 400);
      // 有些手机浏览器不让脚本关分页：关不掉就自己回首页，不留在成功画面发呆。
      // 这个分页的 sessionStorage 是开窗时从 opener 复制来的，待送那句话也在里面：
      // 先清掉，否则 opener 与这里各补送一次＝同一句话送两遍。
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
      <meta name="robots" content="noindex, nofollow" />
      <div className="lg-card w-[380px] max-w-full rounded-ios-lg p-7 text-center">
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
