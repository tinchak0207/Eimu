// 席位履約分支真行為斷言測試（PRD §4/§6）：money 覆核、履約目標、冪等、上限。
//
// 真行為 = 履約入帳的呼叫逐筆記錄（deps 注入假通道），不是源碼字串斷言。
// 冪等由「同一張單（決定性 out_trade_no）只入帳一次」這個可觀察事實斷言：
// 假通道按 out_trade_no 去重（與生產 mapay_credit 主鍵同語義）。

import assert from "node:assert/strict";
import test from "node:test";

import type { MapayCreditOutcome } from "@/lib/mapay-credit";
import { formatMapayMoney } from "@/lib/mapay";
import { seatOrderId, seatOrderParam } from "./team-seat-order.ts";
import { TEAM_SEAT_INCLUDED_COINS, TEAM_SEAT_PRICING, quoteSeatOrder } from "./team-seat-pricing.ts";
import { fulfillSeatOrder, isSeatOrderParam } from "./team-seat-fulfillment.ts";

interface CreditCall {
  orderId: string;
  userId: number;
  param: string;
}

/** 假入帳通道：按 out_trade_no 去重（credited 一次、其餘 already_credited），逐筆記錄呼叫。 */
function fakeCredit(outcome: MapayCreditOutcome = "credited") {
  const calls: CreditCall[] = [];
  const applied = new Set<string>();
  const credit = async (input: CreditCall): Promise<MapayCreditOutcome> => {
    calls.push(input);
    if (outcome !== "credited") return outcome;
    if (applied.has(input.orderId)) return "already_credited";
    applied.add(input.orderId);
    return "credited";
  };
  return { calls, credit, applied };
}

const IDENT = { teamUserId: 117, tier: "team", cycle: "month", seats: 5 };
const PARAM = seatOrderParam(IDENT);
const ORDER_ID = seatOrderId(IDENT);
const TOTAL = formatMapayMoney((TEAM_SEAT_PRICING.team.month as number) * IDENT.seats);

test("非席位 param → handled:false（完全走既有 plan 流程，不碰履約）", async () => {
  const { calls, credit } = fakeCredit();
  for (const param of [null, undefined, "", "popular", "custom:5000", "IMG123"]) {
    const result = await fulfillSeatOrder({ param, money: TOTAL, orderId: ORDER_ID }, { creditSeatOrder: credit });
    assert.equal(result.handled, false, String(param));
  }
  assert.equal(calls.length, 0, "非席位订单不得触发任何入帐");
  assert.equal(isSeatOrderParam(PARAM), true);
});

test("① 金額不符 → 拒且不履約（一次入帳都不發生）", async () => {
  const { calls, credit } = fakeCredit();
  for (const money of [undefined, "", "0.00", "1.00", (Number(TOTAL) - 5).toFixed(2), "999999.00"]) {
    const result = await fulfillSeatOrder({ param: PARAM, money, orderId: ORDER_ID }, { creditSeatOrder: credit });
    assert.equal(result.handled, true, String(money));
    assert.equal(result.ok, false, String(money));
    assert.equal(result.ok === false ? result.code : "", "money_mismatch");
  }
  assert.equal(calls.length, 0, "金额不符绝不得入帐（不履约）");
});

test("② 金額相符 → 目標額度＝seats × 每席位含幣額，且入帳落點是團隊主帳", async () => {
  const { calls, credit } = fakeCredit();
  const result = await fulfillSeatOrder({ param: PARAM, money: TOTAL, orderId: ORDER_ID }, { creditSeatOrder: credit });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.targetCoins, IDENT.seats * TEAM_SEAT_INCLUDED_COINS.team, "5 席 × 1000 币 = 5000 币");
  assert.equal(result.perSeatCoins, TEAM_SEAT_INCLUDED_COINS.team);
  assert.equal(result.credited, true);
  assert.deepEqual(calls, [{ orderId: ORDER_ID, userId: IDENT.teamUserId, param: PARAM }]);
});

test("③ 同一請求重放 → 同一張單只入帳一次，目標額度不變（冪等）", async () => {
  const { calls, credit, applied } = fakeCredit();
  const first = await fulfillSeatOrder({ param: PARAM, money: TOTAL, orderId: ORDER_ID }, { creditSeatOrder: credit });
  const replay = await fulfillSeatOrder({ param: PARAM, money: TOTAL, orderId: ORDER_ID }, { creditSeatOrder: credit });

  assert.equal(first.ok && replay.ok, true);
  if (!first.ok || !replay.ok) return;
  assert.equal(replay.targetCoins, first.targetCoins, "重放目标额度不变");
  assert.equal(replay.orderId, first.orderId, "同一张单（决定性命 id）");
  assert.equal(replay.credited, true, "重放仍视为已履约（already_credited）");
  assert.equal(applied.size, 1, "上游只被入帐一次");
  assert.equal(calls.length, 2, "通道被呼叫两次，但同键去重后只加一次额");
  assert.equal(calls[0].orderId, calls[1].orderId);
});

test("④ 履約用的 per_seat_coins 恆為所購檔位含幣額（上限），逐檔不同", async () => {
  for (const [tier, expected] of [["starter", 300], ["team", 1000], ["flagship", 3000]] as const) {
    const { calls, credit } = fakeCredit();
    const identity = { teamUserId: 117, tier, cycle: "month", seats: 2 };
    const quote = quoteSeatOrder({ tier, cycle: "month", seats: 2 });
    assert.equal(quote.ok, true);
    if (!quote.ok) continue;
    const result = await fulfillSeatOrder(
      { param: seatOrderParam(identity), money: formatMapayMoney(quote.totalPrice), orderId: seatOrderId(identity) },
      { creditSeatOrder: credit },
    );
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.perSeatCoins, expected, `${tier} 每席位含币额`);
    assert.equal(result.targetCoins, 2 * expected);
    assert.equal(calls.length, 1);
  }
});

test("入帳通道不可用（unavailable/failed/in_flight）→ ok 但 credited:false（呼叫方須重投，不發兌換碼）", async () => {
  for (const outcome of ["unavailable", "failed", "in_flight"] as const) {
    const { calls, credit } = fakeCredit(outcome);
    const result = await fulfillSeatOrder({ param: PARAM, money: TOTAL, orderId: ORDER_ID }, { creditSeatOrder: credit });
    assert.equal(result.handled, true);
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.credited, false, outcome);
    assert.equal(result.outcome, outcome);
    assert.equal(calls.length, 1);
  }
});

test("畸形 seat param → 拒且不履約", async () => {
  const { calls, credit } = fakeCredit();
  for (const param of ["seat:117:team:month", "seat:0:team:month:5", "seat:117:nope:month:5", "seat:117:team:month:0"]) {
    const result = await fulfillSeatOrder({ param, money: TOTAL, orderId: ORDER_ID }, { creditSeatOrder: credit });
    assert.equal(result.handled, true, param);
    assert.equal(result.ok, false, param);
    assert.equal(result.ok === false ? result.code : "", "invalid_seat_param");
  }
  assert.equal(calls.length, 0);
});
