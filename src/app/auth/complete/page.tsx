"use client";

import { useEffect } from "react";

export default function AuthCompletePage() {
  useEffect(() => {
    const target = window.location.origin;
    if (window.opener) {
      // 登入發生在 popup 內：通知開啟它的主頁（已帶 napi cookie），然後自己關閉。
      try {
        window.opener.postMessage({ type: "github-auth-complete" }, target);
      } catch {
        // opener 已不可達，忽略——主頁會在下一次導航時自然拿到登入態。
      }
      window.close();
      return;
    }
    // 整頁跳轉的登入：無 opener，直接回首頁。
    const timer = window.setTimeout(() => {
      window.location.replace("/");
    }, 300);
    return () => window.clearTimeout(timer);
  }, []);
  return null;
}