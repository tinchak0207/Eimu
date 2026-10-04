// 席位计价（刀 1）真行为断言测试：正例（总价 = 单价 × 席位）＋ 边界逐条。
//
// 价格真源未填（placeholder = null）之下，正例用**注入的价表**驱动——这同时证明
// 「报价完全由 TEAM_SEAT_PRICING 这一份资料决定」，不是散落在别处的硬编码。

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { formatMapayMoney } from "@/lib/mapay";
import {
  TEAM_SEAT_CYCLES,
  TEAM_SEAT_INCLUDED_COINS,
  TEAM_SEAT_PRICING,
  TEAM_SEAT_TIERS,
  configuredSeatUnitPrice,
  quoteSeatOrder,
  resolveSeatPerSeatCoins,
  seatIncludedCoins,
  type TeamSeatPriceTable,
} from "./team-seat-pricing.ts";

/** 注入价表：站上真实 placeholder 的形状，只把要测的格子填数字。 */
function priced(overrides: Partial<Record<string, Partial<Record<string, number | null>>>>): TeamSeatPriceTable {
  const table = structuredClone(TEAM_SEAT_PRICING);
  for (const [tier, cycles] of Object.entries(overrides)) {
    Object.assign(table[tier as keyof TeamSeatPriceTable], cycles);
  }
  return table;
}

test("正例：总价 = 每席位单价 × 席位（注入价表驱动，两位小数）", () => {
  const pricing = priced({ team: { month: 39 }, flagship: { year: 499 } });

  const quote = quoteSeatOrder({ tier: "team", cycle: "month", seats: 5 }, pricing);
  assert.equal(quote.ok, true);
  assert.deepEqual(quote, {
    ok: true,
    tier: "team",
    cycle: "month",
    seats: 5,
    unitPrice: 39,
    totalPrice: 195,
    currency: "CNY",
    note: "团队档 / 月度：39 元/席位 × 5 席位 = 195 元。",
  });

  const annual = quoteSeatOrder({ tier: "flagship", cycle: "year", seats: 3 }, pricing);
  assert.equal(annual.ok === true ? annual.totalPrice : 0, 1497, "499 × 3");
  assert.equal(
    annual.ok === true ? annual.totalPrice === annual.unitPrice * annual.seats : false,
    true,
    "总价恒等于单价 × 席位",
  );
});

test("正例：小数单价不漏精度（39.9 × 3 = 119.7），且金额格式沿用 mapay 两位小数", () => {
  const pricing = priced({ starter: { quarter: 39.9 } });
  const quote = quoteSeatOrder({ tier: "starter", cycle: "quarter", seats: 3 }, pricing);
  assert.equal(quote.ok === true ? quote.totalPrice : 0, 119.7);
  assert.equal(quote.ok === true ? formatMapayMoney(quote.totalPrice) : "", "119.70");
});

test("价格来源单一：同一请求换价表就换总价，报价不含任何别处硬编码的数字", () => {
  const base = priced({ team: { month: 39 } });
  const raised = priced({ team: { month: 59 } });

  assert.equal(quoteSeatOrder({ tier: "team", cycle: "month", seats: 4 }, base).ok === true
    ? (quoteSeatOrder({ tier: "team", cycle: "month", seats: 4 }, base) as { totalPrice: number }).totalPrice
    : 0, 156);
  const after = quoteSeatOrder({ tier: "team", cycle: "month", seats: 4 }, raised);
  assert.equal(after.ok === true ? after.totalPrice : 0, 236, "改成 59 后总价必须跟著变");
});

test("真源已配置：三档 × 三周期皆为正数单价，且集中在单一档", () => {
  for (const tier of TEAM_SEAT_TIERS) {
    for (const cycle of TEAM_SEAT_CYCLES) {
      const unit = TEAM_SEAT_PRICING[tier][cycle];
      assert.equal(
        typeof unit === "number" && Number.isFinite(unit) && unit > 0,
        true,
        `${tier}.${cycle} 必须是已配置的正数单价，目前为 ${String(unit)}`,
      );
      assert.equal(configuredSeatUnitPrice(tier, cycle), unit);
    }
  }
  // 周期口径：季度 = 月 × 3 × 0.90、年度 = 月 × 12 × 0.80（四舍五入到整元）。
  for (const tier of TEAM_SEAT_TIERS) {
    const month = TEAM_SEAT_PRICING[tier].month as number;
    assert.equal(TEAM_SEAT_PRICING[tier].quarter, Math.round(month * 3 * 0.9), `${tier} 季度折扣`);
    assert.equal(TEAM_SEAT_PRICING[tier].year, Math.round(month * 12 * 0.8), `${tier} 年度折扣`);
  }
  // 变更探针：真值只在 team-seat-pricing.ts 这一个档出现（别处不得有第二份价表）。
  const source = readFileSync(join(process.cwd(), "src/lib/team-seat-pricing.ts"), "utf8");
  assert.match(source, /席位价格唯一真源/, "档头必须标明「改价格只改本档」");
  assert.match(source, /team-seat-prd/, "定价口径必须指向 PRD（docs/prd/team-seat-prd.md §2）");
});

test("反例：seats = 0 / -1 / 1.5 / 非数 一律 invalid_seats，且不给出任何金额", () => {
  const pricing = priced({ team: { month: 39 } });
  for (const seats of [0, -1, 1.5, Number.NaN, "5", null, undefined]) {
    const quote = quoteSeatOrder({ tier: "team", cycle: "month", seats }, pricing);
    assert.equal(quote.ok, false, `seats=${String(seats)} 必须被拒`);
    assert.equal(quote.ok === false ? quote.reason : "", "invalid_seats");
    assert.equal("totalPrice" in quote, false, "被拒时不得带出总价栏位");
  }
});

