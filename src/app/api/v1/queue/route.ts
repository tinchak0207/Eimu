import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import {
  bizTenantId,
  listTenantActiveJobs,
  queryWhenReady,
  toJobStatusSnapshot,
} from "@/lib/generation-core/status-query";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";

function errorResponse(status: number, message: string, code: string, traceId: string, key?: BizApiKey) {
  let response: Response = NextResponse.json(
    { error: { message, type: "invalid_request_error", code, param: null, trace_id: traceId } },
    { status },
  );
  if (key) response = addRateLimitHeaders(response, key, { consumed: false });
  return withTraceId(response, traceId);
}

/**
 * GET /v1/queue — 目前佇列中（pending/running）的任務，限該金鑰自己的 tenant。
 *
 * 診斷面語義與 ComfyUI 的 /queue 一致：聚合平台轉售時需要知道
 * 「我送出去、但還沒出結果的單子現在卡在哪」。只列未終結的狀態，
 * 已結束（succeeded/failed/cancelled/refunded）的請看 /v1/history。
 */
export async function GET(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")), {
    consumeRateLimit: false,
  });
  if (!auth.ok) return errorResponse(auth.status, auth.message, auth.code, traceId);

  const jobs = await queryWhenReady((sql) => listTenantActiveJobs(bizTenantId(auth.key.id), sql));
  const data = (jobs ?? []).map(toJobStatusSnapshot);

  const response = addRateLimitHeaders(
    NextResponse.json({ object: "list", data, count: data.length }, { headers: { "Cache-Control": "no-store" } }),
    auth.key,
    { consumed: false },
  );
  return withTraceId(response, traceId);
}
