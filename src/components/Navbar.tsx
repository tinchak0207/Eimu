"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BookOpen, CreditCard, History, LogOut, User } from "lucide-react";
import { WalletBadge } from "@/components/WalletBadge";
import { CheckinCalendar } from "@/components/CheckinCalendar";
import { SplitLoginButton } from "@/components/SplitLoginButton";
import { useAuth } from "@/hooks/use-auth";
import { getStoredToken } from "@/lib/new-api-client";
import { LOCAL_TEST_MODE } from "@/lib/sub2api";
import { cn } from "@/lib/utils";

interface NavbarProps {
  className?: string;
}

export function Navbar({ className }: NavbarProps) {
  const { user, isLoggedIn, logout, refresh } = useAuth();
  const [loginPhase, setLoginPhase] = useState<"idle" | "drawing">("idle");
  const popupRef = useRef<Window | null>(null);

  // OAuth 在 popup 中同步進行：點擊瞬間開 GitHub 授權窗，主頁原地播進度環。
  // 登入完成後主頁只做 refresh（重新同步 localStorage/cookie），不整頁 reload，
  // 因此 UI 平滑轉到登入態，不受 reload 的脆弱依賴影響。
  const startGithubLogin = () => {
    if (loginPhase === "drawing" && popupRef.current && !popupRef.current.closed) return;
    const popup = window.open("/api/auth/github/start", "github_oauth", "popup,width=760,height=640");
    if (!popup) {
      // popup 被擋：退回整頁跳轉。
      window.location.href = "/api/auth/github/start";
      return;
    }
    popupRef.current = popup;
    setLoginPhase("drawing");
    pollForAuthComplete();
  };

  const startWechatLogin = () => {
    const popup = window.open("/wechat-login", "wechat_oauth", "popup,width=440,height=640");
    if (!popup) {
      window.location.href = "/wechat-login";
    }
  };

  // postMessage 是主通道；輪詢是 fallback——message 遺失時，只要 popup 的
  // complete 頁已把 cookie 同步進共享 localStorage，主頁偵測到就 refresh。
  const pollForAuthComplete = () => {
    const startedAt = Date.now();
    const pollId = window.setInterval(async () => {
      if (getStoredToken()) {
        window.clearInterval(pollId);
        popupRef.current = null;
        setLoginPhase("idle");
        await refresh();
        return;
      }
      if (popupRef.current?.closed && Date.now() - startedAt > 5000) {
        window.clearInterval(pollId);
        setLoginPhase("idle");
      }
    }, 700);
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "github-auth-complete") {
        popupRef.current = null;
        setLoginPhase("idle");
        void refresh();
      }
      if (event.data?.type === "wechat-auth-complete") {
        void refresh();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [refresh]);
  return (
    <>
      <header
        id="global-navbar"
        className={cn(
          "page-shell pointer-events-none relative z-40 mt-2",
          className,
        )}
      >
        <nav
          className="lg-bar pointer-events-auto flex w-full items-center justify-between gap-2 rounded-ios-3xl px-2.5 py-2 sm:px-5 sm:py-2.5"
          aria-label="主导航"
        >
          <Link
            href="/"
            className="flex min-w-0 shrink-0 items-center gap-2.5 rounded-full lg-transition hover:opacity-70 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
            aria-label="回到首页"
          >
            {/* Eimu app icon */}
            <div className="lg-float flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-ios-lg sm:h-8 sm:w-8">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/icon.png" alt="Eimu" width={44} height={44} className="h-full w-full object-cover" />
            </div>
            <span className="hidden text-ios-body font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:inline">
              Eimu
            </span>
          </Link>

          {/* Right side */}
          <div
            className={cn(
              "mobile-nav-actions flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:flex-none sm:gap-3",
              isLoggedIn && user
                ? ""
                : "flex-none gap-2",
            )}
          >
            {LOCAL_TEST_MODE ? (
              <div className="rounded-full bg-[rgba(255,255,255,0.28)] px-3 py-1.5 text-ios-caption1 font-medium text-[rgba(0,0,0,0.52)]">
                本地测试
              </div>
            ) : isLoggedIn && user ? (
              <>
                <WalletBadge showTopUp={false} showCheckin={false} className="mobile-wallet-balance min-w-0 flex-1 sm:flex-none" />

                {/* Nav links — icons only, text stays hidden for screen readers */}
                <CheckinCalendar className="shrink-0" />
                <Link
                  href="/history"
                  className="lg-float flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.78)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
                  aria-label="历史"
                >
                  <History className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">历史</span>
                </Link>
                {/* 这里曾有一颗「助理」导航链接，指向 /agent 独立页。已移除：
                    AI 助理是首页卡片上的一个 toggle，不是一个去处。
                    导航栏摆个入口会把人带离卡片，正好是使用者不要的那种交互。 */}
                <Link
                  href="/docs"
                  className="lg-float flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.78)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
                  aria-label="文档"
                >
                  <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">文档</span>
                </Link>
                <Link
                  href="/pricing"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#007AFF] shadow-[0_4px_16px_rgba(0,122,255,0.26)] lg-transition hover:bg-[#0066DD] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.45)] focus-visible:ring-offset-2"
                  aria-label="充值"
                >
                  <CreditCard className="h-3.5 w-3.5 text-white" aria-hidden="true" />
                  <span className="sr-only">充值</span>
                </Link>

                {/* User pill */}
                <div className="lg-float hidden shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 sm:flex">
                  <User className="h-3.5 w-3.5 text-[rgba(0,0,0,0.44)]" aria-hidden="true" />
                  <span className="max-w-[88px] truncate text-ios-footnote font-medium text-[rgba(0,0,0,0.56)]">
                    {user.display_name || user.username}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={logout}
                  className="lg-float hidden h-8 w-8 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.44)] lg-transition hover:text-[rgba(0,0,0,0.72)] cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] sm:flex"
                  aria-label="退出登录"
                >
                  <LogOut className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <SplitLoginButton
                onGithub={startGithubLogin}
                onWechat={startWechatLogin}
                githubBusy={loginPhase === "drawing" ? "正在连接 GitHub…" : null}
              />
            )}
          </div>
        </nav>
      </header>
    </>
  );
}
