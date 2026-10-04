// 席位下单（刀 2）真行为断言测试：报价 + 待支付订单 + 明确拒单 + 幂等。

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

test("幂等：订单 id 由请求四元组决定（同请求同 id、不同席位不同 id），形状同 mapay out_trade_no", () => {
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

test("履约识别码带 seat: 前缀：既有金币套餐解析器认不得它（不会被 redeem 成金币）", () => {
  const param = seatOrderParam({ teamUserId: 117, tier: "team", cycle: "month", seats: 5 });
  assert.equal(param, "seat:117:team:month:5");
  // 真行为交叉断言：席位订单若误走既有 mapay checkout，notify 端的 resolvePricingPlan
  // 必然取不到套餐 ⇒ 对支付渠道回 400（收钱不履约）。此断言正是「必须另接履约分支」的证据。
  assert.equal(resolvePricingPlan(param), null);
  assert.equal(resolvePricingPlan(param) === null, true);
  assert.notEqual(resolvePricingPlan("popular"), null, "既有套餐仍可解析（没被本片动到）");
});

test("待支付订单形状：out_trade_no/param/name/money 沿用 mapay 栏位口径", () => {
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
  // 待支付订单是可序列化的字段袋（形状与 mapay 的 fields 同族：字串键值）。
  const asFields: MapayFields = { out_trade_no: order.out_trade_no, money: order.money, param: order.param };
  assert.deepEqual(Object.keys(asFields), ["out_trade_no", "money", "param"]);
});

test("价格未配置 → 409 seat_price_not_configured：没有报价、更没有待支付订单", () => {
  // 未配置语义用注入的全 null 价表验（真源已于 2026-10-01 配置；见下一条）。
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

test("真源已配置 → 不注入价表也能算出报价：可支付，报价/金额来自单一真源", () => {
  // 真行为断言：改 team-seat-pricing.ts 这一个物件，下单判定（不注入）就必须跟著动。
  const decision = decideSeatOrder({ teamUserId: 117, tier: "team", cycle: "month", seats: 5 });
  assert.equal(decision.status, 200);
  assert.equal(decision.payable, true, "全链已接线：报价合法即可支付");
  assert.equal(decision.quote?.unitPrice, TEAM_SEAT_PRICING.team.month);
  assert.equal(decision.quote?.totalPrice, (TEAM_SEAT_PRICING.team.month as number) * 5);
  assert.equal(decision.pending_order?.money, formatMapayMoney((TEAM_SEAT_PRICING.team.month as number) * 5));
  assert.equal(decision.pending_order?.param.startsWith("seat:"), true);
});

test("报价合法 → 200 可支付：回报价 + 待支付订单 + 收银台入口（决定性 out_trade_no）", () => {
  const decision = decideSeatOrder({ teamUserId: 117, tier: "team", cycle: "month", seats: 5 }, PRICED);
  assert.equal(decision.status, 200);
  assert.equal(decision.payable, true);
  assert.equal(decision.quote?.totalPrice, 195);
  assert.equal(decision.pending_order?.money, "195.00");
  // 收银台入口带著同一个 seat: param（与金币套餐 id 空间隔离）。
  assert.equal(decision.checkout.method, "GET");
  assert.match(decision.checkout.path, /^\/api\/payments\/mapay\/checkout\?plan=seat%3A117%3Ateam%3Amonth%3A5$/);
  // 接线清单保留（前两条已落地、续费/退款未做）。
  assert.equal(decision.todo.length, 3);
  assert.match(decision.todo.join("\n"), /已落地/);
  assert.match(decision.todo.join("\n"), /fulfillMapayRedemption/);
  // 重放：同一请求再判一次，out_trade_no 一模一样（没有第二张订单、没有状态被写）。
  const replay = decideSeatOrder({ teamUserId: 117, tier: "team", cycle: "month", seats: 5 }, PRICED);
  assert.equal(replay.pending_order?.out_trade_no, decision.pending_order?.out_trade_no);
});

test("param 反解：seatOrderParam → parseSeatOrderParam 逐栏还原；畸形/非席位一律 null", () => {
  const identity = { teamUserId: 117, tier: "team", cycle: "month", seats: 5 };
  assert.deepEqual(parseSeatOrderParam(seatOrderParam(identity)), identity);
  // 含币额与价表同源（席位数 × 档位含币额）。
  assert.equal(seatOrderEntitlementCoins(identity), 5 * 1000);
  for (const bad of [null, "", "popular", "seat:117:team:month", "seat:0:team:month:5", "seat:117:nope:month:5", "seat:117:team:monthly:5", "seat:117:team:month:0", "IMG123"]) {
    assert.equal(parseSeatOrderParam(bad), null, String(bad));
  }
  assert.equal(seatOrderEntitlementCoins({ teamUserId: 1, tier: "nope", cycle: "month", seats: 1 }), null);
});

test("参数不合法逐条回自己的码（400），且都不产生订单", () => {
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
