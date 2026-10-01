// 执行侧可用性信号（2026-08-30 双账本收敛 Part 2：model-status 探测与执行同源）。
//
// 旧病：model-status 探「渠道 GET /models 可达」+「近 24h 交付」，而 worker 执行
// 靠「supplier_capability + supplier/account health_status + cooldown」——两套
// 可用性判据。渠道 /models 200 但账户 cooldown/disabled 时，探测报 available、
// 执行直接死（08-30 事故：AI 依据探测 rerun，worker 无可用供应商，任务排队 3 分钟
// 全 deadline_exceeded）。
//
// 这里把 worker 调度器（scheduler.ts withHealthyAccount）的同一把尺提到站点侧：
// 对每个模型查「是否存在 enabled、非 disabled、未冷却的 supplier，且其上有 enabled、
// 非 disabled、未冷却的 account 持有当前生效 capability」。无 → 执行侧没有可用
// 供应商，availability 必须压成 unavailable（无论 GET /models 怎么探）。
//
// 双模式：控制面（有 GENERATION_DATABASE_URL）直连 DB；Vercel（无 DB 端口）经
// GENERATION_CONTROL_PLANE_PROXY_ORIGIN 调控制面的 /api/internal/supplier-health
// 端点（HMAC 签名通道，复用 biz-key-sync 轮子）。两侧都读不通 → 空信号 fail-open，
// 由调用方维持原探测结果——遥测可以晚到，不可以把好的模型标死（与 balance signal
// 同纪律）。
//
// 只回可用/不可用 + 原因，绝不回显密钥。

import type { GenerationSql } from "./generation-core/database";
import { generationControlPlaneEnabled, getGenerationSql } from "./generation-core/database";
import { signBizKeySync } from "./biz-key-sync";

export interface SupplierHealthSignal {
  /** modelId -> 执行侧是否有可用供应商 */
  availableByModel: Record<string, boolean>;
  /** modelId -> 不可用原因（供 note 拼装） */
  reasonByModel: Record<string, string>;
  /**
   * key -> 成功證據（H4，向後相容：舊控制面/代理可能不帶，缺省 = 未知，調用方不得據此降級）。
   * available=true 只代表「前置條件過」，是否有真實成功證據看這裡。
   */
  evidenceByModel?: Record<string, SupplierEvidence>;
}

export interface SupplierEvidence {
  /** 該 key 下健康供應商的累計成功數。 */
  successCount: number;
  /** 最近一次成功（ISO），無則 null。 */
  lastSuccessAt: string | null;
  /** 供應商配置顯示餘額 <= 0。 */
  zeroBalance: boolean;
}

export type AvailabilityConfidence = "high" | "low" | "probe_only";

export const SUPPLIER_EVIDENCE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 有近期成功 = high；只有陳舊成功 = low；零樣本 = probe_only。 */
export function classifyEvidence(
  evidence: Pick<SupplierEvidence, "successCount" | "lastSuccessAt"> | undefined,
  nowMs: number = Date.now(),
): AvailabilityConfidence {
  if (!evidence || evidence.successCount <= 0) return "probe_only";
  const at = evidence.lastSuccessAt ? Date.parse(evidence.lastSuccessAt) : NaN;
  if (Number.isFinite(at) && nowMs - at <= SUPPLIER_EVIDENCE_WINDOW_MS) return "high";
  return "low";
}

const SIGNAL_TTL_MS = 60_000;
let cache: { expiresAt: number; signal: SupplierHealthSignal } | null = null;

export function __resetSupplierHealthSignalCacheForTests(): void {
  cache = null;
}

/**
 * 读控制面 supplier 健康信号（与 scheduler 的 withHealthyAccount 同判据，60s 缓存）。
 * 不可达/未配置 → 空信号（fail-open），调用方维持原裁决。
 */
