"use client";

import { useEffect, useState } from "react";
import type { EimuShellApi } from "@/types/eimu-shell";

/**
 * 偵測是否跑在 Eimu 桌面殼內（＝外殼以 contextBridge 注入了 `window.eimuShell`）。
 *
 * 普通瀏覽器（含 PWA）恆回 null。判定放 useEffect：SSR／首幀一律 null，避免
 * hydration 不一致（首幀就依作業系統注入與否分歧會炸）。
 *
 * Navbar 與 WindowControls 共用同一個真相來源（單一判定，不各寫一份）。
 */
export function useEimuShell(): EimuShellApi | null {
  const [shell, setShell] = useState<EimuShellApi | null>(null);
  useEffect(() => {
    setShell(window.eimuShell ?? null);
  }, []);
  return shell;
}
