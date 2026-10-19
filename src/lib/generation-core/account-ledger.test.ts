// REQ-E1a 我方帐本（account-ledger）测试：加减项模型、余额公式、基线种子幂等、
// 转移两条腿、充值入帐、以及「记帐失败不挡钱路」。
//
// 验收姿势（AGENTS.md 09-23）：每一条都是**真实行为断言**（真输入 → 真输出），
// 不是源码字串扫描。源码扫描（append-only 守门）只作变更探针，另列。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import type { GenerationSql } from "./database.ts";
import {
  computeAccountBalance,
  ensureAccountOpening,
  ingestRedeemedRecharges,
  ledgerDirectionOf,
  postLedgerEntries,
  quotaResponseBody,
  readAccountBalance,
  recordAdjustment,
  recordConsumption,
  recordRecharge,
  recordRefund,
  recordTransfer,
  validateLedgerEntryDraft,
  type LedgerEntry,
  type LedgerEntryDraft,
} from "./account-ledger.ts";
import type { GatewayAdminUser, GatewayRedemption } from "@/lib/gateway-admin";

/** 写入器注入：基线读法走假上游（生产默认 fetchGatewayUser）。 */
function writerDeps(ledger: ReturnType<typeof fakeLedger>, baseline = 1_000_000) {
  return {
    sql: ledger.sql,
    fetchUser: async (id: number) => gatewayUser(id, baseline),
  };
}

const CONTROL_PLANE_ENV = {
  GENERATION_DATABASE_URL: "postgres://fake:fake@127.0.0.1:1/fake",
  GENERATION_CONTROL_PLANE_ENABLED: "true",
};

/** 环境覆写（async-aware：非同步任务跑完才还原，否则 async fn 会看到已还原的环境）。 */
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

// ── 假帐本 SQL：记忆体表 + 真 UNIQUE(idempotency_ref) + 真 ON CONFLICT DO NOTHING ──

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
  created_at: string;
}

function fakeLedger(seed: { rows?: FakeLedgerRow[]; failInsert?: boolean; clock?: () => string } = {}) {
  const rows: FakeLedgerRow[] = [...(seed.rows ?? [])];
  const inserts: string[] = [];
  let insertedAt = 0;
  const now = seed.clock ?? (() => new Date(Date.UTC(2026, 8, 23, 0, 0, insertedAt++)).toISOString());

  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ? ").replace(/\s+/g, " ").trim();

    if (query.startsWith("INSERT INTO account_ledger")) {
      if (seed.failInsert) throw new Error("fake ledger insert failure");
      const [id, billingUserId, entryType, amount, source, sourceRef, idempotencyRef, jobId, operationId, counterparty, note, metadata] =
        values as [string, number, string, number, string, string, string, string | null, string | null, number | null, string | null, string];
      if (rows.some((row) => row.idempotency_ref === idempotencyRef)) return []; // ON CONFLICT DO NOTHING
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
        created_at: now(),
      });
      inserts.push(idempotencyRef);
      return [{ id, idempotency_ref: idempotencyRef }];
    }

    if (query.includes("SELECT amount FROM account_ledger WHERE idempotency_ref")) {
      const row = rows.find((candidate) => candidate.idempotency_ref === values[0]);
      return row ? [{ amount: row.amount }] : [];
    }
    // 基线冲销两条腿的存在性探测（`WHERE idempotency_ref IN (…, …)`）。
    if (query.includes("SELECT idempotency_ref FROM account_ledger") && query.includes("IN")) {
      const wanted = new Set(values.map((value) => String(value)));
      return rows
        .filter((row) => wanted.has(row.idempotency_ref))
        .map((row) => ({ idempotency_ref: row.idempotency_ref }));
    }
    if (query.includes("SELECT created_at FROM account_ledger WHERE idempotency_ref")) {
      const row = rows.find((candidate) => candidate.idempotency_ref === values[0]);
      return row ? [{ created_at: row.created_at }] : [];
    }
    if (query.includes("FROM account_ledger WHERE billing_user_id")) {
      return rows.filter((row) => row.billing_user_id === Number(values[0])).map((row) => ({ ...row }));
    }
    if (query.includes("SELECT DISTINCT billing_user_id FROM account_ledger")) {
      const ids = [...new Set(rows.map((row) => row.billing_user_id))].sort((a, b) => a - b);
      return ids.map((id) => ({ billing_user_id: id, total_identities: ids.length }));
    }
    if (query.includes("FROM billing_operation")) return [];
    throw new Error(`fakeLedger: 未预期的查询：${query}`);
  }) as unknown as GenerationSql;

  Object.assign(tagged, {
    begin: async (fn: (tx: GenerationSql) => Promise<unknown>) => fn(tagged),
  });

  return {
    sql: tagged,
    rows,
    inserts,
    balanceOf(userId: number) {
      return rows.filter((row) => row.billing_user_id === userId).reduce((sum, row) => sum + row.amount, 0);
    },
  };
}

function gatewayUser(id: number, quota: number): GatewayAdminUser {
  return { id, username: `user-${id}`, quota };
}

// ── 加减项模型（纯函式，真输入真输出） ────────────────────────────────────

