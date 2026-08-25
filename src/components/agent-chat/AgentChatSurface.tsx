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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, History, Loader2, MessageSquarePlus, X } from "lucide-react";
import {
  hasReflectedParams,
  reflectParams,
  type ReflectedParams,
} from "@/lib/agent-param-reflect";
import { cn } from "@/lib/utils";
import { listAgentSessions, type AgentSessionSummary } from "@/lib/agent-chat-client";
import { useAgentChat } from "@/hooks/use-agent-chat";
import {
  buildAnchorMessage,
  buildReanchorMessage,
  deriveBatchAnchor,
} from "@/lib/agent-batch-anchor";
import { AgentChatPanel } from "@/components/agent-chat/AgentChatPanel";
import type { AgentImageItem } from "@/lib/agent-chat-types";
import type { AgentTranscriptProps } from "@/components/agent-chat/AgentTranscript";

function formatSavedAt(savedAt: number): string {
  const diff = Date.now() - savedAt;
  if (!Number.isFinite(diff) || diff < 0) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(savedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** 会话目录条目标题：无标题数据源，用创建时间 + 相对新近度组合一个可读标签。 */
function formatSessionLabel(it: AgentSessionSummary): string {
  const d = new Date(it.created_at);
  const date = d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time} 的对话`;
}

async function triggerDownload(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}


export interface AgentChatSurfaceProps {
  /** page = 独立路由页；inline = 从卡片入口进来的内嵌聊天区（D-1）。 */
  variant?: "page" | "inline";
  /** 嵌入態（工作站面板）：外層已有拖拽把手與容器，Surface 不再自帶把手，
      邊距收緊——單層容器，不留二次 padding。 */
  embedded?: boolean;
  /**
   * 入口按下那一刻输入框里已经打好的半句话（D-24「承接使用者已打的半句话」）。
   * 不自动送出：半句话直接送出去可能立刻触发扣费，与 D-5「花钱前必定交用户确认」
   * 冲突。这里呈现成一颗可点的续写药丸，点一下才进对话。
   */
  initialPrompt?: string;
  /**
   * 会话深链（wish 插件 ?agent=1&session=<uuid>）：挂载时直开该会话。
   * 提供时跳过 autoStart 的自动开场，改为 switchSession 到目标会话；
   * 目标不存在/已被回收则静默退回「开新会话」，不弹错打断落地体验。
   */
  initialSessionId?: string;
  /** inline 变体的退出去向（回工作台）。page 变体不用。 */
  onExit?: () => void;
  /** 2026-08-22：工作站態把「收合成細欄」按鈕併入這裡的圖標組——
      面板不再自長一條頂欄，觸發前後是同一個 header。 */
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
  /** 畫布 SSE 事件分流（v3 embed）：canvas.* 事件轉交右側 CanvasEmbed。 */
  onCanvasEvent?: (event: import("@/lib/agent-chat-types").AgentSseEvent) => void;
  /** 發送前提供畫布摘要（v3 embed）。 */
  canvasStateProvider?: () => unknown;
  /** 當 agent session 變化時通知父組件（用於同步清空畫布）。 */
  onSessionChange?: (sessionId: string | null) => void;
  /**
   * 2026-08-25 模板庫點卡：要自動發出的第一條用戶消息（模板 initialPrompt）。
   * 與 initialPrompt（半句話藥丸，點了才送）不同：點模板卡本身就是發送動作，
   * 這條直接送出，不讓用戶再點一次發送。nonce 變化即觸發一次。
   */
  agentInjection?: { text: string; nonce: number; directive?: string } | null;
  /** 用戶發出消息時回調（上層收起右側模板庫）。 */
  onUserMessage?: () => void;
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
  agentInjection,
  onUserMessage,
  onExit,
  headerExtra,
}: AgentChatSurfaceProps) {
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  // 承接进来的半句话；续写或手动放弃后就不再显示。
  const [draft, setDraft] = useState(initialPrompt.trim());
  // 交给输入区的续写信号（D-24）。输入区吃掉后回调清空，避免重复注入。
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
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
    discardAndStartNew,
    resume,
    switchSession,
    startNewSession,
  } = useAgentChat({
    // 深链接管开场：有 initialSessionId 时不自动开新会话（否则会先建一个
    // 空会话再切走，网关历史里多一条垃圾），由下面的 mount effect 切目标。
    autoStart: !initialSessionId,
    ...(onCanvasEvent ? { onCanvasEvent } : {}),
    ...(canvasStateProvider ? { canvasStateProvider } : {}),
  });
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
  const [historySnapshot, setHistorySnapshot] = useState<{ itemCount: number; savedAt: number } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  // 会话目录（对话历史 dropdown 的数据）：null = 未加载，[] = 已加载但为空。
  const [historyList, setHistoryList] = useState<AgentSessionSummary[] | null>(null);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [startingNew, setStartingNew] = useState(false);
  const historyRef = useRef<HTMLDivElement | null>(null);

  // 開著的 dropdown：點外面就收——浮層不該把人鎖在原地。
  useEffect(() => {
    if (!showHistory) return;
    const onDocPointerDown = (ev: PointerEvent): void => {
      if (historyRef.current && !historyRef.current.contains(ev.target as Node)) {
        setShowHistory(false);
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [showHistory]);

  /** dropdown 开关：第一次打开时拉取目录（之后直接切换显示，不重复请求）。 */
  const toggleHistory = useCallback(async (): Promise<void> => {
    setShowHistory((prev) => {
      const next = !prev;
      if (next && historyList === null) {
        void listAgentSessions()
          .then(setHistoryList)
          .catch(() => setHistoryList([]));
      }
      return next;
    });
  }, [historyList]);

  /** 点选某个历史会话：切过去（SSE 续传 agent 端上下文），成功后收起 dropdown。 */
  const onPickSession = useCallback(async (targetSessionId: string): Promise<void> => {
    if (switchingTo !== null) return;
    setSwitchingTo(targetSessionId);
    try {
      const ok = await switchSession(targetSessionId);
      if (ok) {
        setShowHistory(false);
        setHistorySnapshot(null);
      }
    } finally {
      setSwitchingTo(null);
    }
  }, [switchingTo, switchSession]);
  const didAutoDiscardRef = useRef(false);

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

  /** 開新對話：舊會話留在歷史裡可切回；成功後收 dropdown 並讓歷史目錄重拉。 */
  const onStartNewSession = useCallback(async (): Promise<void> => {
    if (startingNew) return;
    setStartingNew(true);
    try {
      const ok = await startNewSession();
      if (ok) {
        setShowHistory(false);
        setHistorySnapshot(null);
        setHistoryList(null); // 置 null = 未載入，下次打開 dropdown 重新拉目錄（新會話入列）
      }
    } finally {
      setStartingNew(false);
    }
  }, [startingNew, startNewSession]);

  // quota 字段保留在 hook state 里但不再展示——余额端点缺失是已知稳态，
  // 展示「余额未知」只浪费布局空间，扣费仍正常记账。
  const isActive = connection !== "idle" && connection !== "closed";
  const isInline = variant === "inline";

  const onSaveToLibrary = useCallback(async (item: AgentImageItem): Promise<void> => {
    // 客户端幂等：连点两下不该在图库里躺两条一样的记录。
    if (savedIds.has(item.id)) return;
    try {
      const body = {
        id: crypto.randomUUID(),
        prompt: `AI 助理生成 · 第 ${item.seq} 张`,
        generatedAt: Date.now(),
        results: [{ provider: "agent", modelId: "agent", imageUrl: item.url, image: null }],
        source: "server",
      };
      const res = await fetch("/api/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSavedIds((prev) => new Set([...prev, item.id]));
      }
    } catch {
      // 静默失败：图还在，用户仍可下载。不弹错打断对话流。
    }
  }, [savedIds]);

  // D-9：往聊天注入一句话的捷径，不是离开聊天的逃生门。
  // image_generate 是异步的，tool.result 里只有 task_id 没有 URL；
  // 把实际 URL 附在消息里，agent 收到后可直接传给 image_edit / image_upscale，
  // 无需再用 bash 或 image_get_result 查询一次。
  const onEdit = useCallback((item: AgentImageItem): void => {
    void send(`在第 ${item.seq} 张图的基础上继续改图（image_url: ${item.url}）`);
  }, [send]);

  const onUpscale = useCallback((item: AgentImageItem): void => {
    void send(`把第 ${item.seq} 张图放大（image_url: ${item.url}）`);
  }, [send]);

  const onDownload = useCallback(async (item: AgentImageItem): Promise<void> => {
    await triggerDownload(item.url, `agent-${Date.now()}.png`);
  }, []);

  // D-12：盯住最新一条工具调用，把助理实际用的参数回流给工作台控件。
  // 用 ref 记住处理过的条目 id——重渲染不该把同一次调用回流两次，
  // 那会把使用者刚手动改回去的值又冲掉。
  const reflectedRef = useRef<string | null>(null);

  // 監聽 sessionId 變化，通知父組件（用於同步清空畫布）
  useEffect(() => {
    if (onSessionChange) {
      onSessionChange(sessionId);
    }
  }, [sessionId, onSessionChange]);

  useEffect(() => {
    if (!onParamsReflected) return;
    // 从后往前找最新一条带参数的工具条目
    for (let i = state.items.length - 1; i >= 0; i -= 1) {
      const item = state.items[i];
      if (item.kind !== "tool") continue;
      if (item.argsSummary === undefined) continue;
      if (reflectedRef.current === item.id) return; // 这条已经回流过
      reflectedRef.current = item.id;
      const params = reflectParams(item.argsSummary, currentModelId ?? "");
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

  // 稳定的引用：输入区把它放在 effect 依赖里，每次渲染换新函数会白跑一轮。
  const clearPrefill = useCallback((): void => setPrefill(null), []);

  /*
   * D-17：hook 在有存档时故意不自动建号（use-agent-chat.ts 里 start() 会被存档挡住）。
   * 这里替用户做掉那个决定——开新的。
   *
   * ref 守门是必须的：resumable 会在 discardAndStartNew() 里被清成 null，
   * effect 因此至少跑两次；没有守门，任何让 resumable 再次非空的路径都会
   * 重开一个会话。每次 mount 只自动开一次。
   */
  useEffect(() => {
    if (!resumable || didAutoDiscardRef.current) return;
    didAutoDiscardRef.current = true;
    // 2026-08-21：网关会话已持久化（bun:sqlite + lazy reload），刷新/重开
    // 不再等于会话消亡。D-17 的「进来先删旧开新」把可恢复的上下文直接
    // 丢掉了。现在改为静默续上：transcript 原样回来（含 workflow/canvas
    // 事件流）。会话真被回收时 resume() 自己会清档开新并提示。
    setHistorySnapshot({ itemCount: resumable.itemCount, savedAt: resumable.savedAt });
    void resume();
  }, [resumable, resume]);

  /**
   * 2026-08-25 模板注入：會話連上後自動發出。必須等 connection === "open"：
   * autoStart/resume 建號是非同步的，沒連上就 send 等於把用戶的發送動作丟了。
   * ref 記 nonce：只在拿到新的注入時發一次，connection 抖動不重發。
   */
  const injectedNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!agentInjection || injectedNonceRef.current === agentInjection.nonce) return;
    if (connection !== "open") return;
    injectedNonceRef.current = agentInjection.nonce;
    onUserMessage?.();
    // directive（若有）随首条消息隐形上送：网关拼进 system，用户全程看不见。
    // silent：注入的模板 prompt 同样不进 transcript——用户只看到 agent 的引导。
    void send(agentInjection.text, {
      ...(agentInjection.directive ? { sessionDirective: agentInjection.directive } : {}),
      silent: true,
    });
  }, [agentInjection, connection, send, onUserMessage]);

  /**
   * D-26 首张锚定。第一张图 + 产出它的那次工具调用参数都在 transcript 里，
   * 推不出可复现参数时 deriveBatchAnchor 回 null，卡片自然不出现。
   */
  const derivedAnchor = useMemo(() => deriveBatchAnchor(state.items), [state.items]);
  const anchor = derivedAnchor && derivedAnchor.imageId !== anchorAskedFor ? derivedAnchor : null;

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

  const imageActions: AgentTranscriptProps["imageActions"] = {
    onSaveToLibrary,
    onEdit,
    onUpscale,
    onDownload,
  };

  return (
    <div
      className={isInline ? cn("flex min-h-0 flex-1 flex-col overflow-hidden pb-1") : "page-shell flex flex-col pb-4 pt-3"}
      style={isInline ? undefined : { minHeight: "calc(100dvh - 5rem)", height: "calc(100dvh - 5rem)" }}
    >
      {/*
        面板 Header（2026-08-21 移动端抽屉规范重排）：
        拖拽手柄 + 「AI 助理」标题 + 呼吸绿点（连接态，替代消息流里的状态文字行）
        + 右侧图标组（历史记录 / 开新对话 / 收起）。散落的「对话历史」文字链接
        与常驻「已连接」状态行全部收编到这里——对话流里只剩对话。
        embedded（工作站面板態）：外層面板已有把手，這裡的把手省掉——單層。
      */}
      <header className={cn("flex shrink-0 flex-col", embedded ? "mb-1" : "pb-2")}>
        {/* 2026-08-22：拖拽把手已移除——黑色長條佔位搶文字空間，用戶裁定拿掉。 */}
        <div className="flex items-center gap-1.5">
          <span className="lg-tint-blue flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ios-blue">
            <Bot className="h-4 w-4" aria-hidden="true" />
          </span>
          <h2 className="text-[15px] font-semibold text-foreground">AI 助理</h2>
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              connection === "open" ? "bg-emerald-500 animate-pulse" : "bg-slate-300",
            )}
            title={connection === "open" ? "已连接" : "未连接"}
            aria-label={connection === "open" ? "已连接" : "未连接"}
          />
          <div className="ml-auto flex items-center gap-0.5">
            <div ref={historyRef} className="relative">
              <button
                type="button"
                onClick={() => void toggleHistory()}
                aria-expanded={showHistory}
                aria-label="历史记录"
                title="对话历史"
                className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-foreground/45 transition-colors hover:bg-black/5 hover:text-foreground/75 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 touch-manipulation"
              >
                <History className="h-4 w-4" aria-hidden="true" />
                {historyList !== null && historyList.length > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-ios-blue px-1 text-[10px] font-semibold leading-none tabular-nums text-white">
                    {historyList.length}
                  </span>
                )}
              </button>
        {showHistory && (
          <div className="lg-sheet absolute top-full right-0 z-50 mt-0.5 w-56 rounded-ios-2xl p-1">
            {historyList === null ? (
              <p className="px-2.5 py-3 text-center text-ios-caption1 text-foreground/45">
                正在加载历史会话…
              </p>
            ) : historyList.length === 0 ? (
              /* 2026-08-22 完美主義審視：空狀態不只是宣告「沒有」——左對齊 +
                 引導文案 + 一顆 inline 開新對話，讓第一次打開 dropdown 的人
                 知道下一步做什麼。 */
              <div className="flex flex-col items-start gap-1.5 px-2.5 py-3">
                <MessageSquarePlus className="h-4 w-4 text-foreground/45" aria-hidden="true" />
                <p className="text-left text-ios-caption1 leading-relaxed text-foreground/45">
                  还没有历史对话
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setShowHistory(false);
                    void onStartNewSession();
                  }}
                  disabled={startingNew}
                  className="cursor-pointer text-left text-ios-caption1 font-medium text-ios-blue transition-colors hover:text-ios-blue/80 disabled:cursor-wait"
                >
                  {startingNew ? "正在开启…" : "开始新对话 →"}
                </button>
              </div>
            ) : (
              <div className="max-h-64 overflow-y-auto overscroll-contain">
                {historyList.map((it) => {
                  const active = it.session_id === sessionId;
                  return (
                    <button
                      key={it.session_id}
                      type="button"
                      disabled={switchingTo !== null}
                      onClick={() => void onPickSession(it.session_id)}
                      className={cn(
                        "flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left leading-normal transition-colors",
                        active
                          ? "bg-ios-blue/10"
                          : "hover:bg-black/5",
                        switchingTo === it.session_id && "opacity-50",
                      )}
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="block truncate text-ios-caption1 font-medium text-muted-foreground">
                          {formatSessionLabel(it)}
                        </span>
                        <span className="block truncate text-ios-caption2 text-foreground/45">
                          最后活动 {formatSavedAt(it.last_activity_at)}
                        </span>
                      </span>
                      {active ? (
                        <span className="shrink-0 text-ios-caption2 font-medium text-ios-blue">当前</span>
                      ) : switchingTo === it.session_id ? (
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-foreground/45" aria-hidden="true" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
            </div>
            <button
              type="button"
              onClick={() => void onStartNewSession()}
              disabled={startingNew}
              aria-label="开新对话"
              title="开新对话（当前对话保留在历史里）"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-foreground/45 transition-colors hover:bg-black/5 hover:text-foreground/75 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 touch-manipulation disabled:cursor-wait"
            >
              {startingNew ? (
                <Loader2 className="h-4 w-4 animate-spin text-ios-blue" aria-hidden="true" />
              ) : (
                <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
            {headerExtra}
            {onExit && (
              <button
                type="button"
                onClick={onExit}
                aria-label="收起"
                title="收起助理，返回生成模式"
                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-foreground/45 transition-colors hover:bg-black/5 hover:text-foreground/75 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 touch-manipulation"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
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
          <button
            type="button"
            onClick={() => void retry()}
            className="agent-surface-retry shrink-0 cursor-pointer rounded-full bg-destructive/[0.14] px-3 py-1 text-ios-caption1 font-semibold text-destructive lg-transition hover:bg-destructive/[0.22]"
          >
            重试
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <AgentChatPanel
          state={state}
          connection={connection}
          sessionId={sessionId}
          onSend={(text) => void send(text)}
          onConfirm={(requestId, approved) => void confirm(requestId, approved)}
          onAnswerQuestion={(requestId, answers) => void answerQuestion(requestId, answers)}
          onRetryConnection={() => void retry()}
          imageActions={imageActions}
          anchor={anchor}
          onAnchor={() => void onAnchor()}
          onReanchor={() => void onReanchor()}
          onAnchorDismiss={onAnchorDismiss}
          anchorBusy={anchorBusy}
          /* D-26：只在助手还在产出时给「停止」——回合已结束时没有东西可停，
             摆一颗停不了任何东西的按钮是假承诺。 */
          onStopGeneration={state.turnActive ? onStopGeneration : undefined}
          prefill={prefill}
          onPrefillConsumed={clearPrefill}
          onFirstUserMessage={onUserMessage}
        />
      </div>
    </div>
  );
}
