"use client";

// 子代理产出卡（F3/F4）：回合收尾（turn.done / session.error）后，子代理的
// summary 与串流全文转存成这条持久条目——中止不再把唯一有价值的产出一起删掉。
//
// 展开语言沿用工具卡家族：一行预览（truncate）+ 整行可点 + ChevronDown 旋转，
// 展开区放全文（whitespace-pre-wrap，不在模型层硬切）。不新造第二套展开交互。

import { memo, useId, useState } from "react";
import { Bot, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentSubagentReportItem } from "@/lib/agent-chat-types";

export interface AgentSubagentReportCardProps {
  item: AgentSubagentReportItem;
}

const STATUS_META: Record<AgentSubagentReportItem["status"], { label: string; badge: string }> = {
  ok: { label: "已完成", badge: "lg-tint-green text-[#248A3D]" },
  error: { label: "失败", badge: "lg-tint-red text-destructive" },
  // 中止：诚实标「已中止」，不留 running 假状态，也不谎报失败。
  interrupted: { label: "已中止", badge: "bg-black/[0.05] text-muted-foreground" },
};

/** 预览行：全文的第一个非空行（渲染层截断，模型层保留全文）。 */
export function reportPreview(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) return line.trim();
  }
  return "";
}

function AgentSubagentReportCardComponent({ item }: AgentSubagentReportCardProps) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const meta = STATUS_META[item.status];
  const preview = reportPreview(item.text);

  return (
    <div className="agent-rise flex w-full flex-col gap-1 rounded-[16px] bg-[rgba(120,120,128,0.06)] px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md text-left transition-colors hover:bg-black/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 motion-reduce:transition-none [-webkit-tap-highlight-color:transparent]"
      >
        <Bot className="h-3.5 w-3.5 shrink-0 text-foreground/40" aria-hidden="true" />
        <span className="shrink-0 text-ios-footnote font-semibold text-foreground">{item.label}</span>
        {/* 预览截断；全文在展开区，不硬切。 */}
        <span className="min-w-0 flex-1 truncate text-ios-footnote text-muted-foreground">
          {preview || "（无输出）"}
        </span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
            meta.badge,
          )}
        >
          {meta.label}
        </span>
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 text-foreground/30 transition-transform duration-300 ease-ios-spring motion-reduce:transition-none",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {/* 展开区：grid-rows 0fr→1fr 的既有折叠语言（与子任务详情面板同款）。 */}
      <div
        id={bodyId}
        className={cn(
          "grid grid-rows-[0fr] transition-[grid-template-rows] duration-300 ease-ios-spring motion-reduce:transition-none",
          open && "grid-rows-[1fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <p className="whitespace-pre-wrap break-words px-0.5 pb-1 pt-1.5 text-ios-footnote leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            {item.text || "（无输出）"}
          </p>
        </div>
      </div>
    </div>
  );
}

export const AgentSubagentReportCard = memo(AgentSubagentReportCardComponent);
