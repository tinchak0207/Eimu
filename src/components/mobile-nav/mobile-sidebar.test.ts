import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import Module, { createRequire } from "node:module";

// tsconfig 的 jsx=preserve 让 tsx 对 .tsx 退回 classic runtime，组件源码不 import
// React（Next 构建走 automatic）。SSR 渲染/元素树遍历前补全局 React 桩。
(globalThis as unknown as Record<string, unknown>).React ??= React;

// MobileSidebar.tsx 经 AgentChatSurface → AgentChatPanel 间接触发 `import "./agent-chat.css"`：
// node --test 走 CJS require，没有 css loader，静态 import 会在模块图加载阶段炸掉。
// 先把 .css 註冊成空模組（同 agent-chat-ui.test.ts 手法），再 require 元件檔。
(Module as unknown as { _extensions: Record<string, (m: unknown, filename: string) => void> })._extensions[
  ".css"
] = (m) => {
  (m as { exports: unknown }).exports = {};
};
const requireHere = createRequire(import.meta.url);
const {
  MobileSidebarPanel,
  MobileNavHamburger,
  MOBILE_SIDEBAR_NAV,
  isSidebarNavActive,
  readPersistedSessionId,
} = requireHere("./MobileSidebar.tsx") as {
  MobileSidebarPanel: (props: Record<string, unknown>) => React.ReactElement;
  MobileNavHamburger: (props: { onClick: () => void; expanded: boolean }) => React.ReactElement;
  MOBILE_SIDEBAR_NAV: ReadonlyArray<{ href: string; label: string }>;
  isSidebarNavActive: (pathname: string, href: string) => boolean;
  readPersistedSessionId: () => string | null;
};

const root = process.cwd();
function read(relPath: string): string {
  return readFileSync(join(root, relPath), "utf8");
}
/** 去掉注释后的源码（反例写在注释里是常态，原文断言会误判）。 */
function readCode(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const sidebarSrc = read("src/components/mobile-nav/MobileSidebar.tsx");
const sidebarCode = readCode(sidebarSrc);
const navbarCode = readCode(read("src/components/Navbar.tsx"));
const sidebarCss = read("src/components/mobile-nav/mobile-sidebar.css");

// ── 元素樹工具（無 jsdom，直接走 React element props） ────────────────────────

type El = { type: unknown; props: Record<string, unknown> };

function collect(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const el = node as El;
  if (el.props && "type" in el) {
    out.push(el);
    collect(el.props.children, out);
  }
  return out;
}

/** 用 tag 棧判斷 JSX 是否出現嵌套 <button>（全站既有坑，新元件也要守）。 */
function hasNestedButtons(source: string): boolean {
  const stack: string[] = [];
  const re = /<\/?button\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[0].startsWith("</")) stack.pop();
    else {
      stack.push(m[0]);
      if (stack.length > 1) return true;
    }
  }
  return false;
}

const noop = (): void => {};
const ref = { current: null };
const SEARCH_INPUT_REF = { current: null };

function renderPanel(overrides: Record<string, unknown> = {}): El[] {
  const tree = MobileSidebarPanel({
    pathname: "/",
    userName: "阿甲",
    userSubtitle: "a@b.com",
    isLoggedIn: true,
    onLogout: noop,
    sessions: [],
    currentSessionId: null,
    formatLabel: (it: { title?: string | null }) => it.title ?? "",
    query: "",
    onQueryChange: noop,
    onPickSession: noop,
    onStartNew: noop,
    onClose: noop,
    closeButtonRef: ref,
    searchInputRef: SEARCH_INPUT_REF,
    ...overrides,
  });
  return collect(tree);
}

// ── ① 漢堡鈕：窄屏存在（sm:hidden 契約） ────────────────────────────────────

