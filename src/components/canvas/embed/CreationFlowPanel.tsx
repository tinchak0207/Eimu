"use client";

// CreationFlowPanel —— 作品 / 剧集面板（2026-09-16 G2）。
//
// 修的是 PRD「刀 1 全链生效定义」的第 2 环：「canvas 面板可见」。
// 资料链完全复用既有出口，本档不新增任何型别或储存：
//   hook `projectType` / `currentStep` / `episodes`（刀 1 三栏，唯一写入口 setProjectMeta）
//   ＋ `summarizeCreationFlow`（纯资料层，`src/lib/canvas/creation-flow-panel.ts`）。
//
// 挂法照 角色/场景卡面板（同层 `ce-embed-leftpop` 左侧弹层 + 顶栏 chip 开关），
// 不新建页面树。视觉沿用 lg-sheet 材料 + ios-* 字级（DESIGN.md：正文 ≥13px）。
//
// 诚实边界：**不显示「完成进度 N/M」百分比**——本站没有「一镜完成」的建模栏位，
// 把「已落画布镜数 / 场景计画镜数」写成「完成度」就是灌水（D2 缺口的正确解法是
// 呈现真实计数，不是造一个好看的百分比）。

import type {
  CreationFlowSummary,
  CreationNextStepId,
  CreationNextSurface,
  NextCreationStep,
} from "@/lib/canvas/creation-flow-panel";
import { CREATION_STEPS } from "@/lib/creation-flow-steps";

/** 主按钮文案（依动作面；`none` 不渲染，故不入表）。简体，照本面板既有文案体例。 */
const NEXT_ACTION_LABEL: Record<Exclude<CreationNextSurface, "none">, string> = {
  agent: "交给 AI 助理",
  "canvas-generation": "打开分镜处理",
};

/**
 * 「补齐配音」（`id === "shot-audio"`）的主动作文案：**先试算费用**（干跑，不扣费），
 * 确认键才真跑。与其他 id 的 `NEXT_ACTION_LABEL` 分开，因为它不是「打开某个面」而是生成。
 */
const VOICEOVER_QUOTE_LABEL = "补齐配音（先试算费用）";

/**
 * 配音流程的显示状态（**主体是宿主 CanvasEmbedOverlays 的 state**；本面板只负责印出来）。
 *
 * 币数栏位一律由**伺服器回应**填写：`estimatedCoins`＝干跑报价、`costCoins`＝真跑实扣。
 * 面板端零计算（成本公式是伺服器的事）。
 */
export interface VoiceoverFlowView {
  status: "idle" | "quoting" | "quoted" | "applying" | "applied" | "refused" | "error";
  /** 台词行数（伺服器回）。 */
  lineCount?: number;
  /** 总字数（伺服器回）。 */
  totalChars?: number;
  /** 干跑报价币数（伺服器回）。 */
  estimatedCoins?: number;
  /** 真跑实扣币数（伺服器回）。 */
  costCoins?: number;
  /** 失败／被拒原因（伺服器回或传输错误；如实显示，不美化）。 */
  reason?: string;
}

export interface CreationFlowPanelProps {
  summary: CreationFlowSummary;
  /**
   * 由当前现况推导的**唯一下一步**（一步一跳；`deriveNextStep`，2026-09-30）。
   * `id === "unknown"`（资料不足以判断）或 `surface === "none"`（终态）时不渲染——
   * 不给假动作。缺席＝本面板不显示引导。
   */
  nextStep?: NextCreationStep;
  /**
   * 主动作：依 `surface` 导向既有入口（宿主提供，面板不自己找路）。
   * 「补齐配音」需要知道**是哪一个 next step**（同为 `canvas-generation` 的还有补图／补影），
   * 故补上第二个可选参数 `id`；既有呼叫端只读 `surface`，行为不变。
   */
  onNextAction?: (surface: CreationNextSurface, id?: CreationNextStepId) => void;
  /** 配音流程状态（宿主 state；缺席＝本面板不渲染配音报价区）。 */
  voiceover?: VoiceoverFlowView;
  /** 确认键：使用者同意报价后才真跑（`dryRun: false`）。 */
  onVoiceoverConfirm?: () => void;
  /** 关闭面板（点标题列关闭钮）。 */
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

      {/* 下一步（一步一跳）：同一时刻只渲染一个，且排在面板内容最前＝打开就看到。
          由当前现况推导（不读任何持久化标记）；unknown＝资料不足以判断、none＝终态，
          两者都不渲染，不给假动作。主按钮导向既有入口（宿主提供 `onNextAction`）。 */}
      {nextStep && nextStep.id !== "unknown" && nextStep.surface !== "none" ? (
        <div className="border-b bg-ios-blue/5 px-3 py-2.5">
          <p className="text-[11px] font-medium uppercase leading-none tracking-[0.18em] text-ios-blue/70">
            下一步
          </p>
          <p className="mt-1.5 text-[13px] font-medium leading-snug text-foreground">{nextStep.label}</p>
          {/* 补齐配音：主动作＝先干跑试算（不扣费），报价与行数/字数如实显示，
              使用者按确认键才真跑。失败／被拒一律显示原因，不假成功。 */}
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
                  {/* 7 步骨架：纯位置指示（哪一步），不是进度百分比 */}
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
