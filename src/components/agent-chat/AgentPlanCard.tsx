"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Brain, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentPlanItem } from "@/lib/agent-chat-types";

export interface AgentPlanCardProps {
  item: AgentPlanItem;
}

/** 收合時的正文預覽字數（展開鈕之外的全部內容都要一眼掃完）。 */
const COLLAPSED_PREVIEW_CHARS = 40;

/**
 * 本輪計畫卡（turn.plan）——獨立的「計划」區塊，不併進任何 assistant 氣泡。
 *
 * 生命週期：計畫幀在送訊後 ~1.4–2.0s 就到（比首行正文快兩個數量級），初始展開
 * 讓使用者立刻知道助手打算做什麼；第一條 message.delta 到達時 reducer 會把
 * `item.collapsed` 翻成 true，本卡據此自動收合成一行。**但使用者手動 toggle 過
 * 一次之後，任何自動收合都不再改它**（manualRef 是唯一煞車，先例＝
 * AgentMessageBubble 的 reasoningOpen：「手動收合優先於任何自動行為」）。
 *
 * 手動態用 ref 記錄而不是 state：它不參與渲染，只影響 effect 要不要放行；
 * 用 state 會讓每次 toggle 多一輪渲染，而且會與受控 open 打架。
 *
 * 結構上刻意不使用 <summary> 內嵌按鈕的 details 方案（複製鈕那種），改用單一
 * <button> 當唯一開關：全站已有一條「元件內禁止 <button> 嵌 <button>」的硬斷言
 * （agent-chat-ui.test.ts 的 hasNestedButtons），這張卡不製造第二顆。
 *
 * 2026-09-20 暴君細化裁定：
 *   ①「临时」進行中標記拔掉（provisional 旗標不再渲染，資料層原樣保留）；
 *   ②正文不再另起寬塊（舊版视觉上从中间开始），改與「计划」標籤同行排——
 *     正文從標籤緊鄰右邊開始，多行時在剩餘寬度內折行；
 *   ③「计划」字級對齊子代理卡標籤（ios-footnote / font-medium / foreground-80）。
 */
function AgentPlanCardComponent({ item }: AgentPlanCardProps) {
  // open 受控：初值由 item.collapsed 給（新卡＝展開）；之後自動收合／使用者 toggle
  // 都只透過 setOpen 回寫，父層 re-render 不會把它打回展開。
  const [open, setOpen] = useState(!item.collapsed);
  const manualRef = useRef(false);
  const prevCollapsedRef = useRef(item.collapsed);

  useEffect(() => {
    const was = prevCollapsedRef.current;
    prevCollapsedRef.current = item.collapsed;
    // 使用者動過就永不再自動改（手動展開的計畫不因首行正文到達而被吃掉）。
    if (manualRef.current) return;
    // 只認 false → true 這條邊：true → undefined / true → false 都不是「正文來了」。
    if (was !== true && item.collapsed === true) setOpen(false);
  }, [item.collapsed]);

  const experts = item.experts ?? [];
  const collapsedPreview = `${item.text.slice(0, COLLAPSED_PREVIEW_CHARS)}…`;

  return (
    <div className="agent-rise flex w-full flex-col">
      {/* 工具行式折疊頭（agent-chat-preview 已批准語彙）：無底色 header 行；
          正文與標籤同行排（2026-09-20 細化裁定），ChevronDown 指示開合。 */}
      <button
        type="button"
        onClick={() => {
          manualRef.current = true;
          setOpen((prev) => !prev);
        }}
        aria-expanded={open}
        className="flex min-h-11 w-full items-start gap-2.5 rounded-[18px] px-3 py-2.5 text-left transition-colors hover:bg-black/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]"
      >
        <Brain className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        {/* 右側欄＝兩列柵格（09-20 對齊根治，取代 absolute+pl 手調魔法數字）：
            col1 標籤 auto、col2 正文 minmax(0,1fr)，`items-baseline` 讓「计划」與
            正文首行共用基線（13px 對 15px 不再各自為政）；正文換行與首行嚴格同 x
            （柵格列邊界天然對齊，舊 absolute 版換行會竄到標籤底下的錯覺來自行高差）。
            專家晶片放 col2 第二列，與正文左緣對齊。 */}
        <span className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2.5">
          {/* 標籤：字級/字重/色對齊子代理卡（ios-footnote font-medium foreground/80）。 */}
          <span className="text-ios-footnote font-medium text-foreground/80">计划</span>
          {/* 收合預覽與展開正文同字級同行高（ios-subhead/1.55）——切換時只有文字
              長短變化、零字體跳變（舊版 13px 灰預覽↔15px 黑正文＝每次收合都重排）。 */}
          {open ? (
            <span className="break-words whitespace-pre-wrap text-ios-subhead leading-[1.55] text-foreground [overflow-wrap:anywhere]">
              {item.text}
            </span>
          ) : (
            <span className="truncate text-ios-subhead leading-[1.55] text-foreground/50">
              {collapsedPreview}
            </span>
          )}
          {/* 專家晶片：唯讀，缺席就不畫（網關只在 digest 白名單命中時才帶 experts）。
              刻意不是按鈕——這不是可點的操作，只是「這輪會派誰」的事實陳列。 */}
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
