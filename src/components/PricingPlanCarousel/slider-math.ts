import { CUSTOM_PLAN_MAX_COINS, CUSTOM_PLAN_MIN_COINS } from "@/lib/plans";

/* ── 自定义档 Log Scale 滑杆数学 ──
   t∈[0,1] 线性 → coins = 10^(lerp(log10(2000), log10(1000000), t))，
   显示与计费额度吸附到美观档位（CUSTOM_PLAN_TIERS，对数空间最近邻）。 */
export const SLIDER_MAX = 1000;

const LOG_MIN = Math.log10(CUSTOM_PLAN_MIN_COINS);
const LOG_SPAN = Math.log10(CUSTOM_PLAN_MAX_COINS) - LOG_MIN;

export function coinsForSliderValue(value: number): number {
  const t = Math.min(1, Math.max(0, value / SLIDER_MAX));
  return 10 ** (LOG_MIN + t * LOG_SPAN);
}

export function sliderValueForCoins(coins: number): number {
  const t = (Math.log10(Math.max(1, coins)) - LOG_MIN) / LOG_SPAN;
  return Math.round(Math.min(1, Math.max(0, t)) * SLIDER_MAX);
}

/** 额度展示：≥1 万 → 「X 万」，否则千分位（2,000 / 5,000）。 */
export function formatCustomCoins(coins: number): string {
  if (coins >= 10_000) {
    const w = coins / 10_000;
    return `${Number.isInteger(w) ? w : w.toFixed(1)} 万`;
  }
  return coins.toLocaleString("en-US");
}
