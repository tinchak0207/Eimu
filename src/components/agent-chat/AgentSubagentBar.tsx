"use client";

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bot, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentSubagentItem } from "@/lib/agent-chat-types";
import { AGENT_TASK_STATUS_TABLE } from "@/lib/agent-task-status";

// 子代理状态栏（罪状 4）：subagent.started/delta/done 的可视化。
// 不进消息流——置顶堆叠在转录区上方（AgentBatchProgress 旁），turn.done 时
// reducer 已把 subagent 条目整批清掉，这里只负责「还看得见」的那几行。
// 2026-09-20 暴君裁定（Grok 级无底色细行）：「查看全部 N 个子任务」折叠头改
//   「派出 N 个子代理」，展开后每行同工具行风格（无卡壳）＋右端 6px 圆点状态。
// 2026-09-19 暴君裁定（子任务 UI 去重）：
//   折叠头放到列表上方，置顶三卡＋弹出面板两套重复 UI 合并为一份内联列表；
//   默认展开、可收合（SubagentMenu 弹层整体下线）。
// 2026-09-10 暴君裁定（子任务卡視覺迭代）：
//   running 態的末行摘要換跑馬燈（marquee）——流式吐字觀感＝快。

// 状态标签查 agent-task-status.ts 单一语义表（ok=已完成、error=失败，都是
// 语义表的权威值，不再本地字面维护）；圆点着色是本行的展示层，留在这里。
// 色彩纪律（0920）：ios-blue＝运行、深灰＝完成、灰＝停止/等待、红＝失败。
const STATUS_DOT: Record<AgentSubagentItem["status"], string> = {
  running: "bg-ios-blue",
  ok: "bg-foreground/60",
  error: "bg-ios-red",
  // 人工停止成功＝中性灰，不是失败（0920 款定）。
  stopped: "bg-muted-foreground",
};

const STATUS_LABEL: Record<AgentSubagentItem["status"], string> = {
  running: AGENT_TASK_STATUS_TABLE.running.label,
  ok: AGENT_TASK_STATUS_TABLE.ok.label,
  error: AGENT_TASK_STATUS_TABLE.error.label,
  stopped: AGENT_TASK_STATUS_TABLE.stopped.label,
};

/**
 * DOM 上限（字元）：內容超過 HARD_CAP 才整塊裁到 KEEP 字（見 marqueeText）。
 * 為什麼是「整塊裁」而不是「尾段窗」：尾段窗等於每次更新都把一個全新的字串塞進
 * DOM（換行壓平後的尾段 + 前綴省略號），使用者看到的是一次次「整行清掉重填」。
 * 整塊裁只在跨越門檻的那一刻發生一次，兩次裁之間內容只追加、不替換。
 */
export const MARQUEE_HARD_CAP = 6000;
export const MARQUEE_KEEP = 3000;

/**
 * 跑馬燈文字（純函數，可測）：換行／連續空白壓成單一空格、去前後空白（「一直在吐」
 * 是連續的，不因換行整行跳掉）；只有長度 > MARQUEE_HARD_CAP 時才一次裁到最後
 * MARQUEE_KEEP 字。**不補任何省略號**——使用者要的是「最左邊的拿走」，省略號只是
 * 佔位；左緣漸隱遮罩負責暗示「左邊還有」。
 */
export function marqueeText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MARQUEE_HARD_CAP) return flat;
  return flat.slice(-MARQUEE_KEEP);
}

/**
 * 跑馬燈末行：running 態專用。**逐字滑窗**——內容是單一 nowrap 文字節點、只追加
 * 不替換；每次更新後把 scrollLeft 立即釘到最右（useLayoutEffect，無 rAF／無插值／
 * 無平滑滾動）。於是「每多一個字」自然就是「最左邊被擠出去、最新的補進來」——
 * 這是瀏覽器排版的自然結果，不需要我們做動畫（做動畫反而與文字增長兩套運動打架，
 * 看起來就像「滿了就整行清掉」）。
 * 內容不足一屏時 scrollWidth - clientWidth = 0 → scrollLeft 恆為 0＝靜態，
 * 文字自然從左往右長；滿了才開始滑窗。
 * 量測用的 scroller／track 兩個節點**恆常掛載**（只有一條渲染路徑）。
 */
