import { randomUUID } from "node:crypto";
import { getGenerationSql, type GenerationSql } from "./database";
import { JOB_EVENT, emitJobEvent } from "./job-events";
import { resolveModelRoute } from "./model-routing";
import { readFailureRecord, serializeFailureRecord, type FailureRecord } from "./failure-record";
import type {
  CreateGenerationJobInput,
  FailureClass,
  GenerationArtifactResult,
  GenerationJob,
  GenerationJobResult,
  GenerationJobStatus,
  ProviderProtocol,
  SupplierLease,
  SupplierRecord,
} from "./types";

type Row = Record<string, unknown>;

export class IdempotencyConflictError extends Error {
  constructor(readonly jobId: string) {
    super("The Idempotency-Key was already used with a different request.");
    this.name = "IdempotencyConflictError";
  }
}

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : asDate(value);
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

/**
 * 落库用：把 FailureRecord 转成 postgres.js 的 jsonb 参数（null 走 SQL NULL）。
 * 测试用的录音 mock 没有 `sql.json`，故退回原物件（真实客户端由此包装成 jsonb）。
 * 回传 `never` 是 postgres.js tagged template 的参数型别惯例（同档其它 jsonb 写法）。
 */
function failureRecordParam(sql: GenerationSql, record: FailureRecord | null | undefined): never {
  if (!record) return null as never;
  const value = JSON.parse(serializeFailureRecord(record)) as unknown;
  const helper = (sql as unknown as { json?: (input: unknown) => unknown }).json;
  const param = typeof helper === "function" ? helper.call(sql, value) : value;
  return param as never;
}

/** 读回用：jsonb → FailureRecord（未知版本／坏结构回 null，不静默当成当前版本）。 */
export function mapFailureRecordColumn(value: unknown): FailureRecord | null {
  return readFailureRecord(value);
}

export function mapGenerationJob(row: Row): GenerationJob {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    apiKeyId: row.api_key_id === null ? null : String(row.api_key_id),
    billingUserId: row.billing_user_id === null ? null : Number(row.billing_user_id),
    source: row.source as GenerationJob["source"],
    idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key),
    requestHash: String(row.request_hash),
    kind: row.kind as GenerationJob["kind"],
    routingClass: row.routing_class as GenerationJob["routingClass"],
    modelId: String(row.model_id),
    size: row.size === null ? null : String(row.size),
    ratio: row.ratio === null ? null : String(row.ratio),
    resolution: row.resolution === null ? null : String(row.resolution),
    quality: row.quality === null ? null : String(row.quality),
    promptCiphertext: String(row.prompt_ciphertext),
    workflow: jsonValue(row.workflow_json, {}),
    responseFormat: row.response_format as GenerationJob["responseFormat"],
    callbackUrl: row.callback_url === null ? null : String(row.callback_url),
    retryOfTaskId: row.retry_of_job_id === null || row.retry_of_job_id === undefined ? null : String(row.retry_of_job_id),
    primaryResultId: row.primary_artifact_id === null || row.primary_artifact_id === undefined ? null : String(row.primary_artifact_id),
    batchId: row.batch_id === null || row.batch_id === undefined ? null : String(row.batch_id),
    batchIndex: row.batch_index === null || row.batch_index === undefined ? null : Number(row.batch_index),
    status: row.status as GenerationJobStatus,
    requestedCount: Number(row.requested_count),
    completedCount: Number(row.completed_count),
    attemptCount: Number(row.attempt_count),
    billingAmount: Number(row.billing_amount),
    deadlineAt: asDate(row.deadline_at),
    availableAt: asDate(row.available_at),
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseExpiresAt: nullableDate(row.lease_expires_at),
    failureClass: row.failure_class === null ? null : row.failure_class as FailureClass,
    failureDetail: row.failure_detail === null ? null : String(row.failure_detail),
    failureRecord: mapFailureRecordColumn(row.failure_record_json),
    result: jsonValue<GenerationJobResult | null>(row.result_json, null),
    createdAt: asDate(row.created_at),
    startedAt: nullableDate(row.started_at),
    finishedAt: nullableDate(row.finished_at),
    updatedAt: asDate(row.updated_at),
  };
}

