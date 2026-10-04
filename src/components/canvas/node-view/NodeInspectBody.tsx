"use client";

// NodeInspectBody —— 语义缩放 LOD 3：卡片正文区放大后露出的「内部参数」（2026-10-01）。
//
// 不是另一张卡：标题列、类型色顶线、徽章、玻璃材质都沿用原卡；只有正文区换内容。
// 视觉词汇与 StoryboardShotBody 同源（段落眉标 11px uppercase tracking-[0.18em]、栏名 12px、值 13px、
// 蓝色胶囊），但字级用 em 绑在 .lod-inspect 的 font-size＝13px×(1/k) 上——萤幕上永远是 13px，
// 放大＝同一张卡在世界座标里装得下更多行（语义缩放）。HTML 文字会随画布停手后重新栅格化，不糊。
// 放不下的行数如实显示「还有 N 项 · 继续放大」。

import { useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Clapperboard, Cpu, FileText, History, PlugZap, SlidersHorizontal, Sparkles, Timer, Wrench, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InspectIcon, InspectRow, InspectSection } from "./node-inspect";

const ICON: Record<InspectIcon, LucideIcon> = {
  input: PlugZap,
  core: Cpu,
  prompt: Sparkles,
  params: SlidersHorizontal,
  task: Timer,
  versions: History,
  shot: Clapperboard,
  tool: Wrench,
  text: FileText,
};

function Row({ row, hideLabel = false }: { row: InspectRow; hideLabel?: boolean }) {
  if (row.kind === "chips") {
    return (
      <div data-inspect-row className="flex flex-wrap items-center gap-[0.3em]">
        <span className="w-[5.2em] shrink-0 text-[0.923em] font-medium text-muted-foreground">{row.label}</span>
        {row.items.map((item) => (
          <span key={item} className="rounded-full bg-ios-blue/10 px-[0.55em] py-[0.1em] font-mono text-[0.923em] text-ios-blue">
            {item}
          </span>
        ))}
      </div>
    );
  }
  if (row.kind === "text") {
    return (
      <div data-inspect-row className="space-y-[0.2em]">
        {!hideLabel && <span className="block text-[0.923em] font-medium leading-none text-muted-foreground">{row.label}</span>}
        <p
          className={cn(
            "whitespace-pre-wrap break-words leading-[1.55]",
            row.mono && "rounded-[0.6em] bg-black/[0.03] px-[0.6em] py-[0.45em] font-mono text-[0.923em]",
            row.tone === "error" ? "text-ios-red" : row.tone === "negative" ? "text-[#C0362C]/80" : "text-foreground",
          )}
        >
          {row.value}
        </p>
      </div>
    );
  }
  return (
    <div data-inspect-row className="flex items-baseline gap-[0.6em]">
      {!hideLabel && <span className="w-[5.2em] shrink-0 text-[0.923em] font-medium text-muted-foreground">{row.label}</span>}
      <span
        className={cn(
          "min-w-0 flex-1 break-all leading-[1.45]",
          row.mono && "font-mono",
          row.tone === "error" ? "text-ios-red" : row.tone === "accent" ? "font-semibold text-foreground" : "text-foreground",
        )}
      >
        {row.value}
      </span>
    </div>
  );
}

type FieldRow = Extract<InspectRow, { kind: "field" }>;
type Block = { kind: "grid"; rows: FieldRow[] } | { kind: "row"; row: InspectRow };

/** 相邻的短栏位（值 ≤ 18 字）并成一个网格块；长值与文字段保持整行。 */
function groupRows(rows: readonly InspectRow[]): Block[] {
  const blocks: Block[] = [];
  for (const row of rows) {
    const short = row.kind === "field" && [...row.value].length <= 18;
    const last = blocks[blocks.length - 1];
    if (short && last?.kind === "grid") last.rows.push(row as FieldRow);
    else if (short) blocks.push({ kind: "grid", rows: [row as FieldRow] });
    else blocks.push({ kind: "row", row });
  }
  return blocks;
}

