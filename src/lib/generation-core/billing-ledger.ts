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
import { ensureAccountBaselines, recordConsumption, recordRefund } from "./account-ledger";
import { getGenerationJob, mapGenerationJob } from "./job-repository";
import { JOB_EVENT, emitJobEvent } from "./job-events";
import {
  billingReplayDenialDetail,
  planBillingAttemptReplay,
  type BillingReplayOperation,
  type ReplayPlan,
} from "./operation-registry";
import type { FailureClass, GenerationJob } from "./types";

type Row = Record<string, unknown>;
type BillingOperation = "reserve" | "commit" | "refund";

const EXECUTION_LEASE_MS = 45_000;
const DEFAULT_RECONCILE_BATCH = 50;

// P0 止血（2026-08-28 域 E）：殭屍回收門檻。非終態卡在計費狀態超過此時長的任務，
// 由 reconcile 強制對帳（該 refund 的 refund、確定性失敗的終結），不再無限重試。
// P1 拆除 reserve 阻塞閘門後本段整體退役。
const ZOMBIE_RECLAIM_MIN_AGE_MS_DEFAULT = 6 * 60 * 60 * 1000;
const ZOMBIE_RECLAIM_BATCH = 100;

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

/** 計費動作 → 封閉 registry 的動作鍵（FG-b：重放預算的唯一來源）。 */
const BILLING_REPLAY_KEY: Record<BillingOperation, BillingReplayOperation> = {
  reserve: "billing.reserve",
  commit: "billing.commit",
  refund: "billing.refund",
};

type BillingClaimOutcome =
  | { kind: "claimed"; row: Row }
  | { kind: "unavailable" }
  | { kind: "replay_denied"; plan: ReplayPlan };

/**
 * claim = 計費動作的自動重放裁決點。CAS（status='pending' → 'executing' ＋ 租約）
 * 仍是併發邊界；差別是 claim 成功後**先問封閉 operation registry「這次嘗試准不准」**，
 * 不許就更不執行外部扣款／退款。裁決序號用 RETURNING 的 attempt_count：
 * UPDATE 內已 +1，故它就是「即將執行的這次嘗試」的序號（FG 教訓：先定序號語義再改點）。
 *
 * 被拒時的終結刻意沿用既有桶，不動金額與狀態機語義：
 *  - reserve → unknown（扣款狀態不明 → 既有 6h zombie reclaim 全額退款給用戶，用戶不虧）
 *  - refund  → failed（退款未落地且不再自動重試 → 出現在 probe 的 refund_failed 名單）
 */
