"use client";

import { memo, type ComponentType } from "react";
import { Check, Coins, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentToolCallItem } from "@/lib/agent-chat-types";
import { AgentParamDisclosure } from "./AgentParamDisclosure";

export interface AgentToolCardProps {
  item: AgentToolCallItem;
}

interface ToolStatusMeta {
  label: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  tone: string;
}

const STATUS_META: Record<AgentToolCallItem["status"], ToolStatusMeta> = {
  running: { label: "运行中…", Icon: Loader2, tone: "text-[#007AFF]" },
  ok: { label: "已完成", Icon: Check, tone: "text-[#34C759]" },
  failed: { label: "失败", Icon: X, tone: "text-[#FF3B30]" },
};

/** 展示用的金币数：整数原样，浮点去掉多余尾巴。 */
function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function AgentToolCardComponent({ item }: AgentToolCardProps) {
  const status = STATUS_META[item.status];
  const running = item.status === "running";

  return (
    <div className="agent-rise lg-card flex flex-col gap-2 rounded-ios-2xl px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[rgba(0,0,0,0.04)] text-[rgba(0,0,0,0.55)]">
          <status.Icon className={cn("h-4 w-4", running && "animate-spin")} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-ios-subhead font-semibold text-[rgba(0,0,0,0.85)]">
            {item.tool}
          </p>
          {item.costCoins !== undefined && (
            <p className="mt-0.5 flex items-center gap-1 text-ios-caption1 text-[rgba(120,90,20,0.85)]">
              <Coins className="h-3 w-3" aria-hidden="true" />
              消耗 {formatCoins(item.costCoins)} 金币
            </p>
          )}
        </div>
        <span className={cn("shrink-0 text-ios-caption1 font-medium", status.tone)}>
          {status.label}
        </span>
      </div>

      {/* D-19 分层参数 + D-23 窄屏底部抽屉。展开与布局切换都归 AgentParamDisclosure，
          这张卡只负责说「这次调了什么工具、花了多少」。
          花费不往下传：卡片头已经常驻显示，展开后再来一次是噪音。
          （AgentParamCard 保留 costCoins 是给没有卡头的挂载点用的。） */}
      {item.argsSummary !== undefined && (
        <AgentParamDisclosure
          argsSummary={item.argsSummary}
          idPrefix={`agent-args-${item.id}`}
          toolName={item.tool}
        />
      )}
    </div>
  );
}

export const AgentToolCard = memo(AgentToolCardComponent);
