import type { GenerationJob } from "./types";

export function taskStatus(job: GenerationJob): "queued" | "running" | "succeeded" | "failed" | "cancelled" | "refunded" | "unknown" {
  if (job.status === "queued" || job.status === "pending_billing") return "queued";
  if (job.status === "leased" || job.status === "submitting" || job.status === "running") return "running";
  if (job.status === "succeeded") return "succeeded";
  if (job.status === "cancelled") return "cancelled";
  if (job.status === "refunded") return "refunded";
  if (job.status === "billing_unknown" || job.status === "submit_unknown") return "unknown";
  return "failed";
}

export function generationTaskResponse(job: GenerationJob) {
  const status = taskStatus(job);
  return {
    object: "image_generation.task",
    id: job.id,
    task_id: job.id,
    status,
    created: Math.floor(job.createdAt.getTime() / 1000),
    model: job.modelId,
    requested_count: job.requestedCount,
    completed_count: job.completedCount,
    primary_result_id: job.primaryResultId ?? job.result?.artifacts[0]?.id ?? null,
    result_ids: job.result?.artifacts.map((artifact) => artifact.id) ?? [],
    retry_of_task_id: job.retryOfTaskId,
    task_url: `/v1/${job.kind === "video_generate" ? "videos" : "images"}/${job.id}`,
    request_config: {
      model: job.modelId,
      ...(job.size ? { size: job.size } : {}),
      n: job.requestedCount,
      ...(job.quality ? { quality: job.quality } : {}),
      ...(job.responseFormat ? { response_format: job.responseFormat } : {}),
      ...(typeof (job.workflow as { prompt?: unknown }).prompt === "string"
        ? { prompt: ((job.workflow as { prompt?: string }).prompt ?? "").slice(0, 500) }
        : {}),
    },
    ...(status === "succeeded" ? { result_url: `/v1/${job.kind === "video_generate" ? "videos" : "images"}/${job.id}/result`, data: job.result?.artifacts ?? [] } : {}),
    ...(job.failureClass ? { error: failureError(job) } : {}),
  };
}

/**
 * 失敗信息。
 *
 * overloaded 原本只回一句「No eligible supplier capacity is currently available.」，
 * 客戶分不清是「這個模型根本沒註冊供應商」「供應商全下線」還是「額度打滿」——
 * 三種情況的處置完全不同（找我們開通 / 等恢復 / 換小並發）。
 * worker 把調度器的診斷寫成 `reason: detail`，這裡拆回獨立字段，
 * 讓 code 保持可判等，同時把具體原因單獨給出來。
 */
function failureError(job: GenerationJob) {
  const detail = job.failureDetail ?? "Generation failed.";
  // 用 [\s\S] 而不是 /s 标志：tsconfig 的 target 低于 es2018。
  const match = /^([a-z_]+):\s*([\s\S]+)$/.exec(detail);
  if (job.failureClass === "overloaded" && match) {
    return { code: job.failureClass, reason: match[1], message: match[2] };
  }
  return { code: job.failureClass, message: detail };
}
