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
 * 现况：Linux 0.3.4、Windows 0.3.3。Linux 于 2026-10-05 重打为 0.3.4（见下 linux 段注释）；
 * Windows 仍是 0.3.3 旧壳，重打包待办。两平台 2026-10-04 同批发行的「壳内不再显示任何下载
 * 入口（改由 DesktopDownloadButton 在 window.eimuShell 存在时自我隐藏）」与「Windows 安装器
 * 品牌化 assisted 精灵（自绘侧栏／中文文案／无原生安装模式页）」等改动仍在。
 *
 * 托管（2026-10-05 迁移）：产物不再放 Vercel Blob——原 store `GFy3GwthV6OA8bB7` 被
 * 平台封锁（每条 URL 均 403 `Your store is blocked`），发行档改由自家 nginx 直发于
 * `https://store.tinchak0207.xyz/downloads/desktop/`（宿主目录
 * `/opt/imagesite/nginx/downloads/desktop`，只读挂进 imagesite-nginx）。同一目录另放
 * `latest.yml`（Windows）与 `latest-linux.yml`，供桌面壳 electron-updater 取 feed。
 *
 * Linux 范式（2026-10-05 换）：`AppImage` → `tar.gz`。AppImage 在多数现代发行版要先补
 * libfuse2（或 `--appimage-extract`）才能执行，解压即可跑的 tar.gz 更直接。归档顶层目录
 * 名＝档名去后缀（`Eimu-0.3.4-linux-x86_64/`），内容＝electron-builder 的 `linux-unpacked`
 * （即 `tar` target 的既有范式，未自创结构）。**顶层目录必须是这个具名目录，不能是 `.`**：
 * 早一版用 `tar -C linux-unpacked .` 打出裸 `./` 根条目，解压时会把「解压目标目录」本身
 * chmod 成 755——`tar xzf … -C ~` 会把使用者家目录（常见 700）改掉。现已重打并实测
 * 700 的目标目录解压后仍是 700。
 */
export const DESKTOP_RELEASES = {
  // 已存在的最新版本（＝两平台目前较新者），非两平台共用版号。
  version: "0.3.4",
  linux: {
    // 该平台产物版本：0.3.4。2026-10-05 重打为 0.3.4：含最低权限档语义变更（读取预设允许、
    // 写入询问）＋装置票修复（`sk-dev-` 短效票：网页换票 → 窄 IPC → 壳当 Bearer；授权根落盘）。
    // size/sha256 为上传后实测值。
    // 解压后执行档名是 `eimu-desktop`（不是目录名 Eimu），顶层目录 `Eimu-0.3.4-linux-x86_64/`。
    version: "0.3.4",
    url: "https://store.tinchak0207.xyz/downloads/desktop/Eimu-0.3.4-linux-x86_64.tar.gz",
    size: 119677139,
    ext: "tar.gz",
    sha256: "de5c6a328a207d004d3a3e8ab0bbe71acbde038ab0dfd01b3619dacd59f39c86",
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
