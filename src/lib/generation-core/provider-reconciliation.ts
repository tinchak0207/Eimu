import { decryptGenerationPrompt } from "./crypto";
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
  checkpointProviderOutput,
  clearProviderOutputCheckpoint,
} from "./job-repository";
import { JOB_EVENT, emitJobEvent } from "./job-events";
import { planReplay, type ReplayPlan } from "./operation-registry";
import { pollSupplyTask } from "./supply-registry";
import type { ProviderTaskPollResult, ProviderProtocol, SupplierRecord, SupplierGenerationOutput } from "./types";

type Row = Record<string, unknown>;

const RECONCILE_LEASE_MS = 120_000;
const POLL_BACKOFF_BASE_MS = 60_000;
const POLL_BACKOFF_ERROR_MS = 120_000;
const POLL_BACKOFF_MAX_MS = 15 * 60_000;

/**
 * INC-0831 对帐回圈（架构级整改核心）：上游已提交的 provider task 必须有唯一可证明的
 * 结局 —— 交付（单次结算）、上游确认失败才退款、或窗口耗尽冻结人工对帐。
 * 真相未明前永不退款、永不重投、永不宣判失败。
 *
 * 每轮：
 *  1. 退休已过对帐窗口的 attempt（冻结人工，不退款、不改写真相）。
 *  2. SKIP LOCKED 认领到期 attempt（reconcile lease，防多实例重复轮询）。
 *  3. 按协议向上游只读查询真相；查询本身失败 = 退避重试，不是任务失败。
 *  4. succeeded → artifact 落库（canonical 幂等），非活跃 job CAS 复活交付。
 *  5. failed → 确认 job 再无其他未决真相后，才 fail + refund（幂等）。
 */