export async function readSupplierHealthSignal(
  sql: GenerationSql = getGenerationSql(),
  options: { enabled?: boolean } = {},
): Promise<SupplierHealthSignal> {
  const enabled = options.enabled ?? generationControlPlaneEnabled();
  // 控制面侧（有 DB）直连；否则（Vercel 边缘无 DB 端口）走代理签名通道调控制面
  // 内部端点——代理函数内部自行处理 origin/secret 缺失时的 fail-open。
  if (!enabled) return fetchSupplierHealthViaProxy();
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.signal;

  const empty: SupplierHealthSignal = { availableByModel: {}, reasonByModel: {} };
  try {
    // 每个 (model, kind) 是否至少有一条「供应商+账户都健康未冷却」的当前能力。
    const rows = await sql<{
      public_model_id: string;
      kind: string;
      has_healthy: boolean;
      reason: string;
      success_count: string | number | null;
      last_success_at: string | Date | null;
      zero_balance: boolean | null;
    }[]>`
      SELECT cap.public_model_id AS public_model_id,
             cap.kind AS kind,
             bool_or(
               supplier.enabled
               AND supplier.health_status <> 'disabled'
               AND (supplier.cooldown_until IS NULL OR supplier.cooldown_until <= now())
               AND account.enabled
               AND account.health_status <> 'disabled'
               AND (account.cooldown_until IS NULL OR account.cooldown_until <= now())
             ) AS has_healthy,
             CASE
               WHEN NOT bool_or(
                 supplier.enabled
                 AND (supplier.cooldown_until IS NULL OR supplier.cooldown_until <= now())
               ) THEN '执行侧供应商冷却或禁用'
               WHEN NOT bool_or(
                 account.enabled
                 AND account.health_status <> 'disabled'
                 AND (account.cooldown_until IS NULL OR account.cooldown_until <= now())
               ) THEN '执行侧账户冷却或禁用'
               ELSE '执行侧无可用供应商'
             END AS reason,
             coalesce(sum(supplier.success_count), 0) AS success_count,
             max(supplier.last_success_at) AS last_success_at,
             coalesce(bool_and(
               supplier.configuration_json ->> 'balance' ~ '^-?[0-9]+(\\.[0-9]+)?$'
               AND (supplier.configuration_json ->> 'balance')::numeric <= 0
             ), false) AS zero_balance
      FROM supplier_capability cap
      JOIN supplier ON supplier.id = cap.supplier_id
      LEFT JOIN supplier_account account ON account.supplier_id = supplier.id
      WHERE cap.is_current AND cap.enabled
      GROUP BY cap.public_model_id, cap.kind
    `;
    const availableByModel: Record<string, boolean> = {};
    const reasonByModel: Record<string, string> = {};
    const evidenceByModel: Record<string, SupplierEvidence> = {};
    for (let row of rows) {
      const key = `${row.public_model_id}:${row.kind}`;
      const lastSuccess = row.last_success_at ? new Date(row.last_success_at).toISOString() : null;
      const prev = evidenceByModel[key];
      evidenceByModel[key] = {
        successCount: (prev?.successCount ?? 0) + Number(row.success_count ?? 0),
        lastSuccessAt: [prev?.lastSuccessAt ?? null, lastSuccess].filter(Boolean).sort().pop() ?? null,
        zeroBalance: prev ? prev.zeroBalance && Boolean(row.zero_balance) : Boolean(row.zero_balance),
      };
      // 餘額為 0 = 不可用（與渠道欠費同判），不論前置條件。
      if (row.zero_balance && row.has_healthy) {
        row = { ...row, has_healthy: false, reason: "渠道余额为 0，充值前不可用" };
      }
      // 同一模型多个 kind（image/video），取任一种可用即可（探测按端点分 media_type）。
      if (availableByModel[key] === undefined) {
        availableByModel[key] = Boolean(row.has_healthy);
        if (!row.has_healthy) reasonByModel[key] = row.reason;
      } else if (row.has_healthy) {
        availableByModel[key] = true;
        delete reasonByModel[key];
      }
    }
    const signal: SupplierHealthSignal = { availableByModel, reasonByModel, evidenceByModel };
    cache = { expiresAt: now + SIGNAL_TTL_MS, signal };
    return signal;
  } catch (error) {
    console.error("[supplier-health-signal] read failed (fail-open，不挡 model-status)", error);
    return empty;
  }
}

/**
 * 按渠道分组的判活读法（REQ-C2 统计视图用）。**与上面 readSupplierHealthSignal
 * 的判据逐字同源**（同一檔、同一组条件 = scheduler withHealthyAccount 的同一把尺），
 * 差别只有两点：
 *   1) 分组键是渠道（supplier.id）而不是模型；
 *   2) 保留诚实第三态——当前生效能力记录为 0 的渠道回 capabilities=0，
 *      判定权交调用方（statistics-projection 会画成 unknown），绝不猜成「健康」或「不可用」。
 * 只读 SELECT，一条写语句都没有。DB 不可达时抛错，由调用方决定降级（回空清单，不猜）。
 */