test("加减项判别表：消费/转出是减项、充值/退款/转入是加项，基线与调整看符号", () => {
  assert.equal(ledgerDirectionOf("consumption", -100), "debit");
  assert.equal(ledgerDirectionOf("transfer_out", -100), "debit");
  assert.equal(ledgerDirectionOf("recharge", 100), "credit");
  assert.equal(ledgerDirectionOf("refund", 100), "credit");
  assert.equal(ledgerDirectionOf("transfer_in", 100), "credit");
  assert.equal(ledgerDirectionOf("opening", -100), "debit");
  assert.equal(ledgerDirectionOf("opening", 100), "credit");
  assert.equal(ledgerDirectionOf("adjustment", -1), "debit");
});

test("帐本行契约：方向不符/金额为 0/缺来源缺幂等键一律拒收，讯息指出原因", () => {
  const base: LedgerEntryDraft = {
    billingUserId: 7,
    entryType: "consumption",
    amount: -100,
    source: "test",
    sourceRef: "job:j1",
    idempotencyRef: "test:1",
  };
  assert.equal(validateLedgerEntryDraft(base), null);
  assert.match(validateLedgerEntryDraft({ ...base, amount: 100 }) ?? "", /consumption 是减项/);
  assert.match(validateLedgerEntryDraft({ ...base, amount: 0 }) ?? "", /amount 0 只允许出现在 opening/);
  assert.match(validateLedgerEntryDraft({ ...base, entryType: "refund", amount: -5 }) ?? "", /refund 是加项/);
  assert.match(validateLedgerEntryDraft({ ...base, billingUserId: 0 }) ?? "", /billing_user_id/);
  assert.match(validateLedgerEntryDraft({ ...base, source: "  " }) ?? "", /source 必填/);
  assert.match(validateLedgerEntryDraft({ ...base, sourceRef: "" }) ?? "", /source_ref 必填/);
  assert.match(validateLedgerEntryDraft({ ...base, idempotencyRef: "" }) ?? "", /idempotency_ref 必填/);
  assert.match(validateLedgerEntryDraft({ ...base, amount: 1.5 }) ?? "", /必须是整数/);
  // opening 的 0 基线是合法的一句真话（记下「基线时刻」）。
  assert.equal(
    validateLedgerEntryDraft({ ...base, entryType: "opening", amount: 0, idempotencyRef: "seed:7:v1" }),
    null,
  );
});

test("余额公式：真实形态帐本记录集（充值/消费/全额退款/部分退款/分配转移）与手算逐位吻合", () => {
  // 手算（单位 quota，1 币 = 500000）：
  //   opening        10,000,000
  //   recharge       +2,000,000
  //   consumption A  −500,000
  //   refund A（全额）+500,000
  //   consumption B  −1,500,000
  //   refund B（部分）+750,000
  //   transfer_out   −3,000,000
  //   transfer_in    +3,000,000（成员侧）
  //   consumption 成员 −1,000,000
  //   主帐 = 10,000,000+2,000,000−500,000+500,000−1,500,000+750,000−3,000,000 = 8,250,000
  //   成员 = 3,000,000−1,000,000 = 2,000,000
  const entry = (
    billingUserId: number,
    entryType: LedgerEntry["entryType"],
    amount: number,
    id: string,
  ): LedgerEntry => ({
    id,
    billingUserId,
    entryType,
    amount,
    source: "test",
    sourceRef: `ref:${id}`,
    idempotencyRef: `idem:${id}`,
    jobId: null,
    operationId: null,
    counterpartyUserId: null,
    note: null,
    createdAt: new Date(Date.UTC(2026, 8, 23, 0, 0, Number(id.replace(/\D/g, "") || 0))).toISOString(),
  });
  const entries: LedgerEntry[] = [
    entry(40, "opening", 10_000_000, "e1"),
    entry(40, "recharge", 2_000_000, "e2"),
    entry(40, "consumption", -500_000, "e3"),
    entry(40, "refund", 500_000, "e4"),
    entry(40, "consumption", -1_500_000, "e5"),
    entry(40, "refund", 750_000, "e6"),
    entry(40, "transfer_out", -3_000_000, "e7"),
    entry(117, "transfer_in", 3_000_000, "e8"),
    entry(117, "consumption", -1_000_000, "e9"),
  ];

  const master = computeAccountBalance(entries, 40);
  assert.equal(master.quota, 8_250_000);
  assert.equal(master.coins, 16.5);
  assert.equal(master.entryCount, 7);
  assert.equal(master.credits, 10_000_000 + 2_000_000 + 500_000 + 750_000);
  assert.equal(master.debits, -500_000 - 1_500_000 - 3_000_000);
  assert.equal(master.byType.recharge?.quota, 2_000_000);
  assert.equal(master.byType.refund?.entries, 2);

  const member = computeAccountBalance(entries, 117);
  assert.equal(member.quota, 2_000_000);
  assert.equal(member.coins, 4);
  assert.equal(member.credits, 3_000_000);

  // 逐位无损：quota 与币的关系由 QUOTA_PER_COIN 决定（独立常数，不是被测实现的输出）。
  assert.equal(master.quota / QUOTA_PER_COIN, 16.5);
  assert.equal(member.quota / QUOTA_PER_COIN, 4);

  // 全体加总 = 各身份之和（守恒，逐位）。
  const all = computeAccountBalance(entries);
  assert.equal(all.quota, master.quota + member.quota);
});

