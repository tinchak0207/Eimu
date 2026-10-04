// REQ-D3 订阅 SKU（双池／按原出资归还／期次幂等／lazy 过期／兑换码通道／防双算）测试。
//
// 验收姿势（AGENTS.md 09-23 verification 铁律）：
//  ・每一条都是**真实行为断言**：真输入 → 真函式/真假储存层 → 读回真实落地结果
//    （帐本列、池余额、契约回应体），不是源码字串扫描。
//  ・源码层扫描（migration DDL 栏位存在）另列为**变更探针**，不计入已验证。
//  ・带一轮对抗性验证：超额消费、多腿退款、过期期退款、缺栏位的订阅帐本行、重放顺序。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import type { GatewayAdminUser, GatewayRedemption } from "@/lib/gateway-admin";
import type { GenerationSql } from "./database.ts";
import {
  computeAccountBalance,
  ingestRedeemedRecharges,
  postLedgerEntries,
  quotaResponseBody,
  readAccountLedger,
  readPoolBalances,
  recordConsumption,
  recordRefund,
  validateLedgerEntryDraft,
  type LedgerEntryDraft,
} from "./account-ledger.ts";
import {
  SUBSCRIPTION_CODE_NAME_PREFIX,
  SUBSCRIPTION_RENEWAL_MODE,
  availableQuotaOf,
  computePoolBalances,
  parseSubscriptionCodeMarker,
  planConsumptionLegs,
  planRefundLegs,
  replacedQuotaForRenewal,
  subscriptionCodeName,
  subscriptionIdFor,
  subscriptionTermRef,
  subscriptionTermWindow,
} from "./subscription-sku.ts";
import { grantSubscriptionTermFromRedemption, ingestSubscriptionRedemptions, readSubscriptions } from "./subscription.ts";
import { checkQuotaAvailable, enforceQuotaGate, SURGERY_QUOTA_PRECHECK_ENV } from "./quota-precheck.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 23, 0, 0, 0); // 开通时刻（假时钟起点）
const CONTROL_PLANE_ENV = {
  GENERATION_DATABASE_URL: "postgres://fake:fake@127.0.0.1:1/fake",
  GENERATION_CONTROL_PLANE_ENABLED: "true",
};

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

// ── 假储存层：真 UNIQUE(idempotency_ref) / 真 ON CONFLICT DO NOTHING / 真 subscription 表 ──

interface FakeLedgerRow {
  id: string;
  billing_user_id: number;
  entry_type: string;
  amount: number;
  source: string;
  source_ref: string;
  idempotency_ref: string;
  job_id: string | null;
  operation_id: string | null;
  counterparty_user_id: number | null;
  note: string | null;
  metadata_json: string;
  pool: string;
  term_ref: string | null;
  expires_at: string | null;
  created_at: string;
}

interface FakeSubscriptionRow {
  id: string;
  billing_user_id: number;
  sku: string;
  term_quota: number;
  term_seconds: number;
  started_at: string;
  source_ref: string;
  created_at: string;
}

/** 把落地列（snake_case，模拟 DB 行）转成池余额计算要的形状（camelCase）。 */
function poolRowsOf(rows: FakeLedgerRow[], userId: number) {
  return rows
    .filter((row) => row.billing_user_id === userId)
    .map((row) => ({
      amount: row.amount,
      pool: row.pool as "permanent" | "subscription",
      termRef: row.term_ref,
      expiresAt: row.expires_at,
    }));
}

function fakeStore(seed: { clock?: () => string } = {}) {
  const rows: FakeLedgerRow[] = [];
  const subscriptions: FakeSubscriptionRow[] = [];
  let insertedAt = 0;
  const clock = seed.clock ?? (() => new Date(T0 + insertedAt++ * 1000).toISOString());

  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ? ").replace(/\s+/g, " ").trim();

    if (query.startsWith("INSERT INTO account_ledger")) {
      const [
        id,
        billingUserId,
        entryType,
        amount,
        source,
        sourceRef,
        idempotencyRef,
        jobId,
        operationId,
        counterparty,
        note,
        metadata,
        pool,
        termRef,
        expiresAt,
      ] = values as [
        string, number, string, number, string, string, string,
        string | null, string | null, number | null, string | null, string,
        string, string | null, string | null,
      ];
      if (rows.some((row) => row.idempotency_ref === idempotencyRef)) return [];
      // 真 DB 的 CHECK：订阅池必带期次与到期时刻。
      if (pool === "subscription" && (!termRef || !expiresAt)) {
        throw new Error("new row for relation account_ledger violates check constraint subscription_term_check");
      }
      rows.push({
        id,
        billing_user_id: Number(billingUserId),
        entry_type: entryType,
        amount: Number(amount),
        source,
        source_ref: sourceRef,
        idempotency_ref: idempotencyRef,
        job_id: jobId,
        operation_id: operationId,
        counterparty_user_id: counterparty,
        note,
        metadata_json: metadata,
        pool,
        term_ref: termRef,
        expires_at: expiresAt,
        created_at: clock(),
      });
      return [{ id, idempotency_ref: idempotencyRef }];
    }

    if (query.startsWith("INSERT INTO subscription")) {
      const [id, billingUserId, sku, termQuota, termSeconds, startedAt, sourceRef] = values as [
        string, number, string, number, number, string, string,
      ];
      if (subscriptions.some((row) => row.id === id || row.source_ref === sourceRef)) return [];
      subscriptions.push({
        id,
        billing_user_id: Number(billingUserId),
        sku,
        term_quota: Number(termQuota),
        term_seconds: Number(termSeconds),
        started_at: startedAt,
        source_ref: sourceRef,
        created_at: clock(),
      });
      return [
        {
          id,
          billing_user_id: Number(billingUserId),
          sku,
          term_quota: Number(termQuota),
          term_seconds: Number(termSeconds),
          started_at: startedAt,
          source_ref: sourceRef,
        },
      ];
    }

    if (query.includes("FROM subscription WHERE id")) {
      const row = subscriptions.find((candidate) => candidate.id === String(values[0]));
      return row ? [{ ...row }] : [];
    }
    if (query.includes("FROM subscription WHERE billing_user_id")) {
      return subscriptions
        .filter((row) => row.billing_user_id === Number(values[0]))
        .map((row) => ({ ...row }));
    }
    if (query.includes("SELECT amount FROM account_ledger WHERE idempotency_ref")) {
      const row = rows.find((candidate) => candidate.idempotency_ref === values[0]);
      return row ? [{ amount: row.amount }] : [];
    }
    if (query.includes("SELECT created_at FROM account_ledger WHERE idempotency_ref")) {
      const row = rows.find((candidate) => candidate.idempotency_ref === values[0]);
      return row ? [{ created_at: row.created_at }] : [];
    }
    if (query.includes("FROM account_ledger WHERE billing_user_id")) {
      return rows.filter((row) => row.billing_user_id === Number(values[0])).map((row) => ({ ...row }));
    }
    if (query.includes("SELECT DISTINCT billing_user_id FROM account_ledger")) {
      const ids = [...new Set(rows.map((row) => row.billing_user_id))];
      return ids.map((id) => ({ billing_user_id: id, total_identities: ids.length }));
    }
    if (query.includes("FROM billing_operation")) return [];
    throw new Error(`fakeStore: 未预期的查询：${query}`);
  }) as unknown as GenerationSql;

  Object.assign(tagged, { begin: async (fn: (tx: GenerationSql) => Promise<unknown>) => fn(tagged) });

  return {
    sql: tagged,
    rows,
    subscriptions,
    balanceOf(userId: number) {
      return rows.filter((row) => row.billing_user_id === userId).reduce((sum, row) => sum + row.amount, 0);
    },
    poolBalances(userId: number, nowMs: number) {
      return computePoolBalances(poolRowsOf(rows, userId), nowMs);
    },
    rowsFor(sourceRef: string) {
      return rows.filter((row) => row.source_ref.startsWith(sourceRef));
    },
  };
}

