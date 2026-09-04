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
  /** 徽章底色：液态玻璃着色层（lg-tint-*），窄屏上比纯文字更可读。 */
  badge: string;
}

const STATUS_META: Record<AgentToolCallItem["status"], ToolStatusMeta> = {
  running: { label: "运行中…", Icon: Loader2, tone: "text-ios-blue", badge: "lg-tint-blue" },
  ok: { label: "已完成", Icon: Check, tone: "text-[#248A3D]", badge: "lg-tint-green" },
  failed: { label: "失败", Icon: X, tone: "text-destructive", badge: "lg-tint-red" },
};

/** 展示用的金币数：整数原样，浮点去掉多余尾巴。 */
function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** 参数摘要的一行预览：JSON 对象取首个字段值，否则取首行（都截断到一行）。 */
function argPreview(args: string): string {
  const t = args.trim();
  if (t.startsWith("{")) {
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      const first = Object.values(obj)[0];
      if (typeof first === "string" && first.length > 0) return first.replace(/\s+/g, " ").trim();
    } catch {
      /* 非严格 JSON 走首行兜底 */
    }
  }
  return t.split("\n")[0].replace(/\s+/g, " ").trim();
}

function AgentToolCardComponent({ item }: AgentToolCardProps) {
  const status = STATUS_META[item.status];
  const running = item.status === "running";
  // 执行中进度：只有 running 且网关回了 tool.progress 才有。终态后忽略（不冒充还在跑）。
  const progress = running ? item.progress : undefined;
  const pct = progress ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  // 有真实分母时徽章直接报计数「3/8」，比「运行中…」信息量大且不虚报。
  const badgeLabel = progress ? `${progress.done}/${progress.total}` : status.label;

  return (
    <div className="agent-rise flex flex-col gap-2 rounded-[18px] bg-[rgba(120,120,128,0.06)] px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-muted-foreground">
          <status.Icon className={cn("h-4 w-4", running && "animate-spin")} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-ios-subhead font-semibold text-foreground">
            {item.tool}
          </p>
          {item.argsSummary !== undefined && (
            <p className="mt-0.5 truncate text-ios-caption1 text-muted-foreground" title={item.argsSummary}>
              {argPreview(item.argsSummary)}
            </p>
          )}
          {item.costCoins !== undefined && (
            <p className="mt-0.5 flex items-center gap-1 text-ios-caption1 text-[rgba(120,90,20,0.85)]">
              <Coins className="h-3 w-3" aria-hidden="true" />
              消耗 {formatCoins(item.costCoins)} 金币
            </p>
          )}
        </div>
        {/* 状态徽章：着色胶囊比纯文字在窄屏更可读；whitespace-nowrap 保证不被
            长工具名挤出卡片（工具名那一侧自己 truncate 让位）。 */}
        <span
          className={cn(
            "inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-1 text-ios-footnote font-semibold tabular-nums",
            status.badge,
            status.tone,
          )}
        >
          {badgeLabel}
        </span>
      </div>

      {/* 逐镜/逐项进度：真实分母才画条（generation-progress-* 全局样式，reduced-motion
          已被 globals.css 兜住）。role=progressbar 带真实 valuenow/valuemax，不虚报。 */}
      {progress && (
        <div className="flex flex-col gap-1.5">
          <p className="text-ios-caption1 leading-[1.4] text-muted-foreground">
            {progress.label ?? "处理中"} · 已完成 {progress.done}/{progress.total}
          </p>
          <div
            className="generation-progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            aria-label={`${progress.label ?? "处理中"} ${progress.done}/${progress.total}`}
          >
            <div className="generation-progress-fill" style={{ width: pct + "%" }} />
          </div>
        </div>
      )}

      {/* 失败时的人类可读错误（R10-1）：gateway 的 tool.result error.human_message，
          让「红卡刷屏」不再是无声死循环——用户看得到它在修正什么。 */}
      {item.status === "failed" && item.error && (
        <p className="rounded-xl bg-destructive/10 px-2.5 py-1.5 text-ios-caption1 leading-relaxed text-destructive">
          {item.error}
        </p>
      )}

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
