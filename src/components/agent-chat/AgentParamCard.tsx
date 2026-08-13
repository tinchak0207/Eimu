"use client";

// D-19 参数卡片：摊开 agent 这次实际用到的参数，分两层。
//   常用层（模型/尺寸/张数/花费）默认展开——使用者一眼看到花多少钱、出几张。
//   进阶层（LoRA/权重/sampler/steps/seed）默认收起——不给不懂的人添噪音，
//   但懂的人点一下就能核对，不用去翻日志。
//
// 参数只读。改参数的入口是对话（「换成 4:3」），不是在卡片上拉控件——
// 卡片是「agent 打算怎么做」的收据，不是第二套控制面板。

import { memo, useMemo, useState } from "react";
import { ChevronDown, Coins, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseToolParams, type AgentParam } from "@/lib/agent-tool-params";

export interface AgentParamCardProps {
  argsSummary: string | undefined;
  /** 该工具已结算的花费；未结算时不显示，绝不猜。 */
  costCoins?: number;
  /** 折叠区的 DOM id 前缀，保证同一页多张卡的 aria-controls 不撞。 */
  idPrefix: string;
}

function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function ParamRow({ param }: { param: AgentParam }) {
  return (
    <div className={cn("min-w-0", param.wide && "col-span-full")}>
      <dt className="text-ios-caption1 text-[rgba(0,0,0,0.42)]">{param.label}</dt>
      <dd
        className={cn(
          "mt-0.5 text-ios-footnote text-[rgba(0,0,0,0.78)]",
          // 长文本允许折行，短值保持单行不撑破网格
          param.wide ? "break-words leading-relaxed" : "truncate tabular-nums",
        )}
        title={param.value}
      >
        {param.value}
      </dd>
    </div>
  );
}

function AgentParamCardComponent({ argsSummary, costCoins, idPrefix }: AgentParamCardProps) {
  const parsed = useMemo(() => parseToolParams(argsSummary), [argsSummary]);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  if (!parsed) return null;

  const common = parsed.params.filter((p) => p.tier === "common");
  const advanced = parsed.params.filter((p) => p.tier === "advanced");

  // 一个参数都没捞出来 → 退回原文。诚实优于漂亮：
  // 不把半截 JSON 编成看起来完整的参数表。
  if (common.length === 0 && advanced.length === 0) {
    return (
      <p className="rounded-ios-md bg-[rgba(0,0,0,0.03)] px-3 py-2 font-mono text-ios-footnote leading-[1.5] text-[rgba(0,0,0,0.60)]">
        {parsed.raw}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-ios-md bg-[rgba(0,0,0,0.025)] px-3 py-2.5">
      {common.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          {common.map((param) => (
            <ParamRow key={param.key} param={param} />
          ))}
          {/* 花费和参数并排：D-19 把「花费」算进常用层。 */}
          {costCoins !== undefined && (
            <div className="min-w-0">
              <dt className="text-ios-caption1 text-[rgba(0,0,0,0.42)]">花费</dt>
              <dd className="mt-0.5 flex items-center gap-1 text-ios-footnote font-medium tabular-nums text-[rgba(120,90,20,0.88)]">
                <Coins className="h-3 w-3 shrink-0" aria-hidden="true" />
                {formatCoins(costCoins)} 币
              </dd>
            </div>
          )}
        </dl>
      )}

      {advanced.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            aria-expanded={advancedOpen}
            aria-controls={`${idPrefix}-advanced`}
            className="inline-flex w-fit cursor-pointer items-center gap-1 text-ios-caption1 font-medium text-[rgba(0,0,0,0.46)] transition-colors duration-200 hover:text-[rgba(0,0,0,0.78)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
          >
            <SlidersHorizontal className="h-3 w-3" aria-hidden="true" />
            进阶参数
            <span className="tabular-nums text-[rgba(0,0,0,0.46)]">{advanced.length}</span>
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform duration-200", advancedOpen && "rotate-180")}
              aria-hidden="true"
            />
          </button>
          <div id={`${idPrefix}-advanced`} className={cn("agent-args", advancedOpen && "is-open")}>
            <div className="agent-args-inner">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-[rgba(0,0,0,0.06)] pt-2 sm:grid-cols-3">
                {advanced.map((param) => (
                  <ParamRow key={param.key} param={param} />
                ))}
              </dl>
            </div>
          </div>
        </>
      )}

      {/* 上游截断过就说出来，不让使用者以为这就是全部参数。 */}
      {parsed.truncated && (
        <p className="text-ios-caption1 text-[rgba(0,0,0,0.46)]">
          上游只回传了参数摘要，可能不完整
        </p>
      )}
    </div>
  );
}

export const AgentParamCard = memo(AgentParamCardComponent);
