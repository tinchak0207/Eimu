// REQ-D3 订阅 SKU：**写入器层**（订阅合约＋期次发放＋兑换码通道）。
//
// 纯算术在 subscription-sku.ts，帐本在 account-ledger.ts，本档只做「读事实 → 决定 →
// 记帐」的编排：
//   ① 兑换码通道（预设，见 SUBSCRIPTION_FULFILLMENT_CHANNEL）：从 new-api 兑换记录
//      回读「已被使用」且 name 带 SKU 标记的码（与 E1a 充值入帐同一条可观测真相）。
//   ② 建立订阅合约（subscription 表，UNIQUE(source_ref) ⇒ 同码不得双开）。
//   ③ 发放期次：幂等键＝(订阅 id, 期次序号)；replace 语义下把上一期未用完余额作废。
//   ④ 防双算：带标记的码由本模组处理，account-ledger 的永久充值通道明确跳过它。
//   ⑤ 基线规则沿用 E1a：redeemed_time 早于帐本基线的码已含在 opening 里 ⇒ 不发放。
//
// 不变量 ④（过期只在读取时 lazy 判定）：本档**不负责**过期——没有任何「到期清零」的
// 定时任务；过期只在读取余额/预检时由 computePoolBalances(entries, now) 判定。
// 本档唯一与时间有关的写入是「续期替换」（有人按了续费，是事件不是时间流逝）。

import { listGatewayRedemptions, type GatewayAdminUser, type GatewayRedemption } from "@/lib/gateway-admin";
import {
  SUBSCRIPTION_FULFILLMENT_CHANNEL,
  SUBSCRIPTION_RENEWAL_MODE,
  computePoolBalances,
  isKnownSubscriptionSku,
  parseSubscriptionCodeMarker,
  replacedQuotaForRenewal,
  subscriptionIdFor,
  subscriptionSkuTermSeconds,
  subscriptionTermWindow,
} from "./subscription-sku";
import {
  accountLedgerStoreEnabled,
  ensureAccountOpening,
  ledgerRef,
  readAccountLedger,
  recordSubscriptionTermSwitch,
  type LedgerWriterDeps,
} from "./account-ledger";
import { getGenerationSql, type GenerationSql } from "./database";

type Row = Record<string, unknown>;

/** 订阅合约（subscription 表的一列）——只存合约，不存当前期的可变游标（见 migration 022）。 */
export interface SubscriptionRecord {
  id: string;
  billingUserId: number;
  sku: string;
  termQuota: number;
  termSeconds: number;
  startedAt: string;
  sourceRef: string;
}

export interface SubscriptionGrantOutcome {
  ok: boolean;
  subscriptionId: string;
  /** 本期期次序号（1 起算）。 */
  termIndex: number;
  /** true = 本次真的发放；false = 已发过（重放／并发）。 */
  granted: boolean;
  /** 本次作废的上一期未用完余额（replace 语义）。 */
  replacedQuota: number;
  /** 本期到期时刻。 */
  expiresAt: string | null;
  reason?: string;
}

export interface SubscriptionDeps extends LedgerWriterDeps {
  now?: () => Date;
  /** 合约 id 生成（默认订阅 id = sub-<userId>-<sku>；测试可注入）。 */
  newSubscriptionId?: (billingUserId: number, sku: string) => string;
}

/** 把订阅层的依赖缩成帐本层要的形状（不多带栏位，避免型别外溢）。 */
function asLedgerDeps(deps: SubscriptionDeps, sql: GenerationSql): LedgerWriterDeps {
  return deps.fetchUser ? { sql, fetchUser: deps.fetchUser } : { sql };
}

function mapSubscriptionRow(row: Row): SubscriptionRecord {
  return {
    id: String(row.id),
    billingUserId: Number(row.billing_user_id),
    sku: String(row.sku),
    termQuota: Number(row.term_quota),
    termSeconds: Number(row.term_seconds),
    startedAt: new Date(String(row.started_at)).toISOString(),
    sourceRef: String(row.source_ref),
  };
}

