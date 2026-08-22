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
  // 结构化值（JSON 列表/对象，例如模型清单、LoRA 数组）必须整段可见：
  // 手机没有 title 悬浮提示，truncate 等于把内容藏起来。
  const structured = param.value.startsWith("[") || param.value.startsWith("{");
  const wrap = param.wide || structured;
  return (
    <div className={cn("min-w-0", wrap && "col-span-full")}>
      <dt className="text-ios-caption1 text-foreground/45">{param.label}</dt>
      <dd
        className={cn(
          "mt-0.5 text-ios-footnote text-foreground",
          // 长文本允许折行（overflow-wrap:anywhere 连无空格的长 JSON 也折），
          // 短值保持单行不撑破网格
          wrap ? "[overflow-wrap:anywhere] leading-relaxed" : "truncate tabular-nums",
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
      // 原文可能是被截断的 JSON / 错误载荷：保换行、长 token 也折行，
      // 不许横向溢出卡片（手机上没有 hover 能看全）。
      <p className="whitespace-pre-wrap rounded-ios-md bg-black/[0.03] px-3 py-2 font-mono text-ios-footnote leading-[1.5] text-muted-foreground [overflow-wrap:anywhere]">
        {parsed.raw}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-ios-md bg-black/[0.025] px-3 py-2.5">
      {common.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          {common.map((param) => (
            <ParamRow key={param.key} param={param} />
          ))}
          {/* 花费和参数并排：D-19 把「花费」算进常用层。 */}
          {costCoins !== undefined && (
            <div className="min-w-0">
              <dt className="text-ios-caption1 text-foreground/45">花费</dt>
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
            className="inline-flex min-h-11 w-fit cursor-pointer touch-manipulation items-center gap-1.5 self-start rounded-full px-2.5 text-ios-subhead font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground active:bg-black/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 motion-reduce:transition-none [-webkit-tap-highlight-color:transparent]"
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            进阶参数
            <span className="tabular-nums text-foreground/45">{advanced.length}</span>
            <ChevronDown
              className={cn("h-4 w-4 transition-transform duration-200 motion-reduce:transition-none", advancedOpen && "rotate-180")}
              aria-hidden="true"
            />
          </button>
          <div id={`${idPrefix}-advanced`} className={cn("agent-args", advancedOpen && "is-open")}>
            {/* 长参数表在卡内滚动而不是把卡片撑到看不见底：50dvh 封顶。
                overflow-y 用内联样式盖过 .agent-args-inner 的 overflow:hidden。 */}
            <div className="agent-args-inner max-h-[50dvh] overscroll-contain" style={{ overflowY: "auto" }}>
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
        <p className="text-ios-caption1 text-foreground/45">
          上游只回传了参数摘要，可能不完整
        </p>
      )}
    </div>
  );
}

export const AgentParamCard = memo(AgentParamCardComponent);
