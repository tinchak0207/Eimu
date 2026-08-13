"use client";

import { memo, useEffect, useRef } from "react";
import { Loader2, RotateCcw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentAssistantTextItem, AgentChatState } from "@/lib/agent-chat-types";
import type { BatchAnchor } from "@/lib/agent-batch-anchor";
import { AgentTranscript, type AgentTranscriptProps } from "./AgentTranscript";
import { AgentComposer, type AgentComposerProps } from "./AgentComposer";
import { AgentConfirmCard } from "./AgentConfirmCard";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { AgentBatchProgress } from "./AgentBatchProgress";
import { AgentAnchorCard } from "./AgentAnchorCard";
import "./agent-chat.css";

export interface AgentChatPanelProps {
  state: AgentChatState;
  connection: "idle" | "connecting" | "open" | "reconnecting" | "closed";
  disabled?: boolean;
  onSend: (text: string) => void;
  onConfirm: (requestId: string, approved: boolean) => void;
  onAnswerQuestion: (requestId: string, answers: string[][]) => void;
  onRetryConnection: () => void;
  /** 当前会话 id，传给输入区做附件上传。未传时附件按钮禁用。 */
  sessionId?: string | null;
  /** 出图卡动作回调：接线前省略，按钮保持 disabled。 */
  imageActions?: AgentTranscriptProps["imageActions"];
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
}

const CONNECTION_META: Record<AgentChatPanelProps["connection"], { label: string; dotClass: string }> = {
  idle: { label: "未连接", dotClass: "bg-[rgba(0,0,0,0.25)]" },
  connecting: { label: "连接中…", dotClass: "bg-[#FF9500]" },
  open: { label: "已连接", dotClass: "bg-[#34C759]" },
  reconnecting: { label: "正在重新连接…", dotClass: "bg-[#FF9500]" },
  closed: { label: "会话已结束", dotClass: "bg-[#FF3B30]" },
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
  imageActions,
  onStopGeneration,
  anchor,
  onAnchor,
  onReanchor,
  onAnchorDismiss,
  anchorBusy = false,
  prefill,
  onPrefillConsumed,
  awaitingChoice = false,
}: AgentChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { items, pendingConfirms, pendingQuestions, closed, closedReason, turnActive, lastEventId } = state;

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
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, lastEventId, turnActive]);

  // 等用户二选一时，「未连接」的红灯是误报：没连是因为在等他决定。
  const meta = awaitingChoice
    ? { label: "等你选择上面的对话", dotClass: "bg-[#007AFF]" }
    : CONNECTION_META[connection];
  const composerDisabled = disabled || closed;

  return (
    <section className="agent-panel" aria-label="智能体对话">
      {/* 连接状态：一行不占体积，重连时提供手动重试，不遮挡正文。 */}
      <div className="flex items-center gap-2 px-1 pb-2 pt-1">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dotClass)} aria-hidden="true" />
        <span className="text-[11px] font-medium text-[rgba(0,0,0,0.35)]">{meta.label}</span>
        {connection === "reconnecting" && (
          <button
            type="button"
            onClick={onRetryConnection}
            className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-[rgba(0,122,255,0.10)] px-3 py-1 text-ios-caption1 font-semibold text-[#007AFF] transition-colors hover:bg-[rgba(0,122,255,0.18)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            重试
          </button>
        )}
        {connection === "connecting" && (
          <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-[rgba(0,0,0,0.35)]" aria-hidden="true" />
        )}
        {closed && closedReason && (
          <span className="ml-auto truncate text-[11px] text-[rgba(0,0,0,0.35)]">
            原因：{closedReason}
          </span>
        )}
      </div>

      {/* D-26：批量愿望的燃烧进度常驻在顶部，不用点开才知道烧到哪。 */}
      <div className="px-0.5 pb-1.5">
        <AgentBatchProgress items={items} onStop={onStopGeneration} />
      </div>

      {/* 转录区：aria-live 的 polite live region；空态给开场提示，不显示一片空白。 */}
      <div
        ref={scrollRef}
        aria-live="polite"
        className="agent-transcript min-h-0 flex-1 overflow-y-auto overscroll-contain px-0.5 py-1"
      >
        {items.length === 0 && connection === "open" ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[rgba(0,122,255,0.10)] text-[#007AFF]">
              <Sparkles className="h-5 w-5" aria-hidden="true" />
            </span>
            <p className="text-ios-subhead font-medium text-[rgba(0,0,0,0.72)]">
              和智能体聊聊，让它帮你生成图片
            </p>
            <p className="max-w-[30rem] text-ios-footnote leading-[1.5] text-[rgba(0,0,0,0.45)]">
              例如：画一只戴帽子的橘猫，水彩风格
            </p>
          </div>
        ) : (
          <AgentTranscript items={items} imageActions={imageActions} />
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
          <div className="flex items-center gap-2 px-1 py-2" role="status" aria-label="助手正在思考">
            <span className="flex items-end gap-[3px]" aria-hidden="true">
              {[0, 160, 320].map((delay) => (
                <span
                  key={delay}
                  className="inline-block animate-bounce rounded-full bg-[rgba(0,0,0,0.22)]"
                  style={{ width: 6, height: 6, animationDelay: `${delay}ms`, animationDuration: "1.1s" }}
                />
              ))}
            </span>
            <span className="text-[11px] text-[rgba(0,0,0,0.35)]">正在思考…</span>
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
        <div className="px-0.5 pb-2">
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
          缺省时确认卡退回纯花费确认。 */}
      {pendingConfirms.length > 0 && (
        <div className="flex flex-col gap-2 px-0.5 pb-2">
          {pendingConfirms.map((confirm) => (
            <AgentConfirmCard
              key={confirm.requestId}
              confirm={confirm}
              onConfirm={onConfirm}
              contextText={lastAssistantText}
            />
          ))}
        </div>
      )}

      {pendingConfirms.length === 0 && pendingQuestions.length > 0 && (
        <div className="flex flex-col gap-2 px-0.5 pb-2">
          {pendingQuestions.map((question) => (
            <AgentQuestionCard
              key={question.requestId}
              question={question}
              onAnswer={onAnswerQuestion}
            />
          ))}
        </div>
      )}

      <AgentComposer
        disabled={composerDisabled}
        onSend={onSend}
        sessionId={sessionId}
        prefill={prefill}
        onPrefillConsumed={onPrefillConsumed}
      />
    </section>
  );
}

export const AgentChatPanel = memo(AgentChatPanelComponent);
