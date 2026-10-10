"use client";

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bot, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentSubagentItem, AgentSubagentToolEntry } from "@/lib/agent-chat-types";
import { AGENT_TASK_STATUS_TABLE } from "@/lib/agent-task-status";
import { toolDisplayName } from "./AgentToolCard";

// 子代理状态栏（罪状 4）：subagent.started/delta/done 的可视化。
// 不进消息流——置顶堆叠在转录区上方（AgentBatchProgress 旁）。0921 契约：
// turn.done 收尾**不清 running 条目**（异步子代理跨回合在跑，终态由
// subagent.done 独占裁决），所以回合结束后在跑的子任务照常渲染在此，
// 本组件不看 turnActive、也不该看。
// 2026-09-20 暴君裁定（Grok 级无底色细行）：「查看全部 N 个子任务」折叠头改
//   「派出 N 个子代理」，展开后每行同工具行风格（无卡壳）＋右端状态词与 6px 圆点。
// 2026-09-19 暴君裁定（子任务 UI 去重）：
//   折叠头放到列表上方，置顶三卡＋弹出面板两套重复 UI 合并为一份内联列表；
//   可收合（SubagentMenu 弹层整体下线）；G3 R2 起默认折叠降噪。
// 2026-09-10 暴君裁定（子任务卡视觉迭代）：
//   running 态的末行摘要换跑马灯（marquee）——流式吐字观感＝快。

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

// 行尾状态词（2026-09-20 对版预览）：与工具行同一套字面——用户看到的
// 是「运行中…／完成／失败」，不是工单状态「已完成」。
// 字面以 AgentToolCard 的状态词（STATUS_META）为单一真源；此处仅镜射。
const STATUS_WORD: Record<AgentSubagentItem["status"], string> = {
  running: "运行中…",
  ok: "完成",
  error: "失败",
  stopped: "已停止",
};

// 状态词着色：运行＝ios-blue，其余灰；只有失败用红（色彩纪律：红仅失败）。
const STATUS_WORD_TONE: Record<AgentSubagentItem["status"], string> = {
  running: "text-ios-blue",
  ok: "text-foreground/45",
  error: "text-ios-red",
  stopped: "text-foreground/45",
};

// 子代理工具活动细行（2026-10-05 subagent.tool 帧）：沿用本档色彩纪律——
// 状态点与状态词同款字面（运行中…／完成／失败），点比父行（1.5）小一档以体现层级。
const TOOL_STATUS_DOT: Record<AgentSubagentToolEntry["status"], string> = {
  running: "bg-ios-blue",
  ok: "bg-foreground/40",
  failed: "bg-ios-red",
};

const TOOL_STATUS_WORD: Record<AgentSubagentToolEntry["status"], string> = {
  running: "运行中…",
  ok: "完成",
  failed: "失败",
};

const TOOL_STATUS_WORD_TONE: Record<AgentSubagentToolEntry["status"], string> = {
  running: "text-ios-blue",
  ok: "text-foreground/45",
  failed: "text-ios-red",
};

/**
 * DOM 上限（字元）：内容超过 HARD_CAP 才整块裁到 KEEP 字（见 marqueeText）。
 * 为什么是「整块裁」而不是「尾段窗」：尾段窗等于每次更新都把一个全新的字串塞进
 * DOM（换行压平后的尾段 + 前缀省略号），使用者看到的是一次次「整行清掉重填」。
 * 整块裁只在跨越门槛的那一刻发生一次，两次裁之间内容只追加、不替换。
 */
export const MARQUEE_HARD_CAP = 6000;
export const MARQUEE_KEEP = 3000;

/**
 * 跑马灯文字（纯函数，可测）：换行／连续空白压成单一空格、去前后空白（「一直在吐」
 * 是连续的，不因换行整行跳掉）；只有长度 > MARQUEE_HARD_CAP 时才一次裁到最后
 * MARQUEE_KEEP 字。**不补任何省略号**——使用者要的是「最左边的拿走」，省略号只是
 * 占位；左缘渐隐遮罩负责暗示「左边还有」。
 */
export function marqueeText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MARQUEE_HARD_CAP) return flat;
  return flat.slice(-MARQUEE_KEEP);
}

/**
 * 跑马灯末行：running 态专用。**逐字滑窗**——内容是单一 nowrap 文字节点、只追加
 * 不替换；每次更新后把 scrollLeft 立即钉到最右（useLayoutEffect，无 rAF／无插值／
 * 无平滑滚动）。于是「每多一个字」自然就是「最左边被挤出去、最新的补进来」——
 * 这是浏览器排版的自然结果，不需要我们做动画（做动画反而与文字增长两套运动打架，
 * 看起来就像「满了就整行清掉」）。
 * 内容不足一屏时 scrollWidth - clientWidth = 0 → scrollLeft 恒为 0＝静态，
 * 文字自然从左往右长；满了才开始滑窗。
 * 量测用的 scroller／track 两个节点**恒常挂载**（只有一条渲染路径）。
 */
