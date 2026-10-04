"use client";

// 站内通知入口：铃铛 / 「API 密钥」菜单里的一行 + 未读徽章 + 通知面板（列表 + 标记已读 + 公告详情弹窗）。
//
// 本档只做接线的容器，**不含任何运营文案**：列表内容全部来自服务端
// （/api/notifications），空态与错误文案是交互用语，不是公告内容。
//
// 两个 variant：
//   icon（默认）—— 现役的独立图标按钮，行为逐字保留给其他调用者；
//   menuItem    —— 下拉菜单里的一行（Bell + 站内通知 + 未读数），零 header 宽度成本。
//
// 面板为什么挂在 body 上的独立 React root，而不是就地 portal：
//   menuItem 点下去 Radix 会关掉菜单（MenuItem.handleSelect → rootContext.onClose），
//   DropdownMenuContent 用 Presence 在退场动画后把整棵子树卸载 —— 触发那一行，
//   连本组件一起消失。面板若渲染在本组件里，会跟着菜单一起没。
//   因此面板由 mountNotificationPanel() 用 createRoot 挂到 body：菜单卸载与它无关。
//   代价是面板拿不到 AuthProvider，故 token/userId 以 props 传进去。
//
// 浮层落点逐字沿用 WalletBadge 的做法（同一病灶）：祖先 .lg-bar 有
// overflow-hidden + backdrop-filter，会把浮层裁掉并缩成 bar 大小，
// 因此用触发元素的 rect 以 fixed 坐标自算位置。
// 坐标在点击当下就量成数字存下来（nextPanelAnchor），因为 menuItem 那一行点完即被卸载，
// 事后再量只会量到 null —— 量不到时保留旧坐标，绝不清成 null（清了面板整个不显示）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Bell, BellOff, CheckCheck } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { LOCAL_TEST_MODE } from "@/lib/local-test-mode";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { AnnouncementDialog } from "./AnnouncementDialog";
import type { Announcement, InboxItem } from "@/lib/notification-store";

/** 一次拉多少条；与服务端 NOTIFICATION_PAGE_SIZE 同值。 */
const PAGE_SIZE = 20;

/** 面板与触发元素之间的呼吸缝。 */
const ANCHOR_GAP = 8;

/** 面板与视窗右缘/上缘的最小留白。 */
const ANCHOR_MARGIN = 8;

