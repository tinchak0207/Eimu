"use client";

// 赏阅 · 合集适配器：专辑 / 资产包 / 候选 best-of-N。成员可为任意种类。
// 诚实：封面只用成员自己的 cover（图类成员可用自身 url）；没有就文字卡，绝不拿别的成员的图占位。
// 键盘：方向键移动焦点（←→ ±1，↑↓ 按列数）、Home/End、Enter 打开成员（onOpenChild）、F 标记当前成员。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutGrid, List } from "lucide-react";
import type { ViewAsset, ViewKind, ViewerController, ViewerSurfaceProps } from "@/lib/viewer/types";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<ViewKind, string> = {
  image: "图",
  video: "视频",
  audio: "音乐",
  text: "文本",
  scene3d: "3D",
  document: "文档",
  storyboard: "分镜",
  collection: "合集",
};

function coverOf(m: ViewAsset): string | undefined {
  if (m.cover) return m.cover;
  if (m.kind === "image") return m.url;
  return undefined;
}

function memberLabel(m: ViewAsset, i: number): string {
  const title = m.title?.trim();
  const base = `第${i + 1}件${title ? ` ${title}` : ""}`;
  return m.provenance?.take != null ? `${base}（第${m.provenance.take}个候选）` : base;
}

function textPreview(m: ViewAsset): string {
  const t = m.title?.trim();
  if (t) return t;
  if (m.kind === "text" && m.text) return m.text.replace(/\s+/g, " ").trim().slice(0, 60);
  return KIND_LABEL[m.kind];
}

