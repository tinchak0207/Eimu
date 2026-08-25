"use client";

import { memo, useState } from "react";
import { Coins, Loader2, Sparkles } from "lucide-react";
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
  /**
   * 裁决已提交、等待结果时的宿主信号（如网络往返期间）。
   * 缺席时卡片用内部状态在点击瞬间锁住按钮，防双指连点同一笔花费。
   */
  busy?: boolean;
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

function AgentConfirmCardComponent({ confirm, onConfirm, contextText, busy = false }: AgentConfirmCardProps) {
  const { requestId, amountCoins, description } = confirm;
  // 点下去的瞬间锁住两颗按钮：同一笔花费不该被连点两次裁决。
  // 宿主传入 busy 时以宿主信号为准；没有接线时内部状态兜底。
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const locked = busy || pending !== null;

  // D-25：解读 = 这轮已流出的 assistant 文本（agent 对许愿的复述）。
  // description 是网关工具侧的费用明细（「生成 N 张图（模型），预估花费 X 币」），
  // 归费用区块小字——它不是愿望解读，塞进解读标题下文不对题（2026-08-26 修正）。
  const interpret = (contextText ?? "").trim();

  return (
    <div className="agent-rise lg-sheet rounded-ios-2xl p-3.5" aria-busy={locked}>
      {interpret && (
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[rgba(122,73,255,0.14)] text-[#7C4DFF]">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-ios-subhead font-semibold text-foreground">
              我这么理解你的愿望
            </p>
            <p className="mt-0.5 text-sm leading-[1.55] text-muted-foreground">
              {interpret}
            </p>
          </div>
        </div>
      )}
      {/* 扣费数字是这张卡的主角：金额单独成行放大加粗，金币单位跟行尾，一眼看清要扣多少。 */}
      <div className="mt-3 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[rgba(255,179,0,0.16)] text-[#B8860B]">
          <Coins className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-muted-foreground">
            将花费
          </p>
          <p className="mt-0.5 flex items-baseline gap-1.5">
            <span className="text-ios-title2 font-bold leading-none tabular-nums text-[#B8860B]">
              {formatCoins(amountCoins)}
            </span>
            <span className="text-ios-subhead font-semibold text-muted-foreground">金币</span>
          </p>
          {/* 费用明细（description）：跟在金额下面当小字，只出现一次——
              之前在解读区重复展示同一段，被用户点名。 */}
          {description && (
            <p className="mt-1.5 text-sm leading-[1.55] text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </div>
      {/* 两颗大按钮并排各占一半，拇指直接盖住；取消是中性灰，确认是实心蓝，视觉绝不混淆。 */}
      <div className="mt-3.5 grid grid-cols-2 gap-2.5">
        <button
          type="button"
          onClick={() => {
            setPending("reject");
            onConfirm(requestId, false);
          }}
          disabled={locked}
          className={cn(
            "flex min-h-12 items-center justify-center gap-1.5 rounded-full text-ios-subhead font-semibold",
            "bg-black/[0.06] text-muted-foreground transition-colors duration-150 active:bg-black/10",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
          )}
        >
          {pending === "reject" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          取消
        </button>
        <button
          type="button"
          onClick={() => {
            setPending("approve");
            onConfirm(requestId, true);
          }}
          disabled={locked}
          className={cn(
            "flex min-h-12 items-center justify-center gap-1.5 rounded-full text-ios-subhead font-semibold text-white",
            "bg-ios-blue shadow-[0_4px_12px_rgba(0,122,255,0.32)] transition-all duration-200 active:scale-[0.98] active:bg-ios-blue/80",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/40",
            "disabled:cursor-not-allowed disabled:bg-black/[0.12] disabled:shadow-none disabled:active:scale-100",
            "[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
          )}
        >
          {pending === "approve" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          确认
        </button>
      </div>
    </div>
  );
}

export const AgentConfirmCard = memo(AgentConfirmCardComponent);
