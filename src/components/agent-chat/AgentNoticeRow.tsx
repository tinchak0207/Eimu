"use client";

import { memo, useEffect, useState } from "react";
import { AlertTriangle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentNoticeItem } from "@/lib/agent-chat-types";

export interface AgentNoticeRowProps {
  item: AgentNoticeItem;
}

/** prefers-reduced-motion：入場位移對暈動敏感者不友好，關掉。 */
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

function AgentNoticeRowComponent({ item }: AgentNoticeRowProps) {
  const isError = item.tone === "error";
  const Icon = isError ? AlertTriangle : Info;
  const reducedMotion = usePrefersReducedMotion();
  const [dismissed, setDismissed] = useState(false);

  // 使用者點掉提示：本機隱藏（資料模型不動，下次新 notice 是新 key 的新行）。
  if (dismissed) return null;

  return (
    <div
      role="status"
      className={cn(
        "agent-rise flex items-start gap-1.5 rounded-ios-2xl py-1 pl-3.5 pr-1.5 text-ios-footnote leading-[1.5]",
        isError ? "lg-tint-red text-destructive" : "bg-black/[0.03] text-muted-foreground",
      )}
      style={reducedMotion ? { animation: "none" } : undefined}
    >
      <Icon
        className={cn(
          "mt-3 h-4 w-4 shrink-0",
          isError ? "text-destructive" : "text-foreground/45",
        )}
        aria-hidden="true"
      />
      <span className="flex min-h-11 min-w-0 flex-1 items-center break-words py-1 [overflow-wrap:anywhere]">
        {item.text}
      </span>
      {/* 可關閉：點掉讓提示讓路，不擋閱讀；44×44 觸控目標，按下有 active 反饋。 */}
      <button
        type="button"
        aria-label="关闭提示"
        onClick={() => setDismissed(true)}
        className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-full text-foreground/45 transition-colors active:bg-black/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 [-webkit-tap-highlight-color:transparent]"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export const AgentNoticeRow = memo(AgentNoticeRowComponent);