function gatewayUser(id: number, quota: number): GatewayAdminUser {
  return { id, username: `user-${id}`, quota };
}

/** 写入器注入：基线读法走假上游（永久池基线 = 1,000,000 quota）。 */
function writerDeps(store: ReturnType<typeof fakeStore>, baseline = 1_000_000) {
  return { sql: store.sql, fetchUser: async (id: number) => gatewayUser(id, baseline) };
}

/** 订阅码（name 带 SKU 标记；我方建码时自己写的栏位）。 */
function subscriptionRedemption(input: {
  id: number;
  sku: string;
  quota: number;
  userId: number;
  redeemedAtMs: number;
}): GatewayRedemption {
  return {
    id: input.id,
    key: `key-${input.id}`,
    name: subscriptionCodeName(input.sku, `order-${input.id}`),
    quota: input.quota,
    status: 2,
    used_user_id: input.userId,
    redeemed_time: Math.floor(input.redeemedAtMs / 1000),
  };
}

// ═══════════════════════════════════ ① 双池（订阅消耗不扣永久池）

test("双池：订阅消耗只扣订阅池，永久池逐位不动", async () => {
  const store = fakeStore();
  const userId = 401;
  await withEnv(CONTROL_PLANE_ENV, () =>
    grantSubscriptionTermFromRedemption(
      { billingUserId: userId, sku: "pro-monthly", termQuota: 2_000_000, redemptionId: 9001, redeemedAt: new Date(T0).toISOString() },
      { ...writerDeps(store), now: () => new Date(T0) },
    ),
  );
  const before = store.poolBalances(userId, T0 + DAY_MS);
  assert.equal(before.permanentQuota, 1_000_000, "永久池＝开帐基线");
  assert.equal(before.subscriptionQuota, 2_000_000, "订阅池＝本期发放");
  assert.equal(before.availableQuota, 3_000_000);

  const consumed = await withEnv(CONTROL_PLANE_ENV, () =>
    recordConsumption(
      { billingUserId: userId, amountQuota: 500_000, jobId: "job-d3-1", operationId: "op-d3-1", source: "billing-projection" },
      writerDeps(store),
    ),
  );
  assert.equal(consumed.posted, true);

  const after = store.poolBalances(userId, T0 + DAY_MS);
  assert.equal(after.subscriptionQuota, 1_500_000, "扣的是订阅池");
  assert.equal(after.permanentQuota, 1_000_000, "永久池一分未动");
  assert.equal(after.availableQuota, 2_500_000);

  const consumptionRow = store.rows.find((row) => row.idempotency_ref === "billing-op:op-d3-1:debit");
  assert.equal(consumptionRow?.pool, "subscription", "消费帐本行落在订阅池");
  assert.equal(consumptionRow?.term_ref, subscriptionTermRef(subscriptionIdFor(userId, "pro-monthly"), 1));
  assert.equal(consumptionRow?.amount, -500_000);
});

test("双池：没有订阅资料时，消费帐本行与 020 期间逐位相同（单腿、旧幂等键）", async () => {
  const store = fakeStore();
  await withEnv(CONTROL_PLANE_ENV, () =>
    recordConsumption(
      { billingUserId: 402, amountQuota: 250_000, jobId: "job-plain", operationId: "op-plain", source: "billing-projection" },
      writerDeps(store),
    ),
  );
  const row = store.rows.find((r) => r.idempotency_ref === "billing-op:op-plain:debit");
  assert.equal(row?.pool, "permanent");
  assert.equal(row?.term_ref, null);
  assert.equal(row?.expires_at, null);
  assert.equal(store.rows.filter((r) => r.entry_type === "consumption").length, 1, "只有一条消费腿");
  assert.equal(store.balanceOf(402), 750_000);
});

// ═══════════════════════════════════ ② lazy 过期（不依赖 cron）

test("lazy 过期：到期后可用额度下降，且帐本零改写（与「假装有 cron」的结果一致）", async () => {
  const store = fakeStore();
  const userId = 403;
  await withEnv(CONTROL_PLANE_ENV, () =>
    grantSubscriptionTermFromRedemption(
      { billingUserId: userId, sku: "pro-monthly", termQuota: 2_000_000, redemptionId: 9002, redeemedAt: new Date(T0).toISOString() },
      { ...writerDeps(store), now: () => new Date(T0) },
    ),
  );
  const expiresAtMs = T0 + 30 * DAY_MS;
  const snapshotBefore = JSON.stringify(store.rows);

  const beforeExpiry = await withEnv(CONTROL_PLANE_ENV, () => readPoolBalances(userId, { sql: store.sql, nowMs: expiresAtMs - 1 }));
  const afterExpiry = await withEnv(CONTROL_PLANE_ENV, () => readPoolBalances(userId, { sql: store.sql, nowMs: expiresAtMs }));
  const muchLater = await withEnv(CONTROL_PLANE_ENV, () => readPoolBalances(userId, { sql: store.sql, nowMs: expiresAtMs + 90 * DAY_MS }));

  assert.equal(beforeExpiry.availableQuota, 3_000_000, "到期前一毫秒仍可用");
  assert.equal(afterExpiry.availableQuota, 1_000_000, "到期那一刻起不可用（边界含等于）");
  assert.equal(muchLater.availableQuota, 1_000_000, "再久也一样（过期部分不再回来）");
  assert.equal(afterExpiry.expiredSubscriptionQuota, 2_000_000, "过期部分如实回报，不静默消失");
  assert.equal(afterExpiry.bookQuota, 3_000_000, "帐面净额不因过期而改变（权威帐本仍是原值）");

  // 「假装有 cron」＝另一条独立路径（纯函式直接算同一份记录集），结果必须逐位相同。
  const rows = poolRowsOf(store.rows, userId);
  assert.equal(availableQuotaOf(rows, expiresAtMs), afterExpiry.availableQuota);
  assert.equal(availableQuotaOf(rows, expiresAtMs + 90 * DAY_MS), muchLater.availableQuota);

  // 零改写：没有 UPDATE/DELETE、没有为了过期补写任何帐本行（真 cron 也不可能更准）。
  assert.equal(JSON.stringify(store.rows), snapshotBefore, "过期判定不得改写帐本");
  assert.equal(store.rows.filter((row) => row.entry_type === "expire").length, 0, "时间到不落帐（expire 只属于续期替换）");
});

