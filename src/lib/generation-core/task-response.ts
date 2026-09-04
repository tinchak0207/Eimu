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
 * job kind → 對外 REST 路徑段。圖像走 /v1/images、影片走 /v1/videos、
 * AV 成片鏈路（配音/數字人/唇形）各走自己的資源名。
 */
export function taskResourcePath(kind: GenerationJob["kind"]): "images" | "videos" | "tts" | "avatar" | "lipsync" {
  if (kind === "video_generate") return "videos";
  if (kind === "tts" || kind === "avatar" || kind === "lipsync") return kind;
  return "images";
}

export interface GenerationTaskResponseOptions {
  /** succeeded 任務的真實花費（幣）。null/undefined = 查無，欄位省略。 */
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
 * succeeded 任務的真實花費（幣）= billing_operation 該 job 最新一筆
 * operation='commit' 且 status='applied' 的 amount / 500000
 * （例如 amount=485 → 0.00097 幣，與 gateway ledger 的 cost_coins 同源）。
 * 查無行、控制面 DB 未配置或查詢失敗時返回 null，回應省略 cost_coins
 * 欄位（客戶端有「費用以平台账单为准」兜底）。只讀查詢，不參與任何計費寫入。
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
