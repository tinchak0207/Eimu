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
 * GET /v1/batches/:id — 批量聚合視圖。
 *
 * counts 按 OpenAI 相容投影（pending/running/succeeded/failed/cancelled/refunded）
 * 分桶；批終結判定 = 全部已提交項終結（部分成功語義：任何時刻 succeeded 的項
 * 都可經既有 /v1/images/:id/result（或 videos）取件，不必等整批）。輪詢端點
 * 不消耗限流額度，與 /v1/images/:id 一致。
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
  // 讀取時惰性收斂：全部終結 → completed（編排層唯一狀態寫入，best-effort）。
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
