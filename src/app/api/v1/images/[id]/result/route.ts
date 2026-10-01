import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { getGenerationJobForTenant } from "@/lib/generation-core/job-repository";
import { taskStatus } from "@/lib/generation-core/task-response";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";

export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

function error(status: number, message: string, code: string, traceId: string, key?: BizApiKey) {
  let response: Response = NextResponse.json(
    { error: { message, type: "invalid_request_error", code, param: null, trace_id: traceId } },
    { status },
  );
  // 認證成功後的錯誤（此處只會是 404/409）也帶限流預測頭；認證失敗（401/403/429）不加。
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
  if (taskStatus(job) !== "succeeded") return error(409, "Generation result is not ready.", "result_not_ready", traceId, auth.key);
  const artifacts = job.result?.artifacts ?? [];
  // 默認回 JSON；只有 ?format=redirect 才 302（向後相容舊 redirect 客戶端）
  if (req.nextUrl.searchParams.get("format") === "redirect" && artifacts.length === 1 && artifacts[0]?.url) {
    const response = addRateLimitHeaders(
      NextResponse.redirect(artifacts[0].url, { status: 302 }),
      auth.key,
      { consumed: false },
    );
    return withTraceId(response, traceId);
  }
  const response = addRateLimitHeaders(
    NextResponse.json({ object: "image_generation.result", task_id: job.id, data: artifacts }),
    auth.key,
    { consumed: false },
  );
  return withTraceId(response, traceId);
}