export default function CollectionSurface({
  asset,
  density,
  annotations,
  controllerRef,
  onRequestMark,
  active,
  onOpenChild,
}: ViewerSurfaceProps) {
  const full = density === "full";
  const members = useMemo(() => asset.children ?? [], [asset.children]);
  const n = members.length;
  const [view, setView] = useState<"grid" | "list">("grid");
  const [focusIdx, setFocusIdx] = useState(0);
  const focusRef = useRef(0);
  focusRef.current = focusIdx;
  const membersRef = useRef(members);
  membersRef.current = members;
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller: ViewerController = {
      capture() {
        const i = focusRef.current;
        const m = membersRef.current[i];
        return { locator: { t: "whole" }, ...(m ? { excerpt: memberLabel(m, i) } : {}) };
      },
      reveal(locator) {
        void locator; // 合集无位置语义
      },
    };
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef]);

  useEffect(() => {
    if (focusIdx > Math.max(0, n - 1)) setFocusIdx(Math.max(0, n - 1));
  }, [n, focusIdx]);

  const markedMembers = useMemo(() => {
    const s = new Set<number>();
    for (const a of annotations) {
      const m = a.excerpt?.match(/^第(\d+)件/);
      if (m) s.add(Number(m[1]) - 1);
    }
    return s;
  }, [annotations]);

  const kindSummary = useMemo(() => {
    const counts = new Map<ViewKind, number>();
    for (const m of members) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
    return [...counts.entries()].map(([k, c]) => `${c} ${KIND_LABEL[k]}`).join(" · ");
  }, [members]);

  const columns = useCallback((): number => {
    if (view === "list") return 1;
    const first = itemRefs.current[0];
    if (!first) return 1;
    let c = 0;
    for (const el of itemRefs.current) {
      if (el && el.offsetTop === first.offsetTop) c++;
      else if (el) break;
    }
    return Math.max(1, c);
  }, [view]);

  const moveFocus = useCallback(
    (to: number) => {
      if (n === 0) return;
      const i = Math.min(n - 1, Math.max(0, to));
      setFocusIdx(i);
      itemRefs.current[i]?.focus();
    },
    [n],
  );

  if (n === 0) {
    return (
      <div className="flex min-h-[200px] w-full items-center justify-center bg-[#0b0f14] p-6 text-[14px] text-white/70">
        这个合集还没有内容
      </div>
    );
  }

  return (
    <div className={cn("flex w-full flex-col bg-[#0b0f14] text-white", full ? "h-full min-h-[320px]" : "")}>
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-1.5">
        <span className="text-[14px] font-medium">共 {n} 件</span>
        {kindSummary && <span className="text-[13px] text-white/60">{kindSummary}</span>}
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="显示方式">
          <button
            type="button"
            onClick={() => setView("grid")}
            aria-pressed={view === "grid"}
            aria-label="网格"
            className={cn(
              "inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full",
              view === "grid" ? "bg-white/20" : "hover:bg-white/10",
            )}
          >
            <LayoutGrid className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setView("list")}
            aria-pressed={view === "list"}
            aria-label="列表"
            className={cn(
              "inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full",
              view === "list" ? "bg-white/20" : "hover:bg-white/10",
            )}
          >
            <List className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div
        ref={listRef}
        role="list"
        aria-label="合集成员"
        onKeyDown={(e) => {
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          const cols = columns();
          const handled: Record<string, number> = {
            ArrowLeft: focusIdx - 1,
            ArrowRight: focusIdx + 1,
            ArrowUp: focusIdx - cols,
            ArrowDown: focusIdx + cols,
            Home: 0,
            End: n - 1,
          };
          if (e.key in handled) {
            e.preventDefault();
            e.stopPropagation();
            moveFocus(handled[e.key]!);
          } else if (e.key === "f" || e.key === "F") {
            e.preventDefault();
            e.stopPropagation();
            onRequestMark();
          }
        }}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto p-3",
          view === "grid"
            ? cn("grid gap-3", full ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" : "grid-cols-2 sm:grid-cols-3")
            : "flex flex-col gap-2",
        )}
        style={active ? undefined : { visibility: "hidden" }}
      >
        {members.map((m, i) => {
          const cover = coverOf(m);
          const take = m.provenance?.take;
          return (
            <div key={m.id} role="listitem" className="relative">
              <button
                type="button"
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                tabIndex={i === focusIdx ? 0 : -1}
                onFocus={() => setFocusIdx(i)}
                onClick={() => onOpenChild?.(m)}
                aria-label={`打开${memberLabel(m, i)}，${KIND_LABEL[m.kind]}`}
                className={cn(
                  "w-full overflow-hidden rounded-lg text-left ring-1 ring-white/15 transition hover:ring-white/50 focus-visible:ring-2 focus-visible:ring-white",
                  view === "list" ? "flex min-h-[64px] items-stretch gap-3" : "block",
                )}
              >
                <span
                  className={cn(
                    "relative block shrink-0 bg-black",
                    view === "list" ? "aspect-video w-28" : "aspect-video w-full",
                  )}
                >
                  {cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={cover} alt="" loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center bg-white/5 px-2 text-center text-[13px] leading-snug text-white/70">
                      <span className="line-clamp-3">{textPreview(m)}</span>
                    </span>
                  )}
                  <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 text-[13px] leading-5">
                    {KIND_LABEL[m.kind]}
                  </span>
                  {markedMembers.has(i) && (
                    <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-amber-400" aria-label="已有标记" />
                  )}
                </span>
                <span className={cn("min-w-0 px-2 py-1.5", view === "list" ? "flex flex-1 flex-col justify-center" : "block")}>
                  <span className="block truncate text-[14px]">{m.title?.trim() || `第 ${i + 1} 件`}</span>
                  {take != null && <span className="block text-[13px] text-white/60">第 {take} 个候选</span>}
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setFocusIdx(i);
                  focusRef.current = i;
                  onRequestMark();
                }}
                aria-label={`标记${memberLabel(m, i)}`}
                className="absolute bottom-1 right-1 inline-flex min-h-[44px] items-center rounded-full bg-black/60 px-3 text-[13px] text-white hover:bg-black/80"
              >
                标记
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
