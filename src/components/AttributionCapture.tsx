"use client";

import { useEffect } from "react";
import {
  FIRST_TOUCH_COOKIE,
  FIRST_TOUCH_MAX_AGE_DAYS,
  INVITE_COOKIE,
  INVITE_PARAM,
  firstTouchFromLocation,
  looksLikeInviteCode,
  resolveFirstTouchCookieValue,
} from "@/lib/first-touch-attribution";

/**
 * 首次觸達歸因的採集點（掛在 root layout，任何入口頁都跑得到）。
 *
 * 只做一件事：訪客**第一次**進站時把 utm_source/utm_medium/utm_campaign、來源主機名、
 * 落地路徑寫進 `eimu_first_touch` cookie（90 天）。已有合法值＝不重寫（首觸時間戳與窗口固定）。
 *
 * 為什麼放客戶端而不是 middleware：歸因原料（document.referrer 的原始值）只有瀏覽器有，
 * 而本站沒有 middleware；這裡與既有 PromoGate/PwaInstaller 同一種掛法，零新機制。
 * 任何失敗（cookie 被禁、隱私模式）都靜默吞掉——歸因不可得不得影響任何功能。
 */
function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
}

export function AttributionCapture() {
  useEffect(() => {
    try {
      // 邀請碼：首個邀請勝出，與首觸互不影響（登入後由 /api/auth/me 交控面綁定）。
      const invite = new URLSearchParams(window.location.search).get(INVITE_PARAM)?.trim().toLowerCase();
      if (looksLikeInviteCode(invite) && !readCookie(INVITE_COOKIE)) {
        const secure = window.location.protocol === "https:" ? "; Secure" : "";
        document.cookie = `${INVITE_COOKIE}=${invite}; path=/; max-age=${FIRST_TOUCH_MAX_AGE_DAYS * 86_400}; SameSite=Lax${secure}`;
      }
    } catch {
      // 同上：採集失敗不影響任何功能。
    }
    try {
      const value = resolveFirstTouchCookieValue(
        readCookie(FIRST_TOUCH_COOKIE),
        firstTouchFromLocation({
          search: window.location.search,
          referrer: document.referrer,
          selfHost: window.location.hostname,
          pathname: window.location.pathname,
        }),
      );
      if (!value) return;
      const secure = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie =
        `${FIRST_TOUCH_COOKIE}=${value}; path=/; max-age=${FIRST_TOUCH_MAX_AGE_DAYS * 86_400}; SameSite=Lax${secure}`;
    } catch {
      // 歸因採集失敗不影響任何功能。
    }
  }, []);
  return null;
}
