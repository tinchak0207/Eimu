"use client";

// 畫布預算橫條：已花 / 共。放在工具列右側，無預算時隱藏。

import { cn } from "@/lib/utils";

export interface CanvasBudgetBarProps {
  budget: { usedCoins: number; remainingCoins: number } | null;
  className?: string;
}

function fillColorFor(pct: number): string {
  if (pct < 60) return "#34C759";
  if (pct <= 85) return "#FFB300";
  return "#FF3B30";
}

export function CanvasBudgetBar({ budget, className }: CanvasBudgetBarProps) {
  if (!budget) return null;
  const total = budget.usedCoins + budget.remainingCoins;
  const pct = total > 0 ? Math.min(100, (budget.usedCoins / total) * 100) : 0;

  return (
    <div
      role="progressbar"
      aria-label="画布预算"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={budget.usedCoins}
      title={`已花 ${budget.usedCoins} / 共 ${total} 币`}
      className={cn("lg-float flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5", className)}
    >
      <span className="text-[12px] font-medium whitespace-nowrap text-[rgba(0,0,0,0.65)] tabular-nums">
        已花 {budget.usedCoins} / 共 {total} 币
      </span>
      <span className="block h-1.5 w-16 overflow-hidden rounded-full bg-[rgba(0,0,0,0.08)]">
        <span
          className="block h-full rounded-full transition-all duration-300"
          style={{ width: `${pct}%`, background: fillColorFor(pct) }}
        />
      </span>
    </div>
  );
}
