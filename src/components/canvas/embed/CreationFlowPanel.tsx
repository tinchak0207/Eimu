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
//
// 2026-09-24（步驟條）：原本的 7 段 `aria-hidden` 唯讀點條升級為 5 步可交互步驟條
// （`CreationStepBar`，同檔匯出）。契約層 `CREATION_STEPS` 的 7 步**未動**——
// 5 步是呈現層，由 `src/lib/wizard-steps.ts` 單向投影得來。面板不 import 任何審查面板：
// 資產圖／故事板的開啟以 `onOpenReview` 回報，由呼叫端接線。

import type { CreationFlowSummary } from "@/lib/canvas/creation-flow-panel";
import { CREATION_STEPS } from "@/lib/creation-flow-steps";
import {
  WIZARD_STEPS,
  resolveWizardStepAction,
  wizardProgress,
  wizardStepCostLabel,
  type WizardRerunPlan,
  type WizardReviewTarget,
} from "@/lib/wizard-steps";

export interface CreationFlowPanelProps {
  summary: CreationFlowSummary;
  /** 關閉面板（點標題列關閉鈕）。 */
  onClose: () => void;
  /**
   * 步驟條點「資產圖」／「故事板」→ 開對應審查面板。
   * **本元件不 import 任何面板**：面板由呼叫端（路 2）實作與接線。
   */
  onOpenReview?: (target: WizardReviewTarget) => void;
  /**
   * 步驟條回跳：點已完成步 → 回報「要重跑該步與其後續」（決策 15）。
   * 重跑語義（暫停/續跑/扣費）由呼叫端決定，本元件只回報計畫。
   */
  onRewind?: (plan: WizardRerunPlan) => void;
  /** 全自動檔＝只讀進度（決策 13）：不可點、不開面板、不回跳。 */
  readOnly?: boolean;
}

export interface CreationStepBarProps {
  /** 契約層當前步值（1..7，來自 `CanvasProject.currentStep`）。未知＝全部待辦。 */
  contractStep: unknown;
  onOpenReview?: (target: WizardReviewTarget) => void;
  onRewind?: (plan: WizardRerunPlan) => void;
  readOnly?: boolean;
}

/**
 * 5 步可交互步驟條（決策 12/13/14/15/16）。
 *
 * 現況升級自 7 段 `aria-hidden` 唯讀點條（純位置指示、不可點）：
 *   - 呈現層 5 步（行業語言），契約層 `CREATION_STEPS` 的 7 步**一個字都沒動**；
 *   - 當前步高亮、已完成步可點回跳、每步顯示預估花費；
 *   - `readOnly`（全自動檔）＝只讀進度，看它一格格跑完，不新增任何阻塞。
 *
 * 掛在面板內，但**獨立匯出**：呼叫端可把它直接嵌進對話區（決策 12 的形態），
 * 不必連面板外殼一起搬。
 */
export function CreationStepBar({ contractStep, onOpenReview, onRewind, readOnly = false }: CreationStepBarProps) {
  const progress = wizardProgress(contractStep);
  const actionContext = { readOnly, canReview: Boolean(onOpenReview), canRewind: Boolean(onRewind) };

  return (
    <ol className="mt-2 space-y-1" aria-label="创作流程步骤">
      {progress.map(({ step, state }) => {
        const action = resolveWizardStepAction(step, state, actionContext);
        const rowClass =
          state === "current"
            ? "flex w-full items-center gap-2 rounded-md bg-ios-blue/10 px-1.5 py-1 text-left"
            : "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left";
        const content = (
          <>
            <span
              className={
                state === "done"
                  ? "flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-ios-blue text-[10px] font-semibold text-white"
                  : state === "current"
                    ? "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-ios-blue text-[10px] font-semibold text-ios-blue"
                    : "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-black/15 text-[10px] text-foreground/45"
              }
              aria-hidden
            >
              {state === "done" ? "✓" : step.value}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={
                  state === "pending"
                    ? "block truncate text-ios-footnote text-foreground/45"
                    : "block truncate text-ios-footnote font-medium text-foreground"
                }
              >
                {step.label}
                {state === "current" && <span className="ml-1 text-foreground/45">· 进行中</span>}
              </span>
              <span className="block truncate text-ios-caption2 tabular-nums text-foreground/45">
                {wizardStepCostLabel(step)}
              </span>
            </span>
            {step.review && (
              <span className="shrink-0 text-ios-caption2 text-ios-blue">审查</span>
            )}
          </>
        );

        return (
          <li key={step.key}>
            {action ? (
              <button
                type="button"
                className={`${rowClass} touch-manipulation hover:bg-black/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40`}
                aria-label={
                  action.kind === "review"
                    ? `打开${step.label}审查面板`
                    : `回跳重跑：${action.plan.rerun.map((s) => s.label).join("、")}`
                }
                onClick={() => {
                  if (action.kind === "review") onOpenReview?.(action.target);
                  else onRewind?.(action.plan);
                }}
              >
                {content}
              </button>
            ) : (
              <div className={rowClass}>{content}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-black/5 px-1.5 py-0.5 text-ios-caption2 text-muted-foreground">
      {children}
    </span>
  );
}

export function CreationFlowPanel({ summary, onClose, onOpenReview, onRewind, readOnly = false }: CreationFlowPanelProps) {
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
                  {/*
                    5 步可交互步骤条（决策 12/13/14/15/16）——升級自原本 7 段唯讀點條。
                    呈現層 5 步由 `wizard-steps.ts` 單向投影到契約層 `CREATION_STEPS`（7 步未動）。
                    全自動檔（readOnly）只讀進度；協作檔可回跳、可在資產圖/故事板開審查面板。
                  */}
                  <CreationStepBar
                    contractStep={currentStep?.value}
                    onOpenReview={onOpenReview}
                    onRewind={onRewind}
                    readOnly={readOnly}
                  />
                  <p className="mt-1 text-ios-footnote tabular-nums text-foreground/45">
                    共 {WIZARD_STEPS.length} 步 · 已完成{" "}
                    {wizardProgress(currentStep?.value).filter((entry) => entry.state === "done").length}
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
