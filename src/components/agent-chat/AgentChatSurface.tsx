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

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
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
import {
  hasReflectedParams,
  reflectParams,
  type ReflectedParams,
} from "@/lib/agent-param-reflect";
import { cn } from "@/lib/utils";
import { listAgentSessions, type AgentSessionSummary } from "@/lib/agent-chat-client";
import { useAgentChat } from "@/hooks/use-agent-chat";
import { setCurrentAgentSession } from "@/lib/agent-current-session";
import { subscribeAgentSurfaceActions } from "@/lib/agent-surface-actions";
import {
  buildAnchorMessage,
  buildReanchorMessage,
  deriveBatchAnchor,
  shouldOfferBatchAnchor,
} from "@/lib/agent-batch-anchor";
import { AgentChatPanel } from "@/components/agent-chat/AgentChatPanel";
import { AgentSessionList } from "@/components/agent-chat/AgentSessionList";
import { AgentSettingsPopover } from "@/components/agent-chat/AgentSettingsPopover";
import { useIsNarrow } from "@/hooks/use-is-narrow";
import { PwaHandoffPanel } from "@/components/PwaHandoffPanel";
import { createHandoffLogin, isStandalonePwa } from "@/lib/github-login";
import type { AgentAudioItem, AgentImageItem, AgentVideoItem } from "@/lib/agent-chat-types";
import type { AssetPack, AssetPackItem } from "@/lib/asset-pack-store";
import type { AgentTranscriptProps } from "@/components/agent-chat/AgentTranscript";
import { assetUrlFieldOf } from "@/lib/deliverable-kind";
import {
  buildChatSaveItem,
  CHAT_ASSETS_PACK_ID,
  type AgentChatLibraryItem,
} from "@/lib/agent-chat-asset-builders";
import type { HistoryEntry } from "@/lib/history-types";
import {
  AGENT_MEDIA_HISTORY_MAX_ATTEMPTS,
  agentHistoryEntryForMedia,
  agentMediaItemIds,
  planAgentMediaHistoryWrites,
  saveAgentMediaToHistory,
} from "@/lib/agent-media-history";
import { imageExtensionFromUrl, stationAuthHeaders } from "@/lib/agent-image-share";
import { RerunDialog, type HistoryRerunMode } from "@/components/history/RerunDialog";

/** 登录类错误判定：客户端缺凭证（「尚未登录」）与服务端否定登入态的文案都算，
 *  这些不是重试能解决的，必须给登录按钮（2026-09-05：agent-session-guard 的
 *  「请先登录后再使用 AI 助理。」「登录状态已失效…」此前漏在判定外，弹窗只给假「重试」）。 */
function isAuthError(error: string): boolean {
  return error.includes("尚未登录")
    || error.includes("无法使用 Agent 助手")
    || error.includes("请先登录")
    || error.includes("登录状态已失效");
}

/**
 * GitHub OAuth 弹窗（与 Navbar 同一条链路：/api/auth/github/start popup）。
 * 完成信号三选一（2026-09-05 修「点了登录按钮回调没被接收」）：
 * ① /auth/complete 的 postMessage（成功）或首页 Navbar 转发的 github-auth-error（失败）；
 * ② storage 事件（napi_token 被弹窗写入，跨标签页可见）；
 * ③ popup.closed 轮询兜底（用户手动关窗/取消）。
 * 旧实现只认 ③——手机把弹窗开成新标签、或 window.close() 被拦时，
 * 登录早已完成却永远等不到「关闭」，重试不触发，看起来就是回调丢了。
 */
async function startLoginThenRetry(_onDone: () => Promise<void>): Promise<void> {
  // 登录一律同窗口跳转：popup 在套壳/内嵌 webview 上会出现死窗（三个完成
  // 信号全部不来）。同窗口跳转全浏览器兼容；用户登录完回来，会话经本地
  // 存档 resume 续上，再补一次 onDone 刷新。
  window.location.href = "/api/auth/github/start";
}

/** 会话目录条目标题（双轨）：优先显示网关摘要标题（09-12 契约，opencode 首轮
 *  生成的 title，有值即用）；无标题（null/缺栏/全空白）时降级为创建时间合成的
 *  可读时间标签兜底。
 *  唯一实作留在本档（agent-chat-ui.test.ts 对它有源码锚点）；AgentSessionList
 *  透过 formatLabel prop 受注入，不复制第二份。 */