export async function runProviderReconciliation(input: {
  executorId: string;
  sql?: GenerationSql;
}): Promise<{
  claimed: number;
  delivered: number;
  confirmedFailed: number;
  exhausted: number;
  pollErrors: number;
}> {
  const sql = input.sql ?? getGenerationSql();
  // 每轮认领的 attempt 数（吞吐参数，**不是**重试预算——重试预算唯一来源是
  // operation registry 的 provider.reconcile_poll 政策；此参数不接受呼叫方传入）。
  const claimBatchSize = 10;
  const summary = { claimed: 0, delivered: 0, confirmedFailed: 0, exhausted: 0, pollErrors: 0 };

  // ① 对帐窗口耗尽：永久退出轮询（truth unknown → 冻结人工对帐，禁退款）。
  const expired = await sql<Row[]>`
    UPDATE generation_attempt
    SET provider_next_poll_at = NULL, recovery_status='manual', recovery_owner='control-plane:manual-reconciliation',
        recovery_detail='Automatic recovery deadline elapsed; operator must reconcile the original upstream request.',
        reconcile_lease_owner = NULL, reconcile_lease_expires_at = NULL, updated_at = now()
    WHERE recovery_status <> 'resolved'
      AND provider_next_poll_at IS NOT NULL
      AND provider_reconcile_deadline_at IS NOT NULL
      AND provider_reconcile_deadline_at <= now()
      AND (reconcile_lease_expires_at IS NULL OR reconcile_lease_expires_at < now())
      AND NOT EXISTS (
        SELECT 1
        FROM generation_job image_job
        JOIN supplier image_supplier ON image_supplier.id = generation_attempt.supplier_id
        WHERE image_job.id = generation_attempt.job_id
          AND image_job.kind IN ('image_generate', 'image_edit')
          AND (
            COALESCE(image_supplier.configuration_json->>'resultLookupPath', '') = ''
            OR left(image_supplier.configuration_json->>'resultLookupPath', 1) <> '/'
            OR position('{request_id}' in image_supplier.configuration_json->>'resultLookupPath') = 0
          )
      )
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

  // ② SKIP LOCKED 认领到期 attempt。
  const claimed = await sql<Row[]>`
    UPDATE generation_attempt
    SET reconcile_lease_owner = ${input.executorId},
        reconcile_lease_expires_at = now() + (${Math.floor(RECONCILE_LEASE_MS / 1000)}::text || ' seconds')::interval,
        updated_at = now()
    WHERE id IN (
      SELECT candidate.id FROM generation_attempt candidate
      WHERE candidate.recovery_status = 'pending'
        AND (candidate.provider_state IN ('unknown', 'running') OR candidate.response_ciphertext IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM generation_job live_job WHERE live_job.id=candidate.job_id
          AND live_job.lease_expires_at>now() AND live_job.status IN ('leased','submitting','running'))
        AND candidate.provider_next_poll_at IS NOT NULL
        AND candidate.provider_next_poll_at <= now()
        AND (candidate.reconcile_lease_expires_at IS NULL OR candidate.reconcile_lease_expires_at < now())
      ORDER BY candidate.provider_next_poll_at ASC
      LIMIT ${claimBatchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, job_id, output_index, supplier_id, provider_task_id, upstream_request_key, response_ciphertext,
      provider_protocol AS protocol, provider_poll_count
  `;
  if (!claimed.length) return summary;

  // ③ 每个 attempt 的完整上下文（job kind/status + supplier 凭证）。
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
        AND (acct.id = attempt.supplier_account_id OR
          (attempt.supplier_account_id IS NULL AND (SELECT count(*) FROM supplier_account a WHERE a.supplier_id=supplier.id)=1))
      LIMIT 1
    ) account ON true
    LEFT JOIN LATERAL (
      SELECT * FROM supplier_capability cap WHERE cap.supplier_id = supplier.id
        AND (cap.id=attempt.supplier_capability_id OR
          (attempt.supplier_capability_id IS NULL AND cap.public_model_id=job.model_id
            AND cap.kind=job.kind AND cap.is_current
            AND cap.supplier_model_id IS NOT DISTINCT FROM attempt.supplier_model_id))
      LIMIT 1
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
      const providerTaskId = claim.provider_task_id ? String(claim.provider_task_id) : String(claim.upstream_request_key ?? attemptId);
      if (!claim.response_ciphertext && (!ctx.account_id || !ctx.capability_id)) {
        await sql`UPDATE generation_attempt SET recovery_status='manual',recovery_owner='control-plane:manual-reconciliation',
          recovery_detail='Original submitting account/capability cannot be proved; do not query another account.',
          provider_next_poll_at=NULL,reconcile_lease_owner=NULL,reconcile_lease_expires_at=NULL,updated_at=now() WHERE id=${attemptId}`;
        summary.exhausted++; continue;
      }
      const supplier = mapSupplierRecord(ctx);
      const pollCount = Number(claim.provider_poll_count ?? 0);
      const imageKind = ctx.kind === "image_generate" || ctx.kind === "image_edit";
      const lookupPath = supplier.configuration.resultLookupPath;
      const hasResultLookup = typeof lookupPath === "string" && lookupPath.startsWith("/") && lookupPath.includes("{request_id}");
      const undeliveredImageWithoutLookup = imageKind && !hasResultLookup && !claim.response_ciphertext;

      // 认领到退休之间窗口可能已过：退休优先于轮询。
      const deadlineAt = claim.provider_reconcile_deadline_at
        ? new Date(claim.provider_reconcile_deadline_at as string | Date).getTime()
        : null;
      if (deadlineAt !== null && deadlineAt <= Date.now()) {
        if (undeliveredImageWithoutLookup) {
          const failed = await confirmReconciledFailure(sql, {
            executorId: input.executorId,
            jobId,
            attemptId,
            providerTaskId,
            reason: "Image task reconcile deadline elapsed without delivery and without resultLookupPath.",
          });
          if (failed) summary.confirmedFailed += 1;
          else summary.exhausted += 1;
          continue;
        }
        await sql`
          UPDATE generation_attempt
          SET provider_next_poll_at = NULL, recovery_status='manual', recovery_owner='control-plane:manual-reconciliation',
              recovery_detail='Automatic recovery deadline elapsed; upstream outcome remains unknown.',
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
      let savedOutput: SupplierGenerationOutput | undefined;
      try {
        if (claim.response_ciphertext) {
          savedOutput = JSON.parse(decryptGenerationPrompt(String(claim.response_ciphertext))) as SupplierGenerationOutput;
          result = { state: 'succeeded', url: savedOutput.url, base64: savedOutput.base64 };
        } else if (claim.provider_task_id && !(ctx.kind==='image_generate' || ctx.kind==='image_edit')) {
          result = await pollProviderTask(protocol, providerTaskId, supplier);
        } else if (!hasResultLookup) {
          if (imageKind) {
            const delaySec = Math.max(1, Math.floor(pollBackoffMs(pollCount, false) / 1000));
            await sql`UPDATE generation_attempt
              SET provider_last_polled_at = now(),
                  provider_poll_count = provider_poll_count + 1,
                  provider_next_poll_at = now() + (${delaySec}::text || ' seconds')::interval,
                  reconcile_lease_owner = NULL, reconcile_lease_expires_at = NULL, updated_at = now()
              WHERE id = ${attemptId}`;
            continue;
          }
          await sql`UPDATE generation_attempt SET recovery_status='manual',
            recovery_owner='control-plane:manual-reconciliation',
            recovery_detail='Supplier has no configured read-only resultLookupPath; reconcile by upstream_request_key. Never resubmit.',
            provider_next_poll_at=NULL, reconcile_lease_owner=NULL, reconcile_lease_expires_at=NULL, updated_at=now()
            WHERE id=${attemptId}`;
          await sql`UPDATE generation_job SET failure_detail='Original upstream request requires manual reconciliation; generation will not be resubmitted.', updated_at=now()
            WHERE id=${jobId} AND status='submit_unknown'`;
          summary.exhausted += 1;
          continue;
        } else {
          const lookup = lookupPath as string;
          const credential = process.env[supplier.account.credentialRef] ?? process.env[supplier.credentialRef];
          const response = await fetch(`${supplier.baseUrl.replace(/\/+$/, '')}${lookup.replace('{request_id}', encodeURIComponent(providerTaskId))}`, {
            method: 'GET', headers: { Authorization: `Bearer ${credential ?? ''}` }, signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) throw new Error(`Read-only response lookup HTTP ${response.status}; outcome remains unknown.`);
          const payload = await response.json() as { data?: { url?: string; b64_json?: string }[] };
          const media = payload.data?.[0];
          result = media?.url || media?.b64_json ? { state: 'succeeded', url: media.url ?? null, base64: media.b64_json ?? null } : { state: 'running' };
        }
      } catch (error) {
        // 查询通道失败 ≠ 任务失败：真相未变，退避重试（重放许可问 registry）。
        summary.pollErrors += 1;
        const outcome = await backoffAttempt(sql, {
          attemptId,
          jobId,
          executorId: input.executorId,
          pollCount,
          errorDetail: detailOf(error),
        });
        if (outcome === "retired") summary.exhausted += 1;
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
        const outcome = await backoffAttempt(sql, {
          attemptId,
          jobId,
          executorId: input.executorId,
          pollCount,
          errorDetail: null,
        });
        if (outcome === "retired") summary.exhausted += 1;
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
          output: savedOutput,
        });
        if (delivered) summary.delivered += 1;
        continue;
      }

      // 上游确认失败：这是唯一允许走向退款的路径。
      const failed = await confirmReconciledFailure(sql, {
        executorId: input.executorId,
        jobId,
        attemptId,
        providerTaskId,
        reason: result.reason,
      });
      if (failed) summary.confirmedFailed += 1;
    } catch (error) {
      // 单 attempt 异常不炸整轮；释放租约让下一轮重试。
      summary.pollErrors += 1;
      console.error("[provider-reconciliation] attempt 处理异常（下一轮重试）", attemptId, error);
      await sql`
        UPDATE generation_attempt
        SET reconcile_lease_owner = NULL, reconcile_lease_expires_at = NULL, updated_at = now()
        WHERE id = ${attemptId}
      `.catch(() => undefined);
    }
  }

  return summary;
}

