// 生產平面門面 cancel()（docs/architecture/planes.md §3.2；V-01）：
// 「cancel + 條件退款」收在生產平面，分發路由只收 { cancelled, previousStatus, refund }，
// 不再自己觸發帳本動作。
//
// 獨立成檔而非放進 job-repository.ts：billing-ledger 已 import job-repository，
// 反向 import 會形成循環依賴。
import { cancelGenerationJob } from "./job-repository";
import { refundGenerationBilling, type BillingRefundResult } from "./billing-ledger";
import type { GenerationJob, GenerationJobStatus } from "./types";

export type CancelGenerationJobWithRefundResult = {
  cancelled: boolean;
  previousStatus: GenerationJobStatus | null;
  // 只在退款已 applied 時非 null——不向客戶端謊報退款已完成。
  refund: { amount: number; full: boolean } | null;
  // 未觸發退款（未取消／前一態不需退款／billingAmount=0）時為 null。
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

// existing：呼叫方在取消前讀到的 job 快照（租戶已校驗、非終態），退款金額以它為準
// ——與搬遷前路由的語義一致（refund 基於取消前讀取的 billingAmount）。
// 退款語義：
//   - queued / leased：reserve 已落地（已扣款）→ 全額退款；
//   - pending_billing：未扣款，無需退款；
//   - submitting / running：在飛 attempt 由 worker 丟棄，計費由 reconcileGenerationBilling 兜底。
export async function cancelGenerationJobWithRefund(
  id: string,
  tenantId: string,
  existing: GenerationJob,
  deps: CancelServiceDeps = defaultDeps,
): Promise<CancelGenerationJobWithRefundResult> {
  const result = await deps.cancel(id, tenantId);
  if (!result.cancelled) {
    // 讀取後與 CAS 更新之間的競態：job 已被並發終結（worker 完成/失敗/退款）。
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
      // pending/unknown/failed：退款 op 已落地（或凍結），由 reconcile 周期性
      // 重試兜底；不向客戶端謊報退款已完成。
      console.error(`[generation-jobs] cancel refund not applied yet job=${id} state=${outcome}`);
    }
  }

  return { cancelled: true, previousStatus: result.previousStatus, refund, refundState };
}
