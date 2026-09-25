import { getGenerationSql, type GenerationSql } from "./database";

// P1.5 事件賬本 + probe 偵查面（2026-08-28 中控外科手術）。
// 目標：任意一筆失敗 job，probe 一條命令 30 秒內給出死因 + 上游錯誤原文，
// 全程不開 docker exec、不進 VPS。
//
// 遙測兩鐵律：可以晚到，不可以不寫；不擋路。
// - emitJobEvent 是 fire-and-forget：埋點失敗只 console.error，永不讓主流程失敗。
// - 上游錯誤原文（upstreamRaw）原樣入庫不改寫；話術只許存在於展示層。

type Row = Record<string, unknown>;

/** P1.5 事件詞彙表。寫 generation_job / billing_operation 狀態的地方必須挑一個發出。 */
export const JOB_EVENT = {
  billingReserved: "billing_reserved", // reserve op 落地（job → queued）
  billingCommitted: "billing_committed", // commit op 落地
  billingRefunded: "billing_refunded", // refund op 落地（全額時 job → refunded）
  billingRetryScheduled: "billing_retry_scheduled", // op 退回 pending 等待下次嘗試
  billingUnknown: "billing_unknown", // op 凍結為 unknown（reserve 時 job → billing_unknown）
  billingRefundFailed: "billing_refund_failed", // refund op 確定性失敗（4xx）
  jobFailed: "job_failed", // job → failed（計費拒絕）
  jobCancelled: "job_cancelled", // job → cancelled（用戶人工終止）
  jobRequeued: "job_requeued", // job → queued（零金額免計費直通）
  zombieRequeued: "zombie_requeued", // 殭屍回收：reserve 已落地 → 重回隊列
  zombieReclaimed: "zombie_reclaimed", // 殭屍回收：終結為 failed
  strandedRefundRetried: "stranded_refund_retried", // 擱淺退款通道重試
  billingManuallyReconciled: "billing_manually_reconciled", // 管理員人工對帳
  // INC-0830-VIDEO：attempt 生命週期事件（worker 前綴 actor）。append-only 只 INSERT。
  attemptSubmitted: "attempt_submitted", // attempt 已向上游提交（detail 帶 provider_task_id）
  attemptSucceeded: "attempt_succeeded", // attempt 成功（artifact 已落庫）
  attemptFailed: "attempt_failed", // attempt 失敗（upstream_raw = 錯誤原文，不改寫）
  // FG-02/03：自動重放被 registry 拒絕（detail 帶 operation/denial_reason/預算）。
  // 只發拒絕事件（允許重放不發，量太大且 attempt_failed 已覆蓋）。
  replayDenied: "replay_denied",
  // INC-0831：provider 對帳事件。deadline/易主不再單方面宣判失敗——上游真相以
  // 對帳輪詢為準，錢在真相出來前凍結。
  reconcileFrozen: "reconcile_frozen", // job 進入對帳凍結（deadline 到/易主，但上游任務仍在跑）
  reconcilePolled: "reconcile_polled", // 對帳輪詢一次（detail 帶 state）
  reconcileDelivered: "reconcile_delivered", // 對帳確認成功 → artifact 落地 + job succeeded
  reconcileFailed: "reconcile_failed", // 對帳確認上游失敗 → 才退款
  reconcileExhausted: "reconcile_exhausted", // 對帳窗口耗盡（默認凍結+人工，不退款）
} as const;

export type JobEventName = (typeof JOB_EVENT)[keyof typeof JOB_EVENT];

export interface JobEventInput {
  jobId: string;
  event: string;
  actor?: string | null;
  /** 上游/底層錯誤原文，不改寫入庫。 */
  upstreamRaw?: string | null;
  detail?: unknown;
}

function normalizeDetail(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;
  const value = typeof detail === "object" ? detail : { value: detail };
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: String(detail) });
  }
}

/**
 * Fire-and-forget 追加一行事件。永不 throw、永不 await——遙測不擋主流程；
 * 失敗只 console.error（可以晚到，不可以不寫：由 reconcile 周期性補寫語義兜底）。
 */
export function emitJobEvent(input: JobEventInput, sql: GenerationSql = getGenerationSql()): void {
  const detailJson = normalizeDetail(input.detail);
  const tag = `[job-events] job=${input.jobId} event=${input.event}`;
  try {
    void sql`
      INSERT INTO job_events (job_id, event, actor, upstream_raw, detail)
      VALUES (${input.jobId}, ${input.event}, ${input.actor ?? null}, ${input.upstreamRaw ?? null}, ${detailJson}::jsonb)
    `.catch((error: unknown) => {
      console.error(`${tag} emit failed`, error);
    });
  } catch (error) {
    console.error(`${tag} emit failed`, error);
  }
}

export interface JobTimelineEntry {
  kind: "job" | "event" | "billing_operation";
  at: string | null;
  label: string;
  actor: string | null;
  upstreamRaw: string | null;
  detail: unknown;
}

