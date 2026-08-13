"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Coins, Gift, CheckCircle2, CreditCard } from "lucide-react";
import { formatCheckinRewardText, quotaToRewardCount } from "@/lib/checkin-copy";
import { useAuth } from "@/hooks/use-auth";
import { quotaToCoins, fetchCheckinStatus, doCheckin } from "@/lib/new-api-client";
import { cn } from "@/lib/utils";

interface WalletBadgeProps {
  className?: string;
  showTopUp?: boolean;
  showCheckin?: boolean;
}

export function WalletBadge({ className, showTopUp = true, showCheckin = true }: WalletBadgeProps) {
  const { user, token, isLoggedIn, refresh } = useAuth();
  const [canCheckin, setCanCheckin] = useState(false);
  const [checkinLoading, setCheckinLoading] = useState(false);
  const [checkinDone, setCheckinDone] = useState(false);
  const [checkinRewardCount, setCheckinRewardCount] = useState<number | null>(null);

  // Check checkin status on mount
  useEffect(() => {
    if (!showCheckin) return;
    if (!token) return;
    fetchCheckinStatus(token)
      .then((res) => {
        if (res.success && res.data) {
          setCanCheckin(res.data.can_checkin);
          if (res.data.quota) setCheckinRewardCount(quotaToRewardCount(res.data.quota));
        }
      })
      .catch(() => {});
  }, [showCheckin, token]);

  if (!isLoggedIn || !user) return null;

  const coins = quotaToCoins(user.quota);

  const handleCheckin = async () => {
    if (!token || checkinLoading || !canCheckin) return;
    setCheckinLoading(true);
    try {
      const res = await doCheckin(token);
      if (res.success) {
        setCanCheckin(false);
        setCheckinDone(true);
        if (res.data?.quota) setCheckinRewardCount(quotaToRewardCount(res.data.quota));
        // Refresh quota display
        await refresh();
      }
    } catch { /* ignore */ }
    finally { setCheckinLoading(false); }
  };

  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {/* Coin balance — muted amber, no harsh yellow */}
      <div
        className="inline-flex max-w-full shrink items-center gap-1 whitespace-nowrap rounded-full bg-[rgba(0,0,0,0.05)] px-3 py-1.5 text-ios-footnote font-semibold text-[rgba(120,90,20,0.85)] cursor-default select-none"
        aria-label={`余额 ${coins} 币`}
      >
        <Coins className="h-3.5 w-3.5 text-[rgba(160,120,30,0.80)]" aria-hidden="true" />
        <span className="min-w-0 truncate tabular-nums">{coins.toLocaleString()}</span>
      </div>

      {/* Daily checkin button */}
      {showCheckin && canCheckin && !checkinDone && (
        <div className="inline-flex items-center gap-2">
          <button
            type="button"
            onClick={handleCheckin}
            disabled={checkinLoading}
            className="lg-tint-green inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-ios-caption1 font-semibold text-[#248A3D] lg-transition hover:opacity-80 cursor-pointer disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(52,199,89,0.35)]"
            aria-label="每日签到领取额度"
            title={formatCheckinRewardText()}
          >
            <Gift className="h-3 w-3" aria-hidden="true" />
            签到
          </button>
          <span className="hidden text-ios-caption1 text-[rgba(0,0,0,0.58)] sm:inline">{formatCheckinRewardText()}</span>
        </div>
      )}

      {/* Checkin done indicator (fades after 3s) */}
      {showCheckin && checkinDone && (
        // #34C759 在近白底上只有 ~2.2:1，签到成功的确认文字得用深一档的绿。
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-ios-caption1 text-[#248A3D]">
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
          {formatCheckinRewardText(checkinRewardCount ?? undefined)}
        </span>
      )}

      {/* Top-up button in the same iOS pill language as the navbar */}
      {showTopUp && (
        <Link
          href="/pricing"
          className="lg-float inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-ios-footnote font-medium text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.78)] no-underline"
          aria-label="前往充值页面"
        >
          <CreditCard className="h-3.5 w-3.5" aria-hidden="true" />
          充值
        </Link>
      )}
    </div>
  );
}
