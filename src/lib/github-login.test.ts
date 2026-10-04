import test from "node:test";
import assert from "node:assert/strict";

import { isStandalonePwa } from "./github-login.ts";

/**
 * 桌面壳登入路径（2026-09-17 暴君实测回报）。
 *
 * Electron 壳的 storage 与使用者常用浏览器隔离，且视窗没有网址栏：GitHub
 * 授权页若开在 App 内，使用者无从确认自己站在哪个站上，也用不到浏览器既有
 * 的登入态。因此 standalone 侦测必须把 Electron 壳一并判为「需走跨浏览器
 * 交接」，否则登入入口会走同视窗跳转，授权页直接被开进 App。
 *
 * 这里用真实呼叫验证，不靠源码字串断言：此函式的三个判据（media query、
 * iOS navigator.standalone、UA）都是执行期读取的全域值，可精确桩掉。
 */

type Stub = {
  /** window.matchMedia("(display-mode: standalone)").matches */
  standaloneMedia?: boolean;
  /** iOS Safari 的 navigator.standalone */
  iosStandalone?: boolean;
  userAgent?: string;
  /** 是否提供 window（undefined = 模拟 SSR，无 window） */
  hasWindow?: boolean;
  hasMatchMedia?: boolean;
};

function detect(stub: Stub): boolean {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const savedWindow = (globalThis as { window?: unknown }).window;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  const hasWindow = stub.hasWindow ?? true;
  const hasMatchMedia = stub.hasMatchMedia ?? true;

  if (hasWindow) {
    (globalThis as { window?: unknown }).window = hasMatchMedia
      ? { matchMedia: () => ({ matches: stub.standaloneMedia === true }) }
      : {};
  } else {
    delete (globalThis as { window?: unknown }).window;
  }

  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: stub.userAgent ?? "", standalone: stub.iosStandalone === true },
    configurable: true,
    writable: true,
  });

  try {
    return isStandalonePwa();
  } finally {
    if (hadWindow) {
      (globalThis as { window?: unknown }).window = savedWindow;
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    }
  }
}

const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
  + "Eimu/0.1.0 Chrome/140.0.7339.249 Electron/38.8.6 Safari/537.36";
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
  + "Chrome/140.0.0.0 Safari/537.36";

test("Electron 壳被判为需走跨浏览器交接", () => {
  // 壳内：display-mode 是 browser（非 standalone），仅 UA 带 Electron。
  assert.equal(detect({ userAgent: DESKTOP_UA, standaloneMedia: false }), true);
});

test("普通浏览器不受影响（仍走原本的同视窗 OAuth）", () => {
  assert.equal(detect({ userAgent: CHROME_UA, standaloneMedia: false }), false);
});

test("PWA standalone 仍被判为需交接（既有行为不回归）", () => {
  assert.equal(detect({ userAgent: CHROME_UA, standaloneMedia: true }), true);
});

test("iOS Safari 加到主画面仍被判为需交接", () => {
  assert.equal(detect({ userAgent: CHROME_UA, iosStandalone: true }), true);
});

test("UA 含 Electron 子字串的其他嵌入环境也走交接（语义正确：同样是隔离 storage）", () => {
  // Discord/Slack/VS Code 这类 Electron 应用内嵌网页时 UA 同样带 Electron；
  // 它们与 PWA 面对同一个问题（storage 隔离、popup 死窗），走交接是正确解。
  const embedded = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) SomeApp/1.0 Chrome/126.0.0.0 Electron/31.0.0 Safari/537.36";
  assert.equal(detect({ userAgent: embedded, standaloneMedia: false }), true);
});

test("无 window 的 SSR 环境回 false，不抛错", () => {
  assert.equal(detect({ userAgent: DESKTOP_UA, hasWindow: false }), false);
});

test("window 存在但缺 matchMedia 时不抛错（依赖 UA 判定）", () => {
  assert.equal(detect({ userAgent: DESKTOP_UA, hasMatchMedia: false }), true);
  assert.equal(detect({ userAgent: CHROME_UA, hasMatchMedia: false }), false);
});
