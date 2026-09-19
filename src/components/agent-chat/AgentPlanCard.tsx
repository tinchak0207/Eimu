"use client";

import { memo, useEffect, useRef, useState } from "react";
import { ClipboardList } from "lucide-react";
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

  const provisional = item.provisional === true;
  const experts = item.experts ?? [];
  const collapsedPreview = `${item.text.slice(0, COLLAPSED_PREVIEW_CHARS)}…`;

  return (
    <div className="agent-rise flex w-full flex-col gap-2 rounded-[18px] bg-[rgba(120,120,128,0.06)] px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-muted-foreground">
          <ClipboardList className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <p className="text-ios-subhead font-semibold text-foreground">計划</p>
          {/* 進行中的標記：與工具卡 pending（生成中…）同源的金色 tint ——「任務已經
              開始、還沒定案」在全站是同一種顏色語言。 */}
          {provisional && (
            <span className="lg-tint-gold inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-ios-footnote font-semibold text-[rgba(120,90,20,0.85)]">
              （进行中）
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            manualRef.current = true;
            setOpen((prev) => !prev);
          }}
          aria-expanded={open}
          className="shrink-0 rounded-full px-2.5 py-1 text-ios-footnote font-medium text-ios-blue transition-colors hover:bg-black/[0.06] active:scale-95"
        >
          {open ? "收起" : "展开"}
        </button>
      </div>

      {/* 正文：≥13px（design-system/MASTER.md 硬規則），用 ios-subhead（15px）。
          收合時只給 40 字預覽 + 省略號——一行就要能掃完，展開才有全文。 */}
      <p
        className={cn(
          "break-words text-ios-subhead leading-[1.55] text-foreground [overflow-wrap:anywhere]",
          open ? undefined : "truncate text-muted-foreground",
        )}
      >
        {open ? item.text : collapsedPreview}
      </p>

      {/* 專家晶片：唯讀，缺席就不畫（網關只在 digest 白名單命中時才帶 experts）。
          刻意不是按鈕——這不是可點的操作，只是「這輪會派誰」的事實陳列。 */}
      {experts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {experts.map((expert) => (
            <span
              key={expert}
              className="inline-flex items-center rounded-full bg-black/[0.05] px-2 py-0.5 text-ios-footnote text-muted-foreground"
            >
              {expert}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export const AgentPlanCard = memo(AgentPlanCardComponent);
