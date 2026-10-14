import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { getGenerationSql } from "@/lib/generation-core/database";
import { checkpointProviderOutput, checkpointProviderTaskReceipt, clearProviderOutputCheckpoint, markProviderTaskSubmitted } from "@/lib/generation-core/job-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown) {
  const unauthorized = error instanceof Error && error.message === "UNAUTHORIZED";
  return NextResponse.json({ success: false, message: unauthorized ? "Unauthorized." : "Recovery action failed; original request remains preserved." }, { status: unauthorized ? 401 : 400 });
}

/** 无法自动查询的同步请求进入此可操作队列；不泄露响应、媒体签名或凭证。 */
export async function GET() {
  try {
    await requireAdminSession();
    const sql = getGenerationSql();
    const attempts = await sql`
      SELECT id, job_id, supplier_id, upstream_request_key, provider_request_id, provider_task_id,
        provider_protocol, recovery_status, recovery_owner, recovery_detail, provider_reconcile_deadline_at,
        (response_ciphertext IS NOT NULL) AS has_saved_response
      FROM generation_attempt WHERE status='submit_unknown' AND recovery_status <> 'resolved'
      ORDER BY submitted_at LIMIT 500
    `;
    return NextResponse.json({ success: true, attempts });
  } catch (error) { return failure(error); }
}

/** 人工关联既有上游事实；只有原子证实从未提交的排队伪失败可恢复原订单。 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminSession();
    const body = await req.json() as { job_id?: string; attempt_id?: string; action?: string; note?: string; provider_task_id?: string; output?: { url?: string; base64?: string; provider_request_id?: string; http_status?: number } };
    if (body.action === 'requeue_queue_failure') {
      if (!body.job_id || !body.note?.trim()) throw new Error('Original job and audit note required');
      const sql=getGenerationSql();
      const rows=await sql<{id:string}[]>`WITH restored AS (UPDATE generation_job job SET status='queued',
        started_at=NULL,execution_deadline_at=NULL,deadline_at=now()+interval '24 hours',queue_deadline_at=now()+interval '24 hours',
        available_at=now(),finished_at=NULL,failure_class=NULL,failure_detail=NULL,failure_record_json=NULL,
        lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=now()
        WHERE job.id=${body.job_id} AND job.status='failed' AND job.failure_class='deadline_exceeded'
        AND job.attempt_count=0 AND job.cancel_requested_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM generation_attempt a WHERE a.job_id=job.id)
        AND NOT EXISTS(SELECT 1 FROM artifact a WHERE a.job_id=job.id AND a.role='output')
        AND NOT EXISTS(SELECT 1 FROM billing_operation op WHERE op.job_id=job.id AND
          (op.operation='commit' OR op.status IN ('executing','unknown') OR (op.operation='refund' AND op.amount>0)))
        AND (job.billing_amount=0 OR EXISTS(SELECT 1 FROM billing_operation op WHERE op.job_id=job.id
          AND op.operation='reserve' AND op.status='applied' AND op.amount=job.billing_amount))
        RETURNING job.id) INSERT INTO job_events(job_id,event,actor,detail)
        SELECT id,'queue_failure_recovered',${`operator:${session.username}`},${sql.json({note:body.note.trim().slice(0,2000),original_job_id:body.job_id,no_new_request:true} as never)}
        FROM restored RETURNING job_id AS id`;
      if (!rows[0]) throw new Error('Original job lacks safe queue-only recovery or billing proof');
      return NextResponse.json({success:true,job_id:body.job_id,recovered_original_request:true,new_job_created:false});
    }
    if (!body.attempt_id || !body.note?.trim()) throw new Error("attempt_id and upstream evidence note required");
    const sql = getGenerationSql();
    const rows = await sql<{ job_id: string; provider_protocol: string | null; supplier_model_id: string | null }[]>`
      SELECT job_id, provider_protocol, supplier_model_id FROM generation_attempt
      WHERE id=${body.attempt_id} AND status='submit_unknown'
    `;
    if (!rows[0]) throw new Error("Unknown attempt not found");
    const attempt = rows[0];
    if (body.action === "attach_task") {
      if (!body.provider_task_id || !attempt.provider_protocol) throw new Error("Known provider task and original protocol required");
      await checkpointProviderTaskReceipt({jobId:attempt.job_id,attemptId:body.attempt_id,providerTaskId:body.provider_task_id,protocol:attempt.provider_protocol});
      const recorded = await markProviderTaskSubmitted({ jobId: attempt.job_id, attemptId: body.attempt_id,
        providerTaskId: body.provider_task_id, protocol: attempt.provider_protocol, firstPollDelayMs: 1 }, sql);
      if (!recorded) throw new Error("Attempt already has a different upstream task");
      await clearProviderOutputCheckpoint(body.attempt_id);
    } else if (body.action === "attach_output") {
      // 明确保存上游回执，状态/单价不从操作者猜测；不允许凭空编造200。
      if ((!body.output?.url && !body.output?.base64) || !body.output?.http_status || body.output.http_status < 200 || body.output.http_status >= 300) throw new Error("Original successful provider receipt required");
      if (body.output.url && !/^https?:\/\//.test(body.output.url)) throw new Error("Invalid media URL");
      await checkpointProviderOutput({ jobId: attempt.job_id, attemptId: body.attempt_id,
        output: { url: body.output.url ?? null, base64: body.output.base64 ?? null,
          providerRequestId: body.output.provider_request_id, httpStatus: body.output.http_status,
          endpointLabel: "operator-recovered-original-response", supplierModelId: attempt.supplier_model_id ?? "",
          evidence: { source: "operator-confirmed-upstream-receipt", note: body.note.trim() } } }, sql);
    } else if (body.action !== "retry_reconciliation") throw new Error("Unsupported recovery action");
    await sql`UPDATE generation_attempt SET recovery_status='pending', recovery_owner=${`operator:${session.username}`},
      recovery_detail=${body.note.trim().slice(0, 2000)}, provider_next_poll_at=now(),
      provider_reconcile_deadline_at=now()+interval '24 hours', updated_at=now() WHERE id=${body.attempt_id}`;
    return NextResponse.json({ success: true, attempt_id: body.attempt_id, resubmitted_generation: false });
  } catch (error) { return failure(error); }
}
