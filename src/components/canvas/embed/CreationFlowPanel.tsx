"use client";

// CreationFlowPanel —— 作品 / 劇集面板（2026-09-16 G2）。
//
// 修的是 PRD「刀 1 全鏈生效定義」的第 2 環：「canvas 面板可見」。
// 資料鏈完全復用既有出口，本檔不新增任何型別或儲存：
//   hook `projectType` / `currentStep` / `episodes`（刀 1 三欄，唯一寫入口 setProjectMeta）
//   ＋ `summarizeCreationFlow`（純資料層，`src/lib/canvas/creation-flow-panel.ts`）。
//
// 掛法照 角色/場景卡面板（同層 `ce-embed-leftpop` 左側彈層 + 頂欄 chip 開關），
// 不新建頁面樹。視覺沿用 lg-sheet 材料 + ios-* 字級（DESIGN.md：正文 ≥13px）。
//
// 誠實邊界：**不顯示「完成進度 N/M」百分比**——本站沒有「一鏡完成」的建模欄位，
// 把「已落畫布鏡數 / 場景計畫鏡數」寫成「完成度」就是灌水（D2 缺口的正確解法是
// 呈現真實計數，不是造一個好看的百分比）。

import type { CreationFlowSummary } from "@/lib/canvas/creation-flow-panel";
import { CREATION_STEPS } from "@/lib/creation-flow-steps";

export interface CreationFlowPanelProps {
  summary: CreationFlowSummary;
  /** 關閉面板（點標題列關閉鈕）。 */
  onClose: () => void;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-black/5 px-1.5 py-0.5 text-ios-caption2 text-muted-foreground">
      {children}
    </span>
  );
}

export function CreationFlowPanel({ summary, onClose }: CreationFlowPanelProps) {
  const { projectTypeLabel, currentStep, episodeCount, finishedCount, episodes, storyboard } = summary;
  const configured = Boolean(projectTypeLabel || currentStep || episodeCount > 0);
  const stepIndex = currentStep ? CREATION_STEPS.findIndex((s) => s.value === currentStep.value) : -1;

  return (
    <div
      data-canvas-interactive
      role="dialog"
      aria-label="作品与剧集"
      className="ce-embed-leftpop lg-sheet pointer-events-auto absolute z-20 w-72 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-ios-2xl"
      style={{
        left: "calc(0.75rem + env(safe-area-inset-left, 0px))",
        top: "calc(3.5rem + env(safe-area-inset-top, 0px))",
        maxHeight: "min(64dvh, 420px)",
      }}
    >
      <div className="flex items-start justify-between gap-2 border-b px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-foreground">作品 / 剧集</p>
          <p className="mt-0.5 text-ios-footnote leading-snug text-foreground/45">
            作品类型 · 流程进度 · 分集清单（AI 助理可直接写入）
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭作品剧集面板"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground/45 hover:bg-black/5"
        >
          ✕
        </button>
      </div>

      {!configured ? (
        <p className="px-3.5 py-3 text-ios-footnote leading-relaxed text-foreground/45">
          还没有作品配置 · 让 AI 助理设定后就显示在这里
        </p>
      ) : (
        <>
          {/* 作品类型 + 流程步：未设定不渲染该行，不占位不捏造 */}
          {(projectTypeLabel || currentStep) && (
            <div className="border-b px-3 py-2.5">
              <div className="flex items-center gap-2">
                {projectTypeLabel && <Chip>{projectTypeLabel}</Chip>}
                {currentStep && (
                  <span className="text-ios-footnote font-medium text-foreground">
                    第 {currentStep.value} 步 · {currentStep.label}
                  </span>
                )}
              </div>
              {stepIndex >= 0 && (
                <>
                  {/* 7 步骨架：純位置指示（哪一步），不是進度百分比 */}
                  <div className="mt-2 flex items-center gap-1" aria-hidden>
                    {CREATION_STEPS.map((step, i) => (
                      <span
                        key={step.value}
                        className={
                          i <= stepIndex
                            ? "h-1 flex-1 rounded-full bg-ios-blue"
                            : "h-1 flex-1 rounded-full bg-black/10"
                        }
                      />
                    ))}
                  </div>
                  <p className="mt-1 text-ios-footnote tabular-nums text-foreground/45">
                    共 {CREATION_STEPS.length} 步
                  </p>
                </>
              )}
            </div>
          )}

          {/* 剧集清单 */}
          <div className="border-b px-3 py-2.5">
            <div className="flex items-center gap-2">
              <p className="text-ios-footnote font-medium text-foreground">剧集 · {episodeCount} 集</p>
              {finishedCount > 0 && <Chip>已完成 {finishedCount}</Chip>}
            </div>
            {episodes.length === 0 ? (
              <p className="mt-1.5 text-ios-footnote text-foreground/45">还没有分集</p>
            ) : (
              <ul className="mt-1.5 space-y-1">
                {episodes.map((episode) => (
                  <li key={episode.id} className="flex items-center gap-2">
                    <span className="shrink-0 text-ios-footnote tabular-nums text-foreground/45">
                      第 {episode.episodeNo} 集
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ios-footnote text-foreground">{episode.title}</span>
                    <span
                      className={
                        episode.status === "finished"
                          ? "shrink-0 text-ios-footnote font-medium text-ios-green"
                          : "shrink-0 text-ios-footnote text-foreground/45"
                      }
                    >
                      {episode.statusLabel}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 分镜计数：只报真实计数，不报「完成度」 */}
          <div className="px-3 py-2.5">
            <p className="text-ios-footnote font-medium text-foreground">分镜</p>
            <p className="mt-1 text-ios-footnote tabular-nums text-foreground/45">
              已落画布 {storyboard.shots} 镜
              {storyboard.plannedShots > 0 ? ` · 场景计划 ${storyboard.plannedShots} 镜` : ""}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
