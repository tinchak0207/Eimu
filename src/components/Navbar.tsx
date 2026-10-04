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
import { useEimuShell } from "@/hooks/use-eimu-shell";
import { PwaHandoffPanel } from "@/components/PwaHandoffPanel";
import { ShellUpdatePrompt } from "@/components/ShellUpdatePrompt";
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

/** 手機 <640px 的 header 按鈕用「只有圖示」的極簡態：lg-float 的底/描邊/陰影/模糊全部歸零，
    ≥640px 桌面島上的 chip 原樣。 */
const FLAT_MOBILE_CHROME =
  "max-sm:border-0 max-sm:bg-transparent max-sm:shadow-none max-sm:[backdrop-filter:none] max-sm:[-webkit-backdrop-filter:none]";

/** 桌面＋手機一律極簡態（2026-10-04 header 降噪）：與 FLAT_MOBILE_CHROME 同一組
    utility，只是不限 max-sm——header 內的按鈕／連結全部玻璃底、描邊、陰影、模糊歸零，
    只剩圖示與文字；WalletBadge／logo／漢堡各有自己的材質，不套這組。 */
const FLAT_CHROME =
  "border-0 bg-transparent shadow-none [backdrop-filter:none] [-webkit-backdrop-filter:none]";

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
  // 桌面殼偵測（單一真相來源，與 WindowControls 共用）：殼內＝使用者已在 App 裡，
  // 「下載桌面版」是冗餘入口，且三顆視窗控制鈕需要這條右簇的寬度（首頁玻璃島被助理
  // 面板退縮後，1440/1280 下載鈕與右簇會重疊）。殼內隱藏它，換取控制鈕放得下。
  const eimuShell = useEimuShell();
  // 2026-09-24 首秒零回縮：導覽列退縮只屬首頁（助理工作站面）。--ws-navbar-inset
  // 的 fallback 在首頁指向「面板寬+12px」終態，其他頁恆 0——否則直接 reload
  // 非首頁時工作站未掛載、無人寫該變數，fallback 會把膠囊無緣無故退縮一格。
  const pathname = usePathname();
  const isHome = pathname === "/";
  const [loginPhase, setLoginPhase] = useState<"idle" | "drawing">("idle");
  const [copyingKey, setCopyingKey] = useState(false);
  const [pwaHandoffUrl, setPwaHandoffUrl] = useState<string | null>(null);
  const [qqOpen, setQqOpen] = useState(false);
  // 手機端（<sm）左側漢堡 → 整屏側欄（歷史／帳號動作在手機上的唯一入口）。
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const mobileHamburgerRef = useRef<HTMLButtonElement | null>(null);

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

  // 手機 ≤639.98px 的「捲動才上毛玻璃」：靜止態全透明（與頁面底色無縫），
  // 但捲動時卡片內容會從圖示底下穿過去，故 window.scrollY > 4 才把 nav 標成
  // data-nav-scrolled="true"（材質規則見 globals.css）。直接寫 DOM 屬性 + rAF
  // 節流、不 setState——捲動每幀都不該觸發 React 重渲染。首頁內容在自身容器滾、
  // window 不捲動，屬性恆 false，首頁永遠維持全透明。
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
    // 手機一律同窗口（2026-09-30）：新分頁＝人切去微信掃完回來停在登入頁，原頁
    // 沒人通知；同窗口登入完 /wechat-login 自己回首頁，待送的那句話由首頁補送。
    if (window.matchMedia("(pointer: coarse)").matches) {
      window.location.href = "/wechat-login";
      return;
    }
    const popup = window.open("/wechat-login", "wechat_oauth", "popup,width=440,height=640");
    if (!popup) {
      window.location.href = "/wechat-login";
      return;
    }
    // postMessage 遺失時的兜底：token 一落共享 localStorage 就 refresh。
    popupRef.current = popup;
    pollForAuthComplete();
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
      <AnnouncementSurfaces />
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
          // 手機 ≤639.98px 改平铺满血条：page-shell 的左右留白与顶部悬空一并归零。
          "page-shell pointer-events-none sticky top-0 z-[80] pt-2 max-sm:pt-0 max-sm:px-0",
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
            "lg-bar pointer-events-auto flex items-center justify-between gap-2 overflow-hidden rounded-ios-3xl px-2.5 py-2 sm:px-4 sm:py-2.5",
            // 桌面殼拖曳區：外殼移除原生 overlay 後，整條玻璃島＝拖曳把手；左右兩個
            // 直接子容器標 no-drag（按鈕都在裡面），justify-between 的中間空帶即可拖。
            // 普通瀏覽器對這組屬性 inert。詳見 globals.css .app-region-*。
            "app-region-drag",
            isHome
              ? "ml-[var(--ws-navbar-inset,calc(var(--ws-panel-w,420px)_+_0.75rem))] w-[calc(100%_-_var(--ws-navbar-inset,calc(var(--ws-panel-w,420px)_+_0.75rem)))]"
              : "ml-0 w-full",
            "max-md:ml-0 max-md:w-full",
            // 手機 ≤639.98px 完全融入頁面：無底/無框/無 blur/無陰影——底色即頁面底色，
            // 在任何頁面（首頁白卡、/pricing 的 #f5fbff…）都不會出現一條帶狀色差；
            // 半透＋模糊的「白」在實機又會渲成中性灰，故 blur 一併關閉。
            "max-sm:rounded-none max-sm:border-0 max-sm:bg-transparent max-sm:shadow-none max-sm:[backdrop-filter:none] max-sm:[-webkit-backdrop-filter:none] max-sm:px-3",
          )}
          aria-label="主导航"
        >
          {/* 左组：漢堡（僅 <sm）＋ Eimu Logo ＋ QQ 群入口。justify-between 下子元素
              多于两个会把中间的孩子顶到正中——Logo 与 QQ 钮必须包进同一个左组容器。 */}
          <div className={cn("flex min-w-0 shrink-0 items-center gap-2 sm:gap-2.5", "app-region-no-drag")}>
            {/* 漢堡鈕：手機端最左邊的側欄入口（歷史／退出／QQ 群都在側欄裡）。
              桌面 ≥sm 由元件自身的 sm:hidden 隱藏，右側桌面按鈕一個 pixel 不動。 */}
            <MobileNavHamburger
              onClick={() => setMobileNavOpen(true)}
              expanded={mobileNavOpen}
              buttonRef={mobileHamburgerRef}
            />
            <Link
              href="/"
              className="flex min-w-0 shrink items-center gap-2 rounded-full lg-transition hover:opacity-70 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] sm:gap-2.5"
              aria-label="回到首页"
            >
              {/* Eimu app icon。手機端同樣走極簡態：icon.png 四角是透明的，
                 底下那層 lg-float 的白圓角塊會透成一塊多餘的淺色方塊（header 已經
                  全透明了，它就成了唯一的殘留底色），故 <640px 一併歸零。 */}
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
                扫码入群。手机端（<sm）原本是直跳 QQ 加群页的图标——已移进左側側欄
                （MobileSidebar 底部），手機 top bar 收乾淨。 */}
            <button
              type="button"
              onClick={() => setQqOpen(true)}
              aria-label="交流群"
              title="交流群"
              className={`hidden min-w-0 shrink cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-ios-footnote font-semibold text-[rgba(0,0,0,0.60)] select-none lg-transition hover:text-[rgba(0,0,0,0.85)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] sm:inline-flex lg:px-3 ${FLAT_CHROME}`}
            >
              <QqLogo className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">交流群</span>
            </button>

            {/* 桌面版下載（2026-10-04，2026-10-04 二版）：一鍵直接識別平台並下載，
                不再開選單（暴君：「搞弹窗就有点蠢了」）。平台判定與下載動作全在
                DesktopDownloadButton／resolveDesktopDownload 內，這裡只放位置。
                macOS 仍只 toast 婉拒，行動裝置（unknown）因 <xl 斷點本來就看不到。
                殼內（eimuShell）隱藏——使用者已在桌面 App 裡，下載入口冗餘，
                且右簇要讓位給三顆視窗控制鈕（見上方 eimuShell 註）。 */}
            {!eimuShell && <DesktopDownloadButton variant="icon" className={FLAT_CHROME} />}
          </div>

          {/* Right side */}
          <div
            className={cn(
              "mobile-nav-actions flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:gap-2 lg:gap-3",
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
                  className={`hidden h-11 w-11 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.78)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] sm:flex sm:h-9 sm:w-9 ${FLAT_CHROME}`}
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
                  className={`hidden h-11 w-11 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.78)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] sm:flex sm:h-9 sm:w-9 ${FLAT_CHROME}`}
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
                        "flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition sm:hover:text-[#007AFF] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] sm:flex sm:h-9 sm:w-9",
                        FLAT_CHROME,
                      )}
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
                    手机端（<sm）只出退出图标：帳戶出口留在 top bar，用户名文字仍
                    鎖在 lg:inline 不出現。 */}
                <div
                  className={cn(
                    "flex shrink-0 items-center gap-1 rounded-full py-1 pl-2.5 pr-1 lg:pl-3 sm:flex",
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

            {/* 桌面殼自訂視窗控制（最小化／最大化·還原／關閉），右簇最末端——
                與原生視窗鈕原位置語義一致。僅殼內渲染（window.eimuShell 存在時），
                普通瀏覽器回 null。詳見 WindowControls.tsx。 */}
            <WindowControls />
          </div>
        </nav>
      </header>

      {/* 舊桌面殼更新提示（渲染 null，只跑 useEffect；全站生效，見 ShellUpdatePrompt.tsx）。 */}
      <ShellUpdatePrompt />

      {/* QQ 群二维码弹窗（仅桌面端入口会打开；手机端走直跳链接）。 */}
      <QqGroupDialog open={qqOpen} onClose={() => setQqOpen(false)} />

      {/* 手機端整屏側欄（portal 到 body；桌面 <sm 不掛載）。 */}
      <MobileSidebar
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        triggerRef={mobileHamburgerRef}
      />
    </>
  );
}
