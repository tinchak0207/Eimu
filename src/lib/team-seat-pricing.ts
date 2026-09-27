// 團隊席位計價：**價格的單一真源**。改價格只改本檔（TEAM_SEAT_PRICING 一個物件）。
//
// 為什麼這裡是一套新表而不是「讀別處的價」：
//   - src/lib/tier-pricing.ts 的 TierId（internal / reseller / enterprise）是
//     「模型 × 解析度 → 每張圖多少幣」的 B 端金鑰檔位單價**覆寫**表，維度是
//     「一次生成」，與「一個席位一個週期多少元」不同維度，共用會把兩種語義綁死。
//   - src/lib/plans.ts 的 PLANS 是三個**一次性金幣包**（帶淘寶 purchaseUrl、validDays、
//     coins），結構上沒有席位與週期，也沒有可借用的每席位單價。
//   故席位單價在本檔集中定義，**不抄任何一份別處的數字**；能沿用的只有金額口徑：
//   幣別是人民幣（元），金額格式沿用既有支付鏈路（mapay 的 money 兩位小數，
//   formatMapayMoney）——本檔不另立第二種金額格式。
//
// 現狀：價格**全部是 placeholder（null = 未配置）**。未配置一律回
// price_not_configured，**絕不當成 0 元**（0 元成立訂單 = 誠實性事故）。
// 暴君給數字時只改下方 TEAM_SEAT_PRICING 的 null（單位：元 / 每席位 / 週期），
// 其餘代碼零改動。
//
// 本檔是純函式層：不碰 DB、不碰 process.env、不碰網絡，可直接在 node --test 下測。

/** 計價週期（席位是按週期買的，不是一次性）。 */
export const TEAM_SEAT_CYCLES = ["month", "quarter", "year"] as const;
export type TeamSeatCycle = (typeof TEAM_SEAT_CYCLES)[number];

export function isTeamSeatCycle(value: unknown): value is TeamSeatCycle {
  return typeof value === "string" && (TEAM_SEAT_CYCLES as readonly string[]).includes(value);
}

export const TEAM_SEAT_CYCLE_LABELS: Record<TeamSeatCycle, string> = {
  month: "月度",
  quarter: "季度",
  year: "年度",
};

/** 週期天數（僅用於文案與未來的續費截止計算；不參與單價）。 */
export const TEAM_SEAT_CYCLE_DAYS: Record<TeamSeatCycle, number> = {
  month: 30,
  quarter: 90,
  year: 365,
};

/** 席位的檔位（產品檔位，與 tier-pricing.ts 的 B 端分銷檔位無關）。 */
export const TEAM_SEAT_TIERS = ["starter", "team", "flagship"] as const;
export type TeamSeatTier = (typeof TEAM_SEAT_TIERS)[number];

export function isTeamSeatTier(value: unknown): value is TeamSeatTier {
  return typeof value === "string" && (TEAM_SEAT_TIERS as readonly string[]).includes(value);
}

export const TEAM_SEAT_TIER_LABELS: Record<TeamSeatTier, string> = {
  starter: "轻量档",
  team: "团队档",
  flagship: "旗舰档",
};

/** 金額幣別：與 plans.ts 的 price 同一口徑（元）——不新增第二種幣別。 */
export const TEAM_SEAT_PRICING_CURRENCY = "CNY";

/** 每席位單價：檔位 × 週期（單位：元 / 每席位 / 週期）。null = 待暴君填。 */
export type TeamSeatPriceTable = Record<TeamSeatTier, Record<TeamSeatCycle, number | null>>;

/**
 * ⬇⬇⬇ 席位價格唯一真源 ⬇⬇⬇
 * 待暴君填：把 null 換成每席位單價（元）。例如 team.month = 39 代表「团队档 39 元/席位/月」。
 * 改價格只改這個物件，其他地方（報價、下單、文案）全部自動跟隨。
 */
export const TEAM_SEAT_PRICING: TeamSeatPriceTable = {
  starter: { month: null, quarter: null, year: null },
  team: { month: null, quarter: null, year: null },
  flagship: { month: null, quarter: null, year: null },
};
/** ⬆⬆⬆ 席位價格唯一真源 ⬆⬆⬆ */

