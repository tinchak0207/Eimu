// 席位下單（刀 2）真行為斷言測試：報價 + 待支付訂單 + 明確拒單 + 冪等。

import assert from "node:assert/strict";
import test from "node:test";

import { formatMapayMoney, type MapayFields } from "@/lib/mapay";
import { resolvePricingPlan } from "@/lib/plans";
import {
  TEAM_SEAT_PRICING,
  quoteSeatOrder,
  type TeamSeatPriceTable,
} from "./team-seat-pricing.ts";
import {
  SEAT_PRICE_NOT_CONFIGURED_CODE,
  buildSeatPendingOrder,
  decideSeatOrder,
  isSeatOrderId,
  parseSeatOrderParam,
  seatOrderEntitlementCoins,
  seatOrderId,
  seatOrderParam,
} from "./team-seat-order.ts";

function priced(overrides: Partial<Record<string, Partial<Record<string, number | null>>>>): TeamSeatPriceTable {
  const table = structuredClone(TEAM_SEAT_PRICING);
  for (const [tier, cycles] of Object.entries(overrides)) {
    Object.assign(table[tier as keyof TeamSeatPriceTable], cycles);
  }
  return table;
}

const PRICED = priced({ team: { month: 39 } });

test("冪等：訂單 id 由請求四元組決定（同請求同 id、不同席位不同 id），形狀同 mapay out_trade_no", () => {
  const a = seatOrderId({ teamUserId: 117, tier: "team", cycle: "month", seats: 5 });
  const b = seatOrderId({ teamUserId: 117, tier: "team", cycle: "month", seats: 5 });
  const c = seatOrderId({ teamUserId: 117, tier: "team", cycle: "month", seats: 6 });
  const otherTeam = seatOrderId({ teamUserId: 118, tier: "team", cycle: "month", seats: 5 });

  assert.equal(a, b, "同请求重放必须得到同一个 out_trade_no（不会产生第二张订单）");
  assert.notEqual(a, c);
  assert.notEqual(a, otherTeam);
  assert.match(a, /^TS[0-9A-F]{16}$/);
  assert.equal(isSeatOrderId(a), true);
  assert.equal(isSeatOrderId("IMGABC123"), false);
  assert.equal(isSeatOrderId("TSzz"), false);
});

test("履約識別碼帶 seat: 前綴：既有金幣套餐解析器認不得它（不會被 redeem 成金幣）", () => {
  const param = seatOrderParam({ teamUserId: 117, tier: "team", cycle: "month", seats: 5 });
  assert.equal(param, "seat:117:team:month:5");
  // 真行為交叉斷言：席位訂單若誤走既有 mapay checkout，notify 端的 resolvePricingPlan
  // 必然取不到套餐 ⇒ 對支付渠道回 400（收錢不履約）。此斷言正是「必須另接履約分支」的證據。
  assert.equal(resolvePricingPlan(param), null);
  assert.equal(resolvePricingPlan(param) === null, true);
  assert.notEqual(resolvePricingPlan("popular"), null, "既有套餐仍可解析（沒被本片動到）");
});

test("待支付訂單形狀：out_trade_no/param/name/money 沿用 mapay 欄位口徑", () => {
  const quote = quoteSeatOrder({ tier: "team", cycle: "month", seats: 5 }, PRICED);
  assert.equal(quote.ok, true);
  if (!quote.ok) return;

  const order = buildSeatPendingOrder({ teamUserId: 117, quote });
  assert.deepEqual(order, {
    out_trade_no: seatOrderId({ teamUserId: 117, tier: "team", cycle: "month", seats: 5 }),
    param: "seat:117:team:month:5",
    name: "团队席位 团队档 月度 5 席",
    money: "195.00",
    currency: "CNY",
    seats: 5,
    tier: "team",
    cycle: "month",
    team_user_id: 117,
  });
  assert.equal(order.money, formatMapayMoney(quote.totalPrice));
  // 待支付訂單是可序列化的字段袋（形狀與 mapay 的 fields 同族：字串鍵值）。
  const asFields: MapayFields = { out_trade_no: order.out_trade_no, money: order.money, param: order.param };
  assert.deepEqual(Object.keys(asFields), ["out_trade_no", "money", "param"]);
});

test("價格未配置 → 409 seat_price_not_configured：沒有報價、更沒有待支付訂單", () => {
  // 未配置語義用注入的全 null 價表驗（真源已於 2026-10-01 配置；見下一條）。
  const unconfigured: TeamSeatPriceTable = {
    starter: { month: null, quarter: null, year: null },
    team: { month: null, quarter: null, year: null },
    flagship: { month: null, quarter: null, year: null },
  };
  const decision = decideSeatOrder({ teamUserId: 117, tier: "team", cycle: "month", seats: 5 }, unconfigured);
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 409);
  assert.equal(decision.code, SEAT_PRICE_NOT_CONFIGURED_CODE);
  assert.match(decision.message, /未配置/);
  assert.equal(decision.payable, false);
  assert.equal(decision.pending_order, undefined, "价格未配置不得凭空给出订单");
  assert.equal(decision.quote, undefined);
  assert.equal(JSON.stringify(decision).includes("money"), false, "不得出现任何金额字段（不能算成 0 元）");
});

