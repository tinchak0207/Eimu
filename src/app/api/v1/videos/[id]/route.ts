import { NextRequest, NextResponse } from "next/server";
import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { getGenerationJobForTenant } from "@/lib/generation-core/job-repository";
import { generationTaskResponse } from "@/lib/generation-core/task-response";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";

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
  return withTraceId(
    NextResponse.json(generationTaskResponse(job), { headers: { "Cache-Control": "no-store" } }),
    traceId,
  );
}
