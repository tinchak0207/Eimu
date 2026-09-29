"use client";

// 公告的「橫幅」與「彈窗」兩個投放面（ee89433b 只交了端點與鈴鐺列表，這兩面
// 沒有任何前端渲染——運營發了 banner/modal 公告，用戶只能在鈴鐺裡翻到）。
//
//   - 彈窗：GET /api/notifications/active-modal → 複用 AnnouncementDialog；
//     關閉即 POST /api/notifications/mark-read（announcementIds），同一條不再彈。
//   - 橫幅：GET /api/notifications/banners → 取最新一條，底部浮動卡；
//     關閉走 POST /api/notifications/banners/[id]/dismiss（按用戶記）。
//
// 浮動而非塞進 header：header 高度牽動 --ws-navbar-inset 全站佈局，橫幅不該動它。
// 本檔不含任何運營文案，內容全部來自服務端公告。

import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import type { Announcement } from "@/lib/notification-store";
import { AnnouncementDialog } from "@/components/notifications/AnnouncementDialog";

export function AnnouncementSurfaces() {
  const { user, isLoggedIn, token } = useAuth();
  const userId = user?.id ?? null;
  const [modal, setModal] = useState<Announcement | null>(null);
  const [banner, setBanner] = useState<Announcement | null>(null);

  const authHeaders = useMemo(
    () => (token && userId !== null ? { Authorization: `Bearer ${token}`, "x-user-id": String(userId) } : null),
    [token, userId],
  );

  useEffect(() => {
    if (!isLoggedIn || !authHeaders) return;
    let alive = true;
    void (async () => {
      try {
        const [modalRes, bannerRes] = await Promise.all([
          fetch("/api/notifications/active-modal", { headers: authHeaders, cache: "no-store" }),
          fetch("/api/notifications/banners", { headers: authHeaders, cache: "no-store" }),
        ]);
        const modalJson = (await modalRes.json().catch(() => null)) as { data?: { modal?: Announcement | null } } | null;
        const bannerJson = (await bannerRes.json().catch(() => null)) as { data?: { banners?: Announcement[] } } | null;
        if (!alive) return;
        setModal(modalJson?.data?.modal ?? null);
        setBanner(bannerJson?.data?.banners?.[0] ?? null);
      } catch {
        // 公告不可用不打擾用戶：兩面都不出現即可。
      }
    })();
    return () => {
      alive = false;
    };
  }, [isLoggedIn, authHeaders]);

  const closeModal = useCallback(() => {
    const current = modal;
    setModal(null);
    if (!current || !authHeaders) return;
    void fetch("/api/notifications/mark-read", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ announcementIds: [current.id] }),
    }).catch(() => {});
  }, [modal, authHeaders]);

  const dismissBanner = useCallback(() => {
    const current = banner;
    setBanner(null);
    if (!current || !authHeaders) return;
    void fetch(`/api/notifications/banners/${encodeURIComponent(current.id)}/dismiss`, {
      method: "POST",
      headers: authHeaders,
    }).catch(() => {});
  }, [banner, authHeaders]);

  return (
    <>
      <AnnouncementDialog open={modal !== null} announcement={modal} onClose={closeModal} />
      {banner && !modal ? (
        <div
          role="status"
          className="lg-sheet animate-lg-appear fixed bottom-4 left-1/2 z-[90] flex w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 items-start gap-3 rounded-ios-2xl px-4 py-3"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-ios-subhead font-semibold text-[rgba(0,0,0,0.86)]">{banner.title}</p>
            {banner.body ? (
              <p className="mt-0.5 line-clamp-2 text-ios-footnote text-[rgba(0,0,0,0.62)]">{banner.body}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={dismissBanner}
            aria-label="关闭"
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.50)] transition-colors hover:bg-[rgba(0,0,0,0.06)] hover:text-[rgba(0,0,0,0.80)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </>
  );
}
