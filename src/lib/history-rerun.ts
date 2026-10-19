// 历史「再来 N 组／微调变体」：workflow-recall payload 级重跑（MJ --r/Vary 等价）。
//
// 与会话级的 agent 重跑（把 prompt 念回给助理、让它重新决定参数）不同：这里把
// 该条历史记录的完整配方 payload（HistoryEntry.workflow 六槽 + 模型 + 尺寸）
// 原样（或按微调覆写）批量提交到既有 /api/generation-jobs 任务通道——每个任务
// 独立走帐本预检，余额不足会在提交时被 402 挡下，不会先跑后扣。
//
// 衍生关联：提交时带 retryOfTaskId 指回源任务。它同时是父链（历史灯箱显示
// 「衍生自」）与参考图继承通道（任务系统按父任务带回参考图，前端无需重新
// 上传）。源记录不是任务队列任务（例如同步管道直出）时没有 taskId，重跑仍
// 可进行，只是无父链、参考图无法自动找回——对话框里要把这件事说出来。
import { extractPromptSection } from "./workflow-recall";
import { aspectRatioFromImageSize, generationCoins, generationModel } from "./generation-model-catalog";
import { inferEntryKind, primaryModelId } from "./history-types";
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
 *
 * workflow 记录没有「一个」主模型——模型是各节点各自的事，历史卡上的模型字段
 * 往往是空的，用图像模型清单去卡会把整类工作流记录判成不可重跑。它的配方完整
 * 性由 workflow 自身保证，所以这里直接放行，让「再来 N 组／微调变体」可用。
 */
export function canHistoryEntryRerun(entry: HistoryEntry): boolean {
  if (!entry.prompt.trim()) return false;
  const modelId = primaryModelId(entry);
  if (!modelId) return false;
  if (inferEntryKind(entry) === "workflow") return true;
  return generationModel(modelId)?.kind === "image";
}

/**
 * workflow 记录在 workflow 字段上额外挂了 DAG 结构（节点/连线）与后端渲染好的
 * 缩略图 URL。这三个是前端展示与后端落盘用的，不是 /api/generation-jobs 的提交
 * 参数：原样带上会让 DAG 被当成配方写回新任务（新任务的 DAG 由它自己展开）。
 * 与 copies/concurrency/estimatedCredits 同一处理方式——提交前剥掉。
 */
const WORKFLOW_DISPLAY_ONLY_KEYS = ["dagNodes", "dagConnections", "dagThumbnailUrl"] as const;

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

  const workflow: Record<string, unknown> | null = entry.workflow ? { ...entry.workflow } : {};
  if (workflow) {
    // 每个任务单张：原配方的张数/并发/预估字段不属于单次重跑，剥掉防止误导落盘。
    delete workflow.copies;
    delete workflow.concurrency;
    delete workflow.estimatedCredits;
    for (const key of WORKFLOW_DISPLAY_ONLY_KEYS) delete workflow[key];
    if (overrideSize) {
      workflow.imageSize = overrideSize;
      workflow.imageSizes = [overrideSize];
    }
    // REQ-D1 挂钩 c：源记录 id 随配方带上——源不是任务队列任务（无 taskId，
    // retry_of_job_id 无处可落）时，job 投影仍能从这个栏位组出 rerun 血统；
    // 有 taskId 时它只是冗余旁注，投影以 retryOfTaskId 为准。
    workflow.sourceHistoryId = entry.id;
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