test("漢堡鈕是 44×44 的 button，且用 sm:hidden 只在 <sm 出現", () => {
  const el = MobileNavHamburger({ onClick: noop, expanded: false }) as unknown as El;
  assert.equal(el.type, "button");
  const cls = String(el.props.className);
  assert.match(cls, /sm:hidden/, "桌面 ≥sm 必須隱藏（sm:hidden 契約）");
  assert.match(cls, /\bh-11\b/, "觸控目標高度 44px");
  assert.match(cls, /\bw-11\b/, "觸控目標寬度 44px");
  assert.match(cls, /touch-manipulation/);
  assert.equal(el.props["aria-label"], "打开导航");
  assert.equal(el.props["aria-haspopup"], "dialog");

  // Navbar 真的掛了這顆：手機端左簇第一顆，桌面其餘按鈕不動。
  assert.match(navbarCode, /<MobileNavHamburger\b/, "Navbar 必須渲染漢堡鈕");
  assert.match(navbarCode, /<MobileSidebar\b/, "Navbar 必須渲染側欄");
});

// ── ② portal：側欄節點掛在 document.body 下 ─────────────────────────────────

test("側欄用 createPortal 掛到 document.body（否則被 lg-bar 祖先含住）", () => {
  assert.match(sidebarCode, /createPortal\(/);
  assert.match(sidebarCode, /document\.body,\s*\)/, "portal 目標必須是 document.body");
  // 地雷註解也要留著：祖先 backdrop-filter / transform 會當 fixed 後代的 containing block。
  assert.match(sidebarSrc, /backdrop-filter/);
  // 全視窗：scrim 的 CSS 必須是 fixed inset:0（不是只覆蓋那顆膠囊）。
  assert.match(sidebarCss, /\.mobile-sidebar-scrim\s*\{[^}]*position:\s*fixed/s);
  assert.match(sidebarCss, /\.mobile-sidebar-scrim\s*\{[^}]*inset:\s*0/s);
});

// ── ③ 側欄含既有路由連結逐條（不准出現發明的路由） ──────────────────────────

/** 獨立 oracle：把 href 映射回檔案系統路由，確認它真的存在（不與元件同源）。 */
function routeFileExists(href: string): boolean {
  const path = href.split("?")[0];
  if (path === "/") return existsSync(join(root, "src/app/page.tsx"));
  return existsSync(join(root, `src/app${path}/page.tsx`));
}

test("每一條導覽連結都對得上現場存在的路由檔", () => {
  for (const { href } of MOBILE_SIDEBAR_NAV) {
    assert.ok(routeFileExists(href), `${href} 在 src/app 下找不到對應 page.tsx（疑似發明路由）`);
  }
  const hrefs = MOBILE_SIDEBAR_NAV.map((it) => it.href);
  assert.deepEqual(hrefs, [
    "/history",
    "/?agent=1",
    "/skills",
    "/workflows",
    "/pricing",
    "/status",
    "/use-cases",
  ]);
});

test("側欄元素樹逐條含既有路由連結（含設定齒輪）", () => {
  const hrefs = new Set(
    renderPanel()
      .map((el) => el.props.href)
      .filter((h): h is string => typeof h === "string"),
  );
  for (const { href } of MOBILE_SIDEBAR_NAV) {
    assert.ok(hrefs.has(href), `側欄缺 ${href}`);
  }
  assert.ok(hrefs.has("/settings/api-keys"), "設定齒輪必須接既有設定路由 /settings/api-keys");
  // 不准出現沒落地的路由（例如 /assets、/settings、/agent 這些現場不存在的）。
  for (const href of hrefs) {
    if (href.startsWith("http")) continue; // QQ 群外鏈
    assert.ok(routeFileExists(href), `${href} 不是既有路由`);
  }
});

test("active 態只認不帶 query 的路徑連結", () => {
  assert.equal(isSidebarNavActive("/history", "/history"), true);
  assert.equal(isSidebarNavActive("/", "/history"), false);
  assert.equal(isSidebarNavActive("/", "/?agent=1"), false, "query 入口不冒充當前頁");
});

test("對話分節複用既有 AgentSessionList，標題格式化只走動態 import 的唯一實作", () => {
  assert.match(sidebarCode, /import \{ AgentSessionList \} from "@\/components\/agent-chat\/AgentSessionList"/);
  // A（膨脹）：不准靜態 import AgentChatSurface——Navbar 在 root layout，靜態 import
  // 會把整條 agent-chat 模組圖拉進全站每一頁；唯一實作改在側欄開啟時動態載入。
  assert.doesNotMatch(
    sidebarCode,
    /import \{ formatSessionLabel \} from "@\/components\/agent-chat\/AgentChatSurface"/,
    "不准靜態 import AgentChatSurface（會膨脹全站首包）",
  );
  assert.match(
    sidebarCode,
    /import\("@\/components\/agent-chat\/AgentChatSurface"\)/,
    "唯一實作必須以動態 import 取得",
  );
  assert.match(sidebarCode, /<AgentSessionList\b/);
  assert.match(sidebarCode, /formatLabel=\{formatLabel\}/);
  // 不准自造第二份標題格式化邏輯。
  assert.doesNotMatch(sidebarCode, /function formatSessionLabel/);
});

