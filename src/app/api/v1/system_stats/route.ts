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
 * GET /v1/system_stats — 平台层聚合统计，给 API 聚合平台在转售时诊断供应链健康。
 *
 * 回传面**只有聚合数字**：SQL 层只做 GROUP BY model 的计数，
 * 不带任何 tenant/apiKey 栏位，任何一个 cell 都无法反推出单一客户的行为。
 * 统计范围限定 `source = 'biz'`——这是对外转售轨道的视角，C 端用量不算进来。
 * 成功率语义与 SLO 一致：只算成功/失败，**不含排队中的**，不灌水。
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