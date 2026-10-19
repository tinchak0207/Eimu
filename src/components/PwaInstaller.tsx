"use client";

import { useEffect } from "react";

export default function PwaInstaller() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (window.location.protocol !== "https:" && window.location.hostname !== "localhost") return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // SW 注册失败不阻塞任何功能，静默忽略。
    });
  }, []);
  return null;
}