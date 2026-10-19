import { normalizeGenerationConfig } from "../generation-model-catalog";
import type { AspectRatio, NormalizedGenerationConfig, OutputResolution } from "../generation-model-catalog";
import type { GenerationTaskProjection } from "../generation-task-types";
import type { GenerationWorkflowMetadata } from "../image-types";
import { decryptGenerationPrompt } from "./crypto";
import { failureClassToApiErrorCode } from "../api-error-codes";
import { taskStatus } from "./task-response";
import type { GenerationJob } from "./types";

/**
 * 未知模型的最小投影配置：只用 job 自身栏位，不猜任何默认档位。
 * 单条未知模型（如 `master-ingest-service` 写入的 film_export / `timeline_master`）
 * 不得让整个任务列表 500（2026-10-19 实测：VPS 近 96 小时 6127 次列表请求全部 500，
 * 唯一错误就是 `Unsupported generation model: timeline_master`）。正常模型仍走
 * normalizeGenerationConfig，行为不变。
 */
function fallbackNormalizedConfig(job: GenerationJob): NormalizedGenerationConfig {
  const durationSeconds = typeof job.workflow.durationSeconds === "number" ? job.workflow.durationSeconds : undefined;
  const generateAudio = typeof job.workflow.generateAudio === "boolean" ? job.workflow.generateAudio : undefined;
  return {
    modelId: job.modelId,
    mediaType: job.kind === "video_generate" || job.kind === "avatar" || job.kind === "lipsync" ? "video" : "image",
    aspectRatio: (job.ratio ? job.ratio : "1:1") as AspectRatio,
    outputResolution: (job.resolution ? job.resolution : "1k") as OutputResolution,
    qualityMode: job.quality === "quality" ? "quality" : "fast",
    referenceCount: job.workflow.references?.length ?? 0,
    loraModelVersionIds: Array.isArray(job.workflow.loraModelVersionIds)
      ? job.workflow.loraModelVersionIds.map(String)
      : [],
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(generateAudio !== undefined ? { generateAudio } : {}),
  };
}

export function generationTaskProjection(job: GenerationJob, options: { includePrompt?: boolean } = {}): GenerationTaskProjection {
  const workflow = job.workflow as GenerationWorkflowMetadata;
  let normalized: NormalizedGenerationConfig;
  try {
    normalized = normalizeGenerationConfig(job.modelId, {
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
  } catch {
    // 单条未知模型不得让整个任务列表 500（2026-10-19 实测）。
    normalized = fallbackNormalizedConfig(job);
  }
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
