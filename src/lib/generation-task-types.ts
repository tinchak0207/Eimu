import type { NormalizedGenerationConfig } from "./generation-model-catalog";
import type { GenerationWorkflowMetadata } from "./image-types";

export type PublicGenerationTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "refunded"
  | "unknown";

export interface GenerationTaskResultProjection {
  resultId: string;
  taskId: string;
  outputIndex: number;
  url: string | null;
  mimeType: string;
  width: number;
  height: number;
}

export interface GenerationTaskProjection {
  taskId: string;
  status: PublicGenerationTaskStatus;
  modelId: string;
  kind: "image_generate" | "image_edit" | "video_generate";
  submittedConfig: NormalizedGenerationConfig & { workflow?: GenerationWorkflowMetadata };
  prompt?: string;
  resultIds: string[];
  primaryResultId?: string;
  results: GenerationTaskResultProjection[];
  requestedCount: number;
  completedCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  retryOfTaskId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export function mergeGenerationTaskProjections(
  current: GenerationTaskProjection[],
  incoming: GenerationTaskProjection[],
): GenerationTaskProjection[] {
  const byId = new Map(current.map((task) => [task.taskId, task]));
  for (const task of incoming) {
    const existing = byId.get(task.taskId);
    if (!existing || Date.parse(task.updatedAt) >= Date.parse(existing.updatedAt)) byId.set(task.taskId, task);
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
