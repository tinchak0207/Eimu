"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import { RotateCcw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentAssistantTextItem, AgentChatState } from "@/lib/agent-chat-types";
import type { BatchAnchor } from "@/lib/agent-batch-anchor";
import { describeGroup, groupPendingConfirms } from "@/lib/agent-confirm-groups";
import { AgentTranscript, type AgentTranscriptProps } from "./AgentTranscript";
import { AgentComposer, type AgentComposerProps } from "./AgentComposer";
import { AgentConfirmCard } from "./AgentConfirmCard";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { AgentBatchProgress } from "./AgentBatchProgress";
import { AgentSubagentBar } from "./AgentSubagentBar";
import { AgentAnchorCard } from "./AgentAnchorCard";
import "./agent-chat.css";

export interface AgentChatPanelProps {
  state: AgentChatState;
  connection: "idle" | "connecting" | "open" | "reconnecting" | "closed";
  disabled?: boolean;
  onSend: (text: string) => void;
  onConfirm: (requestId: string, approved: boolean) => Promise<boolean | void>;
  onAnswerQuestion: (requestId: string, answers: string[][]) => Promise<boolean | void>;
  onRetryConnection: () => void;
  /** 当前会话 id，传给输入区做附件上传；空态未建号时由 onEnsureSession lazy 建号。 */
  sessionId?: string | null;
  /** 空态选档时透传给输入区的 lazy 建号入口（附件＝用户明确动作）。 */
  onEnsureSession?: AgentComposerProps["onEnsureSession"];
  /** 出图卡动作回调：接线前省略，按钮保持 disabled。 */
  imageActions?: AgentTranscriptProps["imageActions"];
  /** 出片卡动作回调：接线前省略，按钮保持 disabled。 */
  videoActions?: AgentTranscriptProps["videoActions"];
  /** 出音频卡动作回调：接线前省略，按钮保持 disabled。 */
  audioActions?: AgentTranscriptProps["audioActions"];
  /** 批量生成的中止信号。存在时批量进度卡带上「停止」按钮。 */
  onStopGeneration?: () => void;
  /**
   * D-26 首张锚定。缺席（或推不出可复现参数）时不显示锚定卡——
   * 一颗按下去不保证同风格的「锚定」按钮比没有按钮更糟。
   */
  anchor?: BatchAnchor | null;
  onAnchor?: () => void;
  onReanchor?: () => void;
  onAnchorDismiss?: () => void;
  anchorBusy?: boolean;
  /** D-24 无缝续写：透传给输入区，把半句话填进框里而不是直接送出。 */
  prefill?: AgentComposerProps["prefill"];
  onPrefillConsumed?: () => void;
  /**
   * D-17：外面正在问「继续上次还是开新的」，此时还没有会话。
   * 这不是连接故障，状态行要说在等你选，而不是亮一颗「未连接」的灯。
   */
  awaitingChoice?: boolean;
  /**
   * 2026-08-25 模板庫：用户发出第一条消息时通知上層（收起右側模板庫）。
   * 只在从空对话发出时触发——后续消息不再打扰。
   */
  onFirstUserMessage?: () => void;
}

/**
 * 合併確認組的裁決聚合：逐個 id 平行送出，Promise.allSettled 收攏結果——
 * 任一子項 reject 或明確回 false 都算整組失敗（回 false），讓卡片解鎖可
 * 整組重試；全部成功（fulfilled 且非 false）才回 true。抽成純函數，
 * node --test 可直接灌 deferred promise 斷言，不必模擬 DOM 點擊。
 */
export async function resolveConfirmGroup(
  requestIds: string[],
  approved: boolean,
  onConfirm: (requestId: string, approved: boolean) => Promise<boolean | void>,
): Promise<boolean> {
  const results = await Promise.allSettled(requestIds.map((id) => onConfirm(id, approved)));
  return results.every((r) => r.status === "fulfilled" && r.value !== false);
}

const CONNECTION_META: Record<AgentChatPanelProps["connection"], { label: string; dotClass: string }> = {
  idle: { label: "未连接", dotClass: "bg-black/25" },
  connecting: { label: "连接中…", dotClass: "bg-ios-orange" },
  open: { label: "已连接", dotClass: "bg-ios-green" },
  reconnecting: { label: "正在重新连接…", dotClass: "bg-ios-orange" },
  closed: { label: "会话已结束", dotClass: "bg-destructive" },
};

