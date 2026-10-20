import { LEDGER_POOL_DEFAULT, isLedgerPool } from "../subscription-sku";
import { quotaToCoins } from "../statistics-projection";
import type { AccountBalance, LedgerDirection, LedgerEntry, LedgerEntryDraft, LedgerEntryType } from "./types";

/**
 * 每个 entry_type 的法定方向。`signed` = 加减皆可（基线可为负；人工调整两个方向
 * 都是合法更正）。这张表是「余额模型」的单一权威，不得在别处另立第二份判别。
 */
export const LEDGER_ENTRY_DIRECTION: Record<LedgerEntryType, LedgerDirection | "signed"> = {
  opening: "signed",
  recharge: "credit",
  consumption: "debit",
  refund: "credit",
  transfer_in: "credit",
  transfer_out: "debit",
  adjustment: "signed",
  expire: "debit",
};

/** 会计恒等式用的方向分类：opening/adjustment 按实际符号判。 */
export function ledgerDirectionOf(entryType: LedgerEntryType, amount: number): LedgerDirection {
  const fixed = LEDGER_ENTRY_DIRECTION[entryType];
  if (fixed === "credit") return "credit";
  if (fixed === "debit") return "debit";
  return amount >= 0 ? "credit" : "debit";
}

// ─────────────────────────────────────────── 纯函式：契约检查与余额

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

/**
 * 帐本行契约（纯函式，可单独测）：方向、来源、幂等键、金额。
 * 回 null = 可入帐；回字串 = 拒收原因。
 *
 * 金额 0 的唯一例外是 `opening`：0 基线是一句真话（「此刻这个身份没有可入帐的历史
 * 净额」），且它定下「哪一刻之后的充值才该入帐」的时间界线。其余类型 0 一律拒收。
 */
export function validateLedgerEntryDraft(draft: LedgerEntryDraft): string | null {
  if (!isFiniteInteger(draft.billingUserId) || draft.billingUserId <= 0) {
    return `billing_user_id 必须是正整数（收到 ${String(draft.billingUserId)}）`;
  }
  if (!isFiniteInteger(draft.amount)) {
    return `amount 必须是整数 quota（收到 ${String(draft.amount)}）`;
  }
  if (draft.amount === 0 && draft.entryType !== "opening") {
    return `amount 0 只允许出现在 opening 基线（${draft.entryType} 的 0 是空帐）`;
  }
  const direction = LEDGER_ENTRY_DIRECTION[draft.entryType];
  if (direction === undefined) return `未知的 entry_type：${String(draft.entryType)}`;
  if (direction === "credit" && draft.amount < 0) {
    return `${draft.entryType} 是加项，不得为负（收到 ${draft.amount}）`;
  }
  if (direction === "debit" && draft.amount > 0) {
    return `${draft.entryType} 是减项，不得为正（收到 ${draft.amount}）`;
  }
  if (!draft.source.trim()) return "source 必填（哪个写入器记的帐）";
  if (!draft.sourceRef.trim()) return "source_ref 必填（这笔帐指回哪一件外部事实）";
  if (!draft.idempotencyRef.trim()) return "idempotency_ref 必填（重放不得双算）";
  // 池维度契约（REQ-D3）：池值必须合法；订阅池的每一列必须带期次与到期时刻——
  // 没有这两个栏位，读取端就只能靠定时任务改余额（违反「过期只在读取时 lazy 判定」）。
  if (draft.pool !== undefined && !isLedgerPool(draft.pool)) {
    return `未知的 pool：${String(draft.pool)}`;
  }
  const pool = draft.pool ?? LEDGER_POOL_DEFAULT;
  if (pool === "subscription") {
    if (typeof draft.termRef !== "string" || !draft.termRef.trim()) {
      return "订阅池的帐本行必须带 term_ref（期次身份）";
    }
    if (typeof draft.expiresAt !== "string" || !Number.isFinite(Date.parse(draft.expiresAt))) {
      return `订阅池的帐本行必须带可解析的 expires_at（收到 ${String(draft.expiresAt)}）`;
    }
  }
  return null;
}

/**
 * 余额公式（唯一口径）：Σ amount。同一份帐本记录集在任何地方只能算出一个数字。
 * 非有限值整行跳过并回报（跳过的笔数计进 skippedRows——不当 0 加、不静默吞）。
 */