/** 已配置的單價（正的有限數）；null / 0 / 負數 / 非數一律視為未配置。 */
export function configuredSeatUnitPrice(
  tier: TeamSeatTier,
  cycle: TeamSeatCycle,
  pricing: TeamSeatPriceTable = TEAM_SEAT_PRICING,
): number | null {
  const unit = pricing?.[tier]?.[cycle];
  return typeof unit === "number" && Number.isFinite(unit) && unit > 0 ? unit : null;
}

export type SeatQuoteFailureReason =
  | "unknown_tier"
  | "invalid_cycle"
  | "invalid_seats"
  | "price_not_configured";

export interface SeatQuoteOk {
  ok: true;
  tier: TeamSeatTier;
  cycle: TeamSeatCycle;
  seats: number;
  /** 每席位單價（元 / 每席位 / 週期）。 */
  unitPrice: number;
  /** 總價 = 單價 × 席位（元，兩位小數）。 */
  totalPrice: number;
  currency: string;
  /** 人話摘要（含檔位/週期/席位/單價/總價），給回執與文案用。 */
  note: string;
}

export interface SeatQuoteFailure {
  ok: false;
  reason: SeatQuoteFailureReason;
  message: string;
}

export type SeatQuote = SeatQuoteOk | SeatQuoteFailure;

export interface SeatOrderRequest {
  tier: unknown;
  cycle: unknown;
  seats: unknown;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 報價（純函式，無副作用、不拋例外）。
 *
 * 邊界一律回 { ok:false, reason }：
 *   unknown_tier / invalid_cycle / invalid_seats（非正整數）/ price_not_configured。
 * 價格未配置時**明確說「未配置」**，不回 0 元總價。
 *
 * @param pricing 測試注入用；生產一律用 TEAM_SEAT_PRICING（唯一真源）。
 */
export function quoteSeatOrder(
  input: SeatOrderRequest,
  pricing: TeamSeatPriceTable = TEAM_SEAT_PRICING,
): SeatQuote {
  const tier = input.tier;
  if (!isTeamSeatTier(tier)) {
    return {
      ok: false,
      reason: "unknown_tier",
      message: `未知席位档位 ${String(tier)}（可用：${TEAM_SEAT_TIERS.join(" / ")}）。`,
    };
  }

  const cycle = input.cycle;
  if (!isTeamSeatCycle(cycle)) {
    return {
      ok: false,
      reason: "invalid_cycle",
      message: `未知计费周期 ${String(cycle)}（可用：${TEAM_SEAT_CYCLES.join(" / ")}）。`,
    };
  }

  // 嚴格判型不寬容字串（錢路不做隱式轉換："5" / " 5 " / "" / null 一律拒）。
  const seats = input.seats;
  if (typeof seats !== "number" || !Number.isInteger(seats) || seats <= 0) {
    return {
      ok: false,
      reason: "invalid_seats",
      message: `席位数必须是不小于 1 的整数（收到 ${String(input.seats)}）。`,
    };
  }

  const unitPrice = configuredSeatUnitPrice(tier, cycle, pricing);
  if (unitPrice === null) {
    return {
      ok: false,
      reason: "price_not_configured",
      message: `席位价格未配置（${TEAM_SEAT_TIER_LABELS[tier]} / ${TEAM_SEAT_CYCLE_LABELS[cycle]}），暂不可下单。`,
    };
  }

  const totalPrice = roundMoney(unitPrice * seats);
  const note =
    `${TEAM_SEAT_TIER_LABELS[tier]} / ${TEAM_SEAT_CYCLE_LABELS[cycle]}：` +
    `${unitPrice} 元/席位 × ${seats} 席位 = ${totalPrice} 元。`;

  return {
    ok: true,
    tier,
    cycle,
    seats,
    unitPrice,
    totalPrice,
    currency: TEAM_SEAT_PRICING_CURRENCY,
    note,
  };
}
