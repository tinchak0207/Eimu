// 同步直通路由的生產平面計費門面（V-07／V-08，2026-09-28）。
//
// 背景：/v1/images/edits（pixai 分支）、/v1/upscale、/v1/template-generations 與
// /api/pixai/{edit,upscale,template-generations} 是「同步直通上游」——沒有 worker、
// 沒有 durable job。它們原本直接呼叫 configuredGenerationBillingAdapter()／
// image-billing 扣退款，不留 billing_operation 列：退款失敗只剩一行日誌，
// reconcileGenerationBilling／retryStrandedRefundOperations 救不回來。
//
// 本門面讓這些路由的錢走 billing-ledger（唯一計費實作）：
//   reserveSyncCharge  → 建一條「同步 job」列（kind 合法、tenant 前綴 sync:，
//                        狀態 submitting＋租約，絕不進 queued）＋reserve op，
//                        經 reserveSyncGenerationBilling 做 claim／外部扣款／帳本雙寫。
//   commitSyncCharge   → 上游交付後：commit 實耗、未交付部分先落 pending refund op、
//                        job → succeeded；回傳「回應之後再執行」的外部退款。
//   refundSyncCharge   → 上游失敗：先落 pending refund op、job → failed；回傳外部退款。
// 外部退款失敗不吞：console.error，op 留在帳本（pending/unknown/failed），
// failed 終態由 reconcileGenerationBilling 每輪補退，succeeded 部分退款由
// retryStrandedRefundOperations 補退。
//
// 沒有 GENERATION_DATABASE_URL 的實例（Vercel 站點副本：/api/pixai/* 在那裡執行）
// 沒有帳本可寫——門面退回「直接經 billing adapter 扣退款」並如實標 ledger=false、
// 退款失敗 console.error。這是既有行為的保留，不是帳本化；見回報的阻塞點。

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
import type { FailureClass, GenerationJob } from "./types";

/** 同步 job 的租約：路由 maxDuration 300s＋餘裕。過期 → 既有 lease recovery 標 submit_unknown（錢凍結、probe 可見）。 */
const SYNC_LEASE_MS = 6 * 60_000;

export type SyncChargeKind = "image_edit" | "image_generate";

export interface SyncChargeInput {
  /** new-api users.id；0 = 應急 env key 沒帶 userId，無從計費。 */
  userId: number;
  /** 本次預扣的 quota 總額（已乘 n）。 */
  quota: number;
  /** 日誌與 job 追溯用的動作名，如 "images/edits"。 */
  action: string;
  /** 定價鍵（pixai-edit／pixai-upscale／pixai-template）。 */
  modelId: string;
  kind: SyncChargeKind;
  source: "biz" | "web";
  /** 原 tenant（biz:<keyId>／web:<userId>）；同步 job 落 `sync:` 前綴，不混進客戶的任務列表。 */
  tenantId: string;
  apiKeyId?: string | null;
  /** 只用於日誌（env 應急 key 的告警沿用原口徑）。 */
  keyId?: string;
  prompt?: string;
  requestedCount?: number;
  resolution?: string | null;
  ratio?: string | null;
}

export interface SyncCharge {
  /** 帳本 job id（ledger=true）或 relay 冪等鍵（ledger=false）；未扣費時為空字串。 */
  jobId: string;
  userId: number;
  /** 已扣的 quota；0 = 未扣（零價或無從計費的 key）。 */
  reservedQuota: number;
  requestedCount: number;
  action: string;
  /** 是否有 billing_operation 列。 */
  ledger: boolean;
}

export type SyncChargeResult =
  | { ok: true; charge: SyncCharge }
  | { ok: false; status: 402; message: string; body: unknown };

export interface SyncChargeDeps {
  sql?: GenerationSql;
  adapter?: GenerationBillingAdapter;
  /** 測試注入；缺省看 GENERATION_DATABASE_URL。 */
  databaseConfigured?: boolean;
  executorId?: string;
}

