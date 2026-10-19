"use client";

// 手机端（<sm）左侧汉堡 → 整屏侧栏（2026-10-03 对标 Grok 手机端侧栏）。
//
// 为什么要有这支：手机端原本只有 logo 与余额胶囊，历史藏在助理顶栏一颗图示的
// 小浮层里，全站导览（技能／工作流／定价／状态／帮助）在手机上根本没有入口。
// Grok 的侧栏是一级公民：头像＋方案副标／大图示导览列／Conversations 分节
// （标题两行＋相对日期＋当前高亮）／底部浮动玻璃条。这里照它的骨架做。
//
// 两件事跟 Grok 不同的地方，都是本专案的既有约束，不是抄漏：
//   ① 会话列表直接复用既有 AgentSessionList（含两行截断／相对日期／空态／搜寻过滤），
//      标题格式化用 AgentChatSurface 已 export 的 formatSessionLabel（唯一实作，
//      不复制第二份）；但**只能动态 import**（见 loadFormatSessionLabel）：本侧栏
//      挂在 root layout 的 Navbar 下，静态 import 会把整条 agent-chat 模组图拉进
//      全站每一页。点某一列＝走既有深链 `/?agent=1&session=<id>`，不新造切换路径。
//   ② Navbar 在 root layout，拿不到首页 AgentChatSurface 的 startNewSession；
//      新对话 FAB 走既有入口 `/?agent=1`（首页 agent 面）。找不到全域建号入口时
//      这是规格允许的退化，已在回报写明。
//
// 地雷（mobile-agent-parity-traps-2026-10-03 地雷①）：Navbar 的祖先链有
// `lg-bar` / `lg-float`（backdrop-filter / transform 会建立 fixed 后代的
// containing block），留在 Navbar 子树里的 `position: fixed; inset: 0` 只会覆盖
// 那颗胶囊。所以侧栏一律 createPortal 到 document.body。
//
// 材质：底色为不透明纯白（#fff），由面板内层 .mobile-sidebar-bg 承载，面板本体
// 不挂 backdrop-filter；这里不 import agent-chat.css（那支会被另一路 agent 改），
// 字面配方写进 mobile-sidebar.css。

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BadgeDollarSign,
  History,
  Images,
  Menu,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePen,
  X,
} from "lucide-react";
import { AgentSessionList } from "@/components/agent-chat/AgentSessionList";
import { useAuth } from "@/hooks/use-auth";
import { useIsNarrow } from "@/hooks/use-is-narrow";
import { listAgentSessions, type AgentSessionSummary } from "@/lib/agent-chat-client";
import { loadPersisted } from "@/lib/agent-chat-persistence";
import { getCurrentAgentSession } from "@/lib/agent-current-session";
import {
  requestAgentSurfaceAction,
  type AgentSurfaceAction,
} from "@/lib/agent-surface-actions";
import { cn } from "@/lib/utils";
import "./mobile-sidebar.css";

/** 会话标题格式化（唯一实作在 AgentChatSurface，见其 formatSessionLabel）。 */
type SessionLabelFormatter = (it: AgentSessionSummary) => string;

/**
 * 动态取唯一实作——**不准**在这里静态 import AgentChatSurface（膨胀，2026-10-03）：
 * Navbar 在 root layout，静态 import 会把整条 agent-chat 模组图（AgentChatSurface
 * → AgentChatPanel → agent-chat.css → RerunDialog…）拉进全站每一页的初次载入；
 * 原本只有首页／助理面需要它。改成侧栏真的要列会话时才 `await import` 取那「一个」
 * 函式，让 webpack 把它切成非同步 chunk（只在使用者的侧栏打开时下载）。
 * Promise 记忆化：同一 session 内重开侧栏不重复请求同一模组。
 */
