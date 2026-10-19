"use client";

import { formatCoins } from "@/lib/history-types";

export interface HistoryStatsProps {
  /** 本站保存的记录条数。 */
  entries: number;
  /** 出图张数。 */
  images: number;
  /** 已收藏条数。 */
  starred: number;
  /** 账户累计消耗的配额单位，来自上游统计接口；未取到时传 null。 */
  accountQuota: number | null;
  loading: boolean;
}

/** 统计压成一行灰字，收进筛选抽屉里：首屏属于图片，不属于仪表盘。 */
export function HistoryStats({ entries, images, starred, accountQuota, loading }: HistoryStatsProps) {
  return (
    <p className="text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.58)]">
      累计消耗{" "}
      <span className="font-medium tabular-nums text-[rgba(120,90,20,0.85)]">
        {accountQuota === null ? "—" : formatCoins(accountQuota)}
      </span>{" "}
      张 · 留存 {loading ? "—" : images} 张（{entries} 条记录）· 收藏 {starred} 条
    </p>
  );
}
