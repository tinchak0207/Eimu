// SLO 聚合查詢層：按 (tenant_id, model_id) 分組，回報成功率 / 延遲分位 / 排隊時長 /
// 重試率 / 退款率 / 觀測單位成本。純讀取，不寫任何表。
//
// 設計取捨（都在對應欄位旁重複註記，這裡先集中說明一次）：
// - successRate 分母只計 succeeded + failed（排除仍在飛行中的狀態，如 queued/running）。
//   若窗口內一筆 succeeded/failed 都沒有，回 null（樣本不足，不是「100% 成功」）。
// - p50/p95LatencyMs 用 Postgres percentile_cont 在 SQL 內算，不把整表 latency_ms 拉進 JS。
// - retryRate 用「attempt_count > 1 的任務佔比」而非 avg(attempt_count)——欄位名字暗示的是
//   「有多少比例的任務需要重試」，用 count(*) FILTER 一次聚合就能算對，不必額外校準單位。
// - refundRate 是 best-effort 代理：status = 'refunded'，或 status = 'failed' 且
//   billing_amount > 0（錢已預扣但沒交付）。這是簡化版——真正的「是否已退款」要看
//   billing_operation 的 operation = 'refund' 記錄，但那張表的讀寫邏輯正被其他 agent
//   改動中，這裡刻意不依賴它，只用 generation_job 自身欄位做保守估計。
// - unitCostObserved 取 generation_attempt.cost_observed 的平均值，忽略 NULL（供應商未回報成本時）。

import { getGenerationSql, type GenerationSql } from "./database";

type Row = Record<string, unknown>;

/** getGenerationSql() 在未配置 GENERATION_DATABASE_URL / DATABASE_URL 時拋出的訊息，
 * 與 database.ts 完全一致——computeSloWindow 只吞這一種錯誤，其他查詢錯誤照樣往外拋。 */
const NOT_CONFIGURED_MESSAGE =
  "GENERATION_DATABASE_URL or DATABASE_URL is required for the generation control plane.";

export interface SloWindowInput {
  tenantId?: string;
  modelId?: string;
  windowStart: Date;
  windowEnd: Date;
}

