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
 * 首次触达归因的采集点（挂在 root layout，任何入口页都跑得到）。
 *
 * 只做一件事：访客**第一次**进站时把 utm_source/utm_medium/utm_campaign、来源主机名、
 * 落地路径写进 `eimu_first_touch` cookie（90 天）。已有合法值＝不重写（首触时间戳与窗口固定）。
 *
 * 为什么放客户端而不是 middleware：归因原料（document.referrer 的原始值）只有浏览器有，
 * 而本站没有 middleware；这里与既有 PromoGate/PwaInstaller 同一种挂法，零新机制。
 * 任何失败（cookie 被禁、隐私模式）都静默吞掉——归因不可得不得影响任何功能。
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
      // 邀请码：首个邀请胜出，与首触互不影响（登入后由 /api/auth/me 交控面绑定）。
      const invite = new URLSearchParams(window.location.search).get(INVITE_PARAM)?.trim().toLowerCase();
      if (looksLikeInviteCode(invite) && !readCookie(INVITE_COOKIE)) {
        const secure = window.location.protocol === "https:" ? "; Secure" : "";
        document.cookie = `${INVITE_COOKIE}=${invite}; path=/; max-age=${FIRST_TOUCH_MAX_AGE_DAYS * 86_400}; SameSite=Lax${secure}`;
      }
    } catch {
      // 同上：采集失败不影响任何功能。
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
      // 归因采集失败不影响任何功能。
    }
  }, []);
  return null;
}
