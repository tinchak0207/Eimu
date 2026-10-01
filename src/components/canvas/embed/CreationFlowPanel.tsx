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

import type {
  CreationFlowSummary,
  CreationNextStepId,
  CreationNextSurface,
  NextCreationStep,
} from "@/lib/canvas/creation-flow-panel";
import { CREATION_STEPS } from "@/lib/creation-flow-steps";

/** 主按鈕文案（依動作面；`none` 不渲染，故不入表）。簡體，照本面板既有文案體例。 */
const NEXT_ACTION_LABEL: Record<Exclude<CreationNextSurface, "none">, string> = {
  agent: "交给 AI 助理",
  "canvas-generation": "打开分镜处理",
};

/**
 * 「补齐配音」（`id === "shot-audio"`）的主動作文案：**先試算費用**（乾跑，不扣費），
 * 確認鍵才真跑。與其他 id 的 `NEXT_ACTION_LABEL` 分開，因為它不是「打開某個面」而是生成。
 */
const VOICEOVER_QUOTE_LABEL = "补齐配音（先试算费用）";

/**
 * 配音流程的顯示狀態（**主體是宿主 CanvasEmbedOverlays 的 state**；本面板只負責印出來）。
 *
 * 幣數欄位一律由**伺服器回應**填寫：`estimatedCoins`＝乾跑報價、`costCoins`＝真跑實扣。
 * 面板端零計算（成本公式是伺服器的事）。
 */
export interface VoiceoverFlowView {
  status: "idle" | "quoting" | "quoted" | "applying" | "applied" | "refused" | "error";
  /** 台詞行數（伺服器回）。 */
  lineCount?: number;
  /** 總字數（伺服器回）。 */
  totalChars?: number;
  /** 乾跑報價幣數（伺服器回）。 */
  estimatedCoins?: number;
  /** 真跑實扣幣數（伺服器回）。 */
  costCoins?: number;
  /** 失敗／被拒原因（伺服器回或傳輸錯誤；如實顯示，不美化）。 */
  reason?: string;
}

export interface CreationFlowPanelProps {
  summary: CreationFlowSummary;
  /**
   * 由當前現況推導的**唯一下一步**（一步一跳；`deriveNextStep`，2026-09-30）。
   * `id === "unknown"`（資料不足以判斷）或 `surface === "none"`（終態）時不渲染——
   * 不給假動作。缺席＝本面板不顯示引導。
   */
  nextStep?: NextCreationStep;
  /**
   * 主動作：依 `surface` 導向既有入口（宿主提供，面板不自己找路）。
   * 「补齐配音」需要知道**是哪一個 next step**（同為 `canvas-generation` 的還有補圖／補影），
   * 故補上第二個可選參數 `id`；既有呼叫端只讀 `surface`，行為不變。
   */
  onNextAction?: (surface: CreationNextSurface, id?: CreationNextStepId) => void;
  /** 配音流程狀態（宿主 state；缺席＝本面板不渲染配音報價區）。 */
  voiceover?: VoiceoverFlowView;
  /** 確認鍵：使用者同意報價後才真跑（`dryRun: false`）。 */
  onVoiceoverConfirm?: () => void;
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

export function CreationFlowPanel({
  summary,
  nextStep,
  onNextAction,
  voiceover,
  onVoiceoverConfirm,
  onClose,
}: CreationFlowPanelProps) {
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

      {/* 下一步（一步一跳）：同一時刻只渲染一個，且排在面板內容最前＝打開就看到。
          由當前現況推導（不讀任何持久化標記）；unknown＝資料不足以判斷、none＝終態，
          兩者都不渲染，不給假動作。主按鈕導向既有入口（宿主提供 `onNextAction`）。 */}
      {nextStep && nextStep.id !== "unknown" && nextStep.surface !== "none" ? (
        <div className="border-b bg-ios-blue/5 px-3 py-2.5">
          <p className="text-[11px] font-medium uppercase leading-none tracking-[0.18em] text-ios-blue/70">
            下一步
          </p>
          <p className="mt-1.5 text-[13px] font-medium leading-snug text-foreground">{nextStep.label}</p>
          {/* 补齐配音：主動作＝先乾跑試算（不扣費），報價與行數/字數如實顯示，
              使用者按確認鍵才真跑。失敗／被拒一律顯示原因，不假成功。 */}
          {nextStep.id === "shot-audio" ? (
            <>
              {voiceover?.status === "quoting" ? (
                <p className="mt-2 text-ios-footnote text-foreground/45">正在试算配音费用…</p>
              ) : null}
              {voiceover?.status === "applying" ? (
                <p className="mt-2 text-ios-footnote text-foreground/45">正在生成配音…</p>
              ) : null}
              {voiceover?.status === "quoted" ? (
                <>
                  <p className="mt-2 text-ios-footnote tabular-nums text-foreground/60">
                    共 {voiceover.lineCount} 句 · {voiceover.totalChars} 字 · 约 {voiceover.estimatedCoins} 币
                  </p>
                  <button
                    type="button"
                    onClick={() => onVoiceoverConfirm?.()}
                    className="mt-2 flex min-h-[2rem] w-full cursor-pointer items-center justify-center rounded-lg bg-ios-blue px-3 py-1.5 text-[13px] font-medium text-white hover:bg-ios-blue/90"
                  >
                    确认生成（约 {voiceover.estimatedCoins} 币）
                  </button>
                </>
              ) : null}
              {voiceover?.status === "applied" ? (
                <p className="mt-2 text-ios-footnote tabular-nums font-medium text-ios-green">
                  已生成 · 共 {voiceover.lineCount} 句 · {voiceover.totalChars} 字 · 花费 {voiceover.costCoins} 币
                </p>
              ) : null}
              {voiceover?.status === "refused" ? (
                <p className="mt-2 text-ios-footnote leading-snug text-destructive">
                  配音未生成：{voiceover.reason}
                </p>
              ) : null}
              {voiceover?.status === "error" ? (
                <p className="mt-2 text-ios-footnote leading-snug text-destructive">
                  配音试算失败：{voiceover.reason}
                </p>
              ) : null}
              {voiceover?.status === "idle" || voiceover?.status === undefined ? (
                <button
                  type="button"
                  onClick={() => onNextAction?.(nextStep.surface, nextStep.id)}
                  className="mt-2 flex min-h-[2rem] w-full cursor-pointer items-center justify-center rounded-lg bg-ios-blue px-3 py-1.5 text-[13px] font-medium text-white hover:bg-ios-blue/90"
                >
                  {VOICEOVER_QUOTE_LABEL}
                </button>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              onClick={() => onNextAction?.(nextStep.surface)}
              className="mt-2 flex min-h-[2rem] w-full cursor-pointer items-center justify-center rounded-lg bg-ios-blue px-3 py-1.5 text-[13px] font-medium text-white hover:bg-ios-blue/90"
            >
              {NEXT_ACTION_LABEL[nextStep.surface]}
            </button>
          )}
          {nextStep.pipelineStep ? (
            <p className="mt-1.5 text-ios-caption2 text-foreground/45">
              流程第 {nextStep.pipelineStep.value} 步 · {nextStep.pipelineStep.label}
            </p>
          ) : null}
        </div>
      ) : null}

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