let formatSessionLabelPromise: Promise<SessionLabelFormatter> | null = null;
function loadFormatSessionLabel(): Promise<SessionLabelFormatter> {
  formatSessionLabelPromise ??= import("@/components/agent-chat/AgentChatSurface").then(
    (m) => m.formatSessionLabel,
  );
  return formatSessionLabelPromise;
}

/**
 * 仅在动态 import 失败（实务上不可能：模组是同一份部署产物）时用的降级：
 * 只回网关标题或空字串，**不复制** formatSessionLabel 的时间合成逻辑
 * （唯一实作仍留在 AgentChatSurface，别让它漂移成第二份）。
 */
function fallbackSessionLabel(it: AgentSessionSummary): string {
  return typeof it.title === "string" ? it.title.trim() : "";
}

/**
 * 读既有 localStorage 存档里的 sessionId（`AGENT_CHAT_STORAGE_KEY` 的
 * `sessionId` 栏位）：只作侧栏当前高亮的**后备**——首页／助理面已把活跃会话同步进
 * 唯读镜像（@/lib/agent-current-session），有镜像时优先用它；agent 面未挂载的页面
 * （例如 /history）才走这里。直接用既有 lib 的读取函式，不新造第三套 session 状态、
 * 不重写 parser：loadPersisted 已照既有 sanitize 惯例吞掉 SSR／隐私模式／无存档／
 * JSON 坏／schema 不符／逾 24h，一律回 null（绝不 throw）。
 */
export function readPersistedSessionId(): string | null {
  return loadPersisted()?.sessionId ?? null;
}

/** QQ 官方加群分享页（手机端点击直达 QQ 加入群聊）。
 *  自 Navbar 搬来这里：手机端入口移进侧栏，Navbar 只剩桌面弹窗入口；
 *  QqLogo 由 Navbar import 使用（避免两边各存一份 SVG 路径漂移）。 */
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
  /**
   * 动作桥（2026-10-03 第三轮）：有值＝这一列渲染成 button 元素（不是 Link），
   * 点击把动作交给助理面（见 @/lib/agent-surface-actions）；助理面没挂载时才退回
   * href 导航。无值＝纯 Link 导航列。有动作桥的列一律不做 active 高亮。
   */
  action?: AgentSurfaceAction;
  /** 永不冒充当前页（如「直接生成」/ 的 href 就是首页，否则在首页会误亮）。 */
  neverActive?: boolean;
}

/**
 * 导览列（第三轮瘦身：7 列 → 4 列）。手机端不需要的四页（技能／工作流／状态／
 * 帮助）下放成页尾细字连结带（见 MOBILE_SIDEBAR_FOOTER_LINKS），不让它们变孤儿。
 * 留下的四列逐条附出处：
 *   直接生成 /            — src/app/page.tsx；动作桥 "exit"（助理面在时直接退出助理面）
 *   生成历史 /history      — src/app/history/page.tsx；纯连结
 *   我的资产 /?agent=1     — 全站没有独立资产路由，资产面板住在首页 agent 面
 *                            （AgentChatSurface 的「我的资产」）；动作桥 "assets"
 *   定价     /pricing      — src/app/pricing/page.tsx；纯连结
 */
export const MOBILE_SIDEBAR_NAV: readonly MobileSidebarNavItem[] = [
  { href: "/", label: "直接生成", icon: SlidersHorizontal, action: "exit", neverActive: true },
  { href: "/history", label: "生成历史", icon: History },
  { href: "/?agent=1", label: "我的资产", icon: Images, action: "assets" },
  { href: "/pricing", label: "定价", icon: BadgeDollarSign },
];

/**
 * 被移出主导览的四页（第三轮）：降级为卷动区最底部的页尾细字连结带，
 * 不是 52px 导览列、不占列高预算。逐条对上既有路由档。
 *   /skills /workflows /status /use-cases
 */