export interface JobTimeline {
  job: Record<string, unknown> | null;
  timeline: JobTimelineEntry[];
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * 一條查詢（UNION ALL）返回 job 建單 → 當前狀態 → 全部事件 → 全部計費操作
 * 的完整時間線，含上游錯誤原文（job_events.upstream_raw / billing_operation.last_error）。
 * job 不存在時返回 null。
 */
export async function getJobTimeline(jobId: string, sql: GenerationSql = getGenerationSql()): Promise<JobTimeline | null> {
  const rows = await sql<Row[]>`
    WITH job AS (
      SELECT * FROM generation_job WHERE id = ${jobId}
    )
    SELECT * FROM (
      SELECT 'job'::text AS kind, job.created_at AS at, 'job_created'::text AS label,
        NULL::text AS actor, NULL::text AS upstream_raw,
        jsonb_build_object(
          'id', job.id, 'kind', job.kind, 'model_id', job.model_id, 'tenant_id', job.tenant_id,
          'billing_amount', job.billing_amount, 'requested_count', job.requested_count,
          'completed_count', job.completed_count
        ) AS detail
      FROM job
      UNION ALL
      SELECT 'job', job.updated_at, 'job_current:' || job.status, NULL, NULL,
        jsonb_build_object(
          'id', job.id, 'status', job.status, 'kind', job.kind, 'model_id', job.model_id,
          'tenant_id', job.tenant_id, 'failure_class', job.failure_class,
          'failure_detail', job.failure_detail, 'billing_amount', job.billing_amount,
          'requested_count', job.requested_count, 'completed_count', job.completed_count,
          'attempt_count', job.attempt_count, 'lease_owner', job.lease_owner,
          'lease_expires_at', job.lease_expires_at, 'created_at', job.created_at,
          'started_at', job.started_at, 'finished_at', job.finished_at, 'updated_at', job.updated_at
        )
      FROM job
      UNION ALL
      SELECT 'job', job.finished_at, 'job_finished:' || job.status, NULL, NULL,
        jsonb_build_object('status', job.status, 'failure_class', job.failure_class, 'failure_detail', job.failure_detail)
      FROM job
      WHERE job.finished_at IS NOT NULL
      UNION ALL
      SELECT 'event', e.at, e.event, e.actor, e.upstream_raw, e.detail
      FROM job_events e
      WHERE e.job_id = ${jobId}
      UNION ALL
      SELECT 'billing_operation', o.created_at, o.operation || ':' || o.status, o.executor_id, o.last_error,
        jsonb_build_object(
          'id', o.id, 'operation', o.operation, 'status', o.status, 'amount', o.amount,
          'attempt_count', o.attempt_count, 'applied_at', o.applied_at,
          'next_attempt_at', o.next_attempt_at, 'updated_at', o.updated_at
        )
      FROM billing_operation o
      WHERE o.job_id = ${jobId}
    ) timeline
    ORDER BY at ASC NULLS LAST
  `;
  if (!rows.length) return null;

  let job: Record<string, unknown> | null = null;
  const timeline: JobTimelineEntry[] = [];
  for (const row of rows) {
    const entry: JobTimelineEntry = {
      kind: String(row.kind) as JobTimelineEntry["kind"],
      at: toIso(row.at),
      label: String(row.label),
      actor: row.actor === null || row.actor === undefined ? null : String(row.actor),
      upstreamRaw: row.upstream_raw === null || row.upstream_raw === undefined ? null : String(row.upstream_raw),
      detail: row.detail ?? null,
    };
    if (entry.label.startsWith("job_current:")) {
      job = (entry.detail && typeof entry.detail === "object" ? entry.detail : null) as Record<string, unknown> | null;
      continue;
    }
    timeline.push(entry);
  }
  return { job, timeline };
}

export type StuckCause =
  | "pending_billing" // 未受理：卡在計費閘，reserve op 沒被執行
  | "billing_unknown" // 計費結果不明，被凍結
  | "running_stalled" // 提交/執行/輪詢停滯（輪詢斷）
  | "terminal_unsettled"; // 已終態但帳未結（終態未投影）

export interface StuckJob {
  jobId: string;
  status: string;
  kind: string;
  modelId: string;
  tenantId: string;
  cause: StuckCause;
  minutesStuck: number;
  createdAt: string | null;
  updatedAt: string | null;
  evidence: Record<string, unknown>;
}

function evidenceOf(row: Row): Record<string, unknown> {
  return {
    failureClass: row.failure_class ?? null,
    failureDetail: row.failure_detail ?? null,
    leaseOwner: row.lease_owner ?? null,
    leaseExpiresAt: toIso(row.lease_expires_at),
    billingAmount: row.billing_amount === null || row.billing_amount === undefined ? null : Number(row.billing_amount),
    reserve: {
      status: row.reserve_status ?? null,
      executorId: row.reserve_executor_id ?? null,
      lastError: row.reserve_last_error ?? null,
      nextAttemptAt: toIso(row.reserve_next_attempt_at),
    },
    commitStatus: row.commit_status ?? null,
    commitLastError: row.commit_last_error ?? null,
    refund: {
      status: row.refund_status ?? null,
      amount: row.refund_amount === null || row.refund_amount === undefined ? null : Number(row.refund_amount),
      lastError: row.refund_last_error ?? null,
    },
  };
}

/**
 * 死因分類（純函數，便於測試）。輸入必須來自 listStuckJobs 的查詢行。
 */
export function classifyStuckCause(row: Row): StuckCause {
  const status = String(row.status);
  if (status === "pending_billing") return "pending_billing";
  if (status === "billing_unknown") return "billing_unknown";
  if (["succeeded", "failed", "cancelled", "refunded"].includes(status)) return "terminal_unsettled";
  return "running_stalled";
}

function unsettledReason(row: Row): string {
  if (String(row.status) === "succeeded" && (row.commit_status === null || row.commit_status === undefined)) {
    return "commit_missing";
  }
  // 已扣款結算失敗（OBS-1）：succeeded 且 commit 行存在但 status='failed'——必須如實標，
  // 不得掉進退款分支被誤標成 refund_*（語義是「結算失敗」，不是「退款進行中」）。
  if (String(row.status) === "succeeded" && String(row.commit_status ?? "") === "failed") {
    return "commit_failed";
  }
  const refundStatus = row.refund_status === null || row.refund_status === undefined ? "" : String(row.refund_status);
  return refundStatus === "failed" ? "refund_failed" : "refund_pending";
}

/**
 * 滯留名單：非終態停滯超過 minutes，或終態但帳未結。
 * 一條查詢同時取回 reserve/commit/refund op 摘要作為死因證據（含 last_error 原文）。
 */
export async function listStuckJobs(input: {
  minutes?: number;
  limit?: number;
  sql?: GenerationSql;
} = {}): Promise<StuckJob[]> {
  const sql = input.sql ?? getGenerationSql();
  const minutes = Math.max(1, Math.min(Math.floor(input.minutes ?? 30), 60 * 24 * 7));
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 200), 500));
  const rows = await sql<Row[]>`
    SELECT job.id, job.status, job.kind, job.model_id, job.tenant_id,
      job.created_at, job.updated_at, job.finished_at, job.failure_class, job.failure_detail,
      job.lease_owner, job.lease_expires_at, job.billing_amount,
      reserve.status AS reserve_status, reserve.executor_id AS reserve_executor_id,
      reserve.last_error AS reserve_last_error, reserve.next_attempt_at AS reserve_next_attempt_at,
      commit_op.status AS commit_status, commit_op.last_error AS commit_last_error,
      refund_op.status AS refund_status, refund_op.amount AS refund_amount,
      refund_op.last_error AS refund_last_error
    FROM generation_job job
    LEFT JOIN billing_operation reserve
      ON reserve.job_id = job.id AND reserve.operation = 'reserve' AND reserve.sequence = 1
    LEFT JOIN billing_operation commit_op
      ON commit_op.job_id = job.id AND commit_op.operation = 'commit' AND commit_op.sequence = 1
    LEFT JOIN billing_operation refund_op
      ON refund_op.job_id = job.id AND refund_op.operation = 'refund' AND refund_op.sequence = 1
    WHERE (
      job.status IN ('pending_billing', 'billing_unknown', 'queued', 'leased', 'submitting', 'running', 'submit_unknown')
      AND job.updated_at < now() - (${String(minutes)}::text || ' minutes')::interval
    ) OR (
      job.status IN ('succeeded', 'failed', 'cancelled', 'refunded')
      AND (
        (refund_op.status IN ('pending', 'failed') AND refund_op.amount > 0)
        OR (job.status = 'succeeded' AND job.billing_amount > 0 AND commit_op.status IS NULL)
        -- OBS-1：已扣款、commit 行存在卻「結算失敗」（status='failed'，非缺行也非 applied）
        -- 的終態作業先前被漏列——探針必須看得見錢卡死的作業（只加觀測，退款/重放仍歸對賬）。
        OR (job.status = 'succeeded' AND commit_op.status = 'failed')
      )
    )
    ORDER BY job.updated_at
    LIMIT ${limit}
  `;
  const now = Date.now();
  return rows.map((row) => {
    const reference = row.finished_at ?? row.updated_at;
    const referenceMs = reference ? new Date(String(reference)).getTime() : now;
    const minutesStuck = Number.isFinite(referenceMs) ? Math.max(0, Math.round((now - referenceMs) / 60_000)) : 0;
    const cause = classifyStuckCause(row);
    const evidence = evidenceOf(row);
    if (cause === "terminal_unsettled") evidence.reason = unsettledReason(row);
    return {
      jobId: String(row.id),
      status: String(row.status),
      kind: String(row.kind),
      modelId: String(row.model_id),
      tenantId: String(row.tenant_id),
      cause,
      minutesStuck,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      evidence,
    };
  });
}
