import { NextRequest, NextResponse } from "next/server";
import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";
import { submitGenerationCommand } from "@/lib/generation-core/command-service";
import { IdempotencyConflictError } from "@/lib/generation-core/job-repository";
import { GenerationModelUnavailableError } from "@/lib/generation-core/model-availability-gate";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { syncModelPricing } from "@/lib/pricing-runtime";
import {
  BatchIdempotencyConflictError,
  batchItemIdempotencyKey,
  batchRequestHash,
  createGenerationBatch,
  listGenerationBatchJobs,
  recordGenerationBatchFailedItems,
  validateBatchItem,
  validateBatchRequestBody,
  type BatchFailedItemRecord,
} from "@/lib/generation-core/batch-service";

export const runtime = "nodejs";
export const maxDuration = 300;
// 与 /v1/images/generations 同区：逐项提交要串行打控制面 DB（建任务+预留计费）。
export const preferredRegion = "sfo1";

/**
 * POST /v1/batches — B 端批量生成（图片/视频混合）。
 *
 * 每项带 kind（image/video；缺省时由 duration_seconds/generate_audio 判别，
 * 再缺省视为 image），栏位与 /v1/images/generations、/v1/videos/generations
 * 的请求体一致。逐项验证：单项失败不炸整批，回应逐项标 accepted/errors。
 * 每项都走同一条 submitGenerationCommand 提交/计费路径（带 batch_id/batch_index），
 * 并发由平台 scheduler 池化治理——max_in_flight 只是声明性栏位。
 * 幂等：batch 级 Idempotency-Key 重复提交回同一批（崩溃后重放会补齐未提交项，
 * 已提交项靠确定性 item 幂等键去重，不重复扣费）。
 */

type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "insufficient_balance"
  | "api_error";

function errorResponse(
  status: number,
  message: string,
  type: OpenAIErrorType,
  code: string,
  traceId: string,
  headers?: Record<string, string>,
) {
  const response = NextResponse.json(
    { error: { message, type, code, param: null, trace_id: traceId } },
    { status, ...(headers ? { headers } : {}) },
  );
  return withTraceId(response, traceId);
}

interface BatchAcceptedItem {
  index: number;
  task_id: string;
  accepted: true;
  task_url: string;
}

interface BatchFailedItem {
  index: number;
  error: { message: string; type: string; code: string; param: null };
}

