/**
 * Eimu 桌面版發佈清單（單一真源）。
 *
 * header 的「下載桌面版」選單只從這裡取 URL／版本，元件裡不得再抄第二份網址。
 * `size` / `sha256` 是上傳後實測值（Windows 由 VM 打包實測補上）；未來若某平台尚未
 * 上傳，欄位可退回 null，UI 只顯示檔名與副檔名、不編造大小。
 */
export const DESKTOP_RELEASES = {
  version: "0.3.0",
  linux: {
    url: "https://gfy3gwthv6oa8bb7.public.blob.vercel-storage.com/desktop/Eimu-0.3.0-linux-x86_64.AppImage",
    size: 125449297,
    ext: "AppImage",
    sha256: "d01c68ac6103117f3ccaf1fbc71f69a27288d2a276c405448150102ca85faa42",
  },
  windows: {
    url: "https://gfy3gwthv6oa8bb7.public.blob.vercel-storage.com/desktop/Eimu-0.3.0-windows-x64-setup.exe",
    size: 111809843,
    ext: "exe",
    sha256: "af2b4e3888caa07403f0bf80193977cb1c9b80d83ceb32ecd5781d03d62b0426",
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
