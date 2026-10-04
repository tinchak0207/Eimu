import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { getGenerationJobForTenant } from "@/lib/generation-core/job-repository";
import { taskStatus } from "@/lib/generation-core/task-response";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";

export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function error(status: number, message: string, code: string, traceId: string, key?: BizApiKey) {
  let response: Response = NextResponse.json(
    { error: { message, type: "invalid_request_error", code, param: null, trace_id: traceId } },
    { status },
  );
  // 认证成功后的错误（此处只会是 404/409）也带限流预测头；认证失败（401/403/429）不加。
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
  // 默认回 JSON；只有 ?format=redirect 才 302（向后相容旧 redirect 客户端）
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