test("余额公式：非有限金额整行跳过并记数，不当 0 加、不装作没发生", () => {
  const entries: LedgerEntry[] = [
    {
      id: "x1",
      billingUserId: 1,
      entryType: "opening",
      amount: 1_000,
      source: "t",
      sourceRef: "r",
      idempotencyRef: "i1",
      jobId: null,
      operationId: null,
      counterpartyUserId: null,
      note: null,
      createdAt: new Date(0).toISOString(),
    },
    {
      id: "x2",
      billingUserId: 1,
      entryType: "consumption",
      amount: Number.NaN,
      source: "t",
      sourceRef: "r",
      idempotencyRef: "i2",
      jobId: null,
      operationId: null,
      counterpartyUserId: null,
      note: null,
      createdAt: new Date(0).toISOString(),
    },
  ];
  const balance = computeAccountBalance(entries, 1);
  assert.equal(balance.quota, 1_000);
  assert.equal(balance.skippedRows, 1);
  assert.equal(balance.entryCount, 1);
});

// ── 记帐幂等 / 基线种子（真 SQL 契约 + 假储存层） ──────────────────────────

test("基线种子：同一份 new-api 基线重放两次不双算（第二次完全不落帐）", async () => {
  const ledger = fakeLedger();
  const fetchUser = async (userId: number) => gatewayUser(userId, 5_000_000);

  const first = await withEnv(CONTROL_PLANE_ENV, () =>
    ensureAccountOpening(40, { sql: ledger.sql, fetchUser }),
  );
  assert.equal(first.seeded, true);
  assert.equal(first.baselineQuota, 5_000_000);

  const second = await withEnv(CONTROL_PLANE_ENV, () =>
    ensureAccountOpening(40, { sql: ledger.sql, fetchUser }),
  );
  assert.equal(second.seeded, false);
  assert.match(second.reason ?? "", /重放/);

  assert.equal(ledger.inserts.length, 1, "整份基线只能落一次帐");
  assert.equal(ledger.balanceOf(40), 5_000_000, "重放后余额不得翻倍");
});

test("基线种子：new-api 读不到就不种（余额不得靠猜）", async () => {
  const ledger = fakeLedger();
  const result = await withEnv(CONTROL_PLANE_ENV, () =>
    ensureAccountOpening(40, { sql: ledger.sql, fetchUser: async () => null }),
  );
  assert.equal(result.seeded, false);
  assert.equal(result.baselineQuota, null);
  assert.equal(ledger.rows.length, 0);
});

test("0 额帐号也留 0 基线：记下基线时刻（充值入帐的分界线）", async () => {
  const ledger = fakeLedger();
  const result = await withEnv(CONTROL_PLANE_ENV, () =>
    ensureAccountOpening(40, { sql: ledger.sql, fetchUser: async (id) => gatewayUser(id, 0) }),
  );
  assert.equal(result.seeded, true);
  assert.equal(result.baselineQuota, 0);
  assert.equal(ledger.rows[0].amount, 0);
  assert.equal(ledger.rows[0].entry_type, "opening");
});

test("记帐重放：同一 idempotency_ref 第二次只回报 duplicates，余额不变", async () => {
  const ledger = fakeLedger();
  const draft: LedgerEntryDraft = {
    billingUserId: 40,
    entryType: "consumption",
    amount: -250_000,
    source: "billing-projection",
    sourceRef: "billing-op:op-1",
    idempotencyRef: "billing-op:op-1:debit",
  };
  const first = await postLedgerEntries([draft], { sql: ledger.sql });
  assert.deepEqual(first.inserted, ["billing-op:op-1:debit"]);
  const balanceAfterFirst = ledger.balanceOf(40);

  const second = await postLedgerEntries([draft], { sql: ledger.sql });
  assert.deepEqual(second.inserted, []);
  assert.deepEqual(second.duplicates, ["billing-op:op-1:debit"]);
  assert.equal(ledger.balanceOf(40), balanceAfterFirst);
  assert.equal(ledger.rows.length, 1);
});

test("记帐失败不挡钱路：储存层抛错只回报，不往外抛", async () => {
  const ledger = fakeLedger({ failInsert: true });
  const outcome = await withEnv(CONTROL_PLANE_ENV, () =>
    recordConsumption(
      { billingUserId: 40, amountQuota: 250_000, jobId: "job-1", operationId: "op-1", source: "billing-projection" },
      writerDeps(ledger),
    ),
  );
  assert.equal(outcome.posted, false);
  assert.match(outcome.reason ?? "", /fake ledger insert failure/);
});

test("消费/退款写入器：上游扣了才记、退款记加项，operation_id 指回帐务事件", async () => {
  const ledger = fakeLedger();
  const consumed = await withEnv(CONTROL_PLANE_ENV, () =>
    recordConsumption(
      { billingUserId: 40, amountQuota: 300_000, jobId: "job-1", operationId: "op-1", source: "billing-projection" },
      writerDeps(ledger),
    ),
  );
  assert.equal(consumed.posted, true);
  const refunded = await withEnv(CONTROL_PLANE_ENV, () =>
    recordRefund(
      { billingUserId: 40, amountQuota: 300_000, jobId: "job-1", operationId: "op-2", source: "billing-ledger-refund" },
      writerDeps(ledger),
    ),
  );
  assert.equal(refunded.posted, true);

  const entries = ledger.rows.filter((row) => row.billing_user_id === 40);
  assert.equal(entries[0].entry_type, "opening");
  assert.equal(entries[1].entry_type, "consumption");
  assert.equal(entries[1].amount, -300_000);
  assert.equal(entries[1].operation_id, "op-1");
  assert.equal(entries[2].entry_type, "refund");
  assert.equal(entries[2].amount, 300_000);
  assert.equal(entries[2].operation_id, "op-2");
  // 手算：1,000,000 − 300,000 + 300,000 = 1,000,000
  assert.equal(ledger.balanceOf(40), 1_000_000);
});

