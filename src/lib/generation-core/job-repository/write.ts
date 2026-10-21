import { randomUUID } from "node:crypto";

import { requirePinnedPublishedWorkflow } from "../../comfyui-workflow-pin";
import { getGenerationSql, type GenerationSql } from "../database";
import { JOB_EVENT, emitJobEvent } from "../job-events";
import type { CreateGenerationJobInput, FailureClass, GenerationArtifactResult, GenerationJob, GenerationJobResult, GenerationJobStatus, ProviderProtocol, SupplierLease, SupplierRecord } from "../types";
import { IdempotencyConflictError, asDate, failureRecordParam, jsonValue, mapGenerationJob, nullableDate, type CreatedJob, type Row } from "./types";
import type { FailureRecord } from "../failure-record";
import { clearProviderOutputCheckpoint } from "./spool-io";

export async function createGenerationJob(
  input: CreateGenerationJobInput,
  sql: GenerationSql = getGenerationSql(),
): Promise<CreatedJob> {
  requirePinnedPublishedWorkflow(input.workflow);
  return sql.begin(async (tx) => {
    const rows = await tx<Row[]>`
      INSERT INTO generation_job (
        id, tenant_id, api_key_id, billing_user_id, source, idempotency_key, request_hash,
        kind, routing_class, model_id, size, ratio, resolution, quality, prompt_ciphertext,
        workflow_json, response_format, callback_url, retry_of_job_id, requested_count, billing_amount, deadline_at,
        batch_id, batch_index
      ) VALUES (
        ${input.id}, ${input.tenantId}, ${input.apiKeyId ?? null}, ${input.billingUserId ?? null},
        ${input.source}, ${input.idempotencyKey ?? null}, ${input.requestHash}, ${input.kind},
        ${input.routingClass}, ${input.modelId}, ${input.size ?? null}, ${input.ratio ?? null},
        ${input.resolution ?? null}, ${input.quality ?? null}, ${input.promptCiphertext},
        ${tx.json(JSON.parse(JSON.stringify(input.workflow ?? {})) as never)}, ${input.responseFormat ?? "b64_json"},
        ${input.callbackUrl ?? null}, ${input.retryOfTaskId ?? null}, ${input.requestedCount}, ${input.billingAmount}, ${input.deadlineAt},
        ${input.batchId ?? null}, ${input.batchIndex ?? null}
      )
      ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING *
    `;

    if (rows[0]) {
      for (const reference of input.referenceArtifacts ?? []) {
        await tx`
          INSERT INTO artifact (
            id, job_id, role, object_key, delivery_url, sha256, mime_type, byte_size,
            width, height, source_artifact_id, source_generation_id, reference_role, metadata_json
          ) VALUES (
            ${reference.id}, ${input.id}, 'reference', ${reference.objectKey}, ${reference.deliveryUrl},
            ${reference.sha256}, ${reference.mimeType}, ${reference.byteSize}, ${reference.width}, ${reference.height},
            ${reference.sourceResultId ?? null}, ${reference.sourceGenerationId ?? null},
            ${reference.referenceRole ?? "general"},
            ${tx.json(JSON.parse(JSON.stringify(reference.metadata ?? {})) as never)}
          )
          ON CONFLICT (id) DO NOTHING
        `;
      }
      await tx`
        INSERT INTO billing_operation (
          id, job_id, operation, amount, status, idempotency_ref, applied_at
        ) VALUES (
          ${randomUUID()}, ${input.id}, 'reserve', ${input.billingAmount},
          ${input.billingAmount === 0 ? "applied" : "pending"},
          ${`generation:${input.id}:reserve:1`},
          ${input.billingAmount === 0 ? new Date() : null}
        )
      `;
      if (input.billingAmount === 0) {
        const activated = await tx<Row[]>`
          UPDATE generation_job
          SET status = 'queued', updated_at = now()
          WHERE id = ${input.id}
          RETURNING *
        `;
        return { job: mapGenerationJob(activated[0]), created: true };
      }
      return { job: mapGenerationJob(rows[0]), created: true };
    }

    if (!input.idempotencyKey) throw new Error("Generation job insert failed.");
    const existing = await tx<Row[]>`
      SELECT * FROM generation_job
      WHERE tenant_id = ${input.tenantId} AND idempotency_key = ${input.idempotencyKey}
      LIMIT 1
    `;
    if (!existing[0]) throw new Error("Idempotent generation job disappeared after conflict.");
    if (String(existing[0].request_hash) !== input.requestHash) {
      throw new IdempotencyConflictError(String(existing[0].id));
    }
    return { job: mapGenerationJob(existing[0]), created: false };
  });
}
export async function claimNextGenerationJob(
  workerId: string,
  leaseMs: number,
  sql: GenerationSql = getGenerationSql(),
): Promise<GenerationJob | null> {
  const rows = await sql<Row[]>`
    WITH candidate AS (
      SELECT id
      FROM generation_job
      WHERE status = 'queued'
        AND available_at <= now()
      -- Accepted queue entries stay recoverable even after their observation deadline.
      -- FIFO does not prioritize expired capacity waiters ahead of new jobs.
      ORDER BY created_at, available_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE generation_job job
    SET status = 'leased', lease_owner = ${workerId},
        lease_expires_at = now() + (${leaseMs}::text || ' milliseconds')::interval,
        heartbeat_at = now(), updated_at = now()
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING job.*
  `;
  return rows[0] ? mapGenerationJob(rows[0]) : null;
}

