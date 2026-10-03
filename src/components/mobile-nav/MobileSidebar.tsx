"use client";

// 手機端（<sm）左側漢堡 → 整屏側欄（2026-10-03 對標 Grok 手機端側欄）。
//
// 為什麼要有這支：手機端原本只有 logo 與餘額膠囊，歷史藏在助理頂欄一顆圖示的
// 小浮層裡，全站導覽（技能／工作流／定價／狀態／幫助）在手機上根本沒有入口。
// Grok 的側欄是一級公民：頭像＋方案副標／大圖示導覽列／Conversations 分節
// （標題兩行＋相對日期＋當前高亮）／底部浮動玻璃條。這裡照它的骨架做。
//
// 兩件事跟 Grok 不同的地方，都是本專案的既有約束，不是抄漏：
//   ① 會話列表直接複用既有 AgentSessionList（含兩行截斷／相對日期／空態／搜尋過濾），
//      標題格式化用 AgentChatSurface 已 export 的 formatSessionLabel（唯一實作，
//      不複製第二份）；但**只能動態 import**（見 loadFormatSessionLabel）：本側欄
//      掛在 root layout 的 Navbar 下，靜態 import 會把整條 agent-chat 模組圖拉進
//      全站每一頁。點某一列＝走既有深鏈 `/?agent=1&session=<id>`，不新造切換路徑。
//   ② Navbar 在 root layout，拿不到首頁 AgentChatSurface 的 startNewSession；
//      新對話 FAB 走既有入口 `/?agent=1`（首頁 agent 面）。找不到全域建號入口時
//      這是規格允許的退化，已在回報寫明。
//
// 地雷（mobile-agent-parity-traps-2026-10-03 地雷①）：Navbar 的祖先鏈有
// `lg-bar` / `lg-float`（backdrop-filter / transform 會建立 fixed 後代的
// containing block），留在 Navbar 子樹裡的 `position: fixed; inset: 0` 只會覆蓋
// 那顆膠囊。所以側欄一律 createPortal 到 document.body。
//
// 材質沿用本專案已定案的彈層底 `.agent-pop`（0.96 白＋blur，彈層要讀字）；
// 這裡不 import agent-chat.css（那支會被另一路 agent 改），字面配方寫進
// mobile-sidebar.css 的 .mobile-sidebar-panel。

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  BadgeDollarSign,
  CircleHelp,
  History,
  Images,
  LifeBuoy,
  LogOut,
  Menu,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  Workflow,
  X,
} from "lucide-react";
import { AgentSessionList } from "@/components/agent-chat/AgentSessionList";
import { useAuth } from "@/hooks/use-auth";
import { useIsNarrow } from "@/hooks/use-is-narrow";
import { listAgentSessions, type AgentSessionSummary } from "@/lib/agent-chat-client";
import { loadPersisted } from "@/lib/agent-chat-persistence";
import { getCurrentAgentSession } from "@/lib/agent-current-session";
import { cn } from "@/lib/utils";
import "./mobile-sidebar.css";

/** 會話標題格式化（唯一實作在 AgentChatSurface，見其 formatSessionLabel）。 */
type SessionLabelFormatter = (it: AgentSessionSummary) => string;

/**
 * 動態取唯一實作——**不准**在這裡靜態 import AgentChatSurface（膨脹，2026-10-03）：
 * Navbar 在 root layout，靜態 import 會把整條 agent-chat 模組圖（AgentChatSurface
 * → AgentChatPanel → agent-chat.css → RerunDialog…）拉進全站每一頁的初次載入；
 * 原本只有首頁／助理面需要它。改成側欄真的要列會話時才 `await import` 取那「一個」
 * 函式，讓 webpack 把它切成非同步 chunk（只在使用者的側欄打開時下載）。
 * Promise 記憶化：同一 session 內重開側欄不重複請求同一模組。
 */
