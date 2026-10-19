import assert from "node:assert/strict";
import test from "node:test";

import { DESKTOP_RELEASES, detectDesktopPlatform, resolveDesktopDownload } from "./desktop-releases.ts";

/** 发布档托管在自家 nginx 的 desktop/ 目录（2026-10-05 起由 Vercel Blob 迁出），且必须是 https。 */
const RELEASE_HOST = "store.tinchak0207.xyz";

test("desktop releases expose a non-empty version string", () => {
  assert.equal(typeof DESKTOP_RELEASES.version, "string");
  assert.ok(DESKTOP_RELEASES.version.trim().length > 0, "version 不可为空");
});

test("desktop releases pin each platform to its own real version", () => {
  // 版本语义逐平台：Linux 0.3.5、Windows 0.3.3（top-level 只是较新者标记）。
  assert.equal(DESKTOP_RELEASES.version, "0.3.5");
  assert.equal(DESKTOP_RELEASES.linux.version, "0.3.5", "linux version");
  assert.equal(DESKTOP_RELEASES.windows.version, "0.3.3", "windows version");
  for (const key of ["linux", "windows"] as const) {
    assert.match(DESKTOP_RELEASES[key].url, new RegExp(`Eimu-${DESKTOP_RELEASES[key].version.replace(/\./g, "\\.")}`), `${key} url 必须含该平台版本`);
  }
});

test("each platform URL pins its own versioned artifact", () => {
  for (const key of ["linux", "windows"] as const) {
    const release = DESKTOP_RELEASES[key];
    assert.equal(typeof release.version, "string", `${key} version 必须是字串`);
    assert.ok(release.version.trim().length > 0, `${key} version 不可为空`);
    // 档名必须带「该平台自己的」版本，而非任何写死或他平台的版本。
    const escaped = release.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(release.url, new RegExp(`Eimu-${escaped}`), `${key} url 必须含 Eimu-${release.version}`);
    const filename = release.url.split("/").pop() ?? "";
    assert.ok(
      filename.includes(release.version),
      `${key} 档名必须含该平台 version（${release.version}）`,
    );
  }
});

test("linux and windows release URLs are https, on the desktop/ path, and versioned", () => {
  for (const key of ["linux", "windows"] as const) {
    const release = DESKTOP_RELEASES[key];
    assert.equal(typeof release.url, "string");
    const url = new URL(release.url);
    assert.equal(url.protocol, "https:", `${key} 必须是 https`);
    assert.equal(url.hostname, RELEASE_HOST, `${key} 必须在发行主机`);
    assert.ok(url.pathname.includes("/desktop/"), `${key} pathname 必须含 /desktop/ 目录`);
    const filename = url.pathname.split("/").pop() ?? "";
    assert.ok(filename.includes(release.version), `${key} 档名必须含该平台 version（${release.version}）`);
    assert.doesNotMatch(release.url, /^http:\/\//, "不得使用明文 http");
  }
});

test("linux and windows artifacts carry real integrity metadata", () => {
  for (const key of ["linux", "windows"] as const) {
    const { size, sha256 } = DESKTOP_RELEASES[key];
    assert.equal(typeof size, "number", `${key} size 必须是数字`);
    assert.ok(Number.isInteger(size) && size > 0, `${key} size 必须是正整数位元组数`);
    assert.equal(typeof sha256, "string", `${key} sha256 必须是字串`);
    assert.match(sha256, /^[0-9a-f]{64}$/, `${key} sha256 必须是 64 位小写十六进位`);
  }
});

test("the two artifacts differ by platform and digest", () => {
  assert.notEqual(DESKTOP_RELEASES.linux.url, DESKTOP_RELEASES.windows.url);
  assert.notEqual(DESKTOP_RELEASES.linux.sha256, DESKTOP_RELEASES.windows.sha256);
  assert.equal(DESKTOP_RELEASES.linux.ext, "AppImage");
  assert.equal(DESKTOP_RELEASES.windows.ext, "exe");
});

test("detectDesktopPlatform: Android is never labelled linux", () => {
  assert.notEqual(
    detectDesktopPlatform(
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
    ),
    "linux",
  );
  assert.equal(
    detectDesktopPlatform("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36"),
    "unknown",
  );
});

test("detectDesktopPlatform: windows, mac and generic linux", () => {
  assert.equal(
    detectDesktopPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"),
    "windows",
  );
  assert.equal(
    detectDesktopPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15"),
    "mac",
  );
  assert.equal(
    detectDesktopPlatform("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"),
    "linux",
  );
  // iPadOS 伪装成 Macintosh，仍须判为 mac（用来显示「当前设备」小标）。
  assert.equal(
    detectDesktopPlatform("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15"),
    "mac",
  );
});

test("resolveDesktopDownload: Linux UA gets the AppImage download", () => {
  const result = resolveDesktopDownload(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  );
  assert.equal(result.ok, true);
  assert.equal(result.platform, "linux");
  assert.equal(result.ok && result.url, DESKTOP_RELEASES.linux.url);
  assert.equal(result.ok && result.ext, "AppImage");
  assert.equal(result.ok && result.label, "Linux");
});

test("resolveDesktopDownload: Windows UA gets the NSIS installer download", () => {
  const result = resolveDesktopDownload(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  );
  assert.equal(result.ok, true);
  assert.equal(result.platform, "windows");
  assert.equal(result.ok && result.url, DESKTOP_RELEASES.windows.url);
  assert.equal(result.ok && result.ext, "exe");
  assert.equal(result.ok && result.label, "Windows");
});

test("resolveDesktopDownload: macOS has no artifact → web-only refusal", () => {
  const result = resolveDesktopDownload(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.platform, "mac");
  assert.equal(!result.ok && result.reason, "mac-web-only");
});

test("resolveDesktopDownload: Android is unknown (no desktop artifact)", () => {
  const result = resolveDesktopDownload(
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.platform, "unknown");
  assert.equal(!result.ok && result.reason, "unknown");
});

test("resolveDesktopDownload: iPad collapses to mac", () => {
  const result = resolveDesktopDownload(
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.platform, "mac");
  assert.equal(!result.ok && result.reason, "mac-web-only");
});
