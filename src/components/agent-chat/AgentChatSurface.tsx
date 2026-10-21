"use client";

// Agent 聊天区的共用外壳。
//
// 现在站上只有一个入口：首页那张卡片里的 agent 面（variant="inline"，
// D-1「内嵌在卡片里的按钮」＋ D-24 状态B「常驻可开关」）。
// 使用者明确不要独立页，/agent 已改成重定向回首页。
//
// variant="page" 保留：它是「把聊天区当整页用」的能力（未来的分享页、
// 嵌入页都靠它），只是当前没有路由走这条。两者共用同一份 useAgentChat，
// 不复制逻辑——差别仅在标头层级和退出去向。
//
// D-2 说各模式各自进、各自进入各自的聊天区，但 D-3 已修正为「功能完全平等，
// agent 聊天区在两个模式下是同一套东西」——所以这里只有一套组件。


import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bot,
  Boxes,
  History,
  Loader2,
  LogIn,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePen,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentSessionSummary } from "@/lib/agent-chat-client";
import { useAgentChat } from "@/hooks/use-agent-chat";
import { useAuth } from "@/hooks/use-auth";
import { setCurrentAgentSession } from "@/lib/agent-current-session";
import { AgentChatPanel } from "@/components/agent-chat/AgentChatPanel";
import { AgentSessionList } from "@/components/agent-chat/AgentSessionList";
import { AgentSettingsPopover } from "@/components/agent-chat/AgentSettingsPopover";
import { useIsNarrow } from "@/hooks/use-is-narrow";
import { PwaHandoffPanel } from "@/components/PwaHandoffPanel";
import { createHandoffLogin, isStandalonePwa } from "@/lib/github-login";
import type { AssetPack } from "@/lib/asset-pack-store";
import type { HistoryEntry } from "@/lib/history-types";
import { RerunDialog, type HistoryRerunMode } from "@/components/history/RerunDialog";
import {
  formatSessionLabel,
  isAuthError,
  isInsideHistorySurface,
  startLoginThenRetry,
  useDebouncedValue,
} from "./AgentChatSurface.helpers";
import type { AgentChatSurfaceProps } from "./AgentChatSurface.types";
import { useAgentSurfaceSessionActions } from "./AgentChatSurface.session-actions";

export type { AgentChatSurfaceProps } from "./AgentChatSurface.types";
export { formatSessionLabel, isInsideHistorySurface } from "./AgentChatSurface.helpers";

