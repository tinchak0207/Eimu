import test from "node:test";
import assert from "node:assert/strict";

import { DESKTOP_RELEASES } from "./desktop-releases";
import {
  compareVersions,
  isShellOutdated,
  isShellOutdatedForPlatform,
  parseShellVersion,
} from "./shell-version";

// 執行器限定 `npx --yes tsx --test`（repo 的 npm test 走它）。

// 實測真殼 UA（2026-10-04 從暴君機器取得）。
const REAL_LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Eimu/0.3.0 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36";

const WINDOWS_SHELL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Eimu/0.3.0 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36";

const PLAIN_CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36";

test("parseShellVersion 抓真殼 UA 的 Eimu/<x.y.z>", () => {
  assert.equal(parseShellVersion(REAL_LINUX_UA), "0.3.0");
  assert.equal(parseShellVersion(WINDOWS_SHELL_UA), "0.3.0");
  assert.equal(parseShellVersion("Mozilla/5.0 Eimu/0.1.0"), "0.1.0");
  // token 大小寫不拘、可帶後綴。
  assert.equal(parseShellVersion("eimu/1.2.3-beta.1 Surface"), "1.2.3-beta.1");
});

test("非殼 UA（純瀏覽器）→ parseShellVersion null、isShellOutdated 不落後", () => {
  assert.equal(parseShellVersion(PLAIN_CHROME_UA), null);
  assert.equal(parseShellVersion(""), null);
  assert.deepEqual(isShellOutdated(PLAIN_CHROME_UA, "0.3.2"), {
    shellVersion: null,
    outdated: false,
  });
});

test("真實 Linux 殼 0.3.0：對 0.3.0 不落後、對 0.3.2 落後", () => {
  assert.deepEqual(isShellOutdated(REAL_LINUX_UA, "0.3.0"), {
    shellVersion: "0.3.0",
    outdated: false,
  });
  assert.deepEqual(isShellOutdated(REAL_LINUX_UA, "0.3.2"), {
    shellVersion: "0.3.0",
    outdated: true,
  });
  // 比最新新（未來版本）也不落後。
  assert.equal(isShellOutdated(REAL_LINUX_UA, "0.3.0").outdated, false);
  assert.equal(isShellOutdated("Eimu/0.3.3 Firefox/152", "0.3.2").outdated, false);
});

test("最舊殼 0.1.0 → 落後於 0.3.2", () => {
  const ua = "Mozilla/5.0 (X11; Linux x86_64) Eimu/0.1.0 Chrome/120.0 Safari/537.36";
  assert.deepEqual(isShellOutdated(ua, "0.3.2"), { shellVersion: "0.1.0", outdated: true });
});

test("Windows 殼（platform 段 Windows NT）同樣可辨識並判定落後", () => {
  assert.equal(parseShellVersion(WINDOWS_SHELL_UA), "0.3.0");
  assert.deepEqual(isShellOutdated(WINDOWS_SHELL_UA, "0.3.2"), {
    shellVersion: "0.3.0",
    outdated: true,
  });
  assert.equal(isShellOutdated(WINDOWS_SHELL_UA, "0.3.0").outdated, false);
});

test("compareVersions 數字段邊界", () => {
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1); // 數值比大小，不是字典序
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2", "1.2.0"), 0); // 缺位補 0
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
});

test("compareVersions 後綴：同號正式版 > 預覽版", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.1"), 1);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0-beta.2"), -1);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0-beta.1"), 0);
  // 帶後綴的 0.3.2 比 0.3.1 仍較新（核心位先決）。
  assert.equal(compareVersions("0.3.2-beta.1", "0.3.1"), 1);
});

// ── 逐平台判定（isShellOutdatedForPlatform）：修「Windows 已最新卻被誤報」的 bug ──

const WIN_SHELL_032 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Eimu/0.3.2 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36";
const WIN_SHELL_030 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Eimu/0.3.0 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36";
const WIN_SHELL_020 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Eimu/0.2.0 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36";
const LINUX_SHELL_032 =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Eimu/0.3.2 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36";
const LINUX_SHELL_031 =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Eimu/0.3.1 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36";
const LINUX_SHELL_030 =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Eimu/0.3.0 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36";
const MAC_SHELL_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Eimu/0.1.0 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36";

test("逐平台：Windows 0.3.2（已是 windows 最新）不落後", () => {
  assert.deepEqual(isShellOutdatedForPlatform(WIN_SHELL_032, DESKTOP_RELEASES), {
    shellVersion: "0.3.2",
    platform: "windows",
    latestVersion: "0.3.2",
    outdated: false,
  });
});

