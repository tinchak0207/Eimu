"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, CheckCircle2, Gift, X } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { doCheckin, fetchCheckinStatus } from "@/lib/new-api-client";
import { formatCheckinRewardText, quotaToRewardCount } from "@/lib/checkin-copy";
import { cn } from "@/lib/utils";

interface CheckinCalendarProps {
  className?: string;
}

interface CheckinStatusCacheEntry {
  canCheckin: boolean;
  rewardCount: number | null;
}

function getCheckinCacheKey(userId: number) {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `checkin_status_${userId}_${now.getFullYear()}-${month}-${day}`;
}

function readCheckinStatusCache(userId: number): CheckinStatusCacheEntry | null {
  try {
    const raw = window.localStorage.getItem(getCheckinCacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CheckinStatusCacheEntry>;
    if (typeof parsed.canCheckin !== "boolean") return null;
    return {
      canCheckin: parsed.canCheckin,
      rewardCount: typeof parsed.rewardCount === "number" ? parsed.rewardCount : null,
    };
  } catch {
    return null;
  }
}

function writeCheckinStatusCache(userId: number, entry: CheckinStatusCacheEntry) {
  try {
    window.localStorage.setItem(getCheckinCacheKey(userId), JSON.stringify(entry));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

export function CheckinCalendar({ className }: CheckinCalendarProps) {
  const { token, user, refresh } = useAuth();
  const userId = user?.id;
  const [open, setOpen] = useState(false);
  // createPortal 需要 document，SSR 阶段不能调用（与历史灯箱同一模式）。
  const [mounted, setMounted] = useState(false);
  const [canCheckin, setCanCheckin] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [rewardCount, setRewardCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const weekDays = useMemo(() => {
    const today = new Date();
    const start = new Date(today);
    start.setHours(0, 0, 0, 0);
    start.setDate(today.getDate() - today.getDay());
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return {
        key: date.toISOString(),
        label: ["日", "一", "二", "三", "四", "五", "六"][date.getDay()],
        date: date.getDate(),
        isToday: date.toDateString() === today.toDateString(),
      };
    });
  }, []);

  const loadStatus = useCallback(async () => {
    if (!token) return;
    setLoadingStatus(true);
    setError(null);
    try {
      const res = await fetchCheckinStatus(token);
      if (res.success && res.data) {
        const nextCanCheckin = res.data.can_checkin;
        const nextRewardCount = res.data.quota ? quotaToRewardCount(res.data.quota) : null;
        setCanCheckin(nextCanCheckin);
        if (nextRewardCount !== null) setRewardCount(nextRewardCount);
        if (userId !== undefined) {
          writeCheckinStatusCache(userId, { canCheckin: nextCanCheckin, rewardCount: nextRewardCount });
        }
      } else {
        setError(res.message ?? "签到状态获取失败");
      }
    } catch {
      setError("签到状态获取失败");
    } finally {
      setLoadingStatus(false);
    }
  }, [token, userId]);

  useEffect(() => {
    if (!token) return;
    if (userId !== undefined) {
      const cached = readCheckinStatusCache(userId);
      if (cached) {
        setCanCheckin(cached.canCheckin);
        if (cached.rewardCount !== null) setRewardCount(cached.rewardCount);
        return;
      }
    }
    void loadStatus();
  }, [token, userId, loadStatus]);

  const handleOpen = () => {
    setOpen(true);
    void loadStatus();
  };

  const handleCheckin = async () => {
    if (!token || submitting || !canCheckin) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await doCheckin(token);
      if (res.success) {
        const count = quotaToRewardCount(res.data?.quota ?? 500_000);
        setRewardCount(count);
        setCanCheckin(false);
        if (userId !== undefined) {
          writeCheckinStatusCache(userId, { canCheckin: false, rewardCount: count });
        }
        await refresh();
      } else {
        setError(res.message ?? "签到失败，请稍后再试");
      }
    } catch {
      setError("签到失败，请稍后再试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className={cn(
          "lg-float flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.78)]",
          rewardCount && "text-[#34C759]",
          className,
        )}
        aria-label="每日签到"
      >
        {rewardCount ? (
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        <span className="sr-only">签到</span>
      </button>

      {open && mounted
        ? createPortal(
            // /38 不在 Tailwind 默认透明度刻度上，静默编译成空——遮罩其实是全透明的。
            // rgba() 任意值才真正生效（与历史灯箱同一修法）。
            <div className="fixed inset-0 z-[90] flex min-h-[100dvh] items-end justify-center bg-[rgba(31,34,48,0.74)] px-2.5 pb-3 backdrop-blur-md sm:items-center sm:p-6">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="checkin-title"
            // lg-sheet：与全站弹层同一块玻璃。之前是灰底 + 黑描边的平面卡，
            // 在一站玻璃里像贴进来的异物。
            className="lg-sheet relative w-[min(calc(100vw-20px),440px)] max-w-[440px] overflow-hidden rounded-t-ios-4xl px-5 pb-6 pt-5 sm:rounded-ios-4xl"
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="lg-float absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-[rgba(0,0,0,0.44)]"
              aria-label="关闭签到"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>

            <div className="mb-5 pr-10">
              <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-ios-2xl bg-[rgba(0,122,255,0.10)]">
                <Gift className="h-5 w-5 text-[#007AFF]" aria-hidden="true" />
              </div>
              <h2 id="checkin-title" className="text-ios-title2 font-bold tracking-tight text-[rgba(0,0,0,0.86)]">
                每日签到
              </h2>
              <p className="mt-1 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
                每日签到可随机获得 1 到 3 张额度
              </p>
            </div>

            <div className="grid grid-cols-7 gap-1.5">
              {weekDays.map((day) => (
                <div
                  key={day.key}
                  className={cn(
                    "flex min-h-14 flex-col items-center justify-center rounded-ios-xl text-ios-caption1",
                    day.isToday
                      ? "bg-[#007AFF] font-semibold text-white shadow-[0_8px_20px_rgba(0,122,255,0.24)]"
                      : "bg-[rgba(0,0,0,0.045)] text-[rgba(0,0,0,0.50)]",
                  )}
                >
                  <span>{day.label}</span>
                  <span className="mt-0.5 text-ios-footnote">{day.date}</span>
                </div>
              ))}
            </div>

            <div className="mt-5 rounded-ios-2xl bg-[rgba(0,0,0,0.04)] px-4 py-3">
              <p className="text-ios-footnote font-medium text-[rgba(0,0,0,0.70)]">
                {rewardCount ? `今日签到已获得 ${rewardCount} 张额度` : formatCheckinRewardText()}
              </p>
              {error && <p className="mt-1 text-ios-caption1 text-[#FF3B30]">{error}</p>}
            </div>

            <button
              type="button"
              onClick={handleCheckin}
              disabled={loadingStatus || submitting || !canCheckin}
              className="mt-4 w-full rounded-ios-xl bg-[#007AFF] py-3.5 text-ios-body font-semibold text-white shadow-[0_8px_24px_rgba(0,122,255,0.30)] lg-transition hover:bg-[#0066DD] disabled:bg-[rgba(0,0,0,0.16)] disabled:shadow-none"
            >
              {submitting ? "签到中" : canCheckin ? "签到领取" : "今日已签到"}
            </button>
          </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
