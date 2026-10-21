import { listGatewayRedemptions, type GatewayRedemption } from "@/lib/gateway-admin";
import { parseSubscriptionCodeMarker } from "../subscription-sku";
import { getGenerationSql, type GenerationSql } from "../database";
import { ensureAccountOpening } from "./opening";
import { REDEMPTION_BASELINE_OFFSET_SOURCE, REDEMPTION_CASH_SOURCE, REDEMPTION_MANUAL_SOURCE, ledgerRef } from "./schema";
import { accountLedgerStoreEnabled, postLedgerEntries, type Row } from "./storage";
import type { LedgerEntryDraft, LedgerWriterDeps, OpeningDeps, PendingWriteOutcome, RechargeIngestSummary } from "./types";
import { recordRecharge } from "./writes";

// ─────────────────────────────────────────── 充值入帐（上游兑换码 → 帐本）

type RedemptionReader = (input: { pages: number; pageSize: number }) => Promise<GatewayRedemption[]>;

/**
 * 兑换码是不是「真金白银买来的」。唯一判据＝mPay 发码时的命名约定
 * （`mapay-redemption.mapayOrderRedemptionName` = `MP` + out_trade_no 后 18 码）。
 * 人工码（eimu1500 / MANUAL-* / tier-* / gift）一律非现金——帐本语义上不是营收。
 */
export function isCashBackedRedemptionName(name: string | null | undefined): boolean {
  return /^MP[A-Z0-9]{6,}$/.test((name ?? "").trim());
}

/**
 * 基线前（`redeemed_time` 早于开户基线行）的充值入帐：**两条腿同一批**——
 *
 *   recharge       +Q  ← 让「这笔钱从哪来」在帐本上可见（营收/漏斗的唯一事实源）
 *   adjustment     −Q  ← 冲销：该笔额度在开户基线（opening，读自 new-api 当时余额）里
 *                        已经算过一次，若只记 recharge 就是凭空多一份钱。
 *
 * 净额恒为 0 ⇒ 余额（Σ amount）与既有帐本逐位相同；两腿由 postLedgerEntries 包在
 * 同一事务（`ON CONFLICT` 幂等），扫描重放不双算。缺腿自愈：先读两把幂等键，
 * 只补缺的那条——不会出现「recharge 在、冲销不在」的单腿漂移。
 */
