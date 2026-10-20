import { LEDGER_POOL_DEFAULT, computePoolBalances, planConsumptionLegs, planRefundLegs, poolOf, subscriptionTermRef, type ConsumedPoolLeg, type LedgerPool } from "../subscription-sku";
import { getGenerationSql } from "../database";
import { ensureOpeningBeforeWrite } from "./opening";
import { REDEMPTION_CASH_SOURCE, ledgerRef } from "./schema";
import { accountLedgerStoreEnabled, postLedgerEntries, readAccountLedger } from "./storage";
import type { LedgerEntryDraft, LedgerWriterDeps, PendingWriteOutcome } from "./types";

// ─────────────────────────────────────────── 写入器（各钱路径呼叫）

async function withOpeningGuard(
  billingUserIds: number[],
  drafts: LedgerEntryDraft[],
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  if (!accountLedgerStoreEnabled() && !deps.sql) return { posted: false, reason: "帐本储存层未配置" };
  const sql = deps.sql ?? getGenerationSql();
  try {
    if (!(await ensureOpeningBeforeWrite(billingUserIds, sql, deps.fetchUser))) {
      return { posted: false, reason: "基线不可得，放弃记帐（对帐报告负责）" };
    }
    const result = await postLedgerEntries(drafts, { sql });
    if (result.errors.length > 0) return { posted: false, reason: result.errors[0] };
    if (result.rejected.length > 0) return { posted: false, reason: result.rejected[0].reason };
    return { posted: result.inserted.length > 0, reason: result.duplicates.length > 0 ? "已记过（重放）" : undefined };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[account-ledger] 帐本写入异常（不挡钱路）：${reason}`);
    return { posted: false, reason };
  }
}

/** 消费扣费（legacy reserve 的上游扣款、gate path 投影扣款）。amount 取正数入帐为减项。
 *
 * REQ-D3：扣款**按池拆腿**（预设先扣订阅池、再扣永久池，见 CONSUMPTION_POOL_ORDER）。
 * 没有任何订阅资料时，只有一条永久池腿、幂等键与 020 期间逐字相同（行为零变化）。
 * 读帐本失败＝回退单一永久池腿：记帐永不挡钱路，池归属的缺口由对帐报告指出。
 */
export async function recordConsumption(
  input: {
    billingUserId: number;
    amountQuota: number;
    jobId: string;
    operationId: string;
    source: string;
    /** 指定扣款池（省略＝按 CONSUMPTION_POOL_ORDER 自动选）。 */
    pool?: LedgerPool;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.abs(Math.round(input.amountQuota));
  if (amount === 0) return { posted: false, reason: "金额为 0，无帐可记" };
  const legs = await resolveConsumptionLegs(input.billingUserId, amount, input.pool, deps);
  const drafts: LedgerEntryDraft[] = legs.map((leg, index) => {
    const primary = legs.length === 1;
    return {
      billingUserId: input.billingUserId,
      entryType: "consumption" as const,
      amount: -leg.amountQuota,
      source: input.source,
      sourceRef: `billing-op:${input.operationId}`,
      idempotencyRef: primary ? ledgerRef.consumption(input.operationId) : ledgerRef.consumptionLeg(input.operationId, index + 1),
      pool: leg.pool,
      termRef: leg.termRef,
      expiresAt: leg.expiresAt,
      jobId: input.jobId,
      operationId: input.operationId,
      metadata: { amount_quota_abs: leg.amountQuota, pool_legs: legs.length, pool_leg_index: index + 1 },
    };
  });
  return withOpeningGuard([input.billingUserId], drafts, deps);
}

/**
 * 订阅池的「当前期」：未过期的期中最早到期的那一期（先到期先扣）。
 * 纯读帐本；拿不到就回 null（呼叫端据此不指定期次，不制造无效的订阅帐本行）。
 */
async function resolveConsumptionLegs(
  billingUserId: number,
  amountQuota: number,
  forcedPool: LedgerPool | undefined,
  deps: LedgerWriterDeps,
): Promise<{ pool: LedgerPool; termRef: string | null; expiresAt: string | null; amountQuota: number }[]> {
  const permanentOnly = [{ pool: LEDGER_POOL_DEFAULT, termRef: null, expiresAt: null, amountQuota }];
  if (!accountLedgerStoreEnabled() && !deps.sql) return permanentOnly;
  if (forcedPool === "permanent") return permanentOnly;
  try {
    const balances = computePoolBalances(await readAccountLedger(billingUserId, deps), Date.now());
    const planned = planConsumptionLegs(amountQuota, balances);
    const legs = forcedPool === "subscription" ? planned.filter((leg) => leg.pool === "subscription") : planned;
    if (legs.length === 0) return permanentOnly;
    return legs.map((leg) => ({ ...leg }));
  } catch (error) {
    console.error(
      `[account-ledger] 池余额读取失败，本次消费记在永久池 user=${billingUserId}：${error instanceof Error ? error.message : String(error)}`,
    );
    return permanentOnly;
  }
}

/** 退款入帐（billing_operation refund applied 对应的上游 credit）。
 *
 * REQ-D3 **按原出资归还**：退款回到原本出资的池——订阅消耗退订阅池、永久消耗退永久池，
 * 不跨池搬。出资腿的事实来自帐本本身的消费行（不是重算一遍计划，避免两处口径漂移）。
 */
export async function recordRefund(
  input: {
    billingUserId: number;
    amountQuota: number;
    jobId: string;
    operationId: string;
    source: string;
    /** 帐本没有该 operation 的消费行时（历史资料）的兜底池。 */
    pool?: LedgerPool;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.abs(Math.round(input.amountQuota));
  if (amount === 0) return { posted: false, reason: "金额为 0，无帐可记" };
  const legs = await resolveRefundLegs(input, amount, deps);
  const drafts: LedgerEntryDraft[] = legs.map((leg, index) => {
    const primary = legs.length === 1;
    return {
      billingUserId: input.billingUserId,
      entryType: "refund" as const,
      amount: leg.amountQuota,
      source: input.source,
      sourceRef: `billing-op:${input.operationId}`,
      idempotencyRef: primary ? ledgerRef.refund(input.operationId) : ledgerRef.refundLeg(input.operationId, index + 1),
      pool: leg.pool,
      termRef: leg.termRef,
      expiresAt: leg.expiresAt,
      jobId: input.jobId,
      operationId: input.operationId,
      metadata: { amount_quota_abs: leg.amountQuota, pool_legs: legs.length, pool_leg_index: index + 1 },
    };
  });
  return withOpeningGuard([input.billingUserId], drafts, deps);
}

async function resolveRefundLegs(
  input: { billingUserId: number; operationId: string; pool?: LedgerPool },
  amountQuota: number,
  deps: LedgerWriterDeps,
): Promise<{ pool: LedgerPool; termRef: string | null; expiresAt: string | null; amountQuota: number }[]> {
  const fallback = [
    {
      pool: input.pool ?? LEDGER_POOL_DEFAULT,
      termRef: null as string | null,
      expiresAt: null as string | null,
      amountQuota,
    },
  ];
  if (!accountLedgerStoreEnabled() && !deps.sql) return fallback;
  try {
    const entries = await readAccountLedger(input.billingUserId, deps);
    const consumed: ConsumedPoolLeg[] = entries
      .filter((entry) => entry.operationId === input.operationId && entry.entryType === "consumption" && entry.amount < 0)
      .map((entry) => ({
        pool: poolOf(entry),
        termRef: entry.termRef ?? null,
        expiresAt: entry.expiresAt ?? null,
        consumedQuota: Math.abs(entry.amount),
      }));
    if (consumed.length === 0) return fallback;
    const balances = computePoolBalances(entries, Date.now());
    const current = balances.terms.find((term) => !term.expired && term.expiresAt);
    const planned = planRefundLegs(amountQuota, consumed, {
      nowMs: Date.now(),
      ...(current && current.termRef !== "(no-term)" ? { currentTerm: { termRef: current.termRef, expiresAt: current.expiresAt as string } } : {}),
    });
    if (planned.length === 0) return fallback;
    return planned.map((leg) => ({ ...leg }));
  } catch (error) {
    console.error(
      `[account-ledger] 出资腿读取失败，本次退款记在兜底池 user=${input.billingUserId}：${error instanceof Error ? error.message : String(error)}`,
    );
    return fallback;
  }
}

/**
 * B1 分配/回收 = 真转移：主帐 −Δ、成员 +Δ，**两条腿同一个事务**记帐（单腿落地
 * = 我方帐本自己制造不对称）。amountQuota 传正数（划出方向），回收时呼叫端传负数
 * 由本函式翻向：正 = 主帐→成员，负 = 成员→主帐。
 */
export async function recordTransfer(
  input: {
    teamUserId: number;
    memberUserId: number;
    amountQuota: number;
    transferId: string;
    source: string;
    memberKeyId?: string;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.round(input.amountQuota);
  if (!Number.isFinite(amount) || amount === 0) return { posted: false, reason: "转移金额为 0，无帐可记" };
  const outgoing = amount > 0;
  const magnitude = Math.abs(amount);
  const from = outgoing ? input.teamUserId : input.memberUserId;
  const to = outgoing ? input.memberUserId : input.teamUserId;
  const metadata = { transfer_id: input.transferId, member_key_id: input.memberKeyId ?? null };
  return withOpeningGuard(
    [from, to],
    [
      {
        billingUserId: from,
        entryType: "transfer_out",
        amount: -magnitude,
        source: input.source,
        sourceRef: `transfer:${input.transferId}`,
        idempotencyRef: ledgerRef.transferOut(input.transferId),
        counterpartyUserId: to,
        metadata,
      },
      {
        billingUserId: to,
        entryType: "transfer_in",
        amount: magnitude,
        source: input.source,
        sourceRef: `transfer:${input.transferId}`,
        idempotencyRef: ledgerRef.transferIn(input.transferId),
        counterpartyUserId: from,
        metadata,
      },
    ],
    deps,
  );
}

/** 充值入帐（兑换码被使用）。source 决定「现金 / 非现金」语义（投影层据此判付费）。 */
export async function recordRecharge(
  input: {
    billingUserId: number;
    amountQuota: number;
    redemptionId: string | number;
    redemptionKey?: string;
    redeemedAt?: string | null;
    /** 省略＝现金通道（`redemption-sync`）；人工发码必须传非现金来源。 */
    source?: string;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.round(input.amountQuota);
  if (!Number.isFinite(amount) || amount <= 0) return { posted: false, reason: "充值金额非正数" };
  return withOpeningGuard(
    [input.billingUserId],
    [
      {
        billingUserId: input.billingUserId,
        entryType: "recharge",
        amount,
        source: input.source ?? REDEMPTION_CASH_SOURCE,
        sourceRef: `redemption:${String(input.redemptionId)}`,
        idempotencyRef: ledgerRef.recharge(input.redemptionId),
        note: "new-api 兑换码已使用（充值入帐）",
        metadata: { redemption_key: input.redemptionKey ?? null, redeemed_at: input.redeemedAt ?? null },
      },
    ],
    deps,
  );
}

/**
 * REQ-D3 期次切换（订阅池入帐，**不变量 ③**）：一次写入「本期发放」与（可选）「上一期
 * 未用完余额作废」。
 *
 *   发放行：entry_type=recharge、pool='subscription'、term_ref='sub:<id>:term:<n>'，
 *           expires_at = 本期到期时刻；幂等键 = `subscription:<id>:term:<n>`（就是
 *           「(订阅 id, 期次序号)」那条不变量）。
 *   替换行：entry_type=expire、amount = −旧期未用完额（写入时作废；replace 语义）。
 *           两行同一批 ⇒ 同一个事务，要嘛都记、要嘛都不记（不会出现「旧额已作废、
 *           新额却没发」的净损失）。
 *
 * 重放防护两层：①呼叫端先按 source_ref（redemption:<id>）判断同一张码是否已发过；
 * ②帐本 UNIQUE(idempotency_ref) 挡并发（同一期次只会落一次）。
 */
export async function recordSubscriptionTermSwitch(
  input: {
    billingUserId: number;
    subscriptionId: string;
    /** 本期期次序号（从 1 起算）。 */
    termIndex: number;
    /** 本期额度（quota）。 */
    termQuota: number;
    /** 本期到期时刻 ISO。 */
    expiresAt: string;
    /** 发放来源（'redemption:<id>'）。 */
    sourceRef: string;
    sku: string;
    grantedAt?: string | null;
    redemptionKey?: string | null;
    /** 要作废的上一期未用完余额（>0 才写 expire 行；由 subscription.ts 依替换语义算出）。 */
    replaced?: { termIndex: number; termRef: string; expiresAt: string; amountQuota: number } | null;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.round(input.termQuota);
  if (!Number.isFinite(amount) || amount <= 0) return { posted: false, reason: "期次额度非正数" };
  const drafts: LedgerEntryDraft[] = [
    {
      billingUserId: input.billingUserId,
      entryType: "recharge",
      amount,
      source: "subscription-redemption",
      sourceRef: input.sourceRef,
      idempotencyRef: ledgerRef.subscriptionTerm(input.subscriptionId, input.termIndex),
      pool: "subscription",
      termRef: subscriptionTermRef(input.subscriptionId, input.termIndex),
      expiresAt: input.expiresAt,
      note: `订阅期次发放（第 ${input.termIndex} 期）`,
      metadata: {
        subscription_id: input.subscriptionId,
        sku: input.sku,
        term_index: input.termIndex,
        granted_at: input.grantedAt ?? null,
        redemption_key: input.redemptionKey ?? null,
      },
    },
  ];
  if (input.replaced && Math.round(input.replaced.amountQuota) > 0) {
    const replaced = Math.round(input.replaced.amountQuota);
    drafts.push({
      billingUserId: input.billingUserId,
      entryType: "expire",
      amount: -replaced,
      source: "subscription-redemption",
      sourceRef: `${input.sourceRef}/replace-term-${input.replaced.termIndex}`,
      idempotencyRef: ledgerRef.subscriptionReplace(input.subscriptionId, input.replaced.termIndex),
      pool: "subscription",
      termRef: input.replaced.termRef,
      expiresAt: input.replaced.expiresAt,
      note: `续期替换：第 ${input.replaced.termIndex} 期未用完余额作废`,
      metadata: {
        subscription_id: input.subscriptionId,
        replaced_term_index: input.replaced.termIndex,
        replaced_quota: replaced,
        renewal_mode: "replace",
      },
    });
  }
  return withOpeningGuard([input.billingUserId], drafts, deps);
}

/** 管理员加减额度（建户初始额度、人工补正）。sourceRef 必填且要能指回操作人。 */
export async function recordAdjustment(
  input: {
    billingUserId: number;
    amountQuota: number;
    sourceRef: string;
    note: string;
    source?: string;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.round(input.amountQuota);
  if (!Number.isFinite(amount) || amount === 0) return { posted: false, reason: "调整金额为 0，无帐可记" };
  return withOpeningGuard(
    [input.billingUserId],
    [
      {
        billingUserId: input.billingUserId,
        entryType: "adjustment",
        amount,
        source: input.source ?? "admin",
        sourceRef: input.sourceRef,
        idempotencyRef: ledgerRef.adjustment(input.sourceRef),
        note: input.note.slice(0, 500),
      },
    ],
    deps,
  );
}
