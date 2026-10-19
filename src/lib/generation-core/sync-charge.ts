// 同步直通路由的生产平面计费门面（V-07／V-08，2026-09-28）。
//
// 背景：/v1/images/edits（pixai 分支）、/v1/upscale、/v1/template-generations 与
// /api/pixai/{edit,upscale,template-generations} 是「同步直通上游」——没有 worker、
// 没有 durable job。它们原本直接呼叫 configuredGenerationBillingAdapter()／
// image-billing 扣退款，不留 billing_operation 列：退款失败只剩一行日志，
// reconcileGenerationBilling／retryStrandedRefundOperations 救不回来。
//
// 本门面让这些路由的钱走 billing-ledger（唯一计费实作）：
//   reserveSyncCharge  → 建一条「同步 job」列（kind 合法、tenant 前缀 sync:，
//                        状态 submitting＋租约，绝不进 queued）＋reserve op，
//                        经 reserveSyncGenerationBilling 做 claim／外部扣款／帐本双写。
//   commitSyncCharge   → 上游交付后：commit 实耗、未交付部分先落 pending refund op、
//                        job → succeeded；回传「回应之后再执行」的外部退款。
//   refundSyncCharge   → 上游失败：先落 pending refund op、job → failed；回传外部退款。
// 外部退款失败不吞：console.error，op 留在帐本（pending/unknown/failed），
// failed 终态由 reconcileGenerationBilling 每轮补退，succeeded 部分退款由
// retryStrandedRefundOperations 补退。
//
// 没有 GENERATION_DATABASE_URL 的实例（Vercel 站点副本：/api/pixai/* 在那里执行）
// 没有帐本可写——门面退回「直接经 billing adapter 扣退款」并如实标 ledger=false、
// 退款失败 console.error。这是既有行为的保留，不是帐本化；见回报的阻塞点。

import { createHash, randomUUID } from "node:crypto";
import { configuredGenerationBillingAdapter, type GenerationBillingAdapter } from "./billing-relay";
import {
  commitGenerationBilling,
  recordPendingGenerationRefund,
  refundGenerationBilling,
  reserveSyncGenerationBilling,
} from "./billing-ledger";
import { encryptGenerationPrompt } from "./crypto";
import { generationDatabaseConfigured, getGenerationSql, type GenerationSql } from "./database";
import { JOB_EVENT, emitJobEvent } from "./job-events";
import { getGenerationJob, mapGenerationJob } from "./job-repository";
import type { FailureClass, GenerationJob, GenerationJobStatus } from "./types";

/** 同步 job 的租约：路由 maxDuration 300s＋余裕。过期 → 既有 lease recovery 标 submit_unknown（钱冻结、probe 可见）。 */
const SYNC_LEASE_MS = 6 * 60_000;

export type SyncChargeKind = "image_edit" | "image_generate";

export interface SyncChargeInput {
  /** new-api users.id；0 = 应急 env key 没带 userId，无从计费。 */
  userId: number;
  /** 本次预扣的 quota 总额（已乘 n）。 */
  quota: number;
  /** 日志与 job 追溯用的动作名，如 "images/edits"。 */
  action: string;
  /** 定价键（pixai-edit／pixai-upscale／pixai-template）。 */
  modelId: string;
  kind: SyncChargeKind;
  source: "biz" | "web";
  /** 原 tenant（biz:<keyId>／web:<userId>）；同步 job 落 `sync:` 前缀，不混进客户的任务列表。 */
  tenantId: string;
  apiKeyId?: string | null;
  /** 只用于日志（env 应急 key 的告警沿用原口径）。 */
  keyId?: string;
  prompt?: string;
  requestedCount?: number;
  resolution?: string | null;
  ratio?: string | null;
}

export interface SyncCharge {
  /** 帐本 job id（ledger=true）或 relay 幂等键（ledger=false）；未扣费时为空字串。 */
  jobId: string;
  userId: number;
  /** 已扣的 quota；0 = 未扣（零价或无从计费的 key）。 */
  reservedQuota: number;
  requestedCount: number;
  action: string;
  /** 是否有 billing_operation 列。 */
  ledger: boolean;
  /**
   * 无帐本退款失败时停在 billing_unknown（未决），不得当成退款成功。
   * 有帐本时终态以 generation_job.status 为准。
   */
  status?: GenerationJobStatus;
}