export function NodeInspectBody({
  sections,
  zoomKey,
  onOpen,
}: {
  sections: InspectSection[];
  /** 量化后的缩放倍率：变了才重算「还有 N 项」。 */
  zoomKey: number;
  onOpen?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const limit = el.getBoundingClientRect().bottom - el.clientHeight * 0.14;
    let n = 0;
    el.querySelectorAll("[data-inspect-row]").forEach((row) => {
      if (row.getBoundingClientRect().bottom > limit) n += 1;
    });
    setHidden(n);
  }, [sections, zoomKey]);

  return (
    <div ref={ref} className="lod-inspect absolute inset-0 overflow-hidden px-[0.9em] pb-[2.4em] pt-[0.7em]">
      {/* 段落之间的导轨：一条细线把各段串起来（与透析面板同一语汇） */}
      <div className="pointer-events-none absolute bottom-[2.4em] left-[1.45em] top-[1.3em] w-px bg-gradient-to-b from-ios-blue/30 via-black/[0.08] to-transparent" aria-hidden="true" />
      <div className="space-y-[0.85em]">
        {sections.map((section) => {
          const Icon = ICON[section.icon];
          const only = section.rows.length === 1 ? section.rows[0] : null;
          // 单值段落：值直接接在段名后（「模型  seedream-4」），不再多占一行。
          const inline = only && only.kind === "field" ? only : null;
          const blocks = inline ? [] : groupRows(section.rows);
          return (
            <section key={section.key} className="relative space-y-[0.4em] pl-[1.55em]">
              <span className="absolute left-0 top-[0.05em] flex h-[1.15em] w-[1.15em] items-center justify-center rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">
                <Icon className="h-[0.7em] w-[0.7em] text-ios-blue" aria-hidden="true" />
              </span>
              {inline ? (
                <div data-inspect-row className="flex items-baseline gap-[0.6em]">
                  <span className="shrink-0 text-[0.846em] font-medium uppercase tracking-[0.18em] text-muted-foreground/70">{section.title}</span>
                  <span className={cn("min-w-0 break-all", inline.mono && "font-mono", inline.tone === "error" ? "text-ios-red" : "font-semibold text-foreground")}>
                    {inline.label !== section.title && <span className="mr-[0.4em] font-normal text-muted-foreground">{inline.label}</span>}
                    {inline.value}
                  </span>
                </div>
              ) : (
                <>
                  <span className="block text-[0.846em] font-medium uppercase leading-[1.4] tracking-[0.18em] text-muted-foreground/70">{section.title}</span>
                  {blocks.map((block, i) =>
                    block.kind === "grid" ? (
                      // 连续的短栏位排成网格（栏名在上、值在下），同一张卡放得下更多参数。
                      <div key={`${section.key}-g${i}`} className="grid gap-x-[0.9em] gap-y-[0.35em]" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(7.5em, 1fr))" }}>
                        {block.rows.map((row, j) => (
                          <div key={j} data-inspect-row className="min-w-0">
                            <span className="block text-[0.846em] font-medium leading-[1.3] text-muted-foreground">{row.label}</span>
                            <span className={cn("block break-all leading-[1.35]", row.mono && "font-mono", row.tone === "error" ? "text-ios-red" : row.tone === "accent" ? "font-semibold text-foreground" : "text-foreground")}>
                              {row.value}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <Row key={`${section.key}-${i}`} row={block.row} hideLabel={block.row.label === section.title} />
                    ),
                  )}
                </>
              )}
            </section>
          );
        })}
        {sections.length === 0 && <p className="text-muted-foreground">这个节点还没有可展示的参数</p>}
      </div>

      {/* 底部：溢出淡出＋如实计数＋透析入口 */}
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-[0.6em] bg-gradient-to-t from-white via-white/90 to-white/0 px-[0.9em] pb-[0.6em] pt-[1.6em]">
        <span className="text-[0.846em] text-muted-foreground">{hidden > 0 ? `还有 ${hidden} 项 · 继续放大查看` : ""}</span>
        {onOpen && (
          <button
            type="button"
            data-canvas-interactive
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className="inline-flex shrink-0 cursor-pointer items-center gap-[0.25em] rounded-full bg-ios-blue/10 px-[0.7em] py-[0.25em] text-[0.923em] font-medium text-ios-blue transition-colors duration-150 hover:bg-ios-blue/20"
          >
            透析
            <ArrowRight className="h-[0.85em] w-[0.85em]" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

