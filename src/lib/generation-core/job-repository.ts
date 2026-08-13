import { randomUUID } from "node:crypto";
import { getGenerationSql, type GenerationSql } from "./database";
import type {
  CreateGenerationJobInput,
  FailureClass,
  GenerationArtifactResult,
  GenerationJob,
  GenerationJobResult,
  GenerationJobStatus,
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
        workflow_json, response_format, callback_url, retry_of_job_id, requested_count, billing_amount, deadline_at
      ) VALUES (
        ${input.id}, ${input.tenantId}, ${input.apiKeyId ?? null}, ${input.billingUserId ?? null},
        ${input.source}, ${input.idempotencyKey ?? null}, ${input.requestHash}, ${input.kind},
        ${input.routingClass}, ${input.modelId}, ${input.size ?? null}, ${input.ratio ?? null},
        ${input.resolution ?? null}, ${input.quality ?? null}, ${input.promptCiphertext},
        ${tx.json(JSON.parse(JSON.stringify(input.workflow ?? {})) as never)}, ${input.responseFormat ?? "b64_json"},
        ${input.callbackUrl ?? null}, ${input.retryOfTaskId ?? null}, ${input.requestedCount}, ${input.billingAmount}, ${input.deadlineAt}
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
      width: Number(row.width),
      height: Number(row.height),
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
      SET status = 'running', completed_count = completed_count + 1, updated_at = now()
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
  providerHttpStatus?: number;
  retryAfterAt?: Date | null;
  latencyMs: number;
}, sql: GenerationSql = getGenerationSql()): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE generation_attempt
      SET status = 'failed', failure_class = ${input.failureClass}, failure_detail = ${input.failureDetail.slice(0, 2000)},
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
  supplierLabel: string;
  supplierBaseUrl: string;
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
    supplier_label: string;
    supplier_base_url: string;
  }[]>`
    SELECT attempt.attempt_no, attempt.output_index, attempt.status,
           attempt.provider_http_status, attempt.latency_ms, attempt.failure_class,
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
    supplierLabel: row.supplier_label,
    supplierBaseUrl: row.supplier_base_url,
  }));
}

export async function failGenerationJob(input: {
  jobId: string;
  workerId?: string;
  failureClass: FailureClass;
  failureDetail: string;
}, sql: GenerationSql = getGenerationSql()): Promise<void> {
  await sql`
    UPDATE generation_job
    SET status = 'failed', failure_class = ${input.failureClass},
        failure_detail = ${input.failureDetail.slice(0, 2000)}, finished_at = now(),
        lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = now()
    WHERE id = ${input.jobId}
      AND (${input.workerId ?? null}::text IS NULL OR lease_owner = ${input.workerId ?? null})
      AND status NOT IN ('succeeded', 'failed', 'cancelled')
  `;
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
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE generation_job
    SET status = 'cancelled', failure_class = 'cancelled', failure_detail = 'Cancelled by client.',
        finished_at = now(), lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE id = ${jobId} AND tenant_id = ${tenantId}
      AND status IN ('pending_billing', 'queued', 'leased')
    RETURNING id
  `;
  return Boolean(rows[0]);
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
    const unknown = await tx<{ id: string }[]>`
      UPDATE generation_job
      SET status = 'submit_unknown', failure_class = 'unknown',
          failure_detail = 'Worker lease expired after provider submission began; manual/provider reconciliation required.',
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