export async function heartbeatGenerationJob(
  jobId: string,
  workerId: string,
  leaseMs: number,
  sql: GenerationSql = getGenerationSql(),
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE generation_job
    SET heartbeat_at = now(),
        lease_expires_at = now() + (${leaseMs}::text || ' milliseconds')::interval,
        updated_at = now()
    WHERE id = ${jobId} AND lease_owner = ${workerId}
      AND status IN ('leased', 'submitting', 'running')
    RETURNING id
  `;
  return Boolean(rows[0]);
}

export async function releaseJobForRetry(input: {
  jobId: string;
  workerId: string;
  availableAt: Date;
  failureClass?: FailureClass;
  failureDetail?: string;
}, sql: GenerationSql = getGenerationSql()): Promise<void> {
  await sql`
    UPDATE generation_job
    SET status = 'queued', available_at = ${input.availableAt}, lease_owner = NULL,
        lease_expires_at = NULL, heartbeat_at = NULL,
        failure_class = ${input.failureClass ?? null}, failure_detail = ${input.failureDetail ?? null},
        updated_at = now()
    WHERE id = ${input.jobId} AND lease_owner = ${input.workerId}
  `;
}

// 每次取得真实供应商容量后才从当前时刻开始执行预算；排队观测截止与执行截止分别保存。
export async function extendGenerationDeadlineJob(
  job: { id: string; startedAt: Date | null },
  workerId: string,
  totalBudgetMs: number,
  sql: GenerationSql = getGenerationSql(),
): Promise<Date | null> {
  const rows = await sql<{ deadline_at: unknown }[]>`
    UPDATE generation_job
    SET deadline_at = now() + (${totalBudgetMs}::text || ' milliseconds')::interval,
        execution_deadline_at = now() + (${totalBudgetMs}::text || ' milliseconds')::interval,
        updated_at = now()
    WHERE id = ${job.id} AND lease_owner = ${workerId}
      AND status IN ('leased', 'submitting', 'running')
    RETURNING deadline_at
  `;
  return rows[0] ? asDate(rows[0].deadline_at) : null;
}

// 队列观测窗口可滚动续期；容量等待不终结已经受理的订单。
export async function extendGenerationQueueDeadline(
  job: { id: string; startedAt: Date | null },
  workerId: string,
  extraMs: number,
  sql: GenerationSql = getGenerationSql(),
): Promise<Date | null> {
  const rows = await sql<{ deadline_at: unknown }[]>`
    UPDATE generation_job
    SET deadline_at = GREATEST(deadline_at, now() + (${extraMs}::text || ' milliseconds')::interval),
        queue_deadline_at = now() + (${extraMs}::text || ' milliseconds')::interval,
        updated_at = now()
    WHERE id = ${job.id} AND lease_owner = ${workerId}
      AND status IN ('leased', 'submitting', 'running')
    RETURNING deadline_at
  `;
  return rows[0] ? asDate(rows[0].deadline_at) : null;
}

export async function beginGenerationAttempt(input: {
  jobId: string;
  workerId: string;
  supplierId: string;
  supplierModelId: string | null;
  outputIndex: number;
  supplierAccountId?: string;
  supplierCapabilityId?: number;
  protocol?: string;
}, sql: GenerationSql = getGenerationSql()): Promise<{ id: string; attemptNo: number }> {
  return sql.begin(async (tx) => {
    const jobs = await tx<{ attempt_count: number }[]>`
      UPDATE generation_job
      SET status = 'submitting', started_at = COALESCE(started_at, now()), attempt_count = attempt_count + 1, updated_at = now()
      WHERE id = ${input.jobId} AND lease_owner = ${input.workerId}
        AND status IN ('leased', 'running')
      RETURNING attempt_count
    `;
    if (!jobs[0]) throw new Error(`Worker ${input.workerId} no longer owns generation job ${input.jobId}.`);
    const id = randomUUID();
    const attemptNo = Number(jobs[0].attempt_count);
    await tx`
      INSERT INTO generation_attempt (
        id, job_id, attempt_no, output_index, supplier_id, supplier_model_id, status,
        supplier_account_id, supplier_capability_id, upstream_request_key, provider_protocol, recovery_owner, recovery_detail
      ) VALUES (
        ${id}, ${input.jobId}, ${attemptNo}, ${input.outputIndex}, ${input.supplierId},
        ${input.supplierModelId}, 'submitting', ${input.supplierAccountId ?? null},
        ${input.supplierCapabilityId ?? null}, ${id}, ${input.protocol ?? null}, 'control-plane:provider-reconciliation', 'input_preparation_not_submitted'
      )
    `;
    return { id, attemptNo };
  });
}

export async function completeGenerationAttempt(input: {
  jobId: string;
  workerId: string;
  attemptId: string;
  providerRequestId?: string;
  providerTaskId?: string;
  providerHttpStatus: number;
  latencyMs: number;
  evidence?: Record<string, unknown>;
  /**
   * INC-0831：false = 该输出的 canonical artifact 早已存在（重放/晚到命中幂等键），
   * 只记 attempt 成功、不重复递增 completed_count。
   */
  advanceOutput?: boolean;
}, sql: GenerationSql = getGenerationSql()): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE generation_attempt
      SET status = 'succeeded', provider_request_id = ${input.providerRequestId ?? null},
          provider_task_id = ${input.providerTaskId ?? null}, provider_http_status = ${input.providerHttpStatus},
          first_output_at = now(), finished_at = now(), latency_ms = ${input.latencyMs},
          provider_state = 'succeeded', recovery_status = 'resolved', provider_next_poll_at = NULL, response_ciphertext = NULL,
          evidence_json = ${tx.json(JSON.parse(JSON.stringify(input.evidence ?? {})) as never)}, updated_at = now()
      WHERE id = ${input.attemptId} AND job_id = ${input.jobId}
    `;
    await tx`
      UPDATE generation_job
      SET status = CASE WHEN status='cancelled' THEN 'cancelled' ELSE 'running' END,
          completed_count = (SELECT count(*) FROM artifact WHERE job_id=${input.jobId} AND role='output'), updated_at = now()
      WHERE id = ${input.jobId} AND (lease_owner = ${input.workerId} OR status='cancelled')
    `;
  });
  await clearProviderOutputCheckpoint(input.attemptId);
}