/**
 * 对帐轮询分派（V-06）：按协议查 supply-registry，由 adapter 自带的 poll 执行；
 * 同步协议走其显式 `reconcileVia`。未知协议抛错 → 上层记 poll_error 并退避（不再
 * 静默当成 newapi_video 去查）。
 */
async function pollProviderTask(
  protocol: ProviderProtocol,
  providerTaskId: string,
  supplier: SupplierRecord,
): Promise<ProviderTaskPollResult> {
  return pollSupplyTask(protocol, supplier, providerTaskId);
}

/**
 * 轮询退避：指数拉长（60s→…→15min 上限），错误通道起点翻倍。
 * 重放许可与预算由封闭 operation registry 的 `provider.reconcile_poll` 政策决定
 * （FG-02/03），呼叫方不得自带重试次数。
 */
function pollBackoffMs(pollCount: number, isError: boolean): number {
  const base = isError ? POLL_BACKOFF_ERROR_MS : POLL_BACKOFF_BASE_MS;
  return Math.min(base * Math.pow(2, pollCount), POLL_BACKOFF_MAX_MS);
}

/** 下一轮对帐轮询是否允许重放（registry 裁决；未宣告＝禁）。 */
export function planReconcilePollReplay(nextPollNo: number): ReplayPlan {
  return planReplay({ operation: "provider.reconcile_poll", nextAttemptNo: nextPollNo });
}

/**
 * 排下一轮轮询 / 或按 registry 预算退休。
 * 预算是防御性天花板（128），正常情况下 24h 对帐窗口先绑定；预算耗尽 =
 * 冻结人工对帐（不退款、不宣判失败），语义与窗口耗尽一致。
 */
