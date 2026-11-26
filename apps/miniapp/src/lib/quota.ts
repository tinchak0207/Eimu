/** new-api 额度单位换算（真源：仓库 src/lib/quota-constants.ts 的 QUOTA_PER_COIN）。 */
export const QUOTA_PER_COIN = 500_000

export function quotaToCoins(quota: number | null | undefined): number {
  const value = typeof quota === 'number' && Number.isFinite(quota) ? quota : 0
  return Math.trunc(value / QUOTA_PER_COIN)
}
