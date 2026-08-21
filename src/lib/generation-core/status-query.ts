// B 端診斷面的資料源（/v1/queue、/v1/history、/v1/system_stats）。
//
// 刻意把「純邏輯」與「查詢層」分成兩半：
//  - 純函式（toJobStatusSnapshot / clampPagination / computePlatformStats / …）
//    不吃資料庫，可以被單測鎖住 shape 與數學；
//  - 查詢函式接收可注入的 `sql`，測試只驗證純函式，不留真 DB 依賴。
//
// 安全約定：
//  - 每個 job 只回「診斷所需的投影」，永不回 prompt 密文 / workflow 內部結構；
//  - 所有查詢都以 tenant_id 為必備過濾鍵，金鑰只能看自己 tenant 的 job；
//  - system_stats 只在 SQL 層做聚合，回傳面永遠沒有 per-tenant 欄位。

import { getGenerationSql, type GenerationSql } from "./database";
import { mapGenerationJob } from "./job-repository";
import { taskResourcePath, taskStatus } from "./task-response";
import type { FailureClass, GenerationJob, GenerationJobStatus } from "./types";

/** 金鑰計費主體 → 控制面 tenant。與 images/generations 的提交路徑同源。 */
export const BIZ_TENANT_PREFIX = "biz:";

/** 佇列/進行中 = 尚未終結的狀態全集。終結狀態（succeeded/failed/cancelled/refunded）不在佇列。 */
export const QUEUE_STATUSES: readonly GenerationJobStatus[] = [
  "pending_billing",
  "billing_unknown",
  "queued",
  "leased",
  "submitting",
  "running",
  "submit_unknown",
];

export const HISTORY_DEFAULT_LIMIT = 20;
export const HISTORY_MAX_LIMIT = 100;
export const HISTORY_MAX_OFFSET = 10_000;

// ─────────────────────────────────────────── 純邏輯（可單測，不吃 DB）

export function bizTenantId(apiKeyId: string): string {
  return `${BIZ_TENANT_PREFIX}${apiKeyId}`;
}

/**
 * 診斷投影：把持久化 job 收斂成對外安全的狀態卡。
 * 原則是「保留診斷需要的、拔掉隱私相關的」——prompt 密文、workflow 內部、
 * 計費與租約內部字段一律不離開控制面。
 */
export interface JobStatusSnapshot {
  object: "image_generation.task";
  id: string;
  task_id: string;
  /** 內部原始狀態（含 leased / submit_unknown 等）——診斷用，比投影後黑盒更說明問題。 */
  status: GenerationJobStatus;
  /** OpenAI 相容投影：queued / running / succeeded / failed / cancelled / refunded / unknown。 */
  task_state: ReturnType<typeof taskStatus>;
  kind: GenerationJob["kind"];
  model: string;
  size: string | null;
  ratio: string | null;
  resolution: string | null;
  quality: string | null;
  requested_count: number;
  completed_count: number;
  attempt_count: number;
  retry_of_task_id: string | null;
  failure_class: FailureClass | null;
  failure_detail: string | null;
  created: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  task_url: string;
}

export function toJobStatusSnapshot(job: GenerationJob): JobStatusSnapshot {
  const kindPath = taskResourcePath(job.kind);
  return {
    object: "image_generation.task",
    id: job.id,
    task_id: job.id,
    status: job.status,
    task_state: taskStatus(job),
    kind: job.kind,
    model: job.modelId,
    size: job.size,
    ratio: job.ratio,
    resolution: job.resolution,
    quality: job.quality,
    requested_count: job.requestedCount,
    completed_count: job.completedCount,
    attempt_count: job.attemptCount,
    retry_of_task_id: job.retryOfTaskId,
    failure_class: job.failureClass,
    failure_detail: job.failureDetail,
    created: Math.floor(job.createdAt.getTime() / 1000),
    created_at: job.createdAt.toISOString(),
    started_at: job.startedAt ? job.startedAt.toISOString() : null,
    finished_at: job.finishedAt ? job.finishedAt.toISOString() : null,
    updated_at: job.updatedAt.toISOString(),
    task_url: `/v1/${kindPath}/${job.id}`,
  };
}

export interface Pagination {
  limit: number;
  offset: number;
}

export function clampPagination(rawLimit: unknown, rawOffset: unknown): Pagination {
  const requestedLimit = Number(rawLimit);
  const limit = Math.min(
    Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : HISTORY_DEFAULT_LIMIT),
    HISTORY_MAX_LIMIT,
  );
  const requestedOffset = Number(rawOffset);
  const offset = Math.min(
    Math.max(0, Number.isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0),
    HISTORY_MAX_OFFSET,
  );
  return { limit, offset };
}

export interface PlatformAggregateRow {
  model_id: unknown;
  total_jobs: unknown;
  succeeded_jobs: unknown;
  failed_jobs: unknown;
}

export interface PlatformModelStats {
  model: string;
  total_jobs: number;
  succeeded_jobs: number;
  failed_jobs: number;
  /** 正交語義：只算成功/失敗，不含排隊中的——不灌水。無終結樣本時為 null。 */
  success_rate: number | null;
}

