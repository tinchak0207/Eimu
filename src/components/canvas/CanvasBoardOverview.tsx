"use client";

// CanvasBoardOverview —— 语义缩放 LOD 0「画布层」（2026-10-09）。
//
// 形态＝画布牌组：每个画布一格，横排于萤幕安全区（让出右侧缩放轨）。
// 视觉纪律（照 CanvasStageOverview）：单一强调色（ios-blue＝当前画布），其余中性；
// 不做水印大字、彩虹渐层、框中框。primary 用中性 token 标记（不发新色）。
// 格内容：画布标题（缺省「未命名画布」）＋真实进度（该画布 nodes → summarizeStages → overallProgress）
// ＋节点数＋待审数。当前画布高亮；活动画布的进度带 live 节点，其余画布懒取（进程内缓存）。
//
// 转场（k 是唯一真源，board 由宿主每帧传入＝lodBlend(k).board，可被滚轮「刷」、可逆）：
//   phase A（board 0→0.6）：格子以槽位中心为锚 scale 0.72→1 淡入（无世界质心可收束，故原地长出）。
//   phase B（board 0.6→1）：格子从缩到槽位尺寸并展开成完整卡（矩形插值＋easeOut），内容在 B 后半淡入。
// 与阶段层同构的两段式写法；画布带起点略高于 LOD0 进入门槛 ⇒ 换层瞬间 board≈0.43，
// 与阶段层不叠影（单挂载切换，同一时刻只有一层可见）且交接不落空。
// 窄萤幕（<768）纵排、直接淡入（不做 B 滑动）。
//
// 点一格：该格 scale 1.02＋描边 120ms → 宿主 switchCanvas(id)。
// 可点元素带 data-canvas-interactive，InfiniteCanvas 手势层放行。

import { useEffect, useState } from "react";
import { Check, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasNode } from "@/lib/canvas/types";
import { fetchCanvasProject } from "@/lib/canvas/client";
import {
  boardLayout,
  clamp01,
  easeOutCubic,
  overallProgress,
  summarizeStages,
  type CanvasStagePreview,
  type HudRect,
} from "@/lib/canvas/lod";
import type { ChatCanvasEntry } from "@/hooks/canvas/canvas-chat-types";

export interface CanvasBoardOverviewProps {
  /** 画布清单（P2-A 冻结接口 canvas.canvasList）。空＝不渲染。 */
  boards: ChatCanvasEntry[];
  /** lodBlend(k).board（未 ease 的原值）。0 ＝不渲染。 */
  board: number;
  /** 当前画布的活动节点（进度真源）。 */
  activeNodes: CanvasNode[];
  activeCanvasId: string | null;
  size: { width: number; height: number };
  /** 离散 LOD === 0：格子可点。 */
  interactive: boolean;
  /** ≥768px：横排＋两段式形变；否则纵排直接淡入。 */
  wide: boolean;
  reduceMotion?: boolean;
  /** 其它画布进度懒取完成后回写（宿主无需处理；此处仅内部重渲）。 */
  onSwitchCanvas: (canvasId: string) => void;
}

// ─────────────────────────────────────────── 懒取其它画布的节点（进程内缓存，同一 id 只拉一次）
const boardNodesCache = new Map<string, CanvasNode[] | "error">();
const boardNodesFetching = new Set<string>();

/** 该画布的真实进度；未取得回 null（宿主应显示「无进度」，不造假）。 */
interface BoardStat {
  percent: number;
  pendingReview: number;
  nodeCount: number;
  previews: CanvasStagePreview[];
}

function statOf(nodes: CanvasNode[]): BoardStat {
  const stages = summarizeStages(nodes);
  const overall = overallProgress(stages);
  const previews: CanvasStagePreview[] = [];
  for (const s of stages) {
    for (const p of s.previews) {
      if (previews.length >= 4) break;
      previews.push(p);
    }
    if (previews.length >= 4) break;
  }
  return { percent: overall.percent, pendingReview: overall.pendingReview, nodeCount: nodes.length, previews };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRect(a: HudRect, b: HudRect, t: number): HudRect {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), width: lerp(a.width, b.width, t), height: lerp(a.height, b.height, t) };
}

const PICK_DELAY_MS = 60;
const PICK_RESET_MS = 1400;

