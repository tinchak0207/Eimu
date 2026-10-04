// 付款对帐器测试：真输入 → 真输出（注入 fake sql / fake 支付商逐笔查 / fake 兑换码，零外网）。
//
// 核心验收：09-19 真单（IMGMU7UH9SFF9A21D，实付 ¥9.93、梦芽 100 金币、我方零履约痕迹）
// 必须被判为 paid_unfulfilled，且侦测到疑似人工补偿码时 manualReview=true（不得自动补交付）。
//
// 2026-10-04 契约修正：上游 `act=order` 是「按单号单查」不是列表端点，成功码是 1
// （code=0 是失败）。对帐改为「由我方已知单号逐笔查支付商」，故本测试注入 fetchOrder。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import type { GatewayRedemption } from "@/lib/gateway-admin";
import { buildMapayOrderParam } from "@/lib/mapay-order-param";
import type { MapayOrder } from "@/lib/mapay-orders";
import type { GenerationSql } from "./database.ts";
import {
  classifyMapayPaidOrder,
  formatMapayOrderReconciliationReport,
  manualCompensationCandidatesFor,
  mapayCandidateOrderNumbersFromRedemptionNames,
  normalizeMapayOrderCandidates,
  reconcileMapayOrders,
  resolveOrderPlan,
} from "./mapay-order-reconciliation.ts";

const RELAY_SECRET = "test-relay-secret";

function order(overrides: Partial<MapayOrder> = {}): MapayOrder {
  return {
    outTradeNo: overrides.outTradeNo ?? "IMGORDER1",
    tradeNo: overrides.tradeNo ?? null,
    money: overrides.money ?? 9.9,
    status: overrides.status ?? "TRADE_SUCCESS",
    paid: overrides.paid ?? true,
    name: overrides.name ?? "eimu.dev 梦芽 · 轻度尝鲜包 100金币",
    type: overrides.type ?? "alipay",
    createdAt: overrides.createdAt ?? "2026-09-19T03:45:38.000Z",
    paidAt: overrides.paidAt ?? "2026-09-19T03:49:00.000Z",
    raw: overrides.raw ?? {},
  };
}

function redemption(overrides: Partial<GatewayRedemption>): GatewayRedemption {
  return { id: overrides.id ?? 1, key: overrides.key ?? "k", quota: overrides.quota ?? 50_000_000, ...overrides };
}

// ── 套餐解析 ────────────────────────────────────────────────────────────

test("resolveOrderPlan：name 内金币数优先（梦芽 100 金币 → 50,000,000 quota）", () => {
  const plan = resolveOrderPlan(order());
  assert.equal(plan?.coins, 100);
  assert.equal(plan?.quota, 100 * QUOTA_PER_COIN);
});

test("resolveOrderPlan：name 认不出时用 money 对档位（容忍手续费 9.93→starter / 7.00→first-charge）", () => {
  const starter = resolveOrderPlan(order({ name: "eimu.dev 套餐", money: 9.93 }));
  assert.equal(starter?.planId, "starter");
  const firstCharge = resolveOrderPlan(order({ name: "eimu.dev 套餐", money: 7 }));
  assert.equal(firstCharge?.planId, "first-charge");
});

test("resolveOrderPlan：param 自签可精确还原 planId；认不出回 null", () => {
  // planId=popular, userId=253 的自签 param（取自已登入下单形状 popular.253.<hmac8>）。
  const param = buildMapayOrderParam("popular", 253, RELAY_SECRET);
  const saved = process.env.GENERATION_BILLING_RELAY_SECRET;
  process.env.GENERATION_BILLING_RELAY_SECRET = RELAY_SECRET;
  try {
    const plan = resolveOrderPlan(order({ name: "eimu.dev 套餐", money: 29.9, raw: { param } }));
    assert.equal(plan?.planId, "popular");
    assert.equal(plan?.coins, 500);
  } finally {
    if (saved === undefined) delete process.env.GENERATION_BILLING_RELAY_SECRET;
    else process.env.GENERATION_BILLING_RELAY_SECRET = saved;
  }
  assert.equal(resolveOrderPlan(order({ name: "eimu.dev 套餐", money: 12345 })), null);
});

// ── 判定（纯函式） ──────────────────────────────────────────────────────

test("判定：mapay_credit=applied → fulfilled", () => {
  const finding = classifyMapayPaidOrder({
    order: order(),
    evidence: { creditStatus: "applied", redemption: null, ledgerRecharge: null },
    expectedQuota: 50_000_000,
    planId: "starter",
    manualCompensationCandidates: [],
    evidenceUnreadable: false,
  });
  assert.equal(finding.verdict, "fulfilled");
  assert.equal(finding.evidence.mapayCreditApplied, true);
});

