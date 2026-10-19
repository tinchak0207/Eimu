"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Coins, CreditCard, Gift, CheckCircle2, Plus } from "lucide-react";
import { quotaToRewardCount } from "@/lib/checkin-copy";
import { describeQuota, type QuotaDisplayState } from "@/lib/quota-display";
import { useAuth } from "@/hooks/use-auth";
import { quotaToCoins, fetchCheckinStatus, doCheckin } from "@/lib/new-api-client";
import { cn } from "@/lib/utils";

interface WalletBadgeProps {
  className?: string;
  showTopUp?: boolean;
  showCheckin?: boolean;
  /**
   * 呼叫端若已从更权威的来源取得额度状态（例如未来直接读 `/v1/quota` 的元件），
   * 可传入覆写；省略时由本元件从 auth session 推导。纯显示层入口，不触发任何 IO。
   */
  quotaState?: QuotaDisplayState;
}

/**
 * 余额胶囊（2026-08-27 项目负责人裁定）：余额 + 「+」合成一颗胶囊。
 * 「+」点开两项菜单（充值 / 每日签到）：充值跳 /pricing，签到就地完成。
 * 2026-09-05 修正：「+」入口图标恒定不变——已签到状态只体现在菜单项里
 * （不可选 + 「已签到 · 明日再来」），不再把「+」换成绿勾。
 */
