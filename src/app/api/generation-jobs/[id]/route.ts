// GET /api/generation-jobs/[id] — customer-facing, tenant-scoped generation status.
//
// Two job-origin pipelines land here, so two auth paths are supported rather than
// picking one:
//   - biz (aggregator/API-key) jobs: tenantId `biz:${apiKey.id}`, same
//     `readBearerToken` + `authenticateBizApiKey` helpers used by
//     /api/v1/images/generations — reused as-is, not reinvented.
//   - web (session) jobs: tenantId `web:${user.id}`, same `authenticateImageUser`
//     already used by /api/generate-images, whose durable path sets
//     `Location: /api/generation-jobs/{id}` on 202 responses. Dropping this path
//     would break that already-wired redirect.
// A request presenting a `sk-biz-...` bearer token is treated as biz; anything else
// falls back to the web session check.
//
// The response is a deliberately narrow projection of GenerationJob: no
// promptCiphertext, no workflow_json, no supplier/attempt detail. Only what a
// customer needs to see their own request's outcome.
import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, looksLikeBizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { authenticateImageUser } from "@/lib/image-billing";
import { getGenerationJobForTenant } from "@/lib/generation-core/job-repository";
import { cancelGenerationJobWithRefund } from "@/lib/generation-core/cancel-service";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { generationTaskProjection } from "@/lib/generation-core/task-projection";
import { displayGenerationPrompt } from "@/lib/web-task-prompt";

export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 與 VPS（閘道/控制面 DB，矽谷）同區：每次上游往返省一趟橫跨美國（2026-10-01 效能審計）

type TenantResolution =
  | { ok: true; tenantId: string }
  | { ok: false; status: number; message: string };

async function resolveTenant(req: NextRequest): Promise<TenantResolution> {
  const bearer = readBearerToken(req.headers.get("authorization"));
  if (bearer && looksLikeBizApiKey(bearer)) {
    const auth = await authenticateBizApiKey(bearer);
    if (!auth.ok) return { ok: false, status: auth.status, message: auth.message };
    return { ok: true, tenantId: `biz:${auth.key.id}` };
  }

  const auth = await authenticateImageUser(req.headers, 0);
  if (!auth.ok) return { ok: false, status: auth.status, message: auth.message };
  return { ok: true, tenantId: `web:${auth.user.id}` };
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const traceId = getOrCreateTraceId(req);
  const tenant = await resolveTenant(req);
  if (!tenant.ok) {
    return withTraceId(NextResponse.json({ error: tenant.message }, { status: tenant.status }), traceId);
  }

  const { id } = await context.params;
  const job = await getGenerationJobForTenant(id, tenant.tenantId);
  if (!job) {
    return withTraceId(NextResponse.json({ error: "Generation task was not found." }, { status: 404 }), traceId);
  }

  const body = generationTaskProjection(job, { includePrompt: true });
  body.prompt = displayGenerationPrompt(body.prompt, job.workflow);

  return withTraceId(NextResponse.json(body, { headers: { "Cache-Control": "no-store" } }), traceId);
}

// DELETE — 人工终止生成任务，按取消前状态决定退款语义：
//   - pending_billing：未扣款（reserve 尚未落地），无需退款，静默成功；
//   - queued / leased：reserve 已落地（已扣款）→ 全额退款；
//   - submitting / running：允许取消，在飞 attempt 产出由 worker 丢弃；
//     计费按已完成张数 commit、未完成退差额——由 reconcileGenerationBilling 兜底，
//     取消接口本身不直接算钱。
//   - 终态（succeeded/failed/refunded/cancelled/billing_unknown）：409 already_terminal。
const CANCELLABLE_TERMINAL_STATUSES = new Set([
  "succeeded", "failed", "refunded", "cancelled", "billing_unknown",
]);

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const traceId = getOrCreateTraceId(req);
  const tenant = await resolveTenant(req);
  if (!tenant.ok) {
    return withTraceId(NextResponse.json({ error: tenant.message }, { status: tenant.status }), traceId);
  }

  const { id } = await context.params;
  const existing = await getGenerationJobForTenant(id, tenant.tenantId);
  if (!existing) {
    return withTraceId(NextResponse.json({ error: "Generation task was not found." }, { status: 404 }), traceId);
  }
  if (CANCELLABLE_TERMINAL_STATUSES.has(existing.status)) {
    return withTraceId(
      NextResponse.json(
        { error: { code: "already_terminal", message: "任务已结束，无法取消" } },
        { status: 409 },
      ),
      traceId,
    );
  }

  // 取消 + 條件退款收在生產平面門面（V-01）；路由不觸發帳本動作。
  const result = await cancelGenerationJobWithRefund(id, tenant.tenantId, existing);
  if (!result.cancelled) {
    // 读取后与 CAS 更新之间的竞态：job 已被并发终结（worker 完成/失败/退款）。
    return withTraceId(
      NextResponse.json(
        { error: { code: "already_terminal", message: "任务已结束，无法取消" } },
        { status: 409 },
      ),
      traceId,
    );
  }
  const { refund } = result;

  return withTraceId(
    NextResponse.json(
      { success: true, cancelled: true, previous_status: result.previousStatus, refund },
      { headers: { "Cache-Control": "no-store" } },
    ),
    traceId,
  );
}