export async function POST(req: NextRequest) {
  const requestId = Math.random().toString(36).slice(2);
  const traceId = getOrCreateTraceId(req);

  // ── 认证（与单任务端点同一套） ─────────────────────────────
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) {
    const type: OpenAIErrorType =
      auth.status === 429 ? "rate_limit_error" : auth.status === 403 ? "permission_error" : "authentication_error";
    return errorResponse(
      auth.status,
      auth.message,
      type,
      auth.code,
      traceId,
      auth.retryAfterSeconds ? { "Retry-After": String(auth.retryAfterSeconds) } : undefined,
    );
  }
  const apiKey = auth.key;

  // ── 解析与批级验证 ─────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "请求体不是合法的 JSON。", "invalid_request_error", "invalid_json", traceId);
  }

  const validated = validateBatchRequestBody(body);
  if (!validated.ok) {
    return errorResponse(400, validated.message, "invalid_request_error", validated.code, traceId);
  }
  const { requests, maxInFlight } = validated;

  // 管理员改价需立即对扣费生效：与单任务端点同一个计费共同上游。
  await syncModelPricing();

  if (!generationControlPlaneEnabled()) {
    return errorResponse(
      503,
      "Batch generation only supports the durable control plane, which is currently unavailable.",
      "api_error",
      "control_plane_unavailable",
      traceId,
    );
  }

  // ── 幂等建立批记录 ─────────────────────────────────────────
  const tenantId = `biz:${apiKey.id}`;
  const requestHash = batchRequestHash(requests);
  let batch;
  let created;
  try {
    const result = await createGenerationBatch({
      tenantId,
      totalCount: requests.length,
      maxInFlight,
      idempotencyKey: req.headers.get("idempotency-key"),
      requestHash,
    });
    batch = result.batch;
    created = result.created;
  } catch (error) {
    if (error instanceof BatchIdempotencyConflictError) {
      return errorResponse(409, error.message, "invalid_request_error", "idempotency_key_reused", traceId);
    }
    console.error(`[biz-batch] batch creation failed requestId=${requestId}`, error);
    return errorResponse(503, "Generation control plane is temporarily unavailable.", "api_error", "control_plane_unavailable", traceId);
  }

  // ── 逐项提交（同一条 submitGenerationCommand 路径） ─────────
  // 幂等重放：先捞出这批已存在的任务，已提交项直接回既有 task_id，
  // 只对缺失项补提交（崩溃恢复）；全部逻辑与首次提交同一条路。
  const priorJobs = created ? [] : await listGenerationBatchJobs(batch.id);
  const priorByIndex = new Map(priorJobs.map((job) => [job.batchIndex ?? 0, job]));

  const items: BatchAcceptedItem[] = [];
  const failedItems: BatchFailedItem[] = [];

  for (let index = 0; index < requests.length; index += 1) {
    const prior = priorByIndex.get(index);
    if (prior) {
      const kindPath = prior.kind === "video_generate" ? "videos" : "images";
      items.push({ index, task_id: prior.id, accepted: true, task_url: `/v1/${kindPath}/${prior.id}` });
      continue;
    }

    const validatedItem = validateBatchItem(requests[index], index, apiKey);
    if (!validatedItem.ok) {
      failedItems.push({ index, error: { ...validatedItem.error, param: null } });
      continue;
    }

    const plan = validatedItem.plan;
    try {
      const submitted = await submitGenerationCommand({
        tenantId,
        apiKeyId: apiKey.id,
        billingUserId: apiKey.userId,
        source: "biz",
        idempotencyKey: batchItemIdempotencyKey(batch.id, index),
        batchId: batch.id,
        batchIndex: index,
        kind: plan.kind,
        routingClass: plan.routingClass,
        modelId: plan.modelId,
        prompt: plan.prompt,
        size: plan.size,
        ratio: plan.ratio,
        resolution: plan.resolution,
        quality: plan.quality,
        ...(plan.workflow ? { workflow: plan.workflow } : {}),
        responseFormat: plan.responseFormat,
        callbackUrl: plan.callbackUrl,
        requestedCount: plan.requestedCount,
        billingAmount: plan.billingAmount,
      });
      const kindPath = submitted.job.kind === "video_generate" ? "videos" : "images";
      items.push({
        index,
        task_id: submitted.job.id,
        accepted: true,
        task_url: `/v1/${kindPath}/${submitted.job.id}`,
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        failedItems.push({
          index,
          error: { message: error.message, type: "invalid_request_error", code: "idempotency_key_reused", param: null },
        });
        continue;
      }
      // 模型可用性闸：该项建单/扣费前拒绝，逐项诚实回报（其余项照常提交）。
      if (error instanceof GenerationModelUnavailableError) {
        failedItems.push({
          index,
          error: { message: error.message, type: "api_error", code: "no_endpoints", param: null },
        });
        continue;
      }
      console.error(`[biz-batch] item submission failed requestId=${requestId} batchId=${batch.id} index=${index}`, error);
      failedItems.push({
        index,
        error: { message: "任务提交失败，请重试该项。", type: "api_error", code: "submission_failed", param: null },
      });
    }
  }

  // 逐项失败快照落盘：聚合视图与对账要能按 index 对回拒绝原因。
  const failedRecords: BatchFailedItemRecord[] = failedItems.map((item) => ({
    index: item.index,
    code: item.error.code,
    message: item.error.message,
    type: item.error.type,
  }));
  try {
    await recordGenerationBatchFailedItems(batch.id, failedRecords);
  } catch (error) {
    console.error(`[biz-batch] failed-items snapshot write failed requestId=${requestId} batchId=${batch.id}`, error);
  }

  console.log(
    `[biz-batch] requestId=${requestId}, keyId=${apiKey.id}, batchId=${batch.id}, total=${requests.length}, accepted=${items.length}, failed=${failedItems.length}, replay=${!created}`,
  );

  const response = NextResponse.json(
    {
      object: "image_generation.batch",
      id: batch.id,
      batch_id: batch.id,
      status: batch.status,
      total_count: batch.totalCount,
      max_in_flight: batch.maxInFlight,
      created: Math.floor(batch.createdAt.getTime() / 1000),
      created_at: batch.createdAt.toISOString(),
      idempotent_replay: !created,
      items,
      failed_items: failedItems,
      counts: { accepted: items.length, failed: failedItems.length },
      batch_url: `/v1/batches/${batch.id}`,
    },
    {
      status: 202,
      headers: { Location: `/v1/batches/${batch.id}` },
    },
  );
  return withTraceId(addRateLimitHeaders(response, apiKey), traceId);
}

/** 明确拒绝其他方法，避免聚合平台探测时收到 405 之外的怪结果。 */
export function GET(req: NextRequest) {
  return errorResponse(
    405,
    "该端点只接受 POST。批状态请调用 GET /v1/batches/{id}。",
    "invalid_request_error",
    "method_not_allowed",
    getOrCreateTraceId(req),
  );
}