interface InboxPayload {
  notifications: InboxItem[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  unreadCount: number;
}

/** 面板落点（视窗坐标，供 fixed 定位）。 */
export interface PanelAnchor {
  top: number;
  right: number;
}

/**
 * 量位置只需要这两个 DOM 能力；显式声明而不是写 HTMLElement，
 * 让测试能用假元素直呼纯函数（不用真 DOM）。
 */
export interface AnchorElement {
  getBoundingClientRect(): { bottom: number; right: number };
  closest(selector: string): { getBoundingClientRect(): { bottom: number } } | null;
}

export interface AnchorInput {
  /** 触发元素的视窗矩形（只用到 bottom / right）。 */
  rect: { bottom: number; right: number };
  /** 祖先 .lg-bar（顶栏玻璃条）的底边；量不到时传 rect.bottom。 */
  barBottom: number;
  /** 视窗宽度（window.innerWidth）。 */
  innerWidth: number;
}

/**
 * 纯函数：由触发元素矩形 → 面板落点。
 * top 取「元素底边」与「顶栏底边」的较大者再加缝（顶栏比元素还低时不被顶栏盖住）；
 * right 由视窗右缘反推，最窄时不低于 ANCHOR_MARGIN，避免窄屏被推出视窗外。
 */
export function computePanelAnchor({ rect, barBottom, innerWidth }: AnchorInput): PanelAnchor {
  return {
    top: Math.max(rect.bottom, barBottom) + ANCHOR_GAP,
    right: Math.max(ANCHOR_MARGIN, innerWidth - rect.right),
  };
}

/**
 * 纯函数：量一组新落点。
 * 触发元素可能已经不在了（下拉菜单项选完就随菜单卸载，ref 归 null）——
 * 这时原样返回上一组坐标，**不返回 null**：清零会让面板整个消失。
 */
export function nextPanelAnchor(
  previous: PanelAnchor | null,
  el: AnchorElement | null,
  innerWidth: number,
): PanelAnchor | null {
  if (!el) return previous;
  const rect = el.getBoundingClientRect();
  const bar = el.closest(".lg-bar");
  const barBottom = bar ? bar.getBoundingClientRect().bottom : rect.bottom;
  return computePanelAnchor({ rect, barBottom, innerWidth });
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

/** 面板自己的 React root 句柄。同一时刻只允许一层面板。 */
let panelHost: { container: HTMLDivElement; root: Root } | null = null;

/**
 * 把面板挂到 body 上的独立 root —— 这是「菜单卸载后面板还活着」的唯一保障。
 * 重复调用先卸旧再挂新，不会叠层。
 */
function mountNotificationPanel(props: NotificationPanelProps) {
  unmountNotificationPanel();
  const container = document.createElement("div");
  container.setAttribute("data-notification-panel", "");
  // 菜单关掉的那 200ms 退场动画里，Radix 会把 body 的 pointer-events 设成 none
  // （DismissableLayer 的 disableOutsidePointerEvents）。面板是 body 的子节点，
  // 会继承到 none —— 显式 auto，让面板在菜单退场期间就能点（与 Radix 自己的浮层同款做法）。
  container.style.pointerEvents = "auto";
  document.body.appendChild(container);
  const root = createRoot(container);
  panelHost = { container, root };
  root.render(<NotificationPanel {...props} />);
}

/** 卸掉面板 root（幂等）。延后一个 microtask，避免在自身事件处理里同步卸载。 */
function unmountNotificationPanel() {
  const host = panelHost;
  if (!host) return;
  panelHost = null;
  queueMicrotask(() => {
    host.root.unmount();
    host.container.remove();
  });
}

interface NotificationPanelProps {
  authHeaders: Record<string, string> | null;
  /** 触发元素的 ref：菜单项那条在菜单关闭后归 null，量不到就沿用旧坐标。 */
  triggerRef: RefObject<HTMLElement | null>;
  /** 点击当下算好的落点（数字，不是 element）。 */
  initialAnchor: PanelAnchor | null;
  onClose: () => void;
  /** 服务端返回的权威未读数回灌给触发钮的红点（面板与触发钮不在同一棵树上）。 */
  onUnreadChange: (count: number) => void;
}

/** 通知面板：列表 / 已读 / 加载更多 / 公告详情，全部沿用原实现。 */
function NotificationPanel({
  authHeaders,
  triggerRef,
  initialAnchor,
  onClose,
  onUnreadChange,
}: NotificationPanelProps) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Announcement | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<PanelAnchor | null>(initialAnchor);
  const [now] = useState(() => Date.now());

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
        onUnreadChange(data.unreadCount);
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
    [authHeaders, onUnreadChange],
  );

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
        if (typeof json.data?.unreadCount === "number") onUnreadChange(json.data.unreadCount);
      } catch {
        // 标记失败不打断阅读：条目仍是未读，下次打开会再试。
      }
    },
    [authHeaders, onUnreadChange],
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

  // 打开即拉第一页。
  useEffect(() => {
    void loadPage(1, false);
  }, [loadPage]);

  // 面板跟着触发元素跑：窗口尺寸/滚动时重新量；触发元素已卸载则保留旧坐标。
  useEffect(() => {
    const measure = () => setAnchor((previous) => nextPanelAnchor(previous, triggerRef.current, window.innerWidth));
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [triggerRef]);

  if (!anchor) return null;

  return (
    <>
      {/* 点外收起：透明层只承接点击，不遮视觉。 */}
      <div className="fixed inset-0 z-[89]" aria-hidden="true" onClick={onClose} />
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
              className="inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-1 text-ios-caption1 font-medium text-[#007AFF] transition-colors duration-150 hover:bg-[rgba(0,122,255,0.08)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
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
                className="ml-1 cursor-pointer text-[#007AFF] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
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
                className="flex w-full cursor-pointer items-start gap-2.5 rounded-[0.95rem] px-3 py-2.5 text-left transition-colors duration-150 hover:bg-[rgba(0,122,255,0.08)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              >
                {/* 未读标记：一颗 6px 圆点，已读位用等宽占位保持标题左缘对齐。 */}
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
              className="mt-1 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-[0.95rem] px-3 py-2.5 text-ios-footnote font-medium text-[#007AFF] transition-colors duration-150 hover:bg-[rgba(0,122,255,0.08)] disabled:cursor-not-allowed disabled:text-[rgba(0,0,0,0.40)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              {loadingMore ? <Spinner className="h-3.5 w-3.5" /> : null}
              加载更多
            </button>
          ) : null}
        </div>
      </div>

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

