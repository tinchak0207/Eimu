import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { getGenerationJobForTenant } from "@/lib/generation-core/job-repository";
import { generationTaskResponse, resolveTaskCostCoins, taskStatus } from "@/lib/generation-core/task-response";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { withApiRejectionTelemetry, type RejectionContext } from "@/lib/api-rejection";

export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

/** 拒絕遙測用的路徑。任務查詢失敗＝B 端客戶拿不到成品，也必須看得見。 */
const REJECTION_PATH = "/v1/images/{id}";

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
  const rejection: RejectionContext = {
    rawKey: readBearerToken(req.headers.get("authorization")),
    userId: null,
    model: null,
  };
  return withApiRejectionTelemetry(REJECTION_PATH, rejection, () => handleLookup(req, context, rejection));
}

async function handleLookup(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
  rejection: RejectionContext,
): Promise<Response> {
  const traceId = getOrCreateTraceId(req);
  const auth = await authenticateBizApiKey(rejection.rawKey, { consumeRateLimit: false });
  if (!auth.ok) return error(auth.status, auth.message, auth.code, traceId);
  rejection.userId = auth.key.userId;
  const { id } = await context.params;
  const job = await getGenerationJobForTenant(id, `biz:${auth.key.id}`);
  if (!job) return error(404, "Generation task was not found.", "task_not_found", traceId, auth.key);
  const costCoins = taskStatus(job) === "succeeded" ? await resolveTaskCostCoins(job.id) : null;
  const response = addRateLimitHeaders(
    NextResponse.json(generationTaskResponse(job, { costCoins }), { headers: { "Cache-Control": "no-store" } }),
    auth.key,
    { consumed: false },
  );
  return withTraceId(response, traceId);
}

