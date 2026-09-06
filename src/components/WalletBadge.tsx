"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Coins, CreditCard, Gift, CheckCircle2, Plus } from "lucide-react";
import { quotaToRewardCount } from "@/lib/checkin-copy";
import { useAuth } from "@/hooks/use-auth";
import { quotaToCoins, fetchCheckinStatus, doCheckin } from "@/lib/new-api-client";
import { cn } from "@/lib/utils";

interface WalletBadgeProps {
  className?: string;
  showTopUp?: boolean;
  showCheckin?: boolean;
}

/**
 * 余额胶囊（2026-08-27 暴君裁定）：余额 + 「+」合成一颗胶囊。
 * 「+」点开两项菜单（充值 / 每日签到）：充值跳 /pricing，签到就地完成。
 * 2026-09-05 修正：「+」入口图标恒定不变——已签到状态只体现在菜单项里
 * （不可选 + 「已签到 · 明日再来」），不再把「+」换成绿勾。
 */
export function WalletBadge({ className, showTopUp = true, showCheckin = true }: WalletBadgeProps) {
  const { user, token, isLoggedIn, refresh } = useAuth();
  const [plusOpen, setPlusOpen] = useState(false);
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
          if (!res.data.can_checkin) setCheckinDone(true);
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
    <div className={cn("relative flex min-w-0 items-center gap-1.5", className)}>
      {/* 余额 + 「+」合体胶囊：币值一段、加号一段，同一颗圆角外壳。
          「+」恆為加號入口；已簽態只在菜單項裡表達。 */}
      <div
        className="inline-flex max-w-full shrink items-stretch overflow-hidden rounded-full bg-[rgba(0,0,0,0.05)] select-none"
        aria-label={`余额 ${coins} 币`}
      >
        <div className="flex min-w-0 items-center gap-1 whitespace-nowrap px-3 py-1.5 text-ios-footnote font-semibold text-[rgba(120,90,20,0.85)] cursor-default">
          <Coins className="h-3.5 w-3.5 text-[rgba(160,120,30,0.80)]" aria-hidden="true" />
          <span className="min-w-0 truncate tabular-nums">{coins.toLocaleString()}</span>
        </div>
        {(showTopUp || showCheckin) && (
          <button
            type="button"
            onClick={() => setPlusOpen((v) => !v)}
            aria-expanded={plusOpen}
            aria-haspopup="menu"
            aria-label="余额操作"
            className="flex w-7 shrink-0 cursor-pointer items-center justify-center text-[rgba(120,90,20,0.85)] transition-colors duration-200 hover:bg-[rgba(0,0,0,0.06)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
          >
            {/* 2026-09-05 暴君裁定：「+」是充值/签到入口，恆為加號——
                簽到完成態只反映在菜單項裡，不侵占入口圖標。 */}
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* 「+」菜单：数量为 2（充值 / 签到），lg-sheet 玻璃 + specular 顶线。 */}
      {plusOpen && (showTopUp || showCheckin) && (
        <>
          {/* 点外收起：透明层只承接点击，不遮视觉。 */}
          <div className="fixed inset-0 z-30" aria-hidden="true" onClick={() => setPlusOpen(false)} />
          <div
            role="menu"
            aria-label="余额操作"
            className="lg-sheet animate-lg-appear absolute right-0 top-full z-40 mt-2 w-48 overflow-hidden rounded-ios-2xl p-1.5"
          >
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
            {showTopUp && (
              <Link
                href="/pricing"
                role="menuitem"
                onClick={() => setPlusOpen(false)}
                className="flex w-full items-center gap-2.5 rounded-[0.95rem] px-3 py-2.5 text-ios-footnote font-medium text-foreground/[0.88] transition-colors duration-150 hover:bg-[rgba(0,122,255,0.08)] no-underline"
              >
                <CreditCard className="h-4 w-4 text-[rgba(0,0,0,0.44)]" aria-hidden="true" />
                充值
              </Link>
            )}
            {showCheckin && (
              <button
                type="button"
                role="menuitem"
                onClick={() => void handleCheckin()}
                disabled={!canCheckin || checkinLoading}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-[0.95rem] px-3 py-2.5 text-left text-ios-footnote font-medium transition-colors duration-150",
                  canCheckin && !checkinLoading
                    ? "cursor-pointer text-foreground/[0.88] hover:bg-[rgba(52,199,89,0.10)]"
                    : "cursor-not-allowed text-[rgba(0,0,0,0.44)]",
                )}
                aria-disabled={!canCheckin || checkinLoading}
              >
                {checkinLoading ? (
                  <Gift className="h-4 w-4 text-[rgba(0,0,0,0.44)]" aria-hidden="true" />
                ) : canCheckin ? (
                  <Gift className="h-4 w-4 text-[rgba(0,0,0,0.44)]" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-[#248A3D]" aria-hidden="true" />
                )}
                {checkinLoading
                  ? "签到中…"
                  : canCheckin
                    ? `签到（今日可得 ${checkinRewardCount ?? "1-3"} 张）`
                    : "已签到 · 明日再来"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
