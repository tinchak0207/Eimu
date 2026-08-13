"use client";

import { Coins, ImageIcon, Star } from "lucide-react";
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

interface StatCard {
  label: string;
  value: string;
  unit: string;
  icon: React.ReactNode;
  hint?: string;
}

export function HistoryStats({ entries, images, starred, accountQuota, loading }: HistoryStatsProps) {
  const cards: StatCard[] = [
    {
      label: "累计消耗",
      // 这个数字取自上游账户统计，不是本页记录的加总 —— 后者会漏掉已被清理的旧记录。
      value: accountQuota === null ? "—" : formatCoins(accountQuota),
      unit: "张",
      icon: <Coins className="h-4 w-4 text-[rgba(120,90,20,0.85)]" />,
      hint: "账户累计",
    },
    {
      label: "留存作品",
      value: loading ? "—" : String(images),
      unit: "张",
      icon: <ImageIcon className="h-4 w-4 text-[rgba(0,122,255,0.72)]" />,
      hint: `${entries} 条记录`,
    },
    {
      label: "已收藏",
      value: loading ? "—" : String(starred),
      unit: "张",
      icon: <Star className="h-4 w-4 text-[rgba(255,179,0,0.85)]" />,
    },
  ];

  return (
    // 三个数字合在一张玻璃卡里（iOS 健康 App 的摘要卡语法）：
    // 它们是同一层级的摘要信息，拆成三张卡会平白多出两层材质。
    <div className="lg-card relative mb-6 overflow-hidden rounded-ios-3xl">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-70" />
      {/* 三栏之间不画竖线——分组靠留白，线只会加重分割感。 */}
      <dl className="grid grid-cols-3">
        {cards.map(({ label, value, unit, icon, hint }) => (
          <div key={label} className="min-w-0 p-4 sm:px-6">
            <dt className="mb-2 flex items-center gap-1.5">
              {icon}
              {/* text-[rgba(0,0,0,0.58)] 是本页统一的「次要但必须可读」文字色阶——
                  原来的 0.40 在近白底上对比度只有 ~2.8:1，低于 WCAG AA 正文 4.5:1 的门槛。 */}
              <span className="truncate text-ios-caption1 font-medium text-[rgba(0,0,0,0.58)]">{label}</span>
            </dt>
            <dd className="m-0">
              <div className="flex items-baseline gap-1">
                <span className="text-[1.5rem] font-bold leading-none tracking-tight tabular-nums text-[rgba(0,0,0,0.85)]">
                  {value}
                </span>
                <span className="text-ios-caption1 text-[rgba(0,0,0,0.58)]">{unit}</span>
              </div>
              {hint && <p className="mt-1 truncate text-ios-caption1 text-[rgba(0,0,0,0.58)]">{hint}</p>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
