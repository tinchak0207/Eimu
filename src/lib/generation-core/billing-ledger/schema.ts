import { randomUUID } from "node:crypto";

import type { GenerationSql } from "../database";
import { JOB_EVENT, emitJobEvent } from "../job-events";
import { getGenerationJob, mapGenerationJob } from "../job-repository";
import { billingReplayDenialDetail, planBillingAttemptReplay } from "../operation-registry";
import type { FailureClass, GenerationJob } from "../types";
import { BILLING_REPLAY_KEY, EXECUTION_LEASE_MS, operationAmount, operationAttempts, type BillingClaimOutcome, type BillingOperation, type Row } from "./types";

export async function freshJob(jobId: string, sql: GenerationSql): Promise<GenerationJob> {
  const job = await getGenerationJob(jobId, sql);
  if (!job) throw new Error(`Generation job ${jobId} does not exist.`);
  return job;
}

export async function moveJobToQueued(jobId: string, sql: GenerationSql): Promise<void> {
  await sql`
    UPDATE generation_job
    SET status = 'queued', available_at = now(), failure_class = NULL, failure_detail = NULL, updated_at = now()
    WHERE id = ${jobId} AND status = 'pending_billing'
  `;
}
/**
 * claim = 计费动作的自动重放裁决点。CAS（status='pending' → 'executing' ＋ 租约）
 * 仍是并发边界；差别是 claim 成功后**先问封闭 operation registry「这次尝试准不准」**，
 * 不许就更不执行外部扣款／退款。裁决序号用 RETURNING 的 attempt_count：
 * UPDATE 内已 +1，故它就是「即将执行的这次尝试」的序号（FG 教训：先定序号语义再改点）。
 *
 * 被拒时的终结刻意沿用既有桶，不动金额与状态机语义：
 *  - reserve → unknown（扣款状态不明 → zombie 只标 needs_review，金额不动，不自动退款）
 *  - refund  → failed（退款未落地且不再自动重试 → 出现在 probe 的 refund_failed 名单）
 */
export async function claimBillingOperation(input: {
  jobId: string;
  operation: BillingOperation;
  executorId: string;
  sql: GenerationSql;
}): Promise<BillingClaimOutcome> {
  const rows = await input.sql<Row[]>`
    UPDATE billing_operation
    SET status = 'executing',
        executor_id = ${input.executorId},
        execution_expires_at = now() + (${EXECUTION_LEASE_MS}::text || ' milliseconds')::interval,
        last_attempt_at = now(),
        attempt_count = attempt_count + 1,
        updated_at = now()
    WHERE job_id = ${input.jobId}
      AND operation = ${input.operation}
      AND sequence = 1
      AND status = 'pending'
      AND next_attempt_at <= now()
    RETURNING *
  `;
  const claimed = rows[0];
  if (!claimed) return { kind: "unavailable" };

  const replay = planBillingAttemptReplay({
    operation: BILLING_REPLAY_KEY[input.operation],
    nextAttemptNo: operationAttempts(claimed),
  });
  if (replay.allowed) return { kind: "claimed", row: claimed };

  const detail = billingReplayDenialDetail(BILLING_REPLAY_KEY[input.operation], replay);
  if (input.operation === "refund") {
    await input.sql`
      UPDATE billing_operation
      SET status = 'failed', execution_expires_at = NULL, last_error = ${detail}, updated_at = now()
      WHERE id = ${String(claimed.id)} AND status = 'executing'
    `;
  } else {
    await markOperationUnknown({
      id: String(claimed.id),
      jobId: input.jobId,
      operation: input.operation,
      detail,
      sql: input.sql,
    });
  }
  emitJobEvent({
    jobId: input.jobId,
    event: JOB_EVENT.replayDenied,
    actor: input.executorId,
    upstreamRaw: detail,
    detail: {
      operation: BILLING_REPLAY_KEY[input.operation],
      denial_reason: replay.denialReason,
      attempt_no: replay.nextAttemptNo,
      max_replay_attempts: replay.maxReplayAttempts,
      billing_operation: input.operation,
    },
  }, input.sql);
  console.error(`[billing-ledger] job ${input.jobId}: ${input.operation} ${detail}`);
  return { kind: "replay_denied", plan: replay };
}

export async function markOperationRetry(input: {
  id: string;
  detail: string;
  nextAttemptAt: Date;
  sql: GenerationSql;
}): Promise<void> {
  await input.sql`
    UPDATE billing_operation
    SET status = 'pending',
        executor_id = NULL,
        execution_expires_at = NULL,
        last_error = ${input.detail},
        next_attempt_at = ${input.nextAttemptAt},
        updated_at = now()
    WHERE id = ${input.id} AND status = 'executing'
  `;
}

export async function markOperationUnknown(input: {
  id: string;
  jobId: string;
  operation: BillingOperation;
  detail: string;
  sql: GenerationSql;
}): Promise<void> {
  await input.sql.begin(async (tx) => {
    await tx`
      UPDATE billing_operation
      SET status = 'unknown', execution_expires_at = NULL, last_error = ${input.detail}, updated_at = now()
      WHERE id = ${input.id} AND status = 'executing'
    `;
    if (input.operation === "reserve") {
      await tx`
        UPDATE generation_job
        SET status = 'billing_unknown', failure_class = 'unknown',
            failure_detail = ${input.detail}, updated_at = now()
        WHERE id = ${input.jobId} AND status = 'pending_billing'
      `;
    }
  });
}

