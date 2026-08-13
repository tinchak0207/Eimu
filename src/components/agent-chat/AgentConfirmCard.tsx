"use client";

import { memo } from "react";
import { Coins, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentPendingConfirm } from "@/lib/agent-chat-types";

export interface AgentConfirmCardProps {
  confirm: AgentPendingConfirm;
  /** 传入 requestId 与批准与否；由 wiring 阶段连到 reducer 的 confirm 分发。 */
  onConfirm: (requestId: string, approved: boolean) => void;
  /**
   * 这一轮已收到的 message.delta 文本（最新一条 assistant 条目的累计文本）。
   * D-25 魔法时刻：先把 Agent 对许愿的「解读」端上来，用户先确认愿望被听懂，
   * 再让图片逐张浮现。解读文本 = confirm 事件的 description + 这轮已流出的
   * assistant 文本，不凭空造字段。缺 sentiment 时卡片退回纯花费确认。
   */
  contextText?: string;
}

/**
 * 展示用的金币数。模型单价横跨约 6000 倍（pixai-reference-pro 0.00097 → gpt-image 6），
 * 不能一律 toFixed(1)——那会把 0.05 显示成 "0.1"（虚报）、把 0.00097 显示成 "0.0"。
 * 整数直接显示，>=1 用两位小数，<1 向下取整到万分位，绝不虚报。
 */
function formatCoins(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  // 小额向下取整，绝不把 0.00097 显示成 0，也不虚报到 0.001
  return String(Math.max(0, Math.floor(n * 1e5) / 1e5));
}

function AgentConfirmCardComponent({ confirm, onConfirm, contextText }: AgentConfirmCardProps) {
  const { requestId, amountCoins, description } = confirm;

  // D-25：解读 = description（confirm.request 的事件本体）+ 这轮已流出的 assistant 文本。
  // 没有解读可搬时退回纯花费确认，不让卡片空白。
  const interpret = [description, contextText].filter((t): t is string => !!t && t.trim().length > 0).join(" ");

  return (
    <div className="agent-rise lg-sheet rounded-ios-2xl p-3.5">
      {interpret && (
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[rgba(122,73,255,0.14)] text-[#7C4DFF]">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-ios-subhead font-semibold text-[rgba(0,0,0,0.85)]">
              我这么理解你的愿望
            </p>
            <p className="mt-0.5 text-ios-footnote leading-[1.5] text-[rgba(0,0,0,0.55)]">
              {interpret}
            </p>
          </div>
        </div>
      )}
      <div className="mt-3 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[rgba(255,179,0,0.16)] text-[#B8860B]">
          <Coins className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-ios-subhead font-semibold text-[rgba(0,0,0,0.85)]">
            将花费 {formatCoins(amountCoins)} 金币
          </p>
          {description && (
            <p className="mt-0.5 text-ios-footnote leading-[1.5] text-[rgba(0,0,0,0.55)]">
              {description}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onConfirm(requestId, false)}
          className="rounded-full px-4 py-1.5 text-ios-caption1 font-semibold text-[rgba(0,0,0,0.55)] transition-colors hover:bg-[rgba(0,0,0,0.05)] hover:text-[rgba(0,0,0,0.80)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => onConfirm(requestId, true)}
          className={cn(
            "rounded-full bg-[#007AFF] px-4 py-1.5 text-ios-caption1 font-semibold text-white shadow-[0_4px_12px_rgba(0,122,255,0.32)]",
            "transition-all duration-200 hover:-translate-y-[1px] active:scale-[0.97]",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.40)]",
          )}
        >
          确认
        </button>
      </div>
    </div>
  );
}

export const AgentConfirmCard = memo(AgentConfirmCardComponent);
