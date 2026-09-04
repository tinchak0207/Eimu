import { getGenerationSql, type GenerationSql } from "./database";
import { persistOutputArtifact } from "./artifact-service";
import { refundGenerationBilling } from "./billing-ledger";
import {
  failGenerationJobForReconciliation,
  getGenerationJob,
  jobHasUnresolvedProviderTask,
  listCompletedGenerationArtifacts,
  mapSupplierRecord,
  reviveGenerationJobWithArtifacts,
} from "./job-repository";
import { JOB_EVENT, emitJobEvent } from "./job-events";
import { pollFilmeraTask } from "./filmera-upstream";
import { pollMetasoTask } from "./metaso-upstream";
import { pollNewApiVideoTask } from "./newapi-video-upstream";
import { pollOpenaiVideoTask } from "./openai-video-upstream";
import type { ProviderTaskPollResult, ProviderProtocol, SupplierRecord } from "./types";

type Row = Record<string, unknown>;

const RECONCILE_LEASE_MS = 120_000;
const POLL_BACKOFF_BASE_MS = 60_000;
const POLL_BACKOFF_ERROR_MS = 120_000;
const POLL_BACKOFF_MAX_MS = 15 * 60_000;

/**
 * INC-0831 對帳迴圈（架構級整改核心）：上游已提交的 provider task 必須有唯一可證明的
 * 結局 —— 交付（單次結算）、上游確認失敗才退款、或窗口耗盡凍結人工對帳。
 * 真相未明前永不退款、永不重投、永不宣判失敗。
 *
 * 每輪：
 *  1. 退休已過對帳窗口的 attempt（凍結人工，不退款、不改寫真相）。
 *  2. SKIP LOCKED 認領到期 attempt（reconcile lease，防多實例重複輪詢）。
 *  3. 按協議向上游只讀查詢真相；查詢本身失敗 = 退避重試，不是任務失敗。
 *  4. succeeded → artifact 落庫（canonical 冪等），非活躍 job CAS 復活交付。
 *  5. failed → 確認 job 再無其他未決真相後，才 fail + refund（冪等）。
 */