async function claimBillingOperation(input: {
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
    emitJobEvent({ jobId: input.job.id, event: JOB_EVENT.jobRequeued, actor: input.executorId, detail: { reason: "zero_amount" } }, sql);
    return freshJob(input.job.id, sql);
  }
  if (!input.job.billingUserId) {
    throw new Error(`Generation job ${input.job.id} has a billing amount but no billing user.`);
  }
  if (input.job.status !== "pending_billing") return freshJob(input.job.id, sql);

  const claim = await claimBillingOperation({
    jobId: input.job.id,
    operation: "reserve",
    executorId: input.executorId,
    sql,
  });
  // replay_denied：claim 已把 reserve op 凍結為 unknown（job → billing_unknown），
  // 不再執行外部扣款；後續由既有 zombie reclaim 走保守全額退款，金額不變。
  if (claim.kind !== "claimed") return freshJob(input.job.id, sql);
  const claimed = claim.row;

  // REQ-E1a 順序鐵律：先種基線（取「扣款之前」的 users.quota），再扣上游，最後記帳本。
  const baselineReady = await ensureAccountBaselines([input.job.billingUserId], { sql });
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
        emitJobEvent({ jobId: input.job.id, event: JOB_EVENT.billingReserved, actor: input.executorId, detail: { amount: input.job.billingAmount, operation: "reserve" } }, sql);
      });
      // REQ-E1a 雙寫：legacy 路徑的 reserve 是真的動了上游 users.quota（gate 路徑
      // billing_amount=0 會在前面早退，永不走到這裡），故上游扣款同步記進我方帳本。
      // 記帳失敗不擋路，差額由 E1b 對帳報告逐筆指出。
      const ledger = baselineReady
        ? await recordConsumption({
            billingUserId: input.job.billingUserId,
            amountQuota: input.job.billingAmount,
            jobId: input.job.id,
            operationId: String(claimed.id),
            source: "billing-ledger-reserve",
          }, { sql })
        : { posted: false, reason: "基線不可得（未記帳）" };
      if (!ledger.posted) {
        console.error(`[billing-ledger] job ${input.job.id}: reserve 帳本同步未落地（${ledger.reason}）——已由對帳報告負責`);
      }
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
      emitJobEvent({ jobId: input.job.id, event: JOB_EVENT.billingRetryScheduled, actor: input.executorId, upstreamRaw: detail, detail: { operation: "reserve", nextAttemptAt: billingRetryAt(error, operationAttempts(claimed)).toISOString() } }, sql);
    } else if (disposition === "rejected") {
      await markReservationRejected({
        id: String(claimed.id),
        jobId: input.job.id,
        detail,
        failureClass: rejectedFailureClass(error),
        sql,
      });
      emitJobEvent({ jobId: input.job.id, event: JOB_EVENT.jobFailed, actor: input.executorId, upstreamRaw: detail, detail: { reason: "billing_rejected", failureClass: rejectedFailureClass(error), operation: "reserve" } }, sql);
    } else {
      await markOperationUnknown({
        id: String(claimed.id),
        jobId: input.job.id,
        operation: "reserve",
        detail,
        sql,
      });
      emitJobEvent({ jobId: input.job.id, event: JOB_EVENT.billingUnknown, actor: input.executorId, upstreamRaw: detail, detail: { operation: "reserve", jobStatus: "billing_unknown" } }, sql);
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

  // 埋點需要知道 INSERT 是否真正落地（重複 reconcile 會命中 ON CONFLICT 無聲跳過），
  // 故追加 RETURNING id——不改變寫入語義，只讓「帳已結」事件不撒謊、不重複。
  const applied = await sql<Row[]>`
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
    RETURNING id
  `;
  if (applied[0]) {
    emitJobEvent({ jobId: job.id, event: JOB_EVENT.billingCommitted, actor: "system", detail: { amount, operation: "commit" } }, sql);
  }
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

  const claim = await claimBillingOperation({
    jobId: input.job.id,
    operation: "refund",
    executorId: input.executorId,
    sql,
  });
  // 預算耗盡 → claim 已把 refund op 終結為 failed（不重複 credit）。回報 "failed" 而非
  // "pending"：pending 會讓呼叫方以為「還在跑、等一下就好」，那是假話。
  if (claim.kind === "replay_denied") return "failed";
  if (claim.kind === "unavailable") return "pending";
  const claimed = claim.row;

  // REQ-E1a 順序鐵律：先種基線（取「加款之前」的 users.quota），再加回上游，最後記帳本。
  const baselineReady = await ensureAccountBaselines([input.job.billingUserId], { sql });
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
      if (!applied[0]) return;
      emitJobEvent({ jobId: input.job.id, event: JOB_EVENT.billingRefunded, actor: input.executorId, detail: { amount, operation: "refund", full: amount === input.job.billingAmount } }, sql);
      if (amount !== input.job.billingAmount) return;
      await tx`
        UPDATE generation_job
        SET status = 'refunded', finished_at = COALESCE(finished_at, now()), updated_at = now()
        WHERE id = ${input.job.id} AND status IN ('failed', 'cancelled')
      `;
    });
    // REQ-E1a 雙寫：這筆退款真的把 quota 加回了上游 users.quota，我方帳本同步記加項。
    // 記帳失敗不擋路（對帳報告會如實指出這筆未入帳）。
    const ledger = baselineReady
      ? await recordRefund({
          billingUserId: input.job.billingUserId,
          amountQuota: amount,
          jobId: input.job.id,
          operationId: String(claimed.id),
          source: "billing-ledger-refund",
        }, { sql })
      : { posted: false, reason: "基線不可得（未記帳）" };
    if (!ledger.posted) {
      console.error(`[billing-ledger] job ${input.job.id}: refund 帳本同步未落地（${ledger.reason}）——已由對帳報告負責`);
    }
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
      emitJobEvent({ jobId: input.job.id, event: JOB_EVENT.billingRetryScheduled, actor: input.executorId, upstreamRaw: detail, detail: { operation: "refund", nextAttemptAt: billingRetryAt(error, operationAttempts(claimed)).toISOString() } }, sql);
      return "pending";
    }
    if (disposition === "rejected") {
      await sql`
        UPDATE billing_operation
        SET status = 'failed', execution_expires_at = NULL, last_error = ${detail}, updated_at = now()
        WHERE id = ${String(claimed.id)} AND status = 'executing'
      `;
      emitJobEvent({ jobId: input.job.id, event: JOB_EVENT.billingRefundFailed, actor: input.executorId, upstreamRaw: detail, detail: { amount, operation: "refund" } }, sql);
      return "failed";
    }
    await markOperationUnknown({
      id: String(claimed.id),
      jobId: input.job.id,
      operation: "refund",
      detail,
      sql,
    });
    emitJobEvent({ jobId: input.job.id, event: JOB_EVENT.billingUnknown, actor: input.executorId, upstreamRaw: detail, detail: { operation: "refund" } }, sql);
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
  zombieReclaims: number;
  strandedRefundRetries: number;
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
    zombieReclaims: 0,
    strandedRefundRetries: 0,
  };

  summary.zombieReclaims = await reclaimStaleBillingZombies({ executorId: input.executorId, adapter: input.adapter, sql });
  summary.strandedRefundRetries = await retryStrandedRefundOperations({ executorId: input.executorId, adapter: input.adapter, sql });

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

