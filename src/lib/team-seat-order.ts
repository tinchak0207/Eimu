// 席位下單（刀 2）：報價 + 待支付訂單 + 已接線的可支付決策。
//
// ── 現況（2026-10-01 接通，PRD: docs/prd/team-seat-prd.md §4/§6） ──
//   下單 → 收款 → 履約全鏈已落地：本檔給出報價與決定性訂單 id；收銀台
//   GET /api/payments/mapay/checkout?plan=seat:<team>:<tier>:<cycle>:<seats>
//   以同一份報價、同一個 out_trade_no 發起收款；回調 /api/payments/mapay/notify 對
//   `seat:` param 走席位履約分支（src/lib/team-seat-fulfillment.ts）：同源價表重算
//   總價比對 money → 把 seats × 檔位含幣額 的配額加到團隊主帳（冪等鍵＝out_trade_no）。
//   成員分配仍走既有 /v1/team/seats/allocate → allocateMemberQuota（唯一通路）。
//
// ── 為什麼不能塞進既有 plan 流程 ──
//   既有收銀台只認 plans.ts 的 resolvePricingPlan（金幣包 / custom:<coins>）；notify 對
//   planId 的履約物是金幣兌換碼（fulfillMapayRedemption）。席位不是金幣：硬塞 ⇒ notify 端
//   resolvePricingPlan(param) 必然 null ⇒ 對 mapay 回 400 ⇒ **收錢不履約**（PRD §5 紅線）。
//   ⇒ 故席位以 `seat:` 前綴與套餐 id 空間隔離，走獨立的收銀台/履約分支。
//
// ── 冪等 ──
//   本檔不落任何本地訂單（無訂單表 = 無影子帳本）；訂單 id 由請求四元組
//   (team, tier, cycle, seats) 決定性推導 ⇒ 同請求重放得**同一個 out_trade_no**，
//   永不會產生第二張訂單（與 member-quota 的「絕對目標值天然冪等」同一思路：
//   確定性身份取代隨機 id）。同規格續費需另加期別判別碼（見
//   SEAT_ORDER_FULFILLMENT_TODO），不可靠本 id 區分。
//
// 純函式層：不碰 DB / env / 網絡，可直接在 node --test 下測。

import { createHash } from "node:crypto";

import { formatMapayMoney } from "@/lib/mapay";
import { TEAM_SEAT_CYCLE_LABELS, TEAM_SEAT_TIER_LABELS, isTeamSeatCycle, isTeamSeatTier, quoteSeatOrder, seatIncludedCoins, type SeatQuoteOk, type SeatOrderRequest, type TeamSeatPriceTable } from "./team-seat-pricing";

export const SEAT_PRICE_NOT_CONFIGURED_CODE = "seat_price_not_configured";

/**
 * 接線清單（PRD §6）。第 1、2 條已於 2026-10-01 落地；第 3 條屬 PRD §10 本期不做。
 *   1. 回調端履約：notify 對 param 以 seat: 開頭的訂單走席位履約分支
 *      （src/lib/team-seat-fulfillment.ts：記下席位意圖 + 把 seats × 檔位含幣額 加到
 *      團隊主帳，冪等鍵＝out_trade_no），**不得**誤走 fulfillMapayRedemption（發金幣）。
 *   2. 金額覆核：notify 用 quoteSeatOrder（同源價表）重算總價並與回調 money 比對
 *      （mapayMoneyAcceptable），客戶端傳價不參與計價。
 *   3. 續費/退款：同規格續費需期別判別碼；退款需對稱回收（降目標額度 + 席位回退，
 *      走 allocateMemberQuota 的降目標）。
 */
export const SEAT_ORDER_FULFILLMENT_TODO: readonly string[] = [
  "[已落地] 回調端履約：notify 對 param 以 seat: 開頭的訂單走席位履約分支（記下席位意圖 + 把 seats × 檔位含幣額 加到團隊主帳，冪等鍵＝out_trade_no），不得誤走 fulfillMapayRedemption。",
  "[已落地] 金額覆核：notify 用 quoteSeatOrder（同源價表）重算總價並與回調 money 比對，客戶端傳價不參與計價。",
  "[未做·PRD §10] 續費/退款：同規格續費需期別判別碼；退款需對稱回收（降目標額度 + 席位回退，走 allocateMemberQuota）。",
];