export async function failGenerationAttempt(input: {
  jobId: string;
  workerId: string;
  attemptId: string;
  failureClass: FailureClass;
  failureDetail: string;
  /** 适配器抛错时带出的上游任务 id（INC-0830-VIDEO：失败 attempt 也要留上游 task 对账锚点）。 */
  providerTaskId?: string;
  providerHttpStatus?: number;
  retryAfterAt?: Date | null;
  latencyMs: number;
  /**
   * FG-01：版本化失败记录。原生栏位（name/message/code/status/requestId/metadata/
   * cause 递回）逐字落库，与 failureClass/failureDetail 这组产品解释分栏存放。
   */
  failureRecord?: FailureRecord | null;
}, sql: GenerationSql = getGenerationSql()): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE generation_attempt
      SET status = 'failed', failure_class = ${input.failureClass}, failure_detail = ${input.failureDetail.slice(0, 2000)},
          failure_record_json = ${failureRecordParam(sql, input.failureRecord)},
          -- 失败路径不得把已落库的对帐指针抹成 NULL（2026-10-20 DMC auto-hd：
          -- 适配器抛错时可能已把两段链路指针推进到 hdh；错误对象没带新 id 时保留现值）。
          provider_task_id = COALESCE(${input.providerTaskId ?? null}, provider_task_id),
          provider_http_status = ${input.providerHttpStatus ?? null}, retry_after_at = ${input.retryAfterAt ?? null},
          finished_at = now(), latency_ms = ${input.latencyMs}, updated_at = now()
      WHERE id = ${input.attemptId} AND job_id = ${input.jobId}
    `;
    await tx`
      UPDATE generation_job SET status = 'running', updated_at = now()
      WHERE id = ${input.jobId} AND lease_owner = ${input.workerId} AND status = 'submitting'
    `;
  });
}
// ─────────────────────────────────────────────────── INC-0831 provider 对帐

/**
 * 上游任务提交成功的瞬间，把 provider task id + 对帐排程 durably 落进 attempt 行。
 * 这是事故根治点：只发事件不落行，轮询断掉后 task id 就没人认领（INC-0831 根因）。
 * 同 id 重写（提交回调后失败路径再保险一次）幂等；不同 task id 不覆盖。
 * 返回 false = 行已易主或已被其它 task id 占用（调用端不应视为错误）。
 */
export async function markProviderTaskSubmitted(input: {
  jobId: string;
  attemptId: string;
  providerTaskId: string;
  protocol: ProviderProtocol;
  /** 首轮对帐延迟（默认 60s：上游任务刚提交，立刻问也是 running）。 */
  firstPollDelayMs?: number;
  /** 对帐窗口（默认 24h：窗口耗尽 → 冻结人工，不退款）。 */
  reconcileWindowMs?: number;
}, sql: GenerationSql = getGenerationSql()): Promise<boolean> {
  const delaySec = Math.max(1, Math.floor((input.firstPollDelayMs ?? 60_000) / 1000));
  const windowSec = Math.max(60, Math.floor((input.reconcileWindowMs ?? 24 * 60 * 60_000) / 1000));
  const rows = await sql<{ id: string }[]>`
    UPDATE generation_attempt
    SET provider_task_id = ${input.providerTaskId},
        provider_protocol = ${input.protocol},
        provider_state = 'running',
        provider_next_poll_at = COALESCE(provider_next_poll_at,now() + (${delaySec}::text || ' seconds')::interval),
        provider_reconcile_deadline_at = COALESCE(provider_reconcile_deadline_at,now() + (${windowSec}::text || ' seconds')::interval),
        updated_at = now()
    WHERE id = ${input.attemptId} AND job_id = ${input.jobId}
      AND (provider_task_id IS NULL OR provider_task_id = ${input.providerTaskId})
      AND status IN ('submitting', 'running', 'failed', 'submit_unknown')
    RETURNING id
  `;
  return Boolean(rows[0]);
}

/**
 * 对帐指针**受控推进**（2026-10-20 DMC auto-hd 两段链路）：上游把一次交付拆成
 * 「H3 出片 → auto-hd 超分」时，第二段任务提交后真相已移到新 task id，必须在同一
 * attempt 行把 `provider_task_id` 从第一段推进到第二段。
 *
 * CAS 条件 `provider_task_id = expectedProviderTaskId`：只允许适配器显式声明的
 * 「旧的、已确认完成的那一段」推进，绝不无条件覆盖——并发认领／行已易主／指针
 * 已被别的路径改过时返回 false，调用端按「无法durable记录」处理（不吞错）。
 */
export async function replaceProviderTaskId(input: {
  jobId: string;
  attemptId: string;
  /** 新指针（如 `hdh:1080p:<hdTaskId>`）。 */
  providerTaskId: string;
  /** 期望的旧指针（如 `hdx:1080p:<h3TaskId>`）；必须与行内现值完全一致才推进。 */
  expectedProviderTaskId: string;
  protocol: ProviderProtocol;
  /** 新指针的首轮对帐延迟（默认 60s）。 */
  firstPollDelayMs?: number;
}, sql: GenerationSql = getGenerationSql()): Promise<boolean> {
  const delaySec = Math.max(1, Math.floor((input.firstPollDelayMs ?? 60_000) / 1000));
  const rows = await sql<{ id: string }[]>`
    UPDATE generation_attempt
    SET provider_task_id = ${input.providerTaskId},
        provider_protocol = ${input.protocol},
        provider_state = 'running',
        provider_next_poll_at = now() + (${delaySec}::text || ' seconds')::interval,
        provider_reconcile_deadline_at = COALESCE(provider_reconcile_deadline_at, now() + interval '24 hours'),
        updated_at = now()
    WHERE id = ${input.attemptId} AND job_id = ${input.jobId}
      AND provider_task_id = ${input.expectedProviderTaskId}
      AND status IN ('submitting', 'running', 'failed', 'submit_unknown')
    RETURNING id
  `;
  return Boolean(rows[0]);
}

/**
 * job 进入对帐冻结（submit_unknown）：deadline 到/租约易主/轮询断，但已知有
 * 上游任务在跑。钱冻结在 reserve，等 provider-reconciliation 查出真相再结算。
 * 只清租约不动计费；已排程的对帐不受影响，未排程的（回调写入失败的残留）立刻补排。
 */
export async function freezeGenerationJobForReconciliation(input: {
  jobId: string;
  workerId: string;
  reason: string;
}, sql: GenerationSql = getGenerationSql()): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE generation_job
    SET status = 'submit_unknown', failure_class = 'deadline_exceeded',
        failure_detail = ${input.reason.slice(0, 2000)},
        lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = now()
    WHERE id = ${input.jobId} AND lease_owner = ${input.workerId}
      AND status IN ('leased', 'submitting', 'running')
    RETURNING id
  `;
  if (!rows[0]) return false;
  await sql`
    UPDATE generation_attempt
    SET provider_next_poll_at = COALESCE(provider_next_poll_at, now()),
        provider_reconcile_deadline_at = COALESCE(provider_reconcile_deadline_at, now() + interval '24 hours'),
        provider_protocol = COALESCE(generation_attempt.provider_protocol, supplier.adapter_type),
        updated_at = now()
    FROM supplier
    WHERE generation_attempt.supplier_id = supplier.id
      AND generation_attempt.job_id = ${input.jobId}
      AND generation_attempt.status IN ('submitting', 'running', 'failed', 'submit_unknown')
  `;
  emitJobEvent({
    jobId: input.jobId,
    event: JOB_EVENT.reconcileFrozen,
    actor: `worker:${input.workerId}`,
    detail: { reason: input.reason.slice(0, 2000) },
  }, sql);
  return true;
}