// ═══════════════════════════════════ ③ 按原出资归还

test("按原出资归还：订阅消耗的退款回订阅池（永久池不动）", async () => {
  const store = fakeStore();
  const userId = 404;
  await withEnv(CONTROL_PLANE_ENV, () =>
    grantSubscriptionTermFromRedemption(
      { billingUserId: userId, sku: "pro-monthly", termQuota: 2_000_000, redemptionId: 9003, redeemedAt: new Date(T0).toISOString() },
      { ...writerDeps(store), now: () => new Date(T0) },
    ),
  );
  await withEnv(CONTROL_PLANE_ENV, () =>
    recordConsumption(
      { billingUserId: userId, amountQuota: 800_000, jobId: "job-sub", operationId: "op-sub", source: "billing-projection" },
      writerDeps(store),
    ),
  );
  const refunded = await withEnv(CONTROL_PLANE_ENV, () =>
    recordRefund(
      { billingUserId: userId, amountQuota: 800_000, jobId: "job-sub", operationId: "op-sub", source: "billing-ledger-refund" },
      writerDeps(store),
    ),
  );
  assert.equal(refunded.posted, true);

  const refundRow = store.rows.find((row) => row.idempotency_ref === "billing-op:op-sub:credit");
  assert.equal(refundRow?.pool, "subscription", "退款回到原出资池（订阅池）");
  assert.equal(refundRow?.term_ref, subscriptionTermRef(subscriptionIdFor(userId, "pro-monthly"), 1), "回原期");
  assert.equal(refundRow?.expires_at, new Date(T0 + 30 * DAY_MS).toISOString());

  const pools = store.poolBalances(userId, T0 + DAY_MS);
  assert.equal(pools.subscriptionQuota, 2_000_000, "订阅池回到消费前");
  assert.equal(pools.permanentQuota, 1_000_000, "永久池一分未动（不得跨池搬）");
});

test("按原出资归还：永久消耗的退款回永久池（订阅池不动）", async () => {
  const store = fakeStore();
  const userId = 405;
  await withEnv(CONTROL_PLANE_ENV, () =>
    grantSubscriptionTermFromRedemption(
      { billingUserId: userId, sku: "pro-monthly", termQuota: 2_000_000, redemptionId: 9004, redeemedAt: new Date(T0).toISOString() },
      { ...writerDeps(store), now: () => new Date(T0) },
    ),
  );
  // 指定永久池扣款（模拟永久池专属消费路径）。
  await withEnv(CONTROL_PLANE_ENV, () =>
    recordConsumption(
      { billingUserId: userId, amountQuota: 300_000, jobId: "job-perm", operationId: "op-perm", source: "billing-projection", pool: "permanent" },
      writerDeps(store),
    ),
  );
  await withEnv(CONTROL_PLANE_ENV, () =>
    recordRefund(
      { billingUserId: userId, amountQuota: 300_000, jobId: "job-perm", operationId: "op-perm", source: "billing-ledger-refund" },
      writerDeps(store),
    ),
  );
  const refundRow = store.rows.find((row) => row.idempotency_ref === "billing-op:op-perm:credit");
  assert.equal(refundRow?.pool, "permanent");
  const pools = store.poolBalances(userId, T0 + DAY_MS);
  assert.equal(pools.permanentQuota, 1_000_000, "永久池回到消费前");
  assert.equal(pools.subscriptionQuota, 2_000_000, "订阅池未被子系统挪用");
});

test("对抗性：多腿消费（订阅不足→溢出到永久池）的退款按腿归还，不跨池", async () => {
  const store = fakeStore();
  const userId = 406;
  await withEnv(CONTROL_PLANE_ENV, () =>
    grantSubscriptionTermFromRedemption(
      { billingUserId: userId, sku: "pro-monthly", termQuota: 200_000, redemptionId: 9005, redeemedAt: new Date(T0).toISOString() },
      { ...writerDeps(store), now: () => new Date(T0) },
    ),
  );
  await withEnv(CONTROL_PLANE_ENV, () =>
    recordConsumption(
      { billingUserId: userId, amountQuota: 500_000, jobId: "job-split", operationId: "op-split", source: "billing-projection" },
      writerDeps(store),
    ),
  );
  const legs = store.rows.filter((row) => row.operation_id === "op-split" && row.entry_type === "consumption");
  assert.equal(legs.length, 2, "两条出资腿");
  assert.deepEqual(
    legs.map((row) => [row.pool, row.amount]).sort(),
    [
      ["permanent", -300_000],
      ["subscription", -200_000],
    ],
  );

  await withEnv(CONTROL_PLANE_ENV, () =>
    recordRefund(
      { billingUserId: userId, amountQuota: 500_000, jobId: "job-split", operationId: "op-split", source: "billing-ledger-refund" },
      writerDeps(store),
    ),
  );
  const refundLegs = store.rows.filter((row) => row.operation_id === "op-split" && row.entry_type === "refund");
  const byPool = new Map(refundLegs.map((row) => [row.pool, row.amount]));
  assert.equal(byPool.get("permanent"), 300_000, "永久池那条腿退回永久池");
  assert.equal(byPool.get("subscription"), 200_000, "订阅池那条腿退回订阅池");
  assert.equal(refundLegs.reduce((sum, row) => sum + row.amount, 0), 500_000, "退款总额逐位等于消费总额");
  const pools = store.poolBalances(userId, T0 + DAY_MS);
  assert.equal(pools.subscriptionQuota, 200_000);
  assert.equal(pools.permanentQuota, 1_000_000);
});