test("分配转移：两条腿同一批写入、互相对称；主帐 −Δ 成员 +Δ", async () => {
  const ledger = fakeLedger();
  const outcome = await withEnv(CONTROL_PLANE_ENV, () =>
    recordTransfer(
      { teamUserId: 40, memberUserId: 117, amountQuota: 2_000_000, transferId: "t-1", source: "member-quota" },
      writerDeps(ledger),
    ),
  );
  assert.equal(outcome.posted, true);
  const team = ledger.rows.filter((row) => row.billing_user_id === 40 && row.entry_type !== "opening");
  const member = ledger.rows.filter((row) => row.billing_user_id === 117 && row.entry_type !== "opening");
  assert.equal(team.length, 1);
  assert.equal(member.length, 1);
  assert.equal(team[0].entry_type, "transfer_out");
  assert.equal(team[0].amount, -2_000_000);
  assert.equal(team[0].counterparty_user_id, 117);
  assert.equal(member[0].entry_type, "transfer_in");
  assert.equal(member[0].amount, 2_000_000);
  assert.equal(member[0].counterparty_user_id, 40);
  assert.equal(team[0].source_ref, "transfer:t-1");
  assert.equal(member[0].source_ref, "transfer:t-1");

  // 重放同一笔转移（同一 transferId）→ 两条腿都不再落帐。
  const replay = await withEnv(CONTROL_PLANE_ENV, () =>
    recordTransfer(
      { teamUserId: 40, memberUserId: 117, amountQuota: 2_000_000, transferId: "t-1", source: "member-quota" },
      writerDeps(ledger),
    ),
  );
  assert.equal(replay.posted, false);
  assert.equal(ledger.rows.filter((row) => row.source_ref === "transfer:t-1").length, 2);
});

test("分配回收（负方向）：成员 −Δ、主帐 +Δ，方向不得颠倒", async () => {
  const ledger = fakeLedger();
  await withEnv(CONTROL_PLANE_ENV, () =>
    recordTransfer(
      { teamUserId: 40, memberUserId: 117, amountQuota: -800_000, transferId: "t-2", source: "member-quota" },
      writerDeps(ledger),
    ),
  );
  const team = ledger.rows.find((row) => row.billing_user_id === 40 && row.source_ref === "transfer:t-2");
  const member = ledger.rows.find((row) => row.billing_user_id === 117 && row.source_ref === "transfer:t-2");
  assert.equal(team?.entry_type, "transfer_in");
  assert.equal(team?.amount, 800_000);
  assert.equal(member?.entry_type, "transfer_out");
  assert.equal(member?.amount, -800_000);
});

test("管理员调整：加减皆入帐，幂等键含调整目标（重放同一次调整不双算）", async () => {
  const ledger = fakeLedger();
  const first = await withEnv(CONTROL_PLANE_ENV, () =>
    recordAdjustment(
      { billingUserId: 40, amountQuota: 5_000_000, sourceRef: "provision:biz-a:5000000", note: "初始额度", source: "admin-provision" },
      writerDeps(ledger),
    ),
  );
  assert.equal(first.posted, true);
  const replay = await withEnv(CONTROL_PLANE_ENV, () =>
    recordAdjustment(
      { billingUserId: 40, amountQuota: 5_000_000, sourceRef: "provision:biz-a:5000000", note: "初始额度", source: "admin-provision" },
      writerDeps(ledger),
    ),
  );
  assert.equal(replay.posted, false);
  // 手算：基线 1,000,000 + 调整 5,000,000 = 6,000,000（重放不得再加一次）
  assert.equal(ledger.balanceOf(40), 6_000_000);
});

