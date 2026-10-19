"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Brain, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentPlanItem } from "@/lib/agent-chat-types";

export interface AgentPlanCardProps {
  item: AgentPlanItem;
}

/** 收合时的正文预览字数（展开钮之外的全部内容都要一眼扫完）。 */
const COLLAPSED_PREVIEW_CHARS = 40;

/**
 * 本轮计画卡（turn.plan）——独立的「计划」区块，不并进任何 assistant 气泡。
 *
 * 生命周期：计画帧在送讯后 ~1.4–2.0s 就到（比首行正文快两个数量级），初始展开
 * 让使用者立刻知道助手打算做什么；第一条 message.delta 到达时 reducer 会把
 * `item.collapsed` 翻成 true，本卡据此自动收合成一行。**但使用者手动 toggle 过
 * 一次之后，任何自动收合都不再改它**（manualRef 是唯一煞车，先例＝
 * AgentMessageBubble 的 reasoningOpen：「手动收合优先于任何自动行为」）。
 *
 * 手动态用 ref 记录而不是 state：它不参与渲染，只影响 effect 要不要放行；
 * 用 state 会让每次 toggle 多一轮渲染，而且会与受控 open 打架。
 *
 * 结构上刻意不使用 <summary> 内嵌按钮的 details 方案（复制钮那种），改用单一
 * <button> 当唯一开关：全站已有一条「元件内禁止 <button> 嵌 <button>」的硬断言
 * （agent-chat-ui.test.ts 的 hasNestedButtons），这张卡不制造第二颗。
 *
 * 2026-09-20 项目负责人细化裁定：
 *   ①「临时」进行中标记拔掉（provisional 旗标不再渲染，资料层原样保留）；
 *   ②正文不再另起宽块（旧版视觉上从中间开始），改与「计划」标签同行排——
 *     正文从标签紧邻右边开始，多行时在剩余宽度内折行；
 *   ③「计划」字级对齐子代理卡标签（ios-footnote / font-medium / foreground-80）。
 */
function AgentPlanCardComponent({ item }: AgentPlanCardProps) {
  // open 受控：初值由 item.collapsed 给（新卡＝展开）；之后自动收合／使用者 toggle
  // 都只透过 setOpen 回写，父层 re-render 不会把它打回展开。
  const [open, setOpen] = useState(!item.collapsed);
  const manualRef = useRef(false);
  const prevCollapsedRef = useRef(item.collapsed);

  useEffect(() => {
    const was = prevCollapsedRef.current;
    prevCollapsedRef.current = item.collapsed;
    // 使用者动过就永不再自动改（手动展开的计画不因首行正文到达而被吃掉）。
    if (manualRef.current) return;
    // 只认 false → true 这条边：true → undefined / true → false 都不是「正文来了」。
    if (was !== true && item.collapsed === true) setOpen(false);
  }, [item.collapsed]);

  const experts = item.experts ?? [];
  const collapsedPreview = `${item.text.slice(0, COLLAPSED_PREVIEW_CHARS)}…`;

  return (
    <div className="agent-rise flex w-full flex-col">
      {/* 工具行式折叠头（agent-chat-preview 已批准语汇）：无底色 header 行；
          正文与标签同行排（2026-09-20 细化裁定），ChevronDown 指示开合。 */}
      <button
        type="button"
        onClick={() => {
          manualRef.current = true;
          setOpen((prev) => !prev);
        }}
        aria-expanded={open}
        className="flex min-h-11 w-full -mx-1 items-start gap-2.5 rounded-[18px] px-1 py-[7px] text-left transition-colors hover:bg-black/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]"
      >
        <Brain className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        {/* 右侧栏＝两列栅格（09-20 对齐根治，取代 absolute+pl 手调魔法数字）：
            col1 标签 auto、col2 正文 minmax(0,1fr)，`items-baseline` 让「计划」与
            正文首行共用基线（13px 对 15px 不再各自为政）；正文换行与首行严格同 x
            （栅格列边界天然对齐，旧 absolute 版换行会窜到标签底下的错觉来自行高差）。
            专家晶片放 col2 第二列，与正文左缘对齐。 */}
        <span className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2.5">
          {/* 标签：字级/字重/色对齐子代理卡（ios-footnote font-medium foreground/80）。 */}
          <span className="text-ios-footnote font-medium text-foreground/80">计划</span>
          {/* 收合预览与展开正文同字级同行高（ios-subhead/1.55）——切换时只有文字
              长短变化、零字体跳变（旧版 13px 灰预览↔15px 黑正文＝每次收合都重排）。 */}
          {open ? (
            <span className="break-words whitespace-pre-wrap text-ios-subhead leading-[1.55] text-foreground [overflow-wrap:anywhere]">
              {item.text}
            </span>
          ) : (
            <span className="truncate text-ios-subhead leading-[1.55] text-foreground/50">
              {collapsedPreview}
            </span>
          )}
          {/* 专家晶片：唯读，缺席就不画（网关只在 digest 白名单命中时才带 experts）。
              刻意不是按钮——这不是可点的操作，只是「这轮会派谁」的事实陈列。 */}
          {open && experts.length > 0 && (
            <span className="col-start-2 mt-1.5 flex flex-wrap gap-1.5">
              {experts.map((expert) => (
                <span
                  key={expert}
                  className="inline-flex min-w-0 max-w-full items-center rounded-full bg-black/[0.05] px-2 py-0.5 text-ios-footnote text-muted-foreground [overflow-wrap:anywhere]"
                >
                  {expert}
                </span>
              ))}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn("mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

export const AgentPlanCard = memo(AgentPlanCardComponent);
