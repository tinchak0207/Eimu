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
 * 现况：Linux 0.3.4、Windows 0.3.3。Linux 于 2026-10-11 以 AppImage 形态重发（见下 linux 段
 * 注释）；Windows 仍是 0.3.3 旧壳，重打包待办。两平台 2026-10-04 同批发行的「壳内不再显示任何
 * 下载入口（改由 DesktopDownloadButton 在 window.eimuShell 存在时自我隐藏）」与「Windows 安装器
 * 品牌化 assisted 精灵（自绘侧栏／中文文案／无原生安装模式页）」等改动仍在。
 *
 * 托管（2026-10-05 迁移）：产物不再放 Vercel Blob——原 store `GFy3GwthV6OA8bB7` 被
 * 平台封锁（每条 URL 均 403 `Your store is blocked`），发行档改由自家 nginx 直发于
 * `https://store.tinchak0207.xyz/downloads/desktop/`（宿主目录
 * `/opt/imagesite/nginx/downloads/desktop`，只读挂进 imagesite-nginx）。同一目录另放
 * `latest.yml`（Windows）与 `latest-linux.yml`，供桌面壳 electron-updater 取 feed。
 *
 * Linux 范式（2026-10-11 换回）：`tar.gz` → `AppImage`。10-05 曾把 Linux 换成 tar.gz（「解压即可跑、
 * 不必先补 libfuse2」），代价当场记下却没补：electron-updater 在 Linux 只认 AppImage／deb／rpm，
 * 没有 tar.gz updater ⇒ tar.gz 形态的 Linux 壳**永远不会被自己更新**（0.3.3 起 Linux 自动更新静默失效），
 * 每修一轮桥都只能靠使用者手动重抓。发行形态必须与实际能自我替换的更新器一致，故换回 AppImage
 * （`chmod +x` 后直接执行；要免 fuse 可 `--appimage-extract`）。
 * 已装出去的 0.3.3 壳的 `app-update.yml` 是**烧在壳内**的（指向 Vercel Blob `GFy3GwthV6OA8bB7`，
 * 远端改不了），故同一份 AppImage＋feed 也发到该旧 feed 一次让它自己跨过来；跨过来之后新壳的
 * 内建 feed 已指向本 VPS，后续更新不再经过 Blob。
 */
export const DESKTOP_RELEASES = {
  // 已存在的最新版本（＝两平台目前较新者），非两平台共用版号。
  version: "0.3.4",
  linux: {
    // 该平台产物版本：0.3.4。同一份 0.3.4 应用（含最低权限档语义变更「读取预设允许、写入询问」
    // ＋装置票修复 `sk-dev-`：网页换票 → 窄 IPC → 壳当 Bearer；授权根落盘）于 2026-10-11 由
    // `dist-034/linux-unpacked` 以 electron-builder AppImage target 重装成可自我更新的形态。
    // size/sha256 为上传后实测值；feed（本目录 `latest-linux.yml`）逐字与之对帐。
    // 执行方式：`chmod +x` 后直接跑（要免 libfuse2 可 `--appimage-extract`）。
    version: "0.3.4",
    url: "https://store.tinchak0207.xyz/downloads/desktop/Eimu-0.3.4-linux-x86_64.AppImage",
    size: 125982445,
    ext: "AppImage",
    sha256: "f60ffa079393ab1a3b5b292d1477ea5836a9a9562ed08327392d7f028c890c49",
  },
  windows: {
    // 该平台产物版本：0.3.3，于 2026-10-04 同批重建并上传（2026-10-05 原档原样迁到 VPS，
    // 位元组未变，故 sha256 不变）。
    version: "0.3.3",
    url: "https://store.tinchak0207.xyz/downloads/desktop/Eimu-0.3.3-windows-x64-setup.exe",
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
