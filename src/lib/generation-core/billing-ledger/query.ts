import { getGenerationSql, type GenerationSql } from "../database";
import { JOB_EVENT, emitJobEvent } from "../job-events";
import type { GenerationJob } from "../types";
import type { BillingOperation, BillingOperationView, ManualBillingAction, Row } from "./types";

export function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : new Date(String(value));
}

export function mapBillingOperationView(row: Row): BillingOperationView {
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

  const view = await sql.begin(async (tx) => {
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
      // FG-b：人工重试同时把自动重放预算归零（attempt_count = 0）。operation registry
      // 的预算是**自动**重放的预算，不该否决一个明确的人工决定——否则预算耗尽后
      // 这个入口会变成看得到摸不到的空壳（claim 每次都立刻被拒）。
      await tx`
        UPDATE billing_operation
        SET status = 'pending', executor_id = ${input.actor}, execution_expires_at = NULL,
            attempt_count = 0, external_reference = ${reference}, last_error = ${note},
            next_attempt_at = now(), updated_at = now()
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
  emitJobEvent({ jobId: view.jobId, event: JOB_EVENT.billingManuallyReconciled, actor: input.actor, upstreamRaw: note, detail: { action: input.action, operation: view.operation, status: view.status, jobStatus: view.jobStatus, amount: view.amount, manual: true, note } }, sql);
  return view;
}