export function formatSessionLabel(it: AgentSessionSummary): string {
  const t = typeof it.title === 'string' ? it.title.trim() : '';
  if (t) return t;
  const d = new Date(it.created_at);
  const date = d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time} 的对话`;
}

/**
 * 真下载：走站内同源代理 /api/media-download（带既有鉴权标头）把位元组取回，
 * blob → objectURL → `<a download>`。**不再有 window.open 那条 fallback**——
 * 打开附件连结不是下载（暴君点名的病征）。成功回 true，失败回 false（卡片据此闪「失败」）。
 */
async function triggerDownload(url: string, filename: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/media-download?url=${encodeURIComponent(url)}`, {
      headers: stationAuthHeaders(),
    });
    if (!res.ok) return false;
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
    return true;
  } catch {
    return false;
  }
}

/** 300ms debounce 的字串值。 */
function useDebouncedValue(value: string, delayMs = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}


export interface AgentChatSurfaceProps {
  /** page = 独立路由页；inline = 从卡片入口进来的内嵌聊天区（D-1）。 */
  variant?: "page" | "inline";
  /** 嵌入态（工作站面板）：外层已有拖拽把手与容器，Surface 不再自带把手，
      边距收紧——单层容器，不留二次 padding。 */
  embedded?: boolean;
  /**
   * 入口按下那一刻输入框里已经打好的半句话（D-24「承接使用者已打的半句话」）。
   * 不自动送出：半句话直接送出去可能立刻触发扣费，与 D-5「花钱前必定交用户确认」
   * 冲突。这里呈现成一颗可点的续写药丸，点一下才进对话。
   */
  initialPrompt?: string;
  /**
   * 会话深链（wish 插件 ?agent=1&session=<uuid>）：挂载时直开该会话。
   * 09-12：autoStart 已撤（建号权在发送按钮），挂载本来即空态不建号——这里
   * 只是把落点从「空态」换成 switchSession 目标会话；
   * 目标不存在/已被回收则静默退回空态（开新＝清空，不再预建），不弹错打断落地体验。
   */
  initialSessionId?: string;
  /** inline 变体的退出去向（回工作台）。page 变体不用。 */
  onExit?: () => void;
  /** 2026-08-22：工作站态把「收合成细栏」按钮并入这里的图标组——
      面板不再自长一条顶栏，触发前后是同一个 header。 */
  headerExtra?: import("react").ReactNode;
  /**
   * D-12：助理实际用过的参数回流给工作台控件。
   * 只在内嵌变体有意义（独立页背后没有控件可回填），缺席就不回流。
   * 当前控件上的模型要一起传进来——比例/解析度的合法集合取决于模型。
   */
  onParamsReflected?: (params: ReflectedParams) => void;
  currentModelId?: string;
  /**
   * 每次 agent 产出新图时回调，把 URL 推进右侧 ImageDisplay。
   * 不只是聊天区显示——右侧不更新等于没有。
   */
  onImageResult?: (url: string) => void;
  /** 画布 SSE 事件分流（v3 embed）：canvas.* 事件转交右侧 CanvasEmbed。 */
  onCanvasEvent?: (event: import("@/lib/agent-chat-types").AgentSseEvent) => void;
  /** 发送前提供画布摘要（v3 embed）。 */
  canvasStateProvider?: () => unknown;
  /** 当 agent session 变化时通知父组件（用于同步清空画布）。 */
  onSessionChange?: (sessionId: string | null) => void;
  /**
   * 双向同步：把 switchSession 能力上抛给父层。画布选中某个带
   * session_id 的 workflow 节点时，父层要能切到该节点所属的会话——
   * 这条通道就是那根把手（画布 → chat 方向唯一入口）。
   */
  switchSessionRef?: MutableRefObject<((sessionId: string) => Promise<boolean>) | null>;
  /** 暴君裁定 2026-09-01：套模板需要「留旧开新」；父层传 ref 上抛 startNewSession。 */
  startNewSessionRef?: MutableRefObject<(() => Promise<boolean>) | null>;
  /**
   * 2026-08-25 模板库点卡：要自动发出的第一条用户消息（模板 initialPrompt）。
   * 与 initialPrompt（半句话药丸，点了才送）不同：点模板卡本身就是发送动作，
   * 这条直接送出，不让用户再点一次发送。nonce 变化即触发一次。
   *
   * echo（2026-09-27）：这条讯息要不要当成「使用者自己说的话」进 transcript。
   * 模板注入＝一长串机器配方，默认不进（silent）；但宣传片结尾那句是使用者自己
   * 打的，必须进——不然送出后到他看到第一个字之前是一片空白（暴君：TTFT 前空白）。
   */
  agentInjection?: { text: string; nonce: number; directive?: string; echo?: boolean } | null;
  /** 用户发出消息时回调（上层收起右侧模板库）。 */
  onUserMessage?: () => void;
  /**
   * 一句话因为「没登入」送不出去时上抛（上层留住，登入后补送）。
   * 详见 use-agent-chat 的 UseAgentChatOptions.onSendBlockedByAuth。
   */
  onSendBlockedByAuth?: (text: string) => void;
  /**
   * 外部「把这句话预填进输入框」（新人礼首登弹窗的主按钮）。只搬运不发送——
   * 半句话直接送出去会立刻开一轮扣费生成（D-5），所以走与 D-24 药丸同一条
   * prefill 通路：输入框有字、光标在末尾、焦点在框上，人再按送出。
   * 只认 nonce 变化，输入区吃掉后不重播（见下面的 effect）。
   */
  prefillRequest?: { text: string; nonce: number } | null;
}