async function backoffAttempt(
  sql: GenerationSql,
  input: { attemptId: string; jobId: string; executorId: string; pollCount: number; errorDetail: string | null },
): Promise<"scheduled" | "retired"> {
  const { attemptId, pollCount, errorDetail } = input;
  // 刚完成的是第 pollCount+1 次轮询；下一次是第 pollCount+2 次（FG-03：序号由
  // registry 政策换算，呼叫方不得给预算）。
  const replay = planReconcilePollReplay(pollCount + 2);
  if (!replay.allowed) {
    await sql`
      UPDATE generation_attempt
      SET provider_poll_count = provider_poll_count + 1,
          provider_last_polled_at = now(), provider_next_poll_at = NULL,
          recovery_status='manual', recovery_owner='control-plane:manual-reconciliation',
          recovery_detail='Automatic read-only reconciliation replay budget exhausted; original response/request retained.',
          reconcile_lease_owner = NULL, reconcile_lease_expires_at = NULL, updated_at = now()
      WHERE id = ${attemptId}
    `;
    emitJobEvent({
      jobId: input.jobId,
      event: JOB_EVENT.reconcileExhausted,
      actor: `reconcile:${input.executorId}`,
      detail: {
        attempt_id: attemptId,
        reason: replay.denialReason,
        operation: replay.operation,
        poll_count: pollCount + 1,
        max_replay_attempts: replay.maxReplayAttempts,
      },
    }, sql);
    return "retired";
  }

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
  return "scheduled";
}

/**
 * 对帐确认成功：artifact 落库（canonical 幂等）→ 非活跃 job CAS 复活交付。
 * 活跃 job 的交付由 worker 正常路径收口（幂等键保证不重复计数/不重复落列）；
 * 计费结算走 reconcileGenerationBilling 的 terminalReservedJobs 通道（幂等 commit）。
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
    output?: SupplierGenerationOutput;
  },
): Promise<boolean> {
  const job = await getGenerationJob(input.jobId, sql);
  if (!job) return false;
  const mediaKind = job.kind === "tts"
    ? "audio"
    : (job.kind === "video_generate" || job.kind === "avatar" || job.kind === "lipsync") ? "video" : "image";
  // 鉴权产物（DMC auto-hd）：URL 必须带 Bearer 才能下载，而 secret 绝不入加密 receipt；
  // 指针（hdh:…）仍在行内，失败后下一轮重新查询即可再取 URL＋鉴权头，故跳过 receipt。
  if (!input.result.downloadHeaders) {
    await checkpointProviderOutput({ jobId: input.jobId, attemptId: input.attemptId,
      output: input.output ?? { base64: input.result.base64, url: input.result.url, httpStatus: 0,
        endpointLabel: `reconcile:${input.protocol}`, supplierModelId: '',
        providerTaskId: input.providerTaskId,
        evidence: { originalHttpStatusKnown: false, actualSupplierModelKnown: false, source: 'provider-confirmed-readonly-result' } } }, sql);
  }
  const stored = await persistOutputArtifact({
    jobId: input.jobId,
    attemptId: input.attemptId,
    outputIndex: input.outputIndex,
    base64: input.result.base64,
    url: input.result.url,
    endpointLabel: input.output?.endpointLabel ?? `reconcile:${input.protocol}`,
    supplierModelId:input.output?.supplierModelId || null,providerRequestId:input.output?.providerRequestId,
    originalHttpStatus:input.output?.httpStatus || null,
    mediaKind,
    // 上游成片需鉴权下载（DMC auto-hd 的 /v1/tasks/…/content）：只在这里交给 fetch，
    // 绝不写进 evidence／provider_result_json／加密 receipt（checkpoint 只存 url）。
    downloadHeaders: input.result.downloadHeaders,
  }, sql);

  await sql`
    UPDATE generation_attempt
    SET status = 'succeeded', provider_state = 'succeeded', recovery_status='resolved', response_ciphertext=NULL,
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
  await clearProviderOutputCheckpoint(input.attemptId);
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

  await sql`UPDATE generation_job SET completed_count=(SELECT count(*) FROM artifact WHERE job_id=${input.jobId} AND role='output'), updated_at=now() WHERE id=${input.jobId}`;
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
 * 对帐确认上游失败：只有 job 已冻结（submit_unknown）且再无其他未决真相时，
 * 才终结为 failed 并退款（refundGenerationBilling 幂等）。
 * 活跃 job 不动刀（它自己的 deadline/failure 路径会查 jobHasUnresolvedProviderTask）。
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
    SET provider_state = 'failed', status='failed', recovery_status='resolved', response_ciphertext=NULL,
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
