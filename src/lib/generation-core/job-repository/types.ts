import { readFailureRecord, serializeFailureRecord, type FailureRecord } from "../failure-record";
import type { GenerationSql } from "../database";
import type { FailureClass, GenerationJob, GenerationJobResult, GenerationJobStatus } from "../types";

export type Row = Record<string, unknown>;

export class IdempotencyConflictError extends Error {
  constructor(readonly jobId: string) {
    super("The Idempotency-Key was already used with a different request.");
    this.name = "IdempotencyConflictError";
  }
}

export function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

export function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : asDate(value);
}

export function jsonValue<T>(value: unknown, fallback: T): T {
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
export function failureRecordParam(sql: GenerationSql, record: FailureRecord | null | undefined): never {
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
    cancelRequestedAt: nullableDate(row.cancel_requested_at),
    deadlineAt: asDate(row.deadline_at),
    availableAt: asDate(row.available_at),
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseExpiresAt: nullableDate(row.lease_expires_at),
    failureClass: row.failure_class === null ? null : row.failure_class as FailureClass,
    failureDetail: row.failure_detail === null ? null : String(row.failure_detail),
    failureRecord: mapFailureRecordColumn(row.failure_record_json),
    recovery: jsonValue(row.recovery_json, null),
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