export function computeAccountBalance(
  entries: LedgerEntry[],
  billingUserId?: number,
): AccountBalance & { skippedRows: number } {
  const rows = billingUserId === undefined ? entries : entries.filter((entry) => entry.billingUserId === billingUserId);
  let quota = 0;
  let credits = 0;
  let debits = 0;
  let skippedRows = 0;
  const byType: AccountBalance["byType"] = {};
  for (const row of rows) {
    if (!Number.isFinite(row.amount)) {
      skippedRows += 1;
      continue;
    }
    quota += row.amount;
    if (ledgerDirectionOf(row.entryType, row.amount) === "credit") credits += row.amount;
    else debits += row.amount;
    const bucket = byType[row.entryType] ?? { quota: 0, entries: 0 };
    bucket.quota += row.amount;
    bucket.entries += 1;
    byType[row.entryType] = bucket;
  }
  return {
    billingUserId: billingUserId ?? Number.NaN,
    quota,
    coins: quotaToCoins(quota),
    credits,
    debits,
    entryCount: rows.length - skippedRows,
    byType,
    skippedRows,
  };
}

/**
 * 对外余额读取口的回应形体（`/v1/quota` 的契约）：与 2026-08-29 事故后定下的形状
 * **逐字相同**（success / balance_coins / currency）——本刀改的是数字的来源，不是形状。
 * 放在这里是为了让「契约」有一条可被真实断言的路径（路由只负责包 NextResponse）。
 * 币值换算沿用 statistics-projection 的 quotaToCoins（同一条换算式，不另立第二份）。
 */
export const QUOTA_RESPONSE_CURRENCY = "coins";

export function quotaResponseBody(quota: number): { success: true; balance_coins: number; currency: string } {
  return { success: true, balance_coins: quotaToCoins(quota), currency: QUOTA_RESPONSE_CURRENCY };
}

// ─────────────────────────────────────────── 纯函式：契约检查（幂等键）

/** 写入器用的幂等键约定（单一权威，别处不得自拼）。 */
export const ledgerRef = {
  opening: (userId: number) => `seed:${userId}:v1`,
  consumption: (operationId: string) => `billing-op:${operationId}:debit`,
  refund: (operationId: string) => `billing-op:${operationId}:credit`,
  /** 非首条出资腿/退款腿的幂等键（首条永远用上面那两个，维持既有帐本行的键不变）。 */
  consumptionLeg: (operationId: string, legIndex: number) => `billing-op:${operationId}:debit:${legIndex}`,
  refundLeg: (operationId: string, legIndex: number) => `billing-op:${operationId}:credit:${legIndex}`,
  transferOut: (transferId: string) => `transfer:${transferId}:out`,
  transferIn: (transferId: string) => `transfer:${transferId}:in`,
  recharge: (redemptionId: string | number) => `redemption:${String(redemptionId)}`,
  /** 基线冲销腿：充值发生在开户基线之前（金额已含在 opening 内）时的对冲行（见 ingest）。 */
  rechargeBaselineOffset: (redemptionId: string | number) => `redemption:${String(redemptionId)}:opening-offset`,
  adjustment: (sourceRef: string) => `adjustment:${sourceRef}`,
  /** REQ-D3 期次发放幂等键：(订阅 id, 期次序号)（不变量 ③）。 */
  subscriptionTerm: (subscriptionId: string, termIndex: number) => `subscription:${subscriptionId}:term:${termIndex}`,
  /** 续期替换（把上一期未用完余额作废）的幂等键。 */
  subscriptionReplace: (subscriptionId: string, termIndex: number) => `subscription:${subscriptionId}:term:${termIndex}:replace`,
  /**
   * 音乐生成按次扣费的幂等键（chargeId = `music:<keyId>:<ref>`，见 lib/music-charge.ts）。
   * 音乐没有 generation_job，也就没有 billing_operation.id ⇒ 不能沿用 consumption(operationId)
   * 那条键；这里给音乐单独一个约定（幂等键是单一权威，别处不得自拼）。
   */
  musicCharge: (chargeId: string) => `music-charge:${chargeId}:debit`,
} as const;

/** 现金通道（mPay 真实单）的帐本来源：投影层据此把该行计入「付费」。 */
export const REDEMPTION_CASH_SOURCE = "redemption-sync";
/**
 * 人工发码 / 赠送码的帐本来源。**必须**命中 statistics-projection 的
 * NON_CASH_RECHARGE_SOURCE（`gift`）——人工码没有外部现金流入，记成现金＝谎报营收。
 */
export const REDEMPTION_MANUAL_SOURCE = "gift-manual-code";
/** 基线冲销腿的来源（净额 0，两条腿成对，永不单独出现在帐上）。 */
export const REDEMPTION_BASELINE_OFFSET_SOURCE = "opening-offset";
