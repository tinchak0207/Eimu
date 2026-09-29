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
  TEAM_SEAT_PRICING,
  TEAM_SEAT_TIERS,
  configuredSeatUnitPrice,
  quoteSeatOrder,
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

test("placeholder 形狀：真實真源三檔 × 三週期全為 null（未配置），且集中在單一檔", () => {
  for (const tier of TEAM_SEAT_TIERS) {
    for (const cycle of TEAM_SEAT_CYCLES) {
      assert.equal(
        TEAM_SEAT_PRICING[tier][cycle],
        null,
        `${tier}.${cycle} 必須是 null placeholder（待暴君填），目前為 ${String(TEAM_SEAT_PRICING[tier][cycle])}`,
      );
      assert.equal(configuredSeatUnitPrice(tier, cycle), null);
    }
  }
  // 變更探針：真值只在 team-seat-pricing.ts 這一個檔出現（別處不得有第二份價表）。
  const source = readFileSync(join(process.cwd(), "src/lib/team-seat-pricing.ts"), "utf8");
  assert.match(source, /席位價格唯一真源/, "檔頭必須標明「改價格只改本檔」");
  assert.match(source, /待暴君填/);
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
  // 真源目前全 null：三個檔位 × 三個週期都必須是「未配置」。
  for (const tier of TEAM_SEAT_TIERS) {
    for (const cycle of TEAM_SEAT_CYCLES) {
      const quote = quoteSeatOrder({ tier, cycle, seats: 10 });
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