export interface SupplierChannelHealthRow {
  channel_id: string;
  label: string;
  /** 当前生效且启用的能力条数（count(DISTINCT) 抵掉 account 交叉积）。 */
  capabilities: string | number;
  /** 其中「供应商+账户都健康未冷却、且能力本身可用」的条数。 */
  schedulable_capabilities: string | number;
  reason: string;
  success_count: string | number;
  failure_count: string | number;
  last_success_at: string | null;
  last_failure_at: string | null;
}

export async function readSupplierChannelHealth(
  sql: GenerationSql = getGenerationSql(),
): Promise<SupplierChannelHealthRow[]> {
  return sql<SupplierChannelHealthRow[]>`
    SELECT supplier.id AS channel_id,
           supplier.label AS label,
           count(DISTINCT capability.id)
             FILTER (WHERE capability.is_current AND capability.enabled) AS capabilities,
           count(DISTINCT capability.id)
             FILTER (
               WHERE capability.is_current
                 AND capability.enabled
                 AND supplier.enabled
                 AND supplier.health_status <> 'disabled'
                 AND (supplier.cooldown_until IS NULL OR supplier.cooldown_until <= now())
                 AND account.enabled
                 AND account.health_status <> 'disabled'
                 AND (account.cooldown_until IS NULL OR account.cooldown_until <= now())
             ) AS schedulable_capabilities,
           CASE
             WHEN count(DISTINCT capability.id)
               FILTER (WHERE capability.is_current AND capability.enabled) = 0
               THEN '渠道无当前生效能力记录，账本无据可判'
             WHEN NOT (supplier.enabled
                       AND supplier.health_status <> 'disabled'
                       AND (supplier.cooldown_until IS NULL OR supplier.cooldown_until <= now()))
               THEN '执行侧供应商冷却或禁用'
             ELSE '执行侧账户冷却或禁用'
           END AS reason,
           supplier.success_count AS success_count,
           supplier.failure_count AS failure_count,
           supplier.last_success_at AS last_success_at,
           supplier.last_failure_at AS last_failure_at
    FROM supplier
    LEFT JOIN supplier_capability capability ON capability.supplier_id = supplier.id
    LEFT JOIN supplier_account account ON account.supplier_id = supplier.id
    GROUP BY supplier.id, supplier.label, supplier.enabled, supplier.health_status,
             supplier.cooldown_until, supplier.success_count, supplier.failure_count,
             supplier.last_success_at, supplier.last_failure_at
    ORDER BY supplier.id
  `;
}

const PROXY_TIMEOUT_MS = 15_000;

/**
 * Vercel 侧代理读取（无控制面 DB 端口）：经 GENERATION_CONTROL_PLANE_PROXY_ORIGIN
 * 调控制面 /image-control/api/internal/supplier-health（HMAC 签名，域 supplier-health）。
 * 未配置 origin/secret → 空信号 fail-open；任一失败 → 空信号（不挡 model-status）。
 */
async function fetchSupplierHealthViaProxy(): Promise<SupplierHealthSignal> {
  const empty: SupplierHealthSignal = { availableByModel: {}, reasonByModel: {} };
  const origin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/+$/, "");
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!origin || !secret) return empty;
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.signal;

  try {
    const rawBody = JSON.stringify({});
    const timestamp = String(now);
    const signature = signBizKeySync(secret, timestamp, rawBody, "supplier-health");
    const res = await fetch(`${origin}/image-control/api/internal/supplier-health`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Biz-Key-Sync-Timestamp": timestamp,
        "X-Biz-Key-Sync-Signature": signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[supplier-health-signal] proxy fetch failed status=${res.status} (fail-open)`);
      return empty;
    }
    const data = (await res.json().catch(() => null)) as { signal?: SupplierHealthSignal } | null;
    const signal = data?.signal ?? empty;
    cache = { expiresAt: now + SIGNAL_TTL_MS, signal };
    return signal;
  } catch (error) {
    console.error("[supplier-health-signal] proxy read failed (fail-open，不挡 model-status)", error);
    return empty;
  }
}