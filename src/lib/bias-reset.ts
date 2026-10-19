// 渠道 bias 刷新水位（2026-10-12）——单一真源。
//
// 病根：平台对渠道的负面判定全部来自历史证据（72h job 终态 → 断路器；24h routing
// events → last_24h 零交付闸／欠费信号；supplier.health_status/cooldown → 调度可用性）。
// 渠道从坏变好时判据不重新计时，agent 只能干等 24-72h 自然过期，或人工改 DB
// （无台账、不可复现）。这里给出机制：一条可审计的水位，让「修好之前的证据」不再
// 计入判定；历史证据本身保留（不破坏、可反查）。
//
// 谁写：`tools/refresh-channel-bias.ts`（带 reason/actor，同一入口复位调度态）。
// 谁读：`/v1/model-status`、`/api/internal/model-status`（24h 统计 + 欠费信号）、
//       `model-availability-gate`（72h 断路器）。
//
// fail-open 纪律：表不存在（迁移未跑）／DB 不可达 → 空水位 → 判据退化为原行为。
// 绝不允许「水位读不到」变成放行或拦截。

import { generationControlPlaneEnabled, getGenerationSql, type GenerationSql } from "./generation-core/database";

export type BiasResetScope = "model" | "supplier";

export interface BiasResetRow {
  scope: BiasResetScope;
  target: string;
  /** 该时刻（epoch ms）之前的负面证据不计入判定。 */
  resetAt: number;
  reason: string;
  actor: string;
}

export interface BiasResetWatermarks {
  /** public model_id → reset_at(epoch ms)。 */
  modelResets: Map<string, number>;
  /** supplier id/label → reset_at(epoch ms)。 */
  supplierResets: Map<string, number>;
  rows: BiasResetRow[];
}

export const EMPTY_BIAS_RESET_WATERMARKS: BiasResetWatermarks = {
  modelResets: new Map(),
  supplierResets: new Map(),
  rows: [],
};

/** 水位表读取缓存：判据侧每次请求读一次即可，30 秒内复用（写入方跑在另一进程）。 */
const WATERMARK_CACHE_TTL_MS = 30_000;
let watermarkCache: { expiresAt: number; value: BiasResetWatermarks } | null = null;

function toMs(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export async function readBiasResetWatermarks(sql?: GenerationSql): Promise<BiasResetWatermarks> {
  const now = Date.now();
  if (watermarkCache && watermarkCache.expiresAt > now) return watermarkCache.value;
  // 无 DB 的实例（Vercel 边缘）不另算：空水位，真判定只在控制面。
  if (!sql && !generationControlPlaneEnabled()) return EMPTY_BIAS_RESET_WATERMARKS;

  try {
    const db = sql ?? getGenerationSql();
    const rows = await db<{ scope: string; target: string; reset_at: Date | string; reason: string | null; actor: string | null }[]>`
      SELECT scope, target, reset_at, reason, actor
      FROM channel_bias_reset
    `;
    const value: BiasResetWatermarks = { modelResets: new Map(), supplierResets: new Map(), rows: [] };
    for (const row of rows) {
      const resetAt = toMs(row.reset_at);
      if (resetAt === null) continue;
      const scope: BiasResetScope = row.scope === "supplier" ? "supplier" : "model";
      (scope === "supplier" ? value.supplierResets : value.modelResets).set(row.target, resetAt);
      value.rows.push({ scope, target: row.target, resetAt, reason: row.reason ?? "", actor: row.actor ?? "" });
    }
    watermarkCache = { expiresAt: now + WATERMARK_CACHE_TTL_MS, value };
    return value;
  } catch (error) {
    console.error("[bias-reset] 水位读取失败（fail-open，按无水位的原判据继续）", error);
    return EMPTY_BIAS_RESET_WATERMARKS;
  }
}

/** 清进程内水位缓存。写入方（同进程工具）在 upsert 之后必须调，否则会读回旧水位。 */
export function resetBiasResetCache(): void {
  watermarkCache = null;
}

/** 丢弃「某模型在水位之前的」routing events（routing-telemetry 的形状）。 */
export function applyModelBiasReset<T extends { ts: number; modelId: string }>(
  events: readonly T[],
  watermarks: BiasResetWatermarks,
): T[] {
  if (watermarks.modelResets.size === 0) return [...events];
  return events.filter((event) => {
    const resetAt = watermarks.modelResets.get(event.modelId);
    return resetAt === undefined || event.ts >= resetAt;
  });
}

/** 丢弃「某模型在水位之前的」generation_job 行（断路器样本的形状）。 */
export function applyModelBiasResetToJobRows<T extends { model_id: string; created_at: Date | string | null }>(
  rows: readonly T[],
  watermarks: BiasResetWatermarks,
): T[] {
  if (watermarks.modelResets.size === 0) return [...rows];
  return rows.filter((row) => {
    const resetAt = watermarks.modelResets.get(row.model_id);
    if (resetAt === undefined) return true;
    const createdAt = toMs(row.created_at);
    return createdAt === null || createdAt >= resetAt;
  });
}
