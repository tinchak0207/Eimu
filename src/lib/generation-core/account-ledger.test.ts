// REQ-E1a 我方帳本（account-ledger）測試：加減項模型、餘額公式、基線種子幂等、
// 轉移兩條腿、充值入帳、以及「記帳失敗不擋錢路」。
//
// 驗收姿勢（AGENTS.md 09-23）：每一條都是**真實行為斷言**（真輸入 → 真輸出），
// 不是源碼字串掃描。源碼掃描（append-only 守門）只作變更探針，另列。

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

/** 寫入器注入：基線讀法走假上游（生產默認 fetchGatewayUser）。 */
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

/** 環境覆寫（async-aware：非同步任務跑完才還原，否則 async fn 會看到已還原的環境）。 */
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

// ── 假帳本 SQL：記憶體表 + 真 UNIQUE(idempotency_ref) + 真 ON CONFLICT DO NOTHING ──

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
    throw new Error(`fakeLedger: 未預期的查詢：${query}`);
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

// ── 加減項模型（純函式，真輸入真輸出） ────────────────────────────────────

test("加減項判別表：消費/轉出是減項、充值/退款/轉入是加項，基線與調整看符號", () => {
  assert.equal(ledgerDirectionOf("consumption", -100), "debit");
  assert.equal(ledgerDirectionOf("transfer_out", -100), "debit");
  assert.equal(ledgerDirectionOf("recharge", 100), "credit");
  assert.equal(ledgerDirectionOf("refund", 100), "credit");
  assert.equal(ledgerDirectionOf("transfer_in", 100), "credit");
  assert.equal(ledgerDirectionOf("opening", -100), "debit");
  assert.equal(ledgerDirectionOf("opening", 100), "credit");
  assert.equal(ledgerDirectionOf("adjustment", -1), "debit");
});

test("帳本行契約：方向不符/金額為 0/缺來源缺冪等鍵一律拒收，訊息指出原因", () => {
  const base: LedgerEntryDraft = {
    billingUserId: 7,
    entryType: "consumption",
    amount: -100,
    source: "test",
    sourceRef: "job:j1",
    idempotencyRef: "test:1",
  };
  assert.equal(validateLedgerEntryDraft(base), null);
  assert.match(validateLedgerEntryDraft({ ...base, amount: 100 }) ?? "", /consumption 是減項/);
  assert.match(validateLedgerEntryDraft({ ...base, amount: 0 }) ?? "", /amount 0 只允許出現在 opening/);
  assert.match(validateLedgerEntryDraft({ ...base, entryType: "refund", amount: -5 }) ?? "", /refund 是加項/);
  assert.match(validateLedgerEntryDraft({ ...base, billingUserId: 0 }) ?? "", /billing_user_id/);
  assert.match(validateLedgerEntryDraft({ ...base, source: "  " }) ?? "", /source 必填/);
  assert.match(validateLedgerEntryDraft({ ...base, sourceRef: "" }) ?? "", /source_ref 必填/);
  assert.match(validateLedgerEntryDraft({ ...base, idempotencyRef: "" }) ?? "", /idempotency_ref 必填/);
  assert.match(validateLedgerEntryDraft({ ...base, amount: 1.5 }) ?? "", /必須是整數/);
  // opening 的 0 基線是合法的一句真話（記下「基線時刻」）。
  assert.equal(
    validateLedgerEntryDraft({ ...base, entryType: "opening", amount: 0, idempotencyRef: "seed:7:v1" }),
    null,
  );
});

test("餘額公式：真實形態帳本記錄集（充值/消費/全額退款/部分退款/分配轉移）與手算逐位吻合", () => {
  // 手算（單位 quota，1 幣 = 500000）：
  //   opening        10,000,000
  //   recharge       +2,000,000
  //   consumption A  −500,000
  //   refund A（全額）+500,000
  //   consumption B  −1,500,000
  //   refund B（部分）+750,000
  //   transfer_out   −3,000,000
  //   transfer_in    +3,000,000（成員側）
  //   consumption 成員 −1,000,000
  //   主帳 = 10,000,000+2,000,000−500,000+500,000−1,500,000+750,000−3,000,000 = 8,250,000
  //   成員 = 3,000,000−1,000,000 = 2,000,000
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

  // 逐位無損：quota 與幣的關係由 QUOTA_PER_COIN 決定（獨立常數，不是被測實現的輸出）。
  assert.equal(master.quota / QUOTA_PER_COIN, 16.5);
  assert.equal(member.quota / QUOTA_PER_COIN, 4);

  // 全體加總 = 各身份之和（守恆，逐位）。
  const all = computeAccountBalance(entries);
  assert.equal(all.quota, master.quota + member.quota);
});

