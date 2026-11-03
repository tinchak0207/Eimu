import { ImageBillingGatewayError, ImageBillingRevertedError } from "@/lib/image-billing";
import { BillingRelayUnavailableError } from "../billing-relay";
import type { BillingReplayOperation, ReplayPlan } from "../operation-registry";
import type { FailureClass, GenerationJob } from "../types";

export type Row = Record<string, unknown>;
export type BillingOperation = "reserve" | "commit" | "refund";

export const EXECUTION_LEASE_MS = 45_000;
export const DEFAULT_RECONCILE_BATCH = 50;

// P0 止血（2026-08-28 域 E）：僵尸回收门槛。非终态卡在计费状态超过此时长的任务，
// 由 reconcile 强制对帐（该 refund 的 refund、确定性失败的终结），不再无限重试。
// P1 拆除 reserve 阻塞闸门后本段整体退役。
export const ZOMBIE_RECLAIM_MIN_AGE_MS_DEFAULT = 6 * 60 * 60 * 1000;
export const ZOMBIE_RECLAIM_BATCH = 100;

export type BillingFailureDisposition = "rejected" | "retry" | "unknown";
export type BillingRefundResult = "applied" | "pending" | "unknown" | "failed";
export function classifyBillingFailure(error: unknown): BillingFailureDisposition {
  if (error instanceof ImageBillingRevertedError) return "retry";
  if (error instanceof ImageBillingGatewayError) {
    if (error.status === 429) return "retry";
    if (error.status !== undefined && error.status >= 400 && error.status < 500) return "rejected";
  }
  // Timeouts, aborted requests, 5xx, invalid gateway JSON, and network failures
  // are all ambiguous: New API has no request idempotency contract for quota
  // adjustments, so a retry could apply the same debit/credit twice.
  return "unknown";
}

/**
 * H21（2026-11-04）：refund 专用分类。只在 classifyBillingFailure 之上加一条「确定未落地且可恢复」的口子：
 * 计费中继回 4xx 且**非中继 JSON**（BillingRelayUnavailableError：路由不存在／部署停用／边缘拦截）
 * ＝relay 函数根本没跑、new-api add_quota 一定没被调用 → 重放不可能双退，按 retry 走有上限退避
 * （billingRetryAt 5s·2^n 封顶 300s；预算＝operation-registry billing.refund，超预算 → failed 人工队列）。
 * 实证：job 2bc5aefd（2026-08-07）refund 遇中继 404 非 JSON 被判 rejected 永久 failed，1 币至今未退。
 * 刻意不放宽的：
 *  - 408 与 5xx/超时/网络（含非 JSON 502/504）：中继可能已执行 → 仍 unknown 冻结，绝不盲目重放；
 *  - 中继 JSON 业务拒绝（new-api 4xx，如用户不存在）：确定性 → 仍 rejected → failed 人工队列。
 * reserve 不用本函数：reserve 的 relay 故障维持「立即失败不扣费」（11-01 I-2 语义）。
 */
export function classifyRefundFailure(error: unknown): BillingFailureDisposition {
  if (
    error instanceof BillingRelayUnavailableError
    && error.status !== undefined
    && error.status >= 400
    && error.status < 500
    && error.status !== 408
  ) return "retry";
  return classifyBillingFailure(error);
}

export function billingRetryAt(error: unknown, attempt: number, now = new Date()): Date {
  if (error instanceof ImageBillingGatewayError && error.retryAfter) {
    const seconds = Number(error.retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return new Date(now.getTime() + seconds * 1000);
    const parsed = new Date(error.retryAfter);
    if (!Number.isNaN(parsed.getTime()) && parsed > now) return parsed;
  }
  return new Date(now.getTime() + Math.min(300_000, 5_000 * 2 ** Math.min(6, Math.max(0, attempt))));
}

export function detailOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

export function rejectedFailureClass(error: unknown): FailureClass {
  // 计费通道故障（relay 非 JSON / 平台错误头）≠ 余额不足：归 network（可重试的平台侧故障），
  // 不再因透传上游 402 被判 quota_exhausted 叫用户充值（2026-11-01 MCP 实测 I-2）。
  if (error instanceof BillingRelayUnavailableError) return "network";
  if (error instanceof ImageBillingGatewayError) {
    if (error.status === 402) return "quota_exhausted";
    if (error.status === 401 || error.status === 403) return "authentication";
  }
  return "unknown";
}

export function operationAmount(row: Row): number {
  return Number(row.amount ?? 0);
}

export function operationStatus(row: Row): string {
  return String(row.status ?? "");
}

export function operationAttempts(row: Row): number {
  return Number(row.attempt_count ?? 0);
}
/** 计费动作 → 封闭 registry 的动作键（FG-b：重放预算的唯一来源）。 */
export const BILLING_REPLAY_KEY: Record<BillingOperation, BillingReplayOperation> = {
  reserve: "billing.reserve",
  commit: "billing.commit",
  refund: "billing.refund",
};

export type BillingClaimOutcome =
  | { kind: "claimed"; row: Row }
  | { kind: "unavailable" }
  | { kind: "replay_denied"; plan: ReplayPlan };
export interface BillingReconciliationSummary {
  expiredUnknown: number;
  reservationAttempts: number;
  settlementAttempts: number;
  zombieReclaims: number;
  strandedRefundRetries: number;
}
export interface BillingOperationView {
  id: string;
  jobId: string;
  tenantId: string;
  modelId: string;
  operation: BillingOperation;
  amount: number;
  status: "pending" | "executing" | "applied" | "unknown" | "failed" | "needs_review";
  attemptCount: number;
  nextAttemptAt: Date;
  executionExpiresAt: Date | null;
  lastError: string | null;
  jobStatus: GenerationJob["status"];
  createdAt: Date;
  appliedAt: Date | null;
}
export type ManualBillingAction = "mark_applied" | "mark_failed" | "retry";
export type SyncReserveOutcome =
  | { status: "applied"; job: GenerationJob }
  | { status: "rejected"; job: GenerationJob; error: unknown }
  | { status: "unknown"; job: GenerationJob; error: unknown };
