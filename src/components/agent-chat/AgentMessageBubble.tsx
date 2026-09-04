"use client";

import { memo, useEffect, useState, type MouseEvent } from "react";
import { Brain, Check, ChevronDown, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentAssistantTextItem, AgentUserTurnItem } from "@/lib/agent-chat-types";
import { parseUserAttachmentBlock, AgentAttachmentCards } from "./AgentAttachmentCards";
import { AgentMarkdown } from "./AgentMarkdown";

export interface AgentMessageBubbleProps {
  item: AgentUserTurnItem | AgentAssistantTextItem;
  /** 当前会话 id：附件卡铸读取票用。缺省时附件全部降级成文档式卡。 */
  sessionId?: string | null;
}

/** prefers-reduced-motion：串流游標閃爍與入場動畫都關掉，避免暈動。 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function AgentMessageBubbleComponent({ item, sessionId }: AgentMessageBubbleProps) {
  const isUser = item.kind === "user";
  const reducedMotion = usePrefersReducedMotion();

  // 罪状 1：用户消息里的 [ATTACHMENTS_BLOCK] 不再以裸文本示人——正文摘干净，
  // 附件解析成微信式卡片渲染在正文下方。没有区块时解析原样放行，一字不动。
  const userParsed = isUser ? parseUserAttachmentBlock(item.text) : null;
  const hasAttachments = userParsed !== null && userParsed.refs.length > 0;
  const displayText = hasAttachments ? userParsed.cleanText : item.text;

  // 思維鏈一鍵複製：summary 上的按鈕要 preventDefault，否則點擊會順帶收合 details。
  const [reasoningCopied, setReasoningCopied] = useState(false);
  const copyReasoning = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (item.kind !== "assistant" || !item.reasoning) return;
    try {
      await navigator.clipboard.writeText(item.reasoning);
      setReasoningCopied(true);
      setTimeout(() => setReasoningCopied(false), 1500);
    } catch {
      // clipboard 不可用（非安全上下文）時靜默失敗，用戶仍可手動選取複製。
    }
  };

  return (
    <div
      className={cn("agent-rise flex w-full", isUser ? "justify-end" : "justify-start")}
      style={reducedMotion ? { animation: "none" } : undefined}
    >
      <div
        className={cn(
          // min-w-0 + overflow-wrap:anywhere：長 URL／程式碼／JSON 在氣泡內換行，不橫向溢出。
          // 含思維鏈（reasoning）的 assistant 訊息占滿整行：思維鏈是過程性內容，
          // 窄氣泡會讓它「卡在一小塊」難受；純正文維持 85% 上限。
          // 助理正文走 Markdown 渲染，版式由塊級元素接管，不用 pre-wrap。
          "min-w-0 break-words [overflow-wrap:anywhere] text-[15px]",
          item.kind === "user" ? "whitespace-pre-wrap" : "",
          item.kind === "assistant" && item.reasoning ? "w-full" : "max-w-[85%]",
          isUser
            ? "ml-auto rounded-[20px] rounded-br-[6px] bg-ios-blue px-3.5 py-2.5 text-white leading-[1.45] shadow-[0_2px_10px_rgba(0,122,255,0.25)]"
            : "rounded-[20px] rounded-bl-[6px] bg-[rgba(120,120,128,0.08)] px-4 py-3 text-foreground leading-[1.55]",
        )}
      >
        {/* 思维链：默认收合（辅助层不摊开占屏，正文优先）；串流且还没有正文时
            自动展开——真空期里「AI 在想什么」可见（不再黑盒）。
            open 属性只在自动展开条件成立时渲染：undefined 时非受控，
            用户点开/收起不会被重渲染冲掉。 */}
        {item.kind === "assistant" && item.reasoning ? (
          <details
            className="mb-1.5 [&_.brain-chevron]:transition-transform [&[open]>.brain-summary_.brain-chevron]:rotate-180"
            {...(item.streaming && !item.text ? { open: true } : {})}
          >
            {/* 觸控目標 ≥44px：行動端沒有 hover，摘要行要按得到（詳情由內部 span 撐高）。
                select-none 只鎖摘要行（避免拖選時把「思考過程」標籤一起圈走），
                展開後的思維鏈內容可自由選取複製。 */}
            <summary className="brain-summary block min-h-11 cursor-pointer touch-manipulation select-none [-webkit-tap-highlight-color:transparent]">
              <span className="flex min-h-11 items-center gap-1.5 text-ios-footnote font-medium text-muted-foreground">
                <Brain className="h-3.5 w-3.5 shrink-0 text-foreground/40" aria-hidden="true" />
                思考過程
                <ChevronDown className="brain-chevron h-3.5 w-3.5 shrink-0 text-foreground/35" aria-hidden="true" />
                <button
                  type="button"
                  onClick={copyReasoning}
                  aria-label="复制思考过程"
                  title="复制思考过程"
                  className="ml-1 flex h-7 w-7 items-center justify-center rounded-full text-foreground/40 transition-colors hover:bg-black/[0.06] hover:text-foreground/70 active:scale-95"
                >
                  {reasoningCopied ? (
                    <Check className="h-3.5 w-3.5 text-ios-green" aria-hidden="true" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>
              </span>
            </summary>
            <div className="mt-1 whitespace-pre-wrap break-words rounded-[14px] bg-black/[0.035] px-3 py-2.5 text-ios-caption1 leading-[1.6] text-muted-foreground [overflow-wrap:anywhere]">
              {item.reasoning}
            </div>
          </details>
        ) : null}
        {/* 空文本时用零宽空格撑住气泡高度，避免 streaming 首帧内容突跳。
            助理正文走 Markdown 渲染（表格/粗体/列表/代码块；图片直链转缩略图、
            行内代码弱化——罪状 3/9）；用户气泡保持纯文本原样。 */}
        {displayText ? (
          item.kind === "assistant" ? (
            <AgentMarkdown text={displayText} />
          ) : (
            displayText
          )
        ) : (
          "​"
        )}
        {/* 附件卡（罪状 1）：只在解析出附件时渲染，纯文本消息零开销。 */}
        {hasAttachments && <AgentAttachmentCards refs={userParsed.refs} sessionId={sessionId} />}
        {/* 串流中的打字光标。纯视觉提示，屏读器宣告由 AgentChatPanel 的
            role="status" 区域负责。 */}
        {item.kind === "assistant" && item.streaming && (
          <span
            className="agent-caret"
            aria-hidden="true"
            style={{
              // 游標不破行：0 寬 inline-block 永不觸發換行，改用 outline 畫出 2px 游標，
              // 緊貼最後一個字——長串流中游標不會孤零零掉去下一行行首。
              width: 0,
              marginLeft: 0,
              background: "transparent",
              outline: "2px solid currentColor",
              outlineOffset: 0,
              ...(reducedMotion ? { animation: "none" } : {}),
            }}
          />
        )}
      </div>
    </div>
  );
}

export const AgentMessageBubble = memo(AgentMessageBubbleComponent);