/** mapay out_trade_no 形狀（大寫英數）：TS + 16 hex。 */
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
 * 決定性訂單 id（同四元組 ⇒ 同 id ⇒ 重放不會有第二張訂單）。
 * 不帶時間、不帶隨機：時間/隨機 = 重放必然新單。
 */
export function seatOrderId(input: SeatOrderIdentity): string {
  const digest = createHash("sha256")
    .update(`team-seat-order:${input.teamUserId}:${input.tier}:${input.cycle}:${input.seats}`, "utf8")
    .digest("hex");
  return `TS${digest.slice(0, 16).toUpperCase()}`;
}

/** 履約識別碼（mapay param）：席位訂單專用前綴 + 可反解的請求四元組。 */
export function seatOrderParam(input: SeatOrderIdentity): string {
  return `seat:${input.teamUserId}:${input.tier}:${input.cycle}:${input.seats}`;
}

const SEAT_ORDER_PARAM_PATTERN = /^seat:([0-9]{1,15}):([a-z]+):([a-z]+):([0-9]{1,9})$/;

/**
 * 反解 mapay param（seatOrderParam 的逆函式）：`seat:<team>:<tier>:<cycle>:<seats>`。
 * 非 `seat:` 前綴、畸形、檔位/週期/席位不合法一律 null（呼叫方據 null 完全走舊流程）。
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

/** 這張席位訂單的含幣額 = 席位數 × 檔位含幣額（同源價表；檔位不合法回 null）。 */
export function seatOrderEntitlementCoins(input: SeatOrderIdentity): number | null {
  if (!isTeamSeatTier(input.tier)) return null;
  return input.seats * seatIncludedCoins(input.tier);
}

/** mapay param/out_trade_no 語義的待支付訂單（形狀照 buildMapayCheckoutFields 的欄位口徑）。 */
export interface SeatPendingOrder {
  /** mapay out_trade_no：決定性 id，冪等鍵。 */
  out_trade_no: string;
  /** mapay param：履約識別碼（seat: 前綴，與金幣套餐 id 空間不重疊）。 */
  param: string;
  /** mapay name：商品名。 */
  name: string;
  /** mapay money：金額字串（兩位小數，沿用 formatMapayMoney）。 */
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

/** 下單判定：參數/價格不合法 → 拒單（400 / 409）。 */
export interface SeatOrderRejection {
  ok: false;
  status: 400 | 409;
  code: SeatOrderRejectionCode;
  message: string;
  /** 報價（價格未配置時無報價可給）。 */
  quote?: SeatQuoteOk;
  payable: false;
}

/** 報價合法 → 可支付：待支付訂單 + 收銀台入口（下單端據此發起收款）。 */
export interface SeatOrderReady {
  ok: true;
  status: 200;
  quote: SeatQuoteOk;
  pending_order: SeatPendingOrder;
  payable: true;
  /** 收銀台入口（GET；席位與金幣共用同一條 mapay 收銀台）。 */
  checkout: { method: "GET"; path: string };
  /** 尚未落地的接線（續費/退款，PRD §10）。 */
  todo: readonly string[];
}

export type SeatOrderDecision = SeatOrderReady | SeatOrderRejection;

/**
 * 下單判定（純函式）。
 *
 *   參數不合法  → 400 unknown_tier / invalid_cycle / invalid_seats
 *   價格未配置  → 409 seat_price_not_configured（**不得**以 0 元成立訂單）
 *   報價合法    → 200 可支付（pending_order + checkout 入口）
 *
 * 可支付不是「翻一個布林」的開關：pending_order 的 param 只有在下游（收銀台
 * checkout + notify 席位履約分支）真的接線時才有意義——兩者與本判定共用同一份
 * 同源價表與同一個決定性 out_trade_no，缺一則整條鏈在編譯期就散
 * （見 src/lib/team-seat-fulfillment.ts 與 /api/payments/mapay/{checkout,notify}）。
 *
 * @param pricing 測試注入用；生產一律用 TEAM_SEAT_PRICING（唯一真源）。
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

  // 報價合法即成立「待支付訂單」：param 為 seat: 前綴，帶它去收銀台即可收款；
  // 回調端由 team-seat-fulfillment 按同源價表覆核金額後履約（全鏈已接線）。
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