export type SyncChargeResult =
  | { ok: true; charge: SyncCharge }
  | { ok: false; status: 402; message: string; body: unknown };

export interface SyncChargeDeps {
  sql?: GenerationSql;
  adapter?: GenerationBillingAdapter;
  /** 测试注入；缺省看 GENERATION_DATABASE_URL。 */
  databaseConfigured?: boolean;
  executorId?: string;
}

/** 回应送出后才跑的外部退款（放进 next/server 的 after）。永不抛错。 */
export type SyncSettlement = () => Promise<void>;

const NOOP_SETTLEMENT: SyncSettlement = async () => undefined;

function executorOf(deps: SyncChargeDeps): string {
  return deps.executorId ?? `sync:${process.pid}`;
}

function ledgerEnabled(deps: SyncChargeDeps): boolean {
  return deps.sql !== undefined || (deps.databaseConfigured ?? generationDatabaseConfigured());
}

function insufficientQuota(message: string): SyncChargeResult {
  return {
    ok: false,
    status: 402,
    message,
    body: { error: { message, type: "insufficient_quota", code: "insufficient_quota" } },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Billing failed.";
}

/** 上游 HTTP 状态 → failure_class（只用于 job 列的诚实归类，不影响客户回应）。 */
export function syncFailureClass(status: number): FailureClass {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "authentication";
  if (status === 402) return "quota_exhausted";
  if (status >= 400 && status < 500) return "user_input";
  if (status === 503) return "overloaded";
  return "upstream_protocol";
}

let fallbackWarned = false;
function warnFallbackOnce(action: string): void {
  if (fallbackWarned) return;
  fallbackWarned = true;
  console.warn(
    `[sync-charge] GENERATION_DATABASE_URL 未配置：同步计费（首见 action=${action}）走 billing adapter 直扣，`
    + "不留 billing_operation 列（本实例无帐本）。",
  );
}

async function createSyncJob(input: SyncChargeInput, sql: GenerationSql): Promise<GenerationJob> {
  const id = randomUUID();
  const requestedCount = Math.max(1, input.requestedCount ?? 1);
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ sync: input.action, modelId: input.modelId, quota: input.quota, requestedCount }))
    .digest("hex");
  const workflow = { syncAction: input.action };
  return sql.begin(async (tx) => {
    const rows = await tx<Record<string, unknown>[]>`
      INSERT INTO generation_job (
        id, tenant_id, api_key_id, billing_user_id, source, idempotency_key, request_hash,
        kind, routing_class, model_id, ratio, resolution, prompt_ciphertext, workflow_json,
        response_format, status, requested_count, billing_amount, deadline_at,
        lease_owner, lease_expires_at, heartbeat_at, started_at
      ) VALUES (
        ${id}, ${`sync:${input.tenantId}`}, ${input.apiKeyId ?? null}, ${input.userId}, ${input.source},
        NULL, ${requestHash}, ${input.kind}, 'generic', ${input.modelId}, ${input.ratio ?? null},
        ${input.resolution ?? null}, ${encryptGenerationPrompt(input.prompt ?? "")},
        ${tx.json(workflow as never)}, 'url', 'submitting', ${requestedCount}, ${input.quota},
        now() + (${String(SYNC_LEASE_MS)}::text || ' milliseconds')::interval,
        ${`sync:${process.pid}`}, now() + (${String(SYNC_LEASE_MS)}::text || ' milliseconds')::interval,
        now(), now()
      )
      RETURNING *
    `;
    await tx`
      INSERT INTO billing_operation (id, job_id, operation, amount, status, idempotency_ref)
      VALUES (${randomUUID()}, ${id}, 'reserve', ${input.quota}, 'pending', ${`generation:${id}:reserve:1`})
    `;
    return mapGenerationJob(rows[0]);
  });
}

/**
 * 同步路由的预扣。失败一律回 402 insufficient_quota（与旧 chargeBizRequest 同形同码）。
 * quota<=0 或 userId=0（env 应急 key）不扣、不建 job，沿用原口径。
 */
