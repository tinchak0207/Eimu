"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, History, KeyRound, LogOut, Users } from "lucide-react";
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
import { DesktopDownloadButton } from "@/components/DesktopDownloadButton";
import { WindowControls } from "@/components/WindowControls";
import { ShellUpdatePrompt } from "@/components/ShellUpdatePrompt";
import { PwaHandoffPanel } from "@/components/PwaHandoffPanel";
import { QqGroupDialog } from "@/components/QqGroupDialog";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { AnnouncementSurfaces } from "@/components/notifications/AnnouncementSurfaces";
import {
  MobileNavHamburger,
  MobileSidebar,
  QqLogo,
} from "@/components/mobile-nav/MobileSidebar";

interface NavbarProps {
  className?: string;
}

/** 手机 <640px 的 header 按钮用「只有图示」的极简态：lg-float 的底/描边/阴影/模糊全部归零，
    ≥640px 桌面岛上的 chip 原样。 */
const FLAT_MOBILE_CHROME =
  "max-sm:border-0 max-sm:bg-transparent max-sm:shadow-none max-sm:[backdrop-filter:none] max-sm:[-webkit-backdrop-filter:none]";

/** 桌面＋手机一律极简态（2026-10-04 header 降噪）：与 FLAT_MOBILE_CHROME 同一组
    utility，只是不限 max-sm——header 内的按钮／连结全部玻璃底、描边、阴影、模糊归零，
    只剩图示与文字；WalletBadge／logo／汉堡各有自己的材质，不套这组。 */
const FLAT_CHROME =
  "border-0 bg-transparent shadow-none [backdrop-filter:none] [-webkit-backdrop-filter:none]";

