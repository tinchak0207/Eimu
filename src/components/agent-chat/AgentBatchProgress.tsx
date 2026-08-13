"use client";

import { memo } from "react";
import { Coins, Images, Square } from "lucide-react";
import type { AgentChatState } from "@/lib/agent-chat-types";

export interface AgentBatchProgressProps {
  items: AgentChatState["items"];
  /**
   * 随时可停的入口。D-26：批量直接跑 + 实时进度，不逐张弹确认，随时可停。
   *
   * 语义是「要求 agent 停手」，不是即时中断——网关没有 abort 端点，
   * 正在跑的那一张仍会跑完。文案与 title 都照这个语义写，不给假承诺。
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
function AgentBatchProgressComponent({ items, onStop }: AgentBatchProgressProps) {
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

  return (
    <div className="agent-rise lg-card flex items-center gap-2.5 rounded-ios-2xl px-3.5 py-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[rgba(0,122,255,0.10)] text-[#007AFF]">
        <Images className="h-4 w-4" aria-hidden="true" />
      </span>
      {/*
        刻意不用 role="progressbar"：ARIA 里 aria-valuemax 缺省是 100，
        给了 aria-valuenow={images} 就等于宣告「5 / 100」——而总数 Y 根本推不出来
        （事件流没有这个字段）。屏读器会念出一个我们没有的分母，那是虚报。
        总数未知的进度只能是文字状态区，等后端真的给出分母再升级成 progressbar。
      */}
      <div role="status" aria-live="polite" className="min-w-0 flex-1">
        <p className="text-ios-footnote font-semibold leading-[1.5] text-[rgba(0,0,0,0.85)]">
          已出 {images} 张
        </p>
        {coins !== 0 && (
          <p className="mt-0.5 flex items-center gap-1 text-ios-caption1 leading-[1.5] text-[rgba(120,90,20,0.85)]">
            <Coins className="h-3 w-3" aria-hidden="true" />
            已花 {formatCoins(coins)} 币
          </p>
        )}
      </div>
      {onStop && (
        <button
          type="button"
          onClick={onStop}
          aria-label="要求助理停止生成"
          title="当前这张跑完就停，后面的不再开始"
          className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-[rgba(255,59,48,0.09)] px-3 text-ios-caption1 font-semibold text-[#FF3B30] transition-colors hover:bg-[rgba(255,59,48,0.16)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(255,59,48,0.30)]"
        >
          <Square className="h-3 w-3" aria-hidden="true" />
          停下
        </button>
      )}
    </div>
  );
}

export const AgentBatchProgress = memo(AgentBatchProgressComponent);