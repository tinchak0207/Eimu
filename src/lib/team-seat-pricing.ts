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
 * 口徑（2026-10-01，PRD: docs/prd/team-seat-prd.md §2）：底價＝零售幣價 ¥0.099/幣
 * （plans.ts 入門包 9.9 元 / 100 幣）。席位的履約物是配額，不是金幣之外的新權益，
 * 所以席位單價必須低於同量零售幣價才賣得動——本表採批發折扣：
 *   轻量档 300 幣/席位/月 → 0.090 元/幣；团队档 1,000 幣 → 0.085；旗舰档 3,000 幣 → 0.080。
 * 週期折扣：季度 = 月 × 3 × 0.90；年度 = 月 × 12 × 0.80（皆四捨五入到整元）。
 * 改價格只改這個物件，其他地方（報價、下單、文案）全部自動跟隨。
 */
export const TEAM_SEAT_PRICING: TeamSeatPriceTable = {
  starter: { month: 27, quarter: 73, year: 259 },
  team: { month: 85, quarter: 230, year: 816 },
  flagship: { month: 240, quarter: 648, year: 2304 },
};
/** ⬆⬆⬆ 席位價格唯一真源 ⬆⬆⬆ */

/**
 * ⬇⬇⬇ 席位含幣額唯一真源 ⬇⬇⬇（PRD §2 新定義，口徑同價表）
 * 一個席位一個週期包含多少金幣——這是「一個席位值多少」的定義，也是分配時
 * `per_seat_coins` 的上限（主帳不得把沒買的額度劃給成員）。與上方價表同源：
 * 改含幣額只改這個物件。
 */
export const TEAM_SEAT_INCLUDED_COINS: Record<TeamSeatTier, number> = {
  starter: 300,
  team: 1000,
  flagship: 3000,
};

export function seatIncludedCoins(tier: TeamSeatTier): number {
  return TEAM_SEAT_INCLUDED_COINS[tier];
}

export type SeatPerSeatCoinsFailureReason =
  | "unknown_tier"
  | "invalid_per_seat_coins"
  | "per_seat_coins_above_included";

export interface SeatPerSeatCoinsOk {
  ok: true;
  tier: TeamSeatTier;
  perSeatCoins: number;
  /** 該檔位含幣額（上限）。 */
  cap: number;
}

export interface SeatPerSeatCoinsFailure {
  ok: false;
  reason: SeatPerSeatCoinsFailureReason;
  message: string;
}

export type SeatPerSeatCoins = SeatPerSeatCoinsOk | SeatPerSeatCoinsFailure;

/**
 * per_seat_coins 上限＝所購檔位含幣額，超額一律拒（PRD §2 / §6④）。
 * 純函式（錢路不做隱式轉換）：非數/負數 → invalid；超過含幣額 → 拒。
 */
export function resolveSeatPerSeatCoins(input: {
  tier: unknown;
  perSeatCoins: unknown;
}): SeatPerSeatCoins {
  if (!isTeamSeatTier(input.tier)) {
    return { ok: false, reason: "unknown_tier", message: `未知席位档位 ${String(input.tier)}。` };
  }
  const coins = input.perSeatCoins;
  if (typeof coins !== "number" || !Number.isFinite(coins) || coins <= 0) {
    return { ok: false, reason: "invalid_per_seat_coins", message: "每席位币数必须是大于 0 的数值。" };
  }
  const cap = seatIncludedCoins(input.tier);
  if (coins > cap) {
    return {
      ok: false,
      reason: "per_seat_coins_above_included",
      message: `每席位币数 ${coins} 超过${TEAM_SEAT_TIER_LABELS[input.tier]}含币额 ${cap}。`,
    };
  }
  return { ok: true, tier: input.tier, perSeatCoins: coins, cap };
}
/** ⬆⬆⬆ 席位含幣額唯一真源 ⬆⬆⬆ */

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