/** auth_error 代码 → 人话（callback 失败原因码见 /api/auth/github|google/callback）。 */
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
  // 2026-09-24 首秒零回缩：导览列退缩只属首页（助理工作站面）。--ws-navbar-inset
  // 的 fallback 在首页指向「面板宽+12px」终态，其他页恒 0——否则直接 reload
  // 非首页时工作站未挂载、无人写该变数，fallback 会把胶囊无缘无故退缩一格。
  const pathname = usePathname();
  const isHome = pathname === "/";
  const [loginPhase, setLoginPhase] = useState<"idle" | "drawing">("idle");
  const [copyingKey, setCopyingKey] = useState(false);
  const [pwaHandoffUrl, setPwaHandoffUrl] = useState<string | null>(null);
  const [qqOpen, setQqOpen] = useState(false);
  // 手机端（<sm）左侧汉堡 → 整屏侧栏（历史／帐号动作在手机上的唯一入口）。
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const mobileHamburgerRef = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const apply = () => {
      document.documentElement.style.setProperty("--site-header-offset", `${el.offsetHeight}px`);
      // 助理工作站与导览列同一条基准线：量页壳（nav 内容盒）左右缘。
      const nav = el.querySelector("nav");
      if (nav) {
        const rect = nav.getBoundingClientRect();
        // 2026-09-24 navbar 右退刀：nav 的 margin-left 现在可能是
        // --ws-navbar-inset（助理面板吃顶后的退缩量）。直接量 rect.left 会把
        // 退缩量混进 --site-shell-left，再灌回面板/overlay 的 left＝反馈漂移，
        // 减掉它才是「未退缩前」的页壳真左缘（右缘因 ml+宽度互补恒定，不用扣）。
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

  // 手机 ≤639.98px 的「卷动才上毛玻璃」：静止态全透明（与页面底色无缝），
  // 但卷动时卡片内容会从图示底下穿过去，故 window.scrollY > 4 才把 nav 标成
  // data-nav-scrolled="true"（材质规则见 globals.css）。直接写 DOM 属性 + rAF
  // 节流、不 setState——卷动每帧都不该触发 React 重渲染。首页内容在自身容器滚、
  // window 不卷动，属性恒 false，首页永远维持全透明。
  useEffect(() => {
    const nav = headerRef.current?.querySelector("nav");
    if (!nav) return;
    let frame = 0;
    const apply = () => {
      frame = 0;
      nav.dataset.navScrolled = window.scrollY > 4 ? "true" : "false";
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(apply);
    };
    apply();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
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

  // OAuth 在 popup 中同步进行：点击瞬间开 GitHub 授权窗，主页原地播进度环。
  // 登入完成后主页只做 refresh（重新同步 localStorage/cookie），不整页 reload，
  // 因此 UI 平滑转到登入态，不受 reload 的脆弱依赖影响。
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
    // 内容停在 about:blank」的死窗（三个完成信号全部不来，永久卡死），且无法
    // 与正常跨域授权页区分。同窗口跳转全浏览器兼容，callback 落 /auth/complete
    // 后 replace("/") 回主页，由 AuthProvider mount 自愈登录态。
    window.location.href = "/api/auth/github/start";
  };

  // Google 登入与 GitHub 逐行同构（provider 不同），两条链路行为必须一致：
  // standalone 走跨浏览器交接，其余同窗口跳转由 callback 落 /auth/complete 自愈。
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
    // 内容停在 about:blank」的死窗（三个完成信号全部不来，永久卡死），且无法
    // 与正常跨域授权页区分。同窗口跳转全浏览器兼容，callback 落 /auth/complete
    // 后 replace("/") 回主页，由 AuthProvider mount 自愈登录态。
    window.location.href = "/api/auth/google/start";
  };

  const startWechatLogin = () => {
    // 手机一律同窗口（2026-09-30）：新分页＝人切去微信扫完回来停在登入页，原页
    // 没人通知；同窗口登入完 /wechat-login 自己回首页，待送的那句话由首页补送。
    if (window.matchMedia("(pointer: coarse)").matches) {
      window.location.href = "/wechat-login";
      return;
    }
    const popup = window.open("/wechat-login", "wechat_oauth", "popup,width=440,height=640");
    if (!popup) {
      window.location.href = "/wechat-login";
      return;
    }
    // postMessage 遗失时的兜底：token 一落共享 localStorage 就 refresh。
    popupRef.current = popup;
    pollForAuthComplete();
  };

  // postMessage 是主通道；轮询是 fallback——message 遗失时，只要 popup 的
  // complete 页已把 cookie 同步进共享 localStorage，主页侦测到就 refresh。
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
        // 弹窗里的 callback 失败由弹窗自己转发过来（见下方 auth_error 处理）。
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
   * OAuth 回调失败的收口（2026-09-05 修「点了登录按钮回调没被接收」）：
   * callback 路由把一切失败重定向到 /?auth_error=<原因>，但前端从没人读这个参数——
   * 弹窗静默停在首页、主页轮询 popup.closed 永不到来，用户看不到任何报错。
   * 弹窗内（有 opener）：把失败转发给 opener 并自我关闭；
   * 主页：toast 出人话并抹掉 URL 参数。
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
      } catch { /* opener 不可达：降级为本页 toast */ }
      window.close();
      return;
    }
    toast({ title: "GitHub 登录未完成", description: describeAuthError(authError) });
  }, [toast]);
  return (
    <>
      <AnnouncementSurfaces />
      {pwaHandoffUrl && (
        <PwaHandoffPanel
          loginUrl={pwaHandoffUrl}
          onSuccess={() => {
            // 等效 popup 完成信号处理器：抹掉面板 + refresh 刷新登入态。
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
          // 手机 ≤639.98px 改平铺满血条：page-shell 的左右留白与顶部悬空一并归零。
          "page-shell pointer-events-none sticky top-0 z-[80] pt-2 max-sm:pt-0 max-sm:px-0",
          className,
        )}
      >
        {/* 2026-09-24 暴君裁定「header 往右退缩，让 AI 助理占上来，吃满天花板」＋
            同刀「首秒零回缩」：margin-left/宽度仍消费 --ws-navbar-inset，但 fallback
            改指面板宽终态 calc(var(--ws-panel-w)+12px)——SSR 首帧即退缩态，不再
            等 JS effect 从 0px 动画退缩（病灶①）。过度动画的类别已从本行移除：
            只在 html[data-ws-settled]（工作站挂载稳定后写）下生效，规则见
            CanvasChatWorkstation 的 <style> 块。max-md 归零＝手机全屏抽屉态
            导览列不让位。非首页恒 0（isHome 分支）。 */}
        <nav
          className={cn(
            "lg-bar pointer-events-auto flex items-center justify-between gap-2 overflow-hidden rounded-ios-3xl px-2.5 py-2 sm:px-4 sm:py-2.5",
            // 桌面壳拖曳区：外壳移除原生 overlay 后，整条玻璃岛＝拖曳把手；左右两个
            // 直接子容器标 no-drag（按钮都在里面），justify-between 的中间空带即可拖。
            // 普通浏览器对这组属性 inert。详见 globals.css .app-region-*。
            "app-region-drag",
            isHome
              ? "ml-[var(--ws-navbar-inset,calc(var(--ws-panel-w,420px)_+_0.75rem))] w-[calc(100%_-_var(--ws-navbar-inset,calc(var(--ws-panel-w,420px)_+_0.75rem)))]"
              : "ml-0 w-full",
            "max-md:ml-0 max-md:w-full",
            // 手机 ≤639.98px 完全融入页面：无底/无框/无 blur/无阴影——底色即页面底色，
            // 在任何页面（首页白卡、/pricing 的 #f5fbff…）都不会出现一条带状色差；
            // 半透＋模糊的「白」在实机又会渲成中性灰，故 blur 一并关闭。
            "max-sm:rounded-none max-sm:border-0 max-sm:bg-transparent max-sm:shadow-none max-sm:[backdrop-filter:none] max-sm:[-webkit-backdrop-filter:none] max-sm:px-3",
          )}
          aria-label="主导航"
        >
          {/* 左组：汉堡（仅 <sm）＋ Eimu Logo ＋ QQ 群入口。justify-between 下子元素
              多于两个会把中间的孩子顶到正中——Logo 与 QQ 钮必须包进同一个左组容器。 */}
          <div className={cn("flex min-w-0 shrink-0 items-center gap-2 sm:gap-2.5", "app-region-no-drag")}>
            {/* 汉堡钮：手机端最左边的侧栏入口（历史／退出／QQ 群都在侧栏里）。
              桌面 ≥sm 由元件自身的 sm:hidden 隐藏，右侧桌面按钮一个 pixel 不动。 */}
            <MobileNavHamburger
              onClick={() => setMobileNavOpen(true)}
              expanded={mobileNavOpen}
              buttonRef={mobileHamburgerRef}
            />
            <Link
              href="/"
              className="flex min-w-0 shrink items-center gap-2 rounded-full lg-transition hover:opacity-70 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 sm:gap-2.5"
              aria-label="回到首页"
            >
              {/* Eimu app icon。手机端同样走极简态：icon.png 四角是透明的，
                 底下那层 lg-float 的白圆角块会透成一块多余的浅色方块（header 已经
                  全透明了，它就成了唯一的残留底色），故 <640px 一并归零。 */}
              <div
                className={cn(
                  "lg-float flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-ios-lg sm:h-8 sm:w-8",
                  FLAT_MOBILE_CHROME,
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icon.png" alt="Eimu" width={44} height={44} className="h-full w-full object-cover" />
              </div>
              <span className="hidden text-ios-body font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:inline">
                Eimu
              </span>
            </Link>

            {/* QQ 群入口（2026-09-21 暴君特许，紧贴 Logo）：
                桌面端（≥sm）像余额胶囊一样带文字「交流群」，点击弹出群二维码
                扫码入群。手机端（<sm）原本是直跳 QQ 加群页的图标——已移进左侧侧栏
                （MobileSidebar 底部），手机 top bar 收干净。 */}
            <button
              type="button"
              onClick={() => setQqOpen(true)}
              aria-label="交流群"
              title="交流群"
              className={`hidden min-w-0 shrink cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-ios-footnote font-semibold text-[rgba(0,0,0,0.60)] select-none lg-transition hover:text-[rgba(0,0,0,0.85)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 sm:inline-flex lg:px-3 ${FLAT_CHROME}`}
            >
              <QqLogo className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">交流群</span>
            </button>

            {/* 桌面版下载（2026-10-04，2026-10-04 二版）：一键直接识别平台并下载，
                不再开选单（暴君：「搞弹窗就有点蠢了」）。平台判定与下载动作全在
                DesktopDownloadButton／resolveDesktopDownload 内，这里只放位置。
                macOS 仍只 toast 婉拒，行动装置（unknown）因 <xl 断点本来就看不到。
                壳内由 DesktopDownloadButton 自我隐藏（单一真源，见该档）。 */}
            <DesktopDownloadButton variant="icon" className={FLAT_CHROME} />
          </div>

          {/* Right side */}
          <div
            className={cn(
              "mobile-nav-actions flex min-w-0 flex-1 items-center justify-end gap-1 sm:gap-1 lg:gap-1.5",
              "app-region-no-drag",
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
                    「文档」只在 ≥sm 显示：手机端导航留给核心动作。 */}
                <Link
                  href="/history"
                  className={`hidden h-11 w-11 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.78)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 sm:flex sm:h-9 sm:w-8 ${FLAT_CHROME}`}
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
                  className={`hidden h-11 w-11 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.78)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 sm:flex sm:h-9 sm:w-8 ${FLAT_CHROME}`}
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
                      className={cn(
                        "flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition sm:hover:text-[#007AFF] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 sm:flex sm:h-9 sm:w-8",
                        FLAT_CHROME,
                      )}
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
                    {/* 团队治理同样由 B 端密钥驱动（席位/角色/建画布开关/审批/解散/用量），
                        故归在同一把「密钥」小菜单下，不新开顶层入口。 */}
                    <DropdownMenuItem asChild>
                      <Link href="/settings/team" className="cursor-pointer">
                        <Users className="mr-2 h-3.5 w-3.5 text-[rgba(0,0,0,0.44)]" aria-hidden="true" />
                        团队管理
                      </Link>
                    </DropdownMenuItem>
                    {/* 站内通知：机制在、只此一个真业务（新人礼到账）；入口从 header 图示列搬进本菜单。
                        放最后不打断上面「密钥/团队」三连（那组是同一条 B 端密钥语义），
                        且通知是菜单里唯一面向普通用户的条目。 */}
                    <NotificationBell variant="menuItem" />
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* 用户名 + 退出（2026-08-27 暴君裁定：右侧按钮只承担退出）。
                    桌面端（≥sm）照旧：用户名文字在 ≥lg 显示、退出图标常驻。
                    手机端（<sm）只出退出图标：帐户出口留在 top bar，用户名文字仍
                    锁在 lg:inline 不出现。 */}
                <div
                  className={cn(
                    "flex shrink-0 items-center gap-1 rounded-full py-1 pl-1.5 pr-0.5 lg:pl-2 sm:flex",
                    FLAT_CHROME,
                  )}
                >
                  <span className="hidden max-w-[4.5rem] truncate text-ios-footnote font-medium text-[rgba(0,0,0,0.56)] lg:inline xl:max-w-[5.5rem]">
                    {user.display_name || user.username}
                  </span>
                  <button
                    type="button"
                    onClick={() => logout()}
                    aria-label="退出登录"
                    title="退出登录"
                    className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.44)] transition-colors duration-200 sm:hover:bg-[rgba(255,59,48,0.10)] sm:hover:text-[#D92E2E] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(255,59,48,0.30)] max-sm:h-11 max-sm:w-11"
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

            {/* 桌面壳「更新已就绪」提示（0.3.2+ 壳才有 update-ready）：下载完成后
                以产品语言告知并给一个「重启更新」动作，点击即 applyUpdate。仅壳内、
                且壳暴露了更新 API 时渲染；普通浏览器／旧壳回 null。详见 ShellUpdatePrompt.tsx。 */}
            <ShellUpdatePrompt />

            {/* 桌面壳自订视窗控制（最小化／最大化·还原／关闭），右簇最末端——
                与原生视窗钮原位置语义一致。仅壳内渲染（window.eimuShell 存在时），
                普通浏览器回 null。详见 WindowControls.tsx。 */}
            <WindowControls />
          </div>
        </nav>
      </header>

      {/* QQ 群二维码弹窗（仅桌面端入口会打开；手机端走直跳链接）。 */}
      <QqGroupDialog open={qqOpen} onClose={() => setQqOpen(false)} />

      {/* 手机端整屏侧栏（portal 到 body；桌面 <sm 不挂载）。 */}
      <MobileSidebar
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        triggerRef={mobileHamburgerRef}
      />
    </>
  );
}
