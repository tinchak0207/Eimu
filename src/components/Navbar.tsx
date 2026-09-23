"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
import { isStandalonePwa, createHandoffLogin } from "@/lib/github-login";
import { PwaHandoffPanel } from "@/components/PwaHandoffPanel";
import { QqGroupDialog } from "@/components/QqGroupDialog";

interface NavbarProps {
  className?: string;
}

/** QQ 官方加群分享页（手机端点击直达 QQ 加入群聊）。 */
const QQ_GROUP_SHARE_URL =
  "https://qun.qq.com/universal-share/share?ac=1&authKey=9xurH8dNqoFL3AWNrbML8MG1zuxUY%2Blh2FnXaFJfMefKeuWvLYDkPmxvM%2BF%2FxMn8&busi_data=eyJncm91cENvZGUiOiI5ODAxMjIxNzUiLCJ0b2tlbiI6IldYSHVmYXZzU0NmK05IMFVnNXM5cDE2amM0YzBjUGxhUHhvTUx5VDAwcmpXQUtKMWtNSk9HMnA1QmFXVTVHdlMiLCJ1aW4iOiIxNDY1Njg3MDc5In0%3D&data=NUunOBhKAsWIJULcoBA6QFyTGfPWRPd0kWwWxRnxURNQs18QrZFUb2LLJOLhQlOdOveuWXfmT64NqyzIiFtqLA&svctype=4&tempid=h5_group_info";

/** QQ 企鹅徽标：官方 Simple Icons 剪影（品牌蓝 #12B7F5），内嵌无外部依赖。 */
function QqLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fill="#12B7F5"
        d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673"
      />
    </svg>
  );
}

/** auth_error 代碼 → 人話（callback 失敗原因碼見 /api/auth/github|google/callback）。 */
function describeAuthError(code: string): string {
  if (code === "github_state") return "登录窗口状态过期或同时开了多个登录窗，请重新点登录。";
  if (code === "github_config") return "GitHub 登录未配置，请联系管理员。";
  if (code.startsWith("github_login")) return "网关拒绝了本次登录，请重试；持续失败请联系管理员。";
  if (code.startsWith("github_register")) return "自动开户失败，请稍后重试。";
  if (code.startsWith("github_exchange")) return "GitHub 授权码交换失败，请重新点登录。";
  if (code === "google_state") return "登录窗口状态过期或同时开了多个登录窗，请重新点登录。";
  if (code === "google_config") return "Google 登录暂未开放，请改用 GitHub 或微信登录。";
  if (code.startsWith("google_login")) return "网关拒绝了本次登录，请重试；持续失败请联系管理员。";
  if (code.startsWith("google_register")) return "自动开户失败，请稍后重试。";
  if (code.startsWith("google_exchange")) return "Google 授权码交换失败，请重新点登录。";
  if (code.startsWith("google_")) return "登录流程被打断，请重新点登录。";
  return "登录流程被打断，请重新点登录。";
}

