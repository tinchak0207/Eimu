import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import {
  buildBatchItems,
  computeBatchAggregate,
  finalizeGenerationBatchIfTerminal,
  getGenerationBatchForTenant,
  listGenerationBatchJobs,
} from "@/lib/generation-core/batch-service";

export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function errorResponse(status: number, message: string, code: string, traceId: string, key?: BizApiKey) {
  let response: Response = NextResponse.json(
    { error: { message, type: "invalid_request_error", code, param: null, trace_id: traceId } },
    { status },
  );
  if (key) response = addRateLimitHeaders(response, key, { consumed: false });
  return withTraceId(response, traceId);
}

/**
 * GET /v1/batches/:id — 批量聚合视图。
 *
 * counts 按 OpenAI 相容投影（pending/running/succeeded/failed/cancelled/refunded）
 * 分桶；批终结判定 = 全部已提交项终结（部分成功语义：任何时刻 succeeded 的项
 * 都可经既有 /v1/images/:id/result（或 videos）取件，不必等整批）。轮询端点
 * 不消耗限流额度，与 /v1/images/:id 一致。
 */
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const traceId = getOrCreateTraceId(req);
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")), {
    consumeRateLimit: false,
  });
  if (!auth.ok) return errorResponse(auth.status, auth.message, auth.code, traceId);
  const { id } = await context.params;

  const batch = await getGenerationBatchForTenant(id, `biz:${auth.key.id}`);
  if (!batch) return errorResponse(404, "Generation batch was not found.", "batch_not_found", traceId, auth.key);

  const jobs = await listGenerationBatchJobs(batch.id);
  // 读取时惰性收敛：全部终结 → completed（编排层唯一状态写入，best-effort）。
  const finalized = await finalizeGenerationBatchIfTerminal(batch, jobs);
  const aggregate = computeBatchAggregate(finalized, jobs);
  const items = buildBatchItems(finalized, jobs);

  const response = addRateLimitHeaders(
    NextResponse.json(
      {
        object: "image_generation.batch",
        id: finalized.id,
        batch_id: finalized.id,
        status: aggregate.status,
        total_count: finalized.totalCount,
        max_in_flight: finalized.maxInFlight,
        counts: aggregate.counts,
        billing: aggregate.billing,
        items,
        created: Math.floor(finalized.createdAt.getTime() / 1000),
        created_at: finalized.createdAt.toISOString(),
        completed_at: finalized.completedAt ? finalized.completedAt.toISOString() : null,
        batch_url: `/v1/batches/${finalized.id}`,
        reconciliation_url: `/v1/batches/${finalized.id}/reconciliation`,
      },
      { headers: { "Cache-Control": "no-store" } },
    ),
    auth.key,
    { consumed: false },
  );
  return withTraceId(response, traceId);
}
