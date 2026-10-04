import { NextRequest, NextResponse } from "next/server";
import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { getGenerationJobForTenant } from "@/lib/generation-core/job-repository";
import { taskStatus } from "@/lib/generation-core/task-response";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const traceId = getOrCreateTraceId(req);
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")), { consumeRateLimit: false });
  if (!auth.ok) return withTraceId(
    NextResponse.json(
      { error: { message: auth.message, type: "invalid_request_error", code: auth.code, param: null, trace_id: traceId } },
      { status: auth.status },
    ),
    traceId,
  );
  const { id } = await context.params;
  const job = await getGenerationJobForTenant(id, `biz:${auth.key.id}`);
  if (!job) return withTraceId(
    NextResponse.json(
      { error: { message: "Video task not found.", type: "invalid_request_error", code: "task_not_found", param: null, trace_id: traceId } },
      { status: 404 },
    ),
    traceId,
  );
  if (taskStatus(job) !== "succeeded") return withTraceId(
    NextResponse.json(
      { error: { message: "Video result is not ready.", type: "invalid_request_error", code: "result_not_ready", param: null, trace_id: traceId } },
      { status: 409 },
    ),
    traceId,
  );

  const artifacts = job.result?.artifacts ?? [];
  // 影片 artifact 的 url 或 videoUrl
  const videoUrl = artifacts[0]?.url ?? null;
  return withTraceId(
    NextResponse.json({ object: "video_generation.result", task_id: job.id, video_url: videoUrl, data: artifacts }, { headers: { "Cache-Control": "no-store" } }),
    traceId,
  );
}