/**
 * 对帐确认上游成功、artifact 已落库后，把已判死/僵尸的 job 复活为 succeeded。
 * CAS 只碰非活跃 job（活跃 job 的交付由 worker 正常路径完成）；计费结算交给
 * reconcileGenerationBilling 的 terminalReservedJobs 通道（幂等 commit）。
 */
export async function reviveGenerationJobWithArtifacts(input: {
  jobId: string;
  workerId: string;
  artifacts: GenerationArtifactResult[];
}, sql: GenerationSql = getGenerationSql()): Promise<GenerationJobResult | null> {
  const result: GenerationJobResult = {
    created: Math.floor(Date.now() / 1000),
    artifacts: input.artifacts,
    endpointLabel: input.artifacts.at(-1)?.endpointLabel,
  };
  const rows = await sql<{ id: string }[]>`
    UPDATE generation_job
    SET status = 'succeeded', completed_count = ${input.artifacts.length},
        primary_artifact_id = ${input.artifacts[0]?.id ?? null},
        result_json = ${sql.json(JSON.parse(JSON.stringify(result)) as never)},
        failure_class = NULL, failure_detail = NULL,
        finished_at = COALESCE(finished_at, now()),
        lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = now()
    WHERE id = ${input.jobId}
      AND status IN ('failed', 'refunded', 'submit_unknown')
      AND requested_count <= ${input.artifacts.length}
    RETURNING id
  `;
  if (!rows[0]) return null;
  emitJobEvent({
    jobId: input.jobId,
    event: JOB_EVENT.reconcileDelivered,
    actor: input.workerId,
    detail: { artifact_count: input.artifacts.length, primary_artifact_id: input.artifacts[0]?.id ?? null },
  }, sql);
  return result;
}

