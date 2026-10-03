/**
 * Eimu 桌面版發佈清單（單一真源）。
 *
 * header 的「下載桌面版」選單只從這裡取 URL／版本，元件裡不得再抄第二份網址。
 * `size` / `sha256` 是上傳後實測值（Windows 由 VM 打包實測補上）；未來若某平台尚未
 * 上傳，欄位可退回 null，UI 只顯示檔名與副檔名、不編造大小。
 *
 * 版本語義＝**逐平台**：`linux.version`／`windows.version` 是「該平台產物自身」的版本，
 * 兩平台可以不同（不同平台的打包時程／機器受限，不強制同步）。top-level `version`
 * 只是「已存在的最新版本」的標記，供外部標註與排序，**不是**兩平台共用版號。
 *
 * 現況：Linux 與 Windows 皆已重建為 0.3.2（含本輪本地能力與安全修補），同步上傳。
 */
export const DESKTOP_RELEASES = {
  // 已存在的最新版本（＝兩平台目前較新者），非兩平台共用版號。
  version: "0.3.2",
  linux: {
    // 該平台產物版本：0.3.2，於 2026-10-04 重建並上傳（下載回本地逐位元組對帳一致）。
    version: "0.3.2",
    url: "https://gfy3gwthv6oa8bb7.public.blob.vercel-storage.com/desktop/Eimu-0.3.2-linux-x86_64.AppImage",
    size: 125953601,
    ext: "AppImage",
    sha256: "fd6bcff68ded3b52f372adde0bc6c6b7a3e8f60dc884037038d62bbaa8849fb2",
  },
  windows: {
    // 該平台產物版本：0.3.2，於 2026-10-04 同批重建並上傳。
    version: "0.3.2",
    url: "https://gfy3gwthv6oa8bb7.public.blob.vercel-storage.com/desktop/Eimu-0.3.2-windows-x64-setup.exe",
    size: 112069345,
    ext: "exe",
    sha256: "61533498832c6c31e33f57b3fe0596b312ea1fcdec481a94446348e5c67afdaa",
  },
} as const;

/** 桌面作業系統判定結果。無法辨識（含 Android、行動裝置以外的怪 UA）回 "unknown"。 */
export type DesktopPlatform = "linux" | "windows" | "mac" | "unknown";

/**
 * 由 User-Agent 判斷使用者當前桌面平台（純函式，可測）。
 *
 * 順序是硬性約定：
 * 1. Android 必須最先排除——Android 的 UA 同時含 "Linux" 與 "Android"，
 *    先判 Linux 會把手機誤標成「当前设备（Linux）」，而手機根本裝不了桌面版。
 * 2. Mac|iPhone|iPad → mac（iPadOS 的 UA 偽裝成 Macintosh）。
 * 3. Win → windows。
 * 4. 其餘含 Linux/X11/CrOS → linux。
 */
export function detectDesktopPlatform(userAgent: string): DesktopPlatform {
  const ua = typeof userAgent === "string" ? userAgent : "";
  if (/Android/i.test(ua)) return "unknown";
  if (/Mac|iPhone|iPad/i.test(ua)) return "mac";
  if (/Win/i.test(ua)) return "windows";
  if (/Linux|X11|CrOS/i.test(ua)) return "linux";
  return "unknown";
}

/** 平台縮寫（顯示名），hero 鈕文字「下载 {label} 客户端」用。 */
const DESKTOP_PLATFORM_LABELS: Record<"linux" | "windows", string> = {
  linux: "Linux",
  windows: "Windows",
};

/**
 * 一鍵下載的解析結果（header icon 鈕與宣傳片結尾 hero 鈕共用同一份判斷）。
 *
 * - `ok:true`：有對應產物，直接下載 `url`（`label`／`ext` 給 hero 文字用）。
 * - `mac`：無 macOS 產物，只能走網頁版 → 禮貌 toast。
 * - `unknown`（Android／怪 UA）：hero 不渲染，icon 維持既有斷點。
 *
 * 純函式，包 `detectDesktopPlatform`，供兩處元件共用，不得在元件內另寫一份。
 */
export type DesktopDownload =
  | { ok: true; platform: "linux" | "windows"; url: string; label: string; ext: string }
  | { ok: false; platform: "mac" | "unknown"; reason: "mac-web-only" | "unknown" };

export function resolveDesktopDownload(userAgent: string): DesktopDownload {
  const platform = detectDesktopPlatform(userAgent);
  if (platform === "linux" || platform === "windows") {
    const release = DESKTOP_RELEASES[platform];
    return {
      ok: true,
      platform,
      url: release.url,
      label: DESKTOP_PLATFORM_LABELS[platform],
      ext: release.ext,
    };
  }
  if (platform === "mac") {
    return { ok: false, platform: "mac", reason: "mac-web-only" };
  }
  return { ok: false, platform: "unknown", reason: "unknown" };
}