async function recordBaselineAbsorbedRecharge(
  input: {
    billingUserId: number;
    amountQuota: number;
    redemptionId: string | number;
    redemptionKey?: string;
    redeemedAt?: string | null;
    source: string;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.round(input.amountQuota);
  const sql = deps.sql;
  if (!sql) return { posted: false, reason: "帐本储存层未配置" };
  try {
    const rechargeRef = ledgerRef.recharge(input.redemptionId);
    const offsetRef = ledgerRef.rechargeBaselineOffset(input.redemptionId);
    const existing = await sql<Row[]>`
      SELECT idempotency_ref FROM account_ledger
      WHERE idempotency_ref IN (${rechargeRef}, ${offsetRef})
    `;
    const seen = new Set(existing.map((row) => String(row.idempotency_ref)));
    if (seen.has(rechargeRef) && seen.has(offsetRef)) {
      return { posted: false, reason: "已记过（重放）" };
    }
    const sourceRef = `redemption:${String(input.redemptionId)}`;
    const drafts: LedgerEntryDraft[] = [];
    if (!seen.has(rechargeRef)) {
      drafts.push({
        billingUserId: input.billingUserId,
        entryType: "recharge",
        amount,
        source: input.source,
        sourceRef,
        idempotencyRef: rechargeRef,
        note: "new-api 兑换码已使用（充值入帐，金额已含在开户基线内）",
        metadata: { redemption_key: input.redemptionKey ?? null, redeemed_at: input.redeemedAt ?? null, baseline_absorbed: true },
      });
    }
    if (!seen.has(offsetRef)) {
      drafts.push({
        billingUserId: input.billingUserId,
        entryType: "adjustment",
        amount: -amount,
        source: REDEMPTION_BASELINE_OFFSET_SOURCE,
        sourceRef,
        idempotencyRef: offsetRef,
        note: "冲销：该笔充值已含在开户基线（opening）内，避免双算",
        metadata: { redemption_key: input.redemptionKey ?? null, redeemed_at: input.redeemedAt ?? null, baseline_absorbed: true },
      });
    }
    const result = await postLedgerEntries(drafts, { sql });
    if (result.errors.length > 0) return { posted: false, reason: result.errors[0] };
    if (result.rejected.length > 0) return { posted: false, reason: result.rejected[0].reason };
    return { posted: result.inserted.length > 0, reason: undefined };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[account-ledger] 基线冲销入帐异常（不挡钱路）：${reason}`);
    return { posted: false, reason };
  }
}

/**
 * 充值入帐：把 new-api「已被使用」的兑换码同步成我方帐本的 recharge 加项。
 *
 * 为什么读上游而不是在发码时记帐：mPay 回调只是**产生**兑换码（`fulfillMapayRedemption`），
 * 真正入帐要用户在 new-api 端兑换（`POST /api/user/topup`）。发码即记 = 未被兑换的码
 * 凭空变成余额；故一律以「上游记录显示已使用」为唯一入帐依据（同时涵盖人工发码）。
 *
 * 两种来源，两套语义（现金判定在投影层按 `source` 做，此处只负责如实标记）：
 *   - mPay 真实单（name=`MP…`）→ source=`redemption-sync`，是现金营收。
 *   - 人工发码 / 赠送码 → source=`gift-manual-code`（命中 NON_CASH_RECHARGE_SOURCE），
 *     额度有效但不是现金流入，禁止混进付费漏斗。
 *
 * 防双算（关键）：`redeemed_time` **晚于该身份基线入帐时间**的码直接入帐；早于基线的
 * （额度已含在 opening 里）入帐**两条腿**——recharge +Q 让「钱从哪来」在帐上可见，
 * adjustment −Q 冲销防双算（净额 0）。旧版是直接丢弃这类码，导致 09-19 前后所有
 * 已兑换码在帐本上完全消失（营收恒为 0 的根因之一）。
 *
 * 幂等：idempotency_ref = `redemption:<id>`（冲销腿 `…:opening-offset`）⇒ 周期性重扫
 * 不会重复入帐。
 */
export async function ingestRedeemedRecharges(
  input: { pages?: number; pageSize?: number } = {},
  deps: { sql?: GenerationSql; readRedemptions?: RedemptionReader; fetchUser?: OpeningDeps["fetchUser"] } = {},
): Promise<RechargeIngestSummary> {
  const summary: RechargeIngestSummary = {
    scanned: 0,
    charged: 0,
    chargedBaselineAbsorbed: 0,
    skippedUnused: 0,
    skippedBeforeBaseline: 0,
    skippedNoUser: 0,
    skippedSubscription: 0,
    errors: [],
  };
  if (!accountLedgerStoreEnabled() && !deps.sql) {
    summary.errors.push("帐本储存层未配置");
    return summary;
  }
  const sql = deps.sql ?? getGenerationSql();
  const reader: RedemptionReader = deps.readRedemptions ?? listGatewayRedemptions;

  let items: GatewayRedemption[];
  try {
    items = await reader({ pages: Math.max(1, Math.min(input.pages ?? 20, 50)), pageSize: Math.max(1, Math.min(input.pageSize ?? 100, 100)) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    summary.errors.push(reason);
    console.error(`[account-ledger] 兑换码读取失败：${reason}`);
    return summary;
  }

  for (const item of items) {
    summary.scanned += 1;
    const redeemedAtSec = Number(item.redeemed_time ?? 0);
    const usedUserId = Number(item.used_user_id ?? 0);
    if (!(redeemedAtSec > 0)) {
      summary.skippedUnused += 1;
      continue;
    }
    if (!(usedUserId > 0)) {
      summary.skippedNoUser += 1;
      continue;
    }
    // REQ-D3 防双算（关键）：带订阅 SKU 标记的兑换码**只**走订阅通道（subscription.ts
    // 建订阅＋发期次，记在订阅池）。这里若照旧记一笔 recharge，同一张码就会同时产生
    // 「永久充值」与「订阅发放」两笔入帐 = 凭空多一笔钱。
    if (parseSubscriptionCodeMarker(item.name)) {
      summary.skippedSubscription += 1;
      continue;
    }
    const opening = await ensureAccountOpening(usedUserId, { sql, fetchUser: deps.fetchUser });
    if (opening.baselineQuota === null) {
      // 基线不明（上游 user 读不到/额度非整数）⇒ 不入帐，留给对帐报告解释。
      summary.skippedNoUser += 1;
      continue;
    }
    const openingRow = await sql<Row[]>`
      SELECT created_at FROM account_ledger WHERE idempotency_ref = ${ledgerRef.opening(usedUserId)} LIMIT 1
    `;
    // 基线时刻 = 这笔充值是否已含在基线里的分界线。基线行写入失败时保守取 now
    // （宁可漏记一笔旧充值让对帐报告指出，也不把已含在基线里的钱再加一次）。
    const openingAtMs = openingRow[0] ? new Date(String(openingRow[0].created_at)).getTime() : Date.now();
    const source = isCashBackedRedemptionName(item.name) ? REDEMPTION_CASH_SOURCE : REDEMPTION_MANUAL_SOURCE;
    const common = {
      billingUserId: usedUserId,
      amountQuota: Number(item.quota ?? 0),
      redemptionId: item.id,
      redemptionKey: item.key,
      redeemedAt: new Date(redeemedAtSec * 1000).toISOString(),
    };
    if (redeemedAtSec * 1000 < openingAtMs) {
      // 基线前兑换：额度已含在 opening 内 ⇒ 记「充值 + 冲销」两条腿，净额 0 但可见。
      const absorbed = await recordBaselineAbsorbedRecharge({ ...common, source }, { sql });
      if (absorbed.posted) summary.chargedBaselineAbsorbed += 1;
      else if (absorbed.reason && !/重放/.test(absorbed.reason)) {
        summary.skippedBeforeBaseline += 1;
        summary.errors.push(`redemption ${item.id}: ${absorbed.reason}`);
      }
      continue;
    }
    const outcome = await recordRecharge({ ...common, source }, { sql });
    if (outcome.posted) summary.charged += 1;
    else if (outcome.reason && !/重放/.test(outcome.reason)) summary.errors.push(`redemption ${item.id}: ${outcome.reason}`);
  }
  return summary;
}
