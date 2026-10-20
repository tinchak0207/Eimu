import { getGenerationSql, type GenerationSql } from "../database";
import { resolveModelRoute } from "../model-routing";
import type { GenerationArtifactResult, GenerationJob, GenerationJobStatus } from "../types";
import { jsonValue, mapFailureRecordColumn, mapGenerationJob, type GenerationAttemptSummary, type Row, type VideoAttemptSummary } from "./types";

export async function getGenerationJob(id: string, sql: GenerationSql = getGenerationSql()): Promise<GenerationJob | null> {
  const rows = await sql<Row[]>`SELECT job.*, (SELECT jsonb_build_object('state',a.recovery_status,'owner',a.recovery_owner,'deadline_at',a.provider_reconcile_deadline_at,'detail',a.recovery_detail)
      FROM generation_attempt a WHERE a.job_id=job.id AND a.status='submit_unknown' ORDER BY a.attempt_no DESC LIMIT 1) AS recovery_json
      FROM generation_job job WHERE job.id = ${id} LIMIT 1`;
  return rows[0] ? mapGenerationJob(rows[0]) : null;
}

export async function getGenerationJobForTenant(
  id: string,
  tenantId: string,
  sql: GenerationSql = getGenerationSql(),
): Promise<GenerationJob | null> {
  const rows = await sql<Row[]>`
    SELECT job.*, (SELECT jsonb_build_object('state',a.recovery_status,'owner',a.recovery_owner,'deadline_at',a.provider_reconcile_deadline_at,'detail',a.recovery_detail)
      FROM generation_attempt a WHERE a.job_id=job.id AND a.status='submit_unknown' ORDER BY a.attempt_no DESC LIMIT 1) AS recovery_json
      FROM generation_job job WHERE job.id = ${id} AND job.tenant_id = ${tenantId} LIMIT 1
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
      actualSupplierModelId: typeof metadata.actualSupplierModelId==='string' ? metadata.actualSupplierModelId : null,
      originalHttpStatus:typeof metadata.originalHttpStatus==='number' ? metadata.originalHttpStatus : null,
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