test("对抗性：已过期期的消费退款回原期（原到期时刻）⇒ 该笔退款同样不可用（不假装有价值）", async () => {
  const store = fakeStore();
  const userId = 407;
  await withEnv(CONTROL_PLANE_ENV, () =>
    grantSubscriptionTermFromRedemption(
      { billingUserId: userId, sku: "pro-monthly", termQuota: 200_000, redemptionId: 9006, redeemedAt: new Date(T0).toISOString() },
      { ...writerDeps(store), now: () => new Date(T0) },
    ),
  );
  await withEnv(CONTROL_PLANE_ENV, () =>
    recordConsumption(
      { billingUserId: userId, amountQuota: 200_000, jobId: "job-late", operationId: "op-late", source: "billing-projection" },
      writerDeps(store),
    ),
  );
  await withEnv(CONTROL_PLANE_ENV, () =>
    recordRefund(
      { billingUserId: userId, amountQuota: 200_000, jobId: "job-late", operationId: "op-late", source: "billing-ledger-refund" },
      writerDeps(store),
    ),
  );
  const refundRow = store.rows.find((row) => row.idempotency_ref === "billing-op:op-late:credit");
  assert.equal(refundRow?.pool, "subscription");
  assert.equal(refundRow?.expires_at, new Date(T0 + 30 * DAY_MS).toISOString(), "带回原到期时刻");
  const expired = store.poolBalances(userId, T0 + 31 * DAY_MS);
  assert.equal(expired.availableQuota, 1_000_000, "退款没有让可用额度变多（原期已过期）");
  assert.equal(expired.subscriptionQuota, 0);
});

// ═══════════════════════════════════ ④ 期次幂等与替换语义

test("期次幂等：同一张兑换码重放不双发（同期次只落一次帐）", async () => {
  const store = fakeStore();
  const userId = 408;
  const redemption = subscriptionRedemption({ id: 9101, sku: "pro-monthly", quota: 1_000_000, userId, redeemedAtMs: T0 + 1000 });
  const readRedemptions = async () => [redemption];
  const deps = { sql: store.sql, readRedemptions, fetchUser: async (id: number) => gatewayUser(id, 500_000), now: () => new Date(T0) };

  const first = await withEnv(CONTROL_PLANE_ENV, () => ingestSubscriptionRedemptions({}, deps));
  assert.equal(first.scanned, 1);
  assert.equal(first.granted, 1);
  assert.equal(store.rows.filter((row) => row.entry_type === "recharge" && row.pool === "subscription").length, 1);

  const replay = await withEnv(CONTROL_PLANE_ENV, () => ingestSubscriptionRedemptions({}, deps));
  assert.equal(replay.granted, 0, "重放不得再发一期");
  assert.equal(replay.skippedAlreadyGranted, 1);
  assert.equal(store.rows.filter((row) => row.entry_type === "recharge" && row.pool === "subscription").length, 1);
  assert.equal(store.poolBalances(userId, T0 + DAY_MS).subscriptionQuota, 1_000_000, "重放不得让余额翻倍");
  assert.equal(store.balanceOf(userId), 1_500_000);
});

test("期次替换（预设 replace）：下一期取代旧期未用完余额，不累加", async () => {
  const store = fakeStore();
  const userId = 409;
  const grant = (redemptionId: number, termQuota: number, atMs: number) =>
    withEnv(CONTROL_PLANE_ENV, () =>
      grantSubscriptionTermFromRedemption(
        { billingUserId: userId, sku: "pro-monthly", termQuota, redemptionId, redeemedAt: new Date(atMs).toISOString() },
        { ...writerDeps(store), now: () => new Date(atMs) },
      ),
    );

  const term1 = await grant(9201, 1_000_000, T0);
  assert.equal(term1.termIndex, 1);
  assert.equal(term1.granted, true);

  // 第 1 期用掉 400,000，剩 600,000 未用完。
  await withEnv(CONTROL_PLANE_ENV, () =>
    recordConsumption(
      { billingUserId: userId, amountQuota: 400_000, jobId: "job-t1", operationId: "op-t1", source: "billing-projection" },
      writerDeps(store),
    ),
  );
  assert.equal(store.poolBalances(userId, T0 + DAY_MS).subscriptionQuota, 600_000);

  // 续期（第 2 期）：新期 1,000,000 取代旧期未用完的 600,000。
  const term2 = await grant(9202, 1_000_000, T0 + 10 * DAY_MS);
  assert.equal(term2.termIndex, 2, "期次序号由帐本推导（不是本地游标）");
  assert.equal(term2.replacedQuota, 600_000, "旧期未用完余额被作废");

  const replaceRow = store.rows.find((row) => row.entry_type === "expire");
  assert.equal(replaceRow?.amount, -600_000, "作废是减项");
  assert.equal(replaceRow?.term_ref, subscriptionTermRef(subscriptionIdFor(userId, "pro-monthly"), 1), "作废的是第 1 期");
  assert.equal(replaceRow?.expires_at, new Date(T0 + 30 * DAY_MS).toISOString(), "作废行带旧期到期时刻");

  const afterRenew = store.poolBalances(userId, T0 + 11 * DAY_MS);
  assert.equal(afterRenew.subscriptionQuota, 1_000_000, "可用订阅余额＝新期额度（非 600,000+1,000,000）");
  assert.equal(afterRenew.permanentQuota, 1_000_000, "续期不动永久池");
  assert.equal(afterRenew.availableQuota, 2_000_000);

  // 幂等：同一张第 2 期兑换码重放，不得再作废一次、也不得再发一期。
  const replay = await grant(9202, 1_000_000, T0 + 11 * DAY_MS);
  assert.equal(replay.granted, false);
  assert.equal(store.rows.filter((row) => row.entry_type === "expire").length, 1);
  assert.equal(store.poolBalances(userId, T0 + 12 * DAY_MS).subscriptionQuota, 1_000_000);
  // 帐面净额：1,000,000 基线 + 1,000,000 第1期 − 400,000 消费 + 1,000,000 第2期 − 600,000 作废 = 2,000,000
  assert.equal(store.balanceOf(userId), 2_000_000);
});

test("替换语义的翻转点：累积模式（accumulate）不作废任何旧期余额", () => {
  assert.equal(SUBSCRIPTION_RENEWAL_MODE, "replace", "预设＝按期替换");
  assert.equal(replacedQuotaForRenewal(600_000, "replace"), 600_000);
  assert.equal(replacedQuotaForRenewal(600_000, "accumulate"), 0, "翻转成 accumulate 就完全不写 expire 行");
  assert.equal(replacedQuotaForRenewal(-5, "replace"), 0, "负余额没东西可作废");
});