test("充值入帐：已使用的兑换码入帐、未使用的不入帐、基线前兑换补记而不双算", async () => {
  // 基线时刻 = 2026-09-23T00:00:00Z（fake 时钟），基线值 = 1,000,000。
  const ledger = fakeLedger();
  await withEnv(CONTROL_PLANE_ENV, () =>
    ensureAccountOpening(40, { sql: ledger.sql, fetchUser: async (id) => gatewayUser(id, 1_000_000) }),
  );

  const redemptions: GatewayRedemption[] = [
    // 已使用、且兑换时间晚于基线 → 应入帐 +2,000,000
    { id: 9001, key: "k-1", name: "MP0001", quota: 2_000_000, status: 2, used_user_id: 40, redeemed_time: Date.UTC(2026, 8, 23, 1, 0) / 1000 },
    // 未使用（redeemed_time=0）→ 不入帐（发码 ≠ 入账）
    { id: 9002, key: "k-2", name: "MP0002", quota: 3_000_000, status: 1, redeemed_time: 0 },
    // 基线之前就已兑换 → 额度已含在基线里：记「充值 +2,000,000」让来源可见，
    // 同时记 −2,000,000 冲销腿 ⇒ 净额 0，不得让余额多出这 4,000,000。
    { id: 9003, key: "k-3", name: "MP0003", quota: 4_000_000, status: 2, used_user_id: 40, redeemed_time: Date.UTC(2026, 8, 22, 0, 0) / 1000 },
  ];
  const summary = await withEnv(CONTROL_PLANE_ENV, () =>
    ingestRedeemedRecharges(
      {},
      { sql: ledger.sql, readRedemptions: async () => redemptions, fetchUser: async (id) => gatewayUser(id, 1_000_000) },
    ),
  );
  assert.equal(summary.scanned, 3);
  assert.equal(summary.charged, 1);
  assert.equal(summary.chargedBaselineAbsorbed, 1);
  assert.equal(summary.skippedUnused, 1);
  assert.equal(summary.skippedBeforeBaseline, 0);
  assert.equal(ledger.balanceOf(40), 3_000_000, "1,000,000 基线 + 2,000,000 充值（冲销腿净额 0）");
  assert.equal(ledger.rows.filter((row) => row.entry_type === "recharge").length, 2);
  const offset = ledger.rows.filter((row) => row.entry_type === "adjustment" && row.source_ref === "redemption:9003");
  assert.equal(offset.length, 1);
  assert.equal(offset[0]?.amount, -4_000_000);

  // 周期性重扫（同一批兑换码再扫一次）不得重复入帐，也不得重复补记冲销。
  const again = await withEnv(CONTROL_PLANE_ENV, () =>
    ingestRedeemedRecharges(
      {},
      { sql: ledger.sql, readRedemptions: async () => redemptions, fetchUser: async (id) => gatewayUser(id, 1_000_000) },
    ),
  );
  assert.equal(again.charged, 0);
  assert.equal(again.chargedBaselineAbsorbed, 0);
  assert.equal(ledger.balanceOf(40), 3_000_000);
  assert.equal(ledger.rows.filter((row) => row.entry_type === "adjustment" && row.source_ref === "redemption:9003").length, 1);
});