test("真源已配置 → 不注入價表也能算出報價：可支付，報價/金額來自單一真源", () => {
  // 真行為斷言：改 team-seat-pricing.ts 這一個物件，下單判定（不注入）就必須跟著動。
  const decision = decideSeatOrder({ teamUserId: 117, tier: "team", cycle: "month", seats: 5 });
  assert.equal(decision.status, 200);
  assert.equal(decision.payable, true, "全链已接線：报价合法即可支付");
  assert.equal(decision.quote?.unitPrice, TEAM_SEAT_PRICING.team.month);
  assert.equal(decision.quote?.totalPrice, (TEAM_SEAT_PRICING.team.month as number) * 5);
  assert.equal(decision.pending_order?.money, formatMapayMoney((TEAM_SEAT_PRICING.team.month as number) * 5));
  assert.equal(decision.pending_order?.param.startsWith("seat:"), true);
});

test("報價合法 → 200 可支付：回報價 + 待支付訂單 + 收銀台入口（決定性 out_trade_no）", () => {
  const decision = decideSeatOrder({ teamUserId: 117, tier: "team", cycle: "month", seats: 5 }, PRICED);
  assert.equal(decision.status, 200);
  assert.equal(decision.payable, true);
  assert.equal(decision.quote?.totalPrice, 195);
  assert.equal(decision.pending_order?.money, "195.00");
  // 收銀台入口帶著同一個 seat: param（與金幣套餐 id 空間隔離）。
  assert.equal(decision.checkout.method, "GET");
  assert.match(decision.checkout.path, /^\/api\/payments\/mapay\/checkout\?plan=seat%3A117%3Ateam%3Amonth%3A5$/);
  // 接線清單保留（前兩條已落地、續費/退款未做）。
  assert.equal(decision.todo.length, 3);
  assert.match(decision.todo.join("\n"), /已落地/);
  assert.match(decision.todo.join("\n"), /fulfillMapayRedemption/);
  // 重放：同一請求再判一次，out_trade_no 一模一樣（沒有第二張訂單、沒有狀態被寫）。
  const replay = decideSeatOrder({ teamUserId: 117, tier: "team", cycle: "month", seats: 5 }, PRICED);
  assert.equal(replay.pending_order?.out_trade_no, decision.pending_order?.out_trade_no);
});

test("param 反解：seatOrderParam → parseSeatOrderParam 逐欄還原；畸形/非席位一律 null", () => {
  const identity = { teamUserId: 117, tier: "team", cycle: "month", seats: 5 };
  assert.deepEqual(parseSeatOrderParam(seatOrderParam(identity)), identity);
  // 含幣額與價表同源（席位數 × 檔位含幣額）。
  assert.equal(seatOrderEntitlementCoins(identity), 5 * 1000);
  for (const bad of [null, "", "popular", "seat:117:team:month", "seat:0:team:month:5", "seat:117:nope:month:5", "seat:117:team:monthly:5", "seat:117:team:month:0", "IMG123"]) {
    assert.equal(parseSeatOrderParam(bad), null, String(bad));
  }
  assert.equal(seatOrderEntitlementCoins({ teamUserId: 1, tier: "nope", cycle: "month", seats: 1 }), null);
});

test("參數不合法逐條回自己的碼（400），且都不產生訂單", () => {
  const cases: { input: Parameters<typeof decideSeatOrder>[0]; code: string }[] = [
    { input: { teamUserId: 117, tier: "nope", cycle: "month", seats: 1 }, code: "unknown_tier" },
    { input: { teamUserId: 117, tier: "team", cycle: "monthly", seats: 1 }, code: "invalid_cycle" },
    { input: { teamUserId: 117, tier: "team", cycle: "month", seats: 0 }, code: "invalid_seats" },
    { input: { teamUserId: 117, tier: "team", cycle: "month", seats: 1.5 }, code: "invalid_seats" },
    { input: { teamUserId: 117, tier: "team", cycle: "month", seats: "5" }, code: "invalid_seats" },
    { input: { teamUserId: 0, tier: "team", cycle: "month", seats: 5 }, code: "invalid_team" },
  ];
  for (const item of cases) {
    const decision = decideSeatOrder(item.input, PRICED);
    assert.equal(decision.ok, false, JSON.stringify(item.input));
    assert.equal(decision.status, 400);
    assert.equal(decision.code, item.code, JSON.stringify(item.input));
    assert.equal(decision.pending_order, undefined);
    assert.equal(decision.payable, false);
  }
});
