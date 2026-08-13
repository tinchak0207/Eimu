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
import { Bot, History } from "lucide-react";
import {
  hasReflectedParams,
  reflectParams,
  type ReflectedParams,
} from "@/lib/agent-param-reflect";
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
  /**
   * 入口按下那一刻输入框里已经打好的半句话（D-24「承接使用者已打的半句话」）。
   * 不自动送出：半句话直接送出去可能立刻触发扣费，与 D-5「花钱前必定交用户确认」
   * 冲突。这里呈现成一颗可点的续写药丸，点一下才进对话。
   */
  initialPrompt?: string;
  /** inline 变体的退出去向（回工作台）。page 变体不用。 */
  onExit?: () => void;
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
}

export function AgentChatSurface({
  variant = "page",
  initialPrompt = "",
  onParamsReflected,
  currentModelId,
  onImageResult,
  onCanvasEvent,
  canvasStateProvider,
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
    discardAndStartNew,
  } = useAgentChat({
    autoStart: true,
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
  const didAutoDiscardRef = useRef(false);

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
    setHistorySnapshot({ itemCount: resumable.itemCount, savedAt: resumable.savedAt });
    void discardAndStartNew();
  }, [resumable, discardAndStartNew]);

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
   * D-26「随时可停」。网关没有中断端点（只有 DELETE session = 整个会话收摊），
   * 所以这里能做的是**明确要求 agent 停手**，并把这句话摆进 transcript 让人看见。
   *
   * 刻意不叫「立即停止」：正在跑的那一张仍会跑完（钱已经花出去了），
   * 停的是后面还没开始的。按钮文案与提示都照这个语义写，不给假承诺。
   * 真正的即时中断要网关加 abort 端点，那是后端的事，不在这里假装。
   */
  const onStopGeneration = useCallback((): void => {
    void send("停下，不要再生成新的图了。当前这张跑完就停，剩下的先别开始。");
  }, [send]);

  const imageActions: AgentTranscriptProps["imageActions"] = {
    onSaveToLibrary,
    onEdit,
    onUpscale,
    onDownload,
  };

  return (
    <div
      className={isInline ? "flex min-h-0 flex-1 flex-col" : "page-shell flex flex-col pb-4 pt-3"}
      style={isInline ? undefined : { minHeight: "calc(100dvh - 5rem)", height: "calc(100dvh - 5rem)" }}
    >
      {/*
        D-17：上次对话的存档收进一颗默认折起来的按钮里。
        默认状态是「什么都没发生，你可以直接打字」——想知道上次那段去哪了的人
        才需要点开，不点开的人一眼都不用花。
      */}
      {historySnapshot && (
        <div className="mb-2 flex shrink-0 flex-col items-start gap-1.5">
          <button
            type="button"
            onClick={() => setShowHistory((prev) => !prev)}
            aria-expanded={showHistory}
            className="flex cursor-pointer items-center gap-1 text-[11px] font-medium text-[rgba(0,0,0,0.35)] transition-colors duration-200 hover:text-[rgba(0,0,0,0.55)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,0,0,0.20)]"
          >
            <History className="h-3 w-3" aria-hidden="true" />
            对话历史
          </button>
          {showHistory && (
            <div className="rounded-ios-xl bg-[rgba(0,0,0,0.04)] px-3 py-2">
              <p className="text-ios-caption1 text-[rgba(0,0,0,0.52)]">
                上次 {historySnapshot.itemCount} 条消息 · {formatSavedAt(historySnapshot.savedAt)}
              </p>
              {/* 会话本体已经关掉，这里只是告知，不给一颗按下去必然失败的「继续」。 */}
              <p className="mt-0.5 text-ios-caption1 text-[rgba(0,0,0,0.35)]">
                已经为你开了新的对话
              </p>
            </div>
          )}
        </div>
      )}

      {/* D-24：承接使用者已打的半句话，点一下搬进输入框接着写（不自动送出，
          半句话直接送可能立刻扣费）；右侧「放弃」直接丢掉。 */}
      {draft && (
        <div className="mb-2.5 flex shrink-0 items-center gap-2 rounded-ios-2xl bg-[rgba(0,122,255,0.07)] px-3 py-2 ring-1 ring-[rgba(0,122,255,0.16)]">
          <Bot className="h-3.5 w-3.5 shrink-0 text-[#007AFF]" aria-hidden="true" />
          <button
            type="button"
            onClick={continueDraft}
            className="min-w-0 flex-1 cursor-pointer truncate text-left text-ios-footnote text-[rgba(0,0,0,0.72)] lg-transition hover:text-[#007AFF]"
            title="填进输入框接着写"
          >
            接着写：<span className="font-medium">{draft}</span>
          </button>
          <button
            type="button"
            onClick={() => setDraft("")}
            className="shrink-0 cursor-pointer rounded-full px-2 py-0.5 text-ios-caption1 font-medium text-[rgba(0,0,0,0.40)] lg-transition hover:bg-[rgba(0,0,0,0.06)] hover:text-[rgba(0,0,0,0.66)]"
            aria-label="不要这句话"
          >
            放弃
          </button>
        </div>
      )}

      {error && !isActive && (
        <div className="mb-2.5 flex shrink-0 items-center justify-between gap-3 rounded-ios-2xl bg-[rgba(255,59,48,0.08)] px-3.5 py-2.5">
          <p className="min-w-0 flex-1 text-ios-footnote text-[rgba(160,30,25,0.90)]">{error}</p>
          <button
            type="button"
            onClick={() => void retry()}
            className="shrink-0 cursor-pointer rounded-full bg-[rgba(255,59,48,0.14)] px-3 py-1 text-ios-caption1 font-semibold text-[#FF3B30] lg-transition hover:bg-[rgba(255,59,48,0.22)]"
          >
            重试
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
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
        />
      </div>
    </div>
  );
}