test("餘額公式：非有限金額整行跳過並記數，不當 0 加、不裝作沒發生", () => {
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

// ── 記帳冪等 / 基線種子（真 SQL 契約 + 假儲存層） ──────────────────────────

test("基線種子：同一份 new-api 基線重放兩次不雙算（第二次完全不落帳）", async () => {
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

  assert.equal(ledger.inserts.length, 1, "整份基線只能落一次帳");
  assert.equal(ledger.balanceOf(40), 5_000_000, "重放後餘額不得翻倍");
});

test("基線種子：new-api 讀不到就不種（餘額不得靠猜）", async () => {
  const ledger = fakeLedger();
  const result = await withEnv(CONTROL_PLANE_ENV, () =>
    ensureAccountOpening(40, { sql: ledger.sql, fetchUser: async () => null }),
  );
  assert.equal(result.seeded, false);
  assert.equal(result.baselineQuota, null);
  assert.equal(ledger.rows.length, 0);
});

test("0 額帳號也留 0 基線：記下基線時刻（充值入帳的分界線）", async () => {
  const ledger = fakeLedger();
  const result = await withEnv(CONTROL_PLANE_ENV, () =>
    ensureAccountOpening(40, { sql: ledger.sql, fetchUser: async (id) => gatewayUser(id, 0) }),
  );
  assert.equal(result.seeded, true);
  assert.equal(result.baselineQuota, 0);
  assert.equal(ledger.rows[0].amount, 0);
  assert.equal(ledger.rows[0].entry_type, "opening");
});

test("記帳重放：同一 idempotency_ref 第二次只回報 duplicates，餘額不變", async () => {
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

test("記帳失敗不擋錢路：儲存層拋錯只回報，不往外拋", async () => {
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

test("消費/退款寫入器：上游扣了才記、退款記加項，operation_id 指回帳務事件", async () => {
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

test("分配轉移：兩條腿同一批寫入、互相對稱；主帳 −Δ 成員 +Δ", async () => {
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

  // 重放同一筆轉移（同一 transferId）→ 兩條腿都不再落帳。
  const replay = await withEnv(CONTROL_PLANE_ENV, () =>
    recordTransfer(
      { teamUserId: 40, memberUserId: 117, amountQuota: 2_000_000, transferId: "t-1", source: "member-quota" },
      writerDeps(ledger),
    ),
  );
  assert.equal(replay.posted, false);
  assert.equal(ledger.rows.filter((row) => row.source_ref === "transfer:t-1").length, 2);
});

test("分配回收（負方向）：成員 −Δ、主帳 +Δ，方向不得顛倒", async () => {
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

test("管理員調整：加減皆入帳，幂等鍵含調整目標（重放同一次調整不雙算）", async () => {
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
  // 手算：基線 1,000,000 + 調整 5,000,000 = 6,000,000（重放不得再加一次）
  assert.equal(ledger.balanceOf(40), 6_000_000);
});

test("充值入帳：已使用的兌換碼入帳、未使用的不入帳、基線前兌換的不重複計", async () => {
  // 基線時刻 = 2026-09-23T00:00:00Z（fake 時鐘），基線值 = 1,000,000。
  const ledger = fakeLedger();
  await withEnv(CONTROL_PLANE_ENV, () =>
    ensureAccountOpening(40, { sql: ledger.sql, fetchUser: async (id) => gatewayUser(id, 1_000_000) }),
  );

  const redemptions: GatewayRedemption[] = [
    // 已使用、且兌換時間晚於基線 → 應入帳 +2,000,000
    { id: 9001, key: "k-1", name: "MP0001", quota: 2_000_000, status: 2, used_user_id: 40, redeemed_time: Date.UTC(2026, 8, 23, 1, 0) / 1000 },
    // 未使用（redeemed_time=0）→ 不入帳（發碼 ≠ 入帳）
    { id: 9002, key: "k-2", name: "MP0002", quota: 3_000_000, status: 1, redeemed_time: 0 },
    // 基線之前就已兌換 → 已含在基線裡，不得再加（防雙算）
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
  assert.equal(summary.skippedUnused, 1);
  assert.equal(summary.skippedBeforeBaseline, 1);
  assert.equal(ledger.balanceOf(40), 3_000_000, "1,000,000 基線 + 2,000,000 充值");
  assert.equal(ledger.rows.filter((row) => row.entry_type === "recharge").length, 1);

  // 週期性重掃（同一批兌換碼再掃一次）不得重複入帳。
  const again = await withEnv(CONTROL_PLANE_ENV, () =>
    ingestRedeemedRecharges(
      {},
      { sql: ledger.sql, readRedemptions: async () => redemptions, fetchUser: async (id) => gatewayUser(id, 1_000_000) },
    ),
  );
  assert.equal(again.charged, 0);
  assert.equal(ledger.balanceOf(40), 3_000_000);
});

test("單筆充值寫入器：金額非正數拒收（不得記出負充值）", async () => {
  const ledger = fakeLedger();
  const outcome = await withEnv(CONTROL_PLANE_ENV, () =>
    recordRecharge({ billingUserId: 40, amountQuota: -1, redemptionId: 1 }, writerDeps(ledger)),
  );
  assert.equal(outcome.posted, false);
  assert.equal(ledger.rows.length, 0);
});

test("讀餘額：走同一條 Σ 公式（與純函式逐位一致）", async () => {
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

test("契約不破：對外餘額回應形體與事故後定下的形狀逐字相同（獨立 oracle：生產實測值）", () => {
  // 獨立 oracle：2026-09-23 生產 GET /v1/quota 對 biz key 實回
  // {"success":true,"balance_coins":9539.62973,"currency":"coins"}（users.quota 讀法）。
  // 我方帳本的 Σ amount 只要等於當時的 quota，回應就必須逐位重現這個數字與形狀。
  assert.deepEqual(quotaResponseBody(4_769_814_865), {
    success: true,
    balance_coins: 9539.62973,
    currency: "coins",
  });
  // 餘額可為負（真實狀態不夾到 0），形狀不變。
  assert.deepEqual(quotaResponseBody(-2 * QUOTA_PER_COIN), {
    success: true,
    balance_coins: -2,
    currency: "coins",
  });
  // 鍵集合恰為三個（多一個欄位就是改形狀，得先報備）。
  assert.deepEqual(Object.keys(quotaResponseBody(0)).sort(), ["balance_coins", "currency", "success"]);
});

// ── B1 真轉移 ↔ 我方帳本：兩層同筆變動（端到端，真輸入真輸出） ─────────────

test("B1 分配（真轉移）雙寫：我方帳本主帳 −Δ／成員 +Δ，與上游 users.quota 增量逐位一致", async () => {
  // 假上游 users.quota：主帳 40 = 5,000,000；成員 117 = 0。
  const quotas = new Map<number, number>([[40, 5_000_000], [117, 0]]);
  const adjustments: { userId: number; delta: number }[] = [];
  const fetchUser = (async (id: number) => gatewayUser(id, quotas.get(id) ?? 0)) as unknown as typeof import("@/lib/gateway-admin").fetchGatewayUser;
  const adjustUserQuota = (async (id: number, delta: number) => {
    quotas.set(id, (quotas.get(id) ?? 0) + Math.round(delta));
    adjustments.push({ userId: id, delta: Math.round(delta) });
  }) as unknown as typeof import("@/lib/gateway-admin").adjustGatewayUserQuotaExact;

  // 假控制面：成員 key → user 117 的歸屬，加上真帳本表（UNIQUE + ON CONFLICT DO NOTHING）。
  const ledger = fakeLedger();
  const members: { id: string; team_user_id: number; member_user_id: number; member_key_id: string }[] = [];
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ? ").replace(/\s+/g, " ").trim();
    if (query.includes("pg_advisory_xact_lock")) return []; // 假鎖：單執行緒測試不需要真鎖
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
  assert.equal(result.ok, true, `分配必須成功，實際：${JSON.stringify(result)}`);
  if (!result.ok) return;

  // ① 上游（B1 權威讀數／成員顯示口徑）：主帳 −2,000,000、成員 +2,000,000。
  assert.deepEqual(adjustments, [
    { userId: 40, delta: -2_000_000 },
    { userId: 117, delta: 2_000_000 },
  ]);
  assert.equal(quotas.get(40), 3_000_000);
  assert.equal(quotas.get(117), 2_000_000);

  // ② 我方帳本（餘額權威）：兩條腿同事務入帳，增量與上游逐位相同。
  assert.equal(ledger.balanceOf(40), 3_000_000, "主帳帳本淨額 = 上游 users.quota");
  assert.equal(ledger.balanceOf(117), 2_000_000, "成員帳本淨額 = 上游 users.quota");
  const out = ledger.rows.find((row) => row.entry_type === "transfer_out");
  const incoming = ledger.rows.find((row) => row.entry_type === "transfer_in");
  assert.equal(out?.amount, -2_000_000);
  assert.equal(out?.counterparty_user_id, 117);
  assert.equal(incoming?.amount, 2_000_000);
  assert.equal(incoming?.counterparty_user_id, 40);
  assert.equal(out?.source_ref, "transfer:transfer-1");
  assert.equal(incoming?.source_ref, "transfer:transfer-1");
});

// ── 變更探針（源碼守門：只算探針，不計入已驗證） ──────────────────────────

test("變更探針：本模組對 account_ledger 只有 INSERT（append-only，無 UPDATE/DELETE）", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/generation-core/account-ledger.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(source, /UPDATE\s+account_ledger/i);
  assert.doesNotMatch(source, /DELETE\s+FROM\s+account_ledger/i);
  assert.match(source, /INSERT INTO account_ledger/);
});

test("變更探針：migration 020 建表帶 UNIQUE(idempotency_ref) 與 append-only 註釋", () => {
  const ddl = readFileSync(join(process.cwd(), "db/migrations/020_account_ledger.sql"), "utf8");
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS account_ledger/);
  assert.match(ddl, /idempotency_ref text NOT NULL UNIQUE/);
  assert.match(ddl, /只允許 INSERT/);
});
