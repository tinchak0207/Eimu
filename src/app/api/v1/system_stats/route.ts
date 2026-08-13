import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import {
  computePlatformStats,
  queryPlatformDigest,
  queryWhenReady,
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
 * GET /v1/system_stats — 平台層聚合統計，給 API 聚合平台在轉售時診斷供應鏈健康。
 *
 * 回傳面**只有聚合數字**：SQL 層只做 GROUP BY model 的計數，
 * 不帶任何 tenant/apiKey 欄位，任何一個 cell 都無法反推出單一客戶的行為。
 * 統計範圍限定 `source = 'biz'`——這是對外轉售軌道的視角，C 端用量不算進來。
 * 成功率語義與 SLO 一致：只算成功/失敗，**不含排隊中的**，不灌水。
 */
export async function GET(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")), {
    consumeRateLimit: false,
  });
  if (!auth.ok) return errorResponse(auth.status, auth.message, auth.code, traceId);

  const rows = await queryWhenReady((sql) => queryPlatformDigest(sql));
  const stats = computePlatformStats(rows ?? [], new Date());

  const response = addRateLimitHeaders(
    NextResponse.json({ object: "system_stats", ...stats }, { headers: { "Cache-Control": "no-store" } }),
    auth.key,
    { consumed: false },
  );
  return withTraceId(response, traceId);
}