test("期次与过期语义：一期 = 发放时刻起算的 termSeconds，期次身份含订阅 id", () => {
  assert.equal(subscriptionIdFor(42, "pro-monthly"), "sub-42-pro-monthly");
  assert.equal(subscriptionTermRef("sub-42-pro-monthly", 3), "sub:sub-42-pro-monthly:term:3");
  const window = subscriptionTermWindow(T0, 30 * 24 * 3600);
  assert.equal(window.startMs, T0);
  assert.equal(window.endMs, T0 + 30 * DAY_MS);
  assert.equal(window.expiresAt, new Date(T0 + 30 * DAY_MS).toISOString());
  // 续期时长与到期时刻：早期续期＝从续费那一刻重新起算（替换语义的必然结果）。
  const renewed = subscriptionTermWindow(T0 + 10 * DAY_MS, 30 * 24 * 3600);
  assert.equal(renewed.expiresAt, new Date(T0 + 40 * DAY_MS).toISOString());
});

// ═══════════════════════════════════ ⑤ 兑换码通道与防双算

test("防双算：带订阅标记的兑换码只走订阅通道，永久充值通道跳过它（两个方向皆成立）", async () => {
  const store = fakeStore();
  const userId = 410;
  const redemption = subscriptionRedemption({ id: 9301, sku: "pro-monthly", quota: 2_000_000, userId, redeemedAtMs: T0 + 1000 });
  const readRedemptions = async () => [redemption];
  const fetchUser = async (id: number) => gatewayUser(id, 700_000);
  const now = () => new Date(T0);

  // ① 先跑永久充值入帐：必须跳过（不得记 recharge）。
  const rechargeFirst = await withEnv(CONTROL_PLANE_ENV, () =>
    ingestRedeemedRecharges({}, { sql: store.sql, readRedemptions, fetchUser }),
  );
  assert.equal(rechargeFirst.skippedSubscription, 1);
  assert.equal(rechargeFirst.charged, 0);
  assert.equal(store.rows.filter((row) => row.pool === "permanent" && row.entry_type === "recharge").length, 0);

  // ② 再跑订阅通道：发一期。
  const subFirst = await withEnv(CONTROL_PLANE_ENV, () =>
    ingestSubscriptionRedemptions({}, { sql: store.sql, readRedemptions, fetchUser, now }),
  );
  assert.equal(subFirst.granted, 1);

  // ③ 两个通道都再跑一轮：仍然只有一笔钱。
  await withEnv(CONTROL_PLANE_ENV, () => ingestRedeemedRecharges({}, { sql: store.sql, readRedemptions, fetchUser }));
  await withEnv(CONTROL_PLANE_ENV, () => ingestSubscriptionRedemptions({}, { sql: store.sql, readRedemptions, fetchUser, now }));

  const moneyRows = store.rows.filter((row) => row.source_ref === "redemption:9301" || row.source_ref.startsWith("redemption:9301/"));
  assert.equal(moneyRows.length, 1, "同一张码只准一笔入帐");
  assert.equal(moneyRows[0].pool, "subscription");
  assert.equal(moneyRows[0].amount, 2_000_000);
  const pools = store.poolBalances(userId, T0 + DAY_MS);
  assert.equal(pools.permanentQuota, 700_000, "永久池只有基线，没有多一笔充值");
  assert.equal(pools.subscriptionQuota, 2_000_000);
  assert.equal(store.balanceOf(userId), 2_700_000);
});

test("兑换码通道：未兑换的订阅码不发放（发码 ≠ 入帐），基线前兑换的也不重复发", async () => {
  const store = fakeStore();
  const userId = 411;
  // 先种基线（基线时刻 = 假时钟第一笔）。
  await withEnv(CONTROL_PLANE_ENV, () =>
    grantSubscriptionTermFromRedemption(
      { billingUserId: userId, sku: "pro-monthly", termQuota: 1_000_000, redemptionId: 9400, redeemedAt: new Date(T0).toISOString() },
      { ...writerDeps(store), now: () => new Date(T0) },
    ),
  );
  const before = store.poolBalances(userId, T0 + DAY_MS).availableQuota;

  const items: GatewayRedemption[] = [
    { id: 9401, key: "k1", name: subscriptionCodeName("pro-monthly", "o1"), quota: 5_000_000, status: 1, redeemed_time: 0 },
    subscriptionRedemption({ id: 9402, sku: "pro-monthly", quota: 9_000_000, userId, redeemedAtMs: T0 - 5 * DAY_MS }),
  ];
  const summary = await withEnv(CONTROL_PLANE_ENV, () =>
    ingestSubscriptionRedemptions({}, {
      sql: store.sql,
      readRedemptions: async () => items,
      fetchUser: async (id: number) => gatewayUser(id, 1_000_000),
      now: () => new Date(T0 + DAY_MS),
    }),
  );
  // 未使用的码用于开通订阅不存在（fetchUser 读回来才种基线，故基线时刻 = 现在）
  assert.equal(summary.granted, 0, "没有任何一笔被发放");
  assert.equal(store.poolBalances(userId, T0 + DAY_MS).availableQuota, before);
  assert.ok(summary.skippedUnused + summary.skippedBeforeBaseline >= 2, JSON.stringify(summary));
});

test("对抗性：基线前已兑换的订阅码不发放（避免与 opening 基线双算）", async () => {
  const store = fakeStore();
  const userId = 412;
  await withEnv(CONTROL_PLANE_ENV, () =>
    grantSubscriptionTermFromRedemption(
      { billingUserId: userId, sku: "pro-monthly", termQuota: 1_000_000, redemptionId: 9500, redeemedAt: new Date(T0).toISOString() },
      { ...writerDeps(store), now: () => new Date(T0) },
    ),
  );
  const rowsBefore = store.rows.length;
  const summary = await withEnv(CONTROL_PLANE_ENV, () =>
    ingestSubscriptionRedemptions({}, {
      sql: store.sql,
      readRedemptions: async () => [subscriptionRedemption({ id: 9501, sku: "pro-monthly", quota: 3_000_000, userId, redeemedAtMs: T0 - 10 * DAY_MS })],
      fetchUser: async (id: number) => gatewayUser(id, 1_000_000),
      now: () => new Date(T0 + DAY_MS),
    }),
  );
  assert.equal(summary.granted, 0);
  assert.equal(summary.skippedBeforeBaseline, 1);
  assert.equal(store.rows.length, rowsBefore, "不得新增任何帐本行");
});

