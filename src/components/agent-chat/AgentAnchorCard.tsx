"use client";

// D-26 首张锚定卡。第一张图出来时问一句：就按这张出完整批，还是换个方向？
//
// 摆在输入区上方而不是插进 transcript：它是一个待决定的动作，不是已发生的事。
// transcript 是历史，历史不该有按钮等着人按。
//
// 两颗按钮都只是「送一句话进对话」——没有隐藏的后端调用，
// 送出去的原文就摆在 title 里，按下去等于自己打了这句话。

import { memo } from "react";
import { Anchor, RefreshCw } from "lucide-react";
import type { BatchAnchor } from "@/lib/agent-batch-anchor";

export interface AgentAnchorCardProps {
  anchor: BatchAnchor;
  /** 按「就按这张」：把第一张的参数念回给 agent。 */
  onAnchor: () => void;
  /** 按「换个方向」：先回到一张，满意再放量。 */
  onReanchor: () => void;
  /** 按「不用了」：这张不再问，纯 UI 动作，不送消息。 */
  onDismiss: () => void;
  /** 正在送锚定消息，两颗按钮一起锁，避免连点送两句。 */
  busy?: boolean;
}

function AgentAnchorCardComponent({ anchor, onAnchor, onReanchor, onDismiss, busy = false }: AgentAnchorCardProps) {
  // 只展示前 4 项，卡片是「锚什么」的摘要不是参数表——完整参数在上面那张卡里。
  const preview = anchor.params.slice(0, 4);
  const rest = anchor.params.length - preview.length;

  return (
    <div className="agent-rise lg-sheet rounded-ios-2xl p-3.5">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[rgba(0,122,255,0.12)] text-[#007AFF]">
          <Anchor className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-ios-subhead font-semibold text-[rgba(0,0,0,0.85)]">
            第 {anchor.seq} 张出来了，就按这张的风格出完整批？
          </p>
          <p className="mt-0.5 text-ios-footnote leading-[1.5] text-[rgba(0,0,0,0.55)]">
            锚定后整批沿用同一套参数，第 100 张不会跟第 1 张跑偏。
          </p>
          {preview.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {preview.map((param) => (
                <li
                  key={param.key}
                  className="max-w-[14rem] truncate rounded-full bg-[rgba(0,0,0,0.05)] px-2.5 py-0.5 text-ios-caption1 text-[rgba(0,0,0,0.60)]"
                  title={`${param.label}：${param.value}`}
                >
                  {param.label} {param.value}
                </li>
              ))}
              {rest > 0 && (
                <li className="rounded-full bg-[rgba(0,0,0,0.05)] px-2.5 py-0.5 text-ios-caption1 text-[rgba(0,0,0,0.50)]">
                  另 {rest} 项
                </li>
              )}
            </ul>
          )}
          {/* 上游截断过就说出来：锚定可能锚不全，不让使用者以为万无一失。 */}
          {anchor.truncated && (
            <p className="mt-1.5 text-ios-caption1 text-[rgba(0,0,0,0.46)]">
              上游只回传了参数摘要，可能有参数锚不住
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="cursor-pointer rounded-full px-3 py-1.5 text-ios-caption1 font-medium text-[rgba(0,0,0,0.48)] transition-colors hover:bg-[rgba(0,0,0,0.05)] hover:text-[rgba(0,0,0,0.78)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,0,0,0.20)] disabled:cursor-not-allowed disabled:text-[rgba(0,0,0,0.34)]"
        >
          不用了
        </button>
        <button
          type="button"
          onClick={onReanchor}
          disabled={busy}
          title="先只出 1 张换个方向，满意了再出整批"
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-[rgba(0,0,0,0.05)] px-3.5 py-1.5 text-ios-caption1 font-semibold text-[rgba(0,0,0,0.62)] transition-colors hover:bg-[rgba(0,0,0,0.09)] hover:text-[rgba(0,0,0,0.86)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,0,0,0.20)] disabled:cursor-not-allowed disabled:text-[rgba(0,0,0,0.34)]"
        >
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
          换个方向
        </button>
        <button
          type="button"
          onClick={onAnchor}
          disabled={busy}
          title="把这张实际用过的参数念回给助理，整批照抄"
          className="cursor-pointer rounded-full bg-[#007AFF] px-4 py-1.5 text-ios-caption1 font-semibold text-white shadow-[0_4px_12px_rgba(0,122,255,0.30)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-[#0066DD] active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.40)] disabled:cursor-not-allowed disabled:bg-[rgba(0,0,0,0.10)] disabled:text-[rgba(0,0,0,0.34)] disabled:shadow-none"
        >
          就按这张
        </button>
      </div>
    </div>
  );
}

export const AgentAnchorCard = memo(AgentAnchorCardComponent);
