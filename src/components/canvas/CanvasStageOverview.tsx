"use client";

// CanvasStageOverview —— 語義縮放 LOD 1「導演鳥瞰層」（2026-09-30 打磨版）。
//
// 形態＝導演故事板牌組：4 張階段卡橫排於螢幕安全區（讓出右側縮放軌）。
// 視覺紀律：單一強調色（ios-blue＝進行中），其餘中性；不做水印大字、彩虹漸層、框中框。
// 封面優先級：真實產出縮圖 ＞ 劇本摘錄 ＞ 狀態珠點陣（一珠一節點）＞ 階段圖示。
//
// 轉場（k 是唯一真源，gather 由宿主每幀傳入，可被滾輪「刷」、可逆）：
//   phase A（gather 0→0.6）：在各階段「世界質心」的螢幕位置浮現階段徽章（膠囊），scale 0.6→1。
//                             此時畫布上的節點正往同一個質心收束（CSS --lod-g），徽章就是它們的歸宿。
//   phase B（gather 0.6→1）：徽章從質心滑向 HUD 槽位並展開成完整卡片（矩形插值＋easeOut），
//                             卡內容在 B 後半淡入。反向即散開。
// 空階段沒有質心：跳過 A，在槽位原地淡入。窄螢幕（<768）縱排、不做 B 滑動（直接淡入）。
//
// 點卡：該卡 scale 1.03＋描邊 120ms、其餘卡加速淡出 → 宿主 flyTo 該階段（飛行途中聚合自動散開）。
// 可點元素帶 data-canvas-interactive，InfiniteCanvas 手勢層放行。

import { useEffect, useState } from "react";
import { Check, ChevronRight, Clapperboard, Film, ScrollText, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasViewport } from "@/lib/canvas/types";
import {
  clamp01,
  easeOutCubic,
  HUD_CARD,
  hudLayout,
  overallProgress,
  type CanvasStageBead,
  type CanvasStageId,
  type CanvasStagePreview,
  type CanvasStageSummary,
  type HudRect,
} from "@/lib/canvas/lod";

export interface CanvasStageOverviewProps {
  stages: CanvasStageSummary[];
  /** lodBlend(k).gather（未 ease 的原值）。0 ＝不渲染。 */
  gather: number;
  viewport: CanvasViewport;
  size: { width: number; height: number };
  /** 離散 LOD === 1：卡片可點。 */
  interactive: boolean;
  /** ≥768px：橫排＋兩段式形變；否則縱排直接淡入。 */
  wide: boolean;
  reduceMotion?: boolean;
  projectTitle?: string;
  onSelectStage: (stage: CanvasStageSummary) => void;
  onReviewStage: (stage: CanvasStageSummary) => void;
}

/** 階段圖示：鳥瞰卡標題列與空封面共用（單色、不發新色）。 */
const STAGE_ICON: Record<CanvasStageId, LucideIcon> = {
  1: ScrollText,
  2: Users,
  3: Clapperboard,
  4: Film,
};

function smoothstepLocal(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRect(a: HudRect, b: HudRect, t: number): HudRect {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), width: lerp(a.width, b.width, t), height: lerp(a.height, b.height, t) };
}

const BADGE = { width: 150, height: 32 } as const;
const PICK_DELAY_MS = 60;
const PICK_RESET_MS = 1400;