test("判定：account_ledger recharge(redemption:<单号>) → fulfilled（独立于 mapay_credit 的第二证据）", () => {
  const finding = classifyMapayPaidOrder({
    order: order(),
    evidence: { creditStatus: null, redemption: null, ledgerRecharge: { amountQuota: 50_000_000, createdAt: "2026-09-19T06:00:00.000Z" } },
    expectedQuota: 50_000_000,
    planId: "starter",
    manualCompensationCandidates: [],
    evidenceUnreadable: false,
  });
  assert.equal(finding.verdict, "fulfilled");
  assert.equal(finding.evidence.ledgerRecharge, true);
});

test("判定：兑换码 MP<后18位> 且 quota 相符 → fulfilled；quota 不符 → unknown（冻结不误发）", () => {
  const matched = classifyMapayPaidOrder({
    order: order(),
    evidence: { creditStatus: null, redemption: { name: "MPIMGORDER1", quota: 50_000_000, used: true, createdAt: null }, ledgerRecharge: null },
    expectedQuota: 50_000_000,
    planId: "starter",
    manualCompensationCandidates: [],
    evidenceUnreadable: false,
  });
  assert.equal(matched.verdict, "fulfilled");

  const mismatch = classifyMapayPaidOrder({
    order: order(),
    evidence: { creditStatus: null, redemption: { name: "MPIMGORDER1", quota: 35_000_000, used: true, createdAt: null }, ledgerRecharge: null },
    expectedQuota: 50_000_000,
    planId: "starter",
    manualCompensationCandidates: [],
    evidenceUnreadable: false,
  });
  assert.equal(mismatch.verdict, "unknown");
  assert.equal(mismatch.manualReview, true);
});

test("判定：mapay_credit 占位但结果未定（pending/unknown）→ unknown（不开第二条发放通道）", () => {
  for (const status of ["pending", "unknown"] as const) {
    const finding = classifyMapayPaidOrder({
      order: order(),
      evidence: { creditStatus: status, redemption: null, ledgerRecharge: null },
      expectedQuota: 50_000_000,
      planId: "starter",
      manualCompensationCandidates: [],
      evidenceUnreadable: false,
    });
    assert.equal(finding.verdict, "unknown");
    assert.equal(finding.manualReview, true);
  }
});

test("判定：三条证据皆无 → paid_unfulfilled（09-19 那笔落此桶）", () => {
  const finding = classifyMapayPaidOrder({
    order: order(),
    evidence: { creditStatus: null, redemption: null, ledgerRecharge: null },
    expectedQuota: 50_000_000,
    planId: "starter",
    manualCompensationCandidates: [],
    evidenceUnreadable: false,
  });
  assert.equal(finding.verdict, "paid_unfulfilled");
  assert.equal(finding.manualReview, false);
});

test("判定：证据来源读不到时不误判未履约 → unknown（禁同源断言的空集合陷阱）", () => {
  const finding = classifyMapayPaidOrder({
    order: order(),
    evidence: { creditStatus: null, redemption: null, ledgerRecharge: null },
    expectedQuota: null,
    planId: null,
    manualCompensationCandidates: [],
    evidenceUnreadable: true,
  });
  assert.equal(finding.verdict, "unknown");
  assert.match(finding.reason, /证据来源读取失败/);
});

test("人工补偿码候选：只列非系统码、且只作候选不当证据", () => {
  const candidates = manualCompensationCandidatesFor(
    order({ paidAt: "2026-09-19T06:08:00.000Z", money: 9.93 }),
    [
      redemption({ id: 1, name: "MANUAL-1500C-0919", quota: 750_000_000 }),
      redemption({ id: 2, name: "MPFIX993-0919", quota: 50_000_000 }),
      redemption({ id: 3, name: "MPIMGMQN87UBEB0DBDD", quota: 50_000_000 }), // 系统码，不得入候选
      redemption({ id: 4, name: "eimu1500", quota: 750_000_000 }), // 无日期无金额，不入
    ],
  );
  assert.deepEqual(candidates.sort(), ["MANUAL-1500C-0919", "MPFIX993-0919"]);
});

// ── 候选单号推导（取代无法列举的窗口清单） ──────────────────────────────

test("候选单号反推与正规化：MP<后18位> 可反推、逾 18 位截断不猜、非法字元丢弃", () => {
  const eighteen = "ABCDEFGHIJKLMNOPQR"; // 18 位
  assert.deepEqual(
    mapayCandidateOrderNumbersFromRedemptionNames([
      "MPIMGMU7UH9SFF9A21D",
      `MP${eighteen}`,
      `MP${eighteen}X`, // 19 位＝已截断，不可反推
      "MANUAL-0919", // 非系统码
      "mp-lower", // 小写＋连字号，不符系统码格式
    ]).sort(),
    ["IMGMU7UH9SFF9A21D", eighteen].sort(),
  );
  assert.deepEqual(normalizeMapayOrderCandidates([" IMG1 ", "IMG1", "bad name", ""]), ["IMG1"]);
});

