// 席位計價（刀 1）真行為斷言測試：正例（總價 = 單價 × 席位）＋ 邊界逐條。
//
// 價格真源未填（placeholder = null）之下，正例用**注入的價表**驅動——這同時證明
// 「報價完全由 TEAM_SEAT_PRICING 這一份資料決定」，不是散落在別處的硬編碼。

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

/** 注入價表：站上真實 placeholder 的形狀，只把要測的格子填數字。 */
function priced(overrides: Partial<Record<string, Partial<Record<string, number | null>>>>): TeamSeatPriceTable {
  const table = structuredClone(TEAM_SEAT_PRICING);
  for (const [tier, cycles] of Object.entries(overrides)) {
    Object.assign(table[tier as keyof TeamSeatPriceTable], cycles);
  }
  return table;
}

test("正例：總價 = 每席位單價 × 席位（注入價表驅動，兩位小數）", () => {
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
    "總價恆等於單價 × 席位",
  );
});

test("正例：小數單價不漏精度（39.9 × 3 = 119.7），且金額格式沿用 mapay 兩位小數", () => {
  const pricing = priced({ starter: { quarter: 39.9 } });
  const quote = quoteSeatOrder({ tier: "starter", cycle: "quarter", seats: 3 }, pricing);
  assert.equal(quote.ok === true ? quote.totalPrice : 0, 119.7);
  assert.equal(quote.ok === true ? formatMapayMoney(quote.totalPrice) : "", "119.70");
});

test("價格來源單一：同一請求換價表就換總價，報價不含任何別處硬編碼的數字", () => {
  const base = priced({ team: { month: 39 } });
  const raised = priced({ team: { month: 59 } });

  assert.equal(quoteSeatOrder({ tier: "team", cycle: "month", seats: 4 }, base).ok === true
    ? (quoteSeatOrder({ tier: "team", cycle: "month", seats: 4 }, base) as { totalPrice: number }).totalPrice
    : 0, 156);
  const after = quoteSeatOrder({ tier: "team", cycle: "month", seats: 4 }, raised);
  assert.equal(after.ok === true ? after.totalPrice : 0, 236, "改成 59 後總價必須跟著變");
});

test("真源已配置：三檔 × 三週期皆為正數單價，且集中在單一檔", () => {
  for (const tier of TEAM_SEAT_TIERS) {
    for (const cycle of TEAM_SEAT_CYCLES) {
      const unit = TEAM_SEAT_PRICING[tier][cycle];
      assert.equal(
        typeof unit === "number" && Number.isFinite(unit) && unit > 0,
        true,
        `${tier}.${cycle} 必須是已配置的正數單價，目前為 ${String(unit)}`,
      );
      assert.equal(configuredSeatUnitPrice(tier, cycle), unit);
    }
  }
  // 週期口徑：季度 = 月 × 3 × 0.90、年度 = 月 × 12 × 0.80（四捨五入到整元）。
  for (const tier of TEAM_SEAT_TIERS) {
    const month = TEAM_SEAT_PRICING[tier].month as number;
    assert.equal(TEAM_SEAT_PRICING[tier].quarter, Math.round(month * 3 * 0.9), `${tier} 季度折扣`);
    assert.equal(TEAM_SEAT_PRICING[tier].year, Math.round(month * 12 * 0.8), `${tier} 年度折扣`);
  }
  // 變更探針：真值只在 team-seat-pricing.ts 這一個檔出現（別處不得有第二份價表）。
  const source = readFileSync(join(process.cwd(), "src/lib/team-seat-pricing.ts"), "utf8");
  assert.match(source, /席位價格唯一真源/, "檔頭必須標明「改價格只改本檔」");
  assert.match(source, /team-seat-prd/, "定價口徑必須指向 PRD（docs/prd/team-seat-prd.md §2）");
});

test("反例：seats = 0 / -1 / 1.5 / 非數 一律 invalid_seats，且不給出任何金額", () => {
  const pricing = priced({ team: { month: 39 } });
  for (const seats of [0, -1, 1.5, Number.NaN, "5", null, undefined]) {
    const quote = quoteSeatOrder({ tier: "team", cycle: "month", seats }, pricing);
    assert.equal(quote.ok, false, `seats=${String(seats)} 必須被拒`);
    assert.equal(quote.ok === false ? quote.reason : "", "invalid_seats");
    assert.equal("totalPrice" in quote, false, "被拒時不得帶出總價欄位");
  }
});

