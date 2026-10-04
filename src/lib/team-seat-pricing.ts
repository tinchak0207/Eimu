// 团队席位计价：**价格的单一真源**。改价格只改本档（TEAM_SEAT_PRICING 一个物件）。
//
// 为什么这里是一套新表而不是「读别处的价」：
//   - src/lib/tier-pricing.ts 的 TierId（internal / reseller / enterprise）是
//     「模型 × 解析度 → 每张图多少币」的 B 端金钥档位单价**覆写**表，维度是
//     「一次生成」，与「一个席位一个周期多少元」不同维度，共用会把两种语义绑死。
//   - src/lib/plans.ts 的 PLANS 是三个**一次性金币包**（带淘宝 purchaseUrl、validDays、
//     coins），结构上没有席位与周期，也没有可借用的每席位单价。
//   故席位单价在本档集中定义，**不抄任何一份别处的数字**；能沿用的只有金额口径：
//   币别是人民币（元），金额格式沿用既有支付链路（mapay 的 money 两位小数，
//   formatMapayMoney）——本档不另立第二种金额格式。
//
// 现状：价格**全部是 placeholder（null = 未配置）**。未配置一律回
// price_not_configured，**绝不当成 0 元**（0 元成立订单 = 诚实性事故）。
// 暴君给数字时只改下方 TEAM_SEAT_PRICING 的 null（单位：元 / 每席位 / 周期），
// 其余代码零改动。
//
// 本档是纯函式层：不碰 DB、不碰 process.env、不碰网络，可直接在 node --test 下测。

/** 计价周期（席位是按周期买的，不是一次性）。 */
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

/** 周期天数（仅用于文案与未来的续费截止计算；不参与单价）。 */
export const TEAM_SEAT_CYCLE_DAYS: Record<TeamSeatCycle, number> = {
  month: 30,
  quarter: 90,
  year: 365,
};

/** 席位的档位（产品档位，与 tier-pricing.ts 的 B 端分销档位无关）。 */
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

/** 金额币别：与 plans.ts 的 price 同一口径（元）——不新增第二种币别。 */
export const TEAM_SEAT_PRICING_CURRENCY = "CNY";

/** 每席位单价：档位 × 周期（单位：元 / 每席位 / 周期）。null = 待暴君填。 */
export type TeamSeatPriceTable = Record<TeamSeatTier, Record<TeamSeatCycle, number | null>>;

/**
 * ⬇⬇⬇ 席位价格唯一真源 ⬇⬇⬇
 * 口径（2026-10-01，PRD: docs/prd/team-seat-prd.md §2）：底价＝零售币价 ¥0.099/币
 * （plans.ts 入门包 9.9 元 / 100 币）。席位的履约物是配额，不是金币之外的新权益，
 * 所以席位单价必须低于同量零售币价才卖得动——本表采批发折扣：
 *   轻量档 300 币/席位/月 → 0.090 元/币；团队档 1,000 币 → 0.085；旗舰档 3,000 币 → 0.080。
 * 周期折扣：季度 = 月 × 3 × 0.90；年度 = 月 × 12 × 0.80（皆四舍五入到整元）。
 * 改价格只改这个物件，其他地方（报价、下单、文案）全部自动跟随。
 */
export const TEAM_SEAT_PRICING: TeamSeatPriceTable = {
  starter: { month: 27, quarter: 73, year: 259 },
  team: { month: 85, quarter: 230, year: 816 },
  flagship: { month: 240, quarter: 648, year: 2304 },
};
/** ⬆⬆⬆ 席位价格唯一真源 ⬆⬆⬆ */

/**
 * ⬇⬇⬇ 席位含币额唯一真源 ⬇⬇⬇（PRD §2 新定义，口径同价表）
 * 一个席位一个周期包含多少金币——这是「一个席位值多少」的定义，也是分配时
 * `per_seat_coins` 的上限（主帐不得把没买的额度划给成员）。与上方价表同源：
 * 改含币额只改这个物件。
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
  /** 该档位含币额（上限）。 */
  cap: number;
}

export interface SeatPerSeatCoinsFailure {
  ok: false;
  reason: SeatPerSeatCoinsFailureReason;
  message: string;
}

export type SeatPerSeatCoins = SeatPerSeatCoinsOk | SeatPerSeatCoinsFailure;

/**
 * per_seat_coins 上限＝所购档位含币额，超额一律拒（PRD §2 / §6④）。
 * 纯函式（钱路不做隐式转换）：非数/负数 → invalid；超过含币额 → 拒。
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
/** ⬆⬆⬆ 席位含币额唯一真源 ⬆⬆⬆ */

/** 已配置的单价（正的有限数）；null / 0 / 负数 / 非数一律视为未配置。 */
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
  /** 每席位单价（元 / 每席位 / 周期）。 */
  unitPrice: number;
  /** 总价 = 单价 × 席位（元，两位小数）。 */
  totalPrice: number;
  currency: string;
  /** 人话摘要（含档位/周期/席位/单价/总价），给回执与文案用。 */
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
 * 报价（纯函式，无副作用、不抛例外）。
 *
 * 边界一律回 { ok:false, reason }：
 *   unknown_tier / invalid_cycle / invalid_seats（非正整数）/ price_not_configured。
 * 价格未配置时**明确说「未配置」**，不回 0 元总价。
 *
 * @param pricing 测试注入用；生产一律用 TEAM_SEAT_PRICING（唯一真源）。
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

  // 严格判型不宽容字串（钱路不做隐式转换："5" / " 5 " / "" / null 一律拒）。
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
