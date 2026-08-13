"use client";

import { memo } from "react";
import { cn } from "@/lib/utils";
import type { AgentAssistantTextItem, AgentUserTurnItem } from "@/lib/agent-chat-types";

export interface AgentMessageBubbleProps {
  item: AgentUserTurnItem | AgentAssistantTextItem;
}

function AgentMessageBubbleComponent({ item }: AgentMessageBubbleProps) {
  const isUser = item.kind === "user";

  return (
    <div className={cn("agent-rise flex w-full", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[82%] whitespace-pre-wrap break-words text-[15px]",
          isUser
            ? "ml-auto max-w-[75%] rounded-[18px] rounded-br-[4px] bg-gradient-to-br from-[#007AFF] to-[#0055D4] px-3.5 py-2.5 text-white leading-[1.45] shadow-[0_4px_16px_rgba(0,122,255,0.32)]"
            : "rounded-[18px] rounded-bl-[4px] bg-[rgba(120,120,128,0.12)] px-4 py-3 text-[rgba(0,0,0,0.84)] leading-[1.55] ring-1 ring-black/[0.06] shadow-[0_2px_12px_rgba(0,0,0,0.06)] backdrop-blur-xl",
        )}
      >
        {/* 思维链：灰色小字，串流时也实时追加，让「AI 在想什么」可见（不再黑盒） */}
        {item.kind === "assistant" && item.reasoning ? (
          <details className="mb-1.5 select-none" open>
            <summary className="cursor-pointer text-[13px] font-medium text-[rgba(0,0,0,0.38)]">
              思考過程
            </summary>
            <div className="mt-1 whitespace-pre-wrap break-words border-l-2 border-black/10 pl-2.5 text-[13px] leading-[1.5] text-[rgba(0,0,0,0.45)] italic">
              {item.reasoning}
            </div>
          </details>
        ) : null}
        {/* 空文本时用零宽空格撑住气泡高度，避免 streaming 首帧内容突跳 */}
        {item.text || "​"}
        {/* 串流中的打字光标。纯视觉提示，屏读器宣告由 AgentChatPanel 的
            role="status" 区域负责。 */}
        {item.kind === "assistant" && item.streaming && (
          <span className="agent-caret" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

export const AgentMessageBubble = memo(AgentMessageBubbleComponent);