test("生产实录回放：415 张码全扫、11 张已兑换全数在帐本上（含人工码，净额不变）", async () => {
  // 2026-09-27 直查 /opt/eimu-site/new-api-data/one-api.db 的原值（id/name/quota/
  // used_user_id/redeemed_time 一字不改），上游分页语义 p=0≡p=1 亦照实模拟。
  const used: { id: number; name: string; quota: number; userId: number; at: string }[] = [
    { id: 1, name: "starter-9.9-200", quota: 100_000_000, userId: 9, at: "2026-06-02 19:51:05" },
    { id: 7, name: "tier-1", quota: 50_000_000, userId: 30, at: "2026-06-08 14:20:55" },
    { id: 207, name: "tier-3", quota: 750_000_000, userId: 77, at: "2026-07-21 18:26:43" },
    { id: 209, name: "tier-3", quota: 750_000_000, userId: 22, at: "2026-07-25 23:25:02" },
    { id: 406, name: "gift", quota: 2_500_000, userId: 4, at: "2026-06-06 13:32:20" },
    { id: 409, name: "eimu1500", quota: 750_000_000, userId: 102, at: "2026-08-27 17:19:48" },
    { id: 410, name: "eimu1500-2", quota: 750_000_000, userId: 116, at: "2026-08-27 17:27:11" },
    { id: 411, name: "eimu1500", quota: 750_000_000, userId: 117, at: "2026-08-29 17:57:00" },
    { id: 412, name: "eimu1500b", quota: 750_000_000, userId: 124, at: "2026-08-29 18:14:03" },
    { id: 413, name: "eimu1500", quota: 750_000_000, userId: 117, at: "2026-09-01 03:15:52" },
    { id: 414, name: "MANUAL-1500C-0919", quota: 750_000_000, userId: 117, at: "2026-09-19 22:08:39" },
  ];
  const shanghai = (text: string) => Math.floor((Date.parse(`${text.replace(" ", "T")}+08:00`)) / 1000);
  const byId = new Map(used.map((item) => [item.id, item]));
  const upstreamTotal = 415;
  const pageItems = (page: number) => {
    const items: unknown[] = [];
    for (let i = 0; i < 100; i += 1) {
      const id = upstreamTotal - (page - 1) * 100 - i;
      if (id <= 0) continue;
      const hit = byId.get(id);
      items.push(
        hit
          ? { id, key: `key-${id}`, name: hit.name, quota: hit.quota, status: 2, used_user_id: hit.userId, redeemed_time: shanghai(hit.at) }
          : { id, key: `key-${id}`, name: `code-${id}`, quota: 100, status: 1, used_user_id: 0, redeemed_time: 0 },
      );
    }
    return items;
  };

  // 开户基线：全部种在 2026-09-23（中控手术日）⇒ 这 11 笔兑换全在基线之前。
  const openingRows = [...new Set(used.map((item) => item.userId))].map((userId, index) => ({
    id: `opening-${userId}`,
    billing_user_id: userId,
    entry_type: "opening",
    amount: 0,
    source: "seed",
    source_ref: `new-api:users/${userId}@2026-09-23T00:00:00.000Z`,
    idempotency_ref: `seed:${userId}:v1`,
    job_id: null,
    operation_id: null,
    counterparty_user_id: null,
    note: "基线",
    metadata_json: "{}",
    created_at: `2026-09-23T00:00:${String(index).padStart(2, "0")}.000Z`,
  }));
  const ledger = fakeLedger({ rows: openingRows });

  const savedFetch = globalThis.fetch;
  const savedEnv = { token: process.env.GATEWAY_ADMIN_ACCESS_TOKEN, user: process.env.GATEWAY_ADMIN_USER_ID, base: process.env.GATEWAY_BASE_URL };
  process.env.GATEWAY_ADMIN_ACCESS_TOKEN = "test-token";
  process.env.GATEWAY_ADMIN_USER_ID = "1";
  process.env.GATEWAY_BASE_URL = "https://gateway.test";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/api/redemption")) {
      const requested = Number(url.searchParams.get("p"));
      const page = requested === 0 ? 1 : requested; // 上游 p=0 等同 p=1（生产实锤）
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { items: pageItems(page), total: upstreamTotal } }) } as unknown as Response;
    }
    const id = Number(url.pathname.split("/").pop());
    return { status: 200, text: async () => JSON.stringify({ success: true, data: { id, username: `u-${id}`, quota: 0 } }) } as unknown as Response;
  }) as typeof fetch;

  try {
    // 不注入 readRedemptions：走真 listGatewayRedemptions（真分页逻辑）。
    const summary = await withEnv(CONTROL_PLANE_ENV, () =>
      ingestRedeemedRecharges({}, { sql: ledger.sql, fetchUser: async (id) => gatewayUser(id, 0) }),
    );
    assert.equal(summary.scanned, 415, "415 张码必须一张不漏（旧版只看得到 200 次、100 张唯一）");
    assert.equal(summary.skippedUnused, 404);
    assert.equal(summary.charged + summary.chargedBaselineAbsorbed, 11, "11 张已兑换码全部要在帐本上留痕");
    assert.equal(summary.charged, 0, "全部早于基线 ⇒ 全走补记+冲销，不走直接充值");
    assert.equal(summary.chargedBaselineAbsorbed, 11);
    assert.equal(summary.errors.length, 0);
    const recharges = ledger.rows.filter((row) => row.entry_type === "recharge");
    assert.equal(recharges.length, 11, "人工码也要入帐（额度是真的发出去了）");
    assert.equal(ledger.rows.filter((row) => row.entry_type === "adjustment").length, 11, "每笔补记都配一条冲销腿");
    // 人工码（全部非 MP）不得被记成现金来源。
    assert.equal(recharges.filter((row) => row.source === "redemption-sync").length, 0);
    assert.equal(recharges.filter((row) => row.source === "gift-manual-code").length, 11);
    // 净额：基线 0 + Σ充值 − Σ冲销 = 0（不许因为回放而多出一分钱）。
    assert.equal(ledger.balanceOf(117), 0);

    // 再扫一轮：不得重复入帐。
    const again = await withEnv(CONTROL_PLANE_ENV, () =>
      ingestRedeemedRecharges({}, { sql: ledger.sql, fetchUser: async (id) => gatewayUser(id, 0) }),
    );
    assert.equal(again.charged + again.chargedBaselineAbsorbed, 0);
    assert.equal(ledger.rows.filter((row) => row.entry_type === "recharge").length, 11);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedEnv.token === undefined) delete process.env.GATEWAY_ADMIN_ACCESS_TOKEN;
    else process.env.GATEWAY_ADMIN_ACCESS_TOKEN = savedEnv.token;
    if (savedEnv.user === undefined) delete process.env.GATEWAY_ADMIN_USER_ID;
    else process.env.GATEWAY_ADMIN_USER_ID = savedEnv.user;
    if (savedEnv.base === undefined) delete process.env.GATEWAY_BASE_URL;
    else process.env.GATEWAY_BASE_URL = savedEnv.base;
  }
});

test("充值入帐现金判定：mPay 单记现金来源、人工码记非现金来源（投影层据此排除付费）", async () => {
  const ledger = fakeLedger();
  await withEnv(CONTROL_PLANE_ENV, () =>
    ensureAccountOpening(40, { sql: ledger.sql, fetchUser: async (id) => gatewayUser(id, 1_000_000) }),
  );
  const redemptions: GatewayRedemption[] = [
    // mPay 真实单命名 = `MP` + out_trade_no 后 18 码（mapay-redemption.mapayOrderRedemptionName）
    { id: 9101, key: "k-cash", name: "MPIMGMUJU63WMD1D372", quota: 50_000_000, status: 2, used_user_id: 40, redeemed_time: Date.UTC(2026, 8, 24, 1, 0) / 1000 },
    // 人工发码（eimu1500 / MANUAL-* / tier-* 一族）
    { id: 9102, key: "k-manual", name: "MANUAL-1500C-0919", quota: 750_000_000, status: 2, used_user_id: 40, redeemed_time: Date.UTC(2026, 8, 24, 2, 0) / 1000 },
  ];
  await withEnv(CONTROL_PLANE_ENV, () =>
    ingestRedeemedRecharges(
      {},
      { sql: ledger.sql, readRedemptions: async () => redemptions, fetchUser: async (id) => gatewayUser(id, 1_000_000) },
    ),
  );
  const cash = ledger.rows.find((row) => row.source_ref === "redemption:9101");
  const manual = ledger.rows.find((row) => row.source_ref === "redemption:9102");
  assert.equal(cash?.source, "redemption-sync");
  assert.equal(manual?.source, "gift-manual-code");
  // 非现金来源必须命中投影层的 NON_CASH_RECHARGE_SOURCE，否则人工码会被算成营收。
  assert.match(manual?.source ?? "", /gift|opening|checkin|check-in|welcome|bonus|grant|promo|trial|newbie|signup|reward/i);
  assert.doesNotMatch(cash?.source ?? "", /gift|opening|checkin|check-in|welcome|bonus|grant|promo|trial|newbie|signup|reward/i);
});