export async function runProviderReconciliation(input: {
  executorId: string;
  maxAttempts?: number;
  sql?: GenerationSql;
}): Promise<{
  claimed: number;
  delivered: number;
  confirmedFailed: number;
  exhausted: number;
  pollErrors: number;
}> {
  const sql = input.sql ?? getGenerationSql();
  const maxAttempts = Math.max(1, input.maxAttempts ?? 10);
  const summary = { claimed: 0, delivered: 0, confirmedFailed: 0, exhausted: 0, pollErrors: 0 };

  // ① 對帳窗口耗盡：永久退出輪詢（truth unknown → 凍結人工對帳，禁退款）。
  const expired = await sql<Row[]>`
    UPDATE generation_attempt
    SET provider_next_poll_at = NULL,
        reconcile_lease_owner = NULL, reconcile_lease_expires_at = NULL, updated_at = now()
    WHERE provider_state IN ('unknown', 'running')
      AND provider_task_id IS NOT NULL
      AND provider_next_poll_at IS NOT NULL
      AND provider_reconcile_deadline_at IS NOT NULL
      AND provider_reconcile_deadline_at <= now()
      AND (reconcile_lease_expires_at IS NULL OR reconcile_lease_expires_at < now())
    RETURNING id, job_id
  `;
  for (const row of expired) {
    summary.exhausted += 1;
    emitJobEvent({
      jobId: String(row.job_id),
      event: JOB_EVENT.reconcileExhausted,
      actor: `reconcile:${input.executorId}`,
      detail: { attempt_id: String(row.id) },
    }, sql);
  }

  // ② SKIP LOCKED 認領到期 attempt。
  const claimed = await sql<Row[]>`
    UPDATE generation_attempt
    SET reconcile_lease_owner = ${input.executorId},
        reconcile_lease_expires_at = now() + (${Math.floor(RECONCILE_LEASE_MS / 1000)}::text || ' seconds')::interval,
        updated_at = now()
    WHERE id IN (
      SELECT candidate.id FROM generation_attempt candidate
      WHERE candidate.provider_state IN ('unknown', 'running')
        AND candidate.provider_task_id IS NOT NULL
        AND candidate.provider_next_poll_at IS NOT NULL
        AND candidate.provider_next_poll_at <= now()
        AND (candidate.reconcile_lease_expires_at IS NULL OR candidate.reconcile_lease_expires_at < now())
      ORDER BY candidate.provider_next_poll_at ASC
      LIMIT ${maxAttempts}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, job_id, output_index, supplier_id, provider_task_id,
      COALESCE(provider_protocol, 'newapi_video') AS protocol, provider_poll_count
  `;
  if (!claimed.length) return summary;

  // ③ 每個 attempt 的完整上下文（job kind/status + supplier 憑證）。
  const attemptIds = claimed.map((row) => String(row.id));
  const contexts = await sql<Row[]>`
    SELECT job.id AS job_id, job.kind, job.status AS job_status,
      attempt.id AS attempt_id, attempt.output_index, attempt.provider_task_id,
      COALESCE(attempt.provider_protocol, supplier.adapter_type) AS protocol,
      attempt.provider_poll_count,
      supplier.id AS supplier_id,
      supplier.*,
      capability.id AS capability_id, capability.supplier_model_id,
      capability.concurrency_limit AS capability_concurrency_limit,
      capability.contract_version, capability.health_status AS capability_health_status,
      account.id AS account_id, account.label AS account_label,
      account.credential_ref AS account_credential_ref,
      account.concurrency_limit AS account_concurrency_limit,
      account.health_status AS account_health_status, account.token_source,
      account.credential_expires_at, account.refresh_status, account.success_rate_5m,
      account.health_observed_at, account.configuration_json AS account_configuration_json
    FROM generation_attempt attempt
    JOIN generation_job job ON job.id = attempt.job_id
    JOIN supplier ON supplier.id = attempt.supplier_id
    LEFT JOIN LATERAL (
      SELECT * FROM supplier_account acct WHERE acct.supplier_id = supplier.id
      ORDER BY acct.enabled DESC, acct.id ASC LIMIT 1
    ) account ON true
    LEFT JOIN LATERAL (
      SELECT * FROM supplier_capability cap WHERE cap.supplier_id = supplier.id
      ORDER BY cap.is_current DESC, cap.id DESC LIMIT 1
    ) capability ON true
    WHERE attempt.id = ANY(${attemptIds}::text[])
  `;
  const contextById = new Map(contexts.map((row) => [String(row.attempt_id), row]));

  for (const claim of claimed) {
    const attemptId = String(claim.id);
    const jobId = String(claim.job_id);
    summary.claimed += 1;
    try {
      const ctx = contextById.get(attemptId);
      if (!ctx) throw new Error(`reconcile context missing for attempt ${attemptId}`);
      const protocol = String(ctx.protocol) as ProviderProtocol;
      const providerTaskId = String(claim.provider_task_id);
      const supplier = mapSupplierRecord(ctx);
      const pollCount = Number(claim.provider_poll_count ?? 0);

      // 認領到退休之間窗口可能已過：退休優先於輪詢。
      const deadlineAt = claim.provider_reconcile_deadline_at
        ? new Date(claim.provider_reconcile_deadline_at as string | Date).getTime()
        : null;
      if (deadlineAt !== null && deadlineAt <= Date.now()) {
        await sql`
          UPDATE generation_attempt
          SET provider_next_poll_at = NULL,
              reconcile_lease_owner = NULL, reconcile_lease_expires_at = NULL, updated_at = now()
          WHERE id = ${attemptId}
        `;
        summary.exhausted += 1;
        emitJobEvent({
          jobId,
          event: JOB_EVENT.reconcileExhausted,
          actor: `reconcile:${input.executorId}`,
          detail: { attempt_id: attemptId, provider_task_id: providerTaskId },
        }, sql);
        continue;
      }

      let result: ProviderTaskPollResult;
      try {
        result = await pollProviderTask(protocol, providerTaskId, supplier);
      } catch (error) {
        // 查詢通道失敗 ≠ 任務失敗：真相未變，退避重試。
        summary.pollErrors += 1;
        await backoffAttempt(sql, attemptId, pollCount, detailOf(error));
        emitJobEvent({
          jobId,
          event: JOB_EVENT.reconcilePolled,
          actor: `reconcile:${input.executorId}`,
          detail: { attempt_id: attemptId, provider_task_id: providerTaskId, outcome: "poll_error" },
          upstreamRaw: detailOf(error),
        }, sql);
        continue;
      }

      if (result.state === "running") {
        await backoffAttempt(sql, attemptId, pollCount, null);
        emitJobEvent({
          jobId,
          event: JOB_EVENT.reconcilePolled,
          actor: `reconcile:${input.executorId}`,
          detail: { attempt_id: attemptId, provider_task_id: providerTaskId, outcome: "running" },
        }, sql);
        continue;
      }

      if (result.state === "succeeded") {
        const delivered = await landReconciledArtifact(sql, {
          executorId: input.executorId,
          jobId,
          attemptId,
          outputIndex: Number(claim.output_index ?? 0),
          providerTaskId,
          protocol,
          result,
        });
        if (delivered) summary.delivered += 1;
        continue;
      }

      // 上游確認失敗：這是唯一允許走向退款的路徑。
      const failed = await confirmReconciledFailure(sql, {
        executorId: input.executorId,
        jobId,
        attemptId,
        providerTaskId,
        reason: result.reason,
      });
      if (failed) summary.confirmedFailed += 1;
    } catch (error) {
      // 單 attempt 異常不炸整輪；釋放租約讓下一輪重試。
      summary.pollErrors += 1;
      console.error("[provider-reconciliation] attempt 處理異常（下一輪重試）", attemptId, error);
      await sql`
        UPDATE generation_attempt
        SET reconcile_lease_owner = NULL, reconcile_lease_expires_at = NULL, updated_at = now()
        WHERE id = ${attemptId}
      `.catch(() => undefined);
    }
  }

  return summary;
}

