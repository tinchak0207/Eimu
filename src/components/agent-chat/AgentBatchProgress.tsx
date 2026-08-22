"use client";

import { memo } from "react";
import { Coins, Images, Square } from "lucide-react";
import type { AgentChatState } from "@/lib/agent-chat-types";

export interface AgentBatchProgressProps {
  items: AgentChatState["items"];
  /**
   * 整批的目标张数。事件流本身推不出分母（见组件注释），宿主若能拿到
   * （例如 canvas.plan 的 count）就传进来：进度条变成真实百分比；
   * 缺省时不假装知道总数，只做「进行中」的流动指示条。
   */
  total?: number;
  /**
   * 随时可停的入口。D-26：批量直接跑 + 实时进度，不逐张弹确认，随时可停。
   *
   * 系统层中止：网关 /session/:id/abort 打到 opencode，正在跑的这一轮直接终止。
   */
  onStop?: () => void;
}

/**
 * 币值格式化。模型单价横跨约 6000 倍（pixai-reference-pro 0.00097 → gpt-image 6），
 * 不能一律 toFixed(2)——那会把 0.00097 显示成 "0"。整数直接显示，>=1 用两位小数，
 * <1 向下取整到万分位，绝不虚报。
 */
function formatCoins(n: number): string {
  if (Number.isInteger(n)) return String(n);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  // 小额向下取整，绝不把 0.00097 显示成 0，也不虚报到 0.001
  return String(Math.max(0, Math.floor(n * 1e5) / 1e5));
}

/**
 * 批量许愿进度。只从 transcript 里已有的东西派生，不引入任何事件没有的字段：
 * - 已出张数 = image 类条目的数量（image.done 事件去重过，同 url 只算一张）。
 * - 已花币  = tool 类条目 costCoins 的累加（只数工具结算的扣费，不数 image.done 的
 *   costCoins，避免把同一笔扣费数两次）。
 * 总数 Y 无法从事件推出时的诚实呈现：只显示「已出 X 张 · 已花 Z 币」，
 * 不假装知道分母，也绝不把未知数显示成 0。
 */
function AgentBatchProgressComponent({ items, onStop, total }: AgentBatchProgressProps) {
  let images = 0;
  let coins = 0;

  for (const item of items) {
    if (item.kind === "image") {
      images += 1;
    } else if (item.kind === "tool" && typeof item.costCoins === "number") {
      coins += item.costCoins;
    }
  }

  if (images === 0 && coins === 0) return null;

  // 有真实分母才谈百分比：分母未知时进度条退成流动指示条，绝不显示假的「X%」。
  const hasTotal = typeof total === "number" && Number.isFinite(total) && total > 0;
  const totalCount = hasTotal ? (total as number) : 0;
  const pct = hasTotal ? Math.min(100, Math.round((images / totalCount) * 100)) : 0;

  return (
    <div className="agent-rise lg-card rounded-ios-2xl px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ios-blue/10 text-ios-blue">
          <Images className="h-4 w-4" aria-hidden="true" />
        </span>
        {/*
          刻意不用 role="progressbar"：ARIA 里 aria-valuemax 缺省是 100，
          给了 aria-valuenow={images} 就等于宣告「5 / 100」——而总数 Y 根本推不出来
          （事件流没有这个字段）。屏读器会念出一个我们没有的分母，那是虚报。
          总数未知的进度只能是文字状态区，等后端真的给出分母再升级成 progressbar。
        */}
        <div role="status" aria-live="polite" className="min-w-0 flex-1">
          <p className="text-ios-subhead font-semibold leading-[1.4] text-foreground">
            已出 {images} 张{hasTotal ? " / 共 " + totalCount + " 张" : ""}
          </p>
          {hasTotal && (
            <p className="mt-0.5 text-sm font-semibold tabular-nums leading-[1.4] text-ios-blue">
              已完成 {pct}%
            </p>
          )}
          {coins !== 0 && (
            <p className="mt-0.5 flex items-center gap-1 text-sm leading-[1.5] text-[rgba(120,90,20,0.85)]">
              <Coins className="h-3.5 w-3.5" aria-hidden="true" />
              已花 {formatCoins(coins)} 币
            </p>
          )}
        </div>
        {onStop && (
          <button
            type="button"
            onClick={onStop}
            aria-label="中止助理生成"
            title="立即中止当前这轮生成"
            className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-destructive/[0.09] px-4 text-sm font-semibold text-destructive transition-colors duration-150 active:bg-destructive/[0.16] focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/30 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]"
          >
            <Square className="h-3.5 w-3.5" aria-hidden="true" />
            停下
          </button>
        )}
      </div>
      {/*
        进度条：
        - 宿主给了 total → 真实百分比，fill 按比例走（reuse 全局 generation-progress-*
          样式，reduced-motion 已被 globals.css 兜住）。
        - 没给 total → 流动光带只表示「还在跑」，不占宽度，不冒充百分比。
      */}
      {hasTotal ? (
        <div className="generation-progress-track mt-2.5" role="presentation" aria-hidden="true">
          <div className="generation-progress-fill" style={{ width: pct + "%" }} />
        </div>
      ) : (
        <div className="agent-batch-indeterminate mt-2.5" role="presentation" aria-hidden="true" />
      )}
      <style>{INDETERMINATE_CSS}</style>
    </div>
  );
}

// 分母未知时的「进行中」指示条：流动光带不占宽度、不冒充百分比；
// prefers-reduced-motion 下退成静止的淡蓝条，只有状态没有运动。
const INDETERMINATE_CSS = [
  ".agent-batch-indeterminate{position:relative;height:6px;overflow:hidden;border-radius:999px;background:rgba(0,0,0,0.07);box-shadow:inset 0 1px 2px rgba(0,0,0,0.10);}",
  ".agent-batch-indeterminate::after{content:'';position:absolute;top:0;bottom:0;left:-45%;width:45%;border-radius:inherit;background:linear-gradient(90deg,rgba(0,122,255,0.30),rgba(0,122,255,0.75),rgba(0,122,255,0.30));animation:agent-batch-indeterminate 1.3s ease-in-out infinite;}",
  "@keyframes agent-batch-indeterminate{0%{left:-45%;}100%{left:100%;}}",
  "@media (prefers-reduced-motion: reduce){.agent-batch-indeterminate::after{animation:none;left:0;width:100%;opacity:0.25;}}",
].join("\n");

export const AgentBatchProgress = memo(AgentBatchProgressComponent);
