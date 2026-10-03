"use client";

import { memo, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentPendingConfirm } from "@/lib/agent-chat-types";

export interface AgentConfirmCardProps {
  confirm: AgentPendingConfirm;
  /** 传入 requestId 与批准与否；由 wiring 阶段连到 reducer 的 confirm 分发。 */
  onConfirm: (requestId: string, approved: boolean) => Promise<boolean | void>;
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

/**
 * 点击后的裁决提交：先落 pending，await onConfirm，失败（reject）或明确返回
 * false 时解锁 pending；成功（返回 true/undefined）时保持锁定，交给父层
 * 随后经 confirm.resolved 把卡片整个移除——单独抽成纯函数，供 node --test
 * 直接灌 deferred promise 断言解锁行为，不依赖 DOM 事件模拟。
 */
export async function submitConfirmDecision(
  onConfirm: (requestId: string, approved: boolean) => Promise<boolean | void>,
  requestId: string,
  approved: boolean,
  setPending: (value: "approve" | "reject" | null) => void,
): Promise<void> {
  setPending(approved ? "approve" : "reject");
  try {
    const ok = await onConfirm(requestId, approved);
    if (ok === false) setPending(null);
  } catch {
    setPending(null);
  }
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
  // 决策卡摘要行（预览语汇）：左端一行方案摘要，右端币金小字。
  // 缺 description（单笔无明细）时退回「将花费」这个诚实标签，不凭空造句。
  const summary = description && description.trim() ? description.trim() : "将花费";

  return (
    <div className="agent-rise lg-sheet relative overflow-hidden rounded-[20px] p-4" aria-busy={locked}>
      {/* 顶缘 specular 亮线（agent-chat-preview 决策卡已批准语汇）：玻璃上缘受光。 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80"
      />
      {interpret && (
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[rgba(122,73,255,0.14)] text-[#7C4DFF]">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-ios-subhead font-semibold text-foreground">
              我这么理解你的愿望
            </p>
            <p className="mt-0.5 break-words text-sm leading-[1.55] text-muted-foreground">
              {interpret}
            </p>
          </div>
        </div>
      )}
      {/* 预览决策卡语汇（2026-09-20 对版）：币数不再单独成行放大，改右端
          `text-ios-footnote font-medium text-[#b8860b]` 小字「N 币」；
          金额的第二处落在主钮文案「确认 · N 币」上。 */}
      <div className={cn("flex items-baseline justify-between gap-3", interpret && "mt-3")}>
        <p className="agent-turn-text min-w-0 text-[0.9375rem] leading-snug text-foreground">
          {summary}
        </p>
        <span className="shrink-0 text-ios-footnote font-medium text-[#b8860b]">
          {formatCoins(amountCoins)} 币
        </span>
      </div>
      <p className="mt-1 text-ios-footnote text-muted-foreground">
        确认后开始生成，可随时补充要求。
      </p>
      {/* 预览主 CTA 语汇：确认＝#2d3142 深底实心 + 悬浮微升（主钮自带金额）；
          次钮＝幽灵灰字 + 蓝色 hover 底。取消语义照现场：拒绝这笔花费，
          reducer 结「已拒绝该笔花费。」（不是换方案，不谎标「换个方案」）。 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setPending("approve");
            void (async () => {
              try {
                const ok = await onConfirm(requestId, true);
                if (ok === false) setPending(null);
              } catch {
                setPending(null);
              }
            })();
          }}
          disabled={locked}
          className={cn(
            "flex min-h-11 items-center justify-center gap-1.5 rounded-full bg-[#2d3142] px-5 text-ios-footnote font-medium text-white",
            "shadow-[0_8px_20px_rgba(45,49,66,0.18)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-[#272b39] active:scale-95",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20",
            "disabled:cursor-not-allowed disabled:bg-[#2d3142]/60 disabled:shadow-none disabled:active:translate-y-0 disabled:active:scale-100",
            "[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
          )}
        >
          {pending === "approve" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          确认 · {formatCoins(amountCoins)} 币
        </button>
        <button
          type="button"
          onClick={() => {
            setPending("reject");
            void (async () => {
              try {
                const ok = await onConfirm(requestId, false);
                if (ok === false) setPending(null);
              } catch {
                setPending(null);
              }
            })();
          }}
          disabled={locked}
          className={cn(
            "flex min-h-11 items-center justify-center gap-1.5 rounded-full px-4 text-ios-footnote font-medium",
            "text-muted-foreground transition-all duration-200 hover:bg-[rgba(0,122,255,0.12)] hover:text-foreground/75 active:scale-95",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
          )}
        >
          {pending === "reject" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          取消
        </button>
      </div>
    </div>
  );
}

export const AgentConfirmCard = memo(AgentConfirmCardComponent);