async function readSubscription(sql: GenerationSql, id: string): Promise<SubscriptionRecord | null> {
  const rows = await sql<Row[]>`
    SELECT id, billing_user_id, sku, term_quota, term_seconds, started_at, source_ref
    FROM subscription WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ? mapSubscriptionRow(rows[0]) : null;
}

/**
 * 建立订阅合约（**幂等**：同 id 已存在 ⇒ 不覆写）。
 * 合约 id 由 (billing_user_id, sku) 决定 ⇒ 同一用户同一 SKU 只有一份合约，续期＝同一份
 * 合约的下一个期次（期次幂等的载体）。
 * `source_ref` 有 UNIQUE ⇒ 同一张兑换码不可能开出第二份合约（双开的另一道门）。
 */
async function ensureSubscription(
  input: { billingUserId: number; sku: string; termQuota: number; redemptionId: string | number; redeemedAt: string },
  deps: SubscriptionDeps = {},
): Promise<{ subscription: SubscriptionRecord; created: boolean }> {
  const sql = deps.sql ?? getGenerationSql();
  const id = (deps.newSubscriptionId ?? subscriptionIdFor)(input.billingUserId, input.sku);
  const existing = await readSubscription(sql, id);
  if (existing) return { subscription: existing, created: false };

  const sourceRef = `redemption:${String(input.redemptionId)}`;
  const rows = await sql<Row[]>`
    INSERT INTO subscription (id, billing_user_id, sku, term_quota, term_seconds, started_at, source_ref)
    VALUES (
      ${id}, ${input.billingUserId}, ${input.sku}, ${Math.round(input.termQuota)},
      ${subscriptionSkuTermSeconds(input.sku)}, ${input.redeemedAt}, ${sourceRef}
    )
    ON CONFLICT DO NOTHING
    RETURNING id, billing_user_id, sku, term_quota, term_seconds, started_at, source_ref
  `;
  if (rows[0]) return { subscription: mapSubscriptionRow(rows[0]), created: true };

  // 并发：另一路先插了同 id。读回来用（合约内容以先落地者为准，不覆写）。
  const raced = await readSubscription(sql, id);
  if (!raced) throw new Error(`订阅合约建立失败（${id}）`);
  return { subscription: raced, created: false };
}

/**
 * 发放一期（**不变量 ③**）：期次序号由帐本推导（Σ 已发放的期次行），幂等键 (订阅 id, 期次)。
 *
 * 重放防护：同一张兑换码（source_ref='redemption:<id>'）已有发放行 ⇒ 直接回报「已发过」，
 * 不再指派新期次（否则每扫一次就多发一期）。并发时由帐本 UNIQUE(idempotency_ref) 挡。
 *
 * replace 语义（预设）：新期取代旧期未用完余额 ⇒ 作废旧期剩余；accumulate 则不作废。
 */
export async function grantSubscriptionTermFromRedemption(
  input: {
    billingUserId: number;
    sku: string;
    termQuota: number;
    redemptionId: string | number;
    redemptionKey?: string | null;
    redeemedAt: string;
    /** 已存在的合约 id（由呼叫端从兑换记录推出）；省略＝按 (user, sku) 生成。 */
    subscriptionId?: string;
  },
  deps: SubscriptionDeps = {},
): Promise<SubscriptionGrantOutcome> {
  const subscriptionId =
    input.subscriptionId ?? (deps.newSubscriptionId ?? subscriptionIdFor)(input.billingUserId, input.sku);
  const sourceRef = `redemption:${String(input.redemptionId)}`;
  const empty: SubscriptionGrantOutcome = {
    ok: false,
    subscriptionId,
    termIndex: 0,
    granted: false,
    replacedQuota: 0,
    expiresAt: null,
  };

  if (!accountLedgerStoreEnabled() && !deps.sql) return { ...empty, reason: "帐本储存层未配置" };
  const sql = deps.sql ?? getGenerationSql();
  const now = (deps.now ?? (() => new Date()))();

  try {
    await ensureSubscription(
      {
        billingUserId: input.billingUserId,
        sku: input.sku,
        termQuota: input.termQuota,
        redemptionId: input.redemptionId,
        redeemedAt: input.redeemedAt,
      },
      { sql, ...(deps.fetchUser ? { fetchUser: deps.fetchUser } : {}) },
    );

    const entries = await readAccountLedger(input.billingUserId, { sql });
    // ① 同一张码是否已发放过（source_ref 指回这张码且落在订阅池）。
    const already = entries.find(
      (entry) => entry.sourceRef === sourceRef && entry.pool === "subscription" && entry.entryType === "recharge",
    );
    if (already) {
      return {
        ...empty,
        granted: false,
        termIndex: termIndexFromEntry(already.termRef) ?? 0,
        expiresAt: already.expiresAt ?? null,
        reason: "同一张兑换码已发放过（重放不双发）",
      };
    }

    // ② 期次序号 = 已发放期次 + 1（帐本是唯一权威）。
    let maxTerm = 0;
    let previousGrant: { termIndex: number; termRef: string; expiresAt: string; quota: number } | null = null;
    const termQuotaByRef = new Map<string, number>();
    for (const entry of entries) {
      if (entry.pool !== "subscription") continue;
      const termIndex = termIndexFromEntry(entry.termRef);
      if (termIndex === null) continue;
      termQuotaByRef.set(entry.termRef as string, (termQuotaByRef.get(entry.termRef as string) ?? 0) + entry.amount);
      if (termIndex > maxTerm) {
        maxTerm = termIndex;
        if (entry.entryType === "recharge" && entry.expiresAt) {
          previousGrant = {
            termIndex,
            termRef: entry.termRef as string,
            expiresAt: entry.expiresAt,
            quota: 0,
          };
        }
      }
    }
    const termIndex = maxTerm + 1;
    if (previousGrant) {
      previousGrant.quota = termQuotaByRef.get(previousGrant.termRef) ?? 0;
    }

    // ③ 替换语义：旧期未用完余额作废（accumulate 模式回 0 ＝ 不作废）。
    const replacedQuota =
      previousGrant && SUBSCRIPTION_RENEWAL_MODE === "replace"
        ? replacedQuotaForRenewal(previousGrant.quota)
        : 0;

    const window = subscriptionTermWindow(now.getTime(), subscriptionSkuTermSeconds(input.sku));
    const outcome = await recordSubscriptionTermSwitch(
      {
        billingUserId: input.billingUserId,
        subscriptionId,
        termIndex,
        termQuota: input.termQuota,
        expiresAt: window.expiresAt,
        sourceRef,
        sku: input.sku,
        grantedAt: now.toISOString(),
        redemptionKey: input.redemptionKey ?? null,
        replaced:
          previousGrant && replacedQuota > 0
            ? {
                termIndex: previousGrant.termIndex,
                termRef: previousGrant.termRef,
                expiresAt: previousGrant.expiresAt,
                amountQuota: replacedQuota,
              }
            : null,
      },
      asLedgerDeps(deps, sql),
    );
    if (!outcome.posted) {
      return {
        ...empty,
        termIndex,
        expiresAt: window.expiresAt,
        replacedQuota,
        reason: outcome.reason ?? "期次未落地",
      };
    }
    return {
      ok: true,
      subscriptionId,
      termIndex,
      granted: true,
      replacedQuota,
      expiresAt: window.expiresAt,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[subscription] 期次发放失败（不挡钱路，留待下一轮／对帐）user=${input.billingUserId}：${reason}`);
    return { ...empty, reason };
  }
}