export function NotificationBell({
  className,
  variant = "icon",
}: {
  className?: string;
  /** icon＝独立图标按钮（默认，行为不变）；menuItem＝下拉菜单里的一行。 */
  variant?: "icon" | "menuItem";
}) {
  const { user, isLoggedIn, token } = useAuth();
  const userId = user?.id ?? null;

  const [unreadCount, setUnreadCount] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);

  /** 触发元素：icon 是那个圆钮，menuItem 是菜单里那一行（菜单关掉就归 null）。 */
  const triggerRef = useRef<HTMLElement | null>(null);

  const authHeaders = useMemo(
    () => (token && userId !== null ? { Authorization: `Bearer ${token}`, "x-user-id": String(userId) } : null),
    [token, userId],
  );

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    unmountNotificationPanel();
  }, []);

  const handleUnreadChange = useCallback((count: number) => {
    setUnreadCount(count);
  }, []);

  /** 点击当下：先把坐标量成数字（menuItem 那一行点完即被卸载，事后再量只有 null）。 */
  const openPanel = useCallback(() => {
    if (!authHeaders) return;
    const initialAnchor = nextPanelAnchor(null, triggerRef.current, window.innerWidth);
    setPanelOpen(true);
    mountNotificationPanel({ authHeaders, triggerRef, initialAnchor, onClose: closePanel, onUnreadChange: handleUnreadChange });
  }, [authHeaders, closePanel, handleUnreadChange]);

  const toggleOpen = useCallback(() => {
    if (panelOpen) closePanel();
    else openPanel();
  }, [closePanel, openPanel, panelOpen]);

  /** 未读红点的来源：只取一条的轻量请求，拿到 unreadCount 就够。 */
  useEffect(() => {
    if (!isLoggedIn || !authHeaders) {
      setUnreadCount(0);
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

  if (LOCAL_TEST_MODE || !isLoggedIn || !user) return null;

  const hasUnread = unreadCount > 0;

  // 下拉菜单里的一行：与 DropdownMenuItem 同款 class/icon 尺寸，右端是未读数徽章。
  // 点它＝开同一块面板（面板挂在 body 的独立 root，不受菜单关闭影响）。
  if (variant === "menuItem") {
    return (
      <DropdownMenuItem
        ref={(node) => {
          triggerRef.current = node;
        }}
        onSelect={() => openPanel()}
        className="cursor-pointer"
      >
        <Bell className="mr-2 h-3.5 w-3.5 text-[rgba(0,0,0,0.44)]" aria-hidden="true" />
        站内通知
        {hasUnread ? (
          <span className="ml-auto flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#FF3B30] px-1 text-ios-caption2 font-semibold tabular-nums leading-none text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </DropdownMenuItem>
    );
  }

  return (
    <button
      ref={(node) => {
        triggerRef.current = node;
      }}
      type="button"
      onClick={toggleOpen}
      aria-label={hasUnread ? `通知（${unreadCount} 条未读）` : "通知"}
      aria-haspopup="menu"
      aria-expanded={panelOpen}
      title="通知"
      className={cn(
        "lg-float relative flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.78)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 sm:h-9 sm:w-9",
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
  );
}