export interface CreatedJob {
  job: GenerationJob;
  created: boolean;
}

export async function createGenerationJob(
  input: CreateGenerationJobInput,
  sql: GenerationSql = getGenerationSql(),
): Promise<CreatedJob> {
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

export async function getGenerationJob(id: string, sql: GenerationSql = getGenerationSql()): Promise<GenerationJob | null> {
  const rows = await sql<Row[]>`SELECT * FROM generation_job WHERE id = ${id} LIMIT 1`;
  return rows[0] ? mapGenerationJob(rows[0]) : null;
}

export async function getGenerationJobForTenant(
  id: string,
  tenantId: string,
  sql: GenerationSql = getGenerationSql(),
): Promise<GenerationJob | null> {
  const rows = await sql<Row[]>`
    SELECT * FROM generation_job WHERE id = ${id} AND tenant_id = ${tenantId} LIMIT 1
  `;
  return rows[0] ? mapGenerationJob(rows[0]) : null;
}

export async function listGenerationJobsForTenant(
  tenantId: string,
  options: { limit?: number; statuses?: GenerationJobStatus[] } = {},
  sql: GenerationSql = getGenerationSql(),
): Promise<GenerationJob[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
  const statuses = options.statuses?.length ? options.statuses : null;
  const rows = await sql<Row[]>`
    SELECT * FROM generation_job
    WHERE tenant_id = ${tenantId}
      AND (${statuses}::text[] IS NULL OR status = ANY(${statuses}::text[]))
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.map(mapGenerationJob);
}

export async function getGenerationArtifactForTenant(
  artifactId: string,
  tenantId: string,
  sql: GenerationSql = getGenerationSql(),
): Promise<{ artifactId: string; taskId: string } | null> {
  const rows = await sql<{ artifact_id: string; job_id: string }[]>`
    SELECT artifact.id AS artifact_id, artifact.job_id
    FROM artifact
    JOIN generation_job ON generation_job.id = artifact.job_id
    WHERE artifact.id = ${artifactId} AND generation_job.tenant_id = ${tenantId}
      AND artifact.role = 'output'
    LIMIT 1
  `;
  return rows[0] ? { artifactId: rows[0].artifact_id, taskId: rows[0].job_id } : null;
}

/**
 * Completed artifacts are the durable source of truth when a multi-output job
 * is released back to the queue between outputs. The JSON result is written
 * only when the last output succeeds, so it cannot be used for resume.
 */
export async function listCompletedGenerationArtifacts(
  jobId: string,
  sql: GenerationSql = getGenerationSql(),
): Promise<GenerationArtifactResult[]> {
  const rows = await sql<Row[]>`
    SELECT id, output_index, delivery_url, mime_type, sha256, width, height, metadata_json
    FROM artifact
    WHERE job_id = ${jobId} AND role = 'output'
    ORDER BY output_index ASC, created_at ASC
  `;
  return rows.map((row) => {
    const metadata = jsonValue<Record<string, unknown>>(row.metadata_json, {});
    return {
      id: String(row.id),
      outputIndex: Number(row.output_index),
      url: row.delivery_url === null ? null : String(row.delivery_url),
      mimeType: String(row.mime_type),
      sha256: String(row.sha256),
      // NULL 直译为 null：Number(null) 是 0，会把「未实测」伪造成「0×0」（G4 成片可缺尺寸）。
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      endpointLabel: typeof metadata.endpointLabel === "string" ? metadata.endpointLabel : "unknown",
    };
  });
}

export async function hasGenerationCapability(input: {
  modelId: string;
  kind: GenerationJob["kind"];
  ratio?: string | null;
  resolution?: string | null;
  routingClass: GenerationJob["routingClass"];
}, sql: GenerationSql = getGenerationSql()): Promise<boolean> {
  // 与 acquireSupplierLease 同一把尺：不在生效路由里的 supplier 不算可供给。
  const route = await resolveModelRoute(input.modelId, sql);
  if (!route.supplierIds.length) return false;
  const rows = await sql<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM supplier_capability capability
      JOIN supplier ON supplier.id = capability.supplier_id
      WHERE supplier.enabled
        AND supplier.health_status <> 'disabled'
        AND capability.enabled
        AND capability.public_model_id = ${input.modelId}
        AND capability.kind = ${input.kind}
        AND (${input.ratio ?? null}::text IS NULL OR cardinality(capability.ratios) = 0 OR ${input.ratio ?? null} = ANY(capability.ratios))
        AND (${input.resolution ?? null}::text IS NULL OR cardinality(capability.resolutions) = 0 OR ${input.resolution ?? null} = ANY(capability.resolutions))
        AND (${input.routingClass} <> 'firefly_only' OR supplier.adapter_type = 'adobe2api')
        AND supplier.id = ANY(${route.supplierIds}::text[])
    ) AS present
  `;
  return Boolean(rows[0]?.present);
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
      -- Expired queued jobs must still be claimed once so the worker can move
      -- them to a terminal state and execute the existing refund path. Leaving
      -- them out here creates permanently queued, already-charged tasks.
      ORDER BY (deadline_at <= now()) DESC, available_at, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE generation_job job
    SET status = 'leased', lease_owner = ${workerId},
        lease_expires_at = now() + (${leaseMs}::text || ' milliseconds')::interval,
        heartbeat_at = now(), started_at = COALESCE(started_at, now()), updated_at = now()
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

// R7-D（2026-08-29）：排队 deadline（预设 3 分钟）只保护「等容量」阶段；
// 开工后以 started_at 为锚展期到 15 分钟总生成预算。GREATEST 保证对显式
// 传入更长 deadlineMs 的调用者只增不减；只在租约仍属本 worker 时生效。
//
// 病灶 D 修复（2026-08-30）：改为 RETURNING 实际写入的 deadline_at，让调用方
// 同步内存 `job.deadlineAt`，消除「内存快照 deadline 与 DB 不一致」的语义漂移
// （真正开工的 job 内存 deadline 停在 claim 时 3 分钟，DB 已被 extend 到 15 分钟）。
export async function extendGenerationDeadlineJob(
  job: { id: string; startedAt: Date | null },
  workerId: string,
  totalBudgetMs: number,
  sql: GenerationSql = getGenerationSql(),
): Promise<Date | null> {
  if (!job.startedAt) return null;
  const rows = await sql<{ deadline_at: unknown }[]>`
    UPDATE generation_job
    SET deadline_at = GREATEST(deadline_at, ${job.startedAt} + (${totalBudgetMs}::text || ' milliseconds')::interval),
        updated_at = now()
    WHERE id = ${job.id} AND lease_owner = ${workerId}
      AND status IN ('leased', 'submitting', 'running')
    RETURNING deadline_at
  `;
  return rows[0] ? asDate(rows[0].deadline_at) : null;
}

// 病灶 D（2026-08-30）：排队期退避撞穿 3 分钟 deadline —— 无 lease 时反覆
// claim→acquire 失败→releaseForRetry(backoff)，直到排队 deadline 到期被
// deadline_exceeded 杀单（实录 12 笔 video job 全死于此，attempt_count=0）。
// 这里做一次排队顺延：deadline 快到期且还在「可恢复」的等容量状态时，把
// deadline 往后推 extraMs（相对 now 增量，避免 started_at 锚定的 GREATEST
// 第二次就推不动）。上限由调用方用 shouldExtendQueueDeadline 把关（20min 封顶），
// 确保纯无供应商的死路不会无限挂单。
export async function extendGenerationQueueDeadline(
  job: { id: string; startedAt: Date | null },
  workerId: string,
  extraMs: number,
  sql: GenerationSql = getGenerationSql(),
): Promise<Date | null> {
  if (!job.startedAt) return null;
  const rows = await sql<{ deadline_at: unknown }[]>`
    UPDATE generation_job
    SET deadline_at = GREATEST(deadline_at, now() + (${extraMs}::text || ' milliseconds')::interval),
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
}, sql: GenerationSql = getGenerationSql()): Promise<{ id: string; attemptNo: number }> {
  return sql.begin(async (tx) => {
    const jobs = await tx<{ attempt_count: number }[]>`
      UPDATE generation_job
      SET status = 'submitting', attempt_count = attempt_count + 1, updated_at = now()
      WHERE id = ${input.jobId} AND lease_owner = ${input.workerId}
        AND status IN ('leased', 'running')
      RETURNING attempt_count
    `;
    if (!jobs[0]) throw new Error(`Worker ${input.workerId} no longer owns generation job ${input.jobId}.`);
    const id = randomUUID();
    const attemptNo = Number(jobs[0].attempt_count);
    await tx`
      INSERT INTO generation_attempt (
        id, job_id, attempt_no, output_index, supplier_id, supplier_model_id, status
      ) VALUES (
        ${id}, ${input.jobId}, ${attemptNo}, ${input.outputIndex}, ${input.supplierId},
        ${input.supplierModelId}, 'submitting'
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
          evidence_json = ${tx.json(JSON.parse(JSON.stringify(input.evidence ?? {})) as never)}, updated_at = now()
      WHERE id = ${input.attemptId} AND job_id = ${input.jobId}
    `;
    await tx`
      UPDATE generation_job
      SET status = 'running', completed_count = completed_count + ${input.advanceOutput === false ? 0 : 1}, updated_at = now()
      WHERE id = ${input.jobId} AND lease_owner = ${input.workerId}
    `;
  });
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
          provider_task_id = ${input.providerTaskId ?? null},
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
        provider_next_poll_at = now() + (${delaySec}::text || ' seconds')::interval,
        provider_reconcile_deadline_at = now() + (${windowSec}::text || ' seconds')::interval,
        updated_at = now()
    WHERE id = ${input.attemptId} AND job_id = ${input.jobId}
      AND (provider_task_id IS NULL OR provider_task_id = ${input.providerTaskId})
      AND status IN ('submitting', 'running', 'failed')
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
      AND generation_attempt.provider_task_id IS NOT NULL
      AND generation_attempt.provider_state IN ('unknown', 'running')
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
      AND status IN ('failed', 'refunded', 'submit_unknown', 'cancelled')
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
    WHERE job_id = ${jobId} AND provider_task_id IS NOT NULL
      AND provider_state IN ('unknown', 'running')
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
  `;
  return {
    supplierIds: rows.map((row) => row.supplier_id),
    failureDomains: [...new Set(rows.map((row) => row.failure_domain))],
  };
}

export interface GenerationAttemptSummary {
  attemptNo: number;
  outputIndex: number;
  status: string;
  providerHttpStatus: number | null;
  latencyMs: number | null;
  failureClass: string | null;
  /** 上游失败原文（仅 failed attempt 有）。worker 诊断排除链时带给 supplier_excluded 讯息。 */
  failureDetail: string | null;
  /** FG-01：版本化失败记录（原生栏位逐字保留）；读不出来（未知版本/坏结构）为 null。 */
  failureRecord: FailureRecord | null;
  supplierLabel: string;
  supplierBaseUrl: string;
}

/** /v1/videos/[id] attempts 摘要行（INC-0830-VIDEO，plain object，供网关 rerun 防重消费）。 */
export interface VideoAttemptSummary {
  attempt_no: number;
  output_index: number;
  supplier_id: string;
  status: string;
  provider_task_id: string | null;
  failure_class: string | null;
  /** 截断 300 字的失败原文。 */
  failure_detail: string | null;
  submitted_at: string;
  finished_at: string | null;
}

/** 读取 job 的全部 attempt 摘要（attempt_no 升幂）。只读，job 不存在时返回空数组。 */
export async function listVideoAttemptSummariesForJob(jobId: string, sql: GenerationSql = getGenerationSql()): Promise<VideoAttemptSummary[]> {
  const rows = await sql<{
    attempt_no: number;
    output_index: number;
    supplier_id: string;
    status: string;
    provider_task_id: string | null;
    failure_class: string | null;
    failure_detail: string | null;
    submitted_at: Date;
    finished_at: Date | null;
  }[]>`
    SELECT attempt_no, output_index, supplier_id, status, provider_task_id,
           failure_class, failure_detail, submitted_at, finished_at
    FROM generation_attempt
    WHERE job_id = ${jobId}
    ORDER BY attempt_no, output_index
  `;
  return rows.map((row) => ({
    attempt_no: Number(row.attempt_no),
    output_index: Number(row.output_index),
    supplier_id: String(row.supplier_id),
    status: String(row.status),
    provider_task_id: row.provider_task_id === null ? null : String(row.provider_task_id),
    failure_class: row.failure_class === null ? null : String(row.failure_class),
    failure_detail: row.failure_detail === null ? null : String(row.failure_detail).slice(0, 300),
    submitted_at: new Date(row.submitted_at).toISOString(),
    finished_at: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
  }));
}

/** All attempts of a job, oldest attempt first (then output index), for routing telemetry. */
export async function listGenerationAttemptsForJob(jobId: string, sql: GenerationSql = getGenerationSql()): Promise<GenerationAttemptSummary[]> {
  const rows = await sql<{
    attempt_no: number;
    output_index: number;
    status: string;
    provider_http_status: number | null;
    latency_ms: number | null;
    failure_class: string | null;
    failure_detail: string | null;
    failure_record_json: unknown;
    supplier_label: string;
    supplier_base_url: string;
  }[]>`
    SELECT attempt.attempt_no, attempt.output_index, attempt.status,
           attempt.provider_http_status, attempt.latency_ms, attempt.failure_class,
           attempt.failure_detail, attempt.failure_record_json,
           supplier.label AS supplier_label, supplier.base_url AS supplier_base_url
    FROM generation_attempt attempt
    JOIN supplier ON supplier.id = attempt.supplier_id
    WHERE attempt.job_id = ${jobId}
    ORDER BY attempt.attempt_no, attempt.output_index
  `;
  return rows.map((row) => ({
    attemptNo: Number(row.attempt_no),
    outputIndex: Number(row.output_index),
    status: row.status,
    providerHttpStatus: row.provider_http_status === null ? null : Number(row.provider_http_status),
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    failureClass: row.failure_class,
    failureDetail: row.failure_detail === null ? null : String(row.failure_detail),
    failureRecord: mapFailureRecordColumn(row.failure_record_json),
    supplierLabel: row.supplier_label,
    supplierBaseUrl: row.supplier_base_url,
  }));
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
      SET status = 'cancelled', failure_class = 'cancelled', failure_detail = 'Cancelled by client.',
          finished_at = now(), lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = ${jobId} AND tenant_id = ${tenantId}
        AND status IN ('pending_billing', 'queued', 'leased', 'submitting', 'running')
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
            failure_detail = 'Worker lease expired before provider result was durably reconciled.', updated_at = now()
        WHERE job_id = ANY(${unknown.map((row) => row.id)}::text[]) AND status IN ('submitting', 'running')
      `;
      await tx`
        UPDATE generation_attempt
        SET provider_next_poll_at = COALESCE(provider_next_poll_at, now()),
            provider_reconcile_deadline_at = COALESCE(provider_reconcile_deadline_at, now() + interval '24 hours'),
            updated_at = now()
        WHERE job_id = ANY(${unknown.map((row) => row.id)}::text[])
          AND provider_task_id IS NOT NULL AND provider_state IN ('unknown', 'running')
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
