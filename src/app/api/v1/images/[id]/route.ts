import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { getGenerationJobForTenant } from "@/lib/generation-core/job-repository";
import { generationTaskResponse } from "@/lib/generation-core/task-response";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";

export const runtime = "nodejs";

function error(status: number, message: string, code: string, traceId: string, key?: BizApiKey) {
  let response: Response = NextResponse.json(
    { error: { message, type: "invalid_request_error", code, param: null, trace_id: traceId } },
    { status },
  );
  // 認證成功後的錯誤（此處只會是 404）也帶限流預測頭；認證失敗（401/403/429）不加。
  if (key) response = addRateLimitHeaders(response, key, { consumed: false });
  return withTraceId(response, traceId);
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const traceId = getOrCreateTraceId(req);
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")), { consumeRateLimit: false });
  if (!auth.ok) return error(auth.status, auth.message, auth.code, traceId);
  const { id } = await context.params;
  const job = await getGenerationJobForTenant(id, `biz:${auth.key.id}`);
  if (!job) return error(404, "Generation task was not found.", "task_not_found", traceId, auth.key);
  const response = addRateLimitHeaders(
    NextResponse.json(generationTaskResponse(job), { headers: { "Cache-Control": "no-store" } }),
    auth.key,
    { consumed: false },
  );
  return withTraceId(response, traceId);
}