test("逐平台：Windows 0.3.0／0.2.0 落後，latestVersion 取 windows 的 0.3.2（不是他平台）", () => {
  assert.deepEqual(isShellOutdatedForPlatform(WIN_SHELL_030, DESKTOP_RELEASES), {
    shellVersion: "0.3.0",
    platform: "windows",
    latestVersion: "0.3.2",
    outdated: true,
  });
  assert.deepEqual(isShellOutdatedForPlatform(WIN_SHELL_020, DESKTOP_RELEASES), {
    shellVersion: "0.2.0",
    platform: "windows",
    latestVersion: "0.3.2",
    outdated: true,
  });
});

test("逐平台：Linux 0.3.2（已是 linux 最新）不落後", () => {
  assert.deepEqual(isShellOutdatedForPlatform(LINUX_SHELL_032, DESKTOP_RELEASES), {
    shellVersion: "0.3.2",
    platform: "linux",
    latestVersion: "0.3.2",
    outdated: false,
  });
});

test("逐平台：Linux 0.3.1／0.3.0 落後於 linux.version=0.3.2", () => {
  assert.deepEqual(isShellOutdatedForPlatform(LINUX_SHELL_031, DESKTOP_RELEASES), {
    shellVersion: "0.3.1",
    platform: "linux",
    latestVersion: "0.3.2",
    outdated: true,
  });
  assert.deepEqual(isShellOutdatedForPlatform(LINUX_SHELL_030, DESKTOP_RELEASES), {
    shellVersion: "0.3.0",
    platform: "linux",
    latestVersion: "0.3.2",
    outdated: true,
  });
});

test("逐平台：純瀏覽器 UA → 不動作（platform/shellVersion 全 null）", () => {
  assert.deepEqual(isShellOutdatedForPlatform(PLAIN_CHROME_UA, DESKTOP_RELEASES), {
    shellVersion: null,
    platform: null,
    latestVersion: null,
    outdated: false,
  });
});

test("逐平台：mac（無產物）→ 不提示；判不出平台一律不提示", () => {
  const mac = isShellOutdatedForPlatform(MAC_SHELL_UA, DESKTOP_RELEASES);
  assert.equal(mac.shellVersion, "0.1.0");
  assert.equal(mac.platform, null);
  assert.equal(mac.outdated, false);
  // 怪 UA（無平台關鍵字）即使帶 Eimu/ 也不提示。
  assert.equal(isShellOutdatedForPlatform("Eimu/0.1.0 Something/1.0", DESKTOP_RELEASES).outdated, false);
});

test("逐平台：該平台條目缺 version／整表缺平台 → 不提示（寧可不提示）", () => {
  const win = isShellOutdatedForPlatform(WIN_SHELL_020, {
    linux: { version: "0.3.2" },
  });
  assert.equal(win.platform, "windows");
  assert.equal(win.latestVersion, null);
  assert.equal(win.outdated, false);

  const noVersion = isShellOutdatedForPlatform(WIN_SHELL_020, { windows: {} });
  assert.equal(noVersion.latestVersion, null);
  assert.equal(noVersion.outdated, false);

  const empty = isShellOutdatedForPlatform(LINUX_SHELL_030, {});
  assert.equal(empty.outdated, false);
});

test("逐平台：與 isShellOutdated 語義差＝平台基準（獨立表驗證不比錯基準）", () => {
  // 顯式獨立表：top-level 標 0.9.9、windows 仍是 0.3.0。舊入口拿 top-level 會誤報 true，
  // 新入口拿 windows 0.3.0 判為不落後 → 證明比的是「該平台」基準，不是 top-level。
  const table = { version: "0.9.9", windows: { version: "0.3.0" } };
  assert.equal(isShellOutdated(WIN_SHELL_030, table.version).outdated, true);
  assert.equal(isShellOutdatedForPlatform(WIN_SHELL_030, table).outdated, false);
  // 顯式獨立表：windows 0.9.9 時 0.3.0 應落後，證明比的是傳入表、不是寫死。
  assert.equal(
    isShellOutdatedForPlatform(WIN_SHELL_030, { windows: { version: "0.9.9" } }).outdated,
    true,
  );
  assert.equal(
    isShellOutdatedForPlatform(LINUX_SHELL_030, { linux: { version: "0.3.2" } }).outdated,
    true,
  );
});
