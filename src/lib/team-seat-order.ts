// 席位下單（刀 2）：報價 + **待支付訂單語義** + 明確的「未接線」拒單（本片不真收款）。
//
// ── 現場（以現場為準；與記憶「下單走 mapay/checkout」有出入，已在回報說明） ──
//   ① 既有下單入口 GET /api/payments/mapay/checkout?plan=<id> 只認
//      plans.ts 的 resolvePricingPlan：PLANS 的三個一次性金幣包或 custom:<coins>。
//   ② mapay 回調端 /api/payments/mapay/notify 覆核金額後走 fulfillMapayRedemption
//      ——**履約物是金幣兌換碼**（quota = coins × QUOTA_PER_COIN）。席位不是金幣，
//      這條路結構上發不出席位；若硬把席位訂單塞進既有 checkout，notify 端
//      resolvePricingPlan(param) 必然 null ⇒ 對 mapay 回 400 ⇒ **收錢不履約**。
//   ③ 既有 mapay 也沒有「建立待支付訂單」的持久化函式：只有
//      buildMapayCheckoutFields（簽名 + 立即跳轉 submit.php；一簽名就是真收款）
//      與 createMapayOrderId。沒有可複用的「只建單不收款」函式。
//   ⇒ 故本片**不呼叫** mapay 的收款面，只交付接縫（下方 SEAT_ORDER_FULFILLMENT_TODO），
//     並在下單 API 回 501 seat_order_fulfillment_unwired。翻線前一律拒單，
//     **絕不以未履約訂單收款**（禁影子帳本、不宣稱未驗證的成功）。
//
// ── 冪等（照既有冪等範式） ──
//   本片不落任何本地訂單（無訂單表 = 無影子帳本）；訂單 id 由請求四元組
//   (team, tier, cycle, seats) 決定性推導 ⇒ 同請求重放得到**同一個 out_trade_no**，
//   永遠不會產生第二張訂單（與 member-quota 的「絕對目標值天然冪等」同一思路：
//   確定性身份取代隨機 id）。若未來要支援「同規格續費」，履約端需另加
//   續費期判別碼（見 todo 第 3 條），不可靠本 id 區分。
//
// 純函式層：不碰 DB / env / 網絡，可直接在 node --test 下測。

import { createHash } from "node:crypto";

import { formatMapayMoney } from "@/lib/mapay";
import { TEAM_SEAT_CYCLE_LABELS, TEAM_SEAT_TIER_LABELS, quoteSeatOrder, type SeatQuoteOk, type SeatOrderRequest, type TeamSeatPriceTable } from "./team-seat-pricing";

export const SEAT_ORDER_FULFILLMENT_CODE = "seat_order_fulfillment_unwired";
export const SEAT_PRICE_NOT_CONFIGURED_CODE = "seat_price_not_configured";

/**
 * 接線清單（暴君/後續片照這三條即可讓席位訂單真能收款履約）：
 *   1. 回調端履約：/api/payments/mapay/notify 對 param 以 `seat:` 開頭的訂單改走
 *      「席位履約」分支（解析 param 的 team/tier/cycle/seats → 給該團隊加席位意圖
 *      ＋按席位配額分配，唯一通路 member-quota.ts 的 allocateMemberQuota），
 *      **不得**誤走 fulfillMapayRedemption（那條發金幣）。
 *   2. 金額覆核：notify 端必須用 quoteSeatOrder（本檔同源價表）重算 total_price
 *      與回調 money 比對（沿用 mapayMoneyAcceptable），客戶端傳價一律不參與計價。
 *   3. 續費與退款：同規格續費需帶期別判別碼（訂單 id 只由四元組決定，會與上次重合）；
 *      退款/撤回需對稱的回收路徑（回收額度走 allocateMemberQuota 的降目標 + 席位回退）。
 */
export const SEAT_ORDER_FULFILLMENT_TODO: readonly string[] = [
  "回調端履約：notify 對 param 以 seat: 開頭的訂單走席位履約分支（加席位意圖 + allocateMemberQuota 配額分配），不得誤走 fulfillMapayRedemption（那條發金幣）。",
  "金額覆核：notify 用 quoteSeatOrder（同源價表）重算總價並與回調 money 比對，客戶端傳價不參與計價。",
  "續費/退款：同規格續費需期別判別碼；退款需對稱回收（降目標額度 + 席位回退）。",
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
  | typeof SEAT_PRICE_NOT_CONFIGURED_CODE
  | typeof SEAT_ORDER_FULFILLMENT_CODE;

/** 下單判定：本片只可能是「拒單」；501 的那一種同時帶出報價與待支付訂單。 */
export interface SeatOrderRejection {
  ok: false;
  status: 400 | 409 | 501;
  code: SeatOrderRejectionCode;
  message: string;
  /** 報價（價格未配置時無報價可給）。 */
  quote?: SeatQuoteOk;
  /** 待支付訂單語義（明確 payable:false：本片不收款）。 */
  pending_order?: SeatPendingOrder;
  payable: false;
  todo?: readonly string[];
}

export type SeatOrderDecision = SeatOrderRejection;

/**
 * 下單判定（純函式）。
 *
 *   參數不合法      → 400 unknown_tier / invalid_cycle / invalid_seats
 *   價格未配置      → 409 seat_price_not_configured（**不得**以 0 元成立訂單）
 *   價格已配置但未接線 → 501 seat_order_fulfillment_unwired（回報價 + 待支付訂單 + 接線清單）
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

  // 硬性拒單（**不是**開關）：報價合法也只給接縫，不發起收款。
  // 理由：履約端（todo 第 1、2 條）未落地之前，任何可支付的訂單都是「收錢不履約」。
  // 刻意不提供「翻一個布林就能收款」的旋鈕——那會讓未履約收款變成一行 diff 的事。
  return {
    ok: false,
    status: 501,
    code: SEAT_ORDER_FULFILLMENT_CODE,
    message:
      "席位下单的收款与履约尚未接通：已按同源价表算出报价与待支付订单，但系统不会向支付渠道发起收款（避免收钱不履约）。",
    quote,
    pending_order: pendingOrder,
    payable: false,
    todo: SEAT_ORDER_FULFILLMENT_TODO,
  };
}