/**
 * 对帐确认上游失败后的收尾：job 没有可交付产出且对帐窗口已无在飞任务 →
 * 诚实终结为 failed。退款由调用方走 refundGenerationBilling（仅认上游确认失败）。
 */
export async function failGenerationJobForReconciliation(input: {
  jobId: string;
  workerId: string;
  failureClass: FailureClass;
  failureDetail: string;
}, sql: GenerationSql = getGenerationSql()): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE generation_job
    SET status = 'failed', failure_class = ${input.failureClass},
        failure_detail = ${input.failureDetail.slice(0, 2000)},
        finished_at = COALESCE(finished_at, now()),
        lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = now()
    WHERE id = ${input.jobId}
      AND status IN ('submit_unknown', 'queued', 'leased', 'submitting', 'running')
    RETURNING id
  `;
  if (!rows[0]) return false;
  emitJobEvent({
    jobId: input.jobId,
    event: JOB_EVENT.reconcileFailed,
    actor: input.workerId,
    upstreamRaw: input.failureDetail,
    detail: { failure_class: input.failureClass },
  }, sql);
  return true;
}

/** job 是否仍有真相未明的已提交上游任务（INC-0831：deadline/失败路径先查这个再动钱）。 */
export async function jobHasUnresolvedProviderTask(jobId: string, sql: GenerationSql = getGenerationSql()): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM generation_attempt
    WHERE job_id = ${jobId}
      AND ((provider_task_id IS NOT NULL AND provider_state IN ('unknown','running'))
        OR (status='submit_unknown' AND recovery_status <> 'resolved'))
    LIMIT 1
  `;
  return Boolean(rows[0]);
}