test("兑换码标记：只有严格格式才算订阅码（非订阅码走既有永久充值路径）", () => {
  assert.deepEqual(parseSubscriptionCodeMarker("SUB-pro-monthly@order-1"), { sku: "pro-monthly", ref: "order-1" });
  assert.equal(parseSubscriptionCodeMarker("MP3c9f0a1b"), null, "mPay 名不是订阅码");
  assert.equal(parseSubscriptionCodeMarker("eimu1500"), null, "人工码不是订阅码");
  assert.equal(parseSubscriptionCodeMarker("SUB-@x"), null, "缺 SKU");
  assert.equal(parseSubscriptionCodeMarker("SUB-pro monthly@x"), null, "含空白");
  assert.equal(parseSubscriptionCodeMarker(null), null);
  assert.ok(subscriptionCodeName("pro-monthly", "o1").startsWith(SUBSCRIPTION_CODE_NAME_PREFIX));
});

test("充值必兑现：标记认得但 SKU 未注册 ⇒ 仍按期长兜底发放（不让用户拿不到额度）并留审计", async () => {
  const store = fakeStore();
  const userId = 413;
  const summary = await withEnv(CONTROL_PLANE_ENV, () =>
    ingestSubscriptionRedemptions({}, {
      sql: store.sql,
      readRedemptions: async () => [
        subscriptionRedemption({ id: 9601, sku: "beta-special", quota: 4_000_000, userId, redeemedAtMs: T0 + 1000 }),
      ],
      fetchUser: async (id: number) => gatewayUser(id, 0),
      now: () => new Date(T0),
    }),
  );
  assert.equal(summary.unknownSku, 1);
  assert.equal(summary.granted, 1, "仍要发（钱是真的）");
  const grant = store.rows.find((row) => row.source_ref === "redemption:9601");
  assert.equal(grant?.amount, 4_000_000);
  assert.equal(grant?.pool, "subscription");
  // 兜底期长 30 天：到期时刻 = 发放 + 30 天。
  assert.equal(grant?.expires_at, new Date(T0 + 30 * DAY_MS).toISOString());
});

// ═══════════════════════════════════ ⑥ 预检与 402 串接（契约不破）

test("预检走生效池口径：可用＝永久＋未过期订阅，不足与充足共用既有 402 契约", async () => {
  const userId = 414;
  // 充足（订阅池把可用撑过门槛）
  const ok = await checkQuotaAvailable(
    { billingUserId: userId, requiredQuota: 900_000 },
    { readAvailableQuota: async () => 1_400_000, fetchUser: async () => user(0) },
  );
  assert.deepEqual(ok, { verdict: "available", quota: 1_400_000 });

  // 不足（订阅已过期 ⇒ 可用只剩永久池）
  const insufficient = await checkQuotaAvailable(
    { billingUserId: userId, requiredQuota: 900_000 },
    { readAvailableQuota: async () => 800_000, fetchUser: async () => user(0) },
  );
  assert.deepEqual(insufficient, { verdict: "insufficient", quota: 800_000, requiredQuota: 900_000 });

  function user(quota: number) {
    return gatewayUser(userId, quota);
  }
});

test("预检：帐本读不到 ⇒ 回落既有 users.quota 读法（可用性不降级）", async () => {
  const verdict = await checkQuotaAvailable(
    { billingUserId: 415, requiredQuota: 500_000 },
    { readAvailableQuota: async () => null, fetchUser: async (id) => gatewayUser(id, 582_377_145) },
  );
  assert.deepEqual(verdict, { verdict: "available", quota: 582_377_145 });
  const unreachable = await checkQuotaAvailable(
    { billingUserId: 415, requiredQuota: 500_000 },
    { readAvailableQuota: async () => null, fetchUser: async () => null },
  );
  assert.equal(unreachable.verdict, "unreachable");
  // 帐本读数抛错 ⇒ 也算读不到（回落），不得让任务路径失败。
  const thrown = await checkQuotaAvailable(
    { billingUserId: 415, requiredQuota: 500_000 },
    { readAvailableQuota: async () => { throw new Error("boom"); }, fetchUser: async (id) => gatewayUser(id, 600_000) },
  );
  assert.deepEqual(thrown, { verdict: "available", quota: 600_000 });
});

test("402 契约不破：不足时的状态码/错误码/文案与现状逐字相同；充足时仍走零额快车道", async () => {
  const gate = (quota: number) =>
    enforceQuotaGate(
      { bizKeyId: "key-d3", billingUserId: 416, baseBillingAmount: 250_000 },
      {
        env: { [SURGERY_QUOTA_PRECHECK_ENV]: "1" },
        findMember: async () => null,
        readAvailableQuota: async () => quota,
        fetchUser: async (id) => gatewayUser(id, quota),
      },
    );

  const denied = await gate(100_000);
  assert.deepEqual(denied, {
    ok: false,
    status: 402,
    // a9ceb2f0（2026-09-28）已把 402 契约统一为 insufficient_balance。
    type: "insufficient_balance",
    code: "insufficient_balance",
    message: "余额不足，本次未扣费。充值：https://eimu.dev/pricing",
  });

  const allowed = await gate(900_000);
  assert.deepEqual(allowed, { ok: true, billingAmount: 0 }, "充足 ⇒ 0 额快车道（既有行为）");
});

test("契约不破：/v1/quota 回应形状不变，且无订阅时可用余额＝帐面净额（回归逐位等价）", async () => {
  const store = fakeStore();
  const userId = 417;
  await withEnv(CONTROL_PLANE_ENV, () =>
    recordConsumption(
      { billingUserId: userId, amountQuota: 500_000, jobId: "job-shape", operationId: "op-shape", source: "billing-projection" },
      writerDeps(store),
    ),
  );
  const pools = await withEnv(CONTROL_PLANE_ENV, () => readPoolBalances(userId, { sql: store.sql, nowMs: T0 }));
  const book = computeAccountBalance(
    await withEnv(CONTROL_PLANE_ENV, () => readAccountLedger(userId, { sql: store.sql })),
    userId,
  );
  assert.equal(pools.availableQuota, book.quota, "没有订阅帐本行时两口径逐位相同（020 行为不变）");
  assert.equal(pools.subscriptionQuota, 0);
  assert.equal(pools.permanentQuota, book.quota);

  const body = quotaResponseBody(pools.availableQuota);
  assert.deepEqual(Object.keys(body).sort(), ["balance_coins", "currency", "success"]);
  assert.equal(body.balance_coins, (1_000_000 - 500_000) / QUOTA_PER_COIN);
  assert.equal(body.currency, "coins");
  assert.equal(body.success, true);
});

// ═══════════════════════════════════ ⑦ 对抗性：超额消费与缺栏位

