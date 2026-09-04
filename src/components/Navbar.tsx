"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BookOpen, History, Images, KeyRound, LogOut } from "lucide-react";
import { WalletBadge } from "@/components/WalletBadge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { SplitLoginButton } from "@/components/SplitLoginButton";
import { useAuth } from "@/hooks/use-auth";
import { getStoredToken } from "@/lib/new-api-client";
import { LOCAL_TEST_MODE } from "@/lib/local-test-mode";
import { cn } from "@/lib/utils";

interface NavbarProps {
  className?: string;
}

export function Navbar({ className }: NavbarProps) {
  const { user, isLoggedIn, logout, refresh } = useAuth();
  const { toast } = useToast();
  const [loginPhase, setLoginPhase] = useState<"idle" | "drawing">("idle");
  const [copyingKey, setCopyingKey] = useState(false);
  const popupRef = useRef<Window | null>(null);

  /**
   * 钥匙按钮：一键复制可用的 API 密钥（2026-08-27 暴君裁定）。
   * 明文密钥只在签发响应里出现一次——所以逻辑是：
   * ① 先查现有密钥，取第一颗直接复制（密钥本体存 localStorage 的签发记录）；
   * ② 一颗都没有时现签一颗新的再复制。
   * 两种结果都用站内 toast 反馈（Liquid Glass 语言），失败也如实说。
   */
  const copyApiKey = async () => {
    if (copyingKey) return;
    const token = getStoredToken();
    if (!token || !user) {
      toast({ title: "尚未登录", description: "登录后才能复制 API 密钥。" });
      return;
    }
    setCopyingKey(true);
    const headers = { Authorization: `Bearer ${token}`, "x-user-id": String(user.id) };
    try {
      let plaintext: string | null = null;
      let created = false;
      // ① 已签发过的明文密钥缓存在 localStorage（签发时写入），直接取用。
      try {
        const cached = window.localStorage.getItem(`biz_key_plaintext_${user.id}`);
        if (cached && /^sk-/.test(cached)) plaintext = cached;
      } catch { /* ignore */ }
      // ② 没有缓存：签一颗新密钥（明文只在这次响应里出现）。
      if (!plaintext) {
        const res = await fetch("/api/user/biz-keys", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ label: "" }),
        });
        const json = (await res.json()) as { success: boolean; key?: string; message?: string };
        if (!json.success || !json.key) {
          toast({ title: "复制失败", description: json.message ?? "密钥签发失败，请到密钥页重试。" });
          return;
        }
        plaintext = json.key;
        created = true;
        try {
          window.localStorage.setItem(`biz_key_plaintext_${user.id}`, plaintext);
        } catch { /* ignore */ }
      }
      await navigator.clipboard.writeText(plaintext);
      toast({
        title: created ? "已签发并复制 API 密钥" : "已复制 API 密钥",
        description: "已复制到剪贴板，可直接粘贴到 DSH 插件等第三方工具。",
      });
    } catch {
      toast({ title: "复制失败", description: "剪贴板不可用，请到密钥页手动复制。" });
    } finally {
      setCopyingKey(false);
    }
  };

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
          // pt-2 而非 mt-2：body 无 border/padding 时子元素 margin-top 会折叠
          // 穿透，把整页推高 8px（html scrollHeight 恒 = 100vh + 8px）。
          // padding 不参与折叠，位置不变（nav 距页顶同为 8px）。
          "page-shell pointer-events-none relative z-40 pt-2",
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
                {/* 余额胶囊：余额 + 「+」合体——充值与签到都在「+」浮层里，
                    导航栏不再放独立入口（2026-08-27 暴君裁定）。 */}
                <WalletBadge showTopUp showCheckin className="mobile-wallet-balance min-w-0 flex-1 sm:flex-none" />

                {/* Nav links — icons only, text stays hidden for screen readers.
                    「文档」「审查页」只在 ≥sm 显示：手机端导航留给核心动作。 */}
                <Link
                  href="/history"
                  className="lg-float flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.78)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
                  aria-label="历史"
                >
                  <History className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">历史</span>
                </Link>
                <Link
                  href="/review"
                  className="lg-float hidden h-11 w-11 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.78)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] sm:flex"
                  aria-label="审查页"
                >
                  <Images className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">审查页</span>
                </Link>
                {/* 这里曾有一颗「助理」导航链接，指向 /agent 独立页。已移除：
                    AI 助理是首页卡片上的一个 toggle，不是一个去处。
                    导航栏摆个入口会把人带离卡片，正好是使用者不要的那种交互。 */}
                <Link
                  href="/docs"
                  className="lg-float hidden h-11 w-11 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.78)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] sm:flex"
                  aria-label="文档"
                >
                  <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">文档</span>
                </Link>

                {/* 钥匙（2026-08-27 暴君裁定）：专属小菜单只放 key 相关动作。 */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="API 密钥"
                      title="API 密钥"
                      className="lg-float hidden h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[#007AFF] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] sm:flex"
                    >
                      <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" sideOffset={8}>
                    <DropdownMenuItem onSelect={() => void copyApiKey()} className="cursor-pointer">
                      <KeyRound className="mr-2 h-3.5 w-3.5 text-[rgba(0,0,0,0.44)]" aria-hidden="true" />
                      {copyingKey ? "复制中…" : "复制 API 密钥"}
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/settings/api-keys" className="cursor-pointer">
                        <KeyRound className="mr-2 h-3.5 w-3.5 text-[rgba(0,0,0,0.44)]" aria-hidden="true" />
                        密钥管理
                      </Link>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* 用户名 + 退出（2026-08-27 暴君裁定：右侧按钮只承担退出）。
                    手机端（<sm）也必须显示：用户名文字隐藏、退出图标保留——
                    账户出口在手机上消失 = 用户无法登出。 */}
                <div className="lg-float flex shrink-0 items-center gap-1 rounded-full py-1 pl-3 pr-1">
                  <span className="hidden max-w-[88px] truncate text-ios-footnote font-medium text-[rgba(0,0,0,0.56)] sm:inline">
                    {user.display_name || user.username}
                  </span>
                  <button
                    type="button"
                    onClick={() => logout()}
                    aria-label="退出登录"
                    title="退出登录"
                    className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.44)] transition-colors duration-200 hover:bg-[rgba(255,59,48,0.10)] hover:text-[#D92E2E] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(255,59,48,0.30)]"
                  >
                    <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
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
