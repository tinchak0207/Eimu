"use client";

import { useEffect, useState } from "react";
import type { EimuShellApi } from "@/types/eimu-shell";

/**
 * 侦测是否跑在 Eimu 桌面壳内（＝外壳以 contextBridge 注入了 `window.eimuShell`）。
 *
 * 普通浏览器（含 PWA）恒回 null。判定放 useEffect：SSR／首帧一律 null，避免
 * hydration 不一致（首帧就依作业系统注入与否分歧会炸）。
 *
 * Navbar 与 WindowControls 共用同一个真相来源（单一判定，不各写一份）。
 */
export function useEimuShell(): EimuShellApi | null {
  const [shell, setShell] = useState<EimuShellApi | null>(null);
  useEffect(() => {
    setShell(window.eimuShell ?? null);
  }, []);
  return shell;
}
