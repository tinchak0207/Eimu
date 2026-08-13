"use client";

import { memo } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentNoticeItem } from "@/lib/agent-chat-types";

export interface AgentNoticeRowProps {
  item: AgentNoticeItem;
}

function AgentNoticeRowComponent({ item }: AgentNoticeRowProps) {
  const isError = item.tone === "error";
  const Icon = isError ? AlertTriangle : Info;

  return (
    <div
      role="status"
      className={cn(
        "agent-rise flex items-start gap-2.5 rounded-ios-2xl px-3.5 py-2.5 text-ios-footnote leading-[1.5]",
        isError ? "lg-tint-red text-[#B3261E]" : "bg-[rgba(0,0,0,0.03)] text-[rgba(0,0,0,0.55)]",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          isError ? "text-[#FF3B30]" : "text-[rgba(0,0,0,0.38)]",
        )}
        aria-hidden="true"
      />
      <span className="min-w-0">{item.text}</span>
    </div>
  );
}

export const AgentNoticeRow = memo(AgentNoticeRowComponent);