// ── ⑦ 當前會話高亮：讀既有存檔，壞 JSON 落回 null ─────────────────────────────

test("讀存檔取當前會話 id：壞 JSON／無存檔一律回 null，不拋錯", () => {
  const KEY = "agent-chat-session-v1";
  const store = new Map<string, string>();
  const fakeLocalStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  const hadWindow = "window" in g;
  const prevWindow = g.window;
  g.window = { localStorage: fakeLocalStorage };
  try {
    // 壞 JSON：照既有 sanitize 慣例當「沒有存檔」，不得 throw。
    store.set(KEY, "{ not valid json !!");
    assert.equal(readPersistedSessionId(), null);
    // 無存檔。
    store.delete(KEY);
    assert.equal(readPersistedSessionId(), null);
    // 合法存檔才回 sessionId（真源欄位名＝schema 的 sessionId）。
    store.set(
      KEY,
      JSON.stringify({ version: 1, sessionId: "sess-ok", lastEventId: 0, savedAt: Date.now(), items: [] }),
    );
    assert.equal(readPersistedSessionId(), "sess-ok");
  } finally {
    if (hadWindow) g.window = prevWindow;
    else delete g.window;
  }
});

// ── ④ 三條關閉路徑 ──────────────────────────────────────────────────────────

test("關閉鈕（真行為）：點下去呼叫 onClose", () => {
  let closed = 0;
  const els = renderPanel({ onClose: () => (closed += 1) });
  const closeBtn = els.find((el) => el.props["aria-label"] === "关闭导航");
  assert.ok(closeBtn, "側欄必須有關閉鈕");
  assert.equal(closeBtn.type, "button");
  (closeBtn.props.onClick as () => void)();
  assert.equal(closed, 1);
});