export function AgentChatSurface({
  variant = "page",
  embedded = false,
  initialPrompt = "",
  initialSessionId,
  onParamsReflected,
  currentModelId,
  onImageResult,
  onCanvasEvent,
  canvasStateProvider,
  onSessionChange,
  switchSessionRef,
  startNewSessionRef,
  agentInjection,
  onUserMessage,
  onSendBlockedByAuth,
  prefillRequest,
  onExit,
  headerExtra,
}: AgentChatSurfaceProps) {
  const { user: chatHistoryUser } = useAuth();
  const historyOwnerRef = useRef(chatHistoryUser?.id ?? null);
  historyOwnerRef.current = chatHistoryUser?.id ?? null;
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  // 「我的资产」面板：null = 未加载，[] = 已加载但为空。
  const [showAssets, setShowAssets] = useState(false);
  const [assetCache, setAssetCache] = useState<{ ownerId: number; packs: AssetPack[] } | null>(null);
  const assetPacks = assetCache && assetCache.ownerId === chatHistoryUser?.id ? assetCache.packs : null;
  const [activatingPackId, setActivatingPackId] = useState<string | null>(null);
  // 搜索：300ms debounce 后按 ?q= 重新拉取（空字串还原为全量）。
  const [assetQuery, setAssetQuery] = useState("");
  const debouncedAssetQuery = useDebouncedValue(assetQuery);
  const assetPanelRef = useRef<HTMLDivElement | null>(null);
  // 承接进来的半句话；续写或手动放弃后就不再显示。
  const [draft, setDraft] = useState(initialPrompt.trim());
  // 交给输入区的续写信号（D-24）。输入区吃掉后回调清空，避免重复注入。
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  // 图卡的 payload 级重跑对话框（entry 由媒体条目即时合成；null = 未开）。
  const [rerunDialog, setRerunDialog] = useState<{ entry: HistoryEntry; mode: HistoryRerunMode } | null>(null);
  const [contentOwnerId, setContentOwnerId] = useState(chatHistoryUser?.id ?? null);
  const contentIsCurrent = contentOwnerId === (chatHistoryUser?.id ?? null);
  useEffect(() => {
    const nextOwnerId = chatHistoryUser?.id ?? null;
    if (contentOwnerId === nextOwnerId) return;
    setContentOwnerId(nextOwnerId);
    setDraft("");
    setPrefill(null);
    setRerunDialog(null);
  }, [chatHistoryUser?.id, contentOwnerId]);
  const chat = useAgentChat({
    // 09-12 建号权收归发送按钮：hook 的 autoStart 已撤——进助理挂载即空态，
    // 不预建会话；首条消息 send() 内部才 lazy 建号（深链的 switchSession
    // 是恢复旧会话，不是建号，不受影响）。
    ...(onCanvasEvent ? { onCanvasEvent } : {}),
    ...(canvasStateProvider ? { canvasStateProvider } : {}),
    ...(onSendBlockedByAuth ? { onSendBlockedByAuth } : {}),
  });
  const {
    state,
    connection,
    sessionId,
    error,
    send,
    confirm,
    answerQuestion,
    retry,
    resumable,
    abort,
    aborting,
    startingSession,
    switchSession,
    startNewSession,
    ensureSession,
    dispatchNotice,
  } = chat;
  // 活跃会话唯读镜像（src/lib/agent-current-session.ts）：真源是本 hook 的 sessionId，
  // 这里只把它同步给另一棵元件树（MobileSidebar 的当前高亮）读取；不碰既有
  // localStorage 存档（存档会被还原／开新路径 consume 掉，见 use-agent-chat）。
  useEffect(() => {
    setCurrentAgentSession(sessionId ?? null);
  }, [sessionId]);
  // D-26：已经问过锚定的那张图。问过就不再问——同一张图反复弹卡是骚扰。
  const [anchorAskedFor, setAnchorAskedFor] = useState<string | null>(null);
  const [anchorBusy, setAnchorBusy] = useState(false);
  /*
   * D-17 改版：默认开新对话。
   *
   * 旧行为是一进来先摆一张「继续上次 / 结束它开新的」的卡，底下面板同时被禁用——
   * 使用者每次刷新都被拦一次，还要读懂「开新的会删掉上面这段对话」才敢按。
   * 那张卡在教用户怎么管理会话，这不是他要的东西：他要的是一个能打字的框。
   *
   * 现在存档只留一份快照给「对话历史」按钮，会话本体立刻开新的、不问。
   * 快照是纯展示：会话已经删掉了，所以这里不给「继续」按钮——
   * 摆一颗按下去必然失败的按钮比没有按钮更糟。
   */
  const [, setHistorySnapshot] = useState<{ itemCount: number; savedAt: number } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  // 会话目录（对话历史 dropdown 的数据）：null = 未加载，[] = 已加载但为空。
  const [historyCache, setHistoryCache] = useState<{ ownerId: number; items: AgentSessionSummary[] } | null>(null);
  const [historyError, setHistoryError] = useState<{ ownerId: number; message: string } | null>(null);
  const historyList = chatHistoryUser && historyCache?.ownerId === chatHistoryUser.id ? historyCache.items : null;
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [startingNew, setStartingNew] = useState(false);
  const historyRef = useRef<HTMLDivElement | null>(null);
  // 窄屏历史抽屉（portal 到 document.body）：卡片 section.lg-card 有 backdrop-filter，
  // 会成为 fixed 后代的 containing block，把 inset:0 的 scrim 缩成卡片大小
  // （2026-10-03 实锤：390px 下 scrim top 90/left 12/w 366/h 742）。portal 出去后
  // 抽屉节点不在 historyRef 子树内，outside-click 需另外放行这个 ref。
  const historyDrawerRef = useRef<HTMLDivElement | null>(null);
  // 窄屏（≤639.98px，与 sm: 断点同源）：历史从下拉换成底部抽屉（D-23 同款
  // agent-param-drawer 轮子），并带受控搜寻词；宽屏行为不变。
  const isNarrow = useIsNarrow();
  const [historyQuery, setHistoryQuery] = useState("");
  const historyTriggerRef = useRef<HTMLButtonElement | null>(null);
  const historyCloseRef = useRef<HTMLButtonElement | null>(null);
  // PWA standalone 登录交接面板（null = 未开启）。storage 与常用浏览器隔离，
  // popup 链路在 standalone 视窗里拿不回登录态，必须走 handoff。
  const [handoffLogin, setHandoffLogin] = useState<{ ticket: string; loginUrl: string } | null>(null);

  // 助理设定的触发钮收进 ⋯ 菜单：AgentSettingsPopover 是自带触发钮的自足组件
  // （无受控 open prop，档案不在本刀白名单），这里以 0×0 容器承载它的原触发钮，
  // 菜单「设置」行用程序化 click 触发——弹层本体、outside-click、持久化链路零改动。
  const settingsTriggerWrapRef = useRef<HTMLDivElement | null>(null);
  const openSettings = useCallback((): void => {
    settingsTriggerWrapRef.current?.querySelector("button")?.click();
  }, []);

  // 登录入口：standalone PWA 先申请 handoff ticket 弹交接面板；申请失败或普通
  // 浏览器走原 popup 链路（startLoginThenRetry 交互逻辑不动）。
  const beginLogin = useCallback(() => {
    if (isStandalonePwa()) {
      void createHandoffLogin().then((handoff) => {
        if (handoff) {
          setHandoffLogin(handoff);
          return;
        }
        void startLoginThenRetry(retry);
      });
      return;
    }
    void startLoginThenRetry(retry);
  }, [retry]);

  // 开著的 dropdown：点外面就收——浮层不该把人锁在原地。
  // （窄屏抽屉已 portal 到 document.body，节点不在 historyRef 子树内，所以
  //   列与搜寻框的点击改由 historyDrawerRef 放行，不误收；
  //   抽屉自己的 scrim onClick 负责点遮罩关闭。）
  useEffect(() => {
    if (!showHistory) return;
    const onDocPointerDown = (ev: PointerEvent): void => {
      if (!isInsideHistorySurface(historyRef.current, historyDrawerRef.current, ev.target as Node)) {
        setShowHistory(false);
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [showHistory]);

  // 历史抽屉（仅窄屏挂载）：Esc 关闭＋背景锁滚动＋焦点进出——逐条抄
  // AgentParamDisclosure 的 D-23 抽屉轮子（存原 overflow 再还原，与全出血
  // 页面的 html/body 滚动锁共存；关闭后焦点还给触发钮）。
  const historyDrawerOpen = showHistory && isNarrow;
  useEffect(() => {
    if (!historyDrawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setShowHistory(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    historyCloseRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      historyTriggerRef.current?.focus();
    };
  }, [historyDrawerOpen]);

  // 收起历史时清掉搜寻词：下次打开看到的是全量目录，不是上次打一半的词。
  useEffect(() => {
    if (!showHistory) setHistoryQuery("");
  }, [showHistory]);

  // 「我的资产」面板同样点外即收。
  useEffect(() => {
    if (!showAssets) return;
    const onDocPointerDown = (ev: PointerEvent): void => {
      if (assetPanelRef.current && !assetPanelRef.current.contains(ev.target as Node)) {
        setShowAssets(false);
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [showAssets]);

  const {
    prefetchAssets,
    toggleAssets,
    onActivatePack,
    prefetchHistory,
    toggleHistory,
    onPickSession,
    onStartNewSession,
    isActive,
    isInline,
    onSaveToLibrary,
    attachFilesRef,
    onEdit,
    onDownload,
    onVideoDownload,
    onAudioDownload,
    continueDraft,
    clearPrefill,
    anchor,
    onAnchor,
    onReanchor,
    onAnchorDismiss,
    onStopGeneration,
    imageActions,
    videoActions,
    audioActions,
  } = useAgentSurfaceSessionActions({
    chatHistoryUser,
    historyOwnerRef,
    savedIds,
    setSavedIds,
    sessionId,
    onSessionChange,
    switchSession,
    switchSessionRef,
    startNewSession,
    startNewSessionRef,
    state,
    onParamsReflected,
    currentModelId,
    onImageResult,
    connection,
    draft,
    setDraft,
    setPrefill,
    prefillRequest,
    resumable,
    initialSessionId,
    agentInjection,
    onUserMessage,
    send,
    anchorAskedFor,
    setAnchorAskedFor,
    anchorBusy,
    setAnchorBusy,
    abort,
    setRerunDialog,
    assetPacks,
    setAssetCache,
    setActivatingPackId,
    setAssetQuery,
    showAssets,
    setShowAssets,
    setShowHistory,
    switchingTo,
    setSwitchingTo,
    startingNew,
    setStartingNew,
    setHistoryCache,
    setHistoryError,
    setHistorySnapshot,
    historyList,
    assetQuery,
    debouncedAssetQuery,
    activatingPackId,
    openSettings,
    onExit,
    variant,
  });

  return (
    <div
      className={cn(
        // agent-chat-surface：手机端字级阶梯（agent-chat.css 的 ≤639.98px 块）的
        // 唯一锚点，桌面 ≥640px 无任何规则挂它，pixel-identical 不破。
        "agent-chat-surface",
        isInline ? "flex min-h-0 flex-1 flex-col overflow-hidden pb-1" : "page-shell flex flex-col pb-4 pt-3",
      )}
      style={isInline ? undefined : { minHeight: "calc(100dvh - 5rem)", height: "calc(100dvh - 5rem)" }}
    >
      {/*
        面板 Header（2026-09-27 暴君纠正后定版；2026-09-20 顶栏减负为前身）：
        纯图示列、零文字。原本的 lg-tint-blue 星芒圆标＋「AI 助理」标题连同状态
        文字整组拆掉——助理就在眼前，标题与「随时待命」式描述零资讯，还占掉顶栏
        一整块；那个位置现在放的是 资产 / 历史 两颗图示（它们原本埋在 ⋯ 选单里）。
        右侧维持 新会话 SquarePen / 直接生成 SlidersHorizontal / 设置 Settings。

        连带作废：⋯ 收纳选单（三项现在全是直接入口，少一层菜单就少一次点击）。
        连线异常态（reconnecting / closed）的文字不再由顶栏承担：对话区
        （AgentChatPanel）本来就有自己的重试入口与「原因：…」行，顶栏那份是重复的。
        设定弹层本体仍由 AgentSettingsPopover 自足渲染，齿轮只是它的触发钮。
        embedded（工作站面板态）：外层面板已有把手，这里的把手省掉——单层。
      */}
      <header className={cn("flex shrink-0 flex-col", embedded ? "mb-1" : "pb-2")}>
        {/* 窄屏走廊修复（2026-10-03）：桌面上 ml-auto 把右簇顶到最右是对的；
            窄屏上中间那条是死空白走廊。两个簇在窄屏改 display:contents（子按钮
            提升为外层 flex item），外层 justify-between——五颗 44px 钮等距分布
            整行，零 DOM 搬动；5×44=220px 在 320px 宽也不换行。桌面渲染不变。 */}
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1 max-sm:justify-between">
          {/* 资产／历史：就是原本标题那块位置，点外即收的浮层机制沿用各自原本的
              outside-click；图示即「logo」，不再挂文字标签。 */}
          <div className="flex items-center gap-0.5 max-sm:contents">
            <button
              type="button"
              onClick={() => void toggleAssets()}
              onPointerEnter={prefetchAssets}
              onFocus={prefetchAssets}
              aria-expanded={showAssets}
              aria-label="我的资产"
              title="我的资产"
              className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground/45 outline-none transition-colors hover:bg-ios-blue/[0.12] hover:text-foreground/75 active:scale-95 focus:outline-none focus-visible:bg-black/[0.06] aria-expanded:bg-black/[0.06] aria-expanded:text-foreground/80 touch-manipulation max-sm:hidden"
            >
              <Boxes className="h-[1.125rem] w-[1.125rem]" aria-hidden="true" />
            </button>
            <button
              ref={historyTriggerRef}
              type="button"
              onClick={() => void toggleHistory()}
              onPointerEnter={prefetchHistory}
              onFocus={prefetchHistory}
              aria-expanded={showHistory}
              aria-label="对话历史"
              title="对话历史"
              className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground/45 outline-none transition-colors hover:bg-ios-blue/[0.12] hover:text-foreground/75 active:scale-95 focus:outline-none focus-visible:bg-black/[0.06] aria-expanded:bg-black/[0.06] aria-expanded:text-foreground/80 touch-manipulation max-sm:hidden"
            >
              <History className="h-[1.125rem] w-[1.125rem]" aria-hidden="true" />
            </button>
          </div>
          {/* 右簇靠 ml-auto 顶到最右（中间没有 flex-1 的标题块可撑了）。
              窄屏 contents 后 ml-auto 自动失效，由外层 justify-between 接管。 */}
          <div className="ml-auto flex items-center gap-0.5 max-sm:contents">
            <button
              type="button"
              onClick={() => void onStartNewSession()}
              disabled={startingNew}
              aria-label="开新对话"
              title="开新对话（当前对话保留在历史里）"
              className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground/45 outline-none transition-colors hover:bg-ios-blue/[0.12] hover:text-foreground/75 active:scale-95 focus:outline-none focus-visible:bg-black/[0.06] aria-expanded:bg-black/[0.06] aria-expanded:text-foreground/80 touch-manipulation max-sm:hidden disabled:cursor-wait"
            >
              {startingNew ? (
                <Loader2 className="h-[1.125rem] w-[1.125rem] animate-spin text-ios-blue" aria-hidden="true" />
              ) : (
                <SquarePen className="h-[1.125rem] w-[1.125rem]" aria-hidden="true" />
              )}
            </button>
            {onExit && (
              <button
                type="button"
                onClick={onExit}
                aria-label="直接生成"
                title="直接生成：自己选模型和参数出图"
                className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground/45 outline-none transition-colors hover:bg-ios-blue/[0.12] hover:text-foreground/75 active:scale-95 focus:outline-none focus-visible:bg-black/[0.06] aria-expanded:bg-black/[0.06] aria-expanded:text-foreground/80 touch-manipulation max-sm:hidden"
              >
                <SlidersHorizontal className="h-[1.125rem] w-[1.125rem]" aria-hidden="true" />
              </button>
            )}
            {/* 设置：原本是 ⋯（MoreHorizontal）＋选单，2026-09-27 暴君纠正后
                历史与资产已直接站上顶栏，这颗就只剩设定一件事，所以换成齿轮。
                弹层本体仍是 AgentSettingsPopover 的自足渲染（0×0 容器里的
                原触发钮被程序化 click），outside-click 与持久化链路零改动。 */}
            <button
              type="button"
              onClick={openSettings}
              aria-label="设置"
              title="助理设定"
              className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground/45 outline-none transition-colors hover:bg-ios-blue/[0.12] hover:text-foreground/75 active:scale-95 focus:outline-none focus-visible:bg-black/[0.06] aria-expanded:bg-black/[0.06] aria-expanded:text-foreground/80 touch-manipulation max-sm:hidden"
            >
              <Settings className="h-[1.125rem] w-[1.125rem]" aria-hidden="true" />
            </button>
            {/* 助理设定的原触发钮：收进 0×0 容器（视觉退役，程序化 click 保活），
                弹层本体由 AgentSettingsPopover 自行渲染（fixed agent-pop）。 */}
            <div ref={settingsTriggerWrapRef} className="absolute h-0 w-0 overflow-hidden" aria-hidden="true">
              <AgentSettingsPopover />
            </div>
            {/* 历史浮层：触发钮＝顶栏那颗「历史」。宽屏＝agent-pop 下拉（fixed 定位与
                outside-click 机制沿用）；窄屏＝底部抽屉（agent-param-drawer 轮子，
                与参数抽屉同一份 CSS，不新造）。
                窄屏抽屉 portal 到 document.body：卡片 section.lg-card 的 backdrop-filter
                会当 fixed 后代的 containing block，留在卡片内抽屉会被缩到卡片大小
                （不是全屏）；portal 后节点不在 historyRef 子树内，列与搜索框的
                pointerdown 改由 historyDrawerRef 放行。
                抽屉材质用 agent-pop（不透明弹层材质，兄弟历史/资产弹层同款），
                不用半透 lg-sheet——底下消息流的字会透上来和列表字叠在一起。 */}
            <div ref={historyRef} className="relative max-sm:contents">
              {showHistory &&
                (isNarrow ? (
                  typeof document !== "undefined" &&
                  createPortal(
                    <div
                      className="agent-param-scrim"
                      ref={historyDrawerRef}
                      role="presentation"
                      onClick={(event) => {
                        if (event.target === event.currentTarget) setShowHistory(false);
                      }}
                    >
                      <div
                        role="dialog"
                        aria-modal="true"
                        aria-label="对话历史"
                        className="agent-param-drawer agent-pop"
                      >
                      {/* DESIGN.md §5：每张 sheet 都要有一条顶缘高光线。 */}
                      <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
                      {/* 抓手是可见的可抓性提示；真正的关闭靠右上角按钮与点遮罩。 */}
                      <span className="agent-param-drawer-grip" aria-hidden="true" />
                      <div className="flex items-center gap-2 px-4 pb-2">
                        <p className="min-w-0 flex-1 text-ios-subhead font-semibold text-foreground">对话</p>
                        <button
                          ref={historyCloseRef}
                          type="button"
                          onClick={() => setShowHistory(false)}
                          aria-label="关闭历史"
                          className="flex h-11 w-11 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full bg-black/5 text-muted-foreground transition-colors hover:bg-black/[0.09] hover:text-foreground active:bg-black/[0.13] focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 motion-reduce:transition-none [-webkit-tap-highlight-color:transparent]"
                        >
                          <X className="h-5 w-5" aria-hidden="true" />
                        </button>
                      </div>
                      {/* 搜索（仅窄屏抽屉；宽屏 w-56 放不下）：lg-float 框＋放大镜，
                          16px 字级防 iOS 聚焦自动放大。 */}
                      <div className="px-4 pb-2">
                        <div className="lg-float flex h-11 items-center gap-2 rounded-[14px] px-3">
                          <Search className="h-4 w-4 shrink-0 text-foreground/45" aria-hidden="true" />
                          <input
                            value={historyQuery}
                            onChange={(e) => setHistoryQuery(e.target.value)}
                            placeholder="搜索对话"
                            aria-label="搜索对话"
                            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-foreground/40"
                          />
                        </div>
                      </div>
                      <div className="agent-param-drawer-body">
                        <AgentSessionList
                          sessions={historyList}
                          loadError={historyError?.ownerId === chatHistoryUser?.id ? historyError?.message : null}
                          currentSessionId={sessionId}
                          switchingTo={switchingTo}
                          startingNew={startingNew}
                          query={historyQuery}
                          formatLabel={formatSessionLabel}
                          onPick={(id) => void onPickSession(id)}
                          onStartNew={() => {
                            setShowHistory(false);
                            void onStartNewSession();
                          }}
                        />
                      </div>
                    </div>
                  </div>,
                  document.body,
                )
              ) : (
                  <div className="agent-pop agent-pop-in fixed left-1/2 top-[var(--agent-pop-top,5rem)] z-50 w-56 -translate-x-1/2 rounded-[18px] p-1.5">
                    {/* DESIGN.md §5：每张 sheet 都要有一条顶缘高光线。 */}
                    <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
                    <div className="agent-pop-scroll max-h-64 overflow-y-auto overscroll-contain">
                      <AgentSessionList
                        sessions={historyList}
                        loadError={historyError?.ownerId === chatHistoryUser?.id ? historyError?.message : null}
                        currentSessionId={sessionId}
                        switchingTo={switchingTo}
                        startingNew={startingNew}
                        formatLabel={formatSessionLabel}
                        onPick={(id) => void onPickSession(id)}
                        onStartNew={() => {
                          setShowHistory(false);
                          void onStartNewSession();
                        }}
                      />
                    </div>
                  </div>
                ))}
            </div>
            {/* 资产下拉浮层：触发钮已收进 ⋯ 菜单，fixed 定位与 outside-click 机制沿用。
                ref wrapper 窄屏 contents 化的理由同历史浮层（不参与工具列分布计数）。 */}
            <div ref={assetPanelRef} className="relative max-sm:contents">
              {showAssets && (
                <div className="agent-pop agent-pop-in fixed left-1/2 top-[var(--agent-pop-top,5rem)] z-50 w-64 -translate-x-1/2 rounded-[18px] p-1.5">
                  {/* DESIGN.md §5：每张 sheet 都要有一条顶缘高光线。 */}
                  <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
                  <p className="px-2.5 pt-2 pb-1 text-ios-caption1 font-medium text-foreground/60">我的资产</p>
                  <div className="relative px-2.5 pb-1">
                    <Search className="pointer-events-none absolute left-[13px] top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground/45" />
                    <input
                      value={assetQuery}
                      onChange={(e) => setAssetQuery(e.target.value)}
                      placeholder="搜索资产…"
                      className="w-full rounded-lg border border-input bg-black/5 py-1.5 pl-7 pr-3 text-ios-caption1 outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ios-blue"
                    />
                  </div>
                  {assetPacks === null ? (
                    <p className="px-2.5 py-3 text-center text-ios-caption1 text-foreground/45">
                      正在加载资产…
                    </p>
                  ) : assetPacks.length === 0 ? (
                    <p className="px-2.5 py-3 text-center text-ios-caption1 text-foreground/45">
                      还没有保存过资产
                    </p>
                  ) : (
                    <div className="agent-pop-scroll max-h-64 overflow-y-auto overscroll-contain">
                      {assetPacks.map((pack) => {
                        const activating = activatingPackId === pack.id;
                        return (
                          <div
                            key={pack.id}
                            className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-black/5"
                          >
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                              <span className="block truncate text-ios-caption1 font-medium text-muted-foreground">
                                {pack.title}
                              </span>
                              <span className="block truncate text-ios-caption2 text-foreground/45">
                                {pack.items.length} 项
                                {pack.digest ? ` · ${pack.digest.slice(0, 48)}${pack.digest.length > 48 ? "…" : ""}` : ""}
                              </span>
                            </span>
                            <button
                              type="button"
                              disabled={activating}
                              onClick={() => void onActivatePack(pack)}
                              className="shrink-0 cursor-pointer rounded-full px-2 py-0.5 text-ios-caption1 font-medium text-ios-blue transition-colors hover:bg-ios-blue/10 disabled:cursor-wait disabled:opacity-60"
                            >
                              {activating ? "使用中…" : "使用此包"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <p className="px-2.5 pt-1 pb-1.5 text-ios-caption2 text-foreground/35">
                    新会话将携带此资产包
                  </p>
                </div>
              )}
            </div>
            {headerExtra}
          </div>
        </div>
      </header>

      {/* D-24：承接使用者已打的半句话，点一下搬进输入框接着写（不自动送出，
          半句话直接送可能立刻扣费）；右侧「放弃」直接丢掉。 */}
      {contentIsCurrent && draft && (
        <div className="agent-surface-draft mb-2 flex shrink-0 items-center gap-2 rounded-ios-2xl bg-ios-blue/[0.07] px-3 py-2 ring-1 ring-ios-blue/[0.16]">
          <Bot className="h-3.5 w-3.5 shrink-0 text-ios-blue" aria-hidden="true" />
          <button
            type="button"
            onClick={continueDraft}
            className="min-w-0 flex-1 cursor-pointer truncate text-left text-sm text-muted-foreground lg-transition hover:text-ios-blue sm:text-ios-footnote"
            title="填进输入框接着写"
          >
            接着写：<span className="font-medium">{draft}</span>
          </button>
          <button
            type="button"
            onClick={() => setDraft("")}
            className="agent-draft-discard shrink-0 cursor-pointer rounded-full px-2 py-0.5 text-ios-caption1 font-medium text-foreground/45 lg-transition hover:bg-black/5 hover:text-muted-foreground"
            aria-label="不要这句话"
          >
            放弃
          </button>
        </div>
      )}

      {error && !isActive && (
        <div className="agent-surface-error mb-2 flex shrink-0 items-center justify-between gap-3 rounded-ios-2xl bg-destructive/[0.08] px-3.5 py-2.5">
          <p className="min-w-0 flex-1 text-sm text-destructive sm:text-ios-footnote">{error}</p>
          {/* 登录错误：重试无意义（token 不存在怎么重试都失败），
              给登录按钮（GitHub OAuth 弹窗，与 Navbar 同一条链路）；
              弹窗结束后 retry()——此时 token 已写入 localStorage，重试才真有效。 */}
          {isAuthError(error) ? (
            <button
              type="button"
              onClick={beginLogin}
              className="shrink-0 inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-ios-blue px-3 py-1 text-ios-caption1 font-semibold text-white shadow-[0_2px_8px_rgba(0,122,255,0.30)] transition-all duration-150 hover:bg-ios-blue/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/40"
            >
              <LogIn className="h-3 w-3" aria-hidden="true" />
              登录
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void retry()}
              className="agent-surface-retry shrink-0 cursor-pointer rounded-full bg-destructive/[0.14] px-3 py-1 text-ios-caption1 font-semibold text-destructive lg-transition hover:bg-destructive/[0.22]"
            >
              重试
            </button>
          )}
        </div>
      )}

      {/* PWA standalone 登录交接：面板轮询 claim 领回会话，完成后 retry()
          等效 onDone（登录态已写入，重试即刷新连接）；不走 popup 链路。 */}
      {handoffLogin && (
        <PwaHandoffPanel
          loginUrl={handoffLogin.loginUrl}
          onSuccess={() => {
            setHandoffLogin(null);
            void retry();
          }}
          onClose={() => setHandoffLogin(null)}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <AgentChatPanel
          key={chatHistoryUser?.id ?? "anonymous"}
          state={state}
          connection={connection}
          sessionId={sessionId}
          onEnsureSession={ensureSession}
          onSend={(text) => send(text)}
          onConfirm={(requestId, approved) => confirm(requestId, approved)}
          onAnswerQuestion={(requestId, answers) => answerQuestion(requestId, answers)}
          onRetryConnection={() => void retry()}
          imageActions={imageActions}
          videoActions={videoActions}
          audioActions={audioActions}
          anchor={anchor}
          onAnchor={() => void onAnchor()}
          onReanchor={() => void onReanchor()}
          onAnchorDismiss={onAnchorDismiss}
          anchorBusy={anchorBusy}
          /* D-26：只在助手还在产出时给「停止」——回合已结束时没有东西可停，
             摆一颗停不了任何东西的按钮是假承诺。 */
          onStopGeneration={state.turnActive ? onStopGeneration : undefined}
          /* 09-18：把 hook 的两个在途镜像接下去——aborting 让停止钮显「正在中止」，
             startingSession 让空态显「正在建立会话…」并撤掉推荐语。 */
          stopPending={aborting}
          sessionStarting={startingSession}
          prefill={contentIsCurrent ? prefill : null}
          onPrefillConsumed={clearPrefill}
          onFirstUserMessage={onUserMessage}
          attachFilesRef={attachFilesRef}
        />
      </div>

      {/* 图卡「再来 N 组／微调变体」的 payload 级重跑对话框；完成讯息走既有 notice
          通道落进 transcript（surface 无自有 toast，不另造一套）。 */}
      {contentIsCurrent && rerunDialog && (
        <RerunDialog
          entry={rerunDialog.entry}
          mode={rerunDialog.mode}
          onClose={() => setRerunDialog(null)}
          onDone={(message) => {
            setRerunDialog(null);
            dispatchNotice("info", message);
          }}
        />
      )}
    </div>
  );
}
