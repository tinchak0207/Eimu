"use client";

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bot, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentSubagentItem } from "@/lib/agent-chat-types";

// 子代理状态栏（罪状 4）：subagent.started/delta/done 的可视化。
// 不进消息流——置顶堆叠在转录区上方（AgentBatchProgress 旁），turn.done 时
// reducer 已把 subagent 条目整批清掉，这里只负责「还看得见」的那几张卡。
// 2026-09-10 暴君裁定（子任务卡視覺迭代）：
//   ①running 態的末行摘要換跑馬燈（marquee）——流式吐字觀感＝快；
//   ②置頂卡暫時移除展開按鈕（ChevronDown/aria-expanded 整組下線，詳情面板
//     代碼保留但不再從置頂卡進入；「查看全部」面板暫保留唯一入口）。

/**
 * 可见卡选取（纯函数，node --test 可测）。至多 3 张：
 * running 的优先保留；超出名额时新出现的挤掉最旧的已完成项。
 * 返回顺序保持 transcript 原序，卡的位置不因完成而跳动。
 */
export function pickVisibleSubagents(items: AgentSubagentItem[], max: number = 3): AgentSubagentItem[] {
  const running: AgentSubagentItem[] = [];
  const settled: AgentSubagentItem[] = [];
  for (const it of items) {
    if (it.status === "running") running.push(it);
    else settled.push(it);
  }
  // running 超额：保最新的 max 张（旧的 running 也让位给新的）。
  const keptRunning = running.length > max ? running.slice(running.length - max) : running;
  const remaining = max - keptRunning.length;
  const keptSettled = remaining > 0 ? settled.slice(settled.length - remaining) : [];
  const keptIds = new Set([...keptRunning, ...keptSettled].map((it) => it.id));
  return items.filter((it) => keptIds.has(it.id));
}

const STATUS_DOT: Record<AgentSubagentItem["status"], string> = {
  running: "bg-ios-orange animate-pulse",
  ok: "bg-ios-green",
  error: "bg-destructive",
};

const STATUS_LABEL: Record<AgentSubagentItem["status"], string> = {
  running: "运行中",
  ok: "已完成",
  error: "失败",
};

const STATUS_BADGE: Record<AgentSubagentItem["status"], string> = {
  running: "lg-tint-blue text-ios-blue",
  ok: "lg-tint-green text-[#248A3D]",
  error: "lg-tint-red text-destructive",
};

/** 详情正文：收尾取摘要、进行中取串流全文，都没有就诚实说没有。 */
function detailText(item: AgentSubagentItem): string {
  // F4：展开区给全文（text），不再只有末行/摘要——长产出不再硬切到一行。
  if (item.status === "running") return item.text || item.lastLine || "尚无输出";
  return item.summary || item.text || item.lastLine || "尚无输出";
}

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
    <div className="agent-rise flex w-full items-center gap-2 rounded-[16px] bg-[rgba(120,120,128,0.06)] px-3 py-2">
      <Bot className="h-3.5 w-3.5 shrink-0 text-foreground/40" aria-hidden="true" />
      {/* 状态点即语义：颜色 + aria-label，不靠颜色单独传达。 */}
      <span
        className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_DOT[item.status])}
        aria-label={STATUS_LABEL[item.status]}
      />
      <span className="shrink-0 text-ios-footnote font-semibold text-foreground">
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
      <span
        className={cn(
          "inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
          STATUS_BADGE[item.status],
        )}
      >
        {STATUS_LABEL[item.status]}
      </span>
    </div>
  );
}

interface SubagentMenuProps {
  items: AgentSubagentItem[];
  onClose: () => void;
}

/** 「查看全部」面板：lg-sheet 小卡，定位写法与设置/历史 dropdown 一致。 */
function SubagentMenu({ items, onClose }: SubagentMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const runningCount = items.filter((it) => it.status === "running").length;

  return (
    <div ref={rootRef} className="absolute inset-x-0 top-full z-50 mt-1.5">
      {/* 底色比标准 lg-sheet 提高不透明度（0.82→0.94）：本面板罩在转录区的
          饱和蓝用户气泡上，0.82 白 + saturate(200%) 会被采样成整片蓝染。 */}
      <div className="lg-sheet agent-rise rounded-ios-2xl p-1" style={{ background: "rgba(255,255,255,0.94)" }}>
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
        <div className="flex items-center justify-between px-2.5 pb-1.5 pt-2">
          <span className="text-ios-footnote font-semibold text-foreground">
            子任务{items.length > 0 && <span className="ml-1.5 font-normal text-muted-foreground">{items.length} 个 · 运行中 {runningCount}</span>}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭子任务面板"
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-foreground/40 transition-colors hover:bg-black/5 hover:text-foreground/75 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        <div className="max-h-80 divide-y divide-black/[0.06] overflow-y-auto overscroll-contain">
          {items.map((item) => {
            const open = openId === item.id;
            return (
              <div key={item.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : item.id)}
                  aria-expanded={open}
                  className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-black/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ios-blue/30"
                >
                  <span
                    className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_DOT[item.status])}
                    aria-label={STATUS_LABEL[item.status]}
                  />
                  <span className="min-w-0 flex-1 truncate text-ios-footnote font-medium text-foreground">
                    {item.label}
                  </span>
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
                      STATUS_BADGE[item.status],
                    )}
                  >
                    {STATUS_LABEL[item.status]}
                  </span>
                  <ChevronDown
                    className={cn("h-3 w-3 shrink-0 text-foreground/30 transition-transform duration-300 ease-ios-spring", open && "rotate-180")}
                    aria-hidden="true"
                  />
                </button>
                {open && (
                  <p className="whitespace-pre-wrap break-words px-2.5 pb-2.5 pt-0.5 text-ios-caption1 leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                    {detailText(item)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AgentSubagentBarComponent({ items }: { items: AgentSubagentItem[] }) {
  const visible = pickVisibleSubagents(items);
  const [menuOpen, setMenuOpen] = useState(false);
  if (items.length === 0) return null;

  return (
    <div className="relative flex flex-col gap-1.5" role="status" aria-label="子任务进度">
      {visible.map((item) => (
        <SubagentCard key={item.id} item={item} />
      ))}
      <button
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        aria-expanded={menuOpen}
        className={cn(
          "flex w-fit cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-ios-caption1 font-medium text-foreground/45 transition-colors hover:bg-black/5 hover:text-foreground/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30",
          menuOpen && "bg-black/5 text-foreground/70",
        )}
      >
        <Bot className="h-3 w-3" aria-hidden="true" />
        查看全部 {items.length} 个子任务
        <ChevronDown
          className={cn("h-3 w-3 transition-transform duration-300 ease-ios-spring", menuOpen && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {menuOpen && <SubagentMenu items={items} onClose={() => setMenuOpen(false)} />}
    </div>
  );
}

export const AgentSubagentBar = memo(AgentSubagentBarComponent);
