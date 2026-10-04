import type { GenerationJob } from "./generation-core/types";
import { generationTaskProjection } from "./generation-core/task-projection";
import { mergeLineageIntoHost, parentsFromReferences } from "./lineage";
import type { LineageLink } from "./lineage";
import type { HistoryEntry } from "./history-types";
import { displayGenerationPrompt } from "./web-task-prompt";

export function generationJobHistoryEntry(job: GenerationJob): HistoryEntry {
  const task = generationTaskProjection(job, { includePrompt: true });
  // REQ-D1 挂钩 a/c（job 面读时透传）：任务本体就带著血统线索——提交的参考图元数据
  // （workflow.references[].sourceGenerationId/sourceResultId）与「再来 N 组」的
  // retry_of_job_id。job 历史记录是读时投影、没有落盘环节可写栏位，所以在这里组装；
  // 存量任务同路径自动可溯，不需要回补。只进给人看的历史视图，agent 零读权。
  const createdAt = job.createdAt.toISOString();
  const parents: LineageLink[] = parentsFromReferences(job.workflow?.references, createdAt);
  if (job.retryOfTaskId) {
    // 「再来 N 组」提交时源记录是任务队列任务：retry_of_job_id 落库，指回源任务。
    parents.push({ kind: "rerun", jobId: job.retryOfTaskId, at: createdAt });
  } else {
    // 源记录没有 taskId（同步直出/本地补录）：重跑计划在配方里带了 sourceHistoryId，
    // 用历史把手 `history-${id}` 组 rerun——同一事实只登记一次，两个分支互斥。
    const sourceHistoryId = job.workflow?.sourceHistoryId;
    if (typeof sourceHistoryId === "string" && sourceHistoryId.trim()) {
      parents.push({ kind: "rerun", assetId: `history-${sourceHistoryId.trim()}`, at: createdAt });
    }
  }
  const lineage = mergeLineageIntoHost(null, parents);
  return {
    id: task.taskId,
    taskId: task.taskId,
    generationId: task.taskId,
    prompt: displayGenerationPrompt(task.prompt, job.workflow) ?? "",
    generatedAt: Date.parse(task.createdAt),
    source: "server",
    modelId: task.modelId,
    workflow: task.submittedConfig.workflow,
    ...(lineage?.lineage ? { lineage: lineage.lineage } : {}),
    ...(lineage?.lineageTruncated ? { lineageTruncated: true } : {}),
    results: task.results.map((result) => ({
      provider: "image_tinchak",
      modelId: task.modelId,
      image: null,
      imageUrl: task.kind === "video_generate" ? null : result.url,
      videoUrl: task.kind === "video_generate" ? result.url : null,
      mediaType: task.kind === "video_generate" ? "video" : "image",
      resultId: result.resultId,
      taskId: task.taskId,
    })),
    primaryResultId: task.primaryResultId,
    retryOfTaskId: task.retryOfTaskId,
    taskStatus: task.status,
    errorCode: task.errorCode,
  };
}