function MarqueeLine({ text }: { text: string }) {
  const scrollerRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const content = marqueeText(text);

  // 量測：兩個 ref 都掛在無條件渲染的節點上，內容或容器尺寸變動即重測。
  // 只決定左緣漸隱遮罩要不要出現，不參與滾動。
  useEffect(() => {
    const scroller = scrollerRef.current;
    const track = trackRef.current;
    if (!scroller || !track) return;
    const measure = () => setOverflowing(track.scrollWidth > scroller.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    ro.observe(track);
    return () => ro.disconnect();
  }, [content]);

  // 逐字滑窗：內容進 DOM 的那一刻（layout 之前）就把視窗釘到最右。
  // 直接賦值是刻意的：不做插值、不做 transition——兩套運動疊加就是「滿了整行清掉」的病根。
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth;
  }, [content, overflowing]);

  return (
    <span ref={scrollerRef} className="relative min-w-0 flex-1 overflow-hidden">
      {/* 漸隱遮罩放左緣：尾部跟隨下最新字釘在右緣，左緣才是舊字滾出去的地方
          （遮罩擺右緣等於罩住最新字，語義相反）。 */}
      {overflowing && (
        <span className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-[rgba(120,120,128,0.06)] to-transparent" aria-hidden="true" />
      )}
      <span ref={trackRef} className="inline-block w-max whitespace-nowrap text-ios-footnote text-muted-foreground">
        {content}
      </span>
    </span>
  );
}

interface SubagentCardProps {
  item: AgentSubagentItem;
}

function SubagentCard({ item }: SubagentCardProps) {
  return (
    <div className="agent-rise flex min-h-11 w-full items-center gap-2 rounded-[12px] px-2 -mx-2 transition-colors hover:bg-white/55">
      <Bot className="h-4 w-4 shrink-0 text-foreground/40" aria-hidden="true" />
      <span className="shrink-0 text-ios-footnote font-medium text-foreground/80">
        {item.label}
      </span>
      {/* running：跑馬燈末行（活動流＝含 reasoning 的所有增量，尾巴跟隨快吐字觀感）；
          settled：靜態摘要。 */}
      {item.status === "running" ? (
        <MarqueeLine text={item.activity || item.text || item.lastLine || "正在输出…"} />
      ) : (
        <span className="min-w-0 flex-1 truncate text-ios-footnote text-muted-foreground [overflow-wrap:anywhere]">
          {item.summary ?? item.lastLine}
        </span>
      )}
      {/* 状态点即语义（6px 圆点）：颜色 + aria-label，不靠颜色单独传达。 */}
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[item.status])}
        aria-label={STATUS_LABEL[item.status]}
      />
    </div>
  );
}

function AgentSubagentBarComponent({ items }: { items: AgentSubagentItem[] }) {
  // 默认展开：子任务在跑时用户要看的就是这份列表；收合由折叠头手动控制，
  // 手动收合优先于任何自动行为（新一轮 subagent.started 不把收起的列表摊回去）。
  const [open, setOpen] = useState(true);
  if (items.length === 0) return null;

  return (
    <div className="relative flex flex-col gap-0.5" role="status" aria-label="子任务进度">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-11 w-fit cursor-pointer touch-manipulation items-center gap-1.5 rounded-[12px] px-2 -mx-2 text-left text-ios-footnote font-medium text-muted-foreground transition-colors hover:bg-white/55 hover:text-foreground/70 select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 [-webkit-tap-highlight-color:transparent]"
      >
        <Bot className="h-3.5 w-3.5 shrink-0 text-foreground/40" aria-hidden="true" />
        派出 {items.length} 个子代理
        <ChevronDown
          className={cn("lg-transition h-3.5 w-3.5 shrink-0 text-foreground/45", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open && items.map((item) => (
        <SubagentCard key={item.id} item={item} />
      ))}
    </div>
  );
}

export const AgentSubagentBar = memo(AgentSubagentBarComponent);