export interface SloWindowRow {
  tenantId: string;
  modelId: string;
  /** 窗口內落在這個分組的任務數（僅計已建立的 generation_job 行，含仍在飛行中的）。 */
  sampleSize: number;
  /** succeeded / (succeeded + failed)；分母為 0（窗口內無終態任務）時為 null。 */
  successRate: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  /** 已開始（started_at 非空）任務的平均排隊時長；無已開始任務時為 null。 */
  avgQueueAgeMs: number | null;
  /** attempt_count > 1 的任務佔比，見檔頭註解。 */
  retryRate: number;
  /** refunded，或 failed 且已預扣款的任務佔比，見檔頭註解（best-effort 代理）。 */
  refundRate: number;
  unitCostObserved: number | null;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function mapSloRow(row: Row): SloWindowRow {
  const succeeded = Number(row.succeeded_count ?? 0);
  const failed = Number(row.failed_count ?? 0);
  const terminalCount = succeeded + failed;
  return {
    tenantId: String(row.tenant_id),
    modelId: String(row.model_id),
    sampleSize: Number(row.sample_size ?? 0),
    successRate: terminalCount > 0 ? succeeded / terminalCount : null,
    p50LatencyMs: toNullableNumber(row.p50_latency_ms),
    p95LatencyMs: toNullableNumber(row.p95_latency_ms),
    avgQueueAgeMs: toNullableNumber(row.avg_queue_age_ms),
    retryRate: Number(row.retry_fraction ?? 0),
    refundRate: Number(row.refund_fraction ?? 0),
    unitCostObserved: toNullableNumber(row.avg_cost_observed),
  };
}

/**
 * 按 (tenant_id, model_id) 分組的窗口內 SLO 指標。
 *
 * `sql` 僅供測試注入（同 generation-core 其餘模組的 DI 慣例）；生產路徑省略即走
 * `getGenerationSql()`。未配置 Postgres 時（無論是省略 sql 觸發 getGenerationSql() 拋錯，
 * 還是測試注入的 mock sql 模擬同一錯誤訊息）一律回空陣列，不拋錯——這是後台 SLO 面板
 * 的讀取路徑，資料庫沒配好不該讓面板整頁 500。
 */
export async function computeSloWindow(
  input: SloWindowInput,
  sql?: GenerationSql,
): Promise<SloWindowRow[]> {
  try {
    const client = sql ?? getGenerationSql();
    const rows = await client<Row[]>`
      WITH scoped_jobs AS (
        SELECT *
        FROM generation_job
        WHERE created_at >= ${input.windowStart} AND created_at < ${input.windowEnd}
          AND (${input.tenantId ?? null}::text IS NULL OR tenant_id = ${input.tenantId ?? null})
          AND (${input.modelId ?? null}::text IS NULL OR model_id = ${input.modelId ?? null})
      ),
      attempt_stats AS (
        SELECT
          j.tenant_id,
          j.model_id,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY a.latency_ms) AS p50_latency_ms,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY a.latency_ms) AS p95_latency_ms,
          avg(a.cost_observed) AS avg_cost_observed
        FROM generation_attempt a
        JOIN scoped_jobs j ON j.id = a.job_id
        GROUP BY j.tenant_id, j.model_id
      )
      SELECT
        j.tenant_id,
        j.model_id,
        count(*) AS sample_size,
        count(*) FILTER (WHERE j.status = 'succeeded') AS succeeded_count,
        count(*) FILTER (WHERE j.status = 'failed') AS failed_count,
        (count(*) FILTER (WHERE j.attempt_count > 1))::float / count(*) AS retry_fraction,
        avg(EXTRACT(EPOCH FROM (j.started_at - j.created_at)) * 1000)
          FILTER (WHERE j.started_at IS NOT NULL) AS avg_queue_age_ms,
        (count(*) FILTER (WHERE j.status = 'refunded' OR (j.status = 'failed' AND j.billing_amount > 0)))::float
          / count(*) AS refund_fraction,
        stats.p50_latency_ms,
        stats.p95_latency_ms,
        stats.avg_cost_observed
      FROM scoped_jobs j
      LEFT JOIN attempt_stats stats ON stats.tenant_id = j.tenant_id AND stats.model_id = j.model_id
      GROUP BY j.tenant_id, j.model_id, stats.p50_latency_ms, stats.p95_latency_ms, stats.avg_cost_observed
    `;
    return rows.map(mapSloRow);
  } catch (error) {
    if (error instanceof Error && error.message === NOT_CONFIGURED_MESSAGE) return [];
    throw error;
  }
}

export interface SloThresholds {
  minSuccessRate: number;
  maxP95LatencyMs: number;
  maxRefundRate: number;
}

export type SloBreachKind = "success_rate" | "p95_latency" | "refund_rate";

export interface SloBreach {
  tenantId: string;
  modelId: string;
  kinds: SloBreachKind[];
  row: SloWindowRow;
}

/**
 * 純函式（無 DB），供 admin 面板/告警消費——刻意跟查詢層解耦，方便單測所有門檻組合。
 * successRate / p95LatencyMs 樣本不足（null）時視為「無證據」，不觸發該項門檻；
 * retryRate / refundRate 永遠有值（分母為 sampleSize，見 computeSloWindow），直接比較。
 */
export function evaluateSloBreaches(rows: SloWindowRow[], thresholds: SloThresholds): SloBreach[] {
  const breaches: SloBreach[] = [];
  for (const row of rows) {
    const kinds: SloBreachKind[] = [];
    if (row.successRate !== null && row.successRate < thresholds.minSuccessRate) {
      kinds.push("success_rate");
    }
    if (row.p95LatencyMs !== null && row.p95LatencyMs > thresholds.maxP95LatencyMs) {
      kinds.push("p95_latency");
    }
    if (row.refundRate > thresholds.maxRefundRate) {
      kinds.push("refund_rate");
    }
    if (kinds.length > 0) {
      breaches.push({ tenantId: row.tenantId, modelId: row.modelId, kinds, row });
    }
  }
  return breaches;
}
