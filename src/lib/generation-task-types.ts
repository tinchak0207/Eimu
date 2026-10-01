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
  /** 實測尺寸；成片（G4）probe 缺失時為 null——禁止 0 冒充。 */
  width: number | null;
  height: number | null;
}

export interface GenerationTaskProjection {
  taskId: string;
  status: PublicGenerationTaskStatus;
  modelId: string;
  kind: "image_generate" | "image_edit" | "video_generate" | "tts" | "avatar" | "lipsync";
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

/** 任務列表指紋：id＋狀態＋更新時間＋完成數。同指紋＝伺服器端沒有任何變化，前端不必寫 state。 */
export function generationTaskListSignature(tasks: readonly GenerationTaskProjection[]): string {
  return tasks.map((t) => `${t.taskId}:${t.status}:${t.updatedAt}:${t.completedCount}`).join("|");
}

export const GENERATION_SYNC_LIVE_MS = 3_000;
export const GENERATION_SYNC_IDLE_MS = 30_000;

/** 下一次同步的延遲：分頁隱藏＝不排（回到前景再補）；有任務在跑 3s；閒置 30s（仍能發現別處提交的任務）。 */
export function nextGenerationSyncDelay({ hidden, hasLiveTasks }: { hidden: boolean; hasLiveTasks: boolean }): number | null {
  if (hidden) return null;
  return hasLiveTasks ? GENERATION_SYNC_LIVE_MS : GENERATION_SYNC_IDLE_MS;
}