test("对抗性：可用不足时的消费如实记满（不截断、不凭空多出），超出部分记在永久池", async () => {
  const store = fakeStore();
  const userId = 418;
  await withEnv(CONTROL_PLANE_ENV, () =>
    grantSubscriptionTermFromRedemption(
      { billingUserId: userId, sku: "pro-monthly", termQuota: 100_000, redemptionId: 9701, redeemedAt: new Date(T0).toISOString() },
      { ...writerDeps(store), now: () => new Date(T0) },
    ),
  );
  await withEnv(CONTROL_PLANE_ENV, () =>
    recordConsumption(
      { billingUserId: userId, amountQuota: 500_000, jobId: "job-over", operationId: "op-over", source: "billing-projection" },
      writerDeps(store),
    ),
  );
  const legs = store.rows.filter((row) => row.operation_id === "op-over");
  assert.equal(legs.reduce((sum, row) => sum + row.amount, 0), -500_000, "帐本记满真实扣款");
  const pools = store.poolBalances(userId, T0 + DAY_MS);
  assert.equal(pools.subscriptionQuota, 0, "订阅池扣光");
  assert.equal(pools.permanentQuota, 600_000, "溢出部分记在永久池（基线 1,000,000 − 400,000）");
  assert.equal(pools.availableQuota, 600_000);
});