function termIndexFromEntry(termRef: string | null | undefined): number | null {
  if (typeof termRef !== "string") return null;
  const matched = /^sub:.+:term:(\d+)$/.exec(termRef);
  if (!matched) return null;
  const parsed = Number(matched[1]);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

// ─────────────────────────────────────────────── 兑换码通道（上游记录 → 订阅）

export interface SubscriptionIngestSummary {
  scanned: number;
  /** 本次发放的期次数（含续期）。 */
  granted: number;
  /** 认出是订阅码但已发放过。 */
  skippedAlreadyGranted: number;
  skippedUnused: number;
  skippedBeforeBaseline: number;
  skippedNoUser: number;
  /** 标记认得、SKU 不在注册表（用兜底期长兑现，留审计讯息）。 */
  unknownSku: number;
  errors: string[];
}

type RedemptionReader = (input: { pages: number; pageSize: number }) => Promise<GatewayRedemption[]>;

/**
 * 订阅兑换码入帐（**预设通道**，不变量：订阅沿用兑换码）。
 *
 * 为什么与 E1a 充值入帐读同一份上游事实：兑换这个动作只发生在 new-api 端，我方唯一
 * 可观测的真相就是兑换记录（status/redeemed_time/used_user_id）。发码即入帐 = 未兑换的
 * 码凭空变成订阅余额，违反「充值必兑现」的另一面（我方不得凭空给，也不得收了不给）。
 *
 * 基线规则（与 E1a 逐条相同）：redeemed_time 早于该身份基线入帐时刻的码已含在 opening 里
 * ⇒ 不再发放（否则双算）。
 *
 * 幂等：同一张码重放 ⇒ grantSubscriptionTermFromRedemption 依 source_ref 判「已发放」。
 */
export async function ingestSubscriptionRedemptions(
  input: { pages?: number; pageSize?: number } = {},
  deps: {
    sql?: GenerationSql;
    readRedemptions?: RedemptionReader;
    fetchUser?: (userId: number) => Promise<GatewayAdminUser | null>;
    now?: () => Date;
  } = {},
): Promise<SubscriptionIngestSummary> {
  const summary: SubscriptionIngestSummary = {
    scanned: 0,
    granted: 0,
    skippedAlreadyGranted: 0,
    skippedUnused: 0,
    skippedBeforeBaseline: 0,
    skippedNoUser: 0,
    unknownSku: 0,
    errors: [],
  };
  if (SUBSCRIPTION_FULFILLMENT_CHANNEL !== "redemption") {
    summary.errors.push(`订阅兑现通道为 ${SUBSCRIPTION_FULFILLMENT_CHANNEL}（非兑换码），本轮不扫码`);
    return summary;
  }
  if (!accountLedgerStoreEnabled() && !deps.sql) {
    summary.errors.push("帐本储存层未配置");
    return summary;
  }
  const sql = deps.sql ?? getGenerationSql();
  const reader: RedemptionReader = deps.readRedemptions ?? listGatewayRedemptions;

  let items: GatewayRedemption[];
  try {
    items = await reader({
      pages: Math.max(1, Math.min(input.pages ?? 2, 20)),
      pageSize: Math.max(1, Math.min(input.pageSize ?? 100, 100)),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    summary.errors.push(reason);
    console.error(`[subscription] 兑换码读取失败：${reason}`);
    return summary;
  }

  for (const item of items) {
    const marker = parseSubscriptionCodeMarker(item.name);
    if (!marker) continue; // 非订阅码：不属于本通道
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

    const opening = await ensureAccountOpening(usedUserId, { sql, fetchUser: deps.fetchUser });
    if (opening.baselineQuota === null) {
      summary.skippedNoUser += 1;
      continue;
    }
    const openingRow = await sql<Row[]>`
      SELECT created_at FROM account_ledger WHERE idempotency_ref = ${ledgerRef.opening(usedUserId)} LIMIT 1
    `;
    const openingAtMs = openingRow[0] ? new Date(String(openingRow[0].created_at)).getTime() : Date.now();
    if (redeemedAtSec * 1000 < openingAtMs) {
      // 基线前兑换：额度已含在 opening 基线里（防双算，与 E1a 同一条判别）。
      summary.skippedBeforeBaseline += 1;
      continue;
    }

    if (!isKnownSubscriptionSku(marker.sku)) {
      summary.unknownSku += 1;
      console.error(
        `[subscription] 认得订阅标记但 SKU 未注册 sku=${marker.sku} redemption=${item.id}；` +
          `仍按兜底期长发放（充值必兑现），期长=${subscriptionSkuTermSeconds(marker.sku)}s`,
      );
    }

    const outcome = await grantSubscriptionTermFromRedemption(
      {
        billingUserId: usedUserId,
        sku: marker.sku,
        termQuota: Number(item.quota ?? 0),
        redemptionId: item.id,
        redemptionKey: item.key,
        redeemedAt: new Date(redeemedAtSec * 1000).toISOString(),
      },
      { sql, fetchUser: deps.fetchUser, now: deps.now },
    );
    if (outcome.granted) summary.granted += 1;
    else if (/已发放/.test(outcome.reason ?? "")) summary.skippedAlreadyGranted += 1;
    else summary.errors.push(`redemption ${item.id}: ${outcome.reason ?? "未发放"}`);
  }
  return summary;
}

// ─────────────────────────────────────────────── 订阅检视（只读，供后续 UI/排障）

export interface SubscriptionView {
  subscription: SubscriptionRecord;
  termIndex: number;
  expiresAt: string | null;
  termQuota: number;
  /** 该订阅在帐本上的余额（仅订阅池、含已过期部分）。 */
  bookQuota: number;
  /** 未过期部分（可用）。 */
  availableQuota: number;
  expired: boolean;
}

export async function readSubscriptions(
  billingUserId: number,
  deps: { sql?: GenerationSql; nowMs?: number } = {},
): Promise<SubscriptionView[]> {
  const sql = deps.sql ?? getGenerationSql();
  const rows = await sql<Row[]>`
    SELECT id, billing_user_id, sku, term_quota, term_seconds, started_at, source_ref
    FROM subscription WHERE billing_user_id = ${billingUserId} ORDER BY created_at, id
  `;
  const entries = await readAccountLedger(billingUserId, { sql });
  const nowMs = deps.nowMs ?? Date.now();
  return rows.map((row) => {
    const subscription = mapSubscriptionRow(row);
    const prefix = `sub:${subscription.id}:term:`;
    const mine = entries.filter(
      (entry) => entry.pool === "subscription" && typeof entry.termRef === "string" && entry.termRef.startsWith(prefix),
    );
    const balances = computePoolBalances(mine, nowMs);
    let termIndex = 0;
    let expiresAt: string | null = null;
    for (const entry of mine) {
      const index = termIndexFromEntry(entry.termRef) ?? 0;
      if (index >= termIndex) {
        termIndex = index;
        expiresAt = entry.expiresAt ?? expiresAt;
      }
    }
    const bookQuota = mine.reduce((sum, entry) => sum + entry.amount, 0);
    return {
      subscription,
      termIndex,
      expiresAt,
      termQuota: subscription.termQuota,
      bookQuota,
      availableQuota: balances.availableQuota,
      expired: termIndex > 0 && expiresAt !== null && Date.parse(expiresAt) <= nowMs,
    };
  });
}