test("充值入帐：冲销腿缺一半时自愈补齐（不得留下单腿漂移）", async () => {
  const ledger = fakeLedger({
    rows: [
      {
        id: "opening-40",
        billing_user_id: 40,
        entry_type: "opening",
        amount: 1_000_000,
        source: "seed",
        source_ref: "new-api:users/40@2026-09-23T00:00:00.000Z",
        idempotency_ref: "seed:40:v1",
        job_id: null,
        operation_id: null,
        counterparty_user_id: null,
        note: "基线",
        metadata_json: "{}",
        created_at: "2026-09-23T00:00:00.000Z",
      },
      {
        id: "broken-1",
        billing_user_id: 40,
        entry_type: "adjustment",
        amount: -5_000_000,
        source: "opening-offset",
        source_ref: "redemption:9201",
        idempotency_ref: "redemption:9201:opening-offset",
        job_id: null,
        operation_id: null,
        counterparty_user_id: null,
        note: "冲销腿（充值腿遗失）",
        metadata_json: "{}",
        created_at: "2026-09-23T00:00:01.000Z",
      },
    ],
  });
  const balanceBefore = ledger.balanceOf(40);
  const redemptions: GatewayRedemption[] = [
    { id: 9201, key: "k-fix", name: "MPFIX", quota: 5_000_000, status: 2, used_user_id: 40, redeemed_time: Date.UTC(2026, 8, 22, 0, 0) / 1000 },
  ];
  const summary = await withEnv(CONTROL_PLANE_ENV, () =>
    ingestRedeemedRecharges(
      {},
      { sql: ledger.sql, readRedemptions: async () => redemptions, fetchUser: async (id) => gatewayUser(id, 1_000_000) },
    ),
  );
  assert.equal(summary.chargedBaselineAbsorbed, 1);
  assert.equal(ledger.rows.filter((row) => row.idempotency_ref === "redemption:9201").length, 1);
  assert.equal(ledger.rows.filter((row) => row.idempotency_ref === "redemption:9201:opening-offset").length, 1);
  // 坏状态本身是漂移（只有冲销腿 ⇒ 少算了 5,000,000）；补上充值腿后回到
  // 基线 1,000,000 + 充值 5,000,000 − 冲销 5,000,000 = 1,000,000。
  assert.equal(ledger.balanceOf(40), balanceBefore + 5_000_000);
  assert.equal(ledger.balanceOf(40), 1_000_000);
});

test("单笔充值写入器：金额非正数拒收（不得记出负充值）", async () => {
  const ledger = fakeLedger();
  const outcome = await withEnv(CONTROL_PLANE_ENV, () =>
    recordRecharge({ billingUserId: 40, amountQuota: -1, redemptionId: 1 }, writerDeps(ledger)),
  );
  assert.equal(outcome.posted, false);
  assert.equal(ledger.rows.length, 0);
});

test("读余额：走同一条 Σ 公式（与纯函式逐位一致）", async () => {
  const ledger = fakeLedger();
  await withEnv(CONTROL_PLANE_ENV, () =>
    ensureAccountOpening(40, { sql: ledger.sql, fetchUser: async (id) => gatewayUser(id, 4_000_000) }),
  );
  await withEnv(CONTROL_PLANE_ENV, () =>
    recordConsumption(
      { billingUserId: 40, amountQuota: 1_000_000, jobId: "job-9", operationId: "op-9", source: "billing-projection" },
      writerDeps(ledger, 4_000_000),
    ),
  );
  const balance = await withEnv(CONTROL_PLANE_ENV, () => readAccountBalance(40, { sql: ledger.sql }));
  assert.equal(balance.quota, 3_000_000);
  assert.equal(balance.coins, 6);
  assert.equal(balance.entryCount, 2);
});

test("契约不破：对外余额回应形体与事故后定下的形状逐字相同（独立 oracle：生产实测值）", () => {
  // 独立 oracle：2026-09-23 生产 GET /v1/quota 对 biz key 实回
  // {"success":true,"balance_coins":9539.62973,"currency":"coins"}（users.quota 读法）。
  // 我方帐本的 Σ amount 只要等于当时的 quota，回应就必须逐位重现这个数字与形状。
  assert.deepEqual(quotaResponseBody(4_769_814_865), {
    success: true,
    balance_coins: 9539.62973,
    currency: "coins",
  });
  // 余额可为负（真实状态不夹到 0），形状不变。
  assert.deepEqual(quotaResponseBody(-2 * QUOTA_PER_COIN), {
    success: true,
    balance_coins: -2,
    currency: "coins",
  });
  // 键集合恰为三个（多一个栏位就是改形状，得先报备）。
  assert.deepEqual(Object.keys(quotaResponseBody(0)).sort(), ["balance_coins", "currency", "success"]);
});