// ── 主入口（真输入真输出） ───────────────────────────────────────────────

test("09-19 真单实证（显式探针 orders=[]）：支付商回报已付款、我方零履约痕迹、只有人工补偿码 → paid_unfulfilled + manualReview", async () => {
  const alerts: string[] = [];
  const report = await reconcileMapayOrders(
    {},
    {
      sql: fakeSql({ credit: [], ledger: [] }),
      orders: ["IMGMU7UH9SFF9A21D"],
      fetchOrder: async (outTradeNo) =>
        outTradeNo === "IMGMU7UH9SFF9A21D"
          ? order({
              outTradeNo,
              tradeNo: "20260919114538891000",
              money: 9.93,
              paidAt: "2026-09-19T03:49:00.000Z",
              name: "eimu.dev 梦芽 · 轻度尝鲜包 100金币",
            })
          : null,
      listRedemptions: async () => [
        redemption({ id: 1, name: "MANUAL-1500C-0919", quota: 750_000_000 }),
        redemption({ id: 2, name: "MPFIX993-0919", quota: 50_000_000 }),
      ],
      alert: (message) => alerts.push(message),
      now: new Date("2026-10-04T00:00:00.000Z"),
    },
  );
  assert.equal(report.configured, true);
  assert.equal(report.explicitProbe, true);
  assert.equal(report.residue.candidates, 1);
  assert.equal(report.residue.found, 1);
  assert.equal(report.checked, 1);
  assert.equal(report.fulfilled, 0);
  assert.equal(report.paidUnfulfilled.length, 1);
  const finding = report.paidUnfulfilled[0];
  assert.equal(finding.outTradeNo, "IMGMU7UH9SFF9A21D");
  assert.equal(finding.expectedQuota, 50_000_000);
  assert.equal(finding.manualReview, true);
  assert.deepEqual(finding.manualCompensationCandidates.sort(), ["MANUAL-1500C-0919", "MPFIX993-0919"]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /IMGMU7UH9SFF9A21D/);
  assert.match(formatMapayOrderReconciliationReport(report), /paid_unfulfilled.*IMGMU7UH9SFF9A21D/);
});

test("默认取数：候选单号由 intake／credit／ledger(redemption:)／兑换码名(MP<后18位>) 推导，逐笔查支付商", async () => {
  const queried: string[] = [];
  const report = await reconcileMapayOrders(
    {},
    {
      sql: fakeSql({
        intake: [{ out_trade_no: "IMGINTAKE" }],
        credit: [{ out_trade_no: "IMGCREDIT" }],
        ledger: [
          { source_ref: "redemption:IMGLEDGER", billing_user_id: 1, amount: 50_000_000, created_at: "2026-09-19T06:00:00.000Z" },
        ],
      }),
      fetchOrder: async (outTradeNo) => {
        queried.push(outTradeNo);
        return order({ outTradeNo });
      },
      listRedemptions: async () => [redemption({ id: 9, name: "MPIMGCODE", quota: 50_000_000, status: 2 })],
      alert: () => undefined,
    },
  );
  assert.deepEqual(queried.sort(), ["IMGCODE", "IMGCREDIT", "IMGINTAKE", "IMGLEDGER"]);
  assert.equal(report.residue.candidates, 4);
  assert.equal(report.residue.found, 4);
  assert.equal(report.checked, 4);
  assert.equal(report.fulfilled, 2); // ledger redemption 证据 + 兑换码 MPIMGCODE
  assert.equal(report.paidUnfulfilled.length, 2);
  assert.equal(report.residue.upstreamEmpty, false);
});

test("候选单号全部查无（found=0）→ upstream_empty=true，不得当健康", async () => {
  const report = await reconcileMapayOrders(
    {},
    {
      sql: fakeSql({ credit: [], ledger: [] }),
      orders: ["NOPE1", "NOPE2"],
      fetchOrder: async () => null,
      listRedemptions: async () => [],
      alert: () => undefined,
    },
  );
  assert.equal(report.residue.candidates, 2);
  assert.equal(report.residue.found, 0);
  assert.equal(report.residue.notFound, 2);
  assert.equal(report.residue.upstreamEmpty, true);
  assert.equal(report.checked, 0);
  assert.match(report.notes.join("\n"), /查无订单实体/);
});

