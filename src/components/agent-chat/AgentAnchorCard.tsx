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
    <div className="agent-rise lg-sheet relative overflow-hidden rounded-ios-2xl p-3.5">
      {/* 顶缘 specular 亮线：玻璃面板上缘的一线高光，纯装饰不吃事件。 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80"
      />
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-muted-foreground">
          <Anchor className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-ios-subhead font-semibold text-foreground">
            第 {anchor.seq} 张出来了，就按这张的风格出完整批？
          </p>
          <p className="mt-0.5 text-sm leading-[1.55] text-muted-foreground">
            锚定后整批沿用同一套参数，第 100 张不会跟第 1 张跑偏。
          </p>
          {preview.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {preview.map((param) => (
                <li
                  key={param.key}
                  className="min-w-0 rounded-full bg-black/5 px-2.5 py-1 text-sm leading-[1.4] text-muted-foreground [overflow-wrap:anywhere] sm:max-w-[14rem] sm:truncate"
                  title={param.label + "：" + param.value}
                >
                  {param.label} {param.value}
                </li>
              ))}
              {rest > 0 && (
                <li className="rounded-full bg-black/5 px-2.5 py-1 text-sm leading-[1.4] text-muted-foreground">
                  另 {rest} 项
                </li>
              )}
            </ul>
          )}
          {/* 上游截断过就说出来：锚定可能锚不全，不让使用者以为万无一失。 */}
          {anchor.truncated && (
            <p className="mt-1.5 text-sm text-foreground/45">
              上游只回传了参数摘要，可能有参数锚不住
            </p>
          )}
        </div>
      </div>

      {/*
        窄屏：次按钮（不用了 / 换个方向）并排在上，主按钮「就按这张」整行垫底，
        紧贴输入区、拇指最顺；宽屏回到原来的右对齐一行。
      */}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
        <div className="flex w-full gap-2 sm:w-auto">
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            className="min-h-11 flex-1 cursor-pointer rounded-full px-4 text-sm font-medium text-muted-foreground transition-colors duration-150 active:bg-black/[0.07] active:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]"
          >
            不用了
          </button>
          <button
            type="button"
            onClick={onReanchor}
            disabled={busy}
            title="先只出 1 张换个方向，满意了再出整批"
            className="inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full bg-black/5 px-4 text-sm font-semibold text-muted-foreground transition-colors duration-150 active:bg-black/[0.09] active:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            换个方向
          </button>
        </div>
        {/* 预览主 CTA 语汇（agent-chat-preview 决策卡已批准）：深底实心 #2d3142
            + signature 阴影 + 悬浮微升，不再用 ios-blue 蓝底。 */}
        <button
          type="button"
          onClick={onAnchor}
          disabled={busy}
          title="把这张实际用过的参数念回给助理，整批照抄"
          className="inline-flex min-h-12 w-full cursor-pointer items-center justify-center gap-1.5 rounded-full bg-[#2d3142] px-5 text-ios-subhead font-semibold text-white shadow-[0_8px_20px_rgba(45,49,66,0.18)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-[#272b39] active:scale-[0.98] active:bg-[#272b39] focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20 disabled:cursor-not-allowed disabled:bg-black/[0.12] disabled:text-foreground/45 disabled:shadow-none disabled:active:scale-100 disabled:hover:translate-y-0 sm:w-auto [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]"
        >
          就按这张
        </button>
      </div>
    </div>
  );
}

export const AgentAnchorCard = memo(AgentAnchorCardComponent);
