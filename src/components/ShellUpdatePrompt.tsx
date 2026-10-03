"use client";

import { useEffect } from "react";

import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { DESKTOP_RELEASES, resolveDesktopDownload } from "@/lib/desktop-releases";
import { isShellOutdatedForPlatform } from "@/lib/shell-version";

/**
 * 舊桌面殼更新提示（掛在 Navbar，全站生效）。
 *
 * 為什麼需要：殼是薄殼，開機 loadURL 網頁；0.1.0/0.2.0 舊殼沒有 `window.eimuShell`，
 * 網頁端偵測不到，也沒有內建更新器——只能靠網頁用 UA 的 `Eimu/<version>` 認版本，
 * 主動提示使用者「去下載新版」。
 *
 * 行為：
 * - 載入後用 `isShellOutdatedForPlatform(navigator.userAgent, DESKTOP_RELEASES)` 判定；
 *   版本是**逐平台**比對（Windows 比 `windows.version`、Linux 比 `linux.version`），
 *   不會拿 top-level `version` 把「已是最新 Windows 版」誤報成落後。非殼（無 `Eimu/`）
 *   一律什麼都不做；平台判不出、或該平台在 DESKTOP_RELEASES 無條目／缺 version 也不提示。
 * - 判定放 useEffect：SSR／首幀不渲染任何東西，避免 hydration 不一致。
 * - 同一殼版本一 session 只提示一次（sessionStorage 記已提示）。
 * - 動作鈕直接開 `resolveDesktopDownload(...)` 的 url（複用桌面版下載真源，不另寫邏輯）。
 *
 * 相容性：新殼（0.3.0+，有 `window.eimuShell`）若落後同樣會提示；本元件不依賴注入物件。
 */
export function ShellUpdatePrompt() {
  const { toast } = useToast();

  useEffect(() => {
    const userAgent = navigator.userAgent;
    // 逐平台比對：latestVersion 是「該平台當前可下載版本」，文案必須指到它，
    // 否則 Windows 0.2.0 會被告知最新是 0.3.1、卻只下載得到 0.3.0。
    const { shellVersion, outdated, latestVersion } = isShellOutdatedForPlatform(
      userAgent,
      DESKTOP_RELEASES,
    );
    if (!outdated || !shellVersion || !latestVersion) return;

    const storageKey = `eimu-shell-update-prompted:${shellVersion}`;
    try {
      if (sessionStorage.getItem(storageKey)) return;
      sessionStorage.setItem(storageKey, "1");
    } catch {
      // sessionStorage 不可用（隱私模式等）：仍提示，只是無法同 session 去重。
    }

    const download = resolveDesktopDownload(userAgent);
    // 延後一個 macrotask 再彈：Navbar 是 Toaster 的前一個兄弟節點，初始 effect 沖刷時
    // ShellUpdatePrompt 會先於 Toaster 註冊 listener 執行，此刻 dispatch 會被丟棄
    // （TOAST_LIMIT 記憶體狀態已寫、但沒有訂閱者重繪）。setTimeout 0 保證 Toaster 已訂閱。
    // 不在 cleanup 清掉它：StrictMode 的「effect→cleanup→effect」第二輪因 storage 已記而
    // 提前 return，本就只會有一個 timer，清掉反而會整個 silent。
    setTimeout(() => {
      toast({
        title: "App 有新版本",
        description: `目前版本 v${shellVersion}，最新 v${latestVersion}。下載新版以取得最新功能。`,
        action: download.ok ? (
          <ToastAction
            altText="下載新版"
            onClick={() => {
              window.location.href = download.url;
            }}
          >
            下載新版
          </ToastAction>
        ) : undefined,
      });
    }, 0);
  }, [toast]);

  return null;
}
