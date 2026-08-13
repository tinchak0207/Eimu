import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import {
  bizTenantId,
  clampPagination,
  countTenantJobs,
  listTenantHistory,
  queryWhenReady,
  toJobStatusSnapshot,
} from "@/lib/generation-core/status-query";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import type { GenerationJobStatus } from "@/lib/generation-core/types";

export const runtime = "nodejs";

function errorResponse(status: number, message: string, code: string, traceId: string, key?: BizApiKey) {
  let response: Response = NextResponse.json(
    { error: { message, type: "invalid_request_error", code, param: null, trace_id: traceId } },
    { status },
  );
  if (key) response = addRateLimitHeaders(response, key, { consumed: false });
  return withTraceId(response, traceId);
}

const HISTORY_STATUSES: GenerationJobStatus[] = [
  "pending_billing",
  "billing_unknown",
  "queued",
  "leased",
  "submitting",
  "running",
  "submit_unknown",
  "succeeded",
  "failed",
  "cancelled",
  "refunded",
];

/**
 * GET /v1/history — 該金鑰最近的任務歷史（含狀態、模型、時間），支援 limit / offset。
 *
 * 只回 auth.key 對應 tenant 的 job；查不到 DB 時回空清單（診斷面，不 500）。
 */
export async function GET(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")), {
    consumeRateLimit: false,
  });
  if (!auth.ok) return errorResponse(auth.status, auth.message, auth.code, traceId);

  const url = new URL(req.url);
  const rawStatus = url.searchParams.get("status");
  const statuses = rawStatus ? rawStatus.split(",") : null;
  const filtered =
    statuses && statuses.every((s): s is GenerationJobStatus => HISTORY_STATUSES.includes(s as GenerationJobStatus))
      ? statuses
      : null;
  if (rawStatus && !filtered) {
    return errorResponse(400, `status 需為以下其一：${HISTORY_STATUSES.join("、")}。`, "invalid_status", traceId, auth.key);
  }

  const { limit, offset } = clampPagination(url.searchParams.get("limit"), url.searchParams.get("offset"));
  const tenantId = bizTenantId(auth.key.id);

  const result = await queryWhenReady(async (sql) => {
    const [jobs, total] = await Promise.all([
      listTenantHistory(tenantId, { limit, offset, statuses: filtered ?? undefined }, sql),
      countTenantJobs(tenantId, filtered, sql),
    ]);
    return { jobs, total };
  });
  if (result === null) {
    const empty = addRateLimitHeaders(
      NextResponse.json(
        { object: "list", data: [], limit, offset, total: 0, has_more: false },
        { headers: { "Cache-Control": "no-store" } },
      ),
      auth.key,
      { consumed: false },
    );
    return withTraceId(empty, traceId);
  }

  const data = result.jobs.map(toJobStatusSnapshot);
  const hasMore = offset + data.length < result.total;

  const response = addRateLimitHeaders(
    NextResponse.json(
      { object: "list", data, limit, offset, total: result.total, has_more: hasMore },
      { headers: { "Cache-Control": "no-store" } },
    ),
    auth.key,
    { consumed: false },
  );
  return withTraceId(response, traceId);
}