/**
 * outside-click 放行判定（纯函数，可直测，无须 DOM）：目标节点落在宽屏下拉的
 * anchor（historyRef）或 portal 到 document.body 的窄屏抽屉（historyDrawerRef）
 * 内，都算「浮层里面」。抽屉 portal 出去后不再被 historyRef 涵盖，这个 ref 是
 * 它唯一的放行来源；窄屏抽屉内点搜寻框、点列，全靠它不被误收。
 */
export function isInsideHistorySurface(
  anchor: { contains: (node: Node | null) => boolean } | null,
  drawer: { contains: (node: Node | null) => boolean } | null,
  target: Node | null,
): boolean {
  return Boolean(anchor?.contains(target) || drawer?.contains(target));
}

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
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  // 「我的资产」面板：null = 未加载，[] = 已加载但为空。
  const [showAssets, setShowAssets] = useState(false);
  const [assetPacks, setAssetPacks] = useState<AssetPack[] | null>(null);
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
  const [historyList, setHistoryList] = useState<AgentSessionSummary[] | null>(null);
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

  const lastAssetQueryRef = useRef<string | null>(null);

  /** 拉取资产包列表；q 非空时走 ?q= 服务端搜索，空字串还原为全量。同 query 去重。 */
  const loadAssets = useCallback(async (q: string): Promise<void> => {
    const query = q.trim();
    if (query === lastAssetQueryRef.current) return;
    lastAssetQueryRef.current = query;
    try {
      const url = query ? `/api/assets?q=${encodeURIComponent(query)}` : "/api/assets";
      const res = await fetch(url);
      if (!res.ok) {
        lastAssetQueryRef.current = null; // 失败要能重拉，不能被去重挡死
        return;
      }
      const data = (await res.json()) as { packs?: AssetPack[] };
      if (Array.isArray(data?.packs)) setAssetPacks(data.packs);
    } catch {
      // 静默失败：面板保持原状，可重试（清去重标记）。
      lastAssetQueryRef.current = null;
    }
  }, []);

  /*
   * 2026-10-01 暴君「打开反应缓慢」：悬停/聚焦顶栏图标就先拉数据，点下去时列表多半已就绪。
   * 去重交给 loadAssets 的 lastAssetQueryRef 与 historyLoadingRef，悬停多次不重复请求。
   */
  const prefetchAssets = useCallback((): void => {
    if (assetPacks === null) void loadAssets("");
  }, [assetPacks, loadAssets]);

  /** 我的资产：开关。首次打开拉全量；搜索词变化由下方 effect 重新拉取。 */
  const toggleAssets = useCallback(async (): Promise<void> => {
    setShowAssets((prev) => {
      const next = !prev;
      // 2026-10-01 修：原本先把 lastAssetQueryRef 设成 "" 再 loadAssets("")——去重判定
      // 当场命中直接 return，首开永远不发请求，面板卡在「正在加载资产…」直到用户打字。
      if (next && assetPacks === null) void loadAssets("");
      return next;
    });
  }, [assetPacks, loadAssets]);

  // 搜索词（300ms debounce）变化 → 重新拉取（空字串还原为全量）。
  useEffect(() => {
    if (!showAssets) return;
    void loadAssets(debouncedAssetQuery);
  }, [showAssets, debouncedAssetQuery, loadAssets]);

  /** 使用此包：把该包 active:true 写回（store 自动清其它包 active），成功后收面板。 */
  const onActivatePack = useCallback(
    async (pack: AssetPack): Promise<void> => {
      if (activatingPackId !== null) return;
      setActivatingPackId(pack.id);
      try {
        const res = await fetch("/api/assets", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...pack, active: true }),
        });
        if (res.ok) setShowAssets(false);
      } catch {
        // 静默失败：面板留在原地，用户可重试。
      } finally {
        setActivatingPackId(null);
      }
    },
    [activatingPackId],
  );

  /** dropdown 开关：第一次打开时拉取目录（之后直接切换显示，不重复请求）。 */
  const historyLoadingRef = useRef(false);
  const prefetchHistory = useCallback((): void => {
    if (historyList !== null || historyLoadingRef.current) return;
    historyLoadingRef.current = true;
    void listAgentSessions()
      .then(setHistoryList)
      .catch(() => setHistoryList([]))
      .finally(() => {
        historyLoadingRef.current = false;
      });
  }, [historyList]);

  const toggleHistory = useCallback(async (): Promise<void> => {
    setShowHistory((prev) => {
      const next = !prev;
      if (next) prefetchHistory();
      return next;
    });
  }, [prefetchHistory]);

  /** 点选某个历史会话：切过去（SSE 续传 agent 端上下文），成功后收起 dropdown。 */
  const onPickSession = useCallback(async (targetSessionId: string): Promise<void> => {
    if (switchingTo !== null) return;
    setSwitchingTo(targetSessionId);
    try {
      const ok = await switchSession(targetSessionId);
      // 成功：收起 dropdown 并清快照。失败：也收起——switchSession 已在失败分支
      // 经既有 dispatchNotice（transcript notice）/ setError（非活跃时横幅）链路把原因
      // 说清楚，surface 本身无自有 toast/notice seam，留著遮罩只会挡住那条反馈，
      // 于是「静默失败」变成「看得见的人话」（不自造轮子）。
      setShowHistory(false);
      if (ok) setHistorySnapshot(null);
    } finally {
      setSwitchingTo(null);
    }
  }, [switchingTo, switchSession]);
  const didAutoFreshStartRef = useRef(false);

  // 深链落地：mount 时切到 URL 指定的会话（wish 插件 ?agent=1&session=<uuid>）。
  // 只试一次；失败（会话不存在/已被回收/网关重启丢会话）静默退回开新会话——
  // 落地体验不该被一条死链接卡住，切换失败的具体原因由 switchSession 自己记录。
  const didApplyDeepLinkRef = useRef(false);
  useEffect(() => {
    if (!initialSessionId || didApplyDeepLinkRef.current) return;
    didApplyDeepLinkRef.current = true;
    void (async () => {
      const ok = await switchSession(initialSessionId);
      if (!ok) await startNewSession();
    })();
    // 深链只属于挂载那一刻；switchSession / startNewSession 引用稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSessionId]);

  /** 开新对话：旧会话留在历史里可切回；成功后收 dropdown 并让历史目录重拉。 */
  const onStartNewSession = useCallback(async (): Promise<void> => {
    if (startingNew) return;
    setStartingNew(true);
    try {
      const ok = await startNewSession();
      if (ok) {
        setShowHistory(false);
        setHistorySnapshot(null);
        setHistoryList(null); // 置 null = 未载入，下次打开 dropdown 重新拉目录（新会话入列）
      }
    } finally {
      setStartingNew(false);
    }
  }, [startingNew, startNewSession]);

  // 跨元件动作桥（窄屏侧栏叫动本面顶栏钮）：侧栏与本面不住同一棵元件树，
  // 走 window CustomEvent。回 true＝本面处理掉了，桥会 preventDefault，让
  // 侧栏知道不必退回导航；"exit" 无 onExit 时回 false，侧栏自行导航。
  useEffect(() => {
    return subscribeAgentSurfaceActions((action) => {
      switch (action) {
        case "assets":
          void toggleAssets();
          return true;
        case "history":
          void toggleHistory();
          return true;
        case "settings":
          openSettings();
          return true;
        case "new-session":
          void onStartNewSession();
          return true;
        case "exit":
          if (!onExit) return false;
          onExit();
          return true;
        default:
          return false;
      }
    });
  }, [toggleAssets, toggleHistory, openSettings, onStartNewSession, onExit]);

  // quota 字段保留在 hook state 里但不再展示——余额端点缺失是已知稳态，
  // 展示「余额未知」只浪费布局空间，扣费仍正常记账。
  const isActive = connection !== "idle" && connection !== "closed";
  const isInline = variant === "inline";

  const onSaveToLibrary = useCallback(async (item: AgentChatLibraryItem): Promise<boolean> => {
    // 客户端幂等：连点两下不该在资产包里躺两条一样的记录；去重命中也算「已存入」。
    if (savedIds.has(item.id)) return true;
    try {
      const now = new Date().toISOString();
      // 1. 拉取现有资产包，找「聊天素材」确定性包（不存在则构造空包）。
      const listRes = await fetch("/api/assets");
      const data = listRes.ok ? ((await listRes.json()) as { packs?: AssetPack[] }) : null;
      const packs = Array.isArray(data?.packs) ? data.packs : [];
      const existing = packs.find((p) => p.id === CHAT_ASSETS_PACK_ID);
      // 2. 去重键按种类走各自的 URL 栏位（图→imageUrl，影片/音频→mediaUrl）：
      //    不让影片拿图片的 imageUrl 去比，图片既有去重逻辑逐字不受影响。
      const urlField = assetUrlFieldOf(item.kind);
      if (existing?.items.some((it) => it[urlField] === item.url)) {
        setSavedIds((prev) => new Set([...prev, item.id]));
        return true;
      }
      const newItem: AssetPackItem = buildChatSaveItem(item, sessionId, now);
      const pack: AssetPack = existing
        ? { ...existing, items: [...existing.items, newItem], updatedAt: now }
        : {
            id: CHAT_ASSETS_PACK_ID,
            title: "聊天素材",
            items: [newItem],
            tags: [],
            createdAt: now,
            updatedAt: now,
          };
      // 3. PUT 整包 upsert（store 按 id 覆写，单用户写入串行）。
      const res = await fetch("/api/assets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pack),
      });
      if (!res.ok) return false;
      setSavedIds((prev) => new Set([...prev, item.id]));
      return true;
    } catch {
      // 回 false＝卡片显示短暂「未存入」；图还在，用户仍可下载。
      return false;
    }
  }, [savedIds, sessionId]);

  // 媒体卡「改图」把图加进输入框附件的既有入口（AgentComposer.enqueueFiles 经此上抛）。
  const attachFilesRef = useRef<((files: File[]) => void) | null>(null);

  // D-9：改图＝把图抓回、组 File 加进附件列（走既有附件上传状态机），**不送任何消息**。
  // 输入框出现 chip 就是回馈；抓取中/失败由卡片按钮自身呈现。
  const onEdit = useCallback(async (item: AgentImageItem): Promise<boolean> => {
    const attach = attachFilesRef.current;
    if (!attach) return false;
    try {
      const res = await fetch(`/api/media-download?url=${encodeURIComponent(item.url)}`, {
        headers: stationAuthHeaders(),
      });
      if (!res.ok) return false;
      const blob = await res.blob();
      const ext = imageExtensionFromUrl(item.url);
      const file = new File([blob], `agent-image-${item.seq}.${ext}`, {
        type: blob.type || "image/png",
      });
      attach([file]);
      return true;
    } catch {
      return false;
    }
  }, []);

  const onDownload = useCallback(async (item: AgentImageItem): Promise<boolean> => {
    return triggerDownload(item.url, `agent-${Date.now()}.png`);
  }, []);

  // 影片下载：与图片同一条 triggerDownload 路径，副档名换 mp4。
  const onVideoDownload = useCallback(async (item: AgentVideoItem): Promise<boolean> => {
    return triggerDownload(item.url, `agent-${Date.now()}.mp4`);
  }, []);
  // 影片「存图库」已接线（见下方 videoActions）：item 经 assetItemKindOf/
  // assetUrlFieldOf 落 kind:"video" + mediaUrl（agent-chat-asset-builders）。
  // 音频下载：与影片同一条 triggerDownload 路径；副档名优先取 URL 自带者
  // （FlowMusic/lyria 出 m4a，TTS 出 mp3），取不到时回落 m4a。
  const onAudioDownload = useCallback(async (item: AgentAudioItem): Promise<boolean> => {
    const ext = /\.(m4a|mp3|wav|ogg|opus|aac|flac)(?:$|\?)/i.exec(item.url)?.[1] ?? "m4a";
    return triggerDownload(item.url, `agent-${Date.now()}.${ext}`);
  }, []);
  // 音频「存图库」同影片已接线：kind:"audio" + mediaUrl（见下方 audioActions）。

  // D-12：盯住最新一条工具调用，把助理实际用的参数回流给工作台控件。
  // 用 ref 记住处理过的条目 id——重渲染不该把同一次调用回流两次，
  // 那会把使用者刚手动改回去的值又冲掉。
  const reflectedRef = useRef<string | null>(null);

  // 监听 sessionId 变化，通知父组件（用于同步清空画布）
  useEffect(() => {
    if (onSessionChange) {
      onSessionChange(sessionId);
    }
  }, [sessionId, onSessionChange]);

  // 双向同步：把 switchSession 能力上抛给父层（画布选中 workflow 节点时切会话）。
  useEffect(() => {
    if (switchSessionRef) switchSessionRef.current = switchSession;
  }, [switchSession, switchSessionRef]);

  // 暴君裁定 2026-09-01：把 startNewSession 能力同模式上抛（套模板 = 留旧开新）。
  useEffect(() => {
    if (startNewSessionRef) startNewSessionRef.current = startNewSession;
  }, [startNewSession, startNewSessionRef]);

  useEffect(() => {
    if (!onParamsReflected) return;
    // 从后往前找最新一条带参数的工具条目
    for (let i = state.items.length - 1; i >= 0; i -= 1) {
      const item = state.items[i];
      if (item.kind !== "tool") continue;
      if (item.argsSummary === undefined) continue;
      // 守卫键带上当前模型 id：同一条工具调用若在不同模型下被重新处理
      // （例如模型切换后重新回流参数），不应被「已回流过」误挡。
      const effectiveModelId = currentModelId ?? "";
      const guardKey = `${item.id}:${effectiveModelId}`;
      if (reflectedRef.current === guardKey) return; // 这条（在这个模型下）已经回流过
      reflectedRef.current = guardKey;
      const params = reflectParams(item.argsSummary, effectiveModelId);
      if (hasReflectedParams(params)) onParamsReflected(params);
      return;
    }
  }, [state.items, onParamsReflected, currentModelId]);

  // 每次 transcript 里出现新图，把 URL 推给右侧 ImageDisplay。
  // ref 守门避免同一张图因重渲染多次回调。
  const lastImageIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onImageResult) return;
    for (let i = state.items.length - 1; i >= 0; i -= 1) {
      const item = state.items[i];
      if (item.kind !== "image") continue;
      if (lastImageIdRef.current === item.id) return;
      lastImageIdRef.current = item.id;
      onImageResult(item.url);
      return;
    }
  }, [state.items, onImageResult]);

  /*
   * 自动落历史：助理产出的图／影片／音乐不需要使用者按钮就进生成历史（幂等 upsert）。
   *
   * 边界＝「本会话连线就绪」那一刻：连线 open 时先把当下已存在的媒体条目记为基准
   * （深链／历史切换还原回放的旧作品在生成时早就写过，这里不补写、不覆盖），
   * 之后才出现的才是本轮新产物。id 稳定（agent-<taskId>，无 taskId 用 url 杂凑），
   * 同一媒体重复写不会长第二条。写失败静默——历史是旁路，不占用户的对话流。
   */
  const mediaHistoryProcessedRef = useRef<Set<string>>(new Set());
  const mediaHistoryPrimedSessionRef = useRef<string | null>(null);
  const mediaHistoryInFlightRef = useRef<Set<string>>(new Set());
  const mediaHistoryAttemptsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!sessionId || connection !== "open") return;
    if (mediaHistoryPrimedSessionRef.current !== sessionId) {
      // 切换会话（或深链还原落点）＝新基准点：同时重设 processed／in-flight／重试计数——
      // 当下已存在的旧媒体一律视为「生成时早写过」，不补写；计数不跨会话累积。
      mediaHistoryPrimedSessionRef.current = sessionId;
      mediaHistoryProcessedRef.current = new Set(agentMediaItemIds(state.items));
      mediaHistoryInFlightRef.current = new Set();
      mediaHistoryAttemptsRef.current = new Map();
      return;
    }
    const plan = planAgentMediaHistoryWrites(
      state.items,
      mediaHistoryProcessedRef.current,
      mediaHistoryInFlightRef.current,
      mediaHistoryAttemptsRef.current,
    );
    // 送出前只占位本轮要送的 id（＋重试用尽判放弃者），不再把全部媒体一律标记；
    // 失败且未达上限者会在回调里从 processed 撤回，下一轮效应触发时重试。
    mediaHistoryProcessedRef.current = new Set(plan.nextProcessedIds);
    if (plan.writes.length === 0) return;
    for (const { itemId, entry } of plan.writes) {
      mediaHistoryInFlightRef.current.add(itemId);
      const onFailure = (): void => {
        const used = (mediaHistoryAttemptsRef.current.get(itemId) ?? 0) + 1;
        mediaHistoryAttemptsRef.current.set(itemId, used);
        // 未达上限 → 撤回占位，放回 pending 供下次效应重试；
        // 用尽上限 → 留在 processed（明确不可救的失败才定案为已处理），不影响其他条目。
        if (used < AGENT_MEDIA_HISTORY_MAX_ATTEMPTS) {
          mediaHistoryProcessedRef.current.delete(itemId);
        }
      };
      void saveAgentMediaToHistory(entry)
        .then((ok) => {
          if (!ok) onFailure();
        }, onFailure)
        .finally(() => {
          mediaHistoryInFlightRef.current.delete(itemId);
        });
    }
  }, [state.items, connection, sessionId]);

  /**
   * D-24 无缝续写：点药丸 = 把半句话搬进输入框，光标落末尾，人接着打。
   * 不直接 send —— 半句话送出去可能立刻开一轮扣费的生成（D-5）。
   */
  const continueDraft = useCallback((): void => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setPrefill({ text, nonce: Date.now() });
  }, [draft]);

  /**
   * 外部预填（新人礼弹窗主按钮）：与 D-24 药丸同一条通路——只搬进输入框，不发送。
   * 依赖是物件参考，所以「同一句话再点一次」由父层换 nonce 触发；输入区吃掉后
   * 会把 internal prefill 清空，而这里的依赖没变，不会重播（人在打字的东西不会被冲）。
   */
  useEffect(() => {
    if (!prefillRequest) return;
    setPrefill(prefillRequest);
  }, [prefillRequest]);

  // 稳定的引用：输入区把它放在 effect 依赖里，每次渲染换新函数会白跑一轮。
  const clearPrefill = useCallback((): void => setPrefill(null), []);

  /*
   * 暴君裁定 2026-09-01：进页默认起新聊天，不静默续旧——旧对话留在网关
   * 历史下拉，随时切回。同一次访问 toggle 往返不走这里（sessionTouchedInThisVisit
   * 时 resumable 根本不会被设置）。09-12 建号权收归发送按钮后，这里的
   * startNewSession 只把界面清回空态、不建号——预建的旧存档收下后不再驱动任何开场。
   * 深链（initialSessionId）另有 switchSession 接管，这里让路避免落点赛跑。
   *
   * ref 守门是必须的：resumable 会在相关路径里被清成
   * null，effect 因此至少跑两次；没有守门，任何让 resumable 再次非空的路径
   * 都会重跑一次清空。每次 mount 只自动开一次。
   */
  useEffect(() => {
    if (!resumable || didAutoFreshStartRef.current) return;
    didAutoFreshStartRef.current = true;
    if (initialSessionId) return;
    void startNewSession();
  }, [resumable, startNewSession, initialSessionId]);

  /**
   * 2026-08-25 模板注入；2026-09-12 改「nonce 到即发」：
   * 旧实现等 connection === "open" 才 send——那是 autoStart/预建年代的时序
   * （连线总在注入前开好了）。现在进助理不建号不连线，等 open 等于把注入饿死。
   * send() 内部自带 lazy 建号＋连线（ensure 在乐观插入之前），这里不再需要闸门。
   * ref 记 nonce：只在拿到新的注入时发一次，重渲染不重发。
   */
  const injectedNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!agentInjection || injectedNonceRef.current === agentInjection.nonce) return;
    injectedNonceRef.current = agentInjection.nonce;
    onUserMessage?.();
    // directive 隐形上送（网关拼进 system）；模板注入默认 silent，echo 才进 transcript。
    void send(agentInjection.text, {
      ...(agentInjection.directive ? { sessionDirective: agentInjection.directive } : {}),
      silent: !agentInjection.echo,
    });
  }, [agentInjection, send, onUserMessage]);

  /**
   * D-26 首张锚定。第一张图 + 产出它的那次工具调用参数都在 transcript 里，
   * 推不出可复现参数时 deriveBatchAnchor 回 null，卡片自然不出现。
   */
  const derivedAnchor = useMemo(() => deriveBatchAnchor(state.items), [state.items]);
  // 只有用户表达过批量意图（≥2 张图或消息里带批量措辞）才弹锚定卡：
  // 只要了一张图的人不该被追问「要不要出完整批」。
  const anchor =
    derivedAnchor && derivedAnchor.imageId !== anchorAskedFor && shouldOfferBatchAnchor(state.items)
      ? derivedAnchor
      : null;

  /** 「就按这张」：把第一张实际用过的参数念回给 agent，让它照抄而不是重猜。 */
  const onAnchor = useCallback(async (): Promise<void> => {
    if (!anchor) return;
    setAnchorBusy(true);
    setAnchorAskedFor(anchor.imageId);
    try {
      await send(buildAnchorMessage(anchor));
    } finally {
      setAnchorBusy(false);
    }
  }, [anchor, send]);

  /** 「换个方向」：先回到一张，满意再放量——不拿一整批的钱去赌一个方向。 */
  const onReanchor = useCallback(async (): Promise<void> => {
    if (!anchor) return;
    setAnchorBusy(true);
    setAnchorAskedFor(anchor.imageId);
    try {
      await send(buildReanchorMessage(anchor));
    } finally {
      setAnchorBusy(false);
    }
  }, [anchor, send]);

  /** 「不用了」：纯 UI，不送消息。 */
  const onAnchorDismiss = useCallback((): void => {
    if (!anchor) return;
    setAnchorAskedFor(anchor.imageId);
  }, [anchor]);

  /**
   * D-26「随时可停」。系统层强制中止：网关 /session/:id/abort 打到 opencode，
   * 正在跑的这一轮直接终止（不再花后面的钱）。这不是发 prompt 软停。
   */
  const onStopGeneration = useCallback((): void => {
    void abort();
  }, [abort]);

  /*
   * 三张卡的「再来 N 组／微调」：
   *  - 图：payload 级重跑（RerunDialog → /api/generation-jobs，逐任务帐本预检、明码计价）。
   *  - 影片／音频：会话级（payload 级对按秒计费不开放）——「再来 N 组」翻成一句话用
   *    既有 send() 丢回对话，让助理重新决定参数；「微调」只预填输入框，不自动送出
   *    （半句话直接送出去会立刻开一轮扣费生成）。
   */
  const onImageRerun = useCallback((item: AgentImageItem): void => {
    setRerunDialog({ entry: agentHistoryEntryForMedia(item), mode: "rerun" });
  }, []);
  const onImageRerunVariant = useCallback((item: AgentImageItem): void => {
    setRerunDialog({ entry: agentHistoryEntryForMedia(item), mode: "variant" });
  }, []);
  const onVideoRerun = useCallback((item: AgentVideoItem, count: number): void => {
    const kind = item.mediaKind === "film" ? "成片" : "影片";
    void send(`把上一条${kind}按原参数再来 ${count} 组（第 ${item.seq} 段，${item.url}）`);
  }, [send]);
  const onVideoVariant = useCallback((item: AgentVideoItem): void => {
    const kind = item.mediaKind === "film" ? "成片" : "影片";
    setPrefill({ text: `微调第 ${item.seq} 段${kind}（${item.url}）：`, nonce: Date.now() });
  }, []);
  const onAudioRerun = useCallback((item: AgentAudioItem, count: number): void => {
    const kind = item.mediaKind === "music" ? "音乐" : "音频";
    void send(`把上一条${kind}按原参数再来 ${count} 组（第 ${item.seq} 段，${item.url}）`);
  }, [send]);
  const onAudioVariant = useCallback((item: AgentAudioItem): void => {
    const kind = item.mediaKind === "music" ? "音乐" : "音频";
    setPrefill({ text: `微调第 ${item.seq} 段${kind}（${item.url}）：`, nonce: Date.now() });
  }, []);

  const imageActions: AgentTranscriptProps["imageActions"] = {
    onSaveToLibrary,
    onEdit,
    onDownload,
    onRerun: onImageRerun,
    onRerunVariant: onImageRerunVariant,
  };

  const videoActions: AgentTranscriptProps["videoActions"] = {
    onSaveToLibrary,
    onDownload: onVideoDownload,
    onRerun: onVideoRerun,
    onVariant: onVideoVariant,
  };

  const audioActions: AgentTranscriptProps["audioActions"] = {
    onSaveToLibrary,
    onDownload: onAudioDownload,
    onRerun: onAudioRerun,
    onVariant: onAudioVariant,
  };

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
      {draft && (
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
          prefill={prefill}
          onPrefillConsumed={clearPrefill}
          onFirstUserMessage={onUserMessage}
          attachFilesRef={attachFilesRef}
        />
      </div>

      {/* 图卡「再来 N 组／微调变体」的 payload 级重跑对话框；完成讯息走既有 notice
          通道落进 transcript（surface 无自有 toast，不另造一套）。 */}
      {rerunDialog && (
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
