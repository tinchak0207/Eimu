import { randomUUID } from "node:crypto";
import {
  ImageBillingGatewayError,
  ImageBillingRevertedError,
} from "@/lib/image-billing";
import {
  configuredGenerationBillingAdapter,
  type GenerationBillingAdapter,
} from "./billing-relay";
import { getGenerationSql, type GenerationSql } from "./database";
import { getGenerationJob, mapGenerationJob } from "./job-repository";
import type { FailureClass, GenerationJob } from "./types";

type Row = Record<string, unknown>;
type BillingOperation = "reserve" | "commit" | "refund";

const EXECUTION_LEASE_MS = 45_000;
const DEFAULT_RECONCILE_BATCH = 50;

export type BillingFailureDisposition = "rejected" | "retry" | "unknown";
export type BillingRefundResult = "applied" | "pending" | "unknown" | "failed";

export function classifyBillingFailure(error: unknown): BillingFailureDisposition {
  if (error instanceof ImageBillingRevertedError) return "retry";
  if (error instanceof ImageBillingGatewayError) {
    if (error.status === 429) return "retry";
    if (error.status !== undefined && error.status >= 400 && error.status < 500) return "rejected";
  }
  // Timeouts, aborted requests, 5xx, invalid gateway JSON, and network failures
  // are all ambiguous: New API has no request idempotency contract for quota
  // adjustments, so a retry could apply the same debit/credit twice.
  return "unknown";
}

