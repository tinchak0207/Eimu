import { normalizeGenerationConfig } from "../generation-model-catalog";
import type { GenerationTaskProjection } from "../generation-task-types";
import type { GenerationWorkflowMetadata } from "../image-types";
import { decryptGenerationPrompt } from "./crypto";
import { failureClassToApiErrorCode } from "../api-error-codes";
import { taskStatus } from "./task-response";
import type { GenerationJob } from "./types";

export function generationTaskProjection(job: GenerationJob, options: { includePrompt?: boolean } = {}): GenerationTaskProjection {
  const workflow = job.workflow as GenerationWorkflowMetadata;
  const normalized = normalizeGenerationConfig(job.modelId, {
    aspectRatio: job.ratio ?? undefined,
    outputResolution: job.resolution ?? undefined,
    durationSeconds: typeof job.workflow.durationSeconds === "number" ? job.workflow.durationSeconds : undefined,
    generateAudio: typeof job.workflow.generateAudio === "boolean" ? job.workflow.generateAudio : undefined,
    qualityMode: job.quality ?? undefined,
    referenceCount: job.workflow.references?.length ?? 0,
    loraModelVersionIds: Array.isArray(job.workflow.loraModelVersionIds)
      ? job.workflow.loraModelVersionIds.map(String)
      : [],
  }).config;
  const results = (job.result?.artifacts ?? []).map((artifact) => ({
    resultId: artifact.id,
    taskId: job.id,
    outputIndex: artifact.outputIndex,
    url: artifact.url,
    mimeType: artifact.mimeType,
    width: artifact.width,
    height: artifact.height,
  }));
  const status = taskStatus(job);
  return {
    taskId: job.id,
    status,
    modelId: job.modelId,
    kind: job.kind,
    submittedConfig: { ...normalized, workflow },
    ...(options.includePrompt ? { prompt: decryptGenerationPrompt(job.promptCiphertext) } : {}),
    resultIds: results.map((result) => result.resultId),
    ...(job.primaryResultId ?? results[0]?.resultId ? { primaryResultId: job.primaryResultId ?? results[0]?.resultId } : {}),
    results,
    requestedCount: job.requestedCount,
    completedCount: job.completedCount,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    ...(job.startedAt ? { startedAt: job.startedAt.toISOString() } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt.toISOString() } : {}),
    ...(job.retryOfTaskId ? { retryOfTaskId: job.retryOfTaskId } : {}),
    ...(status === "failed" || status === "cancelled" || status === "refunded" || status === "unknown"
      ? {
          errorCode: failureClassToApiErrorCode(job.failureClass ?? "unknown"),
          errorMessage: job.failureDetail ?? "Generation failed.",
        }
      : {}),
  };
}
