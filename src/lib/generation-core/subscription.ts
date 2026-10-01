// REQ-D3 訂閱 SKU：**寫入器層**（訂閱合約＋期次發放＋兌換碼通道）。
//
// 純算術在 subscription-sku.ts，帳本在 account-ledger.ts，本檔只做「讀事實 → 決定 →
// 記帳」的編排：
//   ① 兌換碼通道（預設，見 SUBSCRIPTION_FULFILLMENT_CHANNEL）：從 new-api 兌換記錄
//      回讀「已被使用」且 name 帶 SKU 標記的碼（與 E1a 充值入帳同一條可觀測真相）。
//   ② 建立訂閱合約（subscription 表，UNIQUE(source_ref) ⇒ 同碼不得雙開）。
//   ③ 發放期次：冪等鍵＝(訂閱 id, 期次序號)；replace 語義下把上一期未用完餘額作廢。
//   ④ 防雙算：帶標記的碼由本模組處理，account-ledger 的永久充值通道明確跳過它。
//   ⑤ 基線規則沿用 E1a：redeemed_time 早於帳本基線的碼已含在 opening 裡 ⇒ 不發放。
//
// 不變量 ④（過期只在讀取時 lazy 判定）：本檔**不負責**過期——沒有任何「到期清零」的
// 定時任務；過期只在讀取餘額/預檢時由 computePoolBalances(entries, now) 判定。
// 本檔唯一與時間有關的寫入是「續期替換」（有人按了續費，是事件不是時間流逝）。

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

/** 訂閱合約（subscription 表的一列）——只存合約，不存當前期的可變游標（見 migration 022）。 */
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
  /** 本期期次序號（1 起算）。 */
  termIndex: number;
  /** true = 本次真的發放；false = 已發過（重放／併發）。 */
  granted: boolean;
  /** 本次作廢的上一期未用完餘額（replace 語義）。 */
  replacedQuota: number;
  /** 本期到期時刻。 */
  expiresAt: string | null;
  reason?: string;
}

export interface SubscriptionDeps extends LedgerWriterDeps {
  now?: () => Date;
  /** 合約 id 生成（默認訂閱 id = sub-<userId>-<sku>；測試可注入）。 */
  newSubscriptionId?: (billingUserId: number, sku: string) => string;
}

/** 把訂閱層的依賴縮成帳本層要的形狀（不多帶欄位，避免型別外溢）。 */
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
 * 建立訂閱合約（**冪等**：同 id 已存在 ⇒ 不覆寫）。
 * 合約 id 由 (billing_user_id, sku) 決定 ⇒ 同一用戶同一 SKU 只有一份合約，續期＝同一份
 * 合約的下一個期次（期次冪等的載體）。
 * `source_ref` 有 UNIQUE ⇒ 同一張兌換碼不可能開出第二份合約（雙開的另一道門）。
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

  // 併發：另一路先插了同 id。讀回來用（合約內容以先落地者為準，不覆寫）。
  const raced = await readSubscription(sql, id);
  if (!raced) throw new Error(`訂閱合約建立失敗（${id}）`);
  return { subscription: raced, created: false };
}

/**
 * 發放一期（**不變量 ③**）：期次序號由帳本推導（Σ 已發放的期次行），冪等鍵 (訂閱 id, 期次)。
 *
 * 重放防護：同一張兌換碼（source_ref='redemption:<id>'）已有發放行 ⇒ 直接回報「已發過」，
 * 不再指派新期次（否則每掃一次就多發一期）。並發時由帳本 UNIQUE(idempotency_ref) 擋。
 *
 * replace 語義（預設）：新期取代舊期未用完餘額 ⇒ 作廢舊期剩餘；accumulate 則不作廢。
 */
