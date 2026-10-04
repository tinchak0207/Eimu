/**
 * Eimu 桌面版发布清单（单一真源）。
 *
 * header 的「下载桌面版」选单只从这里取 URL／版本，元件里不得再抄第二份网址。
 * `size` / `sha256` 是上传后实测值（Windows 由 VM 打包实测补上）；未来若某平台尚未
 * 上传，栏位可退回 null，UI 只显示档名与副档名、不编造大小。
 *
 * 版本语义＝**逐平台**：`linux.version`／`windows.version` 是「该平台产物自身」的版本，
 * 两平台可以不同（不同平台的打包时程／机器受限，不强制同步）。top-level `version`
 * 只是「已存在的最新版本」的标记，供外部标注与排序，**不是**两平台共用版号。
 *
 * 现况：两平台皆 0.3.3，2026-10-04 同批发行（Linux 含网页端「壳内不再显示任何下载
 * 入口」的改动，下载入口改由 DesktopDownloadButton 在 window.eimuShell 存在时自我隐藏）。
 * Windows 安装器已改成品牌化 assisted 精灵（自绘侧栏／中文文案／无原生安装模式页）。
 */
export const DESKTOP_RELEASES = {
  // 已存在的最新版本（＝两平台目前较新者），非两平台共用版号。
  version: "0.3.3",
  linux: {
    // 该平台产物版本：0.3.3，于 2026-10-04 重建并上传（下载回本地逐位元组对帐一致）。
    version: "0.3.3",
    url: "https://gfy3gwthv6oa8bb7.public.blob.vercel-storage.com/desktop/Eimu-0.3.3-linux-x86_64.AppImage",
    size: 125978340,
    ext: "AppImage",
    sha256: "b635f08a7342e5a920cb48ba02c948219b3b0fea05493863060a4fe545c31597",
  },
  windows: {
    // 该平台产物版本：0.3.3，于 2026-10-04 同批重建并上传。
    version: "0.3.3",
    url: "https://gfy3gwthv6oa8bb7.public.blob.vercel-storage.com/desktop/Eimu-0.3.3-windows-x64-setup.exe",
    size: 112182968,
    ext: "exe",
    sha256: "13694addaa85dd8f39017c95c682d58afe4d5e430bec8838a90b5720b3aebe3e",
  },
} as const;

/** 桌面作业系统判定结果。无法辨识（含 Android、行动装置以外的怪 UA）回 "unknown"。 */
export type DesktopPlatform = "linux" | "windows" | "mac" | "unknown";

/**
 * 由 User-Agent 判断使用者当前桌面平台（纯函式，可测）。
 *
 * 顺序是硬性约定：
 * 1. Android 必须最先排除——Android 的 UA 同时含 "Linux" 与 "Android"，
 *    先判 Linux 会把手机误标成「当前设备（Linux）」，而手机根本装不了桌面版。
 * 2. Mac|iPhone|iPad → mac（iPadOS 的 UA 伪装成 Macintosh）。
 * 3. Win → windows。
 * 4. 其余含 Linux/X11/CrOS → linux。
 */
export function detectDesktopPlatform(userAgent: string): DesktopPlatform {
  const ua = typeof userAgent === "string" ? userAgent : "";
  if (/Android/i.test(ua)) return "unknown";
  if (/Mac|iPhone|iPad/i.test(ua)) return "mac";
  if (/Win/i.test(ua)) return "windows";
  if (/Linux|X11|CrOS/i.test(ua)) return "linux";
  return "unknown";
}

/** 平台缩写（显示名），hero 钮文字「下载 {label} 客户端」用。 */
const DESKTOP_PLATFORM_LABELS: Record<"linux" | "windows", string> = {
  linux: "Linux",
  windows: "Windows",
};

/**
 * 一键下载的解析结果（header icon 钮与宣传片结尾 hero 钮共用同一份判断）。
 *
 * - `ok:true`：有对应产物，直接下载 `url`（`label`／`ext` 给 hero 文字用）。
 * - `mac`：无 macOS 产物，只能走网页版 → 礼貌 toast。
 * - `unknown`（Android／怪 UA）：hero 不渲染，icon 维持既有断点。
 *
 * 纯函式，包 `detectDesktopPlatform`，供两处元件共用，不得在元件内另写一份。
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