test("反例：未知档位 / 未知周期各自回自己的 reason", () => {
  const pricing = priced({ team: { month: 39 } });

  const badTier = quoteSeatOrder({ tier: "enterprise", cycle: "month", seats: 2 }, pricing);
  assert.equal(badTier.ok, false);
  assert.equal(badTier.ok === false ? badTier.reason : "", "unknown_tier");
  assert.match(badTier.ok === false ? badTier.message : "", /未知席位档位/);

  const badCycle = quoteSeatOrder({ tier: "team", cycle: "monthly", seats: 2 }, pricing);
  assert.equal(badCycle.ok, false);
  assert.equal(badCycle.ok === false ? badCycle.reason : "", "invalid_cycle");
  assert.match(badCycle.ok === false ? badCycle.message : "", /未知计费周期/);

  // 档位/周期不合法时优先于价格检查（未配置的档位也不能盖掉参数错误）。
  const badTierNoPrice = quoteSeatOrder({ tier: "nope", cycle: "month", seats: 3 });
  assert.equal(badTierNoPrice.ok === false ? badTierNoPrice.reason : "", "unknown_tier");
});

test("反例：价格未配置 → price_not_configured（明确说未配置，不是 0 元）", () => {
  // 未配置的语义用**注入的全 null 价表**验（真源已于 2026-10-01 配置，见上一条）。
  const unconfigured: TeamSeatPriceTable = {
    starter: { month: null, quarter: null, year: null },
    team: { month: null, quarter: null, year: null },
    flagship: { month: null, quarter: null, year: null },
  };
  for (const tier of TEAM_SEAT_TIERS) {
    for (const cycle of TEAM_SEAT_CYCLES) {
      const quote = quoteSeatOrder({ tier, cycle, seats: 10 }, unconfigured);
      assert.equal(quote.ok, false, `${tier}/${cycle} 未配价不得成立订单`);
      assert.equal(quote.ok === false ? quote.reason : "", "price_not_configured");
      assert.match(quote.ok === false ? quote.message : "", /未配置/);
      assert.equal(JSON.stringify(quote).includes("totalPrice"), false, "不得以 0 元总价成立");
    }
  }

  // 0 / 负 / 非数 / 缺格 一律等同「未配置」（不是「免费」）。
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
    const pricing = priced({ team: { month: value } });
    const quote = quoteSeatOrder({ tier: "team", cycle: "month", seats: 1 }, pricing);
    assert.equal(quote.ok, false, `价值 ${String(value)} 不得被当成有效价`);
    assert.equal(quote.ok === false ? quote.reason : "", "price_not_configured");
  }
  const missing = quoteSeatOrder({ tier: "starter", cycle: "year", seats: 1 }, {} as TeamSeatPriceTable);
  assert.equal(missing.ok === false ? missing.reason : "", "price_not_configured");
});

test("含币额真源：300 / 1000 / 3000，且与价表同源单点（改这里改全部）", () => {
  assert.deepEqual(TEAM_SEAT_INCLUDED_COINS, { starter: 300, team: 1000, flagship: 3000 });
  for (const tier of TEAM_SEAT_TIERS) {
    assert.equal(seatIncludedCoins(tier), TEAM_SEAT_INCLUDED_COINS[tier]);
  }
  // 变更探针：含币额真值只在 team-seat-pricing.ts 这一个档出现。
  const source = readFileSync(join(process.cwd(), "src/lib/team-seat-pricing.ts"), "utf8");
  assert.match(source, /席位含币额唯一真源/);
});

test("④ per_seat_coins 上限＝所购档位含币额：超额拒、边界（＝上限）放行、非法拒", () => {
  // 真行为断言（PRD §2/§6）：上限由档位决定，不是一个可随意调的数字。
  const ok = resolveSeatPerSeatCoins({ tier: "starter", perSeatCoins: 300 });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok === true ? ok.cap : 0, 300, "上限＝轻量档含币额 300");
  assert.equal(resolveSeatPerSeatCoins({ tier: "starter", perSeatCoins: 300.5 }).ok, false, "超过上限一分也拒");

  // 逐档上限：超额一律拒、等于上限放行。
  for (const tier of TEAM_SEAT_TIERS) {
    const cap = seatIncludedCoins(tier);
    assert.equal(resolveSeatPerSeatCoins({ tier, perSeatCoins: cap }).ok, true, `${tier} 等于上限放行`);
    const over = resolveSeatPerSeatCoins({ tier, perSeatCoins: cap + 1 });
    assert.equal(over.ok, false, `${tier} 超上限必须拒`);
    assert.equal(over.ok === false ? over.reason : "", "per_seat_coins_above_included");
  }

  // 非法：未知档位 / 非正数 / 非数。
  assert.equal(resolveSeatPerSeatCoins({ tier: "nope", perSeatCoins: 1 }).ok, false);
  for (const coins of [0, -1, Number.NaN, "300", null, undefined]) {
    const result = resolveSeatPerSeatCoins({ tier: "team", perSeatCoins: coins });
    assert.equal(result.ok, false, String(coins));
    assert.equal(result.ok === false ? result.reason : "", "invalid_per_seat_coins");
  }
});
