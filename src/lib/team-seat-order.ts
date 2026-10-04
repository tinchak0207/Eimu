// 席位下单（刀 2）：报价 + 待支付订单 + 已接线的可支付决策。
//
// ── 现况（2026-10-01 接通，PRD: docs/prd/team-seat-prd.md §4/§6） ──
//   下单 → 收款 → 履约全链已落地：本档给出报价与决定性订单 id；收银台
//   GET /api/payments/mapay/checkout?plan=seat:<team>:<tier>:<cycle>:<seats>
//   以同一份报价、同一个 out_trade_no 发起收款；回调 /api/payments/mapay/notify 对
//   `seat:` param 走席位履约分支（src/lib/team-seat-fulfillment.ts）：同源价表重算
//   总价比对 money → 把 seats × 档位含币额 的配额加到团队主帐（幂等键＝out_trade_no）。
//   成员分配仍走既有 /v1/team/seats/allocate → allocateMemberQuota（唯一通路）。
//
// ── 为什么不能塞进既有 plan 流程 ──
//   既有收银台只认 plans.ts 的 resolvePricingPlan（金币包 / custom:<coins>）；notify 对
//   planId 的履约物是金币兑换码（fulfillMapayRedemption）。席位不是金币：硬塞 ⇒ notify 端
//   resolvePricingPlan(param) 必然 null ⇒ 对 mapay 回 400 ⇒ **收钱不履约**（PRD §5 红线）。
//   ⇒ 故席位以 `seat:` 前缀与套餐 id 空间隔离，走独立的收银台/履约分支。
//
// ── 幂等 ──
//   本档不落任何本地订单（无订单表 = 无影子帐本）；订单 id 由请求四元组
//   (team, tier, cycle, seats) 决定性推导 ⇒ 同请求重放得**同一个 out_trade_no**，
//   永不会产生第二张订单（与 member-quota 的「绝对目标值天然幂等」同一思路：
//   确定性身份取代随机 id）。同规格续费需另加期别判别码（见
//   SEAT_ORDER_FULFILLMENT_TODO），不可靠本 id 区分。
//
// 纯函式层：不碰 DB / env / 网络，可直接在 node --test 下测。

import { createHash } from "node:crypto";

import { formatMapayMoney } from "@/lib/mapay";
import { TEAM_SEAT_CYCLE_LABELS, TEAM_SEAT_TIER_LABELS, isTeamSeatCycle, isTeamSeatTier, quoteSeatOrder, seatIncludedCoins, type SeatQuoteOk, type SeatOrderRequest, type TeamSeatPriceTable } from "./team-seat-pricing";

export const SEAT_PRICE_NOT_CONFIGURED_CODE = "seat_price_not_configured";

/**
 * 接线清单（PRD §6）。第 1、2 条已于 2026-10-01 落地；第 3 条属 PRD §10 本期不做。
 *   1. 回调端履约：notify 对 param 以 seat: 开头的订单走席位履约分支
 *      （src/lib/team-seat-fulfillment.ts：记下席位意图 + 把 seats × 档位含币额 加到
 *      团队主帐，幂等键＝out_trade_no），**不得**误走 fulfillMapayRedemption（发金币）。
 *   2. 金额覆核：notify 用 quoteSeatOrder（同源价表）重算总价并与回调 money 比对
 *      （mapayMoneyAcceptable），客户端传价不参与计价。
 *   3. 续费/退款：同规格续费需期别判别码；退款需对称回收（降目标额度 + 席位回退，
 *      走 allocateMemberQuota 的降目标）。
 */
export const SEAT_ORDER_FULFILLMENT_TODO: readonly string[] = [
  "[已落地] 回调端履约：notify 对 param 以 seat: 开头的订单走席位履约分支（记下席位意图 + 把 seats × 档位含币额 加到团队主帐，幂等键＝out_trade_no），不得误走 fulfillMapayRedemption。",
  "[已落地] 金额覆核：notify 用 quoteSeatOrder（同源价表）重算总价并与回调 money 比对，客户端传价不参与计价。",
  "[未做·PRD §10] 续费/退款：同规格续费需期别判别码；退款需对称回收（降目标额度 + 席位回退，走 allocateMemberQuota）。",
];

