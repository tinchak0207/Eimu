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
  MOBILE_SIDEBAR_FOOTER_LINKS,
  isSidebarNavActive,
  readPersistedSessionId,
  QQ_GROUP_SHARE_URL,
} = requireHere("./MobileSidebar.tsx") as {
  MobileSidebarPanel: (props: Record<string, unknown>) => React.ReactElement;
  MobileNavHamburger: (props: { onClick: () => void; expanded: boolean }) => React.ReactElement;
  MOBILE_SIDEBAR_NAV: ReadonlyArray<{
    href: string;
    label: string;
    action?: string;
    neverActive?: boolean;
  }>;
  MOBILE_SIDEBAR_FOOTER_LINKS: ReadonlyArray<{ href: string; label: string }>;
  isSidebarNavActive: (pathname: string, href: string) => boolean;
  readPersistedSessionId: () => string | null;
  QQ_GROUP_SHARE_URL: string;
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
    sessions: [],
    currentSessionId: null,
    formatLabel: (it: { title?: string | null }) => it.title ?? "",
    query: "",
    onQueryChange: noop,
    onPickSession: noop,
    onStartNew: noop,
    onSurfaceAction: noop,
    onClose: noop,
    closeButtonRef: ref,
    searchInputRef: SEARCH_INPUT_REF,
    ...overrides,
  });
  return collect(tree);
}

/** 取某個元素的子孫元素（用於把 dock 內的按鈕隔離出來）。 */
function descendants(el: El): El[] {
  return collect(el.props.children);
}

/** 取一個元素下所有可按子孫（button／帶 href 的連結）。 */
function clickables(el: El): El[] {
  return descendants(el).filter(
    (n) => n.type === "button" || typeof n.props.href === "string",
  );
}

/** 元素內所有可見文字（遞迴 span／純字串）。 */
function textOf(el: El): string {
  let out = "";
  const walk = (node: unknown): void => {
    if (typeof node === "string" || typeof node === "number") {
      out += String(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const c of node) walk(c);
      return;
    }
    if (node && typeof node === "object" && (node as El).props) walk((node as El).props.children);
  };
  walk(el.props.children);
  return out;
}