/** 回應送出後才跑的外部退款（放進 next/server 的 after）。永不拋錯。 */
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

/** 上游 HTTP 狀態 → failure_class（只用於 job 列的誠實歸類，不影響客戶回應）。 */
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
    `[sync-charge] GENERATION_DATABASE_URL 未配置：同步計費（首見 action=${action}）走 billing adapter 直扣，`
    + "不留 billing_operation 列（本實例無帳本）。",
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
 * 同步路由的預扣。失敗一律回 402 insufficient_quota（與舊 chargeBizRequest 同形同碼）。
 * quota<=0 或 userId=0（env 應急 key）不扣、不建 job，沿用原口徑。
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
      // 建單失敗時錢還沒動：回落直扣保可用性（與 quota-precheck「不可達回落」同一取捨），如實記錄。
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

  // 無帳本實例：relay 要求 job_id 長度 8..128，且用它做冪等鍵（沿用舊格式）。
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
      console.error(
        `[sync-charge] refund failed (no ledger) action=${charge.action} userId=${charge.userId} quota=${amount} jobId=${charge.jobId}`,
        error,
      );
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
          + "——op 留在 billing_operation，由 reconcile／stranded-refund 通道或人工對帳接手",
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
 * 上游交付後結算。`delivered` = 實際拿到的產出數；未交付部分按張退
 * （沿用舊口徑 round(quota/n*(n-delivered))）。帳本寫入在這裡同步完成，
 * 外部退款由回傳的 settlement 在回應後執行。永不拋錯（客戶已拿到結果）。
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
    // 先 commit 實耗、再落 pending refund、最後才標 succeeded：reconcile 對 succeeded
    // job 會補 commit 全額，順序反過來會把未交付部分也記成實耗。
    const consumed = job.billingAmount - unused;
    if (consumed > 0) await commitGenerationBilling(job, consumed, sql);
    if (unused > 0) await recordPendingGenerationRefund(job, unused, sql);
    await sql`
      UPDATE generation_job
      SET status = 'succeeded', completed_count = ${Math.max(0, outcome.delivered)},
          failure_class = NULL, failure_detail = NULL, finished_at = now(),
          lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = now()
      WHERE id = ${job.id} AND status = 'running'
    `;
    emitJobEvent({ jobId: job.id, event: "sync_job_succeeded", actor: executorOf(deps), detail: { action: charge.action, delivered: outcome.delivered, requested: n, consumed, refundDue: unused } }, sql);
  } catch (error) {
    console.error(`[sync-charge] commit bookkeeping failed action=${charge.action} job=${charge.jobId}`, error);
    return NOOP_SETTLEMENT;
  }
  return unused > 0 ? ledgerRefund(charge, unused, deps, sql) : NOOP_SETTLEMENT;
}

/**
 * 上游失敗：全額退。帳本（pending refund op + job failed）同步落地，外部退款由
 * 回傳的 settlement 在回應後執行。永不拋錯（不蓋掉更有用的上游錯誤）。
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
    await sql`
      UPDATE generation_job
      SET status = 'failed', failure_class = ${failureClass}, failure_detail = ${detail},
          finished_at = now(), lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
          updated_at = now()
      WHERE id = ${job.id} AND status = 'running'
    `;
    emitJobEvent({ jobId: job.id, event: JOB_EVENT.jobFailed, actor: executorOf(deps), upstreamRaw: detail, detail: { reason: "sync_upstream_failed", action: charge.action, httpStatus: failure.status, failureClass } }, sql);
  } catch (error) {
    // 帳本沒寫成也照樣嘗試外部退款：refundGenerationBilling 會自行補建 refund op。
    console.error(`[sync-charge] failure bookkeeping failed action=${charge.action} job=${charge.jobId}`, error);
  }
  return ledgerRefund(charge, charge.reservedQuota, deps, sql);
}