export async function reserveSyncCharge(input: SyncChargeInput, deps: SyncChargeDeps = {}): Promise<SyncChargeResult> {
  const requestedCount = Math.max(1, input.requestedCount ?? 1);
  const free = { ok: true as const, charge: { jobId: "", userId: input.userId, reservedQuota: 0, requestedCount, action: input.action, ledger: false } };
  if (input.quota <= 0) return free;
  if (!input.userId) {
    console.warn(
      `[pixai-proxy] uncharged request action=${input.action} keyId=${input.keyId ?? "-"} quota=${input.quota}`
      + " reason=env_fallback_key_without_user_id",
    );
    return free;
  }

  const adapter = deps.adapter ?? configuredGenerationBillingAdapter();
  if (ledgerEnabled(deps)) {
    const sql = deps.sql ?? getGenerationSql();
    let job: GenerationJob | null = null;
    try {
      job = await createSyncJob(input, sql);
    } catch (error) {
      // 建单失败时钱还没动：回落直扣保可用性（与 quota-precheck「不可达回落」同一取舍），如实记录。
      console.error(`[sync-charge] ledger job creation failed action=${input.action}; falling back to direct billing`, error);
    }
    if (job) {
      try {
        const outcome = await reserveSyncGenerationBilling({ job, executorId: executorOf(deps), adapter }, sql);
        if (outcome.status === "applied") {
          return { ok: true, charge: { jobId: job.id, userId: input.userId, reservedQuota: input.quota, requestedCount, action: input.action, ledger: true } };
        }
        return insufficientQuota(messageOf(outcome.error));
      } catch (error) {
        console.error(`[sync-charge] ledger reserve failed action=${input.action} job=${job.id}`, error);
        return insufficientQuota(messageOf(error));
      }
    }
  } else {
    warnFallbackOnce(input.action);
  }

  // 无帐本实例：relay 要求 job_id 长度 8..128，且用它做幂等键（沿用旧格式）。
  const jobId = `pixai-${input.action.replace(/[^a-z0-9]+/gi, "-")}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await adapter.reserve({ jobId, operation: "reserve", userId: input.userId, amount: input.quota });
    return { ok: true, charge: { jobId, userId: input.userId, reservedQuota: input.quota, requestedCount, action: input.action, ledger: false } };
  } catch (error) {
    return insufficientQuota(messageOf(error));
  }
}

function directRefund(charge: SyncCharge, amount: number, deps: SyncChargeDeps): SyncSettlement {
  return async () => {
    try {
      await (deps.adapter ?? configuredGenerationBillingAdapter()).refund({
        jobId: charge.jobId,
        operation: "refund",
        userId: charge.userId,
        amount,
      });
    } catch (error) {
      charge.status = "billing_unknown";
      console.error(
        `[sync-charge] refund failed (no ledger) action=${charge.action} userId=${charge.userId} quota=${amount} jobId=${charge.jobId} status=billing_unknown`,
        error,
      );
      throw error;
    }
  };
}

function ledgerRefund(charge: SyncCharge, amount: number, deps: SyncChargeDeps, sql: GenerationSql): SyncSettlement {
  return async () => {
    try {
      const job = await getGenerationJob(charge.jobId, sql);
      if (!job) throw new Error(`Sync job ${charge.jobId} disappeared before refund.`);
      const result = await refundGenerationBilling({ job, amount, executorId: executorOf(deps), adapter: deps.adapter }, sql);
      if (result !== "applied") {
        console.error(
          `[sync-charge] refund ${result} action=${charge.action} userId=${charge.userId} quota=${amount} job=${charge.jobId}`
          + "——op 留在 billing_operation，由 reconcile／stranded-refund 通道或人工对帐接手",
        );
      }
    } catch (error) {
      console.error(
        `[sync-charge] refund threw action=${charge.action} userId=${charge.userId} quota=${amount} job=${charge.jobId}`,
        error,
      );
    }
  };
}

/**
 * 上游交付后结算。`delivered` = 实际拿到的产出数；未交付部分按张退
 * （沿用旧口径 round(quota/n*(n-delivered))）。帐本写入在这里同步完成，
 * 外部退款由回传的 settlement 在回应后执行。永不抛错（客户已拿到结果）。
 */
export async function commitSyncCharge(
  charge: SyncCharge,
  outcome: { delivered: number },
  deps: SyncChargeDeps = {},
): Promise<SyncSettlement> {
  if (!charge.reservedQuota || !charge.jobId || !charge.userId) return NOOP_SETTLEMENT;
  const n = charge.requestedCount;
  const unused = Math.max(0, Math.round((charge.reservedQuota / n) * (n - outcome.delivered)));
  if (!charge.ledger) return unused > 0 ? directRefund(charge, unused, deps) : NOOP_SETTLEMENT;

  const sql = deps.sql ?? getGenerationSql();
  try {
    const job = await getGenerationJob(charge.jobId, sql);
    if (!job) throw new Error(`Sync job ${charge.jobId} not found.`);
    // 先 commit 实耗、再落 pending refund、最后才标 succeeded：reconcile 对 succeeded
    // job 会补 commit 全额，顺序反过来会把未交付部分也记成实耗。
    const consumed = job.billingAmount - unused;
    if (consumed > 0) await commitGenerationBilling(job, consumed, sql);
    if (unused > 0) await recordPendingGenerationRefund(job, unused, sql);
    const updated = await sql<{ id: string }[]>`
      UPDATE generation_job
      SET status = 'succeeded', completed_count = ${Math.max(0, outcome.delivered)},
          failure_class = NULL, failure_detail = NULL, finished_at = now(),
          lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = now()
      WHERE id = ${job.id} AND status IN ('submitting', 'running')
      RETURNING id
    `;
    if (!updated[0]) {
      console.error(
        `[sync-charge] terminal update matched 0 rows action=${charge.action} job=${charge.jobId} expected status submitting|running; not treating as succeeded`,
      );
      return NOOP_SETTLEMENT;
    }
    emitJobEvent({ jobId: job.id, event: "sync_job_succeeded", actor: executorOf(deps), detail: { action: charge.action, delivered: outcome.delivered, requested: n, consumed, refundDue: unused } }, sql);
  } catch (error) {
    console.error(`[sync-charge] commit bookkeeping failed action=${charge.action} job=${charge.jobId}`, error);
    return NOOP_SETTLEMENT;
  }
  return unused > 0 ? ledgerRefund(charge, unused, deps, sql) : NOOP_SETTLEMENT;
}

/**
 * 上游失败：全额退。帐本（pending refund op + job failed）同步落地，外部退款由
 * 回传的 settlement 在回应后执行。永不抛错（不盖掉更有用的上游错误）。
 */
export async function refundSyncCharge(
  charge: SyncCharge,
  failure: { status: number; detail?: string },
  deps: SyncChargeDeps = {},
): Promise<SyncSettlement> {
  if (!charge.reservedQuota || !charge.jobId || !charge.userId) return NOOP_SETTLEMENT;
  if (!charge.ledger) return directRefund(charge, charge.reservedQuota, deps);

  const sql = deps.sql ?? getGenerationSql();
  const failureClass = syncFailureClass(failure.status);
  const detail = (failure.detail ?? `Upstream ${charge.action} failed with HTTP ${failure.status}.`).slice(0, 2000);
  try {
    const job = await getGenerationJob(charge.jobId, sql);
    if (!job) throw new Error(`Sync job ${charge.jobId} not found.`);
    await recordPendingGenerationRefund(job, job.billingAmount, sql);
    const updated = await sql<{ id: string }[]>`
      UPDATE generation_job
      SET status = 'failed', failure_class = ${failureClass}, failure_detail = ${detail},
          finished_at = now(), lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
          updated_at = now()
      WHERE id = ${job.id} AND status IN ('submitting', 'running')
      RETURNING id
    `;
    if (!updated[0]) {
      console.error(
        `[sync-charge] terminal update matched 0 rows action=${charge.action} job=${charge.jobId} expected status submitting|running; not treating as failed`,
      );
      return NOOP_SETTLEMENT;
    }
    emitJobEvent({ jobId: job.id, event: JOB_EVENT.jobFailed, actor: executorOf(deps), upstreamRaw: detail, detail: { reason: "sync_upstream_failed", action: charge.action, httpStatus: failure.status, failureClass } }, sql);
  } catch (error) {
    // 帐本没写成也照样尝试外部退款：refundGenerationBilling 会自行补建 refund op。
    console.error(`[sync-charge] failure bookkeeping failed action=${charge.action} job=${charge.jobId}`, error);
  }
  return ledgerRefund(charge, charge.reservedQuota, deps, sql);
}
