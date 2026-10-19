// SLO 聚合查询层：按 (tenant_id, model_id) 分组，回报成功率 / 延迟分位 / 排队时长 /
// 重试率 / 退款率 / 观测单位成本。纯读取，不写任何表。
//
// 设计取舍（都在对应栏位旁重复注记，这里先集中说明一次）：
// - successRate 分母只计 succeeded + failed（排除仍在飞行中的状态，如 queued/running）。
//   若窗口内一笔 succeeded/failed 都没有，回 null（样本不足，不是「100% 成功」）。
// - p50/p95LatencyMs 用 Postgres percentile_cont 在 SQL 内算，不把整表 latency_ms 拉进 JS。
// - retryRate 用「attempt_count > 1 的任务占比」而非 avg(attempt_count)——栏位名字暗示的是
//   「有多少比例的任务需要重试」，用 count(*) FILTER 一次聚合就能算对，不必额外校准单位。
// - refundRate 是 best-effort 代理：status = 'refunded'，或 status = 'failed' 且
//   billing_amount > 0（钱已预扣但没交付）。这是简化版——真正的「是否已退款」要看
//   billing_operation 的 operation = 'refund' 记录，但那张表的读写逻辑正被其他 agent
//   改动中，这里刻意不依赖它，只用 generation_job 自身栏位做保守估计。
// - unitCostObserved 取 generation_attempt.cost_observed 的平均值，忽略 NULL（供应商未回报成本时）。

import { getGenerationSql, type GenerationSql } from "./database";

type Row = Record<string, unknown>;

/** getGenerationSql() 在未配置 GENERATION_DATABASE_URL / DATABASE_URL 时抛出的讯息，
 * 与 database.ts 完全一致——computeSloWindow 只吞这一种错误，其他查询错误照样往外抛。 */
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
  /** 窗口内落在这个分组的任务数（仅计已建立的 generation_job 行，含仍在飞行中的）。 */
  sampleSize: number;
  /** succeeded / (succeeded + failed)；分母为 0（窗口内无终态任务）时为 null。 */
  successRate: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  /** 已开始（started_at 非空）任务的平均排队时长；无已开始任务时为 null。 */
  avgQueueAgeMs: number | null;
  /** attempt_count > 1 的任务占比，见档头注解。 */
  retryRate: number;
  /** refunded，或 failed 且已预扣款的任务占比，见档头注解（best-effort 代理）。 */
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
 * 按 (tenant_id, model_id) 分组的窗口内 SLO 指标。
 *
 * `sql` 仅供测试注入（同 generation-core 其余模组的 DI 惯例）；生产路径省略即走
 * `getGenerationSql()`。未配置 Postgres 时（无论是省略 sql 触发 getGenerationSql() 抛错，
 * 还是测试注入的 mock sql 模拟同一错误讯息）一律回空阵列，不抛错——这是后台 SLO 面板
 * 的读取路径，资料库没配好不该让面板整页 500。
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
 * 纯函式（无 DB），供 admin 面板/告警消费——刻意跟查询层解耦，方便单测所有门槛组合。
 * successRate / p95LatencyMs 样本不足（null）时视为「无证据」，不触发该项门槛；
 * retryRate / refundRate 永远有值（分母为 sampleSize，见 computeSloWindow），直接比较。
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