/** 取某一列（Link／button）內層標籤 span 的文字。 */
function rowLabel(el: El): string | null {
  const kids = Array.isArray(el.props.children) ? el.props.children : [el.props.children];
  for (const kid of kids) {
    if (kid && typeof kid === "object" && (kid as El).type === "span") {
      return String((kid as El).props.children);
    }
  }
  return null;
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

// ── ③ 側欄導覽瘦身成 4 列：逐列驗標籤／href／button-or-link／動作橋 ────────────

/** 獨立 oracle：把 href 映射回檔案系統路由，確認它真的存在（不與元件同源）。 */
function routeFileExists(href: string): boolean {
  const path = href.split("?")[0];
  if (path === "/") return existsSync(join(root, "src/app/page.tsx"));
  return existsSync(join(root, `src/app${path}/page.tsx`));
}

/** 第三輪定案的 4 列（順序固定）；bridge＝null 表示純連結。 */
const NAV_TABLE = [
  { href: "/", label: "直接生成", bridge: "exit", tag: "button" },
  { href: "/history", label: "生成历史", bridge: null, tag: "link" },
  { href: "/?agent=1", label: "我的资产", bridge: "assets", tag: "button" },
  { href: "/pricing", label: "定价", bridge: null, tag: "link" },
] as const;

test("導覽列只剩 4 列且順序固定（技能/工作流/状态/帮助已下放頁尾）", () => {
  assert.equal(MOBILE_SIDEBAR_NAV.length, 4, "第三輪：7 列 → 4 列");
  assert.deepEqual(
    MOBILE_SIDEBAR_NAV.map((it) => it.href),
    NAV_TABLE.map((it) => it.href),
  );
  assert.deepEqual(
    MOBILE_SIDEBAR_NAV.map((it) => it.label),
    NAV_TABLE.map((it) => it.label),
  );
  // 逐條 href 仍對得上現場存在的路由檔（/=首頁；/?agent=1 取路徑前段）。
  for (const { href } of MOBILE_SIDEBAR_NAV) {
    assert.ok(routeFileExists(href), `${href} 在 src/app 下找不到對應 page.tsx（疑似發明路由）`);
  }
});

test("導覽逐列：有動作橋＝button（帶動作字串＋fallback href）；純連結＝Link", () => {
  const els = renderPanel();
  for (const row of NAV_TABLE) {
    if (row.tag === "button") {
      const btn = els.find((el) => el.props["data-agent-action"] === row.bridge);
      assert.ok(btn, `缺動作橋列 ${row.label}（action=${row.bridge}）`);
      assert.equal(btn.type, "button", `${row.label} 有動作橋必須渲染成 <button>`);
      assert.equal(btn.props.href, undefined, `${row.label} 不可是 <Link>（不得帶 href）`);
      assert.equal(btn.props["data-fallback-href"], row.href, `${row.label} fallback href 不符`);
      assert.equal(rowLabel(btn), row.label, `${row.label} 標籤不符`);
      assert.equal(btn.props["aria-current"], undefined, `${row.label} 有動作橋不得做 active 高亮`);
    } else {
      const link = els.find((el) => el.props.href === row.href);
      assert.ok(link, `缺純連結列 ${row.label}（href=${row.href}）`);
      assert.notEqual(link.type, "button", `${row.label} 無動作橋應維持 <Link>`);
      assert.equal(link.props["data-agent-action"], undefined, `${row.label} 不應帶動作橋`);
      assert.equal(rowLabel(link), row.label, `${row.label} 標籤不符`);
    }
  }
});

test("側欄元素樹含剩餘純連結路由，且無發明路由", () => {
  const els = renderPanel();
  const hrefs = new Set(
    els.map((el) => el.props.href).filter((h): h is string => typeof h === "string"),
  );
  assert.ok(hrefs.has("/history"));
  assert.ok(hrefs.has("/pricing"));
  // 「账号设置」列已移除（回歸 header）；帳號設置仍可經 dock 齒輪 fallback 到達。
  assert.ok(
    els.some(
      (el) => el.props["aria-label"] === "设置" && el.props["data-fallback-href"] === "/settings/api-keys",
    ),
    "dock 齒輪 fallback 必須仍接 /settings/api-keys",
  );
  // 動作橋列的 href 落在 data-fallback-href 上（不是 Link），逐條對得上是真路由。
  for (const el of els) {
    const fb = el.props["data-fallback-href"];
    if (typeof fb === "string") assert.ok(routeFileExists(fb), `${fb} 不是既有路由`);
  }
  // 不准出現沒落地的路由（例如 /assets、/settings、/agent 這些現場不存在的）。
  for (const href of hrefs) {
    if (href.startsWith("http")) continue; // QQ 群外鏈
    assert.ok(routeFileExists(href), `${href} 不是既有路由`);
  }
});

// ── ③b 被砍的 4 頁降級頁尾細字連結帶（不變孤兒） ─────────────────────────────

test("頁尾連結帶含技能/工作流/状态/帮助 4 條真路由連結", () => {
  // 常數逐條對得上真路由檔（不與元件同源的 oracle）。
  assert.deepEqual(
    MOBILE_SIDEBAR_FOOTER_LINKS.map((it) => it.href),
    ["/skills", "/workflows", "/status", "/use-cases"],
  );
  for (const { href } of MOBILE_SIDEBAR_FOOTER_LINKS) {
    assert.ok(routeFileExists(href), `頁尾連結 ${href} 不是既有路由`);
  }
  // 元素樹裡真的渲染出這 4 條（標記 data-mobile-footer-link）。
  const footerLinks = renderPanel().filter(
    (el) => el.props["data-mobile-footer-link"] === "true",
  );
  assert.equal(footerLinks.length, 4, "頁尾連結帶應有 4 條");
  assert.deepEqual(
    footerLinks.map((el) => el.props.href).sort(),
    ["/skills", "/status", "/use-cases", "/workflows"],
  );
});

// ── ③c 帳號區補「账号设置」＋底部齒輪情境感知 ──────────────────────────────

test("④ 捲動區已無『账号设置』『退出登录』列，『加入 QQ 群』保留", () => {
  const els = renderPanel();
  assert.equal(
    els.find((el) => rowLabel(el) === "账号设置"),
    undefined,
    "『账号设置』列應已移除（回歸 header）",
  );
  assert.equal(
    els.find((el) => rowLabel(el) === "退出登录"),
    undefined,
    "『退出登录』列應已移除（回歸 header）",
  );
  // 兩個圖示 import 若不再使用就會是死碼：KeyRound／LogOut 不應再出現在元件源碼。
  assert.doesNotMatch(sidebarCode, /\bKeyRound\b/, "KeyRound 已無使用者，import 應移除");
  assert.doesNotMatch(sidebarCode, /\bLogOut\b/, "LogOut 已無使用者，import 應移除");
  // 死 prop：onLogout / isLoggedIn 不再出現在元件源碼（已從 props 與容器移除）。
  assert.doesNotMatch(sidebarCode, /\bonLogout\b/, "onLogout 已是死 prop，應移除");
  assert.doesNotMatch(sidebarCode, /\bisLoggedIn\b/, "isLoggedIn 已是死 prop，應移除");
  // 「加入 QQ 群」保留（外部連結）。
  const qq = els.find((el) => el.props.href === QQ_GROUP_SHARE_URL);
  assert.ok(qq, "『加入 QQ 群』列必須保留");
  assert.equal(rowLabel(qq), "加入 QQ 群");
});

test("① dock 已無『搜索』鈕，只剩齒輪＋黑色新對話 FAB（justify-between）", () => {
  const dock = renderPanel().find((el) => String(el.props.className ?? "").includes("mobile-sidebar-dock"));
  assert.ok(dock, "缺 .mobile-sidebar-dock");
  const bar = descendants(dock).find((el) => String(el.props.className ?? "").includes("lg-bar"));
  assert.ok(bar, "dock 缺 lg-bar 內層");
  assert.match(String(bar.props.className), /justify-between/, "dock 兩端對齊（justify-between）");
  const buttons = descendants(dock).filter((el) => el.type === "button");
  assert.equal(buttons.length, 2, `dock 應只剩 2 顆按鈕（齒輪＋FAB），實得 ${buttons.length}`);
  const labels = buttons.map((b) => b.props["aria-label"]);
  assert.ok(labels.includes("设置"), "dock 缺齒輪");
  assert.ok(labels.includes("新对话"), "dock 缺黑色 FAB");
  assert.ok(
    !buttons.some((b) => textOf(b).includes("搜索")),
    "dock 不應再有『搜索』字樣的按鈕",
  );
  // 不再有任何地方呼叫 searchInputRef.focus()（那是被刪的搜索鈕唯一作用）。
  assert.doesNotMatch(sidebarCode, /searchInputRef\?\.current\?\.focus\(\)/, "dock 搜索鈕的 focus 呼叫應已移除");
});

test("③「对话」分節的搜尋框（唯一入口）仍在，且 searchInputRef 仍掛在它上", () => {
  const els = renderPanel();
  const input = els.find((el) => el.type === "input" && el.props["aria-label"] === "搜索对话");
  assert.ok(input, "『对话』分節的搜索框（唯一入口）不得移除");
  assert.equal(input.props.placeholder, "搜索对话");
  // searchInputRef 仍掛在對話搜尋框上（ref 不落在 element.props，用源碼確認）。
  assert.match(sidebarCode, /ref=\{searchInputRef\}/, "searchInputRef 必須仍接在對話搜尋框上");
});

test("④ 面板內有承載底色的內層（.mobile-sidebar-bg），面板本體不含 backdrop-filter", () => {
  // 元素樹：面板內真的渲染出承載底色的內層。
  const bg = renderPanel().find(
    (el) => String(el.props.className ?? "") === "mobile-sidebar-bg",
  );
  assert.ok(bg, "面板內缺承載底色的 .mobile-sidebar-bg 內層");
  // 面板本體規則：不得再有 backdrop-filter（材質已移到內層）。
  const panelBlock = /\.mobile-sidebar-panel\s*\{([^}]*)\}/.exec(sidebarCss)?.[1] ?? "";
  assert.ok(panelBlock, "找不到 .mobile-sidebar-panel 規則");
  assert.doesNotMatch(panelBlock, /backdrop-filter/, "面板本體不得再掛 backdrop-filter");
  // 內層＝不透明純白（不是半透 0.96）。
  const bgBlock = /\.mobile-sidebar-bg\s*\{([^}]*)\}/.exec(sidebarCss)?.[1] ?? "";
  assert.ok(bgBlock, "找不到 .mobile-sidebar-bg 規則");
  assert.match(bgBlock, /position:\s*absolute/);
  assert.match(bgBlock, /inset:\s*0/);
  assert.match(bgBlock, /background:\s*(#fff|rgb\(255,\s*255,\s*255\))/, "內層底色＝不透明純白");
  // scrim 的 blur(2px) 保留。
  const scrimBlock = /\.mobile-sidebar-scrim\s*\{([^}]*)\}/.exec(sidebarCss)?.[1] ?? "";
  assert.match(scrimBlock, /backdrop-filter:\s*blur\(2px\)/, "scrim 的 blur 保留");
});