export function CanvasBoardOverview({
  boards,
  board,
  activeNodes,
  activeCanvasId,
  size,
  interactive,
  wide,
  reduceMotion = false,
  onSwitchCanvas,
}: CanvasBoardOverviewProps) {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  // 懒取「非当前画布」的节点：带进程内缓存、同一 id 只拉一次、失败回退成「无进度」。
  useEffect(() => {
    let cancelled = false;
    for (const b of boards) {
      if (b.id === activeCanvasId || boardNodesCache.has(b.id) || boardNodesFetching.has(b.id)) continue;
      boardNodesFetching.add(b.id);
      void fetchCanvasProject(b.id)
        .then((res) => {
          boardNodesCache.set(b.id, res.ok && res.data && Array.isArray(res.data.nodes) ? res.data.nodes : "error");
        })
        .catch(() => boardNodesCache.set(b.id, "error"))
        .finally(() => {
          boardNodesFetching.delete(b.id);
          if (!cancelled) forceTick((t) => t + 1);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [boards, activeCanvasId]);

  // 每帧现算：读缓存 Map（懒取完成后 forceTick 触发重渲）。便宜（画布数很少）。
  const stats = boards.map((b) => {
    if (b.id === activeCanvasId) return statOf(activeNodes);
    const cached = boardNodesCache.get(b.id);
    return Array.isArray(cached) ? statOf(cached) : null;
  });

  const dispersed = board <= 0;
  useEffect(() => {
    if (dispersed) setPickedId(null);
  }, [dispersed]);
  useEffect(() => {
    if (pickedId === null) return;
    const t = window.setTimeout(() => setPickedId(null), PICK_RESET_MS);
    return () => window.clearTimeout(t);
  }, [pickedId]);

  if (board <= 0 || size.width <= 0 || size.height <= 0 || boards.length === 0) return null;

  const phaseA = clamp01(board / 0.6);
  const phaseB = clamp01((board - 0.6) / 0.4);
  const eB = easeOutCubic(phaseB);
  const contentOpacity = clamp01((phaseB - 0.15) / 0.5);
  const clickable = interactive && phaseB > 0.95;
  const activeIndex = Math.max(0, boards.findIndex((b) => b.id === activeCanvasId));
  const activeBoard = boards[activeIndex];

  const pick = (canvasId: string) => {
    if (!clickable || pickedId !== null || canvasId === activeCanvasId) return;
    setPickedId(canvasId);
    window.setTimeout(() => onSwitchCanvas(canvasId), reduceMotion ? 0 : PICK_DELAY_MS);
  };

  const header = (
    <div className="flex items-baseline gap-2.5" style={{ opacity: contentOpacity }}>
      <span className="max-w-[40vw] truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">全部画布</span>
      <span className="text-[12px] tabular-nums text-muted-foreground">
        共 {boards.length} 个 · 当前「{activeBoard?.title || "未命名画布"}」
      </span>
    </div>
  );

  // ── 窄萤幕：纵排、直接淡入（不做 phase B 滑动）
  if (!wide) {
    return (
      <div
        className="pointer-events-none absolute inset-0 z-[5] overflow-y-auto px-4 pb-8 pt-16"
        style={{ opacity: phaseB }}
        aria-hidden={!interactive}
      >
        <div className="mb-3">{header}</div>
        <div className="mx-auto flex max-w-[420px] flex-col gap-3">
          {boards.map((b, i) => (
            <div key={b.id} className="h-[188px]">
              <BoardCard
                board={b}
                stat={stats[i]}
                active={b.id === activeCanvasId}
                clickable={clickable}
                picked={pickedId === b.id}
                dimmed={pickedId !== null && pickedId !== b.id}
                onPick={() => pick(b.id)}
                className={cn("lg-float rounded-[20px]", clickable && "pointer-events-auto")}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── 宽萤幕：两段式形变（缩格 → 卡片）
  const { slots } = boardLayout(size, boards.length);

  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-y-auto" aria-hidden={!interactive}>
      <div className="absolute" style={{ left: slots[0].x + 2, top: slots[0].y - 34 }}>
        {header}
      </div>
      {boards.map((b, i) => {
        const slot = slots[i];
        // A 段徽章＝槽位中心缩到 0.72 的小格（无世界来源，原地长出）。
        const badgeRect: HudRect = {
          x: slot.x + slot.width * 0.14,
          y: slot.y + slot.height * 0.14,
          width: slot.width * 0.72,
          height: slot.height * 0.72,
        };
        const rect = lerpRect(badgeRect, slot, eB);
        const aEase = easeOutCubic(phaseA);
        const scale = phaseB > 0 ? 1 : 0.72 + 0.28 * aEase;
        // 缩格淡入（A 段 0.05→0.4）：换层瞬间 board≈0，格子从无到有，不与阶段层叠影。
        const shellOpacity = phaseB > 0 ? 1 : clamp01((board - 0.05) / 0.35);
        const picked = pickedId === b.id;
        const dimmed = pickedId !== null && !picked;
        const active = b.id === activeCanvasId;
        return (
          <div
            key={b.id}
            className={cn(
              "lod-stage-shell absolute overflow-hidden",
              phaseB > 0 ? "lg-float" : "bg-white/95 shadow-[0_4px_16px_rgba(0,0,0,0.10),0_0_0_0.5px_rgba(0,0,0,0.08)] backdrop-blur-md",
              clickable && "lod-stage-hover pointer-events-auto",
            )}
            data-board-active={active ? "" : undefined}
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
              borderRadius: 20,
              opacity: shellOpacity * (dimmed ? 0 : 1),
              transform: `scale(${picked ? 1.02 : scale})`,
              transition: pickedId !== null ? "opacity 150ms ease-out, transform 120ms ease-out, box-shadow 120ms ease-out" : undefined,
              boxShadow: picked
                ? "0 0 0 2px rgba(0,122,255,0.9), 0 18px 40px -10px rgba(0,122,255,0.35)"
                : active && phaseB > 0
                  ? "0 0 0 1.5px rgba(0,122,255,0.5), 0 16px 40px -14px rgba(0,122,255,0.28)"
                  : undefined,
            }}
          >
            {contentOpacity > 0 && (
              <div className="absolute left-0 top-0 h-full w-full" style={{ opacity: contentOpacity }}>
                <BoardCard
                  board={b}
                  stat={stats[i]}
                  active={active}
                  clickable={clickable}
                  picked={picked}
                  dimmed={dimmed}
                  onPick={() => pick(b.id)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────── 格子内容

interface BoardCardProps {
  board: ChatCanvasEntry;
  stat: BoardStat | null;
  active: boolean;
  clickable: boolean;
  picked: boolean;
  dimmed: boolean;
  onPick: () => void;
  className?: string;
}

function BoardCard({ board, stat, active, clickable, picked, dimmed, onPick, className }: BoardCardProps) {
  const title = board.title || "未命名画布";
  const percent = stat ? stat.percent : 0;
  const barColor = active ? "bg-ios-blue" : stat && percent >= 100 ? "bg-[#34C759]" : "bg-foreground/35";
  return (
    <div
      role="button"
      data-canvas-interactive
      data-board-cell
      tabIndex={clickable ? 0 : -1}
      aria-disabled={!clickable}
      aria-current={active ? "true" : undefined}
      aria-label={`画布「${title}」${stat ? `：整体 ${percent}%，${stat.nodeCount} 个节点` : "：进度未取到"}`}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick();
        }
      }}
      className={cn(
        "lod-stage-card group relative flex h-full w-full flex-col p-3 text-left outline-none",
        clickable && "cursor-pointer",
        className,
      )}
      style={{ opacity: dimmed ? 0 : 1 }}
    >
      {/* 封面：真实产出缩图（最多 4）＞ 空位图示；不发假图。 */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-[12px] bg-foreground/[0.035]">
        {stat && stat.previews.length > 0 ? (
          <BoardMosaic previews={stat.previews} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Layers className="h-7 w-7 text-foreground/15" strokeWidth={1.5} />
          </div>
        )}
      </div>

      {/* 标题列 */}
      <div className="mt-3 flex items-center gap-1.5">
        <span className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">{title}</span>
        {active && (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-ios-blue">
            <span className="lod-pulse h-1.5 w-1.5 rounded-full bg-ios-blue" />
            当前
          </span>
        )}
        {board.isPrimary && !active && (
          <span className="ml-auto shrink-0 rounded-full bg-foreground/[0.06] px-1.5 py-0.5 text-[11px] font-medium text-foreground/70">主画布</span>
        )}
      </div>

      {/* 数字＋状态 */}
      <div className="mt-2.5 flex items-end justify-between gap-2">
        {stat ? (
          <span className="leading-none">
            <span className="text-[22px] font-semibold tabular-nums tracking-[-0.02em] text-foreground">{stat.percent}%</span>
            <span className="text-[13px] tabular-nums text-muted-foreground"> · {stat.nodeCount} 个节点</span>
          </span>
        ) : (
          <span className="text-[12px] text-muted-foreground">无进度</span>
        )}
        <div className="flex min-w-0 items-center gap-2 text-[11px] font-medium tabular-nums">
          {stat && stat.pendingReview > 0 && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-[rgba(255,159,10,0.14)] py-0.5 pl-2 pr-2 text-[#A35F00]">
              待审 {stat.pendingReview}
            </span>
          )}
          {active && (
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-ios-blue text-white">
              <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
            </span>
          )}
        </div>
      </div>

      {/* 进度细条 */}
      <div className="mt-2.5 h-[3px] w-full overflow-hidden rounded-full bg-foreground/[0.07]">
        {percent > 0 && (
          <div
            className={cn("h-full rounded-full", barColor)}
            style={{ width: `${percent}%`, transition: "width 600ms cubic-bezier(0.2, 0.9, 0.2, 1)" }}
          />
        )}
      </div>
    </div>
  );
}

/** 真实产出缩图的 1/2/3/4 网格（与鸟瞰封面同款写法）。 */
function BoardMosaic({ previews }: { previews: CanvasStagePreview[] }) {
  const n = previews.length;
  const grid = n === 1 ? "grid-cols-1" : n === 2 ? "grid-cols-2" : "grid-cols-2 grid-rows-2";
  return (
    <div className={cn("grid h-full w-full gap-px bg-white/60", grid)}>
      {previews.map((p, i) => (
        <div key={`${p.url}-${i}`} className={cn("relative overflow-hidden", n === 3 && i === 0 && "row-span-2")}>
          {p.kind === "video" ? (
            <video src={p.url} muted playsInline preload="metadata" className="lod-stage-thumb h-full w-full object-cover" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.url} alt="" loading="lazy" draggable={false} className="lod-stage-thumb h-full w-full object-cover" />
          )}
        </div>
      ))}
    </div>
  );
}

/** 画布层图示（单色、不发新色）。 */
export default CanvasBoardOverview;