export function billingRetryAt(error: unknown, attempt: number, now = new Date()): Date {
  if (error instanceof ImageBillingGatewayError && error.retryAfter) {
    const seconds = Number(error.retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return new Date(now.getTime() + seconds * 1000);
    const parsed = new Date(error.retryAfter);
    if (!Number.isNaN(parsed.getTime()) && parsed > now) return parsed;
  }
  return new Date(now.getTime() + Math.min(300_000, 5_000 * 2 ** Math.min(6, Math.max(0, attempt))));
}

function detailOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

function rejectedFailureClass(error: unknown): FailureClass {
  if (error instanceof ImageBillingGatewayError) {
    if (error.status === 402) return "quota_exhausted";
    if (error.status === 401 || error.status === 403) return "authentication";
  }
  return "unknown";
}

function operationAmount(row: Row): number {
  return Number(row.amount ?? 0);
}

function operationStatus(row: Row): string {
  return String(row.status ?? "");
}

function operationAttempts(row: Row): number {
  return Number(row.attempt_count ?? 0);
}

async function freshJob(jobId: string, sql: GenerationSql): Promise<GenerationJob> {
  const job = await getGenerationJob(jobId, sql);
  if (!job) throw new Error(`Generation job ${jobId} does not exist.`);
  return job;
}

async function moveJobToQueued(jobId: string, sql: GenerationSql): Promise<void> {
  await sql`
    UPDATE generation_job
    SET status = 'queued', available_at = now(), failure_class = NULL, failure_detail = NULL, updated_at = now()
    WHERE id = ${jobId} AND status = 'pending_billing'
  `;
}

async function claimBillingOperation(input: {
  jobId: string;
  operation: BillingOperation;
  executorId: string;
  sql: GenerationSql;
}): Promise<Row | null> {
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
  return rows[0] ?? null;
}

async function markOperationRetry(input: {
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

async function markOperationUnknown(input: {
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

async function markReservationRejected(input: {
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

/**
 * Claims a durable reserve record before the external debit. An ambiguous result
 * is terminally frozen as billing_unknown; it is never replayed automatically.
 */
export async function reserveGenerationBilling(input: {
  job: GenerationJob;
  executorId: string;
  adapter?: GenerationBillingAdapter;
}, sql: GenerationSql = getGenerationSql()): Promise<GenerationJob> {
  if (input.job.billingAmount === 0) {
    await moveJobToQueued(input.job.id, sql);
    return freshJob(input.job.id, sql);
  }
  if (!input.job.billingUserId) {
    throw new Error(`Generation job ${input.job.id} has a billing amount but no billing user.`);
  }
  if (input.job.status !== "pending_billing") return freshJob(input.job.id, sql);

  const claimed = await claimBillingOperation({
    jobId: input.job.id,
    operation: "reserve",
    executorId: input.executorId,
    sql,
  });
  if (!claimed) return freshJob(input.job.id, sql);

  try {
    await (input.adapter ?? configuredGenerationBillingAdapter()).reserve({
      jobId: input.job.id,
      operation: "reserve",
      userId: input.job.billingUserId,
      amount: input.job.billingAmount,
    });
    await sql.begin(async (tx) => {
      const applied = await tx<Row[]>`
        UPDATE billing_operation
        SET status = 'applied', applied_at = now(), execution_expires_at = NULL,
            last_error = NULL, updated_at = now()
        WHERE id = ${String(claimed.id)} AND status = 'executing'
        RETURNING id
      `;
      if (!applied[0]) return;
      await tx`
        UPDATE generation_job
        SET status = 'queued', available_at = now(), failure_class = NULL, failure_detail = NULL, updated_at = now()
        WHERE id = ${input.job.id} AND status = 'pending_billing'
      `;
    });
  } catch (error) {
    const detail = detailOf(error);
    const disposition = classifyBillingFailure(error);
    if (disposition === "retry") {
      await markOperationRetry({
        id: String(claimed.id),
        detail,
        nextAttemptAt: billingRetryAt(error, operationAttempts(claimed)),
        sql,
      });
    } else if (disposition === "rejected") {
      await markReservationRejected({
        id: String(claimed.id),
        jobId: input.job.id,
        detail,
        failureClass: rejectedFailureClass(error),
        sql,
      });
    } else {
      await markOperationUnknown({
        id: String(claimed.id),
        jobId: input.job.id,
        operation: "reserve",
        detail,
        sql,
      });
    }
  }

  return freshJob(input.job.id, sql);
}

/**
 * A commit has no external side effect: it proves how much of an already-applied
 * reservation was consumed. The unique operation key makes this idempotent.
 */
export async function commitGenerationBilling(
  job: GenerationJob,
  amount = job.billingAmount,
  sql: GenerationSql = getGenerationSql(),
): Promise<void> {
  if (!amount) return;
  if (amount < 0 || amount > job.billingAmount) {
    throw new Error(`Invalid committed amount for generation job ${job.id}.`);
  }

  await sql`
    INSERT INTO billing_operation (
      id, job_id, operation, amount, status, idempotency_ref, applied_at,
      next_attempt_at
    )
    SELECT ${randomUUID()}, job.id, 'commit', ${amount}, 'applied',
      ${`generation:${job.id}:commit:1`}, now(), now()
    FROM generation_job job
    JOIN billing_operation reserve
      ON reserve.job_id = job.id
      AND reserve.operation = 'reserve'
      AND reserve.sequence = 1
      AND reserve.status = 'applied'
    WHERE job.id = ${job.id}
    ON CONFLICT (job_id, operation, sequence) DO NOTHING
  `;
}

async function ensureRefundOperation(job: GenerationJob, amount: number, sql: GenerationSql): Promise<Row> {
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

async function markFullyRefunded(job: GenerationJob, amount: number, sql: GenerationSql): Promise<void> {
  if (amount !== job.billingAmount) return;
  await sql`
    UPDATE generation_job
    SET status = 'refunded', finished_at = COALESCE(finished_at, now()), updated_at = now()
    WHERE id = ${job.id} AND status IN ('failed', 'cancelled')
  `;
}

/**
 * Refunds only the uncommitted part of the reservation. A successful partial
 * refund keeps the job failed; only a full refund receives the public refunded
 * status. Unknown credit results are frozen, never retried blindly.
 */
export async function refundGenerationBilling(input: {
  job: GenerationJob;
  amount?: number;
  executorId: string;
  adapter?: GenerationBillingAdapter;
}, sql: GenerationSql = getGenerationSql()): Promise<BillingRefundResult> {
  const amount = input.amount ?? input.job.billingAmount;
  if (!amount || !input.job.billingUserId) return "applied";
  if (amount < 0 || amount > input.job.billingAmount) {
    throw new Error(`Invalid refund amount for generation job ${input.job.id}.`);
  }

  const operation = await ensureRefundOperation(input.job, amount, sql);
  if (operationStatus(operation) === "applied") {
    await markFullyRefunded(input.job, amount, sql);
    return "applied";
  }
  if (operationStatus(operation) === "unknown") return "unknown";
  if (operationStatus(operation) === "failed") return "failed";

  const claimed = await claimBillingOperation({
    jobId: input.job.id,
    operation: "refund",
    executorId: input.executorId,
    sql,
  });
  if (!claimed) return "pending";

  try {
    await (input.adapter ?? configuredGenerationBillingAdapter()).refund({
      jobId: input.job.id,
      operation: "refund",
      userId: input.job.billingUserId,
      amount,
    });
    await sql.begin(async (tx) => {
      const applied = await tx<Row[]>`
        UPDATE billing_operation
        SET status = 'applied', applied_at = now(), execution_expires_at = NULL,
            last_error = NULL, updated_at = now()
        WHERE id = ${String(claimed.id)} AND status = 'executing'
        RETURNING id
      `;
      if (!applied[0] || amount !== input.job.billingAmount) return;
      await tx`
        UPDATE generation_job
        SET status = 'refunded', finished_at = COALESCE(finished_at, now()), updated_at = now()
        WHERE id = ${input.job.id} AND status IN ('failed', 'cancelled')
      `;
    });
    return "applied";
  } catch (error) {
    const detail = detailOf(error);
    const disposition = classifyBillingFailure(error);
    if (disposition === "retry") {
      await markOperationRetry({
        id: String(claimed.id),
        detail,
        nextAttemptAt: billingRetryAt(error, operationAttempts(claimed)),
        sql,
      });
      return "pending";
    }
    if (disposition === "rejected") {
      await sql`
        UPDATE billing_operation
        SET status = 'failed', execution_expires_at = NULL, last_error = ${detail}, updated_at = now()
        WHERE id = ${String(claimed.id)} AND status = 'executing'
      `;
      return "failed";
    }
    await markOperationUnknown({
      id: String(claimed.id),
      jobId: input.job.id,
      operation: "refund",
      detail,
      sql,
    });
    return "unknown";
  }
}

function committedAmount(job: GenerationJob): number {
  if (!job.requestedCount || !job.completedCount) return 0;
  return Math.floor(job.billingAmount * Math.min(job.requestedCount, job.completedCount) / job.requestedCount);
}

async function markExpiredBillingOperationsUnknown(sql: GenerationSql): Promise<number> {
  const expired = await sql<Row[]>`
    UPDATE billing_operation
    SET status = 'unknown', execution_expires_at = NULL,
        last_error = COALESCE(last_error, 'Billing worker lease expired after external adjustment began; reconciliation required.'),
        updated_at = now()
    WHERE status = 'executing' AND execution_expires_at < now()
    RETURNING job_id, operation
  `;
  for (const operation of expired) {
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

async function dueReservationJobs(limit: number, sql: GenerationSql): Promise<GenerationJob[]> {
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

async function terminalReservedJobs(limit: number, sql: GenerationSql): Promise<GenerationJob[]> {
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

export interface BillingReconciliationSummary {
  expiredUnknown: number;
  reservationAttempts: number;
  settlementAttempts: number;
}

/**
 * Runs from every worker. Claims on billing_operation are the concurrency
 * boundary, so many workers may scan but only one can perform an external call.
 */
export async function reconcileGenerationBilling(input: {
  executorId: string;
  limit?: number;
  adapter?: GenerationBillingAdapter;
  sql?: GenerationSql;
}): Promise<BillingReconciliationSummary> {
  const sql = input.sql ?? getGenerationSql();
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_RECONCILE_BATCH, 200));
  const summary: BillingReconciliationSummary = {
    expiredUnknown: await markExpiredBillingOperationsUnknown(sql),
    reservationAttempts: 0,
    settlementAttempts: 0,
  };

  for (const job of await dueReservationJobs(limit, sql)) {
    await reserveGenerationBilling({ job, executorId: input.executorId, adapter: input.adapter }, sql);
    summary.reservationAttempts += 1;
  }

  for (const job of await terminalReservedJobs(limit, sql)) {
    if (job.status === "succeeded") {
      await commitGenerationBilling(job, job.billingAmount, sql);
      summary.settlementAttempts += 1;
      continue;
    }

    const committed = committedAmount(job);
    await commitGenerationBilling(job, committed, sql);
    const refund = Math.max(0, job.billingAmount - committed);
    if (refund) {
      await refundGenerationBilling({
        job,
        amount: refund,
        executorId: input.executorId,
        adapter: input.adapter,
      }, sql);
    }
    summary.settlementAttempts += 1;
  }

  return summary;
}

export interface BillingOperationView {
  id: string;
  jobId: string;
  tenantId: string;
  modelId: string;
  operation: BillingOperation;
  amount: number;
  status: "pending" | "executing" | "applied" | "unknown" | "failed";
  attemptCount: number;
  nextAttemptAt: Date;
  executionExpiresAt: Date | null;
  lastError: string | null;
  jobStatus: GenerationJob["status"];
  createdAt: Date;
  appliedAt: Date | null;
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : new Date(String(value));
}

function mapBillingOperationView(row: Row): BillingOperationView {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    tenantId: String(row.tenant_id),
    modelId: String(row.model_id),
    operation: String(row.operation) as BillingOperation,
    amount: Number(row.amount),
    status: String(row.status) as BillingOperationView["status"],
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: new Date(String(row.next_attempt_at)),
    executionExpiresAt: nullableDate(row.execution_expires_at),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    jobStatus: String(row.job_status) as GenerationJob["status"],
    createdAt: new Date(String(row.created_at)),
    appliedAt: nullableDate(row.applied_at),
  };
}

export async function listBillingOperations(input: {
  status?: BillingOperationView["status"];
  limit?: number;
  sql?: GenerationSql;
} = {}): Promise<BillingOperationView[]> {
  const sql = input.sql ?? getGenerationSql();
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const rows = await sql<Row[]>`
    SELECT operation.*, job.tenant_id, job.model_id, job.status AS job_status
    FROM billing_operation operation
    JOIN generation_job job ON job.id = operation.job_id
    WHERE (${input.status ?? null}::text IS NULL OR operation.status = ${input.status ?? null})
    ORDER BY operation.updated_at DESC
    LIMIT ${limit}
  `;
  return rows.map(mapBillingOperationView);
}

export type ManualBillingAction = "mark_applied" | "mark_failed" | "retry";

/**
 * This is intentionally an administrative decision, not an automated retry.
 * Operators must inspect the upstream account ledger before resolving an
 * unknown operation, then record the actor and note in the durable row.
 */
export async function reconcileBillingOperationManually(input: {
  operationId: string;
  action: ManualBillingAction;
  actor: string;
  note: string;
  sql?: GenerationSql;
}): Promise<BillingOperationView> {
  const sql = input.sql ?? getGenerationSql();
  const note = input.note.trim().slice(0, 1_500);
  if (!note) throw new Error("A reconciliation note is required.");

  return sql.begin(async (tx) => {
    const rows = await tx<Row[]>`
      SELECT operation.*, job.tenant_id, job.model_id, job.status AS job_status, job.billing_amount
      FROM billing_operation operation
      JOIN generation_job job ON job.id = operation.job_id
      WHERE operation.id = ${input.operationId}
      FOR UPDATE
    `;
    const operation = rows[0];
    if (!operation) throw new Error("Billing operation was not found.");
    const currentStatus = String(operation.status);
    if (currentStatus === "executing") {
      throw new Error("Billing operation is still executing; wait for its lease to expire or complete.");
    }
    if (currentStatus === "applied" && input.action !== "mark_applied") {
      throw new Error("An applied billing operation cannot be retried or failed.");
    }

    const reference = `manual:${input.actor}:${new Date().toISOString()}`;
    if (input.action === "mark_applied") {
      await tx`
        UPDATE billing_operation
        SET status = 'applied', applied_at = COALESCE(applied_at, now()), executor_id = ${input.actor},
            execution_expires_at = NULL, external_reference = ${reference}, last_error = ${note}, updated_at = now()
        WHERE id = ${input.operationId}
      `;
      if (String(operation.operation) === "reserve") {
        await tx`
          UPDATE generation_job
          SET status = 'queued', available_at = now(), failure_class = NULL, failure_detail = NULL, updated_at = now()
          WHERE id = ${String(operation.job_id)} AND status IN ('pending_billing', 'billing_unknown')
        `;
      } else if (String(operation.operation) === "refund" && Number(operation.amount) === Number(operation.billing_amount)) {
        await tx`
          UPDATE generation_job
          SET status = 'refunded', finished_at = COALESCE(finished_at, now()), updated_at = now()
          WHERE id = ${String(operation.job_id)} AND status IN ('failed', 'cancelled')
        `;
      }
    } else if (input.action === "mark_failed") {
      await tx`
        UPDATE billing_operation
        SET status = 'failed', executor_id = ${input.actor}, execution_expires_at = NULL,
            external_reference = ${reference}, last_error = ${note}, updated_at = now()
        WHERE id = ${input.operationId}
      `;
      if (String(operation.operation) === "reserve") {
        await tx`
          UPDATE generation_job
          SET status = 'failed', failure_class = 'unknown', failure_detail = ${note},
              finished_at = now(), updated_at = now()
          WHERE id = ${String(operation.job_id)} AND status IN ('pending_billing', 'billing_unknown')
        `;
      }
    } else {
      if (currentStatus !== "unknown" && currentStatus !== "failed" && currentStatus !== "pending") {
        throw new Error("Only unknown, failed, or pending billing operations can be retried.");
      }
      await tx`
        UPDATE billing_operation
        SET status = 'pending', executor_id = ${input.actor}, execution_expires_at = NULL,
            external_reference = ${reference}, last_error = ${note}, next_attempt_at = now(), updated_at = now()
        WHERE id = ${input.operationId}
      `;
      if (String(operation.operation) === "reserve") {
        await tx`
          UPDATE generation_job
          SET status = 'pending_billing', failure_class = NULL, failure_detail = NULL, updated_at = now()
          WHERE id = ${String(operation.job_id)} AND status = 'billing_unknown'
        `;
      }
    }

    const updated = await tx<Row[]>`
      SELECT operation.*, job.tenant_id, job.model_id, job.status AS job_status
      FROM billing_operation operation
      JOIN generation_job job ON job.id = operation.job_id
      WHERE operation.id = ${input.operationId}
    `;
    if (!updated[0]) throw new Error("Billing operation disappeared during reconciliation.");
    return mapBillingOperationView(updated[0]);
  });
}