export const MOBILE_SIDEBAR_FOOTER_LINKS: readonly { href: string; label: string }[] = [
  { href: "/skills", label: "技能" },
  { href: "/workflows", label: "工作流" },
  { href: "/status", label: "状态" },
  { href: "/use-cases", label: "帮助" },
];

/** 只认「不带 query 的路径连结」的 active 态；`/?agent=1` 这类入口不冒充当前页。 */
export function isSidebarNavActive(pathname: string, href: string): boolean {
  if (href.includes("?")) return false;
  return pathname === href;
}

export interface MobileSidebarPanelProps {
  /** 当前路径（由容器受控传入，方便测试直接渲染纯元件树）。 */
  pathname: string;
  /** 已登入＝显示名称；未登入＝「未登录」。 */
  userName: string;
  /** 身份副标（Grok 的 Premium 位置）：已登入显示 email／「已登录」，否则「未登录」。 */
  userSubtitle: string;
  /** 会话目录：null＝载入中，[]＝已载入但为空。 */
  sessions: AgentSessionSummary[] | null;
  loadError?: string | null;
  /** 当前会话（＝活跃会话的唯读镜像，见 @/lib/agent-current-session；agent 面未挂载
   *  时退回既有 localStorage 存档的 sessionId），null＝尚未建立／无存档，
   *  此时没有任何一列算「当前」。 */
  currentSessionId: string | null;
  /** 标题格式化：唯一实作由容器动态载入 AgentChatSurface.loadFormatSessionLabel 注入，
   *  不在此档静态 import（避免把 agent-chat 模组图拉进全站）。 */
  formatLabel: SessionLabelFormatter;
  query: string;
  onQueryChange: (value: string) => void;
  /** 点某一列＝走既有深链（/?agent=1&session=<id>），非另造切换路径。 */
  onPickSession: (sessionId: string) => void;
  /** 新对话（FAB 与空态 CTA 共用）＝既有入口 /?agent=1。 */
  onStartNew: () => void;
  /**
   * 动作桥派发（第三轮）：导览列「直接生成／我的资产」与底部齿轮共用。
   * 容器实作：先 onClose() 关侧栏 → requestAgentSurfaceAction(action)；
   * 助理面没挂载（回 false）才 router.push(fallbackHref) 退回导航。
   */
  onSurfaceAction: (action: AgentSurfaceAction, fallbackHref: string) => void;
  onClose: () => void;
  closeButtonRef?: RefObject<HTMLButtonElement | null>;
  searchInputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * 纯呈现层（零 hooks）：容器负责 portal／滚动锁／焦点／资料载入，
 * 这里只管长相与事件回呼，让 node:test 能直接 renderToStaticMarkup 验元素树。
 */
export function MobileSidebarPanel({
  pathname,
  userName,
  userSubtitle,
  sessions,
  loadError,
  currentSessionId,
  formatLabel,
  query,
  onQueryChange,
  onPickSession,
  onStartNew,
  onSurfaceAction,
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
      {/* 内层材质：绝对定位铺满，承载不透明纯白底；面板本体不挂 backdrop-filter
          （Safari 对 backdrop-filter＋transform 动画有合成怪癖会吞掉位移）。
          内容（header／卷动区／dock）各以 z-index 叠在它之上。 */}
      <div className="mobile-sidebar-bg" aria-hidden="true" />
      {/* 顶部身份：头像＋名称＋副标（Grok 的 avatar + handle + Premium）。 */}
      <header className="relative z-[1] flex shrink-0 items-center gap-3 px-4 pb-1">
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
          className="flex h-11 w-11 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full bg-black/[0.05] text-[rgba(0,0,0,0.56)] transition-colors hover:bg-black/[0.09] hover:text-[rgba(0,0,0,0.85)] active:bg-black/[0.13] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 motion-reduce:transition-none [-webkit-tap-highlight-color:transparent]"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </header>

      {/* 单一卷动容器：导览＋「对话」清单＋退出/QQ 一起卷（清单不再自开第二条卷轴，
          避免巢状卷动）。底部浮动玻璃条改绝对定位浮在最下（.mobile-sidebar-dock），
          这里留出等高 padding-bottom，最后一列不会被盖住。 */}
      <div className="mobile-sidebar-scroll relative z-[1] min-h-0 flex-1 overflow-y-auto overscroll-contain px-2">
        {/* 导览列（第三轮瘦身 4 列）：有动作桥的列渲染成 button（把动作交给助理面，
            没宿主才退回 href），纯连结列维持 Link。标签字级（text-ios-body＝17px）
            挂在内层 span 的**纯字串 className** 上，不进 cn()：cn＝twMerge(clsx(...))，
            tailwind-merge 认不得自订 token `text-ios-body`，会把它归到 text-color
            群组，然后被同一串后面的 `text-[rgba(…)]` 颜色 class 吃掉（实测 twMerge
            直接移除该 class）——之前挂在 cn 的 anchor 上，17px 从未生效。
            span 走纯 className 就绕过这个合并陷阱（见 mobile-sidebar.test.ts 探针）。 */}
        <nav aria-label="主导航链接" className="pt-1">
          <ul className="flex flex-col">
            {MOBILE_SIDEBAR_NAV.map(({ href, label, icon: Icon, action, neverActive }) => {
              // 有动作桥的列不做 active 高亮；`neverActive`（如「直接生成」/ 就是首页）
              // 也永不冒充当前页。
              const active = !neverActive && !action && isSidebarNavActive(pathname, href);
              const rowClass = cn(
                "flex min-h-[52px] items-center gap-3.5 rounded-[14px] px-3 font-medium touch-manipulation transition-colors [-webkit-tap-highlight-color:transparent] motion-reduce:transition-none",
                active
                  ? "bg-black/[0.05] text-[rgba(0,0,0,0.85)]"
                  : "text-[rgba(0,0,0,0.72)] hover:bg-black/[0.04] hover:text-[rgba(0,0,0,0.88)] active:bg-black/[0.07]",
              );
              return (
                <li key={href}>
                  {action ? (
                    <button
                      type="button"
                      onClick={() => onSurfaceAction(action, href)}
                      data-agent-action={action}
                      data-fallback-href={href}
                      className={cn(rowClass, "w-full cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30")}
                    >
                      <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                      <span className="truncate text-ios-body">{label}</span>
                    </button>
                  ) : (
                    <Link
                      href={href}
                      onClick={onClose}
                      aria-current={active ? "page" : undefined}
                      className={rowClass}
                    >
                      <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                      <span className="truncate text-ios-body">{label}</span>
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        {/* 对话分节：标题＋搜寻框＋既有 AgentSessionList（两行截断／相对日期／空态）。 */}
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
          {/* 清单随内容自然撑高，不再自开卷轴（避免巢状卷动）。 */}
          <div className="px-1 pb-2">
            <AgentSessionList
              sessions={sessions}
              loadError={loadError}
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

        {/* 底部帐号动作：随内容一起卷（浮动玻璃条另为绝对定位的 .mobile-sidebar-dock）。
            「账号设置」「退出登录」已移除（2026-10-03 项目负责人裁定回归 header，另一路在
            手机端 header 显出那两颗）；帐号设置仍可经 dock 齿轮的 fallback 到达。 */}
        <div className="pt-1">
          <div className="flex flex-col">
            <a
              href={QQ_GROUP_SHARE_URL}
              className="flex min-h-[52px] touch-manipulation items-center gap-3.5 rounded-[14px] px-3 text-ios-body font-medium text-[rgba(0,0,0,0.72)] transition-colors hover:bg-black/[0.04] hover:text-[rgba(0,0,0,0.88)] active:bg-black/[0.07] motion-reduce:transition-none [-webkit-tap-highlight-color:transparent]"
            >
              <QqLogo className="h-5 w-5 shrink-0" />
              <span className="truncate">加入 QQ 群</span>
            </a>
          </div>
          {/* 被移出主导览的四页降级入口（第三轮）：页尾细字连结带，14px／可折行，
              不是 52px 导览列；只求不变孤儿，不占列高预算。 */}
          <nav
            aria-label="更多入口"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2 pt-3 text-ios-footnote text-[rgba(0,0,0,0.42)]"
          >
            {MOBILE_SIDEBAR_FOOTER_LINKS.map((item, index) => (
              <span key={item.href} className="flex items-center gap-x-2">
                {index > 0 && <span aria-hidden="true">·</span>}
                <Link
                  href={item.href}
                  onClick={onClose}
                  data-mobile-footer-link="true"
                  className="hover:text-[rgba(0,0,0,0.7)] [-webkit-tap-highlight-color:transparent]"
                >
                  {item.label}
                </Link>
              </span>
            ))}
          </nav>
        </div>
      </div>

      {/* 底部浮动玻璃条（齿轮／黑色新对话 FAB）：绝对定位浮在最下，不参与卷动。
          「搜索」钮已移除（2026-10-03）：与「对话」分节的搜寻框重复，该框是唯一入口。 */}
      <div className="mobile-sidebar-dock">
        <div className="lg-bar flex items-center justify-between gap-2 rounded-full p-2">
          {/* 齿轮＝情境感知（第三轮）：助理面在时叫动它的「助理设定」（我的技能＋
              互动模式）；助理面没挂载（回 false）才退回帐号设置 /settings/api-keys。
              aria-label 契约维持「设置」。 */}
          <button
            type="button"
            onClick={() => onSurfaceAction("settings", "/settings/api-keys")}
            data-agent-action="settings"
            data-fallback-href="/settings/api-keys"
            aria-label="设置"
            className="flex h-11 w-11 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full bg-black/[0.05] text-[rgba(0,0,0,0.62)] transition-colors hover:bg-black/[0.09] hover:text-[rgba(0,0,0,0.88)] active:bg-black/[0.13] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 [-webkit-tap-highlight-color:transparent]"
          >
            <Settings className="h-5 w-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onStartNew}
            aria-label="新对话"
            className="flex h-12 w-12 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full bg-black text-white transition-transform hover:scale-[1.03] active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 motion-reduce:transition-none [-webkit-tap-highlight-color:transparent]"
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
  /** 关闭后焦点还原处（Navbar 的汉堡钮）。 */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * 容器：portal 到 document.body（地雷①）＋左滑入动画＋遮罩／Esc／关闭钮三条关闭
 * ＋body 滚动锁（存原值再还原，与既有全出血锁共存）＋开场焦点进侧栏、关闭归还
 * 汉堡钮＋首次开启载入会话目录。
 */
export function MobileSidebar({ open, onClose, triggerRef }: MobileSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const narrow = useIsNarrow();
  const { user } = useAuth();
  const [sessionCache, setSessionCache] = useState<{ ownerId: number; items: AgentSessionSummary[] } | null>(null);
  const [sessionError, setSessionError] = useState<{ ownerId: number; message: string } | null>(null);
  const sessions = user && sessionCache?.ownerId === user.id ? sessionCache.items : null;
  // 当前会话（当前高亮用）：开侧栏时读既有 localStorage 存档，不用第三套状态。
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  // 标题格式化：null＝唯一实作（AgentChatSurface）尚未动态载入完。
  const [formatLabel, setFormatLabel] = useState<SessionLabelFormatter | null>(null);
  const [query, setQuery] = useState("");
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // 只有手机（<sm）才算开启：汉堡本身 sm:hidden；桌面若在开启中拉宽，自动关闭。
  const active = open && narrow;

  // onClose 每次 Navbar render 都是新函式；用 ref 取值，effect 才不会被它反覆触发
  // （依赖摆 onClose 会让 effect 每次重跑＝一开就被自己关掉）。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 路由一变就收起：Navbar 在 root layout，侧栏跨页存活，不靠这个会在换页后
  // 留一层关不掉的整屏面板。
  useEffect(() => {
    if (!open) return;
    onCloseRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // 每次开启从服务端刷新；失败保留已核实目录，重新开启可重试。
  useEffect(() => {
    if (!active || !user) return;
    const ownerId = user.id;
    setSessionError(null);
    let cancelled = false;
    void listAgentSessions()
      .then((list) => {
        if (!cancelled) setSessionCache({ ownerId, items: list });
      })
      .catch(() => {
        if (!cancelled) setSessionError({ ownerId, message: "历史加载失败，请重新打开重试。" });
      });
    return () => {
      cancelled = true;
    };
  }, [active, user?.id]);

  // 动态载入唯一标题格式化（见 loadFormatSessionLabel）：侧栏没开就不下载
  // agent-chat chunk；Promise 记忆化，重开侧栏不再请求。
  useEffect(() => {
    if (!active || formatLabel !== null) return;
    let cancelled = false;
    void loadFormatSessionLabel()
      .then((fmt) => {
        if (!cancelled) setFormatLabel(() => fmt);
      })
      .catch(() => {
        // 取不到唯一实作：维持降级格式化，不让整个会话清单一起失败。
      });
    return () => {
      cancelled = true;
    };
  }, [active, formatLabel]);

  // 当前会话高亮：优先用活跃会话的唯读镜像（见 @/lib/agent-current-session，
  // 真源是 AgentChatSurface 的 sessionId）；非首页（agent 面未挂载）镜像为 null，
  // 才退回读既有存档（坏 JSON／无存档／逾 24h 一律 null）。
  useEffect(() => {
    if (!active) return;
    setCurrentSessionId(user ? getCurrentAgentSession() ?? readPersistedSessionId() : null);
  }, [active, user?.id]);

  // Esc 关闭＋滚动锁＋焦点进出。存原 overflow 再还原：首页全出血有自己的
  // html/body 锁，不能关掉侧栏时把别人的锁一起抹平。
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

  // 收起时清掉搜寻词：下次打开看到全量目录，不是上一轮打一半的词。
  useEffect(() => {
    if (!active) setQuery("");
  }, [active]);

  const handleStartNew = (): void => {
    onClose();
    router.push("/?agent=1");
  };

  const handlePickSession = (sessionId: string): void => {
    onClose();
    router.push(`/?agent=1&session=${encodeURIComponent(sessionId)}`);
  };

  /**
   * 动作桥派发（第三轮）：先关侧栏（不挡住助理面的浮层），再呼叫助理面；
   * 只有助理面没挂载（回 false）才退回该列自己的 href。
   */
  const handleSurfaceAction = (action: AgentSurfaceAction, fallbackHref: string): void => {
    onClose();
    if (!requestAgentSurfaceAction(action)) router.push(fallbackHref);
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
        sessions={sessions}
        loadError={sessionError?.ownerId === user?.id ? sessionError?.message : null}
        currentSessionId={currentSessionId}
        formatLabel={formatLabel ?? fallbackSessionLabel}
        query={query}
        onQueryChange={setQuery}
        onPickSession={handlePickSession}
        onStartNew={handleStartNew}
        onSurfaceAction={handleSurfaceAction}
        onClose={onClose}
        closeButtonRef={closeButtonRef}
        searchInputRef={searchInputRef}
      />
    </div>,
    document.body,
  );
}

/** 汉堡钮（Navbar 手机端最左边）：44×44，只在 <sm 出现（sm:hidden 契约）。 */
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
      className="flex h-11 w-11 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full text-[rgba(0,0,0,0.62)] lg-transition active:bg-black/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 sm:hidden [-webkit-tap-highlight-color:transparent]"
    >
      <Menu className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}
