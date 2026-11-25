// GET /api/generation-jobs/:id/diagnostic —— 用户自助的脱敏诊断（客服无需再要提示词／密钥／截图）。
// 只认本租户的任务；回结局四态、钱的去向、关键步骤的人话时间线，和一句可直接粘贴给客服的工单文字。

import { NextRequest, NextResponse } from "next/server";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { looksLikeBizApiKey, readBearerToken } from "@/lib/biz-api-keys";
import { getJobTimeline } from "@/lib/generation-core/job-events";
import { getGenerationJobForTenant } from "@/lib/generation-core/job-repository";
import { buildTaskDiagnostic } from "@/lib/generation-core/task-diagnostic";
import { authenticateImageUser } from "@/lib/image-billing";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const traceId = getOrCreateTraceId(req);
  const done = (body: unknown, status = 200) =>
    withTraceId(NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }), traceId);

  let tenantId: string;
  const bearer = readBearerToken(req.headers.get("authorization"));
  if (bearer && looksLikeBizApiKey(bearer)) {
    const auth = await authenticateBizApiKey(bearer);
    if (!auth.ok) return done({ error: auth.message }, auth.status);
    tenantId = `biz:${auth.key.id}`;
  } else {
    const auth = await authenticateImageUser(req.headers, 0);
    if (!auth.ok) return done({ error: auth.message }, auth.status);
    tenantId = `web:${auth.user.id}`;
  }

  const { id } = await context.params;
  const job = await getGenerationJobForTenant(id, tenantId);
  if (!job) return done({ error: "Generation task was not found." }, 404);
  const timeline = await getJobTimeline(id).catch(() => null);
  return done({ ok: true, requestId: traceId, ...buildTaskDiagnostic(job, timeline) });
}