/** mapay out_trade_no 形状（大写英数）：TS + 16 hex。 */
const SEAT_ORDER_ID_PATTERN = /^TS[0-9A-F]{16}$/;

export function isSeatOrderId(value: unknown): value is string {
  return typeof value === "string" && SEAT_ORDER_ID_PATTERN.test(value);
}

export interface SeatOrderIdentity {
  teamUserId: number;
  tier: string;
  cycle: string;
  seats: number;
}

/**
 * 决定性订单 id（同四元组 ⇒ 同 id ⇒ 重放不会有第二张订单）。
 * 不带时间、不带随机：时间/随机 = 重放必然新单。
 */
export function seatOrderId(input: SeatOrderIdentity): string {
  const digest = createHash("sha256")
    .update(`team-seat-order:${input.teamUserId}:${input.tier}:${input.cycle}:${input.seats}`, "utf8")
    .digest("hex");
  return `TS${digest.slice(0, 16).toUpperCase()}`;
}

/** 履约识别码（mapay param）：席位订单专用前缀 + 可反解的请求四元组。 */
export function seatOrderParam(input: SeatOrderIdentity): string {
  return `seat:${input.teamUserId}:${input.tier}:${input.cycle}:${input.seats}`;
}

const SEAT_ORDER_PARAM_PATTERN = /^seat:([0-9]{1,15}):([a-z]+):([a-z]+):([0-9]{1,9})$/;

/**
 * 反解 mapay param（seatOrderParam 的逆函式）：`seat:<team>:<tier>:<cycle>:<seats>`。
 * 非 `seat:` 前缀、畸形、档位/周期/席位不合法一律 null（呼叫方据 null 完全走旧流程）。
 */
export function parseSeatOrderParam(param: string | null | undefined): SeatOrderIdentity | null {
  const match = SEAT_ORDER_PARAM_PATTERN.exec((param ?? "").trim());
  if (!match) return null;
  const teamUserId = Number(match[1]);
  const seats = Number(match[4]);
  if (!Number.isSafeInteger(teamUserId) || teamUserId <= 0) return null;
  if (!isTeamSeatTier(match[2]) || !isTeamSeatCycle(match[3])) return null;
  if (!Number.isSafeInteger(seats) || seats <= 0) return null;
  return { teamUserId, tier: match[2], cycle: match[3], seats };
}

/** 这张席位订单的含币额 = 席位数 × 档位含币额（同源价表；档位不合法回 null）。 */
export function seatOrderEntitlementCoins(input: SeatOrderIdentity): number | null {
  if (!isTeamSeatTier(input.tier)) return null;
  return input.seats * seatIncludedCoins(input.tier);
}

/** mapay param/out_trade_no 语义的待支付订单（形状照 buildMapayCheckoutFields 的栏位口径）。 */
export interface SeatPendingOrder {
  /** mapay out_trade_no：决定性 id，幂等键。 */
  out_trade_no: string;
  /** mapay param：履约识别码（seat: 前缀，与金币套餐 id 空间不重叠）。 */
  param: string;
  /** mapay name：商品名。 */
  name: string;
  /** mapay money：金额字串（两位小数，沿用 formatMapayMoney）。 */
  money: string;
  currency: string;
  seats: number;
  tier: string;
  cycle: string;
  team_user_id: number;
}