async function pollProviderTask(
  protocol: ProviderProtocol,
  providerTaskId: string,
  supplier: SupplierRecord,
): Promise<ProviderTaskPollResult> {
  switch (protocol) {
    case "metaso":
      return pollMetasoTask(supplier, providerTaskId);
    case "openai_video":
      return pollOpenaiVideoTask(supplier, providerTaskId);
    case "filmera":
      return pollFilmeraTask(providerTaskId);
    case "newapi_video":
    default:
      return pollNewApiVideoTask(providerTaskId);
  }
}

/** 輪詢退避：指數拉長（60s→…→15min 上限），錯誤通道起點翻倍。 */
function pollBackoffMs(pollCount: number, isError: boolean): number {
  const base = isError ? POLL_BACKOFF_ERROR_MS : POLL_BACKOFF_BASE_MS;
  return Math.min(base * Math.pow(2, pollCount), POLL_BACKOFF_MAX_MS);
}

async function backoffAttempt(sql: GenerationSql, attemptId: string, pollCount: number, errorDetail: string | null): Promise<void> {
  const delaySec = Math.floor(pollBackoffMs(pollCount, errorDetail !== null) / 1000);
  const resultJson = errorDetail === null
    ? null
    : sql.json(JSON.parse(JSON.stringify({ state: "running", last_error: errorDetail.slice(0, 2000) })) as never);
  await sql`
    UPDATE generation_attempt
    SET provider_state = 'running', provider_last_polled_at = now(),
        provider_poll_count = provider_poll_count + 1,
        provider_next_poll_at = now() + (${delaySec}::text || ' seconds')::interval,
        provider_result_json = ${resultJson},
        reconcile_lease_owner = NULL, reconcile_lease_expires_at = NULL, updated_at = now()
    WHERE id = ${attemptId}
  `;
}

/**
 * 對帳確認成功：artifact 落庫（canonical 冪等）→ 非活躍 job CAS 復活交付。
 * 活躍 job 的交付由 worker 正常路徑收口（冪等鍵保證不重複計數/不重複落列）；
 * 計費結算走 reconcileGenerationBilling 的 terminalReservedJobs 通道（冪等 commit）。
 */
