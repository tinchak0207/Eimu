// 歷史「再來 N 組／微調變體」：workflow-recall payload 級重跑（MJ --r/Vary 等價）。
//
// 與會話級的 agent 重跑（把 prompt 念回給助理、讓它重新決定參數）不同：這裡把
// 該條歷史記錄的完整配方 payload（HistoryEntry.workflow 六槽 + 模型 + 尺寸）
// 原樣（或按微調覆寫）批量提交到既有 /api/generation-jobs 任務通道——每個任務
// 獨立走帳本預檢，餘額不足會在提交時被 402 擋下，不會先跑後扣。
//
// 衍生關聯：提交時帶 retryOfTaskId 指回源任務。它同時是父鏈（歷史燈箱顯示
// 「衍生自」）與參考圖繼承通道（任務系統按父任務帶回參考圖，前端無需重新
// 上傳）。源記錄不是任務隊列任務（例如同步管道直出）時沒有 taskId，重跑仍
// 可進行，只是無父鏈、參考圖無法自動找回——對話框裡要把這件事說出來。
import { extractPromptSection } from "./workflow-recall";
import { aspectRatioFromImageSize, generationCoins, generationModel } from "./generation-model-catalog";
import { primaryModelId } from "./history-types";
import type { HistoryEntry } from "./history-types";

/** 再来 N 组的组数档位（与工作站张数上限 1..8 对齐的常用选项）。 */
export const HISTORY_RERUN_COUNT_OPTIONS = [1, 2, 3, 5, 8] as const;
export const HISTORY_RERUN_DEFAULT_COUNT = 3;

/** 微调变体允许覆写的字段：只改 prompt 片段、换模型或换尺寸，其余 payload 原样。 */
export interface HistoryRerunOverrides {
  prompt?: string;
  modelId?: string;
  imageSize?: string;
}

/** 一条历史记录的重跑计划：可直接映射为 /api/generation-jobs 的请求体字段。 */
export interface HistoryRerunPlan {
  prompt: string;
  modelId: string;
  aspectRatio: string;
  outputResolution: "1k" | "2k";
  qualityMode: "fast" | "quality";
  /** 原配方 payload（已剥掉 copies/concurrency/estimatedCredits——每个任务单张）。 */
  workflow: Record<string, unknown> | null;
  /** 父任务 id：源记录是任务队列任务时才有；提交时作为 retryOfTaskId 传回。 */
  retryOfTaskId: string | null;
  /** 父任务存在 → 参考图文件可由任务系统继承，无需重新上传。 */
  referencesInheritable: boolean;
  /** 原配方带参考图（仅元数据；文件本身在任务系统里）。 */
  hasReferenceImages: boolean;
}

/**
 * 判定一条历史记录能否 payload 级重跑：有 prompt、有主模型、且是图像模型
 * （视频按时长计费，重跑预估口径不同，先不放开）。
 */
export function canHistoryEntryRerun(entry: HistoryEntry): boolean {
  if (!entry.prompt.trim()) return false;
  const modelId = primaryModelId(entry);
  if (!modelId) return false;
  return generationModel(modelId)?.kind === "image";
}

/**
 * 把历史记录（含微调覆写）折叠成重跑计划。
 *
 * 尺寸覆写会同步写回 workflow 的 imageSize/imageSizes，保证落盘元数据与
 * 实际提交参数一致；质量档沿用原配方的 qualityProfile（print → 2k），
 * 与工作站的档位映射一致。
 */
export function buildHistoryRerunPlan(
  entry: HistoryEntry,
  overrides: HistoryRerunOverrides = {},
): HistoryRerunPlan {
  const modelId = overrides.modelId?.trim() || primaryModelId(entry) || "";
  const prompt = (
    overrides.prompt !== undefined ? overrides.prompt : extractPromptSection(entry.prompt)
  ).trim();
  const overrideSize = overrides.imageSize?.trim() || undefined;
  const imageSize = overrideSize ?? entry.workflow?.imageSize ?? entry.workflow?.imageSizes?.[0];
  const outputResolution: "1k" | "2k" = entry.workflow?.qualityProfile === "print" ? "2k" : "1k";

  const workflow: Record<string, unknown> | null = entry.workflow ? { ...entry.workflow } : null;
  if (workflow) {
    // 每个任务单张：原配方的张数/并发/预估字段不属于单次重跑，剥掉防止误导落盘。
    delete workflow.copies;
    delete workflow.concurrency;
    delete workflow.estimatedCredits;
    if (overrideSize) {
      workflow.imageSize = overrideSize;
      workflow.imageSizes = [overrideSize];
    }
  }

  const retryOfTaskId = entry.taskId?.trim() || null;
  return {
    prompt,
    modelId,
    aspectRatio: aspectRatioFromImageSize(imageSize),
    outputResolution,
    qualityMode: outputResolution === "2k" ? "quality" : "fast",
    workflow,
    retryOfTaskId,
    referencesInheritable: retryOfTaskId !== null,
    hasReferenceImages: Boolean(entry.workflow?.referenceImages?.length),
  };
}

/** 单张费用：由计费配置（含管理员覆写）计算，不写死数字。 */
export function historyRerunCoinsPerImage(plan: HistoryRerunPlan): number {
  return generationCoins(plan.modelId, { resolution: plan.outputResolution });
}

/** N 组预估：单张 × N，四舍五入到 0.1 币。 */
export function historyRerunEstimate(plan: HistoryRerunPlan, count: number): number {
  const perImage = historyRerunCoinsPerImage(plan);
  return Math.round(perImage * Math.max(1, count) * 10) / 10;
}