export function Navbar({ className }: NavbarProps) {
  const { user, isLoggedIn, logout, refresh } = useAuth();
  const { toast } = useToast();
  // 2026-09-24 首秒零回縮：導覽列退縮只屬首頁（助理工作站面）。--ws-navbar-inset
  // 的 fallback 在首頁指向「面板寬+12px」終態，其他頁恆 0——否則直接 reload
  // 非首頁時工作站未掛載、無人寫該變數，fallback 會把膠囊無緣無故退縮一格。
  const pathname = usePathname();
  const isHome = pathname === "/";
  const [loginPhase, setLoginPhase] = useState<"idle" | "drawing">("idle");
  const [copyingKey, setCopyingKey] = useState(false);
  const [pwaHandoffUrl, setPwaHandoffUrl] = useState<string | null>(null);
  const [qqOpen, setQqOpen] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const apply = () => {
      document.documentElement.style.setProperty("--site-header-offset", `${el.offsetHeight}px`);
      // 助理工作站與導覽列同一條基準線：量頁殼（nav 內容盒）左右緣。
      const nav = el.querySelector("nav");
      if (nav) {
        const rect = nav.getBoundingClientRect();
        // 2026-09-24 navbar 右退刀：nav 的 margin-left 現在可能是
        // --ws-navbar-inset（助理面板吃頂後的退縮量）。直接量 rect.left 會把
        // 退縮量混進 --site-shell-left，再灌回面板/overlay 的 left＝反馈漂移，
        // 減掉它才是「未退縮前」的頁殼真左緣（右緣因 ml+寬度互補恆定，不用扣）。
        const inset = parseFloat(getComputedStyle(nav).marginLeft) || 0;
        document.documentElement.style.setProperty("--site-shell-left", `${rect.left - inset}px`);
        document.documentElement.style.setProperty("--site-shell-right", `${window.innerWidth - rect.right}px`);
      }
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    window.addEventListener("resize", apply);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, []);

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
    // PWA standalone：GitHub 登录态带不进来，改走跨浏览器交接面板（popup 逻辑不动）。
    if (isStandalonePwa()) {
      void createHandoffLogin().then((handoff) => {
        if (handoff) {
          setPwaHandoffUrl(handoff.loginUrl);
          return;
        }
        window.location.href = "/api/auth/github/start";
      });
      return;
    }
    if (loginPhase === "drawing" && popupRef.current && !popupRef.current.closed) return;
    // 登录一律同窗口跳转：popup 在套壳/内嵌 webview 上会出现「窗口对象存在但
    // 内容停在 about:blank」的死窗（三個完成信号全部不來，永久卡死），且无法
    // 与正常跨域授权页区分。同窗口跳转全浏览器兼容，callback 落 /auth/complete
    // 后 replace("/") 回主页，由 AuthProvider mount 自愈登录态。
    window.location.href = "/api/auth/github/start";
  };

  // Google 登入與 GitHub 逐行同構（provider 不同），兩條鏈路行為必須一致：
  // standalone 走跨瀏覽器交接，其餘同窗口跳轉由 callback 落 /auth/complete 自愈。
  const startGoogleLogin = () => {
    // PWA standalone：Google 登录态带不进来，改走跨浏览器交接面板（popup 逻辑不动）。
    if (isStandalonePwa()) {
      void createHandoffLogin("google").then((handoff) => {
        if (handoff) {
          setPwaHandoffUrl(handoff.loginUrl);
          return;
        }
        window.location.href = "/api/auth/google/start";
      });
      return;
    }
    if (loginPhase === "drawing" && popupRef.current && !popupRef.current.closed) return;
    // 登录一律同窗口跳转：popup 在套壳/内嵌 webview 上会出现「窗口对象存在但
    // 内容停在 about:blank」的死窗（三個完成信号全部不來，永久卡死），且无法
    // 与正常跨域授权页区分。同窗口跳转全浏览器兼容，callback 落 /auth/complete
    // 后 replace("/") 回主页，由 AuthProvider mount 自愈登录态。
    window.location.href = "/api/auth/google/start";
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
      if (event.data?.type === "github-auth-error") {
        // 弹窗里的 callback 失敗由弹窗自己转发过来（見下方 auth_error 處理）。
        popupRef.current = null;
        setLoginPhase("idle");
        toast({ title: "GitHub 登录未完成", description: describeAuthError(String(event.data?.code ?? "")) });
      }
      if (event.data?.type === "wechat-auth-complete") {
        void refresh();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [refresh, toast]);

  /**
   * OAuth 回調失敗的收口（2026-09-05 修「点了登录按钮回调没被接收」）：
   * callback 路由把一切失敗重定向到 /?auth_error=<原因>，但前端從沒人讀這個參數——
   * 弹窗靜默停在首頁、主頁輪詢 popup.closed 永不到來，用戶看不到任何報錯。
   * 弹窗內（有 opener）：把失敗轉發給 opener 並自我關閉；
   * 主頁：toast 出人話並抹掉 URL 參數。
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("auth_error");
    if (!authError) return;
    params.delete("auth_error");
    const qs = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage({ type: "github-auth-error", code: authError }, window.location.origin);
      } catch { /* opener 不可達：降級為本頁 toast */ }
      window.close();
      return;
    }
    toast({ title: "GitHub 登录未完成", description: describeAuthError(authError) });
  }, [toast]);
  return (
    <>
      {pwaHandoffUrl && (
        <PwaHandoffPanel
          loginUrl={pwaHandoffUrl}
          onSuccess={() => {
            // 等效 popup 完成信號處理器：抹掉面板 + refresh 刷新登入態。
            setPwaHandoffUrl(null);
            void refresh();
          }}
          onClose={() => setPwaHandoffUrl(null)}
        />
      )}
      <header
        id="global-navbar"
        ref={headerRef}
        className={cn(
          // pt-2 而非 mt-2：body 无 border/padding 时子元素 margin-top 会折叠
          // 穿透，把整页推高 8px（html scrollHeight 恒 = 100vh + 8px）。
          // padding 不参与折叠，位置不变（nav 距页顶同为 8px）。
          "page-shell pointer-events-none sticky top-0 z-[80] pt-2",
          className,
        )}
      >
        {/* 2026-09-24 暴君裁定「header 往右退縮，讓 AI 助理占上來，吃滿天花板」＋
            同刀「首秒零回縮」：margin-left/寬度仍消費 --ws-navbar-inset，但 fallback
            改指面板寬終態 calc(var(--ws-panel-w)+12px)——SSR 首幀即退縮態，不再
            等 JS effect 從 0px 動畫退縮（病灶①）。過度動畫的類別已從本行移除：
            只在 html[data-ws-settled]（工作站掛載穩定後寫）下生效，規則見
            CanvasChatWorkstation 的 <style> 塊。max-md 歸零＝手機全屏抽屜態
            導覽列不讓位。非首頁恆 0（isHome 分支）。 */}
        <nav
          className={cn(
            "lg-bar pointer-events-auto flex items-center justify-between gap-2 rounded-ios-3xl px-2.5 py-2 sm:px-5 sm:py-2.5",
            isHome
              ? "ml-[var(--ws-navbar-inset,calc(var(--ws-panel-w,420px)_+_12px))] w-[calc(100%_-_var(--ws-navbar-inset,calc(var(--ws-panel-w,420px)_+_12px)))]"
              : "ml-0 w-full",
            "max-md:ml-0 max-md:w-full",
          )}
          aria-label="主导航"
        >
          {/* 左组：Eimu Logo + QQ 群入口。justify-between 下子元素多于两个会把
              中间的孩子顶到正中——Logo 与 QQ 钮必须包进同一个左组容器。 */}
          <div className="flex min-w-0 shrink-0 items-center gap-2 sm:gap-2.5">
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

            {/* QQ 群入口（2026-09-21 暴君特许，紧贴 Logo）：
                手机端（<sm）直达 QQ 加群分享页；桌面端（≥sm）像余额胶囊一样
                带文字「售后/交流群组」，点击弹出群二维码扫码入群。 */}
            <a
              href={QQ_GROUP_SHARE_URL}
              aria-label="售后/交流群组"
              className="lg-float flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.78)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] sm:hidden"
            >
              <QqLogo className="h-4 w-4" />
            </a>
            <button
              type="button"
              onClick={() => setQqOpen(true)}
              aria-label="售后/交流群组"
              title="售后/交流群组"
              className="lg-float hidden shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full bg-[rgba(0,0,0,0.05)] px-3 py-1.5 text-ios-footnote font-semibold text-[rgba(0,0,0,0.60)] select-none lg-transition hover:bg-[rgba(0,0,0,0.08)] hover:text-[rgba(0,0,0,0.85)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] sm:inline-flex"
            >
              <QqLogo className="h-3.5 w-3.5" />
              <span>售后/交流群组</span>
            </button>
          </div>

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
                  <DropdownMenuContent align="end" sideOffset={8} className="z-[90]">
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
                onGoogle={startGoogleLogin}
                onGithub={startGithubLogin}
                onWechat={startWechatLogin}
                githubBusy={loginPhase === "drawing" ? "正在连接 GitHub…" : null}
              />
            )}
          </div>
        </nav>
      </header>

      {/* QQ 群二维码弹窗（仅桌面端入口会打开；手机端走直跳链接）。 */}
      <QqGroupDialog open={qqOpen} onClose={() => setQqOpen(false)} />
    </>
  );
}