export interface SystemStatsDigest {
  total_jobs: number;
  succeeded_jobs: number;
  failed_jobs: number;
  /** 仍在佇列/進行中的數量 = total - 成功 - 失敗。 */
  active_jobs: number;
  success_rate: number | null;
  by_model: PlatformModelStats[];
  generated_at: string;
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function computePlatformStats(rows: PlatformAggregateRow[], now = new Date()): SystemStatsDigest {
  const by_model: PlatformModelStats[] = rows.map((row) => {
    const succeeded = toCount(row.succeeded_jobs);
    const failed = toCount(row.failed_jobs);
    const terminal = succeeded + failed;
    return {
      model: String(row.model_id),
      total_jobs: toCount(row.total_jobs),
      succeeded_jobs: succeeded,
      failed_jobs: failed,
      success_rate: terminal > 0 ? succeeded / terminal : null,
    };
  });

  const total = by_model.reduce((sum, row) => sum + row.total_jobs, 0);
  const succeeded = by_model.reduce((sum, row) => sum + row.succeeded_jobs, 0);
  const failed = by_model.reduce((sum, row) => sum + row.failed_jobs, 0);

  return {
    total_jobs: total,
    succeeded_jobs: succeeded,
    failed_jobs: failed,
    active_jobs: Math.max(0, total - succeeded - failed),
    success_rate: succeeded + failed > 0 ? succeeded / (succeeded + failed) : null,
    by_model,
    generated_at: now.toISOString(),
  };
}

// ─────────────────────────────────────────── 查詢層（sql 可注入）

type Row = Record<string, unknown>;

/** 控制面 DB 未配置時 getGenerationSql 拋出的訊息（見 database.ts）。 */
const NOT_CONFIGURED_MARKER = /GENERATION_DATABASE_URL|DATABASE_URL is required/i;

export function isControlPlaneUnavailableError(error: unknown): boolean {
  return error instanceof Error && NOT_CONFIGURED_MARKER.test(error.message);
}

/**
 * 診斷端點共用的「DB 未配置＝誠實的空/零」閘道。
 * 未配置時回 null，路由回空清單而非 500——因為控制平面沒接 DB 時，
 * 「我的 queue 是空的」就是事實，不是故障假裝成功。
 */
export async function queryWhenReady<T>(fn: (sql: GenerationSql) => Promise<T>): Promise<T | null> {
  try {
    const sql = getGenerationSql();
    return await fn(sql);
  } catch (error) {
    if (isControlPlaneUnavailableError(error)) return null;
    throw error;
  }
}

export async function listTenantActiveJobs(
  tenantId: string,
  sql: GenerationSql = getGenerationSql(),
): Promise<GenerationJob[]> {
  const rows = await sql<Row[]>`
    SELECT * FROM generation_job
    WHERE tenant_id = ${tenantId}
      AND status = ANY(${QUEUE_STATUSES}::text[])
    ORDER BY created_at DESC
  `;
  return rows.map(mapGenerationJob);
}

export async function countTenantJobs(
  tenantId: string,
  statuses: GenerationJobStatus[] | null,
  sql: GenerationSql = getGenerationSql(),
): Promise<number> {
  const rows = await sql<{ count: unknown }[]>`
    SELECT count(*) AS count
    FROM generation_job
    WHERE tenant_id = ${tenantId}
      AND (${statuses}::text[] IS NULL OR status = ANY(${statuses}::text[]))
  `;
  return toCount(rows[0]?.count);
}

export async function listTenantHistory(
  tenantId: string,
  options: { limit?: number; offset?: number; statuses?: GenerationJobStatus[] },
  sql: GenerationSql = getGenerationSql(),
): Promise<GenerationJob[]> {
  const { limit, offset } = clampPagination(options.limit, options.offset);
  const statuses = options.statuses?.length ? options.statuses : null;
  const rows = await sql<Row[]>`
    SELECT * FROM generation_job
    WHERE tenant_id = ${tenantId}
      AND (${statuses}::text[] IS NULL OR status = ANY(${statuses}::text[]))
    ORDER BY created_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return rows.map(mapGenerationJob);
}

/**
 * 平台層聚合——只取 biz 軌道的任務，且只在 SQL 層 GROUP BY model。
 * 回傳面只有數字，任何一個 cell 都無法反推出單一 tenant 的行為。
 */
export async function queryPlatformDigest(sql: GenerationSql = getGenerationSql()): Promise<PlatformAggregateRow[]> {
  const rows = await sql<PlatformAggregateRow[]>`
    SELECT
      model_id,
      count(*) AS total_jobs,
      count(*) FILTER (WHERE status = 'succeeded') AS succeeded_jobs,
      count(*) FILTER (WHERE status = 'failed') AS failed_jobs
    FROM generation_job
    WHERE source = 'biz'
    GROUP BY model_id
    ORDER BY total_jobs DESC
  `;
  return rows;
}