test("逐笔查询抛错 → query_errors 记单号（与证据不可读分开），且不当健康", async () => {
  const report = await reconcileMapayOrders(
    {},
    {
      sql: fakeSql({ credit: [], ledger: [] }),
      orders: ["IMGBOOM"],
      fetchOrder: async () => {
        throw new Error("relay down");
      },
      listRedemptions: async () => [],
      alert: () => undefined,
    },
  );
  assert.deepEqual(report.residue.queryErrors, ["IMGBOOM"]);
  assert.equal(report.residue.evidenceUnreadable.length, 0);
  assert.equal(report.residue.upstreamEmpty, true);
  assert.equal(report.checked, 0);
});

test("已履约单（mapay_credit=applied，候选由 credit 表推导）记 fulfilled", async () => {
  const report = await reconcileMapayOrders(
    {},
    {
      sql: fakeSql({ credit: [{ out_trade_no: "IMGDONE", user_id: 7, status: "applied", updated_at: "2026-09-20T00:00:00.000Z" }], ledger: [] }),
      fetchOrder: async (outTradeNo) => order({ outTradeNo }),
      listRedemptions: async () => [],
      alert: () => undefined,
      now: new Date("2026-10-04T00:00:00.000Z"),
    },
  );
  assert.equal(report.fulfilled, 1);
  assert.equal(report.paidUnfulfilled.length, 0);
});

test("兑换码证据命中 → fulfilled；未付款单不进 checked（残差如实计数）", async () => {
  const report = await reconcileMapayOrders(
    {},
    {
      sql: fakeSql({ credit: [], ledger: [] }),
      orders: ["IMGVIA", "IMGPENDING"],
      fetchOrder: async (outTradeNo) =>
        order({ outTradeNo, paid: outTradeNo === "IMGVIA", status: outTradeNo === "IMGVIA" ? "TRADE_SUCCESS" : "WAIT_BUYER_PAY" }),
      listRedemptions: async () => [redemption({ id: 9, name: "MPIMGVIA", quota: 50_000_000, status: 2 })],
      alert: () => undefined,
    },
  );
  assert.equal(report.residue.found, 2);
  assert.equal(report.checked, 1);
  assert.equal(report.fulfilled, 1);
  assert.equal(report.residue.notPaid, 1);
});

test("证据来源读取失败（mapay_credit 查询抛错）→ 该单冻结 unknown，不误判未履约", async () => {
  const report = await reconcileMapayOrders(
    {},
    {
      sql: fakeSql({ credit: [], ledger: [], creditThrows: true }),
      orders: ["IMGBROKEN"],
      fetchOrder: async (outTradeNo) => order({ outTradeNo }),
      listRedemptions: async () => [],
      alert: () => undefined,
    },
  );
  assert.equal(report.unknown.length, 1);
  assert.equal(report.paidUnfulfilled.length, 0);
  assert.deepEqual(report.residue.evidenceUnreadable, ["mapay_credit"]);
});

test("未配置控制面资料库：configured=false、清楚说明不可用（不假装健康）", async () => {
  const saved = process.env.GENERATION_DATABASE_URL;
  delete process.env.GENERATION_DATABASE_URL;
  try {
    const report = await reconcileMapayOrders({}, { now: new Date("2026-10-04T00:00:00.000Z") });
    assert.equal(report.configured, false);
    assert.match(report.notes.join("\n"), /没有控制面资料库连线/);
  } finally {
    if (saved !== undefined) process.env.GENERATION_DATABASE_URL = saved;
  }
});

// ── 只读守门（变更探针） ────────────────────────────────────────────────

test("变更探针：对帐模组对我方帐本／额度／支付商都只有读（无 INSERT/UPDATE/DELETE）", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/generation-core/mapay-order-reconciliation.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(source, /\bINSERT INTO\b/i);
  assert.doesNotMatch(source, /\bUPDATE\b/i);
  assert.doesNotMatch(source, /\bDELETE FROM\b/i);
});

// ── 假控制面 SQL（对帐只用到 SELECT） ───────────────────────────────────

function fakeSql(seed: {
  intake?: Record<string, unknown>[];
  credit: Record<string, unknown>[];
  ledger: Record<string, unknown>[];
  creditThrows?: boolean;
}): GenerationSql {
  const tagged = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join(" ? ").replace(/\s+/g, " ").trim();
    if (query.includes("FROM mapay_order_intake")) return seed.intake ?? [];
    if (query.includes("FROM mapay_credit")) {
      if (seed.creditThrows) throw new Error('relation "mapay_credit" does not exist');
      return seed.credit;
    }
    if (query.includes("FROM account_ledger")) return seed.ledger;
    throw new Error(`fakeSql: 未预期的查询：${query}`);
  }) as unknown as GenerationSql;
  return tagged;
}