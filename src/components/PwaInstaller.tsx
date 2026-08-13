"use client";

import { useEffect } from "react";

export function PwaInstaller() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (window.location.protocol !== "https:" && window.location.hostname !== "localhost") return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // SW 註冊失敗不阻塞任何功能，靜默忽略。
    });
  }, []);
  return null;
}