export async function attemptedSupplierRoutingForOutput(
  jobId: string,
  outputIndex: number,
  sql: GenerationSql = getGenerationSql(),
): Promise<{ supplierIds: string[]; failureDomains: string[] }> {
  const rows = await sql<{ supplier_id: string; failure_domain: string }[]>`
    SELECT DISTINCT attempt.supplier_id, supplier.failure_domain
    FROM generation_attempt attempt
    JOIN supplier ON supplier.id = attempt.supplier_id
    WHERE attempt.job_id = ${jobId} AND attempt.output_index = ${outputIndex}
      AND attempt.status = 'failed'
      AND attempt.failure_class NOT IN ('artifact_download','cancelled','user_input','pricing_config')
  `;
  return {
    supplierIds: rows.map((row) => row.supplier_id),
    failureDomains: [...new Set(rows.map((row) => row.failure_domain))],
  };
}
export async function failGenerationJob(input: {
  jobId: string;
  workerId?: string;
  failureClass: FailureClass;
  failureDetail: string;
  /** FG-01：终态失败也要留版本化原生记录（帐本之外的可回溯真相）。 */
  failureRecord?: FailureRecord | null;
}, sql: GenerationSql = getGenerationSql()): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    UPDATE generation_job
    SET status = 'failed', failure_class = ${input.failureClass},
        failure_detail = ${input.failureDetail.slice(0, 2000)},
        failure_record_json = ${failureRecordParam(sql, input.failureRecord)}, finished_at = now(),
        lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = now()
    WHERE id = ${input.jobId}
      AND (${input.workerId ?? null}::text IS NULL OR lease_owner = ${input.workerId ?? null})
      AND status NOT IN ('succeeded', 'failed', 'cancelled')
    RETURNING id
  `;
  // audit P2-1（INC-0830-VIDEO）：终态不静默。仅在实际状态迁移时补发 job_failed
  // （fire-and-forget，遥测不挡主流程）；重复调用（已终态）不再发。
  if (rows[0]) {
    emitJobEvent({
      jobId: input.jobId,
      event: JOB_EVENT.jobFailed,
      actor: input.workerId ?? "worker",
      upstreamRaw: input.failureDetail,
      detail: { failure_class: input.failureClass, failure_detail: input.failureDetail.slice(0, 2000) },
    }, sql);
  }
}

export async function completeGenerationJob(input: {
  jobId: string;
  workerId: string;
  artifacts: GenerationArtifactResult[];
}, sql: GenerationSql = getGenerationSql()): Promise<GenerationJobResult> {
  const result: GenerationJobResult = {
    created: Math.floor(Date.now() / 1000),
    artifacts: input.artifacts,
    endpointLabel: input.artifacts.at(-1)?.endpointLabel,
  };
  const rows = await sql<{ id: string }[]>`
    UPDATE generation_job
    SET status = 'succeeded', completed_count = ${input.artifacts.length},
        primary_artifact_id = ${input.artifacts[0]?.id ?? null},
        result_json = ${sql.json(JSON.parse(JSON.stringify(result)) as never)},
        failure_class = NULL, failure_detail = NULL, finished_at = now(),
        lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = now()
    WHERE id = ${input.jobId} AND lease_owner = ${input.workerId}
      AND status IN ('leased', 'submitting', 'running')
    RETURNING id
  `;
  if (!rows[0]) throw new Error(`Could not complete generation job ${input.jobId}; lease ownership changed.`);
  return result;
}

export async function cancelGenerationJob(
  jobId: string,
  tenantId: string,
  sql: GenerationSql = getGenerationSql(),
): Promise<{ cancelled: boolean; previousStatus: GenerationJobStatus | null }> {
  // previous_status 经 CTE 快照取回（UPDATE ... RETURNING 只能拿到新值）。
  // CAS 的 status IN 条件保证只有可取消态才会更新成功；快照与实际前一态在
  // 并发下可能偶有偏差，但它只进入遥测 detail，不参与结算判断。
  const rows = await sql<{ id: string; previous_status: string | null }[]>`
    WITH previous AS (
      SELECT status FROM generation_job WHERE id = ${jobId} AND tenant_id = ${tenantId} LIMIT 1
    ), updated AS (
      UPDATE generation_job
      SET cancel_requested_at = COALESCE(cancel_requested_at,now()),
          status = CASE WHEN status IN ('submitting','running','submit_unknown') THEN status ELSE 'cancelled' END,
          failure_class = CASE WHEN status IN ('submitting','running','submit_unknown') THEN failure_class ELSE 'cancelled' END,
          failure_detail = 'Client requested cancellation; submitted remote work is preserved for reconciliation.',
          finished_at = CASE WHEN status IN ('submitting','running','submit_unknown') THEN finished_at ELSE now() END,
          lease_owner = CASE WHEN status IN ('submitting','running','submit_unknown') THEN lease_owner ELSE NULL END,
          lease_expires_at = CASE WHEN status IN ('submitting','running','submit_unknown') THEN lease_expires_at ELSE NULL END,updated_at = now()
      WHERE id = ${jobId} AND tenant_id = ${tenantId}
        AND status IN ('pending_billing', 'queued', 'leased', 'submitting', 'running','submit_unknown')
      RETURNING id
    )
    SELECT updated.id, previous.status AS previous_status
    FROM updated LEFT JOIN previous ON true
  `;
  if (!rows[0]) return { cancelled: false, previousStatus: null };
  const previousStatus = (rows[0].previous_status ?? null) as GenerationJobStatus | null;
  emitJobEvent(
    { jobId, event: JOB_EVENT.jobCancelled, actor: "client", detail: { tenant_id: tenantId, previous_status: previousStatus } },
    sql,
  );
  return { cancelled: true, previousStatus };
}

export async function recoverExpiredGenerationLeases(sql: GenerationSql = getGenerationSql()): Promise<{
  requeued: number;
  unknown: number;
}> {
  return sql.begin(async (tx) => {
    // 新代码明确记载尚在准备输入且没有POST起点；旧版本NULL不能据此推断未发。
    const prepared=await tx<{job_id:string}[]>`UPDATE generation_attempt a SET status='failed',recovery_status='resolved',
      failure_class='artifact_download',failure_detail='Lease expired during input preparation; provider was never called.',finished_at=now(),updated_at=now()
      FROM generation_job job WHERE job.id=a.job_id AND job.lease_expires_at<now()
      AND a.status IN ('submitting','running') AND a.provider_submission_started_at IS NULL
      AND a.recovery_detail='input_preparation_not_submitted' RETURNING a.job_id`;
    if(prepared.length) await tx`UPDATE generation_job SET status='queued',available_at=now(),lease_owner=NULL,
      lease_expires_at=NULL,heartbeat_at=NULL,updated_at=now() WHERE id=ANY(${prepared.map(a=>a.job_id)}::text[])
      AND status IN ('submitting','running') AND lease_expires_at<now()
      AND NOT EXISTS(SELECT 1 FROM generation_attempt a WHERE a.job_id=generation_job.id AND a.status IN ('submitting','running','submit_unknown') AND a.recovery_status<>'resolved')`;
    const requeued = await tx<{ id: string }[]>`
      UPDATE generation_job
      SET status = 'queued', available_at = now(), lease_owner = NULL, lease_expires_at = NULL,
          heartbeat_at = NULL, updated_at = now()
      WHERE status = 'leased' AND lease_expires_at < now()
      RETURNING id
    `;
    // INC-0831：submit_unknown 不再是死路——同时把未排程的对帐（task id 已知）补排，
    // 让 provider-reconciliation 接手查真相；钱冻结在 reserve，真相出来才结算。
    const unknown = await tx<{ id: string }[]>`
      UPDATE generation_job
      SET status = 'submit_unknown', failure_class = 'unknown',
          failure_detail = 'Worker lease expired after provider submission began; provider reconciliation scheduled.',
          lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = now()
      WHERE status IN ('submitting', 'running') AND lease_expires_at < now()
      RETURNING id
    `;
    if (unknown.length) {
      await tx`
        UPDATE generation_attempt
        SET status = 'submit_unknown', failure_class = 'unknown',
            failure_detail = 'Worker lease expired before provider result was durably reconciled.',
            recovery_owner = COALESCE(recovery_owner, 'control-plane:provider-reconciliation'), updated_at = now()
        WHERE job_id = ANY(${unknown.map((row) => row.id)}::text[]) AND status IN ('submitting', 'running')
      `;
      await tx`
        UPDATE generation_attempt
        SET provider_next_poll_at = COALESCE(provider_next_poll_at, now()),
            provider_reconcile_deadline_at = COALESCE(provider_reconcile_deadline_at, now() + interval '24 hours'),
            updated_at = now()
        WHERE job_id = ANY(${unknown.map((row) => row.id)}::text[])
          AND provider_state IN ('unknown', 'running', 'succeeded')
      `;
    }
    await tx`DELETE FROM supplier_lease WHERE expires_at < now()`;
    return { requeued: requeued.length, unknown: unknown.length };
  });
}

export function mapSupplierRecord(row: Row): SupplierRecord {
  return {
    id: String(row.id),
    label: String(row.label),
    adapterType: row.adapter_type as SupplierRecord["adapterType"],
    supplyTier: row.supply_tier as SupplierRecord["supplyTier"],
    failureDomain: String(row.failure_domain),
    baseUrl: String(row.base_url),
    credentialRef: String(row.credential_ref),
    configuration: jsonValue(row.configuration_json, {}),
    priority: Number(row.priority),
    concurrencyLimit: Number(row.concurrency_limit),
    qualityScore: Number(row.quality_score),
    unitCost: Number(row.unit_cost),
    healthStatus: row.health_status as SupplierRecord["healthStatus"],
    healthScore: Number(row.health_score),
    latencyEwmaMs: row.latency_ewma_ms === null ? null : Number(row.latency_ewma_ms),
    supplierModelId: row.supplier_model_id === null ? null : String(row.supplier_model_id),
    capabilityId: Number(row.capability_id),
    capabilityConcurrencyLimit: Number(row.capability_concurrency_limit),
    contractVersion: Number(row.contract_version),
    capabilityHealthStatus: row.capability_health_status as SupplierRecord["capabilityHealthStatus"],
    account: {
      id: String(row.account_id),
      label: String(row.account_label),
      credentialRef: String(row.account_credential_ref),
      concurrencyLimit: Number(row.account_concurrency_limit),
      healthStatus: row.account_health_status as SupplierRecord["account"]["healthStatus"],
      tokenSource: row.token_source === null ? null : String(row.token_source),
      credentialExpiresAt: nullableDate(row.credential_expires_at),
      refreshStatus: row.refresh_status as SupplierRecord["account"]["refreshStatus"],
      successRate5m: Number(row.success_rate_5m),
      healthObservedAt: nullableDate(row.health_observed_at),
      configuration: jsonValue(row.account_configuration_json, {}),
    },
  };
}

export function mapSupplierLease(row: Row): SupplierLease {
  return {
    id: String(row.lease_id),
    jobId: String(row.job_id),
    workerId: String(row.worker_id),
    expiresAt: asDate(row.expires_at),
    supplier: mapSupplierRecord(row),
  };
}