let formatSessionLabelPromise: Promise<SessionLabelFormatter> | null = null;
function loadFormatSessionLabel(): Promise<SessionLabelFormatter> {
  formatSessionLabelPromise ??= import("@/components/agent-chat/AgentChatSurface").then(
    (m) => m.formatSessionLabel,
  );
  return formatSessionLabelPromise;
}

/**
 * 僅在動態 import 失敗（實務上不可能：模組是同一份部署產物）時用的降級：
 * 只回網關標題或空字串，**不複製** formatSessionLabel 的時間合成邏輯
 * （唯一實作仍留在 AgentChatSurface，別讓它漂移成第二份）。
 */
function fallbackSessionLabel(it: AgentSessionSummary): string {
  return typeof it.title === "string" ? it.title.trim() : "";
}

/**
 * 讀既有 localStorage 存檔裡的 sessionId（`AGENT_CHAT_STORAGE_KEY` 的
 * `sessionId` 欄位）：只作側欄當前高亮的**後備**——首頁／助理面已把活躍會話同步進
 * 唯讀鏡像（@/lib/agent-current-session），有鏡像時優先用它；agent 面未掛載的頁面
 * （例如 /history）才走這裡。直接用既有 lib 的讀取函式，不新造第三套 session 狀態、
 * 不重寫 parser：loadPersisted 已照既有 sanitize 慣例吞掉 SSR／隱私模式／無存檔／
 * JSON 壞／schema 不符／逾 24h，一律回 null（絕不 throw）。
 */
export function readPersistedSessionId(): string | null {
  return loadPersisted()?.sessionId ?? null;
}

/** QQ 官方加群分享页（手机端点击直达 QQ 加入群聊）。
 *  自 Navbar 搬來這裡：手機端入口移進側欄，Navbar 只剩桌面彈窗入口；
 *  QqLogo 由 Navbar import 使用（避免兩邊各存一份 SVG 路徑漂移）。 */
export const QQ_GROUP_SHARE_URL =
  "https://qun.qq.com/universal-share/share?ac=1&authKey=9xurH8dNqoFL3AWNrbML8MG1zuxUY%2Blh2FnXaFJfMefKeuWvLYDkPmxv%2BF%2FxMn8&busi_data=eyJncm91cENvZGUiOiI5ODAxMjIxNzUiLCJ0b2tlbiI6IldYSHVmYXZzU0NmK05IMFVnNXM5cDE2amM0YzBjUGxhUHhvTUx5VDAwcmpXQUtKMWtNSk9HMnA1QmFXVTVHdlMiLCJ1aW4iOiIxNDY1Njg3MDc5In0%3D&data=NUunOBhKAsWIJULcoBA6QFyTGfPWRPd0kWwWxRnxURNQs18QrZFUb2LLJOLhQlOdOveuWXfmT64NqyzIiFtqLA&svctype=4&tempid=h5_group_info";