test("底部 dock 齒輪＝button（情境感知動作橋），aria-label 仍是『设置』", () => {
  const gear = renderPanel().find((el) => el.props["aria-label"] === "设置");
  assert.ok(gear, "dock 缺 aria-label 為「设置」的齒輪");
  assert.equal(gear.type, "button", "齒輪應改為 <button>（動作橋派發）");
  assert.equal(gear.props.href, undefined, "齒輪不應再是 <Link>");
  assert.equal(gear.props["data-fallback-href"], "/settings/api-keys", "齒輪 fallback 應回帳號設置");
  // 容器：先關側欄 → 派動作 → 沒宿主才 router.push fallback。
  assert.match(sidebarCode, /requestAgentSurfaceAction\(action\)/);
  assert.match(sidebarCode, /if \(!requestAgentSurfaceAction\(action\)\) router\.push\(fallbackHref\)/);
  // 不准靜態 import AgentChatSurface 取助理面動作（仍走動作橋）。
  assert.match(
    sidebarCode,
    /import \{\s*requestAgentSurfaceAction,\s*type AgentSurfaceAction,\s*\} from "@\/lib\/agent-surface-actions"/,
  );
});

test("『直接生成』/ 不冒充當前頁（neverActive），只有不帶 query 的純連結才亮", () => {
  const navItem = MOBILE_SIDEBAR_NAV.find((it) => it.href === "/");
  assert.equal(navItem?.neverActive, true, "/ 這列必須標 neverActive");
  // 純函式語意不變：/ 對 / 仍回 true（元件端靠 neverActive 關掉）。
  assert.equal(isSidebarNavActive("/", "/"), true);
  // 首頁渲染：直接生成那顆 button 不得亮 aria-current。
  const exitBtn = renderPanel({ pathname: "/" }).find(
    (el) => el.props["data-agent-action"] === "exit",
  );
  assert.ok(exitBtn);
  assert.equal(exitBtn.props["aria-current"], undefined, "首頁不得亮『直接生成』");
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

test("側欄內每個可按元素觸控目標 ≥44px（頁尾細字連結帶為既定例外）", () => {
  const interactive = renderPanel().filter((el) => {
    // 頁尾「技能·工作流·状态·帮助」是刻意的小字連結帶，不是 52px 列，排除。
    if (el.props["data-mobile-footer-link"] === "true") return false;
    const isButton = el.type === "button";
    const isLink = typeof el.props.href === "string";
    return isButton || isLink;
  });
  // 第四輪刪掉「账号设置／退出登录／dock 搜索」三顆 ⇒ 常駐可按元素由 11 降為 8。
  assert.ok(interactive.length >= 8, `可按元素太少（${interactive.length}），側欄沒接上`);
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
