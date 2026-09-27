"use client";

// 顶栏通知入口：铃铛 + 未读红点 + 下拉列表 + 标记已读 + 公告详情弹窗。
//
// 本档只做接线的容器，**不含任何运营文案**：列表内容全部来自服务端
// （/api/notifications），空态与错误文案是交互用语，不是公告内容。
//
// 浮层落点逐字沿用 WalletBadge 的做法（同一病灶）：祖先 .lg-bar 有
// overflow-hidden + backdrop-filter，会把浮层裁掉并缩成 bar 大小，
// 因此 portal 到 body 后用按钮 rect 以 fixed 坐标自算位置。
//
// 已读语义：点开条目即对该条标记已读；「全部已读」对当前列表里未读的 id 一次提交。
// 标记只写当前登录用户自己的子文档（服务端保证），跨用户无影响。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bell, BellOff, CheckCheck } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { LOCAL_TEST_MODE } from "@/lib/local-test-mode";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { AnnouncementDialog } from "./AnnouncementDialog";
import type { Announcement, InboxItem } from "@/lib/notification-store";

/** 一次拉多少条；与服务端 NOTIFICATION_PAGE_SIZE 同值。 */
const PAGE_SIZE = 20;

interface InboxPayload {
  notifications: InboxItem[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  unreadCount: number;
}

/** ISO → 列表里的时间标签（刚刚 / N 分钟前 / N 小时前 / 昨天 / M月D日）。 */
function formatWhen(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const diff = now - at;
  if (diff < 60_000) return "刚刚";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))} 小时前`;
  if (diff < 48 * 60 * 60_000) return "昨天";
  const date = new Date(at);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function NotificationBell({ className }: { className?: string }) {
  const { user, isLoggedIn, token } = useAuth();
  const userId = user?.id ?? null;

  const [items, setItems] = useState<InboxItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Announcement | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const authHeaders = useMemo(
    () => (token && userId !== null ? { Authorization: `Bearer ${token}`, "x-user-id": String(userId) } : null),
    [token, userId],
  );

  const measureAnchor = useCallback(() => {
    const button = buttonRef.current;
    const rect = button?.getBoundingClientRect();
    if (!rect) return;
    const barBottom = button?.closest(".lg-bar")?.getBoundingClientRect().bottom ?? rect.bottom;
    setAnchor({
      top: Math.max(rect.bottom, barBottom) + 8,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, []);

  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    measureAnchor();
    window.addEventListener("resize", measureAnchor);
    window.addEventListener("scroll", measureAnchor, true);
    return () => {
      window.removeEventListener("resize", measureAnchor);
      window.removeEventListener("scroll", measureAnchor, true);
    };
  }, [open, measureAnchor]);

  /** 未读红点的来源：只取一条的轻量请求，拿到 unreadCount 就够。 */
  useEffect(() => {
    if (!isLoggedIn || !authHeaders) {
      setUnreadCount(0);
      setItems([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/notifications?pageSize=1", {
          headers: authHeaders,
          cache: "no-store",
        });
        const json = (await res.json()) as { success?: boolean; data?: InboxPayload };
        if (cancelled || !json?.success || !json.data) return;
        setUnreadCount(json.data.unreadCount);
      } catch {
        // 红点读不到就不显示；不把失败画成「零通知」以外的干扰。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, authHeaders]);

  const loadPage = useCallback(
    async (targetPage: number, append: boolean) => {
      if (!authHeaders) return;
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const res = await fetch(`/api/notifications?page=${targetPage}&pageSize=${PAGE_SIZE}`, {
          headers: authHeaders,
          cache: "no-store",
        });
        const json = (await res.json()) as { success?: boolean; data?: InboxPayload };
        if (!json?.success || !json.data) throw new Error("load failed");
        const data = json.data;
        setItems((previous) => (append ? [...previous, ...data.notifications] : data.notifications));
        setUnreadCount(data.unreadCount);
        setHasMore(data.hasMore);
        setPage(data.page);
        setFailed(false);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [authHeaders],
  );

  const toggleOpen = useCallback(() => {
    setOpen((previous) => {
      const next = !previous;
      if (next) {
        setNow(Date.now());
        void loadPage(1, false);
      }
      return next;
    });
  }, [loadPage]);

  const markRead = useCallback(
    async (payload: { notificationIds?: string[]; announcementIds?: string[] }) => {
      if (!authHeaders) return;
      try {
        const res = await fetch("/api/notifications/mark-read", {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = (await res.json()) as { success?: boolean; data?: { unreadCount?: number } };
        if (!json?.success) return;
        const touched = new Set([...(payload.notificationIds ?? []), ...(payload.announcementIds ?? [])]);
        setItems((previous) => previous.map((item) => (touched.has(item.id) ? { ...item, read: true } : item)));
        if (typeof json.data?.unreadCount === "number") setUnreadCount(json.data.unreadCount);
      } catch {
        // 标记失败不打断阅读：条目仍是未读，下次打开会再试。
      }
    },
    [authHeaders],
  );

  const openDetail = useCallback(
    async (announcementId: string) => {
      if (!authHeaders) return;
      setDetailId(announcementId);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      try {
        const res = await fetch(`/api/notifications/announcements/${encodeURIComponent(announcementId)}`, {
          headers: authHeaders,
          cache: "no-store",
        });
        const json = (await res.json()) as { success?: boolean; data?: Announcement; message?: string };
        if (!json?.success || !json.data) {
          setDetailError(json?.message ?? "公告不存在或已下线。");
          return;
        }
        setDetail(json.data);
      } catch {
        setDetailError("公告详情暂时不可用，请稍后再试。");
      } finally {
        setDetailLoading(false);
      }
    },
    [authHeaders],
  );

  const handleItemClick = useCallback(
    (item: InboxItem) => {
      if (!item.read) {
        void markRead(item.kind === "announcement" ? { announcementIds: [item.id] } : { notificationIds: [item.id] });
      }
      const targetId = item.kind === "announcement" ? item.id : item.announcementId;
      if (targetId) void openDetail(targetId);
    },
    [markRead, openDetail],
  );

  const unreadInList = useMemo(() => items.filter((item) => !item.read), [items]);

  const markAllVisibleRead = useCallback(() => {
    if (!unreadInList.length) return;
    void markRead({
      notificationIds: unreadInList.filter((item) => item.kind === "notification").map((item) => item.id),
      announcementIds: unreadInList.filter((item) => item.kind === "announcement").map((item) => item.id),
    });
  }, [markRead, unreadInList]);

  if (LOCAL_TEST_MODE || !isLoggedIn || !user) return null;

  const hasUnread = unreadCount > 0;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleOpen}
        aria-label={hasUnread ? `通知（${unreadCount} 条未读）` : "通知"}
        aria-haspopup="menu"
        aria-expanded={open}
        title="通知"
        className={cn(
          "lg-float relative flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.78)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] sm:h-9 sm:w-9",
          className,
        )}
      >
        <Bell className="h-3.5 w-3.5" aria-hidden="true" />
        {hasUnread ? (
          <>
            {/* 数字徽标：>9 显示 9+，避免小圆点被撑成椭圆。 */}
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#FF3B30] px-1 text-ios-caption2 font-semibold tabular-nums leading-none text-white"
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
            <span className="sr-only">{unreadCount} 条未读通知</span>
          </>
        ) : null}
      </button>

      {open && anchor && mounted
        ? createPortal(
            <>
              {/* 点外收起：透明层只承接点击，不遮视觉。 */}
              <div className="fixed inset-0 z-[89]" aria-hidden="true" onClick={() => setOpen(false)} />
              <div
                role="menu"
                aria-label="通知"
                style={{ top: anchor.top, right: anchor.right }}
                className="lg-sheet animate-lg-appear fixed z-[90] flex max-h-[min(70dvh,30rem)] w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-ios-2xl"
              >
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />

                <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-3">
                  <span className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.80)]">通知</span>
                  {unreadInList.length > 0 ? (
                    <button
                      type="button"
                      onClick={markAllVisibleRead}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-1 text-ios-caption1 font-medium text-[#007AFF] transition-colors duration-150 hover:bg-[rgba(0,122,255,0.08)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
                    >
                      <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
                      全部已读
                    </button>
                  ) : null}
                </div>
                <div className="mx-3 h-px shrink-0 bg-[rgba(0,0,0,0.07)]" />

                <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                  {loading ? (
                    <div className="flex items-center justify-center gap-2 px-3 py-8 text-ios-footnote text-[rgba(0,0,0,0.52)]">
                      <Spinner className="h-3.5 w-3.5" />
                      正在读取…
                    </div>
                  ) : failed ? (
                    <div className="px-3 py-8 text-center text-ios-footnote text-[rgba(0,0,0,0.60)]">
                      通知暂时不可用。
                      <button
                        type="button"
                        onClick={() => void loadPage(1, false)}
                        className="ml-1 cursor-pointer text-[#007AFF] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
                      >
                        重试
                      </button>
                    </div>
                  ) : items.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 px-3 py-9 text-ios-footnote text-[rgba(0,0,0,0.52)]">
                      <BellOff className="h-4 w-4" aria-hidden="true" />
                      暂无通知
                    </div>
                  ) : (
                    items.map((item) => (
                      <button
                        key={`${item.kind}:${item.id}`}
                        type="button"
                        role="menuitem"
                        onClick={() => handleItemClick(item)}
                        className="flex w-full cursor-pointer items-start gap-2.5 rounded-[0.95rem] px-3 py-2.5 text-left transition-colors duration-150 hover:bg-[rgba(0,122,255,0.08)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
                      >
                        {/* 未读标记：一顆 6px 圆点，已读位用等宽占位保持标题左缘对齐。 */}
                        <span className="mt-1 flex h-1.5 w-1.5 shrink-0 items-center justify-center" aria-hidden="true">
                          {item.read ? null : <span className="h-1.5 w-1.5 rounded-full bg-[#FF3B30]" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className={cn(
                              "block truncate text-ios-footnote",
                              item.read
                                ? "font-medium text-[rgba(0,0,0,0.62)]"
                                : "font-semibold text-[rgba(0,0,0,0.88)]",
                            )}
                          >
                            {item.title}
                          </span>
                          <span className="mt-0.5 line-clamp-2 block text-ios-caption1 leading-[1.35] text-[rgba(0,0,0,0.55)]">
                            {item.body}
                          </span>
                          <span className="mt-1 block text-ios-caption2 tabular-nums text-[rgba(0,0,0,0.42)]">
                            {formatWhen(item.createdAt, now)}
                          </span>
                        </span>
                      </button>
                    ))
                  )}

                  {hasMore && !loading && !failed ? (
                    <button
                      type="button"
                      onClick={() => void loadPage(page + 1, true)}
                      disabled={loadingMore}
                      className="mt-1 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-[0.95rem] px-3 py-2.5 text-ios-footnote font-medium text-[#007AFF] transition-colors duration-150 hover:bg-[rgba(0,122,255,0.08)] disabled:cursor-not-allowed disabled:text-[rgba(0,0,0,0.40)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
                    >
                      {loadingMore ? <Spinner className="h-3.5 w-3.5" /> : null}
                      加载更多
                    </button>
                  ) : null}
                </div>
              </div>
            </>,
            document.body,
          )
        : null}

      <AnnouncementDialog
        open={detailId !== null}
        announcement={detail}
        loading={detailLoading}
        error={detailError}
        onClose={() => {
          setDetailId(null);
          setDetail(null);
          setDetailError(null);
        }}
      />
    </>
  );
}
