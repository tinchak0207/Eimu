import type { GenerationJob } from "./types";
import { generationDatabaseConfigured, getGenerationSql } from "./database";

export function taskStatus(job: GenerationJob): "queued" | "running" | "succeeded" | "failed" | "cancelled" | "refunded" | "unknown" {
  if (job.status === "queued" || job.status === "pending_billing") return "queued";
  if (job.status === "leased" || job.status === "submitting" || job.status === "running") return "running";
  if (job.status === "succeeded") return "succeeded";
  if (job.status === "cancelled") return "cancelled";
  if (job.status === "refunded") return "refunded";
  if (job.status === "billing_unknown" || job.status === "submit_unknown") return "unknown";
  return "failed";
}

/**
 * job kind → 对外 REST 路径段。图像走 /v1/images、影片走 /v1/videos、
 * AV 成片链路（配音/数字人/唇形）各走自己的资源名。
 */
export function taskResourcePath(kind: GenerationJob["kind"]): "images" | "videos" | "tts" | "avatar" | "lipsync" {
  if (kind === "video_generate") return "videos";
  if (kind === "tts" || kind === "avatar" || kind === "lipsync") return kind;
  return "images";
}

export interface GenerationTaskResponseOptions {
  /** succeeded 任务的真实花费（币）。null/undefined = 查无，栏位省略。 */
  costCoins?: number | null;
}

export function generationTaskResponse(job: GenerationJob, options: GenerationTaskResponseOptions = {}) {
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
    task_url: `/v1/${taskResourcePath(job.kind)}/${job.id}`,
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
    ...(status === "succeeded"
      ? {
          result_url: `/v1/${taskResourcePath(job.kind)}/${job.id}/result`,
          data: job.result?.artifacts ?? [],
          ...(typeof options.costCoins === "number" ? { cost_coins: options.costCoins } : {}),
        }
      : {}),
    ...(job.failureClass ? { error: failureError(job) } : {}),
  };
}

/**
 * succeeded 任务的真实花费（币）= billing_operation 该 job 最新一笔
 * operation='commit' 且 status='applied' 的 amount / 500000
 * （例如 amount=485 → 0.00097 币，与 gateway ledger 的 cost_coins 同源）。
 * 查无行、控制面 DB 未配置或查询失败时返回 null，回应省略 cost_coins
 * 栏位（客户端有「费用以平台账单为准」兜底）。只读查询，不参与任何计费写入。
 */
export async function resolveTaskCostCoins(jobId: string): Promise<number | null> {
  if (!generationDatabaseConfigured()) return null;
  try {
    const sql = getGenerationSql();
    const rows = await sql<{ amount: string | number }[]>`
      SELECT operation.amount
      FROM billing_operation operation
      WHERE operation.job_id = ${jobId}
        AND operation.operation = 'commit'
        AND operation.status = 'applied'
      ORDER BY operation.updated_at DESC
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    return Math.round((Number(rows[0].amount) / 500000) * 1e6) / 1e6;
  } catch (error) {
    console.error("[task-response] cost_coins lookup failed", { jobId, error: String(error) });
    return null;
  }
}

/**
 * 失败信息。
 *
 * overloaded 原本只回一句「No eligible supplier capacity is currently available.」，
 * 客户分不清是「这个模型根本没注册供应商」「供应商全下线」还是「额度打满」——
 * 三种情况的处置完全不同（找我们开通 / 等恢复 / 换小并发）。
 * worker 把调度器的诊断写成 `reason: detail`，这里拆回独立字段，
 * 让 code 保持可判等，同时把具体原因单独给出来。
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
