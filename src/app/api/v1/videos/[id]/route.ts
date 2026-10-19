import { NextRequest, NextResponse } from "next/server";
import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { getGenerationJobForTenant, listVideoAttemptSummariesForJob } from "@/lib/generation-core/job-repository";
import { generationTaskResponse, resolveTaskCostCoins, taskStatus } from "@/lib/generation-core/task-response";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function error(status: number, message: string, code: string, traceId: string) {
  const response = NextResponse.json(
    { error: { message, type: "invalid_request_error", code, param: null, trace_id: traceId } },
    { status },
  );
  return withTraceId(response, traceId);
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const traceId = getOrCreateTraceId(req);
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")), { consumeRateLimit: false });
  if (!auth.ok) return error(auth.status, auth.message, auth.code, traceId);
  const { id } = await context.params;
  const job = await getGenerationJobForTenant(id, `biz:${auth.key.id}`);
  if (!job) return error(404, "Video generation task was not found.", "task_not_found", traceId);
  // INC-0830-VIDEO：响应带 attempts 摘要（plain array，禁 Map 序列化），供网关
  // rerun 防重消费——同一上游 task 不重复提交。
  // contract-lock 铁律③：cost_coins 必须是 `=== "succeeded" ? await resolveTaskCostCoins(...) : null`
  // 字面形状（与 images/tts 状态路由同构），不得改写为 Promise.all。
  const costCoins = taskStatus(job) === "succeeded" ? await resolveTaskCostCoins(job.id) : null;
  const attempts = await listVideoAttemptSummariesForJob(job.id);
  return withTraceId(
    NextResponse.json(
      { ...generationTaskResponse(job, { costCoins }), attempts },
      { headers: { "Cache-Control": "no-store" } },
    ),
    traceId,
  );
}
