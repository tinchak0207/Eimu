import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import {
  buildBatchReconciliationItems,
  computeBatchAggregate,
  computeBatchFailureBreakdown,
  finalizeGenerationBatchIfTerminal,
  getGenerationBatchForTenant,
  listGenerationBatchJobs,
} from "@/lib/generation-core/batch-service";

export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

function errorResponse(status: number, message: string, code: string, traceId: string, key?: BizApiKey) {
  let response: Response = NextResponse.json(
    { error: { message, type: "invalid_request_error", code, param: null, trace_id: traceId } },
    { status },
  );
  if (key) response = addRateLimitHeaders(response, key, { consumed: false });
  return withTraceId(response, traceId);
}

/**
 * GET /v1/batches/:id/reconciliation — 對賬導出（JSON；CSV 後續可加）。
 *
 * 服務 B 端月結對賬：任務 ID、成功/失敗數、逐項失敗原因 class、
 * 計費金額彙總（charged = succeeded 合計——失敗退費=按成功計費；
 * refunded = 非成功終結項退回合計；pending = 在途預留）。輪詢不消耗限流額度。
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
  const finalized = await finalizeGenerationBatchIfTerminal(batch, jobs);
  const aggregate = computeBatchAggregate(finalized, jobs);
  const items = buildBatchReconciliationItems(finalized, jobs);
  const failureBreakdown = computeBatchFailureBreakdown(finalized, jobs);

  const response = addRateLimitHeaders(
    NextResponse.json(
      {
        object: "image_generation.batch_reconciliation",
        batch_id: finalized.id,
        status: aggregate.status,
        totals: aggregate.counts,
        billing: aggregate.billing,
        failure_breakdown: failureBreakdown,
        items,
        created_at: finalized.createdAt.toISOString(),
        completed_at: finalized.completedAt ? finalized.completedAt.toISOString() : null,
        generated_at: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    ),
    auth.key,
    { consumed: false },
  );
  return withTraceId(response, traceId);
}