test("反例：未知檔位 / 未知週期各自回自己的 reason", () => {
  const pricing = priced({ team: { month: 39 } });

  const badTier = quoteSeatOrder({ tier: "enterprise", cycle: "month", seats: 2 }, pricing);
  assert.equal(badTier.ok, false);
  assert.equal(badTier.ok === false ? badTier.reason : "", "unknown_tier");
  assert.match(badTier.ok === false ? badTier.message : "", /未知席位档位/);

  const badCycle = quoteSeatOrder({ tier: "team", cycle: "monthly", seats: 2 }, pricing);
  assert.equal(badCycle.ok, false);
  assert.equal(badCycle.ok === false ? badCycle.reason : "", "invalid_cycle");
  assert.match(badCycle.ok === false ? badCycle.message : "", /未知计费周期/);

  // 檔位/週期不合法時優先於價格檢查（未配置的檔位也不能蓋掉參數錯誤）。
  const badTierNoPrice = quoteSeatOrder({ tier: "nope", cycle: "month", seats: 3 });
  assert.equal(badTierNoPrice.ok === false ? badTierNoPrice.reason : "", "unknown_tier");
});

test("反例：價格未配置 → price_not_configured（明確說未配置，不是 0 元）", () => {
  // 未配置的語義用**注入的全 null 價表**驗（真源已於 2026-10-01 配置，見上一條）。
  const unconfigured: TeamSeatPriceTable = {
    starter: { month: null, quarter: null, year: null },
    team: { month: null, quarter: null, year: null },
    flagship: { month: null, quarter: null, year: null },
  };
  for (const tier of TEAM_SEAT_TIERS) {
    for (const cycle of TEAM_SEAT_CYCLES) {
      const quote = quoteSeatOrder({ tier, cycle, seats: 10 }, unconfigured);
      assert.equal(quote.ok, false, `${tier}/${cycle} 未配價不得成立訂單`);
      assert.equal(quote.ok === false ? quote.reason : "", "price_not_configured");
      assert.match(quote.ok === false ? quote.message : "", /未配置/);
      assert.equal(JSON.stringify(quote).includes("totalPrice"), false, "不得以 0 元總價成立");
    }
  }

  // 0 / 負 / 非數 / 缺格 一律等同「未配置」（不是「免費」）。
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
    const pricing = priced({ team: { month: value } });
    const quote = quoteSeatOrder({ tier: "team", cycle: "month", seats: 1 }, pricing);
    assert.equal(quote.ok, false, `價值 ${String(value)} 不得被當成有效價`);
    assert.equal(quote.ok === false ? quote.reason : "", "price_not_configured");
  }
  const missing = quoteSeatOrder({ tier: "starter", cycle: "year", seats: 1 }, {} as TeamSeatPriceTable);
  assert.equal(missing.ok === false ? missing.reason : "", "price_not_configured");
});

test("含幣額真源：300 / 1000 / 3000，且與價表同源單點（改這裡改全部）", () => {
  assert.deepEqual(TEAM_SEAT_INCLUDED_COINS, { starter: 300, team: 1000, flagship: 3000 });
  for (const tier of TEAM_SEAT_TIERS) {
    assert.equal(seatIncludedCoins(tier), TEAM_SEAT_INCLUDED_COINS[tier]);
  }
  // 變更探針：含幣額真值只在 team-seat-pricing.ts 這一個檔出現。
  const source = readFileSync(join(process.cwd(), "src/lib/team-seat-pricing.ts"), "utf8");
  assert.match(source, /席位含幣額唯一真源/);
});

test("④ per_seat_coins 上限＝所購檔位含幣額：超額拒、邊界（＝上限）放行、非法拒", () => {
  // 真行為斷言（PRD §2/§6）：上限由檔位決定，不是一個可隨意調的數字。
  const ok = resolveSeatPerSeatCoins({ tier: "starter", perSeatCoins: 300 });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok === true ? ok.cap : 0, 300, "上限＝轻量档含币额 300");
  assert.equal(resolveSeatPerSeatCoins({ tier: "starter", perSeatCoins: 300.5 }).ok, false, "超过上限一分也拒");

  // 逐檔上限：超額一律拒、等於上限放行。
  for (const tier of TEAM_SEAT_TIERS) {
    const cap = seatIncludedCoins(tier);
    assert.equal(resolveSeatPerSeatCoins({ tier, perSeatCoins: cap }).ok, true, `${tier} 等于上限放行`);
    const over = resolveSeatPerSeatCoins({ tier, perSeatCoins: cap + 1 });
    assert.equal(over.ok, false, `${tier} 超上限必须拒`);
    assert.equal(over.ok === false ? over.reason : "", "per_seat_coins_above_included");
  }

  // 非法：未知檔位 / 非正數 / 非數。
  assert.equal(resolveSeatPerSeatCoins({ tier: "nope", perSeatCoins: 1 }).ok, false);
  for (const coins of [0, -1, Number.NaN, "300", null, undefined]) {
    const result = resolveSeatPerSeatCoins({ tier: "team", perSeatCoins: coins });
    assert.equal(result.ok, false, String(coins));
    assert.equal(result.ok === false ? result.reason : "", "invalid_per_seat_coins");
  }
});