export function CanvasStageOverview({
  stages,
  gather,
  viewport,
  size,
  interactive,
  wide,
  reduceMotion = false,
  projectTitle,
  onSelectStage,
  onReviewStage,
}: CanvasStageOverviewProps) {
  const [pickedId, setPickedId] = useState<CanvasStageId | null>(null);

  // 點選態撐過整段飛行（其他卡保持隱去，不在半途閃回）；完全散開或逾時即清，下次回來是乾淨的牌組。
  const dispersed = gather <= 0;
  useEffect(() => {
    if (dispersed) setPickedId(null);
  }, [dispersed]);
  useEffect(() => {
    if (pickedId === null) return;
    const t = window.setTimeout(() => setPickedId(null), PICK_RESET_MS);
    return () => window.clearTimeout(t);
  }, [pickedId]);

  if (gather <= 0 || size.width <= 0 || size.height <= 0) return null;

  const phaseA = clamp01(gather / 0.6);
  const phaseB = clamp01((gather - 0.6) / 0.4);
  const eB = easeOutCubic(phaseB);
  // 內容與殼同步長出（B 段 15%→65% 淡入）：不出現「空白殼」過渡幀。
  const contentOpacity = clamp01((phaseB - 0.15) / 0.5);
  const clickable = interactive && phaseB > 0.95;
  const overall = overallProgress(stages);

  const pick = (stage: CanvasStageSummary) => {
    if (!clickable || stage.total === 0 || pickedId !== null) return;
    setPickedId(stage.id);
    window.setTimeout(() => onSelectStage(stage), reduceMotion ? 0 : PICK_DELAY_MS);
  };

  const header = (
    <div className="flex items-baseline gap-2.5" style={{ opacity: contentOpacity }}>
      <span className="max-w-[40vw] truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">{projectTitle || "未命名作品"}</span>
      <span className="text-[12px] tabular-nums text-muted-foreground">
        整体 {overall.percent}%{overall.pendingReview > 0 ? ` · 待审 ${overall.pendingReview}` : ""}
      </span>
    </div>
  );

  // ── 窄螢幕：縱排、直接淡入（不做 phase B 滑動）
  if (!wide) {
    return (
      <div
        className="pointer-events-none absolute inset-0 z-[5] overflow-y-auto px-4 pb-8 pt-16"
        style={{ opacity: phaseB }}
        aria-hidden={!interactive}
      >
        <div className="mb-3">{header}</div>
        <div className="mx-auto flex max-w-[420px] flex-col gap-3">
          {stages.map((stage) => (
            <div key={stage.id} className="h-[268px]">
              <StageCard
                stage={stage}
                clickable={clickable}
                picked={pickedId === stage.id}
                dimmed={pickedId !== null && pickedId !== stage.id}
                onPick={() => pick(stage)}
                onReview={() => onReviewStage(stage)}
                className={cn("lg-float rounded-[20px]", clickable && "pointer-events-auto")}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── 寬螢幕：兩段式形變（徽章 → 卡片）
  const { mode, slots } = hudLayout(size, stages.length);
  const first = slots[0];

  return (
    <div className="pointer-events-none absolute inset-0 z-[5]" aria-hidden={!interactive}>
      {/* 標題列：與第一張卡左緣對齊 */}
      <div className="absolute" style={{ left: first.x + 2, top: first.y - 34 }}>
        {header}
      </div>

      {/* 卡間方向指示：細 chevron，只在卡片成形後出現 */}
      {mode === "row" && slots.slice(0, -1).map((slot, i) => (
        <ChevronRight
          key={`chev-${i}`}
          aria-hidden="true"
          className="absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 text-foreground/25"
          style={{ left: slot.x + slot.width + HUD_CARD.gap / 2, top: slot.y + slot.height / 2, opacity: contentOpacity }}
        />
      ))}

      {stages.map((stage, i) => {
        const slot = slots[i];
        const c = stage.centroid;
        const empty = stage.total === 0 || !c;
        const badgeRect: HudRect = c
          ? {
              x: c.x * viewport.k + viewport.x - BADGE.width / 2,
              y: c.y * viewport.k + viewport.y - BADGE.height / 2,
              width: BADGE.width,
              height: BADGE.height,
            }
          : { x: slot.x + slot.width * 0.04, y: slot.y + slot.height * 0.04, width: slot.width * 0.92, height: slot.height * 0.92 };
        const rect = lerpRect(badgeRect, slot, eB);
        // A 段：徽章 scale 0.6→1、淡入；空階段無 A 段，只在 B 段原地淡入。
        const aEase = easeOutCubic(phaseA);
        const scale = empty ? 1 : phaseB > 0 ? 1 : 0.6 + 0.4 * aEase;
        // 徽章只在節點收進來之後才現身（g 0.25→0.45）：散開時節點一回來它就退場，不壓在節點上。
        const shellOpacity = empty ? phaseB : phaseB > 0 ? 1 : smoothstepLocal(0.25, 0.45, gather);
        const chipOpacity = empty ? 0 : 1 - clamp01(phaseB / 0.35);
        const picked = pickedId === stage.id;
        const dimmed = pickedId !== null && !picked;
        const Icon = STAGE_ICON[stage.id];
        return (
          <div
            key={stage.id}
            className={cn(
              "lod-stage-shell absolute overflow-hidden",
              phaseB > 0 ? "lg-float" : "bg-white/95 shadow-[0_4px_16px_rgba(0,0,0,0.10),0_0_0_0.5px_rgba(0,0,0,0.08)] backdrop-blur-md",
              clickable && !empty && "lod-stage-hover pointer-events-auto",
            )}
            data-current={stage.current ? "" : undefined}
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
              borderRadius: lerp(BADGE.height / 2, 20, eB),
              opacity: shellOpacity * (dimmed ? 0 : 1),
              transform: `scale(${picked ? 1.02 : scale})`,
              transition: pickedId !== null ? "opacity 150ms ease-out, transform 120ms ease-out, box-shadow 120ms ease-out" : undefined,
              boxShadow: picked
                ? "0 0 0 2px rgba(0,122,255,0.9), 0 18px 40px -10px rgba(0,122,255,0.35)"
                : stage.current && phaseB > 0
                  ? "0 0 0 1.5px rgba(0,122,255,0.5), 0 16px 40px -14px rgba(0,122,255,0.28)"
                  : undefined,
            }}
          >
            {/* 徽章內容（A 段主角，B 段前 35% 淡出） */}
            {chipOpacity > 0 && (
              <div
                className="pointer-events-none absolute left-0 top-0 flex items-center gap-1.5 px-3"
                style={{ height: BADGE.height, width: BADGE.width, opacity: chipOpacity }}
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-foreground/55" strokeWidth={2} />
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{stage.code}</span>
                <span className="min-w-0 truncate text-ios-caption1 font-semibold text-foreground">{stage.label}</span>
              </div>
            )}
            {/* 卡片本體：固定槽位尺寸，殼縮小時被裁切；B 段後半淡入。 */}
            {contentOpacity > 0 && (
              <div className="absolute left-0 top-0" style={{ width: slot.width, height: slot.height, opacity: contentOpacity }}>
                <StageCard
                  stage={stage}
                  clickable={clickable}
                  picked={picked}
                  dimmed={dimmed}
                  onPick={() => pick(stage)}
                  onReview={() => onReviewStage(stage)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────── 卡片內容

interface StageCardProps {
  stage: CanvasStageSummary;
  clickable: boolean;
  picked: boolean;
  dimmed: boolean;
  onPick: () => void;
  onReview: () => void;
  className?: string;
}

function StageCard({ stage, clickable, onPick, onReview, className }: StageCardProps) {
  const empty = stage.total === 0;
  const percent = empty ? 0 : Math.round((stage.done / stage.total) * 100);
  const Icon = STAGE_ICON[stage.id];
  const barColor = stage.current ? "bg-ios-blue" : stage.complete ? "bg-[#34C759]" : "bg-foreground/35";
  return (
    <div
      role="button"
      data-canvas-interactive
      tabIndex={clickable && !empty ? 0 : -1}
      aria-disabled={empty || !clickable}
      aria-label={`${stage.code} ${stage.label}：${empty ? "未开始" : `完成 ${stage.done}/${stage.total}`}`}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick();
        }
      }}
      className={cn(
        "lod-stage-card group relative flex h-full w-full flex-col p-3 text-left outline-none",
        !empty && clickable && "cursor-pointer",
        className,
      )}
    >
      {/* 封面：真實產出 ＞ 劇本摘錄 ＞ 狀態珠點陣 ＞ 空 */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-[12px] bg-foreground/[0.035]">
        {stage.previews.length > 0 ? (
          <>
            <PreviewMosaic previews={stage.previews} />
            {stage.total > stage.previews.length && <BeadStrip beads={stage.beads} />}
          </>
        ) : stage.excerpt ? (
          <div className="relative flex h-full items-center px-4 pl-6">
            <span className="absolute left-2.5 top-2 font-serif text-[26px] leading-none text-foreground/20" aria-hidden="true">
              “
            </span>
            <p className="line-clamp-3 font-serif text-[13px] leading-[1.55] text-foreground/75">{stage.excerpt}</p>
          </div>
        ) : stage.beads.length > 0 ? (
          <BeadGrid beads={stage.beads} total={stage.total} icon={Icon} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Icon className="h-7 w-7 text-foreground/15" strokeWidth={1.5} />
          </div>
        )}
      </div>

      {/* 標題列 */}
      <div className="mt-3 flex items-center gap-1.5">
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{stage.code}</span>
        <span className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">{stage.label}</span>
        {stage.current && (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-ios-blue">
            <span className="lod-pulse h-1.5 w-1.5 rounded-full bg-ios-blue" />
            进行中
          </span>
        )}
        {stage.complete && (
          <span className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#34C759] text-white">
            <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
          </span>
        )}
      </div>

      {/* 數字＋狀態 */}
      <div className="mt-2.5 flex items-end justify-between gap-2">
        {empty ? (
          <span className="text-[12px] text-muted-foreground">尚无节点</span>
        ) : (
          <span className="leading-none">
            <span className="text-[22px] font-semibold tabular-nums tracking-[-0.02em] text-foreground">{stage.done}</span>
            <span className="text-[13px] tabular-nums text-muted-foreground"> / {stage.total}</span>
          </span>
        )}
        <div className="flex min-w-0 items-center gap-2 text-[11px] font-medium tabular-nums">
          {stage.running > 0 && <span className="text-ios-blue">运行 {stage.running}</span>}
          {stage.failed > 0 && <span className="text-ios-red">失败 {stage.failed}</span>}
          {stage.pendingReview > 0 && (
            <button
              type="button"
              data-canvas-interactive
              disabled={!clickable}
              onClick={(e) => {
                e.stopPropagation();
                onReview();
              }}
              className="inline-flex items-center gap-0.5 rounded-full bg-[rgba(255,159,10,0.14)] py-0.5 pl-2 pr-1 text-[#A35F00] transition-colors hover:bg-[rgba(255,159,10,0.24)]"
            >
              待审 {stage.pendingReview}
              <ChevronRight className="h-3 w-3" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>

      {/* 進度細條 */}
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

/** 1/2/3/4 張各自的網格：1＝滿版、2＝對開、3＝左大右二、4＝田字。 */
function PreviewMosaic({ previews }: { previews: CanvasStagePreview[] }) {
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

const BEAD_CLASS: Record<CanvasStageBead, string> = {
  done: "bg-foreground/75",
  running: "lod-pulse bg-ios-blue",
  failed: "bg-ios-red",
  review: "bg-[#FF9F0A]",
  idle: "bg-foreground/[0.13]",
};

const STRIP_BEAD_CLASS: Record<CanvasStageBead, string> = {
  done: "bg-white",
  running: "lod-pulse bg-[#5AC8FA]",
  failed: "bg-[#FF6961]",
  review: "bg-[#FFB340]",
  idle: "bg-white/30",
};

/** 縮圖封面底部的狀態珠條：縮圖只露 4 張，其餘鏡頭的進度靠這條一眼看完。 */
function BeadStrip({ beads }: { beads: CanvasStageBead[] }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 via-black/25 to-transparent px-2.5 pb-2 pt-5">
      <div className="flex flex-wrap gap-[3px]">
        {beads.map((b, i) => (
          <span key={i} className={cn("h-[5px] w-[5px] rounded-full", STRIP_BEAD_CLASS[b])} />
        ))}
      </div>
    </div>
  );
}

/** 狀態珠點陣：每顆＝一個節點（按位置排序），沒有產出縮圖時一眼看清整段進度。 */
function BeadGrid({ beads, total, icon: Icon }: { beads: CanvasStageBead[]; total: number; icon: LucideIcon }) {
  const overflow = total - beads.length;
  // 珠子太少撐不起封面：上方補階段圖示，珠子退為圖示下的狀態列。
  const sparse = beads.length <= 6;
  return (
    <div className="flex h-full flex-col items-center justify-center px-4">
      {sparse && <Icon className="mb-3 h-7 w-7 text-foreground/15" strokeWidth={1.5} />}
      <div className="flex max-w-full flex-wrap content-center justify-center gap-[5px]">
        {beads.map((b, i) => (
          <span key={i} className={cn("h-[7px] w-[7px] rounded-full", BEAD_CLASS[b])} />
        ))}
      </div>
      {overflow > 0 && <span className="mt-2 text-ios-caption2 tabular-nums text-muted-foreground">另有 {overflow} 个</span>}
    </div>
  );
}

export default CanvasStageOverview;