function AgentChatPanelComponent({
  state,
  connection,
  disabled = false,
  onSend,
  onConfirm,
  onAnswerQuestion,
  onRetryConnection,
  sessionId,
  onEnsureSession,
  imageActions,
  videoActions,
  audioActions,
  onStopGeneration,
  anchor,
  onAnchor,
  onReanchor,
  onAnchorDismiss,
  anchorBusy = false,
  prefill,
  onPrefillConsumed,
  awaitingChoice = false,
  onFirstUserMessage,
}: AgentChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // 输入区锚点：虚拟键盘弹起后，拿它判断「输入区是不是被键盘盖住了」。
  const composerAnchorRef = useRef<HTMLDivElement>(null);

  /** 空态快捷示例：点一下就发送（ChatGPT 同款模式），当回合结束后输入区自动沉到底部。 */
  const EXAMPLES = [
    "画一只戴帽子的橘猫，水彩风格",
    "让这瓶香水出现在落日海滩，自然光",
    "生成秦始皇骑北极熊的大电影",
  ];
  // 用户是否停在列表底部附近。串流/新条目只在「本来就在底部」时自动贴底，
  // 往上翻历史时不许把滚动条强拉回底部（「往上翻不強拉」）。
  const isNearBottomRef = useRef(true);
  const { items, pendingConfirms, pendingQuestions, closed, closedReason, turnActive, lastEventId, turnStatus } = state;

  // 罪状 4：子代理条目不进消息流，聚到转录区上方的状态栏（组件内部裁到至多 3 张）。
  const subagentItems = useMemo(() => {
    const out: Extract<AgentChatState["items"][number], { kind: "subagent" }>[] = [];
    for (const it of items) {
      if (it.kind === "subagent") out.push(it);
    }
    return out;
  }, [items]);

  // D-25：解读上下文 = 该轮已收到的 message.delta 文本（最新一条 assistant 条目的累计文本）。
  // 只取 transcript 里已有的东西，不造契约没有的字段；没有助手文本时确认卡退回纯花费确认。
  const lastAssistantText = (() => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (it.kind === "assistant") return (it as AgentAssistantTextItem).text;
    }
    return undefined;
  })();

  // 新条目 / 串流进行时滚到底部，让最新内容可见。
  // 只在用户本来就停在底部附近时贴底：往上翻历史时新内容到达也不拽人下去。
  useEffect(() => {
    const el = scrollRef.current;
    if (el && isNearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [items.length, lastEventId, turnActive]);

  // 罪状 5：同批同模型的确认卡合并成一张「model ×N 共 N 币」；
  // 不同模型（或金额不同）各自成组逐张出。裁决时逐笔 resolve。
  const confirmGroups = useMemo(() => groupPendingConfirms(pendingConfirms), [pendingConfirms]);

  // 滚动时实时记录「在不在底部附近」。128px 阈值 = 翻看最后几条时也算「在底部」，
  // 新内容会温柔地贴上来；翻到历史深处就不再自动滚。
  const handleTranscriptScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 128;
  };

  // 虚拟键盘 / 捏合缩放：视觉视口被吃掉后，底部输入区可能被键盘盖住。
  // visualViewport 的 resize/scroll 是唯一可靠的信号——部分浏览器（键盘 overlay
  // 模式、iOS 某些路径）下 window.innerHeight 不会跟着变，layout viewport 也不缩。
  // 只在「视口真的被吃掉 ≥80px」且「输入区底部掉出可视区」时把输入区滚回可见；
  // 键盘收起、纯地址栏伸缩不触发，避免和用户翻历史打架。
  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const adjust = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const anchor = composerAnchorRef.current;
        if (!anchor) return;
        if (vv.height < window.innerHeight - 80) {
          const rect = anchor.getBoundingClientRect();
          const visibleBottom = vv.offsetTop + vv.height;
          if (rect.bottom > visibleBottom - 12) {
            anchor.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
          }
        }
      });
    };
    vv.addEventListener("resize", adjust);
    vv.addEventListener("scroll", adjust);
    return () => {
      vv.removeEventListener("resize", adjust);
      vv.removeEventListener("scroll", adjust);
      cancelAnimationFrame(raf);
    };
  }, []);

  // 等用户二选一时，「未连接」的红灯是误报：没连是因为在等他决定。
  const meta = awaitingChoice
    ? { label: "等你选择上面的对话", dotClass: "bg-ios-blue" }
    : CONNECTION_META[connection];
  const composerDisabled = disabled || closed || pendingQuestions.length > 0 || pendingConfirms.length > 0;

  // 等待卡片選擇期間的 placeholder 提示（R9-3 死線 4）。
  const composerPlaceholder = pendingQuestions.length > 0 || pendingConfirms.length > 0
    ? "等待卡片选择…"
    : undefined;

  return (
    <section className="agent-panel" aria-label="智能体对话">
      {/* 状态行（2026-08-21 收缩）：常驻「已连接/连接中」由 Surface Header 的
          呼吸绿点承担，这里只在需要人做决定/知晓时出现——等待二选一、
          断线可重试、会话关闭带原因。 */}
      {(awaitingChoice || connection === "reconnecting" || (closed && closedReason)) && (
        <div className="agent-panel-status flex items-center gap-2 px-0.5 pb-2 pt-1">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dotClass)} aria-hidden="true" />
          <span className="text-ios-caption1 font-medium text-foreground/45">{meta.label}</span>
          {connection === "reconnecting" && (
            <button
              type="button"
              onClick={onRetryConnection}
              className="agent-retry ml-auto inline-flex items-center gap-1.5 rounded-full bg-ios-blue/10 px-3 py-1 text-ios-caption1 font-semibold text-ios-blue transition-colors hover:bg-ios-blue/[0.18] focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              重试
            </button>
          )}
          {closed && closedReason && !awaitingChoice && (
            <span className="ml-auto truncate text-ios-caption1 text-foreground/45">
              原因：{closedReason}
            </span>
          )}
        </div>
      )}

      {/* D-26：批量愿望的燃烧进度常驻在顶部，不用点开才知道烧到哪。 */}
      <div className="pb-1">
        <AgentBatchProgress items={items} onStop={onStopGeneration} />
      </div>

      {/* 罪状 4：子代理状态栏，置顶于转录区之上、从上到下堆叠（至多 3 张）。 */}
      <div className="pb-1">
        <AgentSubagentBar items={subagentItems} />
      </div>

      {/* 转录区：aria-live 的 polite live region；空态给开场提示，不显示一片空白。 */}
      <div
        ref={scrollRef}
        aria-live="polite"
        onScroll={handleTranscriptScroll}
        className="agent-transcript min-h-0 flex-1 overflow-y-auto overscroll-contain px-0.5 pb-2 pt-0"
      >
        {/* 第二輪就緒優化刀A：空態（歡迎語）不再等 SSE open —— idle/connecting/open
            都顯示（「沒內容且沒壞」）。建號+ticket+SSE 握手在背後接，error 態仍由
            connection meta 條目單獨呈現，此處只排除 reconnecting/closed。 */}
        {items.length === 0 && connection !== "reconnecting" && connection !== "closed" ? (
          <div className="agent-empty flex h-full min-h-40 flex-col items-center justify-center gap-4 px-6 text-center">
            <span className="lg-tint-blue flex h-12 w-12 items-center justify-center rounded-full text-ios-blue">
              <Sparkles className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <p className="text-ios-subhead font-semibold text-foreground">
                和智能体聊聊，让它帮你生成图片
              </p>
              <p className="agent-empty-hint mx-auto mt-1.5 max-w-[30rem] text-sm leading-[1.5] text-foreground/45 sm:text-ios-footnote">
                说一句话，它自动选好模型、风格和比例
              </p>
            </div>
            <div className="flex max-w-[28rem] flex-wrap items-center justify-center gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => onSend(ex)}
                  className="lg-float cursor-pointer rounded-full px-3.5 py-2 text-ios-footnote font-medium text-muted-foreground transition-all duration-200 hover:-translate-y-0.5 hover:text-ios-blue hover:shadow-[0_6px_18px_rgba(0,0,0,0.10)] active:translate-y-0 active:scale-[0.97]"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <AgentTranscript items={items} imageActions={imageActions} videoActions={videoActions} audioActions={audioActions} sessionId={sessionId} turnStatus={turnStatus} />
        )}

        {/*
          思考中间态。送出到第一个字之间是一段真空——网关要先跑一轮推理才吐
          message.delta，这段时间画面上什么都不动，人会以为自己没送出去。

          条件是「这轮还开着，但最后一条不是助手文本」：
          - 最后一条是使用者消息 → 还没开始回，真空期，要显示。
          - 最后一条是工具调用 → agent 在跑工具（出图），还没接着讲话，也要显示。
          - 最后一条是助手文本 → 字已经在流出来了，光标本身就是回馈，不必再叠一个。
          回合一结束 turnActive 落下，泡泡跟着消失，不用另外清理。
        */}
        {turnActive && items[items.length - 1]?.kind !== "assistant" && (
          <div className="agent-thinking flex items-center gap-2 px-1 py-2" role="status" aria-label="助手正在思考">
            <span className="flex items-end gap-[3px]" aria-hidden="true">
              {[0, 160, 320].map((delay) => (
                <span
                  key={delay}
                  className="inline-block animate-bounce rounded-full bg-black/[0.22]"
                  style={{ width: 6, height: 6, animationDelay: `${delay}ms`, animationDuration: "1.1s" }}
                />
              ))}
            </span>
            <span className="text-ios-caption1 text-foreground/45">正在思考…</span>
          </div>
        )}
      </div>

      {/* 串流状态的无障碍宣告：画面本身已用光标呈现，这里补屏幕阅读器播报。 */}
      <span className="sr-only" role="status" aria-live="polite">
        {turnActive ? "助手正在输入…" : "助手回复完成"}
      </span>

      {/* D-26 首张锚定：紧贴输入区上方，和确认卡互斥。
          有待裁决的花费确认时不问锚定——同时摆两张要人做决定的卡，
          会让人分不清自己按下的是哪一个。花费确认优先，它才是要扣钱的那张。 */}
      {anchor && pendingConfirms.length === 0 && pendingQuestions.length === 0 && onAnchor && onReanchor && onAnchorDismiss && (
        <div className="pb-1.5">
          <AgentAnchorCard
            anchor={anchor}
            onAnchor={onAnchor}
            onReanchor={onReanchor}
            onDismiss={onAnchorDismiss}
            busy={anchorBusy}
          />
        </div>
      )}

      {/* 待确认卡片浮在输入区上方，任何时刻 0..n 张。
          D-25：解读 = 该轮已收到的 message.delta 文本（lastAssistantText），
          与 confirm 事件的 description 一起由确认卡拼装成「我这么理解你的愿望」；
          缺省时确认卡退回纯花费确认。
          2026-08-16：卡片区有界 + 内部滚动（最高 min(45dvh, 22rem)）——高卡片
          不会再被面板高度裁掉底部选项，也不会把 transcript 挤到零高度。
          罪状 5/6：同批同模型合并成一张卡（model ×N 共 N 币），一键裁决逐笔
          resolve；确认卡容器限高 + 内部滚动，禁止整页溢出。 */}
      {confirmGroups.length > 0 && (
        <div className="min-h-0 max-h-[min(45dvh,22rem)] shrink-0 overflow-y-auto overscroll-contain px-0.5 pb-1.5">
          <div className="flex flex-col gap-2">
            {confirmGroups.map((group) => {
              const merged = group.count > 1;
              return (
                <AgentConfirmCard
                  key={group.requestIds[0]}
                  confirm={{
                    requestId: group.requestIds[0],
                    amountCoins: group.amountCoins,
                    ...(merged
                      ? { description: describeGroup(group) }
                      : group.description !== undefined
                        ? { description: group.description }
                        : {}),
                    seq: 0,
                  }}
                  onConfirm={(_requestId, approved) =>
                    resolveConfirmGroup(group.requestIds, approved, onConfirm)
                  }
                  contextText={lastAssistantText}
                />
              );
            })}
          </div>
        </div>
      )}

      {pendingConfirms.length === 0 && pendingQuestions.length > 0 && (
        <div className="min-h-0 max-h-[min(45dvh,22rem)] shrink-0 overflow-y-auto overscroll-contain px-0.5 pb-1.5">
          {/* 問題卡串行：一次只出一張，答完（reducer 移除該 requestId）再浮出下一張，
              不讓多張疊在一起同時逼用戶做決定。 */}
          <div className="flex flex-col gap-2">
            {pendingQuestions.slice(0, 1).map((question) => (
              <AgentQuestionCard
                key={question.requestId}
                question={question}
                onAnswer={onAnswerQuestion}
              />
            ))}
          </div>
        </div>
      )}

      {/* 输入区锚点：键盘弹起时以此为基准判断可见性，滚回可视区。
          2026-08-22 完美主義審視曾讓輸入區在有待回答的問題/確認卡時「讓位消失」——
          R9-3 死線 4 推翻：輸入框直接消失 = 用戶失去操作空間（想補充/換句話都沒門），
          決策卡與輸入框的優先級靠 disabled + placeholder 表達，不靠讓位。
          卡片在等選擇 → 輸入框禁用並提示「等待卡片选择…」；答完卡自動恢復。 */}
      <div ref={composerAnchorRef} className="agent-composer-anchor">
        <AgentComposer
          disabled={composerDisabled}
          placeholder={composerPlaceholder}
          onSend={(text) => {
            // 第一条用户消息 = 右侧模板库退场的时刻（首条消息落地即收起）。
            if (items.length === 0) onFirstUserMessage?.();
            onSend(text);
          }}
          sessionId={sessionId}
          onEnsureSession={onEnsureSession}
          prefill={prefill}
          onPrefillConsumed={onPrefillConsumed}
          /* D-26 补全：生成中（turnActive）把中止信号送进输入区——
             输入框为空时送出钮位置变停止钮，不再只能乾等。 */
          onStop={turnActive ? onStopGeneration : undefined}
        />
      </div>
    </section>
  );
}

export const AgentChatPanel = memo(AgentChatPanelComponent);