function zombieReclaimAgeMs(): number {
  const raw = Number(process.env.GENERATION_BILLING_ZOMBIE_AGE_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : ZOMBIE_RECLAIM_MIN_AGE_MS_DEFAULT;
}

function zombieFailureClass(reserveError: string): FailureClass {
  return /余额不足|quota/i.test(reserveError) ? "quota_exhausted" : "unknown";
}

type ZombieDisposition =
  | { action: "skip" }
  | { action: "requeued" }
  | { action: "failed"; refundFull: boolean; job: GenerationJob };

/**
 * P0 止血（2026-08-28 域 E）：回收卡死在 pending_billing / billing_unknown 的殭屍。
 *
 * 判據（保守原則：用戶虧 1 幣重於平台黑 1 幣）：
 * - reserve op = applied：扣款已確認但任務未入隊（原子更新失敗的殘留）→
 *   任務重回 queued 繼續生成，由正常路徑 commit 結帳。
 * - reserve op = pending 且最近一次錯誤含 "reversed"：ImageBillingRevertedError
 *   只在「subtract 成功→複核失敗→add 回滾成功」後拋出，淨額為零由代碼路徑保證；
 *   這是確定性失敗（典型：用戶餘額買不起該模型，每次重試都扣成負數再回滾），
 *   無限重試毫無意義 → CAS 將 op 鎖成 failed，任務終結為 failed，不退款。
 * - reserve op = failed：reserve 已被確定性拒絕（4xx），無外部扣款 → 任務 failed，不退款。
 * - 其餘（op = unknown，或 pending 但無 reversed 憑據）：扣款狀態不明 →
 *   任務 failed 後全額退款（寧可平台承擔可能的風贈，也不讓用戶承擔不確定）。
 *
 * op 為 pending 時必須先 CAS（帶 status='pending' 條件的原子更新）再改任務，
 * 避免與另一個 worker 正在執行的外部扣款賽跑；CAS 影響 0 行 = 本輪有併發 claim，跳過。
 * unknown op 不可再被 claim（claim 只認 pending），無賽跑風險。
 */
async function reclaimStaleBillingZombies(input: {
  executorId: string;
  adapter?: GenerationBillingAdapter;
  sql: GenerationSql;
}): Promise<number> {
  const ageMs = zombieReclaimAgeMs();
  const candidates = await input.sql<Row[]>`
    SELECT job.id
    FROM generation_job job
    JOIN billing_operation reserve
      ON reserve.job_id = job.id
      AND reserve.operation = 'reserve'
      AND reserve.sequence = 1
    WHERE job.status IN ('pending_billing', 'billing_unknown')
      AND reserve.status IN ('pending', 'unknown', 'failed', 'applied')
      AND job.created_at < now() - (${String(ageMs)}::text || ' milliseconds')::interval
    ORDER BY job.created_at
    LIMIT ${ZOMBIE_RECLAIM_BATCH}
  `;
  let reclaimed = 0;
  for (const candidate of candidates) {
    const jobId = String(candidate.id);
    try {
      reclaimed += await reclaimOneZombie({ jobId, executorId: input.executorId, adapter: input.adapter }, input.sql);
    } catch (error) {
      console.error(`[billing-reconcile] zombie reclaim failed for job ${jobId}`, error);
    }
  }
  return reclaimed;
}

async function reclaimOneZombie(input: {
  jobId: string;
  executorId: string;
  adapter?: GenerationBillingAdapter;
}, sql: GenerationSql): Promise<number> {
  const disposition = await sql.begin<ZombieDisposition>(async (tx): Promise<ZombieDisposition> => {
    const rows = await tx<Row[]>`
      SELECT job.*, reserve.status AS reserve_status, reserve.last_error AS reserve_error
      FROM generation_job job
      JOIN billing_operation reserve
        ON reserve.job_id = job.id
        AND reserve.operation = 'reserve'
        AND reserve.sequence = 1
      WHERE job.id = ${input.jobId}
      FOR UPDATE OF job, reserve
    `;
    const row = rows[0];
    if (!row) return { action: "skip" };
    const job = mapGenerationJob(row);
    if (job.status !== "pending_billing" && job.status !== "billing_unknown") return { action: "skip" };
    const reserveStatus = String(row.reserve_status ?? "");
    const reserveError = row.reserve_error === null || row.reserve_error === undefined ? "" : String(row.reserve_error);
    const detail = `Billing zombie auto-reclaim (stuck as ${job.status}; reserve ${reserveStatus}${reserveError ? `: ${reserveError}` : ""})`.slice(0, 2000);

    if (reserveStatus === "applied") {
      await tx`
        UPDATE generation_job
        SET status = 'queued', available_at = now(), failure_class = NULL, failure_detail = NULL, updated_at = now()
        WHERE id = ${input.jobId} AND status IN ('pending_billing', 'billing_unknown')
      `;
      emitJobEvent({ jobId: input.jobId, event: JOB_EVENT.zombieRequeued, actor: input.executorId, upstreamRaw: reserveError || null, detail: { reserveStatus, stuckAs: job.status } }, sql);
      return { action: "requeued" };
    }

    if (reserveStatus === "pending" && /reversed/i.test(reserveError)) {
      const claimed = await tx<Row[]>`
        UPDATE billing_operation
        SET status = 'failed', execution_expires_at = NULL, last_error = ${detail}, updated_at = now()
        WHERE job_id = ${input.jobId} AND operation = 'reserve' AND sequence = 1 AND status = 'pending'
        RETURNING id
      `;
      if (!claimed[0]) return { action: "skip" };
      await tx`
        UPDATE generation_job
        SET status = 'failed', failure_class = ${zombieFailureClass(reserveError)},
            failure_detail = ${detail}, finished_at = now(), updated_at = now()
        WHERE id = ${input.jobId} AND status IN ('pending_billing', 'billing_unknown')
      `;
      emitJobEvent({ jobId: input.jobId, event: JOB_EVENT.zombieReclaimed, actor: input.executorId, upstreamRaw: reserveError || null, detail: { reserveStatus, refund: "none", stuckAs: job.status, failureClass: zombieFailureClass(reserveError) } }, sql);
      return { action: "failed", refundFull: false, job };
    }

    if (reserveStatus === "failed") {
      await tx`
        UPDATE generation_job
        SET status = 'failed', failure_class = 'unknown',
            failure_detail = ${detail}, finished_at = now(), updated_at = now()
        WHERE id = ${input.jobId} AND status IN ('pending_billing', 'billing_unknown')
      `;
      emitJobEvent({ jobId: input.jobId, event: JOB_EVENT.zombieReclaimed, actor: input.executorId, upstreamRaw: reserveError || null, detail: { reserveStatus, refund: "none", stuckAs: job.status } }, sql);
      return { action: "failed", refundFull: false, job };
    }

    if (reserveStatus === "pending") {
      const claimed = await tx<Row[]>`
        UPDATE billing_operation
        SET status = 'failed', execution_expires_at = NULL, last_error = ${detail}, updated_at = now()
        WHERE job_id = ${input.jobId} AND operation = 'reserve' AND sequence = 1 AND status = 'pending'
        RETURNING id
      `;
      if (!claimed[0]) return { action: "skip" };
    }
    await tx`
      UPDATE generation_job
      SET status = 'failed', failure_class = 'unknown',
          failure_detail = ${detail}, finished_at = now(), updated_at = now()
      WHERE id = ${input.jobId} AND status IN ('pending_billing', 'billing_unknown')
    `;
    emitJobEvent({ jobId: input.jobId, event: JOB_EVENT.zombieReclaimed, actor: input.executorId, upstreamRaw: reserveError || null, detail: { reserveStatus, refund: "full", stuckAs: job.status } }, sql);
    return { action: "failed", refundFull: true, job };
  });

  if (disposition.action === "requeued") {
    console.log(`[billing-reconcile] zombie ${input.jobId}: requeued (reserve applied)`);
    return 1;
  }
  if (disposition.action !== "failed") return 0;
  if (!disposition.refundFull) {
    console.log(`[billing-reconcile] zombie ${input.jobId}: failed without refund (net-zero evidenced)`);
    return 1;
  }
  let refundResult: BillingRefundResult;
  try {
    refundResult = await refundGenerationBilling({
      job: disposition.job,
      executorId: input.executorId,
      adapter: input.adapter,
    }, sql);
  } catch (error) {
    console.error(`[billing-reconcile] zombie ${input.jobId}: refund threw after terminal fail`, error);
    return 1;
  }
  console.log(`[billing-reconcile] zombie ${input.jobId}: failed with full refund attempt -> ${refundResult}`);
  return 1;
}

/**
 * P0 止血（2026-08-28 域 E）：重跑擱淺的 refund operation。
 * terminalReservedJobs 只覆蓋 reserve=applied 的終態任務；reserve 非 applied 的
 * 終態任務，其 refund op 一旦落入 pending 就沒有任何循環會再碰它——
 * 用戶該退的錢永遠退不出去。這裡按同樣的 claim 門禁補一條重試通道。
 * unknown 的 refund 仍保留人工對帳（盲目重放可能已落地的 credit 會雙倍退款）。
 *
 * 2026-08-30 整改：failed refund 是確定性拒絕（refundGenerationBilling 對 failed op
 * 直接短路返回 "failed"，永遠進不了 claim/執行），把 failed 撈進來只會每 30s 重複
 * 「撈起→短路→返回 failed」刷日誌（實證：job 2bc5aefd-… Billing relay refund failed
 * HTTP 404，500000 quota 永遠退不掉）。故只重試 status='pending'；failed op 由
 * probe terminal_unsettled(refund_failed) 如實可見、需人工對帳，不再自動重試。
 * 過期的 executing op 已由 markExpiredBillingOperationsUnknown 在同輪凍結為 unknown，
 * 走人工對帳通道，這裡不再重掃。
 */
export async function retryStrandedRefundOperations(input: {
  executorId: string;
  adapter?: GenerationBillingAdapter;
  sql: GenerationSql;
}): Promise<number> {
  const ageMs = zombieReclaimAgeMs();
  const candidates = await input.sql<Row[]>`
    SELECT job.id, refund_op.amount AS refund_amount
    FROM generation_job job
    JOIN billing_operation refund_op
      ON refund_op.job_id = job.id
      AND refund_op.operation = 'refund'
      AND refund_op.sequence = 1
    WHERE refund_op.status = 'pending'
      AND refund_op.next_attempt_at <= now()
      AND refund_op.amount > 0
      AND job.status IN ('succeeded', 'failed', 'cancelled')
      AND job.finished_at < now() - (${String(ageMs)}::text || ' milliseconds')::interval
    ORDER BY job.finished_at NULLS LAST
    LIMIT ${ZOMBIE_RECLAIM_BATCH}
  `;
  let retried = 0;
  for (const candidate of candidates) {
    const jobId = String(candidate.id);
    const job = await getGenerationJob(jobId, input.sql);
    if (!job) continue;
    try {
      const result = await refundGenerationBilling({
        job,
        amount: Number(candidate.refund_amount),
        executorId: input.executorId,
        adapter: input.adapter,
      }, input.sql);
      emitJobEvent({ jobId, event: JOB_EVENT.strandedRefundRetried, actor: input.executorId, detail: { amount: Number(candidate.refund_amount), result } }, input.sql);
      if (result === "applied") retried += 1;
      console.log(`[billing-reconcile] stranded refund retry ${jobId} (amount ${String(candidate.refund_amount)}) -> ${result}`);
    } catch (error) {
      console.error(`[billing-reconcile] stranded refund retry failed for job ${jobId}`, error);
    }
  }
  return retried;
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
      // FG-b：人工重試同時把自動重放預算歸零（attempt_count = 0）。operation registry
      // 的預算是**自動**重放的預算，不該否決一個明確的人工決定——否則預算耗盡後
      // 這個入口會變成看得到摸不到的空殼（claim 每次都立刻被拒）。
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