export function WalletBadge({ className, showTopUp = true, showCheckin = true, quotaState }: WalletBadgeProps) {
  const { user, token, isLoggedIn, refresh } = useAuth();
  const [plusOpen, setPlusOpen] = useState(false);
  const [canCheckin, setCanCheckin] = useState(false);
  const [checkinLoading, setCheckinLoading] = useState(false);
  const [, setCheckinDone] = useState(false);
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

  const plusBtnRef = useRef<HTMLButtonElement | null>(null);
  /* 「+」浮层的落点（fixed 座标）：portal 到 body 后就脱离了 .lg-bar 的
     overflow-hidden 与 backdrop-filter containing block，位置必须自己算。
     量测时机＝开启当下 ＋ resize/scroll（navbar 是 sticky，卷动时钮的视口座标不变，
     但展开中的浮层仍跟著量，避免缩窗后错位）。 */
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; right: number } | null>(null);
  const measureAnchor = useCallback(() => {
    const btn = plusBtnRef.current;
    const rect = btn?.getBoundingClientRect();
    if (!rect) return;
    // 用「+」钮下缘对齐，但胶囊钮比 .lg-bar 矮（bar 有 py 内距），只取钮下缘
    // 会让浮层顶端落进 bar 的下内距、盖住玻璃条底缘；故取两者较低者再留 8px。
    const barBottom = btn?.closest(".lg-bar")?.getBoundingClientRect().bottom ?? rect.bottom;
    setMenuAnchor({ top: Math.max(rect.bottom, barBottom) + 8, right: Math.max(8, window.innerWidth - rect.right) });
  }, []);
  useEffect(() => {
    if (!plusOpen) {
      setMenuAnchor(null);
      return;
    }
    measureAnchor();
    window.addEventListener("resize", measureAnchor);
    window.addEventListener("scroll", measureAnchor, true);
    return () => {
      window.removeEventListener("resize", measureAnchor);
      window.removeEventListener("scroll", measureAnchor, true);
    };
  }, [plusOpen, measureAnchor]);

  // 额度显示语义（R3）：把 auth session 的读数收敛成 describeQuota 的三态。
  //   有有限读数 ⇒ authoritative（帐本权威值，直接显示，包含真实的 0）；
  //   读不到／非有限 ⇒ 有上次成功的读数就标 estimated（约值 + 时效），否则
  //   unavailable（显示「暂不可用」，永不画假 0）。
  // 这只在显示层收敛语义，不改任何取余额的 API／资料层。
  const liveCoins =
    isLoggedIn && user && Number.isFinite(user.quota) ? quotaToCoins(user.quota) : null;
  const lastGoodQuotaRef = useRef<{ coins: number; asOf: number } | null>(null);
  useEffect(() => {
    if (liveCoins !== null) lastGoodQuotaRef.current = { coins: liveCoins, asOf: Date.now() };
  }, [liveCoins]);

  if (!isLoggedIn || !user) return null;

  const derivedQuotaState: QuotaDisplayState =
    liveCoins !== null
      ? { kind: "authoritative", balanceCoins: liveCoins }
      : lastGoodQuotaRef.current
        ? {
            kind: "estimated",
            balanceCoins: lastGoodQuotaRef.current.coins,
            asOf: lastGoodQuotaRef.current.asOf,
          }
        : { kind: "unavailable", reason: "auth session has no finite balance" };
  const quotaDisplay = describeQuota(quotaState ?? derivedQuotaState, Date.now());
  const quotaToneClass =
    quotaDisplay.tone === "ok"
      ? "text-[rgba(120,90,20,0.85)]"
      : quotaDisplay.tone === "warn"
        ? "text-[rgba(150,90,10,0.90)]"
        : "text-[rgba(0,0,0,0.44)]";

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
          「+」恒为加号入口；已签态只在菜单项里表达。 */}
      <div
        className="inline-flex max-w-full shrink items-stretch overflow-hidden rounded-full bg-[rgba(0,0,0,0.05)] max-sm:bg-transparent select-none"
        aria-label={`余额 ${quotaDisplay.label}${quotaDisplay.stale ? "（数据可能已过期）" : ""}`}
        title={quotaDisplay.stale ? "数据可能已过期" : undefined}
      >
        <div
          className={cn(
            "flex min-w-0 items-center gap-1 whitespace-nowrap px-3 py-1.5 text-ios-footnote font-semibold cursor-default",
            quotaToneClass,
          )}
        >
          <Coins className="h-3.5 w-3.5 text-[rgba(160,120,30,0.80)]" aria-hidden="true" />
          <span className="min-w-0 truncate tabular-nums">{quotaDisplay.label}</span>
        </div>
        {(showTopUp || showCheckin) && (
          <button
            type="button"
            ref={plusBtnRef}
            onClick={() => setPlusOpen((v) => !v)}
            aria-expanded={plusOpen}
            aria-haspopup="menu"
            aria-label="余额操作"
            className="flex w-6 shrink-0 cursor-pointer items-center justify-center text-[rgba(120,90,20,0.85)] transition-colors duration-200 sm:hover:bg-[rgba(0,0,0,0.06)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          >
            {/* 2026-09-05 项目负责人裁定：「+」是充值/签到入口，恒为加号——
                签到完成态只反映在菜单项里，不侵占入口图标。 */}
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* 「+」菜单：数量为 2（充值 / 签到），lg-sheet 玻璃 + specular 顶线。
          2026-09-27：portal 到 body——祖先 .lg-bar 的 overflow-hidden 会裁掉浮层、
          backdrop-filter 又会把 fixed 后代缩成 bar 大小，两者都在 portal 后失效；
          位置改用「+」钮的 rect 以 fixed 座标自算，层级对齐同档帐号选单 z-90。 */}
      {plusOpen && menuAnchor && (showTopUp || showCheckin) && createPortal(
        <>
          {/* 点外收起：透明层只承接点击，不遮视觉。portal 到 body 后才是真正的全屏层。 */}
          <div className="fixed inset-0 z-[89]" aria-hidden="true" onClick={() => setPlusOpen(false)} />
          <div
            role="menu"
            aria-label="余额操作"
            style={{ top: menuAnchor.top, right: menuAnchor.right }}
            className="lg-sheet animate-lg-appear fixed z-[90] w-48 overflow-hidden rounded-ios-2xl p-1.5"
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
        </>,
        document.body,
      )}
    </div>
  );
}
