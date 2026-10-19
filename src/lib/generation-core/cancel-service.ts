// 生产平面门面 cancel()（docs/architecture/planes.md §3.2；V-01）：
// 「cancel + 条件退款」收在生产平面，分发路由只收 { cancelled, previousStatus, refund }，
// 不再自己触发帐本动作。
//
// 独立成档而非放进 job-repository.ts：billing-ledger 已 import job-repository，
// 反向 import 会形成循环依赖。
import { cancelGenerationJob } from "./job-repository";
import { refundGenerationBilling, type BillingRefundResult } from "./billing-ledger";
import type { GenerationJob, GenerationJobStatus } from "./types";

export type CancelGenerationJobWithRefundResult = {
  cancelled: boolean;
  previousStatus: GenerationJobStatus | null;
  // 只在退款已 applied 时非 null——不向客户端谎报退款已完成。
  refund: { amount: number; full: boolean } | null;
  // 未触发退款（未取消／前一态不需退款／billingAmount=0）时为 null。
  refundState: BillingRefundResult | null;
};

export type CancelServiceDeps = {
  cancel: typeof cancelGenerationJob;
  refund: typeof refundGenerationBilling;
};

const defaultDeps: CancelServiceDeps = {
  cancel: cancelGenerationJob,
  refund: refundGenerationBilling,
};

// existing：呼叫方在取消前读到的 job 快照（租户已校验、非终态），退款金额以它为准
// ——与搬迁前路由的语义一致（refund 基于取消前读取的 billingAmount）。
// 退款语义：
//   - queued / leased：reserve 已落地（已扣款）→ 全额退款；
//   - pending_billing：未扣款，无需退款；
//   - submitting / running：在飞 attempt 由 worker 丢弃，计费由 reconcileGenerationBilling 兜底。
export async function cancelGenerationJobWithRefund(
  id: string,
  tenantId: string,
  existing: GenerationJob,
  deps: CancelServiceDeps = defaultDeps,
): Promise<CancelGenerationJobWithRefundResult> {
  const result = await deps.cancel(id, tenantId);
  if (!result.cancelled) {
    // 读取后与 CAS 更新之间的竞态：job 已被并发终结（worker 完成/失败/退款）。
    return { cancelled: false, previousStatus: result.previousStatus, refund: null, refundState: null };
  }

  let refund: { amount: number; full: boolean } | null = null;
  let refundState: BillingRefundResult | null = null;
  if ((result.previousStatus === "queued" || result.previousStatus === "leased") && existing.billingAmount > 0) {
    const outcome = await deps.refund({ job: existing, executorId: `cancel:${tenantId}` });
    refundState = outcome;
    if (outcome === "applied") {
      refund = { amount: existing.billingAmount, full: true };
    } else {
      // pending/unknown/failed：退款 op 已落地（或冻结），由 reconcile 周期性
      // 重试兜底；不向客户端谎报退款已完成。
      console.error(`[generation-jobs] cancel refund not applied yet job=${id} state=${outcome}`);
    }
  }

  return { cancelled: true, previousStatus: result.previousStatus, refund, refundState };
}
