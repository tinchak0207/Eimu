import { randomUUID } from "node:crypto";

import { configuredGenerationBillingAdapter, type GenerationBillingAdapter } from "../billing-relay";
import { ensureAccountBaselines, recordConsumption, recordRefund } from "../account-ledger";
import { getGenerationSql, type GenerationSql } from "../database";
import { getGenerationJob, mapGenerationJob } from "../job-repository";
import { JOB_EVENT, emitJobEvent } from "../job-events";
import { claimBillingOperation, committedAmount, dueReservationJobs, ensureRefundOperation, freshJob, markExpiredBillingOperationsUnknown, markFullyRefunded, markOperationRetry, markOperationUnknown, markReservationRejected, moveJobToQueued, terminalReservedJobs } from "./schema";
import { billingRetryAt, classifyBillingFailure, detailOf, operationAttempts, operationStatus, rejectedFailureClass, type BillingReconciliationSummary, type BillingRefundResult, type Row, type SyncReserveOutcome } from "./types";
import { DEFAULT_RECONCILE_BATCH, ZOMBIE_RECLAIM_BATCH, ZOMBIE_RECLAIM_MIN_AGE_MS_DEFAULT } from "./types";
import type { FailureClass, GenerationJob } from "../types";

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
  // replay_denied：claim 已把 reserve op 冻结为 unknown（job → billing_unknown），
  // 不再执行外部扣款；后续由既有 zombie reclaim 走保守全额退款，金额不变。
  if (claim.kind !== "claimed") return freshJob(input.job.id, sql);
  const claimed = claim.row;

  // REQ-E1a 顺序铁律：先种基线（取「扣款之前」的 users.quota），再扣上游，最后记帐本。
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
      // REQ-E1a 双写：legacy 路径的 reserve 是真的动了上游 users.quota（gate 路径
      // billing_amount=0 会在前面早退，永不走到这里），故上游扣款同步记进我方帐本。
      // 记帐失败不挡路，差额由 E1b 对帐报告逐笔指出。
      const ledger = baselineReady
        ? await recordConsumption({
            billingUserId: input.job.billingUserId,
            amountQuota: input.job.billingAmount,
            jobId: input.job.id,
            operationId: String(claimed.id),
            source: "billing-ledger-reserve",
          }, { sql })
        : { posted: false, reason: "基线不可得（未记帐）" };
      if (!ledger.posted) {
        console.error(`[billing-ledger] job ${input.job.id}: reserve 帐本同步未落地（${ledger.reason}）——已由对帐报告负责`);
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

  // 埋点需要知道 INSERT 是否真正落地（重复 reconcile 会命中 ON CONFLICT 无声跳过），
  // 故追加 RETURNING id——不改变写入语义，只让「帐已结」事件不撒谎、不重复。
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
  // 预算耗尽 → claim 已把 refund op 终结为 failed（不重复 credit）。回报 "failed" 而非
  // "pending"：pending 会让呼叫方以为「还在跑、等一下就好」，那是假话。
  if (claim.kind === "replay_denied") return "failed";
  if (claim.kind === "unavailable") return "pending";
  const claimed = claim.row;

  // REQ-E1a 顺序铁律：先种基线（取「加款之前」的 users.quota），再加回上游，最后记帐本。
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
    // REQ-E1a 双写：这笔退款真的把 quota 加回了上游 users.quota，我方帐本同步记加项。
    // 记帐失败不挡路（对帐报告会如实指出这笔未入帐）。
    const ledger = baselineReady
      ? await recordRefund({
          billingUserId: input.job.billingUserId,
          amountQuota: amount,
          jobId: input.job.id,
          operationId: String(claimed.id),
          source: "billing-ledger-refund",
        }, { sql })
      : { posted: false, reason: "基线不可得（未记帐）" };
    if (!ledger.posted) {
      console.error(`[billing-ledger] job ${input.job.id}: refund 帐本同步未落地（${ledger.reason}）——已由对帐报告负责`);
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
  | { action: "needs_review" }
  | { action: "failed"; refundFull: boolean; job: GenerationJob };

/**
 * P0 止血（2026-08-28 域 E）：回收卡死在 pending_billing / billing_unknown 的僵尸。
 *
 * 判据（保守原则：用户亏 1 币重于平台黑 1 币）：
 * - reserve op = applied：扣款已确认但任务未入队（原子更新失败的残留）→
 *   任务重回 queued 继续生成，由正常路径 commit 结帐。
 * - reserve op = pending 且最近一次错误含 "reversed"：ImageBillingRevertedError
 *   只在「subtract 成功→复核失败→add 回滚成功」后抛出，净额为零由代码路径保证；
 *   这是确定性失败（典型：用户余额买不起该模型，每次重试都扣成负数再回滚），
 *   无限重试毫无意义 → CAS 将 op 锁成 failed，任务终结为 failed，不退款。
 * - reserve op = failed：reserve 已被确定性拒绝（4xx），无外部扣款 → 任务 failed，不退款。
 * - reserve op = unknown：扣款是否落地不明 → 标 needs_review，金额不动，不自动退款。
 * - 其余（pending 但无 reversed 凭据）：扣款状态不明 →
 *   任务 failed 后全额退款（宁可平台承担可能的风赠，也不让用户承担不确定）。
 *
 * op 为 pending 时必须先 CAS（带 status='pending' 条件的原子更新）再改任务，
 * 避免与另一个 worker 正在执行的外部扣款赛跑；CAS 影响 0 行 = 本轮有并发 claim，跳过。
 * unknown op 不可再被 claim（claim 只认 pending），无赛跑风险。
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

    if (reserveStatus === "unknown") {
      await tx`
        UPDATE billing_operation
        SET status = 'needs_review', last_error = ${detail}, updated_at = now()
        WHERE job_id = ${input.jobId} AND operation = 'reserve' AND sequence = 1 AND status = 'unknown'
      `;
      await tx`
        UPDATE generation_job
        SET failure_detail = ${detail}, updated_at = now()
        WHERE id = ${input.jobId} AND status IN ('pending_billing', 'billing_unknown')
      `;
      emitJobEvent({ jobId: input.jobId, event: JOB_EVENT.zombieReclaimed, actor: input.executorId, upstreamRaw: reserveError || null, detail: { reserveStatus, refund: "none", review: "needs_review", stuckAs: job.status } }, sql);
      return { action: "needs_review" };
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
  if (disposition.action === "needs_review") {
    console.log(`[billing-reconcile] zombie ${input.jobId}: reserve unknown marked needs_review, amount unchanged`);
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
 * P0 止血（2026-08-28 域 E）：重跑搁浅的 refund operation。
 * terminalReservedJobs 只覆盖 reserve=applied 的终态任务；reserve 非 applied 的
 * 终态任务，其 refund op 一旦落入 pending 就没有任何循环会再碰它——
 * 用户该退的钱永远退不出去。这里按同样的 claim 门禁补一条重试通道。
 * unknown 的 refund 仍保留人工对帐（盲目重放可能已落地的 credit 会双倍退款）。
 *
 * 2026-08-30 整改：failed refund 是确定性拒绝（refundGenerationBilling 对 failed op
 * 直接短路返回 "failed"，永远进不了 claim/执行），把 failed 捞进来只会每 30s 重复
 * 「捞起→短路→返回 failed」刷日志（实证：job 2bc5aefd-… Billing relay refund failed
 * HTTP 404，500000 quota 永远退不掉）。故只重试 status='pending'；failed op 由
 * probe terminal_unsettled(refund_failed) 如实可见、需人工对帐，不再自动重试。
 * 过期的 executing op 已由 markExpiredBillingOperationsUnknown 在同轮冻结为 unknown，
 * 走人工对帐通道，这里不再重扫。
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
// ── 同步路由门面用的帐本原语（V-07/V-08，2026-09-28）──────────────────────
//
// 同步直通路由（/v1/images/edits pixai 分支、/v1/upscale、/v1/template-generations、
// /api/pixai/*）没有 worker 执行，但钱必须跟 durable 任务一样留 billing_operation 列，
// 让 reconcileGenerationBilling／retryStrandedRefundOperations 捞得到。
// 以下两个 export 是**新增**的，不改上方既有函式语义；唯一门面是 ./sync-charge.ts。

/**
 * 同步 job 的预扣。与 reserveGenerationBilling 同一条 claim／外部扣款／帐本双写链，
 * 差别只在 job 状态机：
 *  - 成功：job 保持在「已在执行」态（'running'，租约由门面设），**绝不进 queued**——
 *    同步 job 没有 worker 可接，进队列等于让 worker 再打一次付费上游。
 *  - 确定未扣（rejected／retry 类）：op → failed、job → failed。同步路由不排程重试：
 *    客户当下就拿到 402，不能在背后偷偷扣。
 *  - 不明（unknown）：op → unknown、job → billing_unknown，交既有 zombie reclaim
 *    （标 needs_review，金额不动，不自动全额退款）。
 * 呼叫前 job 必须处于 'submitting'（门面建单时设定），使 dueReservationJobs／
 * zombie reclaim（只认 pending_billing/billing_unknown）在扣款进行中碰不到它。
 */
export async function reserveSyncGenerationBilling(input: {
  job: GenerationJob;
  executorId: string;
  adapter?: GenerationBillingAdapter;
}, sql: GenerationSql = getGenerationSql()): Promise<SyncReserveOutcome> {
  if (!input.job.billingUserId || !input.job.billingAmount) {
    throw new Error(`Sync generation job ${input.job.id} needs a billing user and a positive amount.`);
  }
  const claim = await claimBillingOperation({
    jobId: input.job.id,
    operation: "reserve",
    executorId: input.executorId,
    sql,
  });
  if (claim.kind !== "claimed") {
    return {
      status: "unknown",
      job: await freshJob(input.job.id, sql),
      error: new Error(`Sync reserve for job ${input.job.id} could not be claimed (${claim.kind}).`),
    };
  }
  const claimed = claim.row;

  const baselineReady = await ensureAccountBaselines([input.job.billingUserId], { sql });
  try {
    await (input.adapter ?? configuredGenerationBillingAdapter()).reserve({
      jobId: input.job.id,
      operation: "reserve",
      userId: input.job.billingUserId,
      amount: input.job.billingAmount,
    });
  } catch (error) {
    const detail = detailOf(error);
    const disposition = classifyBillingFailure(error);
    if (disposition === "unknown") {
      await sql.begin(async (tx) => {
        await tx`
          UPDATE billing_operation
          SET status = 'unknown', execution_expires_at = NULL, last_error = ${detail}, updated_at = now()
          WHERE id = ${String(claimed.id)} AND status = 'executing'
        `;
        await tx`
          UPDATE generation_job
          SET status = 'billing_unknown', failure_class = 'unknown', failure_detail = ${detail},
              lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = now()
          WHERE id = ${input.job.id} AND status = 'submitting'
        `;
      });
      emitJobEvent({ jobId: input.job.id, event: JOB_EVENT.billingUnknown, actor: input.executorId, upstreamRaw: detail, detail: { operation: "reserve", jobStatus: "billing_unknown", sync: true } }, sql);
      return { status: "unknown", job: await freshJob(input.job.id, sql), error };
    }
    const failureClass = rejectedFailureClass(error);
    await sql.begin(async (tx) => {
      await tx`
        UPDATE billing_operation
        SET status = 'failed', execution_expires_at = NULL, last_error = ${detail}, updated_at = now()
        WHERE id = ${String(claimed.id)} AND status = 'executing'
      `;
      await tx`
        UPDATE generation_job
        SET status = 'failed', failure_class = ${failureClass}, failure_detail = ${detail},
            finished_at = now(), lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
            updated_at = now()
        WHERE id = ${input.job.id} AND status = 'submitting'
      `;
    });
    emitJobEvent({ jobId: input.job.id, event: JOB_EVENT.jobFailed, actor: input.executorId, upstreamRaw: detail, detail: { reason: "billing_rejected", failureClass, operation: "reserve", disposition, sync: true } }, sql);
    return { status: "rejected", job: await freshJob(input.job.id, sql), error };
  }

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
      SET status = 'running', updated_at = now()
      WHERE id = ${input.job.id} AND status = 'submitting'
    `;
  });
  emitJobEvent({ jobId: input.job.id, event: JOB_EVENT.billingReserved, actor: input.executorId, detail: { amount: input.job.billingAmount, operation: "reserve", sync: true } }, sql);
  const ledger = baselineReady
    ? await recordConsumption({
        billingUserId: input.job.billingUserId,
        amountQuota: input.job.billingAmount,
        jobId: input.job.id,
        operationId: String(claimed.id),
        source: "billing-ledger-reserve",
      }, { sql })
    : { posted: false, reason: "基线不可得（未记帐）" };
  if (!ledger.posted) {
    console.error(`[billing-ledger] sync job ${input.job.id}: reserve 帐本同步未落地（${ledger.reason}）——已由对帐报告负责`);
  }
  return { status: "applied", job: await freshJob(input.job.id, sql) };
}
/**
 * 只落一条 pending 的 refund op（不做外部 credit）。同步门面在回应客户前先把
 * 「该退多少」写进帐本，外部退款放到回应之后执行；进程若在那之前死掉，
 * reconcileGenerationBilling（failed 终态）或 retryStrandedRefundOperations
 * （succeeded 终态的部分退款）会捞到这条 op 补退。与 refundGenerationBilling
 * 共用同一个 ensureRefundOperation（同 idempotency_ref，金额冲突即抛）。
 */
export async function recordPendingGenerationRefund(
  job: GenerationJob,
  amount: number,
  sql: GenerationSql = getGenerationSql(),
): Promise<void> {
  if (!amount) return;
  if (amount < 0 || amount > job.billingAmount) {
    throw new Error(`Invalid refund amount for generation job ${job.id}.`);
  }
  await ensureRefundOperation(job, amount, sql);
}