export function buildSeatPendingOrder(input: {
  teamUserId: number;
  quote: SeatQuoteOk;
}): SeatPendingOrder {
  const identity: SeatOrderIdentity = {
    teamUserId: input.teamUserId,
    tier: input.quote.tier,
    cycle: input.quote.cycle,
    seats: input.quote.seats,
  };
  return {
    out_trade_no: seatOrderId(identity),
    param: seatOrderParam(identity),
    name: `团队席位 ${TEAM_SEAT_TIER_LABELS[input.quote.tier]} ${TEAM_SEAT_CYCLE_LABELS[input.quote.cycle]} ${input.quote.seats} 席`,
    money: formatMapayMoney(input.quote.totalPrice),
    currency: input.quote.currency,
    seats: input.quote.seats,
    tier: input.quote.tier,
    cycle: input.quote.cycle,
    team_user_id: input.teamUserId,
  };
}

export type SeatOrderRejectionCode =
  | "invalid_team"
  | "unknown_tier"
  | "invalid_cycle"
  | "invalid_seats"
  | typeof SEAT_PRICE_NOT_CONFIGURED_CODE;

/** 下单判定：参数/价格不合法 → 拒单（400 / 409）。 */
export interface SeatOrderRejection {
  ok: false;
  status: 400 | 409;
  code: SeatOrderRejectionCode;
  message: string;
  /** 报价（价格未配置时无报价可给）。 */
  quote?: SeatQuoteOk;
  payable: false;
}

/** 报价合法 → 可支付：待支付订单 + 收银台入口（下单端据此发起收款）。 */
export interface SeatOrderReady {
  ok: true;
  status: 200;
  quote: SeatQuoteOk;
  pending_order: SeatPendingOrder;
  payable: true;
  /** 收银台入口（GET；席位与金币共用同一条 mapay 收银台）。 */
  checkout: { method: "GET"; path: string };
  /** 尚未落地的接线（续费/退款，PRD §10）。 */
  todo: readonly string[];
}

export type SeatOrderDecision = SeatOrderReady | SeatOrderRejection;

/**
 * 下单判定（纯函式）。
 *
 *   参数不合法  → 400 unknown_tier / invalid_cycle / invalid_seats
 *   价格未配置  → 409 seat_price_not_configured（**不得**以 0 元成立订单）
 *   报价合法    → 200 可支付（pending_order + checkout 入口）
 *
 * 可支付不是「翻一个布林」的开关：pending_order 的 param 只有在下游（收银台
 * checkout + notify 席位履约分支）真的接线时才有意义——两者与本判定共用同一份
 * 同源价表与同一个决定性 out_trade_no，缺一则整条链在编译期就散
 * （见 src/lib/team-seat-fulfillment.ts 与 /api/payments/mapay/{checkout,notify}）。
 *
 * @param pricing 测试注入用；生产一律用 TEAM_SEAT_PRICING（唯一真源）。
 */
export function decideSeatOrder(
  input: { teamUserId: number } & SeatOrderRequest,
  pricing?: TeamSeatPriceTable,
): SeatOrderDecision {
  if (!Number.isInteger(input.teamUserId) || input.teamUserId <= 0) {
    return {
      ok: false,
      status: 400,
      code: "invalid_team",
      message: "团队主账号不可用（缺少有效的计费用户）。",
      payable: false,
    };
  }

  const quote = quoteSeatOrder(input, pricing);
  if (!quote.ok) {
    if (quote.reason === "price_not_configured") {
      return {
        ok: false,
        status: 409,
        code: SEAT_PRICE_NOT_CONFIGURED_CODE,
        message: quote.message,
        payable: false,
      };
    }
    return { ok: false, status: 400, code: quote.reason, message: quote.message, payable: false };
  }

  const pendingOrder = buildSeatPendingOrder({ teamUserId: input.teamUserId, quote });

  // 报价合法即成立「待支付订单」：param 为 seat: 前缀，带它去收银台即可收款；
  // 回调端由 team-seat-fulfillment 按同源价表覆核金额后履约（全链已接线）。
  return {
    ok: true,
    status: 200,
    quote,
    pending_order: pendingOrder,
    payable: true,
    checkout: {
      method: "GET",
      path: `/api/payments/mapay/checkout?plan=${encodeURIComponent(pendingOrder.param)}`,
    },
    todo: SEAT_ORDER_FULFILLMENT_TODO,
  };
}