/** QQ 企鹅徽标：官方 Simple Icons 剪影（品牌蓝 #12B7F5），内嵌无外部依赖。 */
export function QqLogo({ className }: { className?: string }) {
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

export interface MobileSidebarNavItem {
  href: string;
  label: string;
  icon: typeof History;
}

/**
 * 導覽列：只接「現場存在」的路由，逐條附出處。
 *   生成历史 /history      — src/app/history/page.tsx；Navbar 原有 /history 入口
 *   我的资产 /?agent=1     — 全站沒有獨立的資產路由，資產面板住在首頁 agent 面
 *                            （AgentChatSurface 的「我的资产」）；不發明 /assets 之類的新路由
 *   技能     /skills       — src/app/skills/page.tsx；SkillSlashMenu 同款連結
 *   工作流   /workflows    — src/app/workflows/page.tsx；UseCaseLinks 同款連結
 *   定价     /pricing      — src/app/pricing/page.tsx；WalletBadge 同款連結
 *   状态     /status       — src/app/status/page.tsx（Gatus 探針頁）
 *   帮助     /use-cases    — src/app/use-cases/page.tsx（站內既有內容入口）
 */
export const MOBILE_SIDEBAR_NAV: readonly MobileSidebarNavItem[] = [
  { href: "/history", label: "生成历史", icon: History },
  { href: "/?agent=1", label: "我的资产", icon: Images },
  { href: "/skills", label: "技能", icon: Sparkles },
  { href: "/workflows", label: "工作流", icon: Workflow },
  { href: "/pricing", label: "定价", icon: BadgeDollarSign },
  { href: "/status", label: "状态", icon: Activity },
  { href: "/use-cases", label: "帮助", icon: CircleHelp },
];

/** 只認「不帶 query 的路徑連結」的 active 態；`/?agent=1` 這類入口不冒充當前頁。 */
export function isSidebarNavActive(pathname: string, href: string): boolean {
  if (href.includes("?")) return false;
  return pathname === href;
}

export interface MobileSidebarPanelProps {
  /** 當前路徑（由容器受控傳入，方便測試直接渲染純元件樹）。 */
  pathname: string;
  /** 已登入＝顯示名稱；未登入＝「未登录」。 */
  userName: string;
  /** 身份副標（Grok 的 Premium 位置）：已登入顯示 email／「已登录」，否則「未登录」。 */
  userSubtitle: string;
  isLoggedIn: boolean;
  onLogout: () => void;
  /** 會話目錄：null＝載入中，[]＝已載入但為空。 */
  sessions: AgentSessionSummary[] | null;
  /** 當前會話（＝活躍會話的唯讀鏡像，見 @/lib/agent-current-session；agent 面未掛載
   *  時退回既有 localStorage 存檔的 sessionId），null＝尚未建立／無存檔，
   *  此時沒有任何一列算「當前」。 */
  currentSessionId: string | null;
  /** 標題格式化：唯一實作由容器動態載入 AgentChatSurface.loadFormatSessionLabel 注入，
   *  不在此檔靜態 import（避免把 agent-chat 模組圖拉進全站）。 */
  formatLabel: SessionLabelFormatter;
  query: string;
  onQueryChange: (value: string) => void;
  /** 點某一列＝走既有深鏈（/?agent=1&session=<id>），非另造切換路徑。 */
  onPickSession: (sessionId: string) => void;
  /** 新對話（FAB 與空態 CTA 共用）＝既有入口 /?agent=1。 */
  onStartNew: () => void;
  onClose: () => void;
  closeButtonRef?: RefObject<HTMLButtonElement | null>;
  searchInputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * 純呈現層（零 hooks）：容器負責 portal／滾動鎖／焦點／資料載入，
 * 這裡只管長相與事件回呼，讓 node:test 能直接 renderToStaticMarkup 驗元素樹。
 */
export function MobileSidebarPanel({
  pathname,
  userName,
  userSubtitle,
  isLoggedIn,
  onLogout,
  sessions,
  currentSessionId,
  formatLabel,
  query,
  onQueryChange,
  onPickSession,
  onStartNew,
  onClose,
  closeButtonRef,
  searchInputRef,
}: MobileSidebarPanelProps) {
  return (
    <aside
      role="dialog"
      aria-modal="true"
      aria-label="主导航"
      className="mobile-sidebar-panel"
    >
      {/* 頂部身份：頭像＋名稱＋副標（Grok 的 avatar + handle + Premium）。 */}
      <header className="flex shrink-0 items-center gap-3 px-4 pb-1">
        <div className="lg-float flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.png" alt="" width={44} height={44} className="h-full w-full object-cover" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-ios-body font-semibold text-[rgba(0,0,0,0.85)]">
            {userName}
          </p>
          <p className="truncate text-ios-footnote text-[rgba(0,0,0,0.45)]">{userSubtitle}</p>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="关闭导航"
          className="flex h-11 w-11 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full bg-black/[0.05] text-[rgba(0,0,0,0.56)] transition-colors hover:bg-black/[0.09] hover:text-[rgba(0,0,0,0.85)] active:bg-black/[0.13] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] motion-reduce:transition-none [-webkit-tap-highlight-color:transparent]"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </header>

      {/* 導覽列：icon 20px＋標籤 17px，列高 ≥52px。
          標籤字級（text-ios-body＝17px）掛在內層 span 的**純字串 className** 上，
          不進 cn()：cn＝twMerge(clsx(...))，tailwind-merge 認不得自訂 token
          `text-ios-body`，會把它歸到 text-color 群組，然後被同一串後面的
          `text-[rgba(…)]` 顏色 class 吃掉（實測 twMerge 直接移除該 class）——
          之前掛在 cn 的 anchor 上，17px 從未生效、實際繼承 body 的 15px。
          span 走純 className 就繞過這個合併陷阱（見 mobile-sidebar.test.ts 探針）。 */}
      {/* 單一捲動容器：導覽＋「对话」清單＋退出/QQ 一起捲（清單不再自開第二條捲軸，
          避免巢狀捲動）。底部浮動玻璃條改絕對定位浮在最下（.mobile-sidebar-dock），
          這裡留出等高 padding-bottom，最後一列不會被蓋住。 */}
      <div className="mobile-sidebar-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-2">
        {/* 導覽列：icon 20px＋標籤 17px，列高 ≥52px。 */}
        <nav aria-label="主导航链接" className="pt-1">
          <ul className="flex flex-col">
            {MOBILE_SIDEBAR_NAV.map(({ href, label, icon: Icon }) => {
              const active = isSidebarNavActive(pathname, href);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    onClick={onClose}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-[52px] items-center gap-3.5 rounded-[14px] px-3 font-medium touch-manipulation transition-colors [-webkit-tap-highlight-color:transparent] motion-reduce:transition-none",
                      active
                        ? "bg-black/[0.05] text-[rgba(0,0,0,0.85)]"
                        : "text-[rgba(0,0,0,0.72)] hover:bg-black/[0.04] hover:text-[rgba(0,0,0,0.88)] active:bg-black/[0.07]",
                    )}
                  >
                    <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                    <span className="truncate text-ios-body">{label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* 對話分節：標題＋搜尋框＋既有 AgentSessionList（兩行截斷／相對日期／空態）。 */}
        <div className="flex flex-col pt-3">
          <p className="px-3 pb-1.5 text-ios-subhead font-semibold text-[rgba(0,0,0,0.45)]">
            对话
          </p>
          <div className="px-1 pb-2">
            <div className="lg-float flex h-11 items-center gap-2 rounded-[14px] px-3">
              <Search className="h-4 w-4 shrink-0 text-[rgba(0,0,0,0.45)]" aria-hidden="true" />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder="搜索对话"
                aria-label="搜索对话"
                className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-[rgba(0,0,0,0.40)]"
              />
            </div>
          </div>
          {/* 清單隨內容自然撐高，不再自開捲軸（避免巢狀捲動）。 */}
          <div className="px-1 pb-2">
            <AgentSessionList
              sessions={sessions}
              currentSessionId={currentSessionId}
              switchingTo={null}
              startingNew={false}
              query={query}
              formatLabel={formatLabel}
              onPick={onPickSession}
              onStartNew={onStartNew}
            />
          </div>
        </div>

        {/* 底部帳號動作：隨內容一起捲（浮動玻璃條另為絕對定位的 .mobile-sidebar-dock）。 */}
        <div className="pt-1">
          {isLoggedIn && (
            <div className="flex flex-col">
              <button
                type="button"
                onClick={onLogout}
                className="flex min-h-[52px] cursor-pointer touch-manipulation items-center gap-3.5 rounded-[14px] px-3 text-ios-body font-medium text-[rgba(0,0,0,0.72)] transition-colors hover:bg-black/[0.04] hover:text-[#D92E2E] active:bg-black/[0.07] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(255,59,48,0.30)] motion-reduce:transition-none [-webkit-tap-highlight-color:transparent]"
              >
                <LogOut className="h-5 w-5 shrink-0" aria-hidden="true" />
                <span className="truncate">退出登录</span>
              </button>
            </div>
          )}
          <div className="flex flex-col">
            <a
              href={QQ_GROUP_SHARE_URL}
              className="flex min-h-[52px] touch-manipulation items-center gap-3.5 rounded-[14px] px-3 text-ios-body font-medium text-[rgba(0,0,0,0.72)] transition-colors hover:bg-black/[0.04] hover:text-[rgba(0,0,0,0.88)] active:bg-black/[0.07] motion-reduce:transition-none [-webkit-tap-highlight-color:transparent]"
            >
              <QqLogo className="h-5 w-5 shrink-0" />
              <span className="truncate">加入 QQ 群</span>
            </a>
          </div>
        </div>
      </div>

      {/* 底部浮動玻璃條（齒輪／搜尋／黑色新對話 FAB）：絕對定位浮在最下，不參與捲動。 */}
      <div className="mobile-sidebar-dock">
        <div className="lg-bar flex items-center gap-2 rounded-full p-2">
          <Link
            href="/settings/api-keys"
            onClick={onClose}
            aria-label="设置"
            className="flex h-11 w-11 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full bg-black/[0.05] text-[rgba(0,0,0,0.62)] transition-colors hover:bg-black/[0.09] hover:text-[rgba(0,0,0,0.88)] active:bg-black/[0.13] [-webkit-tap-highlight-color:transparent]"
          >
            <Settings className="h-5 w-5" aria-hidden="true" />
          </Link>
          <button
            type="button"
            onClick={() => searchInputRef?.current?.focus()}
            className="flex h-11 min-w-0 flex-1 cursor-pointer touch-manipulation items-center gap-2 rounded-full bg-black/[0.05] px-4 text-left text-ios-body text-[rgba(0,0,0,0.45)] transition-colors hover:bg-black/[0.08] active:bg-black/[0.11] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] motion-reduce:transition-none [-webkit-tap-highlight-color:transparent]"
          >
            <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">搜索</span>
          </button>
          <button
            type="button"
            onClick={onStartNew}
            aria-label="新对话"
            className="flex h-12 w-12 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full bg-black text-white transition-transform hover:scale-[1.03] active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.45)] motion-reduce:transition-none [-webkit-tap-highlight-color:transparent]"
          >
            <SquarePen className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </aside>
  );
}

export interface MobileSidebarProps {
  open: boolean;
  onClose: () => void;
  /** 關閉後焦點還原處（Navbar 的漢堡鈕）。 */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * 容器：portal 到 document.body（地雷①）＋左滑入動畫＋遮罩／Esc／關閉鈕三條關閉
 * ＋body 滾動鎖（存原值再還原，與既有全出血鎖共存）＋開場焦點進側欄、關閉歸還
 * 漢堡鈕＋首次開啟載入會話目錄。
 */
export function MobileSidebar({ open, onClose, triggerRef }: MobileSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const narrow = useIsNarrow();
  const { user, isLoggedIn, logout } = useAuth();
  const [sessions, setSessions] = useState<AgentSessionSummary[] | null>(null);
  // 當前會話（當前高亮用）：開側欄時讀既有 localStorage 存檔，不用第三套狀態。
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  // 標題格式化：null＝唯一實作（AgentChatSurface）尚未動態載入完。
  const [formatLabel, setFormatLabel] = useState<SessionLabelFormatter | null>(null);
  const [query, setQuery] = useState("");
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // 只有手機（<sm）才算開啟：漢堡本身 sm:hidden；桌面若在開啟中拉寬，自動關閉。
  const active = open && narrow;

  // onClose 每次 Navbar render 都是新函式；用 ref 取值，effect 才不會被它反覆觸發
  // （依賴擺 onClose 會讓 effect 每次重跑＝一開就被自己關掉）。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 路由一變就收起：Navbar 在 root layout，側欄跨頁存活，不靠這個會在換頁後
  // 留一層關不掉的整屏面板。
  useEffect(() => {
    if (!open) return;
    onCloseRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // 首次開啟載入會話目錄（null＝載入中；失敗視為空）。
  useEffect(() => {
    if (!active || sessions !== null) return;
    let cancelled = false;
    void listAgentSessions()
      .then((list) => {
        if (!cancelled) setSessions(list);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [active, sessions]);

  // 動態載入唯一標題格式化（見 loadFormatSessionLabel）：側欄沒開就不下載
  // agent-chat chunk；Promise 記憶化，重開側欄不再請求。
  useEffect(() => {
    if (!active || formatLabel !== null) return;
    let cancelled = false;
    void loadFormatSessionLabel()
      .then((fmt) => {
        if (!cancelled) setFormatLabel(() => fmt);
      })
      .catch(() => {
        // 取不到唯一實作：維持降級格式化，不讓整個會話清單一起失敗。
      });
    return () => {
      cancelled = true;
    };
  }, [active, formatLabel]);

  // 當前會話高亮：優先用活躍會話的唯讀鏡像（見 @/lib/agent-current-session，
  // 真源是 AgentChatSurface 的 sessionId）；非首頁（agent 面未掛載）鏡像為 null，
  // 才退回讀既有存檔（壞 JSON／無存檔／逾 24h 一律 null）。
  useEffect(() => {
    if (!active) return;
    setCurrentSessionId(getCurrentAgentSession() ?? readPersistedSessionId());
  }, [active]);

  // Esc 關閉＋滾動鎖＋焦點進出。存原 overflow 再還原：首頁全出血有自己的
  // html/body 鎖，不能關掉側欄時把別人的鎖一起抹平。
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      triggerRef?.current?.focus();
    };
  }, [active, triggerRef]);

  // 收起時清掉搜尋詞：下次打開看到全量目錄，不是上一輪打一半的詞。
  useEffect(() => {
    if (!active) setQuery("");
  }, [active]);

  const handleLogout = (): void => {
    onClose();
    logout();
  };

  const handleStartNew = (): void => {
    onClose();
    router.push("/?agent=1");
  };

  const handlePickSession = (sessionId: string): void => {
    onClose();
    router.push(`/?agent=1&session=${encodeURIComponent(sessionId)}`);
  };

  if (!active || typeof document === "undefined") return null;

  const displayName = user ? user.display_name || user.username : "未登录";
  const subtitle = user ? user.email || "已登录" : "未登录";

  return createPortal(
    <div
      className="mobile-sidebar-scrim"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <MobileSidebarPanel
        pathname={pathname}
        userName={displayName}
        userSubtitle={subtitle}
        isLoggedIn={Boolean(isLoggedIn && user)}
        onLogout={handleLogout}
        sessions={sessions}
        currentSessionId={currentSessionId}
        formatLabel={formatLabel ?? fallbackSessionLabel}
        query={query}
        onQueryChange={setQuery}
        onPickSession={handlePickSession}
        onStartNew={handleStartNew}
        onClose={onClose}
        closeButtonRef={closeButtonRef}
        searchInputRef={searchInputRef}
      />
    </div>,
    document.body,
  );
}

/** 漢堡鈕（Navbar 手機端最左邊）：44×44，只在 <sm 出現（sm:hidden 契約）。 */
export function MobileNavHamburger({
  onClick,
  expanded,
  buttonRef,
}: {
  onClick: () => void;
  expanded: boolean;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-label="打开导航"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      className="lg-float flex h-11 w-11 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full text-[rgba(0,0,0,0.62)] lg-transition hover:text-[rgba(0,0,0,0.88)] active:bg-black/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] sm:hidden [-webkit-tap-highlight-color:transparent]"
    >
      <Menu className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}
