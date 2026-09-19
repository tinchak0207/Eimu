import test from "node:test";
import assert from "node:assert/strict";

import { isStandalonePwa } from "./github-login.ts";

/**
 * 桌面殼登入路徑（2026-09-17 暴君實測回報）。
 *
 * Electron 殼的 storage 與使用者常用瀏覽器隔離，且視窗沒有網址欄：GitHub
 * 授權頁若開在 App 內，使用者無從確認自己站在哪個站上，也用不到瀏覽器既有
 * 的登入態。因此 standalone 偵測必須把 Electron 殼一併判為「需走跨瀏覽器
 * 交接」，否則登入入口會走同視窗跳轉，授權頁直接被開進 App。
 *
 * 這裡用真實呼叫驗證，不靠源碼字串斷言：此函式的三個判據（media query、
 * iOS navigator.standalone、UA）都是執行期讀取的全域值，可精確樁掉。
 */

type Stub = {
  /** window.matchMedia("(display-mode: standalone)").matches */
  standaloneMedia?: boolean;
  /** iOS Safari 的 navigator.standalone */
  iosStandalone?: boolean;
  userAgent?: string;
  /** 是否提供 window（undefined = 模擬 SSR，無 window） */
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

test("Electron 殼被判為需走跨瀏覽器交接", () => {
  // 殼內：display-mode 是 browser（非 standalone），僅 UA 帶 Electron。
  assert.equal(detect({ userAgent: DESKTOP_UA, standaloneMedia: false }), true);
});

test("普通瀏覽器不受影響（仍走原本的同視窗 OAuth）", () => {
  assert.equal(detect({ userAgent: CHROME_UA, standaloneMedia: false }), false);
});

test("PWA standalone 仍被判為需交接（既有行為不回歸）", () => {
  assert.equal(detect({ userAgent: CHROME_UA, standaloneMedia: true }), true);
});

test("iOS Safari 加到主畫面仍被判為需交接", () => {
  assert.equal(detect({ userAgent: CHROME_UA, iosStandalone: true }), true);
});

test("UA 含 Electron 子字串的其他嵌入環境也走交接（語義正確：同樣是隔離 storage）", () => {
  // Discord/Slack/VS Code 這類 Electron 應用內嵌網頁時 UA 同樣帶 Electron；
  // 它們與 PWA 面對同一個問題（storage 隔離、popup 死窗），走交接是正確解。
  const embedded = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) SomeApp/1.0 Chrome/126.0.0.0 Electron/31.0.0 Safari/537.36";
  assert.equal(detect({ userAgent: embedded, standaloneMedia: false }), true);
});

test("無 window 的 SSR 環境回 false，不拋錯", () => {
  assert.equal(detect({ userAgent: DESKTOP_UA, hasWindow: false }), false);
});

test("window 存在但缺 matchMedia 時不拋錯（依賴 UA 判定）", () => {
  assert.equal(detect({ userAgent: DESKTOP_UA, hasMatchMedia: false }), true);
  assert.equal(detect({ userAgent: CHROME_UA, hasMatchMedia: false }), false);
});