export async function markReservationRejected(input: {
  id: string;
  jobId: string;
  detail: string;
  failureClass: FailureClass;
  sql: GenerationSql;
}): Promise<void> {
  await input.sql.begin(async (tx) => {
    await tx`
      UPDATE billing_operation
      SET status = 'failed', execution_expires_at = NULL, last_error = ${input.detail}, updated_at = now()
      WHERE id = ${input.id} AND status = 'executing'
    `;
    await tx`
      UPDATE generation_job
      SET status = 'failed', failure_class = ${input.failureClass},
          failure_detail = ${input.detail}, finished_at = now(), updated_at = now()
      WHERE id = ${input.jobId} AND status = 'pending_billing'
    `;
  });
}
export async function ensureRefundOperation(job: GenerationJob, amount: number, sql: GenerationSql): Promise<Row> {
  await sql`
    INSERT INTO billing_operation (
      id, job_id, operation, amount, status, idempotency_ref, next_attempt_at
    ) VALUES (
      ${randomUUID()}, ${job.id}, 'refund', ${amount}, 'pending',
      ${`generation:${job.id}:refund:1`}, now()
    )
    ON CONFLICT (job_id, operation, sequence) DO NOTHING
  `;
  const rows = await sql<Row[]>`
    SELECT * FROM billing_operation
    WHERE job_id = ${job.id} AND operation = 'refund' AND sequence = 1
    LIMIT 1
  `;
  const operation = rows[0];
  if (!operation) throw new Error(`Could not create refund operation for generation job ${job.id}.`);
  if (operationAmount(operation) !== amount) {
    throw new Error(`Refund amount conflict for generation job ${job.id}; manual reconciliation required.`);
  }
  return operation;
}

export async function markFullyRefunded(job: GenerationJob, amount: number, sql: GenerationSql): Promise<void> {
  if (amount !== job.billingAmount) return;
  await sql`
    UPDATE generation_job
    SET status = 'refunded', finished_at = COALESCE(finished_at, now()), updated_at = now()
    WHERE id = ${job.id} AND status IN ('failed', 'cancelled')
  `;
}
export function committedAmount(job: GenerationJob): number {
  if (!job.requestedCount || !job.completedCount) return 0;
  return Math.floor(job.billingAmount * Math.min(job.requestedCount, job.completedCount) / job.requestedCount);
}

export async function markExpiredBillingOperationsUnknown(sql: GenerationSql): Promise<number> {
  const expired = await sql<Row[]>`
    UPDATE billing_operation
    SET status = 'unknown', execution_expires_at = NULL,
        last_error = COALESCE(last_error, 'Billing worker lease expired after external adjustment began; reconciliation required.'),
        updated_at = now()
    WHERE status = 'executing' AND execution_expires_at < now()
    RETURNING job_id, operation
  `;
  for (const operation of expired) {
    emitJobEvent({ jobId: String(operation.job_id), event: JOB_EVENT.billingUnknown, actor: "system", upstreamRaw: "Billing worker lease expired after external adjustment began; reconciliation required.", detail: { operation: String(operation.operation), reason: "lease_expired" } }, sql);
    if (String(operation.operation) !== "reserve") continue;
    await sql`
      UPDATE generation_job
      SET status = 'billing_unknown', failure_class = 'unknown',
          failure_detail = 'Billing worker lease expired after reservation began; reconciliation required.',
          updated_at = now()
      WHERE id = ${String(operation.job_id)} AND status = 'pending_billing'
    `;
  }
  return expired.length;
}

export async function dueReservationJobs(limit: number, sql: GenerationSql): Promise<GenerationJob[]> {
  const rows = await sql<Row[]>`
    SELECT job.*
    FROM generation_job job
    JOIN billing_operation operation
      ON operation.job_id = job.id
      AND operation.operation = 'reserve'
      AND operation.sequence = 1
    WHERE job.status = 'pending_billing'
      AND operation.status = 'pending'
      AND operation.next_attempt_at <= now()
    ORDER BY operation.next_attempt_at, job.created_at
    LIMIT ${limit}
  `;
  return rows.map(mapGenerationJob);
}

export async function terminalReservedJobs(limit: number, sql: GenerationSql): Promise<GenerationJob[]> {
  const rows = await sql<Row[]>`
    SELECT job.*
    FROM generation_job job
    JOIN billing_operation reserve
      ON reserve.job_id = job.id
      AND reserve.operation = 'reserve'
      AND reserve.sequence = 1
      AND reserve.status = 'applied'
    WHERE job.status IN ('succeeded', 'failed', 'cancelled')
    ORDER BY job.finished_at NULLS LAST, job.created_at
    LIMIT ${limit}
  `;
  return rows.map(mapGenerationJob);
}