async function landReconciledArtifact(
  sql: GenerationSql,
  input: {
    executorId: string;
    jobId: string;
    attemptId: string;
    outputIndex: number;
    providerTaskId: string;
    protocol: ProviderProtocol;
    result: Extract<ProviderTaskPollResult, { state: "succeeded" }>;
  },
): Promise<boolean> {
  const job = await getGenerationJob(input.jobId, sql);
  if (!job) return false;
  const mediaKind = job.kind === "tts"
    ? "audio"
    : (job.kind === "video_generate" || job.kind === "avatar" || job.kind === "lipsync") ? "video" : "image";
  const stored = await persistOutputArtifact({
    jobId: input.jobId,
    attemptId: input.attemptId,
    outputIndex: input.outputIndex,
    base64: input.result.base64,
    url: input.result.url,
    endpointLabel: `reconcile:${input.protocol}`,
    mediaKind,
  }, sql);

  await sql`
    UPDATE generation_attempt
    SET status = 'succeeded', provider_state = 'succeeded',
        provider_last_polled_at = now(), provider_poll_count = provider_poll_count + 1,
        provider_result_json = ${sql.json(JSON.parse(JSON.stringify({
          state: "succeeded",
          artifact_id: stored.id,
          delivery_url: stored.deliveryUrl,
          inserted: stored.inserted,
        })) as never)},
        provider_next_poll_at = NULL,
        failure_class = NULL, failure_detail = NULL,
        first_output_at = COALESCE(first_output_at, now()), finished_at = now(),
        reconcile_lease_owner = NULL, reconcile_lease_expires_at = NULL, updated_at = now()
    WHERE id = ${input.attemptId} AND job_id = ${input.jobId}
  `;
  emitJobEvent({
    jobId: input.jobId,
    event: JOB_EVENT.reconcilePolled,
    actor: `reconcile:${input.executorId}`,
    detail: {
      attempt_id: input.attemptId,
      provider_task_id: input.providerTaskId,
      outcome: "succeeded",
      artifact_id: stored.id,
      artifact_inserted: stored.inserted,
    },
  }, sql);

  const activeStatuses = new Set(["pending_billing", "billing_unknown", "queued", "leased", "submitting", "running"]);
  if (activeStatuses.has(job.status)) return false;
  const artifacts = await listCompletedGenerationArtifacts(input.jobId, sql);
  const revived = await reviveGenerationJobWithArtifacts({
    jobId: input.jobId,
    workerId: `reconcile:${input.executorId}`,
    artifacts,
  }, sql);
  return revived !== null;
}

/**
 * 對帳確認上游失敗：只有 job 已凍結（submit_unknown）且再無其他未決真相時，
 * 才終結為 failed 並退款（refundGenerationBilling 冪等）。
 * 活躍 job 不動刀（它自己的 deadline/failure 路徑會查 jobHasUnresolvedProviderTask）。
 */
async function confirmReconciledFailure(
  sql: GenerationSql,
  input: {
    executorId: string;
    jobId: string;
    attemptId: string;
    providerTaskId: string;
    reason: string;
  },
): Promise<boolean> {
  await sql`
    UPDATE generation_attempt
    SET provider_state = 'failed',
        provider_last_polled_at = now(), provider_poll_count = provider_poll_count + 1,
        provider_result_json = ${sql.json(JSON.parse(JSON.stringify({ state: "failed", reason: input.reason.slice(0, 2000) })) as never)},
        provider_next_poll_at = NULL,
        reconcile_lease_owner = NULL, reconcile_lease_expires_at = NULL, updated_at = now()
    WHERE id = ${input.attemptId}
  `;
  emitJobEvent({
    jobId: input.jobId,
    event: JOB_EVENT.reconcilePolled,
    actor: `reconcile:${input.executorId}`,
    detail: { attempt_id: input.attemptId, provider_task_id: input.providerTaskId, outcome: "failed" },
    upstreamRaw: input.reason,
  }, sql);

  const job = await getGenerationJob(input.jobId, sql);
  if (!job || job.status !== "submit_unknown") return false;
  if (await jobHasUnresolvedProviderTask(input.jobId, sql)) return false;
  const terminated = await failGenerationJobForReconciliation({
    jobId: input.jobId,
    workerId: `reconcile:${input.executorId}`,
    failureClass: "unknown",
    failureDetail: input.reason,
  }, sql);
  if (!terminated) return false;
  await refundGenerationBilling({ job, executorId: `reconcile:${input.executorId}` }, sql);
  return true;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