// ── B1 真转移 ↔ 我方帐本：两层同笔变动（端到端，真输入真输出） ─────────────

test("B1 分配（真转移）双写：我方帐本主帐 −Δ／成员 +Δ，与上游 users.quota 增量逐位一致", async () => {
  // 假上游 users.quota：主帐 40 = 5,000,000；成员 117 = 0。
  const quotas = new Map<number, number>([[40, 5_000_000], [117, 0]]);
  const adjustments: { userId: number; delta: number }[] = [];
  const fetchUser = (async (id: number) => gatewayUser(id, quotas.get(id) ?? 0)) as unknown as typeof import("@/lib/gateway-admin").fetchGatewayUser;
  const adjustUserQuota = (async (id: number, delta: number) => {
    quotas.set(id, (quotas.get(id) ?? 0) + Math.round(delta));
    adjustments.push({ userId: id, delta: Math.round(delta) });
  }) as unknown as typeof import("@/lib/gateway-admin").adjustGatewayUserQuotaExact;

  // 假控制面：成员 key → user 117 的归属，加上真帐本表（UNIQUE + ON CONFLICT DO NOTHING）。
  const ledger = fakeLedger();
  const members: { id: string; team_user_id: number; member_user_id: number; member_key_id: string }[] = [];
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ? ").replace(/\s+/g, " ").trim();
    if (query.includes("pg_advisory_xact_lock")) return []; // 假锁：单执行绪测试不需要真锁
    if (query.includes("FROM biz_api_key")) return [{ id: values[0], label: "成员A", user_id: 117 }];
    if (query.includes("FROM team_member_quota")) {
      return members.filter((member) =>
        query.includes("WHERE member_user_id")
          ? member.member_user_id === Number(values[0])
          : member.team_user_id === Number(values[0]),
      );
    }
    if (query.includes("INSERT INTO team_member_quota")) {
      members.push({
        id: String(values[0]),
        team_user_id: Number(values[1]),
        member_user_id: Number(values[2]),
        member_key_id: String(values[3]),
      });
      return [];
    }
    return await (ledger.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(strings, ...values);
  }) as unknown as GenerationSql;
  Object.assign(tagged, { begin: async (fn: (tx: GenerationSql) => Promise<unknown>) => fn(tagged) });

  const { allocateMemberQuota } = await import("./member-quota.ts");
  const result = await withEnv(CONTROL_PLANE_ENV, () =>
    allocateMemberQuota(
      { teamUserId: 40, memberKeyId: "k-member", targetGranted: 2_000_000 },
      {
        sql: tagged,
        fetchUser,
        adjustUserQuota,
        newMemberId: () => "member-1",
        newTransferId: () => "transfer-1",
      },
    ),
  );
  assert.equal(result.ok, true, `分配必须成功，实际：${JSON.stringify(result)}`);
  if (!result.ok) return;

  // ① 上游（B1 权威读数／成员显示口径）：主帐 −2,000,000、成员 +2,000,000。
  assert.deepEqual(adjustments, [
    { userId: 40, delta: -2_000_000 },
    { userId: 117, delta: 2_000_000 },
  ]);
  assert.equal(quotas.get(40), 3_000_000);
  assert.equal(quotas.get(117), 2_000_000);

  // ② 我方帐本（余额权威）：两条腿同事务入帐，增量与上游逐位相同。
  assert.equal(ledger.balanceOf(40), 3_000_000, "主帐帐本净额 = 上游 users.quota");
  assert.equal(ledger.balanceOf(117), 2_000_000, "成员帐本净额 = 上游 users.quota");
  const out = ledger.rows.find((row) => row.entry_type === "transfer_out");
  const incoming = ledger.rows.find((row) => row.entry_type === "transfer_in");
  assert.equal(out?.amount, -2_000_000);
  assert.equal(out?.counterparty_user_id, 117);
  assert.equal(incoming?.amount, 2_000_000);
  assert.equal(incoming?.counterparty_user_id, 40);
  assert.equal(out?.source_ref, "transfer:transfer-1");
  assert.equal(incoming?.source_ref, "transfer:transfer-1");
});

// ── 变更探针（源码守门：只算探针，不计入已验证） ──────────────────────────

test("变更探针：本模组对 account_ledger 只有 INSERT（append-only，无 UPDATE/DELETE）", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/generation-core/account-ledger.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(source, /UPDATE\s+account_ledger/i);
  assert.doesNotMatch(source, /DELETE\s+FROM\s+account_ledger/i);
  assert.match(source, /INSERT INTO account_ledger/);
});

test("变更探针：migration 020 建表带 UNIQUE(idempotency_ref) 与 append-only 注释", () => {
  const ddl = readFileSync(join(process.cwd(), "db/migrations/020_account_ledger.sql"), "utf8");
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS account_ledger/);
  assert.match(ddl, /idempotency_ref text NOT NULL UNIQUE/);
  assert.match(ddl, /只允许 INSERT/);
});
