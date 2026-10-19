// 席位履约分支（notify 端）：`seat:` 订单的「收款 → 履约」编排。
//
// 为什么要在 notify 端另开分支：mapay 回调端既有的履约物是**金币兑换码**
// （fulfillMapayRedemption）。把席位订单硬塞进既有流程 ⇒ 回调端
// `resolvePricingPlan(param)` 必然 null ⇒ 对支付渠道回 400 ⇒ **收钱不履约**
// （PRD §5 红线）。故 `seat:` 前缀的订单走本分支，且**不得**呼叫 fulfillMapayRedemption。
//
// 履约物与落点（PRD §7「支付成功 → 团队配额增加」）：
//   席位是「按人头买额度」——买方（团队主帐）先拿到 seats × 含币额 的配额，
//   再由 owner 经 /v1/team/seats/allocate → allocateMemberQuota 分给成员。
//   故本分支把配额加到**团队主帐**（唯一入帐通路＝既有 mapay-credit 通道，
//   幂等键＝out_trade_no）；成员分配是既有 allocate 端点的职责，本分支不重复实作。
//
// 四条性质（纯编排，deps 可注入，node --test 直接测，不碰 DB/env）：
//   ① 金额覆核：quoteSeatOrder（与下单/收银台同源价表）重算总价，与回调 money 比对
//      （mapayMoneyAcceptable）；不符 → 拒且**不履约**。
//   ② 履约目标：目标额度 = 席位数 × 每席位含币额（TEAM_SEAT_INCLUDED_COINS，同源）。
//   ③ 幂等：履约走既有 mapay-credit（幂等键＝out_trade_no）。席位订单 id 由
//      (team,tier,cycle,seats) 决定性推导 ⇒ 同请求重放必为同一张单，只入帐一次。
//   ④ 上限：per_seat_coins 上限＝所购档位含币额（resolveSeatPerSeatCoins），超额拒。

import { mapayMoneyAcceptable } from "@/lib/mapay";
import { creditMapayOrderViaRelay, type MapayCreditOutcome } from "@/lib/mapay-credit";
import { parseSeatOrderParam, type SeatOrderIdentity } from "./team-seat-order";
import { quoteSeatOrder, resolveSeatPerSeatCoins, seatIncludedCoins } from "./team-seat-pricing";

/** 席位订单 param 前缀（与金币套餐 id 空间隔离）。 */
export const SEAT_ORDER_PARAM_PREFIX = "seat:";

export function isSeatOrderParam(param: unknown): param is string {
  return typeof param === "string" && param.startsWith(SEAT_ORDER_PARAM_PREFIX);
}

export interface SeatFulfillmentInput {
  /** mapay 回调的 param（原样回传）。 */
  param: string | null | undefined;
  /** mapay 回调的 money（只用于比对，不参与计价）。 */
  money: string | undefined;
  /** mapay 回调的 out_trade_no（履约幂等键）。 */
  orderId: string;
}

export interface SeatFulfillmentDeps {
  /** 入帐（团队主帐加 seats × 含币额）。预设＝既有 mapay-credit 签名通道。 */
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
      /** 履约是否已落地（credited / already_credited）。 */
      credited: boolean;
      outcome: MapayCreditOutcome;
      orderId: string;
      identity: SeatOrderIdentity;
      teamUserId: number;
      tier: string;
      cycle: string;
      seats: number;
      perSeatCoins: number;
      /** 目标额度 = 席位数 × 每席位含币额（币）。 */
      targetCoins: number;
    };

const defaultDeps: SeatFulfillmentDeps = {
  // 席位 param 就是入帐通道的 planId：控制面侧据 `seat:` 前缀重算额度（见
  // /api/internal/mapay-credit）。同一条既有通道、同一个幂等键＝out_trade_no。
  creditSeatOrder: ({ orderId, userId, param }) =>
    creditMapayOrderViaRelay({ orderId, userId, planId: param }),
};

/**
 * seat: 订单的履约编排。非席位 param → { handled:false }（呼叫方完全走既有 plan 流程）。
 * 金额不符/参数不合法 → 拒且不呼叫入帐（不履约）。
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

  // ① 金额只由我方同源价表决定；回调 money 不符 → 拒且不履约。
  if (!mapayMoneyAcceptable(input.money, quote.totalPrice)) {
    return {
      handled: true,
      ok: false,
      code: "money_mismatch",
      message: "回调金额与席位报价不一致，拒绝履约。",
    };
  }

  // ② + ④ 每席位含币额（上限）= 所购档位含币额；目标额度 = 席位数 × 含币额。
  const perSeat = resolveSeatPerSeatCoins({
    tier: identity.tier,
    perSeatCoins: seatIncludedCoins(quote.tier),
  });
  if (!perSeat.ok) {
    return { handled: true, ok: false, code: "invalid_seat_param", message: perSeat.message };
  }
  const targetCoins = identity.seats * perSeat.perSeatCoins;

  // ③ 幂等：入帐走既有通道，幂等键＝out_trade_no（同请求重放同一张单，只入帐一次）。
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
