"use client";

// 公告的「横幅」与「弹窗」两个投放面（ee89433b 只交了端点与铃铛列表，这两面
// 没有任何前端渲染——运营发了 banner/modal 公告，用户只能在铃铛里翻到）。
//
//   - 弹窗：GET /api/notifications/active-modal → 复用 AnnouncementDialog；
//     关闭即 POST /api/notifications/mark-read（announcementIds），同一条不再弹。
//   - 横幅：GET /api/notifications/banners → 取最新一条，底部浮动卡；
//     关闭走 POST /api/notifications/banners/[id]/dismiss（按用户记）。
//
// 浮动而非塞进 header：header 高度牵动 --ws-navbar-inset 全站布局，横幅不该动它。
// 本档不含任何运营文案，内容全部来自服务端公告。

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
        // 公告不可用不打扰用户：两面都不出现即可。
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
