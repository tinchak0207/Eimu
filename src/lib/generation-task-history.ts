import type { GenerationJob } from "./generation-core/types";
import { generationTaskProjection } from "./generation-core/task-projection";
import { mergeLineageIntoHost, parentsFromReferences } from "./lineage";
import type { LineageLink } from "./lineage";
import type { HistoryEntry } from "./history-types";
import { displayGenerationPrompt } from "./web-task-prompt";

export function generationJobHistoryEntry(job: GenerationJob): HistoryEntry {
  const task = generationTaskProjection(job, { includePrompt: true });
  // REQ-D1 掛鉤 a/c（job 面讀時透傳）：任務本體就帶著血統線索——提交的參考圖元數據
  // （workflow.references[].sourceGenerationId/sourceResultId）與「再來 N 組」的
  // retry_of_job_id。job 歷史記錄是讀時投影、沒有落盤環節可寫欄位，所以在這裡組裝；
  // 存量任務同路徑自動可溯，不需要回補。只進给人看的歷史視圖，agent 零讀權。
  const createdAt = job.createdAt.toISOString();
  const parents: LineageLink[] = parentsFromReferences(job.workflow?.references, createdAt);
  if (job.retryOfTaskId) {
    // 「再來 N 組」提交時源記錄是任務隊列任務：retry_of_job_id 落庫，指回源任務。
    parents.push({ kind: "rerun", jobId: job.retryOfTaskId, at: createdAt });
  } else {
    // 源記錄沒有 taskId（同步直出/本地補錄）：重跑計劃在配方裡帶了 sourceHistoryId，
    // 用歷史把手 `history-${id}` 組 rerun——同一事實只登記一次，兩個分支互斥。
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
