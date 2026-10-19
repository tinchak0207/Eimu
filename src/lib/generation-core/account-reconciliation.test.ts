// REQ-E1b 跨层对帐测试：真实行为断言（真输入 → 真输出）。
//
// 核心验收：注入一笔人为差异 → 对帐报告指出并定位到具体 job／operation／billing_user；
// 上游不可读 → 冻结 unknown 并告警，不得假装两层相等；writeoff 等不动用户余额的事件
// 不得被误判成缺帐。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import type { GenerationSql } from "./database.ts";
import type { LedgerEntry } from "./account-ledger.ts";
import {
  DEFAULT_DRIFT_ALERT_QUOTA,
  driftAlerts,
  expectedLedgerEntryForOperation,
  formatAccountReconciliationReport,
  reconcileAccountBalances,
  reconcileAccountRow,
  type UpstreamBalanceEvent,
} from "./account-reconciliation.ts";

const ENV = { GENERATION_DATABASE_URL: "postgres://fake:fake@127.0.0.1:1/fake" };

function withEnv<T>(fn: () => T): T {
  const savedUrl = process.env.GENERATION_DATABASE_URL;
  process.env.GENERATION_DATABASE_URL = ENV.GENERATION_DATABASE_URL;
  const restore = () => {
    if (savedUrl === undefined) delete process.env.GENERATION_DATABASE_URL;
    else process.env.GENERATION_DATABASE_URL = savedUrl;
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

function entry(overrides: Partial<LedgerEntry> & { entryType: LedgerEntry["entryType"]; amount: number }): LedgerEntry {
  return {
    id: overrides.id ?? `entry-${overrides.entryType}-${Math.abs(overrides.amount)}`,
    billingUserId: overrides.billingUserId ?? 40,
    entryType: overrides.entryType,
    amount: overrides.amount,
    source: overrides.source ?? "test",
    sourceRef: overrides.sourceRef ?? "test:ref",
    idempotencyRef: overrides.idempotencyRef ?? `idem-${overrides.id}`,
    ...(overrides.pool !== undefined ? { pool: overrides.pool } : {}),
    ...(overrides.termRef !== undefined ? { termRef: overrides.termRef } : {}),
    ...(overrides.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
    jobId: overrides.jobId ?? null,
    operationId: overrides.operationId ?? null,
    counterpartyUserId: overrides.counterpartyUserId ?? null,
    note: overrides.note ?? null,
    createdAt: overrides.createdAt ?? new Date(Date.UTC(2026, 8, 23, 0, 0, 0)).toISOString(),
  };
}

function upstream(overrides: Partial<UpstreamBalanceEvent> & { operation: UpstreamBalanceEvent["operation"]; amountQuota: number }): UpstreamBalanceEvent {
  return {
    operationId: overrides.operationId ?? `op-${overrides.operation}`,
    jobId: overrides.jobId ?? "job-1",
    operation: overrides.operation,
    amountQuota: overrides.amountQuota,
    idempotencyRef: overrides.idempotencyRef ?? `${overrides.operation}:x:1`,
    appliedAt: overrides.appliedAt ?? new Date(Date.UTC(2026, 8, 23, 0, 5, 0)).toISOString(),
  };
}

// ── 判别口径（纯函式） ───────────────────────────────────────────────────

test("判别口径：只有会动用户余额的上游事件才要求帐本行（writeoff/gate 零额 reserve/一般 commit 都不要求）", () => {
  assert.deepEqual(expectedLedgerEntryForOperation(upstream({ operation: "refund", amountQuota: 300_000 })), {
    expected: "refund",
    amountQuota: 300_000,
  });
  assert.deepEqual(expectedLedgerEntryForOperation(upstream({ operation: "reserve", amountQuota: 500_000 })), {
    expected: "consumption",
    amountQuota: 500_000,
  });
  assert.equal(
    expectedLedgerEntryForOperation(upstream({ operation: "reserve", amountQuota: 0 })).expected,
    "none",
  );
  assert.deepEqual(
    expectedLedgerEntryForOperation(upstream({ operation: "commit", amountQuota: 500_000, idempotencyRef: "projection:job-1:commit:1" })),
    { expected: "consumption", amountQuota: 500_000 },
  );
  assert.equal(
    expectedLedgerEntryForOperation(upstream({ operation: "commit", amountQuota: 500_000, idempotencyRef: "generation:job-1:commit:1" })).expected,
    "none",
  );
  assert.equal(expectedLedgerEntryForOperation(upstream({ operation: "writeoff", amountQuota: 999_999 })).expected, "none");
  assert.equal(expectedLedgerEntryForOperation(upstream({ operation: "release", amountQuota: 999_999 })).expected, "none");
});

// ── 对帐单列（真输入真输出） ─────────────────────────────────────────────

test("两层一致：我方帐本 = new-api = 4,000,000（每笔都能对上）→ matched、零 finding", () => {
  const row = reconcileAccountRow({
    billingUserId: 40,
    entries: [
      entry({ id: "e1", entryType: "opening", amount: 5_000_000, idempotencyRef: "seed:40:v1" }),
      entry({ id: "e2", entryType: "consumption", amount: -1_000_000, jobId: "job-1", operationId: "op-1" }),
    ],
    newApiQuota: 4_000_000,
    upstreamEvents: [
      upstream({
        operationId: "op-1",
        jobId: "job-1",
        operation: "commit",
        amountQuota: 1_000_000,
        idempotencyRef: "projection:job-1:commit:1",
      }),
    ],
  });
  assert.equal(row.state, "matched");
  assert.equal(row.ourNetQuota, 4_000_000);
  assert.equal(row.newApiQuota, 4_000_000);
  assert.equal(row.differenceQuota, 0);
  assert.deepEqual(row.findings, []);
  assert.equal(row.unlocatedQuota, 0);
});

test("注入人为差异（上游有一笔退款、我方帐本漏记）→ 报表指出并定位到 job／operation", () => {
  const row = reconcileAccountRow({
    billingUserId: 40,
    entries: [
      entry({ id: "e1", entryType: "opening", amount: 5_000_000 }),
      entry({ id: "e2", entryType: "consumption", amount: -1_000_000, jobId: "job-1", operationId: "op-1" }),
    ],
    newApiQuota: 4_300_000, // 上游已把 300,000 退回去，我方帐本没记
    upstreamEvents: [
      upstream({ operationId: "op-1", jobId: "job-1", operation: "commit", amountQuota: 1_000_000, idempotencyRef: "projection:job-1:commit:1" }),
      upstream({ operationId: "op-7", jobId: "job-injected", operation: "refund", amountQuota: 300_000 }),
    ],
  });
  assert.equal(row.state, "explained");
  assert.equal(row.differenceQuota, 300_000);
  assert.equal(row.differenceCoins, 0.6);
  assert.equal(row.unlocatedQuota, 0);
  assert.equal(row.findings.length, 1);
  const [finding] = row.findings;
  assert.equal(finding.kind, "unrecorded_upstream_change");
  assert.equal(finding.billingUserId, 40);
  assert.equal(finding.jobId, "job-injected");
  assert.equal(finding.operationId, "op-7");
  assert.equal(finding.quota, 300_000);
  assert.match(finding.detail, /refund/);
});

test("注入人为差异（我方帐本多记一笔，上游没有对应事件）→ 定位到该帐本行 id", () => {
  const row = reconcileAccountRow({
    billingUserId: 40,
    entries: [
      entry({ id: "e1", entryType: "opening", amount: 5_000_000 }),
      entry({ id: "e-ghost", entryType: "consumption", amount: -700_000, jobId: "job-ghost", operationId: "op-ghost" }),
    ],
    newApiQuota: 5_000_000, // 上游没有被扣
    upstreamEvents: [],
  });
  assert.equal(row.state, "explained");
  assert.equal(row.differenceQuota, 700_000);
  assert.equal(row.findings[0].kind, "orphan_ledger_entry");
  assert.equal(row.findings[0].entryId, "e-ghost");
  assert.equal(row.findings[0].jobId, "job-ghost");
  assert.equal(row.findings[0].quota, 700_000);
});

test("注入人为差异（找不到任何对应事件的后台改额）→ 冻结 unknown + 未定位差额如实列出", () => {
  const row = reconcileAccountRow({
    billingUserId: 40,
    entries: [entry({ id: "e1", entryType: "opening", amount: 5_000_000 })],
    newApiQuota: 4_500_000, // 有人直接在 new-api 后台扣了 500,000
    upstreamEvents: [],
  });
  assert.equal(row.state, "unknown");
  assert.equal(row.differenceQuota, -500_000);
  assert.equal(row.unlocatedQuota, -500_000);
  const unexplained = row.findings.find((finding) => finding.kind === "unexplained_difference");
  assert.ok(unexplained, "必须单列一笔未定位差额");
  assert.equal(unexplained?.quota, -500_000);
  assert.equal(unexplained?.jobId, null);
  assert.match(unexplained?.detail ?? "", /人工核对/);
});

test("上游额度读不到 → unknown（不得假装相等），并标 balance_unavailable", () => {
  const row = reconcileAccountRow({
    billingUserId: 40,
    entries: [entry({ id: "e1", entryType: "opening", amount: 5_000_000 })],
    newApiQuota: null,
    upstreamEvents: [],
  });
  assert.equal(row.state, "unknown");
  assert.equal(row.differenceQuota, null);
  assert.equal(row.newApiQuota, null);
  assert.equal(row.findings[0].kind, "balance_unavailable");
});

test("writeoff 与 gate 零额 reserve 不得被误判成缺帐（平台自身损失不动用户余额）", () => {
  const row = reconcileAccountRow({
    billingUserId: 40,
    entries: [entry({ id: "e1", entryType: "opening", amount: 5_000_000 })],
    newApiQuota: 5_000_000,
    upstreamEvents: [
      upstream({ operationId: "op-w", operation: "writeoff", amountQuota: 2_000_000 }),
      upstream({ operationId: "op-r0", operation: "reserve", amountQuota: 0 }),
      upstream({ operationId: "op-c", operation: "commit", amountQuota: 2_000_000, idempotencyRef: "generation:job-1:commit:1" }),
    ],
  });
  assert.equal(row.state, "matched");
  assert.deepEqual(row.findings, []);
});

test("E1-b D3 过期残差：expire 作废行（上游无此语义）必须归 explained，不得坠入 unknown，也不得进孤儿判定", () => {
  const row = reconcileAccountRow({
    billingUserId: 40,
    entries: [
      entry({ id: "e1", entryType: "opening", amount: 5_000_000 }),
      entry({ id: "e2", entryType: "consumption", amount: -1_000_000, jobId: "job-1", operationId: "op-1" }),
      // 续期替换作废旧期残额：负数、无 operationId、带池维度
      entry({ id: "e3", entryType: "expire", amount: -800_000, pool: "subscription", termRef: "sub:9:term:1", expiresAt: "2026-09-20T00:00:00.000Z" }),
    ],
    // 上游只动过 1,000,000 的消费：过期是纯我方口径 ⇒ 上游水位 4,000,000（比 Σ 多一个 800,000）
    newApiQuota: 4_000_000,
    upstreamEvents: [
      upstream({ operationId: "op-1", jobId: "job-1", operation: "reserve", amountQuota: 1_000_000 }),
    ],
  });
  assert.equal(row.state, "explained", "口径差已被逐笔定位 = explained，不是 unknown");
  assert.equal(row.unlocatedQuota, 0);
  assert.equal(row.findings.length, 1, "只有 expire 一笔 finding（consumption 对上了；expire 不进孤儿）");
  assert.equal(row.findings[0].kind, "subscription_expiry");
  assert.equal(row.findings[0].quota, 800_000, "贡献恰为 expire 行抬高的差额（-entry.amount）");
  assert.equal(row.findings[0].entryId, "e3");
  assert.match(row.findings[0].detail, /sub:9:term:1/);
});

test("E1-b D3 多笔 expire＋真漂移混合：残差只剩漂移，state 仍 unknown 且未定位额＝漂移部分", () => {
  const row = reconcileAccountRow({
    billingUserId: 40,
    entries: [
      entry({ id: "e1", entryType: "opening", amount: 5_000_000 }),
      entry({ id: "e3", entryType: "expire", amount: -800_000, pool: "subscription", termRef: "sub:9:term:1", expiresAt: "2026-09-20T00:00:00.000Z" }),
      entry({ id: "e4", entryType: "expire", amount: -200_000, pool: "subscription", termRef: "sub:9:term:2", expiresAt: "2026-09-21T00:00:00.000Z" }),
    ],
    // Σ=4,000,000（开帐 5M − 作废 1M）；上游 4,300,000 ⇒ 差 +300,000。expire 解释
    // +1,000,000 超过差额 ⇒ residual = −700,000：过期解释不完的部分诚实留残、必坠 unknown。
    newApiQuota: 4_300_000,
    upstreamEvents: [],
  });
  assert.equal(row.state, "unknown");
  assert.equal(row.findings.filter((f) => f.kind === "subscription_expiry").length, 2);
  assert.equal(row.unlocatedQuota, -700_000);
  assert.equal(row.findings.filter((f) => f.kind === "unexplained_difference")[0].quota, -700_000);
});

test("实锤反例 a：difference===0 但 findings 自相抵销（孤儿帐本行 × 上游事件互冲）→ explained 非 unknown、driftAlerts 空", () => {
  // 现场病灶（生产 user 82/102/116/117/124）：两层逐位相等，但帐本有一笔上游没有事件的
  // 孤儿 consumption（+300,000 贡献），上游同时有一笔帐本没记的 reserve consumption
  // （−300,000 贡献）——两个 finding 恰好抵销，差额为 0。旧判定拿「difference ≠ 0」当
  // explained 前提，把它们坠进 unknown＋push residual=0 的 unexplained_difference＋误告警。
  const row = reconcileAccountRow({
    billingUserId: 82,
    entries: [
      entry({ id: "e1", billingUserId: 82, entryType: "opening", amount: 5_000_000, idempotencyRef: "seed:82:v1" }),
      // 孤儿帐本行：我方多记一笔 consumption，上游没有对应 applied 事件。
      entry({ id: "e-ghost", billingUserId: 82, entryType: "consumption", amount: -300_000, jobId: "job-ghost", operationId: "op-ghost" }),
    ],
    // 上游只动过 op-miss 那 300,000（帐本没记）⇒ 我方 4,700,000 = 上游 4,700,000，差额 0。
    newApiQuota: 4_700_000,
    upstreamEvents: [
      upstream({ operationId: "op-miss", jobId: "job-miss", operation: "reserve", amountQuota: 300_000 }),
    ],
  });
  assert.equal(row.differenceQuota, 0);
  assert.equal(row.state, "explained", "抵销＝解释得完，不是歧义，不得进 unknown");
  assert.equal(row.findings.length, 2, "两个 finding 原样保留（可逐笔定位）");
  assert.ok(row.findings.every((finding) => finding.kind !== "unexplained_difference"), "残差 0 不得再 push 假的未定位差额");
  assert.equal(row.unlocatedQuota, 0);
  assert.deepEqual(driftAlerts(row, DEFAULT_DRIFT_ALERT_QUOTA), [], "差额 0 的 explained 不得告警");
});

test("实锤反例 b：帐本未接管（零帐本行、无 opening，上游大额 quota＋applied 事件）→ unseeded、不比较、不告警", async () => {
  const row = reconcileAccountRow({
    billingUserId: 77,
    entries: [],
    newApiQuota: 8_000_000,
    upstreamEvents: [
      upstream({ operationId: "op-lazy", jobId: "job-lazy", operation: "reserve", amountQuota: 5_000_000 }),
    ],
  });
  assert.equal(row.state, "unseeded", "lazy 种帐未触及 ≠ 歧义，不得进 unknown");
  assert.equal(row.ledgerEntries, 0);
  assert.equal(row.differenceQuota, null, "未接管不比较");
  assert.equal(row.newApiQuota, 8_000_000, "上游水位照实展示，不藏");
  assert.deepEqual(row.findings, [], "不比较 ⇒ 不产 findings、不 push unexplained_difference");
  assert.deepEqual(driftAlerts(row, DEFAULT_DRIFT_ALERT_QUOTA), [], "unseeded 永不自动告警");

  // 经主入口：报表totals 如实分帐，警报通道零输出。
  const reported: string[] = [];
  const report = await withEnv(() =>
    reconcileAccountBalances(
      { billingUserIds: [77] },
      {
        sql: fakeSql({ entries: [] }),
        fetchUser: async () => ({ quota: 8_000_000 }),
        readEvents: async () => [upstream({ operationId: "op-lazy", jobId: "job-lazy", operation: "reserve", amountQuota: 5_000_000 })],
        alert: (message) => reported.push(message),
        now: new Date(Date.UTC(2026, 8, 24, 0, 0, 0)),
      },
    ),
  );
  assert.equal(report.totals.unseeded, 1);
  assert.equal(report.totals.unknown, 0);
  assert.equal(report.totals.matched, 0);
  assert.deepEqual(report.alerts, []);
  assert.equal(reported.length, 0);
  assert.match(report.notes.join("\n"), /帐本尚未接管/);
  const text = formatAccountReconciliationReport(report);
  assert.match(text, /\[unseeded\] user=77 我方帐本=0 quota\(0 币\) new-api=8000000 差额=不比较（帐本未接管）/);
});

test("现场实锤：opening 之前的 legacy applied 事件被基线吸收，不得再逐笔要求帐本行（user 102/82 病灶）", () => {
  // 生产实录：user 82 的 1026 笔 applied 事件中 1022 笔发生在 2026-09-23 种帐之前，
  // 对帐器把它们全算成 unrecorded（explained −230,184,485），把两层逐位相等的身份推进
  // unknown＋假告警。基线语义＝「以种帐当时的 users.quota 种入」，之前的上游变动已净入
  // opening——契约从基线起算。
  const row = reconcileAccountRow({
    billingUserId: 102,
    entries: [
      entry({ id: "e1", billingUserId: 102, entryType: "opening", amount: 1_281_108_885, idempotencyRef: "seed:102:v1" }),
    ],
    newApiQuota: 1_281_108_885,
    upstreamEvents: [
      upstream({ operationId: "op-legacy-1", jobId: "job-legacy-1", operation: "reserve", amountQuota: 500_000, appliedAt: "2026-08-22T23:30:00.000Z" }),
      upstream({ operationId: "op-legacy-2", jobId: "job-legacy-2", operation: "reserve", amountQuota: 5_000_000, appliedAt: "2026-08-22T23:45:00.000Z" }),
    ],
  });
  assert.equal(row.state, "matched", "基线前事件不参与比对 ⇒ 零 findings、差额 0 = matched");
  assert.deepEqual(row.findings, []);
  assert.equal(row.differenceQuota, 0);
});

test("基线截断不掩盖真漂移：post-seed 缺帐仍逐笔定位 explained，pre-seed 大额事件不入 findings", () => {
  const row = reconcileAccountRow({
    billingUserId: 82,
    entries: [
      entry({ id: "e1", billingUserId: 82, entryType: "opening", amount: 10_000_000, idempotencyRef: "seed:82:v1" }),
      entry({ id: "e2", billingUserId: 82, entryType: "consumption", amount: -1_000_000, jobId: "job-1", operationId: "op-1" }),
    ],
    newApiQuota: 9_300_000, // 种帐后上游还退了一笔 300,000，帐本没记
    upstreamEvents: [
      upstream({ operationId: "op-legacy", jobId: "job-legacy", operation: "reserve", amountQuota: 5_000_000, appliedAt: "2026-08-22T23:00:00.000Z" }),
      upstream({ operationId: "op-1", jobId: "job-1", operation: "reserve", amountQuota: 1_000_000, appliedAt: "2026-09-23T01:00:00.000Z" }),
      upstream({ operationId: "op-late", jobId: "job-late", operation: "refund", amountQuota: 300_000, appliedAt: "2026-09-23T06:00:00.000Z" }),
    ],
  });
  assert.equal(row.state, "explained");
  assert.equal(row.findings.length, 1, "只有 post-seed 那笔缺帐退款入 findings；5M legacy 事件不得混入");
  assert.equal(row.findings[0].kind, "unrecorded_upstream_change");
  assert.equal(row.findings[0].operationId, "op-late");
  assert.equal(row.findings[0].quota, 300_000);
  assert.equal(row.unlocatedQuota, 0);
});

// ── 告警门槛（沿用既有通道） ─────────────────────────────────────────────

test("门槛与告警：未定位差额必告警；已定位且低于门槛的零头不吵人", async () => {
  assert.equal(DEFAULT_DRIFT_ALERT_QUOTA, QUOTA_PER_COIN);

  const reported: string[] = [];
  const lowDrift = await withEnv(() =>
    reconcileAccountBalances(
      { billingUserIds: [40] },
      {
        sql: fakeSql({ entries: [entry({ id: "e1", entryType: "opening", amount: 5_000_000 })] }),
        fetchUser: async () => ({ quota: 5_000_000 - 1 }),
        readEvents: async () => [],
        alert: (message) => reported.push(message),
        now: new Date(Date.UTC(2026, 8, 23, 3, 0, 0)),
      },
    ),
  );
  // 1 quota 的残差仍是 unknown（未定位）⇒ 必须告警（低于门槛也要吵：那是解释不了的差）。
  assert.equal(lowDrift.totals.unknown, 1);
  assert.equal(reported.length, 1);
  assert.match(reported[0], /未定位差额/);

  // 已定位（explained）且差额低于门槛 → 不告警（书面记录在报表里）。
  const explainedSmall = await withEnv(() =>
    reconcileAccountBalances(
      { billingUserIds: [40] },
      {
        sql: fakeSql({ entries: [entry({ id: "e1", entryType: "opening", amount: 5_000_000 })] }),
        fetchUser: async () => ({ quota: 5_000_000 + 10 }),
        readEvents: async () => [upstream({ operationId: "op-miss", jobId: "job-miss", operation: "refund", amountQuota: 10 })],
        alert: () => undefined,
        now: new Date(Date.UTC(2026, 8, 23, 3, 0, 0)),
      },
    ),
  );
  assert.equal(explainedSmall.totals.explained, 1);
  assert.equal(explainedSmall.totals.unknown, 0);
  assert.deepEqual(explainedSmall.alerts, []);
});

test("告警门槛可由环境覆写（ACCOUNT_RECONCILE_ALERT_QUOTA），已定位差额超门槛即告警", async () => {
  const saved = process.env.ACCOUNT_RECONCILE_ALERT_QUOTA;
  process.env.ACCOUNT_RECONCILE_ALERT_QUOTA = "100";
  const reported: string[] = [];
  try {
    const report = await withEnv(() =>
      reconcileAccountBalances(
        { billingUserIds: [40] },
        {
          sql: fakeSql({ entries: [entry({ id: "e1", entryType: "opening", amount: 5_000_000 })] }),
          fetchUser: async () => ({ quota: 5_000_000 + 5_000 }),
          readEvents: async () => [upstream({ operationId: "op-miss", jobId: "job-miss", operation: "refund", amountQuota: 5_000 })],
          alert: (message) => reported.push(message),
        },
      ),
    );
    assert.equal(report.thresholdQuota, 100);
    assert.equal(report.totals.explained, 1);
    assert.equal(reported.length, 1);
    assert.match(reported[0], /两层差额 5000 quota（门槛 100）/);
  } finally {
    if (saved === undefined) delete process.env.ACCOUNT_RECONCILE_ALERT_QUOTA;
    else process.env.ACCOUNT_RECONCILE_ALERT_QUOTA = saved;
  }
});

// ── 只读 / 报表输出 ─────────────────────────────────────────────────────

test("对帐主入口：只读帐本与上游，报表可逐笔解释（含注入差异的样本）", async () => {
  const report = await withEnv(() =>
    reconcileAccountBalances(
      { billingUserIds: [40, 117] },
      {
        sql: fakeSql({
          entries: [
            entry({ id: "e1", billingUserId: 40, entryType: "opening", amount: 5_000_000 }),
            entry({ id: "e2", billingUserId: 40, entryType: "consumption", amount: -1_000_000, jobId: "job-1", operationId: "op-1" }),
            entry({ id: "e3", billingUserId: 117, entryType: "opening", amount: 0, idempotencyRef: "seed:117:v1" }),
          ],
        }),
        fetchUser: async (userId) => ({ quota: userId === 40 ? 4_300_000 : 0 }),
        readEvents: async (userId) =>
          userId === 40
            ? [
                upstream({ operationId: "op-1", jobId: "job-1", operation: "commit", amountQuota: 1_000_000, idempotencyRef: "projection:job-1:commit:1" }),
                upstream({ operationId: "op-7", jobId: "job-injected", operation: "refund", amountQuota: 300_000 }),
              ]
            : [],
        alert: () => undefined,
        now: new Date(Date.UTC(2026, 8, 23, 3, 30, 0)),
      },
    ),
  );
  assert.equal(report.configured, true);
  assert.equal(report.totals.users, 2);
  assert.equal(report.totals.explained, 1);
  assert.equal(report.totals.matched, 1);

  const text = formatAccountReconciliationReport(report);
  assert.match(text, /user=40 我方帐本=4000000 quota\(8 币\) new-api=4300000 差额=300000/);
  assert.match(text, /unrecorded_upstream_change \+300000 quota job=job-injected operation=op-7/);
  assert.match(text, /\[matched\] user=117 我方帐本=0 quota\(0 币\) new-api=0 差额=0/);
});

test("对帐主入口：没有可对的帐时不画「对帐通过」（空集合不是通过）", async () => {
  const report = await withEnv(() =>
    reconcileAccountBalances(
      { billingUserIds: [] },
      { sql: fakeSql({ entries: [] }), fetchUser: async () => ({ quota: 0 }), readEvents: async () => [], alert: () => undefined },
    ),
  );
  assert.equal(report.totals.users, 0);
  assert.equal(report.totals.matched, 0);
  assert.match(report.notes.join("\n"), /没有任何身份有帐本行或帐务事件/);
});

test("对帐对象自动探索：有帐本行或有帐务事件的身份都入列，超过上限如实标截断", async () => {
  const report = await withEnv(() =>
    reconcileAccountBalances(
      {},
      {
        sql: fakeSql({
          entries: [entry({ id: "e1", billingUserId: 40, entryType: "opening", amount: 5_000_000 })],
          subjects: [
            { billing_user_id: 40, total_identities: 5 },
            { billing_user_id: 117, total_identities: 5 },
          ],
        }),
        fetchUser: async () => ({ quota: 5_000_000 }),
        readEvents: async () => [],
        alert: () => undefined,
      },
    ),
  );
  assert.equal(report.totals.users, 2);
  assert.match(report.notes.join("\n"), /对帐身份超过单轮上限 50 个/);
});

test("变更探针：对帐模组对帐本与上游都只有读（无 INSERT/UPDATE/DELETE）", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/generation-core/account-reconciliation.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(source, /\bINSERT INTO\b/i);
  assert.doesNotMatch(source, /\bUPDATE\b/i);
  assert.doesNotMatch(source, /\bDELETE FROM\b/i);
});

/** 假控制面 SQL：对帐只用到两条 SELECT（帐本行、帐务事件）。 */
function fakeSql(seed: {
  entries: LedgerEntry[];
  events?: UpstreamBalanceEvent[];
  subjects?: { billing_user_id: number; total_identities: number }[];
}): GenerationSql {
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ? ").replace(/\s+/g, " ").trim();
    if (query.includes("count(*) OVER ()")) return seed.subjects ?? [];
    if (query.includes("FROM account_ledger WHERE billing_user_id")) {
      return seed.entries
        .filter((row) => row.billingUserId === Number(values[0]))
        .map((row) => ({
          id: row.id,
          billing_user_id: row.billingUserId,
          entry_type: row.entryType,
          amount: row.amount,
          source: row.source,
          source_ref: row.sourceRef,
          idempotency_ref: row.idempotencyRef,
          job_id: row.jobId,
          operation_id: row.operationId,
          counterparty_user_id: row.counterpartyUserId,
          note: row.note,
          created_at: row.createdAt,
        }));
    }
    if (query.includes("FROM billing_operation")) {
      return (seed.events ?? [])
        .filter(() => false)
        .map(() => ({}));
    }
    throw new Error(`fakeSql: 未预期的查询：${query}`);
  }) as unknown as GenerationSql;
  return tagged;
}
