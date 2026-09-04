"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Bot, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentSubagentItem } from "@/lib/agent-chat-types";

// 子代理状态栏（罪状 4）：subagent.started/delta/done 的可视化。
// 不进消息流——置顶堆叠在转录区上方（AgentBatchProgress 旁），turn.done 时
// reducer 已把 subagent 条目整批清掉，这里只负责「还看得见」的那几张卡。
// R10 后新增：卡片可点开看详情（完整摘要），「查看全部」面板可管理本回合
// 的所有子任务（置顶卡裁到 3 张，面板不裁——查看权不因名额而丢）。

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
  const keptIds = new Set([...keptRunning, ...keptSettled]);
  return items.filter((it) => keptIds.has(it));
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

/** 详情正文：收尾取摘要，进行中取流式末行，都没有就诚实说没有。 */
function detailText(item: AgentSubagentItem): string {
  if (item.status === "running") return item.lastLine || "尚无输出";
  return item.summary ?? item.lastLine ?? "尚无输出";
}

function SubagentDetail({ item, open }: { item: AgentSubagentItem; open: boolean }) {
  return (
    <div
      className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-300 ease-ios-spring data-[open=true]:grid-rows-[1fr]"
      data-open={open}
    >
      <div className="min-h-0 overflow-hidden">
        <p className="whitespace-pre-wrap break-words px-0.5 pb-1 pt-1.5 text-ios-footnote leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {detailText(item)}
        </p>
      </div>
    </div>
  );
}

interface SubagentCardProps {
  item: AgentSubagentItem;
  expanded: boolean;
  onToggle: () => void;
}

function SubagentCard({ item, expanded, onToggle }: SubagentCardProps) {
  const detailId = `subagent-detail-${item.id}`;
  return (
    <div className="agent-rise rounded-[16px] bg-[rgba(120,120,128,0.06)] px-3 py-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={detailId}
        className="flex w-full cursor-pointer items-center gap-2 rounded-[10px] text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
      >
        <Bot className="h-3.5 w-3.5 shrink-0 text-foreground/40" aria-hidden="true" />
        {/* 状态点即语义：颜色 + aria-label，不靠颜色单独传达。 */}
        <span
          className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_DOT[item.status])}
          aria-label={STATUS_LABEL[item.status]}
        />
        <span className="shrink-0 text-ios-footnote font-semibold text-foreground">
          {item.label}
        </span>
        {/* 收起时给一行摘要预览；展开后正文区接手，这里淡出避免重复。 */}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-ios-footnote text-muted-foreground [overflow-wrap:anywhere] transition-opacity",
            expanded && "opacity-0",
          )}
        >
          {item.status === "running" ? item.lastLine : (item.summary ?? item.lastLine)}
        </span>
        <ChevronDown
          className={cn("h-3.5 w-3.5 shrink-0 text-foreground/35 transition-transform duration-300 ease-ios-spring", expanded && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      <div id={detailId}>
        <SubagentDetail item={item} open={expanded} />
      </div>
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  if (items.length === 0) return null;

  return (
    <div className="relative flex flex-col gap-1.5" role="status" aria-label="子任务进度">
      {visible.map((item) => (
        <SubagentCard
          key={item.id}
          item={item}
          expanded={expandedId === item.id}
          onToggle={() => setExpandedId((cur) => (cur === item.id ? null : item.id))}
        />
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