export async function grantSubscriptionTermFromRedemption(
  input: {
    billingUserId: number;
    sku: string;
    termQuota: number;
    redemptionId: string | number;
    redemptionKey?: string | null;
    redeemedAt: string;
    /** 已存在的合約 id（由呼叫端從兌換記錄推出）；省略＝按 (user, sku) 生成。 */
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

  if (!accountLedgerStoreEnabled() && !deps.sql) return { ...empty, reason: "帳本儲存層未配置" };
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
    // ① 同一張碼是否已發放過（source_ref 指回這張碼且落在訂閱池）。
    const already = entries.find(
      (entry) => entry.sourceRef === sourceRef && entry.pool === "subscription" && entry.entryType === "recharge",
    );
    if (already) {
      return {
        ...empty,
        granted: false,
        termIndex: termIndexFromEntry(already.termRef) ?? 0,
        expiresAt: already.expiresAt ?? null,
        reason: "同一張兌換碼已發放過（重放不雙發）",
      };
    }

    // ② 期次序號 = 已發放期次 + 1（帳本是唯一權威）。
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

    // ③ 替換語義：舊期未用完餘額作廢（accumulate 模式回 0 ＝ 不作廢）。
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
    console.error(`[subscription] 期次發放失敗（不擋錢路，留待下一輪／對帳）user=${input.billingUserId}：${reason}`);
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

// ─────────────────────────────────────────────── 兌換碼通道（上游記錄 → 訂閱）

export interface SubscriptionIngestSummary {
  scanned: number;
  /** 本次發放的期次數（含續期）。 */
  granted: number;
  /** 認出是訂閱碼但已發放過。 */
  skippedAlreadyGranted: number;
  skippedUnused: number;
  skippedBeforeBaseline: number;
  skippedNoUser: number;
  /** 標記認得、SKU 不在註冊表（用兜底期長兌現，留審計訊息）。 */
  unknownSku: number;
  errors: string[];
}

type RedemptionReader = (input: { pages: number; pageSize: number }) => Promise<GatewayRedemption[]>;

/**
 * 訂閱兌換碼入帳（**預設通道**，不變量：訂閱沿用兌換碼）。
 *
 * 為什麼與 E1a 充值入帳讀同一份上游事實：兌換這個動作只發生在 new-api 端，我方唯一
 * 可觀測的真相就是兌換記錄（status/redeemed_time/used_user_id）。發碼即入帳 = 未兌換的
 * 碼憑空變成訂閱餘額，違反「充值必兌現」的另一面（我方不得憑空給，也不得收了不給）。
 *
 * 基線規則（與 E1a 逐條相同）：redeemed_time 早於該身份基線入帳時刻的碼已含在 opening 裡
 * ⇒ 不再發放（否則雙算）。
 *
 * 幂等：同一張碼重放 ⇒ grantSubscriptionTermFromRedemption 依 source_ref 判「已發放」。
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
    summary.errors.push(`訂閱兌現通道為 ${SUBSCRIPTION_FULFILLMENT_CHANNEL}（非兌換碼），本輪不掃碼`);
    return summary;
  }
  if (!accountLedgerStoreEnabled() && !deps.sql) {
    summary.errors.push("帳本儲存層未配置");
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
    console.error(`[subscription] 兌換碼讀取失敗：${reason}`);
    return summary;
  }

  for (const item of items) {
    const marker = parseSubscriptionCodeMarker(item.name);
    if (!marker) continue; // 非訂閱碼：不屬於本通道
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
      // 基線前兌換：額度已含在 opening 基線裡（防雙算，與 E1a 同一條判別）。
      summary.skippedBeforeBaseline += 1;
      continue;
    }

    if (!isKnownSubscriptionSku(marker.sku)) {
      summary.unknownSku += 1;
      console.error(
        `[subscription] 認得訂閱標記但 SKU 未註冊 sku=${marker.sku} redemption=${item.id}；` +
          `仍按兜底期長發放（充值必兌現），期長=${subscriptionSkuTermSeconds(marker.sku)}s`,
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
    else if (/已發放/.test(outcome.reason ?? "")) summary.skippedAlreadyGranted += 1;
    else summary.errors.push(`redemption ${item.id}: ${outcome.reason ?? "未發放"}`);
  }
  return summary;
}

// ─────────────────────────────────────────────── 訂閱檢視（只讀，供後續 UI/排障）

export interface SubscriptionView {
  subscription: SubscriptionRecord;
  termIndex: number;
  expiresAt: string | null;
  termQuota: number;
  /** 該訂閱在帳本上的餘額（僅訂閱池、含已過期部分）。 */
  bookQuota: number;
  /** 未過期部分（可用）。 */
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