function MarqueeLine({ text }: { text: string }) {
  const scrollerRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const content = marqueeText(text);

  // 量测：两个 ref 都挂在无条件渲染的节点上，内容或容器尺寸变动即重测。
  // 只决定左缘渐隐遮罩要不要出现，不参与滚动。
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

  // 逐字滑窗：内容进 DOM 的那一刻（layout 之前）就把视窗钉到最右。
  // 直接赋值是刻意的：不做插值、不做 transition——两套运动叠加就是「满了整行清掉」的病根。
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth;
  }, [content, overflowing]);

  return (
    <span ref={scrollerRef} className="relative min-w-0 flex-1 overflow-hidden">
      {/* 渐隐遮罩放左缘：尾部跟随下最新字钉在右缘，左缘才是旧字滚出去的地方
          （遮罩摆右缘等于罩住最新字，语义相反）。 */}
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

/**
 * 子代理工具活动区（2026-10-05）：只在子代理运行中渲染，让用户看到「它在跑什么」。
 * 可见行 = 所有 running 条目；一条都没有时取最后一条 settled（「刚做完 X，正在想」）。
 * 行数上限 3，避免长卡；不发明「还有 N 条」这类控件。
 */
function SubagentToolLines({ entries }: { entries: AgentSubagentToolEntry[] }) {
  const running = entries.filter((t) => t.status === "running");
  const visible = (running.length > 0 ? running : entries.slice(-1)).slice(0, 3);
  if (visible.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 pb-1 pl-7">
      {visible.map((t) => (
        <div key={t.callId} className="flex min-w-0 items-center gap-1.5 text-ios-footnote text-muted-foreground">
          <span className={cn("h-1 w-1 shrink-0 rounded-full", TOOL_STATUS_DOT[t.status])} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{toolDisplayName(t.tool)}</span>
          <span className={cn("shrink-0 whitespace-nowrap", TOOL_STATUS_WORD_TONE[t.status])}>
            {TOOL_STATUS_WORD[t.status]}
          </span>
        </div>
      ))}
    </div>
  );
}

function SubagentCard({ item }: SubagentCardProps) {
  return (
    <div className="flex min-w-0 w-full flex-col">
      <div className="agent-rise flex min-h-11 min-w-0 w-full items-center gap-2 rounded-[12px] px-2 -mx-2 transition-colors hover:bg-white/55">
        <Bot className="h-4 w-4 shrink-0 text-foreground/40" aria-hidden="true" />
        {/* 标签（闸道给的短标签）：旧写法 shrink-0 没有任何宽度上限＝长标签
           既不缩也不截，直接把整行撑出面板宽度（2026-09-20 根因清剿）。
            这里刻意用「让位 + 换行」而不是省略号：running 行的活动流必须是
            完整逐字滑窗（测试钉著 running 标记不得出现省略号截断），标签若也走
            截断语汇会与活动流的「全文可见」语义打架；max-w-[45%] + min-w-0 +
            overflow-wrap:anywhere 保证它永远不会撑破宽度。 */}
        <span className="min-w-0 max-w-[45%] text-ios-footnote font-medium text-foreground/80 [overflow-wrap:anywhere]">
          {item.label}
        </span>
        {/* running：跑马灯末行（活动流＝含 reasoning 的所有增量，尾巴跟随快吐字观感）；
            settled：静态摘要。 */}
        {item.status === "running" ? (
          <MarqueeLine text={item.activity || item.text || item.lastLine || "正在输出…"} />
        ) : (
          <span className="min-w-0 flex-1 truncate text-ios-footnote text-muted-foreground [overflow-wrap:anywhere]">
            {item.summary ?? item.lastLine}
          </span>
        )}
        {/* 状态词（无胶囊）：whitespace-nowrap 保证不被长工具名挤出行
            （工具名那一侧自己 truncate 让位）。 */}
        <span
          className={cn(
            "shrink-0 whitespace-nowrap text-ios-footnote tabular-nums",
            STATUS_WORD_TONE[item.status],
          )}
        >
          {STATUS_WORD[item.status]}
        </span>
        {/* 状态点即语义（6px 圆点）：颜色 + aria-label，不靠颜色单独传达。 */}
        <span
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[item.status])}
          aria-label={STATUS_LABEL[item.status]}
        />
      </div>
      {item.status === "running" && <SubagentToolLines entries={item.tools ?? []} />}
    </div>
  );
}

function AgentSubagentBarComponent({
  items,
  initialOpen = false,
}: {
  items: AgentSubagentItem[];
  /** 测试／调试可强制初开；生产默认折叠（G3 R2 降噪）。 */
  initialOpen?: boolean;
}) {
  // G3（2026-10-10）：默认折叠——用户默认面靠 turn.status「进行中／本路刚完成」，
  // 展开才见跑马灯细节；手动展开优先于任何自动行为（新 started 不把收起的摊回去）。
  const [open, setOpen] = useState(initialOpen);
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