test("Esc 與遮罩點擊兩條關閉路徑（容器行為）", () => {
  // Esc：keydown → Escape → onClose。
  assert.match(sidebarCode, /document\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(sidebarCode, /event\.key === "Escape"/);
  assert.match(sidebarCode, /onCloseRef\.current\(\)/);
  // 遮罩：只有點到 scrim 本身（不是面板內部）才關。
  assert.match(sidebarCode, /if \(event\.target === event\.currentTarget\) onClose\(\);/);
});

// ── ⑤ 滾動鎖存還原 ──────────────────────────────────────────────────────────

test("body 滾動鎖存原值再還原（與全出血鎖共存）", () => {
  assert.match(sidebarCode, /const previousOverflow = document\.body\.style\.overflow/);
  assert.match(sidebarCode, /document\.body\.style\.overflow = "hidden"/);
  assert.match(sidebarCode, /document\.body\.style\.overflow = previousOverflow/);
  // 開場焦點進側欄、關閉歸還觸發鈕。
  assert.match(sidebarCode, /closeButtonRef\.current\?\.focus\(\)/);
  assert.match(sidebarCode, /triggerRef\?\.current\?\.focus\(\)/);
  // aria 契約。
  assert.match(sidebarCode, /role="dialog"/);
  assert.match(sidebarCode, /aria-modal="true"/);
  assert.match(sidebarCode, /aria-label="主导航"/);
  // reduced-motion 出口。
  assert.match(sidebarCss, /prefers-reduced-motion/);
});

// ── ⑥ 44px 觸控目標 ＋ 無嵌套 button ────────────────────────────────────────

test("側欄內每個可按元素觸控目標 ≥44px", () => {
  const interactive = renderPanel().filter((el) => {
    const isButton = el.type === "button";
    const isLink = typeof el.props.href === "string";
    return isButton || isLink;
  });
  assert.ok(interactive.length >= 10, `可按元素太少（${interactive.length}），側欄沒接上`);
  for (const el of interactive) {
    const cls = String(el.props.className ?? "");
    assert.match(
      cls,
      /(min-h-\[52px\]|\bh-11\b|\bh-12\b|\bh-14\b)/,
      `可按元素缺 44px 觸控高度：${cls}`,
    );
    assert.match(cls, /touch-manipulation/, `可按元素缺 touch-manipulation：${cls}`);
  }
});

test("新元件不嵌套 button，也不改 agent-chat 檔", () => {
  assert.ok(!hasNestedButtons(sidebarSrc), "MobileSidebar 不得有 button 套 button");
  // 只新建 mobile-nav 下的檔：不得 import 或改動 agent-chat 目錄下的 CSS。
  assert.doesNotMatch(sidebarCode, /import "\.\.\/agent-chat\/agent-chat\.css"/);
  assert.doesNotMatch(sidebarCode, /import "\.\.\/\.\.\/app\/globals\.css"/);
});

// ── ⑨ 手機字級對齊（2026-10-03 對標 Grok 側欄）──────────────────────────────
// 說明：以下是 CSS/JSX 源碼斷言（變更探針）；渲染 oracle 由本地 390×844
// Playwright 實測承擔（見回報數字）。

test("導覽列標籤 17px（text-ios-body 掛標籤 span、不進 cn）＋列高 ≥52px＋icon 20px", () => {
  const els = renderPanel();
  const navItem = els.find((el) => el.props.href === "/history");
  assert.ok(navItem, "導覽列缺 /history");
  const anchorCls = String(navItem.props.className ?? "");
  assert.match(anchorCls, /min-h-\[52px\]/, "導覽列高必須 ≥52px（17px 不撐破/不擠掉垂直置中）");
  // twMerge 陷阱：cn() 會把不認識的 `text-ios-body` 歸到 text-color 群組，再被同串
  // 之後的 `text-[rgba(…)]` 吃掉（實測 twMerge 直接移除）；所以 17px token 必須落在
  // 內層 span 的純字串 className，不可放在 cn 的 anchor 上。
  assert.doesNotMatch(anchorCls, /\btext-ios-body\b/, "text-ios-body 不得放進 cn（會被 twMerge 吃掉）");
  const labelSpan = els.find(
    (el) => el.type === "span" && /\btext-ios-body\b/.test(String(el.props.className ?? "")),
  );
  assert.ok(labelSpan, "標籤 span 缺 text-ios-body（17px）");
  assert.match(String(labelSpan.props.className), /truncate/);
  // icon：20px（h-5 w-5），與 17px 字級相襯、不被字級壓過。
  assert.ok(
    els.some((el) => String(el.props.className ?? "") === "h-5 w-5 shrink-0"),
    "導覽 icon 應為 20px（h-5 w-5）",
  );
});

test("側欄作用域把 footnote 層抬到 14px 地板，且只作用 ≤639.98px", () => {
  const NARROW = "@media (max-width: 639.98px)";
  const at = sidebarCss.indexOf(NARROW);
  assert.ok(at >= 0, "mobile-sidebar.css 缺 ≤639.98px 地板塊");
  const narrowBlock = sidebarCss.slice(at);
  assert.match(
    narrowBlock,
    /\.mobile-sidebar-panel\s+\.text-ios-footnote\s*\{[^}]*font-size:\s*14px/s,
    "側欄缺 footnote→14px 地板規則（會話日期行／身份副標）",
  );
  // 桌面 ≥640px 一字不動：14px 只准出現在窄屏塊內。
  assert.ok(
    !sidebarCss.slice(0, at).includes("font-size: 14px"),
    "14px 地板泄漏到窄屏塊之外",
  );
  // 共用件基礎 class 不得被改：AgentSessionList 仍是 text-ios-footnote（13px）。
  const sessionListSrc = read("src/components/agent-chat/AgentSessionList.tsx");
  assert.match(
    sessionListSrc,
    /text-ios-subhead font-medium leading-snug/,
    "共用件 AgentSessionList 標題基礎 class 被改動",
  );
  assert.match(
    sessionListSrc,
    /gap-1\.5 text-ios-footnote text-foreground\/45/,
    "共用件 AgentSessionList 日期行基礎 class 被改動（應只在 mobile-sidebar.css 覆寫）",
  );
});