test("对抗性：订阅池帐本行缺 term_ref/expires_at 一律拒收（lazy 过期不可无依据）", async () => {
  const base: LedgerEntryDraft = {
    billingUserId: 419,
    entryType: "recharge",
    amount: 100_000,
    source: "test",
    sourceRef: "redemption:1",
    idempotencyRef: "subscription:x:term:1",
    pool: "subscription",
  };
  assert.match(validateLedgerEntryDraft(base) ?? "", /term_ref/);
  assert.match(validateLedgerEntryDraft({ ...base, termRef: "sub:x:term:1" }) ?? "", /expires_at/);
  assert.equal(
    validateLedgerEntryDraft({ ...base, termRef: "sub:x:term:1", expiresAt: new Date(T0).toISOString() }),
    null,
  );
  assert.match(validateLedgerEntryDraft({ ...base, pool: "vip", termRef: "t", expiresAt: new Date(T0).toISOString() }) ?? "", /未知的 pool/);
  // 永久池不受此约束（020 既有行为）。
  assert.equal(validateLedgerEntryDraft({ ...base, pool: "permanent" }), null);

  const store = fakeStore();
  const result = await postLedgerEntries([base], { sql: store.sql });
  assert.equal(result.inserted.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(store.rows.length, 0, "拒收的行不得落库");
});

test("对抗性：纯函式层（planner）不因空帐、负余额、重复期次而发明金额", () => {
  const empty = computePoolBalances([], T0);
  assert.deepEqual(
    { permanent: empty.permanentQuota, subscription: empty.subscriptionQuota, available: empty.availableQuota },
    { permanent: 0, subscription: 0, available: 0 },
  );
  assert.deepEqual(planConsumptionLegs(500_000, empty), [
    { pool: "permanent", termRef: null, expiresAt: null, amountQuota: 500_000 },
  ], "全空时唯一一腿＝永久池，且不截断");

  const balances = computePoolBalances(
    [
      { amount: 300_000, pool: "subscription", termRef: "sub:a:term:1", expiresAt: new Date(T0 + DAY_MS).toISOString() },
      { amount: 0, pool: "permanent" },
    ],
    T0,
  );
  const legs = planConsumptionLegs(300_000, balances);
  assert.deepEqual(legs, [
    { pool: "subscription", termRef: "sub:a:term:1", expiresAt: new Date(T0 + DAY_MS).toISOString(), amountQuota: 300_000 },
  ]);
  // 退款分摊：退款大于已记录消耗时仍不跨池（记在最后一条出资腿的池）。
  const refund = planRefundLegs(500_000, [{ pool: "subscription", termRef: "sub:a:term:1", expiresAt: new Date(T0 + DAY_MS).toISOString(), consumedQuota: 300_000 }], {
    nowMs: T0,
  });
  assert.equal(refund.length, 1);
  assert.equal(refund[0].pool, "subscription");
  assert.equal(refund[0].amountQuota, 500_000);
});

// ═══════════════════════════════════ ⑧ 订阅检视（只读）

test("订阅检视：回报期次、到期、可用与帐面余额（过期后 available 降、书面值不变）", async () => {
  const store = fakeStore();
  const userId = 420;
  await withEnv(CONTROL_PLANE_ENV, () =>
    grantSubscriptionTermFromRedemption(
      { billingUserId: userId, sku: "pro-monthly", termQuota: 1_200_000, redemptionId: 9801, redeemedAt: new Date(T0).toISOString() },
      { ...writerDeps(store), now: () => new Date(T0) },
    ),
  );
  const view = await withEnv(CONTROL_PLANE_ENV, () => readSubscriptions(userId, { sql: store.sql, nowMs: T0 + DAY_MS }));
  assert.equal(view.length, 1);
  assert.equal(view[0].termIndex, 1);
  assert.equal(view[0].termQuota, 1_200_000);
  assert.equal(view[0].availableQuota, 1_200_000);
  assert.equal(view[0].bookQuota, 1_200_000);
  assert.equal(view[0].expired, false);

  const expiredView = await withEnv(CONTROL_PLANE_ENV, () =>
    readSubscriptions(userId, { sql: store.sql, nowMs: T0 + 31 * DAY_MS }),
  );
  assert.equal(expiredView[0].expired, true);
  assert.equal(expiredView[0].availableQuota, 0);
  assert.equal(expiredView[0].bookQuota, 1_200_000, "帐面仍记著这笔钱（过期不改历史）");
});

test("对抗性：并发发放同一期次（两个 worker 同时扫到）⇒ 帐本 UNIQUE 挡住，只落一次", async () => {
  const store = fakeStore();
  const userId = 421;
  const call = (redemptionId: number) =>
    withEnv(CONTROL_PLANE_ENV, () =>
      grantSubscriptionTermFromRedemption(
        { billingUserId: userId, sku: "pro-monthly", termQuota: 1_000_000, redemptionId, redeemedAt: new Date(T0).toISOString() },
        { ...writerDeps(store), now: () => new Date(T0) },
      ),
    );
  const [a, b] = await Promise.all([call(9901), call(9901)]);
  assert.equal([a, b].filter((outcome) => outcome.granted).length, 1, "同期次只能发一次");
  assert.equal(store.rows.filter((row) => row.pool === "subscription").length, 1);
  assert.equal(store.poolBalances(userId, T0 + DAY_MS).subscriptionQuota, 1_000_000, "余额不得翻倍");

  // 败方下一轮（重扫）看到同码已发放 ⇒ 不再补发。
  const retry = await call(9901);
  assert.equal(retry.granted, false);
  assert.equal(store.rows.filter((row) => row.pool === "subscription").length, 1);
});

test("对抗性：两张不同兑换码并发抢同一期次 ⇒ 败方在下一轮补发（钱不丢，期次递延）", async () => {
  const store = fakeStore();
  const userId = 422;
  const call = (redemptionId: number) =>
    withEnv(CONTROL_PLANE_ENV, () =>
      grantSubscriptionTermFromRedemption(
        { billingUserId: userId, sku: "pro-monthly", termQuota: 1_000_000, redemptionId, redeemedAt: new Date(T0).toISOString() },
        { ...writerDeps(store), now: () => new Date(T0) },
      ),
    );
  const [first, second] = await Promise.all([call(9911), call(9912)]);
  assert.equal([first, second].filter((outcome) => outcome.granted).length, 1);
  // 败方重扫（同一张码、下一轮）：拿到下一期，钱一分不少。
  const loserId = first.granted ? 9912 : 9911;
  const healed = await call(loserId);
  assert.equal(healed.granted, true, "败方必须在下一轮补发（不得静默吞掉一笔已付款的订阅）");
  assert.equal(healed.termIndex, 2);
  const grantRows = store.rows.filter((row) => row.pool === "subscription" && row.entry_type === "recharge");
  assert.equal(grantRows.length, 2, "两笔付款 = 两期发放");
  assert.equal(grantRows.reduce((sum, row) => sum + row.amount, 0), 2_000_000);
});

// ═══════════════════════════════════ ⑨ 发码端 ↔ 入帐端（标记约定端到端）

test("发码端：产生的码名带 SKU 标记，且先搜后建（重复履约不产生第二张可兑换的码）", async () => {
  const requests: { method: string; url: string; body?: string }[] = [];
  const adminEnv = { GATEWAY_ADMIN_ACCESS_TOKEN: "tok", GATEWAY_ADMIN_USER_ID: "1", GATEWAY_BASE_URL: "http://gw" };
  let created: { key: string; name: string; quota: number } | null = null;

  const fetcher = (async (url: string, init?: RequestInit) => {
    requests.push({ method: init?.method ?? "GET", url, body: init?.body as string | undefined });
    if ((init?.method ?? "GET") === "POST") {
      const body = JSON.parse(String(init?.body)) as { name: string; quota: number };
      created = { key: "k-sub-1", name: body.name, quota: body.quota };
      return new Response(JSON.stringify({ success: true, data: ["k-sub-1"] }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ success: true, data: { items: created ? [created] : [] } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const { fulfillSubscriptionRedemption } = await import("@/lib/subscription-redemption");
  const first = await withEnv({}, () =>
    fulfillSubscriptionRedemption({ plan: { sku: "pro-monthly", orderId: "ord-7", quota: 750_000_000 } }, adminEnv, fetcher),
  );
  assert.equal(first.created, true);
  assert.deepEqual(parseSubscriptionCodeMarker(first.name), { sku: "pro-monthly", ref: "ord-7" });
  const createRequest = requests.find((request) => request.method === "POST");
  assert.ok(createRequest, "必须发一次建码请求");
  assert.equal(JSON.parse(String(createRequest.body)).name, first.name, "码名（标记载体）由我方写入");
  assert.equal(JSON.parse(String(createRequest.body)).quota, 750_000_000);

  const second = await withEnv({}, () =>
    fulfillSubscriptionRedemption({ plan: { sku: "pro-monthly", orderId: "ord-7", quota: 750_000_000 } }, adminEnv, fetcher),
  );
  assert.equal(second.created, false, "同名同额已存在 ⇒ 不得再建一张");
  assert.equal(second.key, "k-sub-1");
  assert.equal(requests.filter((request) => request.method === "POST").length, 1, "整段只准一次建码");
});

test("端到端：发码端写的 name → 入帐端认出 → 发一期（标记约定真的闭合）", async () => {
  const store = fakeStore();
  const userId = 423;
  const codeName = subscriptionCodeName("pro-yearly", "ord-e2e");
  const redemption: GatewayRedemption = {
    id: 9999,
    key: "k-e2e",
    name: codeName,
    quota: 5_000_000,
    status: 2,
    used_user_id: userId,
    redeemed_time: Math.floor((T0 + 1000) / 1000),
  };
  const summary = await withEnv(CONTROL_PLANE_ENV, () =>
    ingestSubscriptionRedemptions({}, {
      sql: store.sql,
      readRedemptions: async () => [redemption],
      fetchUser: async (id: number) => gatewayUser(id, 0),
      now: () => new Date(T0),
    }),
  );
  assert.equal(summary.granted, 1);
  const grant = store.rows.find((row) => row.source_ref === "redemption:9999");
  assert.equal(grant?.pool, "subscription");
  assert.equal(grant?.amount, 5_000_000);
  // pro-yearly 的期长 = 365 天（SKU 注册表生效，不是兜底值）。
  assert.equal(grant?.expires_at, new Date(T0 + 365 * DAY_MS).toISOString());

  // 阴性对照：旧通道（mPay 的 MP 名）不会被订阅通道认领——标记是承重的。
  const mpayStyle = await withEnv(CONTROL_PLANE_ENV, () =>
    ingestSubscriptionRedemptions({}, {
      sql: store.sql,
      readRedemptions: async () => [{ id: 9998, key: "k-mp", name: "MPabc123", quota: 5_000_000, status: 2, used_user_id: userId, redeemed_time: Math.floor(T0 / 1000) }],
      fetchUser: async (id: number) => gatewayUser(id, 0),
      now: () => new Date(T0),
    }),
  );
  assert.equal(mpayStyle.scanned, 0, "非订阅码不进订阅通道");
});

// ═══════════════════════════════════ 变更探针（只算探针，不计入已验证）

test("变更探针：migration 022 有池维度三栏、订阅表与唯一来源约束", () => {
  const ddl = readFileSync(join(process.cwd(), "db/migrations/022_subscription_pools.sql"), "utf8");
  assert.match(ddl, /ADD COLUMN IF NOT EXISTS pool text NOT NULL DEFAULT 'permanent'/);
  assert.match(ddl, /ADD COLUMN IF NOT EXISTS term_ref text/);
  assert.match(ddl, /ADD COLUMN IF NOT EXISTS expires_at timestamptz/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS subscription/);
  assert.match(ddl, /source_ref text NOT NULL UNIQUE/);
  assert.match(ddl, /'expire'/);
});
