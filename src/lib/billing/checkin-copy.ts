import { QUOTA_PER_COIN } from "./quota-constants";

export function quotaToRewardCount(quota: number): number {
  return Math.max(1, Math.min(3, Math.round(quota / QUOTA_PER_COIN)));
}

export function formatCheckinRewardText(rewardCount?: number): string {
  if (!rewardCount) return "每日签到可随机获得 1 到 3 张额度";
  return `今日签到已获得 ${rewardCount} 张额度`;
}
