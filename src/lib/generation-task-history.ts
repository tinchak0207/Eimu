import type { GenerationJob } from "./generation-core/types";
import { generationTaskProjection } from "./generation-core/task-projection";
import type { HistoryEntry } from "./history-types";

export function generationJobHistoryEntry(job: GenerationJob): HistoryEntry {
  const task = generationTaskProjection(job, { includePrompt: true });
  return {
    id: task.taskId,
    taskId: task.taskId,
    generationId: task.taskId,
    prompt: task.prompt ?? "",
    generatedAt: Date.parse(task.createdAt),
    source: "server",
    modelId: task.modelId,
    workflow: task.submittedConfig.workflow,
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
