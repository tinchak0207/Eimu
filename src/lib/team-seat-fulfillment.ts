// 席位履約分支（notify 端）：`seat:` 訂單的「收款 → 履約」編排。
//
// 為什麼要在 notify 端另開分支：mapay 回調端既有的履約物是**金幣兌換碼**
// （fulfillMapayRedemption）。把席位訂單硬塞進既有流程 ⇒ 回調端
// `resolvePricingPlan(param)` 必然 null ⇒ 對支付渠道回 400 ⇒ **收錢不履約**
// （PRD §5 紅線）。故 `seat:` 前綴的訂單走本分支，且**不得**呼叫 fulfillMapayRedemption。
//
// 履約物與落點（PRD §7「支付成功 → 團隊配額增加」）：
//   席位是「按人頭買額度」——買方（團隊主帳）先拿到 seats × 含幣額 的配額，
//   再由 owner 經 /v1/team/seats/allocate → allocateMemberQuota 分給成員。
//   故本分支把配額加到**團隊主帳**（唯一入帳通路＝既有 mapay-credit 通道，
//   冪等鍵＝out_trade_no）；成員分配是既有 allocate 端點的職責，本分支不重複實作。
//
// 四條性質（純編排，deps 可注入，node --test 直接測，不碰 DB/env）：
//   ① 金額覆核：quoteSeatOrder（與下單/收銀台同源價表）重算總價，與回調 money 比對
//      （mapayMoneyAcceptable）；不符 → 拒且**不履約**。
//   ② 履約目標：目標額度 = 席位數 × 每席位含幣額（TEAM_SEAT_INCLUDED_COINS，同源）。
//   ③ 冪等：履約走既有 mapay-credit（冪等鍵＝out_trade_no）。席位訂單 id 由
//      (team,tier,cycle,seats) 決定性推導 ⇒ 同請求重放必為同一張單，只入帳一次。
//   ④ 上限：per_seat_coins 上限＝所購檔位含幣額（resolveSeatPerSeatCoins），超額拒。

import { mapayMoneyAcceptable } from "@/lib/mapay";
import { creditMapayOrderViaRelay, type MapayCreditOutcome } from "@/lib/mapay-credit";
import { parseSeatOrderParam, type SeatOrderIdentity } from "./team-seat-order";
import { quoteSeatOrder, resolveSeatPerSeatCoins, seatIncludedCoins } from "./team-seat-pricing";

/** 席位訂單 param 前綴（與金幣套餐 id 空間隔離）。 */
export const SEAT_ORDER_PARAM_PREFIX = "seat:";

export function isSeatOrderParam(param: unknown): param is string {
  return typeof param === "string" && param.startsWith(SEAT_ORDER_PARAM_PREFIX);
}

export interface SeatFulfillmentInput {
  /** mapay 回調的 param（原樣回傳）。 */
  param: string | null | undefined;
  /** mapay 回調的 money（只用于比对，不参与计价）。 */
  money: string | undefined;
  /** mapay 回調的 out_trade_no（履約冪等鍵）。 */
  orderId: string;
}

export interface SeatFulfillmentDeps {
  /** 入帳（團隊主帳加 seats × 含幣額）。預設＝既有 mapay-credit 簽名通道。 */
  creditSeatOrder(input: {
    orderId: string;
    userId: number;
    param: string;
  }): Promise<MapayCreditOutcome>;
}

export type SeatFulfillmentFailureCode =
  | "invalid_seat_param"
  | "unknown_tier"
  | "invalid_cycle"
  | "invalid_seats"
  | "price_not_configured"
  | "money_mismatch";

export type SeatFulfillmentResult =
  | { handled: false }
  | { handled: true; ok: false; code: SeatFulfillmentFailureCode; message: string }
  | {
      handled: true;
      ok: true;
      /** 履約是否已落地（credited / already_credited）。 */
      credited: boolean;
      outcome: MapayCreditOutcome;
      orderId: string;
      identity: SeatOrderIdentity;
      teamUserId: number;
      tier: string;
      cycle: string;
      seats: number;
      perSeatCoins: number;
      /** 目標額度 = 席位數 × 每席位含幣額（幣）。 */
      targetCoins: number;
    };

const defaultDeps: SeatFulfillmentDeps = {
  // 席位 param 就是入帳通道的 planId：控制面側據 `seat:` 前綴重算額度（見
  // /api/internal/mapay-credit）。同一條既有通道、同一個冪等鍵＝out_trade_no。
  creditSeatOrder: ({ orderId, userId, param }) =>
    creditMapayOrderViaRelay({ orderId, userId, planId: param }),
};

/**
 * seat: 訂單的履約編排。非席位 param → { handled:false }（呼叫方完全走既有 plan 流程）。
 * 金額不符/參數不合法 → 拒且不呼叫入帳（不履約）。
 */
export async function fulfillSeatOrder(
  input: SeatFulfillmentInput,
  deps: SeatFulfillmentDeps = defaultDeps,
): Promise<SeatFulfillmentResult> {
  if (!isSeatOrderParam(input.param)) return { handled: false };

  const identity = parseSeatOrderParam(input.param);
  if (!identity) {
    return {
      handled: true,
      ok: false,
      code: "invalid_seat_param",
      message: "席位订单参数不合法，拒绝履约。",
    };
  }

  const quote = quoteSeatOrder({ tier: identity.tier, cycle: identity.cycle, seats: identity.seats });
  if (!quote.ok) {
    return { handled: true, ok: false, code: quote.reason, message: quote.message };
  }

  // ① 金額只由我方同源價表決定；回調 money 不符 → 拒且不履約。
  if (!mapayMoneyAcceptable(input.money, quote.totalPrice)) {
    return {
      handled: true,
      ok: false,
      code: "money_mismatch",
      message: "回调金额与席位报价不一致，拒绝履约。",
    };
  }

  // ② + ④ 每席位含幣額（上限）= 所購檔位含幣額；目標額度 = 席位數 × 含幣額。
  const perSeat = resolveSeatPerSeatCoins({
    tier: identity.tier,
    perSeatCoins: seatIncludedCoins(quote.tier),
  });
  if (!perSeat.ok) {
    return { handled: true, ok: false, code: "invalid_seat_param", message: perSeat.message };
  }
  const targetCoins = identity.seats * perSeat.perSeatCoins;

  // ③ 冪等：入帳走既有通道，冪等鍵＝out_trade_no（同請求重放同一張单，只入帐一次）。
  const outcome = await deps.creditSeatOrder({
    orderId: input.orderId,
    userId: identity.teamUserId,
    param: input.param,
  });
  const credited = outcome === "credited" || outcome === "already_credited";

  return {
    handled: true,
    ok: true,
    credited,
    outcome,
    orderId: input.orderId,
    identity,
    teamUserId: identity.teamUserId,
    tier: identity.tier,
    cycle: identity.cycle,
    seats: identity.seats,
    perSeatCoins: perSeat.perSeatCoins,
    targetCoins,
  };
}
