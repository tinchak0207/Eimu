/**
 * 桌面殼版本解析與新舊判定（純函式，可測；無第三方依賴；平台判定複用
 * `desktop-releases` 的 `detectDesktopPlatform`，不另抄一份 UA 平台規則）。
 *
 * 背景：Eimu 桌面殼是薄殼，開機 `loadURL("https://www.eimu.dev")`。殼的 User-Agent
 * 會帶上 product token `Eimu/<version>`（實測：
 * `Mozilla/5.0 (X11; Linux x86_64) … Eimu/0.3.0 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36`）。
 * 0.1.0／0.2.0 舊殼沒有 `window.eimuShell`，網頁端無法用注入物件辨識，只能靠 UA 這條
 * product token 才知道使用者在跑哪個版本的殼；本篇即為該判定的單一真源。
 *
 * 判定放元件 `useEffect`（SSR 沒有 navigator），本檔只提供純函式。
 */

import { detectDesktopPlatform } from "./desktop-releases";

/**
 * 從 User-Agent 抓 `Eimu/<x.y.z>`（可帶 `-beta.1` 之類後綴）的版本字串。
 *
 * - token 比對：`Eimu/` 大小寫不拘，位置不限（前綴可為行首或空白/括號分隔），
 *   不寫死整串 UA，避免 Chrome/Electron 段變動就失效。
 * - 非殼（找不到 token）或不合法輸入 → null。
 */
export function parseShellVersion(userAgent: string): string | null {
  if (typeof userAgent !== "string" || userAgent.length === 0) return null;
  const match = userAgent.match(/(?:^|[\s(])Eimu\/([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/i);
  return match ? match[1] : null;
}

interface ParsedVersion {
  core: number[];
  /** 後綴識別碼（`-` 之後以 `.` 切開）；無後綴為 null（＝正式版）。 */
  pre: string[] | null;
}

/** 解析 `v1.2.3` / `1.2.3-beta.1` 形式的版本；不合法回 null。 */
function parseVersion(input: string): ParsedVersion | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().replace(/^v/i, "");
  const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)*)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  const core = match[1].split(".").map((part) => Number(part));
  if (core.some((n) => !Number.isFinite(n))) return null;
  const pre = match[2] ? match[2].split(".") : null;
  return { core, pre };
}

/** 比較兩個後綴識別碼：數字段依大小、英數段依字典序（數字恆小於英數，semver 規則）。 */
function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1; // 較短的後綴較舊
    if (y === undefined) return 1;
    const xNum = /^[0-9]+$/.test(x);
    const yNum = /^[0-9]+$/.test(y);
    if (xNum && yNum) {
      const nx = Number(x);
      const ny = Number(y);
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1; // 數字段優先序低於英數段
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 版本比較：`a < b` 回 -1、`a === b` 回 0、`a > b` 回 1。
 *
 * - 支援 `1.2.3` 與 `1.2.3-beta.1`；同號時「有後綴者 < 無後綴者」（正式版較新）。
 * - 段數不同時缺位補 0（`1.2` 等於 `1.2.0`）。
 * - 無法解析者視為最低（不拋錯，純函式保持 total）；兩者皆無法解析回 0。
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va && !vb) return 0;
  if (!va) return -1;
  if (!vb) return 1;

  const coreLen = Math.max(va.core.length, vb.core.length);
  for (let i = 0; i < coreLen; i += 1) {
    const x = va.core[i] ?? 0;
    const y = vb.core[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }

  if (va.pre && !vb.pre) return -1;
  if (!va.pre && vb.pre) return 1;
  if (va.pre && vb.pre) return comparePrerelease(va.pre, vb.pre);
  return 0;
}

export interface ShellOutdatedResult {
  /** UA 中的殼版本；非殼為 null。 */
  shellVersion: string | null;
  /** 是否比 latestVersion 舊。非殼一律 false。 */
  outdated: boolean;
}

/**
 * 判定目前 UA 的桌面殼是否落後於給定最新版。
 *
 * 非殼（UA 無 `Eimu/`）→ `{ shellVersion: null, outdated: false }`，普通瀏覽器
 * （含 PWA）一律不動作。latestVersion 需由呼叫端傳入（前端用 `DESKTOP_RELEASES.version`）。
 */
export function isShellOutdated(userAgent: string, latestVersion: string): ShellOutdatedResult {
  const shellVersion = parseShellVersion(userAgent);
  if (!shellVersion) return { shellVersion: null, outdated: false };
  return { shellVersion, outdated: compareVersions(shellVersion, latestVersion) < 0 };
}

/** 有平台級發佈產物、可提示更新的桌面平台（mac／Android 等不在其列）。 */
export type ShellPlatform = "linux" | "windows";

/** 逐平台發佈條目：判定只需 `version`（結構兼容 `DESKTOP_RELEASES[platform]`）。 */
export interface ShellPlatformRelease {
  version?: string | null;
}

/** 逐平台發佈表（結構兼容 `DESKTOP_RELEASES`）。 */
export interface ShellReleaseTable {
  linux?: ShellPlatformRelease;
  windows?: ShellPlatformRelease;
}

export interface ShellPlatformOutdatedResult {
  /** UA 中的殼版本；非殼為 null。 */
  shellVersion: string | null;
  /** 由 UA 判定的平台；非 Windows／Linux 或判不出為 null。 */
  platform: ShellPlatform | null;
  /** 該平台在發佈表中的最新版；查不到為 null。 */
  latestVersion: string | null;
  /** 殼版本是否落後於「該平台」最新版。任一環節無法判定一律 false（寧可不提示）。 */
  outdated: boolean;
}

/**
 * 逐平台判定殼是否落後（`ShellUpdatePrompt` 專用入口）。
 *
 * 為何需要：`DESKTOP_RELEASES` 的版本是**逐平台**的（兩平台可各自獨立，另有 top-level
 * `version`）。拿 top-level 版號去比會把「已是最新 Windows 版」誤報成落後，按下載卻只
 * 拿到同一版 ⇒ 欺騙使用者。
 *
 * 規則（寧可不提示，也不要誤報）：
 * - 非殼（UA 無 `Eimu/`）→ 全 null／false，普通瀏覽器（含 PWA）一律不動作。
 * - 平台非 Windows／Linux（含 mac、Android、怪 UA）→ 不判定（`platform: null`）。
 * - 該平台在 `releases` 無條目或缺 `version` → 不提示（`latestVersion: null`、`outdated: false`）。
 * - 有平台版號才比對「殼版本」與「該平台版本」。
 */
export function isShellOutdatedForPlatform(
  userAgent: string,
  releases: ShellReleaseTable,
): ShellPlatformOutdatedResult {
  const shellVersion = parseShellVersion(userAgent);
  if (!shellVersion) {
    return { shellVersion: null, platform: null, latestVersion: null, outdated: false };
  }

  const detected = detectDesktopPlatform(userAgent);
  if (detected !== "linux" && detected !== "windows") {
    return { shellVersion, platform: null, latestVersion: null, outdated: false };
  }

  const latestVersion = releases[detected]?.version ?? null;
  if (!latestVersion) {
    return { shellVersion, platform: detected, latestVersion: null, outdated: false };
  }

  return {
    shellVersion,
    platform: detected,
    latestVersion,
    outdated: compareVersions(shellVersion, latestVersion) < 0,
  };
}
