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
// 先把 .css 注册成空模组（同 agent-chat-ui.test.ts 手法），再 require 元件档。
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

// ── 元素树工具（无 jsdom，直接走 React element props） ────────────────────────

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

/** 用 tag 栈判断 JSX 是否出现嵌套 <button>（全站既有坑，新元件也要守）。 */
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

/** 取某个元素的子孙元素（用于把 dock 内的按钮隔离出来）。 */
function descendants(el: El): El[] {
  return collect(el.props.children);
}

/** 取一个元素下所有可按子孙（button／带 href 的连结）。 */
function clickables(el: El): El[] {
  return descendants(el).filter(
    (n) => n.type === "button" || typeof n.props.href === "string",
  );
}

/** 元素内所有可见文字（递回 span／纯字串）。 */
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

/** 取某一列（Link／button）内层标签 span 的文字。 */
function rowLabel(el: El): string | null {
  const kids = Array.isArray(el.props.children) ? el.props.children : [el.props.children];
  for (const kid of kids) {
    if (kid && typeof kid === "object" && (kid as El).type === "span") {
      return String((kid as El).props.children);
    }
  }
  return null;
}

// ── ① 汉堡钮：窄屏存在（sm:hidden 契约） ────────────────────────────────────

test("汉堡钮是 44×44 的 button，且用 sm:hidden 只在 <sm 出现", () => {
  const el = MobileNavHamburger({ onClick: noop, expanded: false }) as unknown as El;
  assert.equal(el.type, "button");
  const cls = String(el.props.className);
  assert.match(cls, /sm:hidden/, "桌面 ≥sm 必须隐藏（sm:hidden 契约）");
  assert.match(cls, /\bh-11\b/, "触控目标高度 44px");
  assert.match(cls, /\bw-11\b/, "触控目标宽度 44px");
  assert.match(cls, /touch-manipulation/);
  assert.equal(el.props["aria-label"], "打开导航");
  assert.equal(el.props["aria-haspopup"], "dialog");

  // Navbar 真的挂了这颗：手机端左簇第一颗，桌面其余按钮不动。
  assert.match(navbarCode, /<MobileNavHamburger\b/, "Navbar 必须渲染汉堡钮");
  assert.match(navbarCode, /<MobileSidebar\b/, "Navbar 必须渲染侧栏");
});

// ── ② portal：侧栏节点挂在 document.body 下 ─────────────────────────────────

test("侧栏用 createPortal 挂到 document.body（否则被 lg-bar 祖先含住）", () => {
  assert.match(sidebarCode, /createPortal\(/);
  assert.match(sidebarCode, /document\.body,\s*\)/, "portal 目标必须是 document.body");
  // 地雷注解也要留著：祖先 backdrop-filter / transform 会当 fixed 后代的 containing block。
  assert.match(sidebarSrc, /backdrop-filter/);
  // 全视窗：scrim 的 CSS 必须是 fixed inset:0（不是只覆盖那颗胶囊）。
  assert.match(sidebarCss, /\.mobile-sidebar-scrim\s*\{[^}]*position:\s*fixed/s);
  assert.match(sidebarCss, /\.mobile-sidebar-scrim\s*\{[^}]*inset:\s*0/s);
});

// ── ③ 侧栏导览瘦身成 4 列：逐列验标签／href／button-or-link／动作桥 ────────────

/** 独立 oracle：把 href 映射回档案系统路由，确认它真的存在（不与元件同源）。 */
function routeFileExists(href: string): boolean {
  const path = href.split("?")[0];
  if (path === "/") return existsSync(join(root, "src/app/page.tsx"));
  return existsSync(join(root, `src/app${path}/page.tsx`));
}

/** 第三轮定案的 4 列（顺序固定）；bridge＝null 表示纯连结。 */
const NAV_TABLE = [
  { href: "/", label: "直接生成", bridge: "exit", tag: "button" },
  { href: "/history", label: "生成历史", bridge: null, tag: "link" },
  { href: "/?agent=1", label: "我的资产", bridge: "assets", tag: "button" },
  { href: "/pricing", label: "定价", bridge: null, tag: "link" },
] as const;

test("导览列只剩 4 列且顺序固定（技能/工作流/状态/帮助已下放页尾）", () => {
  assert.equal(MOBILE_SIDEBAR_NAV.length, 4, "第三轮：7 列 → 4 列");
  assert.deepEqual(
    MOBILE_SIDEBAR_NAV.map((it) => it.href),
    NAV_TABLE.map((it) => it.href),
  );
  assert.deepEqual(
    MOBILE_SIDEBAR_NAV.map((it) => it.label),
    NAV_TABLE.map((it) => it.label),
  );
  // 逐条 href 仍对得上现场存在的路由档（/=首页；/?agent=1 取路径前段）。
  for (const { href } of MOBILE_SIDEBAR_NAV) {
    assert.ok(routeFileExists(href), `${href} 在 src/app 下找不到对应 page.tsx（疑似发明路由）`);
  }
});

test("导览逐列：有动作桥＝button（带动作字串＋fallback href）；纯连结＝Link", () => {
  const els = renderPanel();
  for (const row of NAV_TABLE) {
    if (row.tag === "button") {
      const btn = els.find((el) => el.props["data-agent-action"] === row.bridge);
      assert.ok(btn, `缺动作桥列 ${row.label}（action=${row.bridge}）`);
      assert.equal(btn.type, "button", `${row.label} 有动作桥必须渲染成 <button>`);
      assert.equal(btn.props.href, undefined, `${row.label} 不可是 <Link>（不得带 href）`);
      assert.equal(btn.props["data-fallback-href"], row.href, `${row.label} fallback href 不符`);
      assert.equal(rowLabel(btn), row.label, `${row.label} 标签不符`);
      assert.equal(btn.props["aria-current"], undefined, `${row.label} 有动作桥不得做 active 高亮`);
    } else {
      const link = els.find((el) => el.props.href === row.href);
      assert.ok(link, `缺纯连结列 ${row.label}（href=${row.href}）`);
      assert.notEqual(link.type, "button", `${row.label} 无动作桥应维持 <Link>`);
      assert.equal(link.props["data-agent-action"], undefined, `${row.label} 不应带动作桥`);
      assert.equal(rowLabel(link), row.label, `${row.label} 标签不符`);
    }
  }
});

test("侧栏元素树含剩余纯连结路由，且无发明路由", () => {
  const els = renderPanel();
  const hrefs = new Set(
    els.map((el) => el.props.href).filter((h): h is string => typeof h === "string"),
  );
  assert.ok(hrefs.has("/history"));
  assert.ok(hrefs.has("/pricing"));
  // 「账号设置」列已移除（回归 header）；帐号设置仍可经 dock 齿轮 fallback 到达。
  assert.ok(
    els.some(
      (el) => el.props["aria-label"] === "设置" && el.props["data-fallback-href"] === "/settings/api-keys",
    ),
    "dock 齿轮 fallback 必须仍接 /settings/api-keys",
  );
  // 动作桥列的 href 落在 data-fallback-href 上（不是 Link），逐条对得上是真路由。
  for (const el of els) {
    const fb = el.props["data-fallback-href"];
    if (typeof fb === "string") assert.ok(routeFileExists(fb), `${fb} 不是既有路由`);
  }
  // 不准出现没落地的路由（例如 /assets、/settings、/agent 这些现场不存在的）。
  for (const href of hrefs) {
    if (href.startsWith("http")) continue; // QQ 群外链
    assert.ok(routeFileExists(href), `${href} 不是既有路由`);
  }
});

// ── ③b 被砍的 4 页降级页尾细字连结带（不变孤儿） ─────────────────────────────

test("页尾连结带含技能/工作流/状态/帮助 4 条真路由连结", () => {
  // 常数逐条对得上真路由档（不与元件同源的 oracle）。
  assert.deepEqual(
    MOBILE_SIDEBAR_FOOTER_LINKS.map((it) => it.href),
    ["/skills", "/workflows", "/status", "/use-cases"],
  );
  for (const { href } of MOBILE_SIDEBAR_FOOTER_LINKS) {
    assert.ok(routeFileExists(href), `页尾连结 ${href} 不是既有路由`);
  }
  // 元素树里真的渲染出这 4 条（标记 data-mobile-footer-link）。
  const footerLinks = renderPanel().filter(
    (el) => el.props["data-mobile-footer-link"] === "true",
  );
  assert.equal(footerLinks.length, 4, "页尾连结带应有 4 条");
  assert.deepEqual(
    footerLinks.map((el) => el.props.href).sort(),
    ["/skills", "/status", "/use-cases", "/workflows"],
  );
});

// ── ③c 帐号区补「账号设置」＋底部齿轮情境感知 ──────────────────────────────

test("④ 卷动区已无『账号设置』『退出登录』列，『加入 QQ 群』保留", () => {
  const els = renderPanel();
  assert.equal(
    els.find((el) => rowLabel(el) === "账号设置"),
    undefined,
    "『账号设置』列应已移除（回归 header）",
  );
  assert.equal(
    els.find((el) => rowLabel(el) === "退出登录"),
    undefined,
    "『退出登录』列应已移除（回归 header）",
  );
  // 两个图示 import 若不再使用就会是死码：KeyRound／LogOut 不应再出现在元件源码。
  assert.doesNotMatch(sidebarCode, /\bKeyRound\b/, "KeyRound 已无使用者，import 应移除");
  assert.doesNotMatch(sidebarCode, /\bLogOut\b/, "LogOut 已无使用者，import 应移除");
  // 死 prop：onLogout / isLoggedIn 不再出现在元件源码（已从 props 与容器移除）。
  assert.doesNotMatch(sidebarCode, /\bonLogout\b/, "onLogout 已是死 prop，应移除");
  assert.doesNotMatch(sidebarCode, /\bisLoggedIn\b/, "isLoggedIn 已是死 prop，应移除");
  // 「加入 QQ 群」保留（外部连结）。
  const qq = els.find((el) => el.props.href === QQ_GROUP_SHARE_URL);
  assert.ok(qq, "『加入 QQ 群』列必须保留");
  assert.equal(rowLabel(qq), "加入 QQ 群");
});

test("① dock 已无『搜索』钮，只剩齿轮＋黑色新对话 FAB（justify-between）", () => {
  const dock = renderPanel().find((el) => String(el.props.className ?? "").includes("mobile-sidebar-dock"));
  assert.ok(dock, "缺 .mobile-sidebar-dock");
  const bar = descendants(dock).find((el) => String(el.props.className ?? "").includes("lg-bar"));
  assert.ok(bar, "dock 缺 lg-bar 内层");
  assert.match(String(bar.props.className), /justify-between/, "dock 两端对齐（justify-between）");
  const buttons = descendants(dock).filter((el) => el.type === "button");
  assert.equal(buttons.length, 2, `dock 应只剩 2 颗按钮（齿轮＋FAB），实得 ${buttons.length}`);
  const labels = buttons.map((b) => b.props["aria-label"]);
  assert.ok(labels.includes("设置"), "dock 缺齿轮");
  assert.ok(labels.includes("新对话"), "dock 缺黑色 FAB");
  assert.ok(
    !buttons.some((b) => textOf(b).includes("搜索")),
    "dock 不应再有『搜索』字样的按钮",
  );
  // 不再有任何地方呼叫 searchInputRef.focus()（那是被删的搜索钮唯一作用）。
  assert.doesNotMatch(sidebarCode, /searchInputRef\?\.current\?\.focus\(\)/, "dock 搜索钮的 focus 呼叫应已移除");
});

test("③「对话」分节的搜寻框（唯一入口）仍在，且 searchInputRef 仍挂在它上", () => {
  const els = renderPanel();
  const input = els.find((el) => el.type === "input" && el.props["aria-label"] === "搜索对话");
  assert.ok(input, "『对话』分节的搜索框（唯一入口）不得移除");
  assert.equal(input.props.placeholder, "搜索对话");
  // searchInputRef 仍挂在对话搜寻框上（ref 不落在 element.props，用源码确认）。
  assert.match(sidebarCode, /ref=\{searchInputRef\}/, "searchInputRef 必须仍接在对话搜寻框上");
});

test("④ 面板内有承载底色的内层（.mobile-sidebar-bg），面板本体不含 backdrop-filter", () => {
  // 元素树：面板内真的渲染出承载底色的内层。
  const bg = renderPanel().find(
    (el) => String(el.props.className ?? "") === "mobile-sidebar-bg",
  );
  assert.ok(bg, "面板内缺承载底色的 .mobile-sidebar-bg 内层");
  // 面板本体规则：不得再有 backdrop-filter（材质已移到内层）。
  const panelBlock = /\.mobile-sidebar-panel\s*\{([^}]*)\}/.exec(sidebarCss)?.[1] ?? "";
  assert.ok(panelBlock, "找不到 .mobile-sidebar-panel 规则");
  assert.doesNotMatch(panelBlock, /backdrop-filter/, "面板本体不得再挂 backdrop-filter");
  // 内层＝不透明纯白（不是半透 0.96）。
  const bgBlock = /\.mobile-sidebar-bg\s*\{([^}]*)\}/.exec(sidebarCss)?.[1] ?? "";
  assert.ok(bgBlock, "找不到 .mobile-sidebar-bg 规则");
  assert.match(bgBlock, /position:\s*absolute/);
  assert.match(bgBlock, /inset:\s*0/);
  assert.match(bgBlock, /background:\s*(#fff|rgb\(255,\s*255,\s*255\))/, "内层底色＝不透明纯白");
  // scrim 的 blur(2px) 保留。
  const scrimBlock = /\.mobile-sidebar-scrim\s*\{([^}]*)\}/.exec(sidebarCss)?.[1] ?? "";
  assert.match(scrimBlock, /backdrop-filter:\s*blur\(2px\)/, "scrim 的 blur 保留");
});

test("底部 dock 齿轮＝button（情境感知动作桥），aria-label 仍是『设置』", () => {
  const gear = renderPanel().find((el) => el.props["aria-label"] === "设置");
  assert.ok(gear, "dock 缺 aria-label 为「设置」的齿轮");
  assert.equal(gear.type, "button", "齿轮应改为 <button>（动作桥派发）");
  assert.equal(gear.props.href, undefined, "齿轮不应再是 <Link>");
  assert.equal(gear.props["data-fallback-href"], "/settings/api-keys", "齿轮 fallback 应回帐号设置");
  // 容器：先关侧栏 → 派动作 → 没宿主才 router.push fallback。
  assert.match(sidebarCode, /requestAgentSurfaceAction\(action\)/);
  assert.match(sidebarCode, /if \(!requestAgentSurfaceAction\(action\)\) router\.push\(fallbackHref\)/);
  // 不准静态 import AgentChatSurface 取助理面动作（仍走动作桥）。
  assert.match(
    sidebarCode,
    /import \{\s*requestAgentSurfaceAction,\s*type AgentSurfaceAction,\s*\} from "@\/lib\/agent-surface-actions"/,
  );
});

test("『直接生成』/ 不冒充当前页（neverActive），只有不带 query 的纯连结才亮", () => {
  const navItem = MOBILE_SIDEBAR_NAV.find((it) => it.href === "/");
  assert.equal(navItem?.neverActive, true, "/ 这列必须标 neverActive");
  // 纯函式语意不变：/ 对 / 仍回 true（元件端靠 neverActive 关掉）。
  assert.equal(isSidebarNavActive("/", "/"), true);
  // 首页渲染：直接生成那颗 button 不得亮 aria-current。
  const exitBtn = renderPanel({ pathname: "/" }).find(
    (el) => el.props["data-agent-action"] === "exit",
  );
  assert.ok(exitBtn);
  assert.equal(exitBtn.props["aria-current"], undefined, "首页不得亮『直接生成』");
});

test("active 态只认不带 query 的路径连结", () => {
  assert.equal(isSidebarNavActive("/history", "/history"), true);
  assert.equal(isSidebarNavActive("/", "/history"), false);
  assert.equal(isSidebarNavActive("/", "/?agent=1"), false, "query 入口不冒充当前页");
});

test("对话分节复用既有 AgentSessionList，标题格式化只走动态 import 的唯一实作", () => {
  assert.match(sidebarCode, /import \{ AgentSessionList \} from "@\/components\/agent-chat\/AgentSessionList"/);
  // A（膨胀）：不准静态 import AgentChatSurface——Navbar 在 root layout，静态 import
  // 会把整条 agent-chat 模组图拉进全站每一页；唯一实作改在侧栏开启时动态载入。
  assert.doesNotMatch(
    sidebarCode,
    /import \{ formatSessionLabel \} from "@\/components\/agent-chat\/AgentChatSurface"/,
    "不准静态 import AgentChatSurface（会膨胀全站首包）",
  );
  assert.match(
    sidebarCode,
    /import\("@\/components\/agent-chat\/AgentChatSurface"\)/,
    "唯一实作必须以动态 import 取得",
  );
  assert.match(sidebarCode, /<AgentSessionList\b/);
  assert.match(sidebarCode, /formatLabel=\{formatLabel\}/);
  // 不准自造第二份标题格式化逻辑。
  assert.doesNotMatch(sidebarCode, /function formatSessionLabel/);
});

// ── ⑦ 当前会话高亮：读既有存档，坏 JSON 落回 null ─────────────────────────────

test("读存档取当前会话 id：坏 JSON／无存档回 null；合法存档按账号读取", () => {
  // 2026-10-19 账号隔离（95a27106）：存档键改为 `agent-chat-session-v1:user:<id>`，
  // 旧无归属键只经服务端归属核实后迁移、不得直接展示。这条继续钉「坏数据当无存档」
  // 与「合法存档回 sessionId」，并补上账号隔离的否定断言。
  const LEGACY_KEY = "agent-chat-session-v1";
  const KEY = `${LEGACY_KEY}:user:7`;
  const store = new Map<string, string>();
  const fakeLocalStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  const hadWindow = "window" in g;
  const prevWindow = g.window;
  const hadLocalStorage = "localStorage" in g;
  const prevLocalStorage = g.localStorage;
  g.window = { localStorage: fakeLocalStorage };
  g.localStorage = fakeLocalStorage;
  try {
    // 已登录账号（getStoredUser 读 napi_user）。
    store.set("napi_user", JSON.stringify({ id: 7, username: "tester" }));
    // 坏 JSON：照既有 sanitize 惯例当「没有存档」，不得 throw。
    store.set(KEY, "{ not valid json !!");
    assert.equal(readPersistedSessionId(), null);
    // 无存档。
    store.delete(KEY);
    assert.equal(readPersistedSessionId(), null);
    // 合法存档才回 sessionId（真源栏位名＝schema 的 sessionId）。
    store.set(
      KEY,
      JSON.stringify({ version: 1, sessionId: "sess-ok", lastEventId: 0, savedAt: Date.now(), items: [] }),
    );
    assert.equal(readPersistedSessionId(), "sess-ok");
    // 账号隔离：旧无归属键即便内容合法，也不得被直接当成当前会话。
    store.set(
      LEGACY_KEY,
      JSON.stringify({ version: 1, sessionId: "legacy-sess", lastEventId: 0, savedAt: Date.now(), items: [] }),
    );
    store.delete(KEY);
    assert.equal(
      readPersistedSessionId(),
      null,
      "旧无归属存档未经服务端核实迁移，不得直接展示",
    );
  } finally {
    if (hadLocalStorage) g.localStorage = prevLocalStorage;
    else delete g.localStorage;
    if (hadWindow) g.window = prevWindow;
    else delete g.window;
  }
});

// ── ④ 三条关闭路径 ──────────────────────────────────────────────────────────

test("关闭钮（真行为）：点下去呼叫 onClose", () => {
  let closed = 0;
  const els = renderPanel({ onClose: () => (closed += 1) });
  const closeBtn = els.find((el) => el.props["aria-label"] === "关闭导航");
  assert.ok(closeBtn, "侧栏必须有关闭钮");
  assert.equal(closeBtn.type, "button");
  (closeBtn.props.onClick as () => void)();
  assert.equal(closed, 1);
});

test("Esc 与遮罩点击两条关闭路径（容器行为）", () => {
  // Esc：keydown → Escape → onClose。
  assert.match(sidebarCode, /document\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(sidebarCode, /event\.key === "Escape"/);
  assert.match(sidebarCode, /onCloseRef\.current\(\)/);
  // 遮罩：只有点到 scrim 本身（不是面板内部）才关。
  assert.match(sidebarCode, /if \(event\.target === event\.currentTarget\) onClose\(\);/);
});

// ── ⑤ 滚动锁存还原 ──────────────────────────────────────────────────────────

test("body 滚动锁存原值再还原（与全出血锁共存）", () => {
  assert.match(sidebarCode, /const previousOverflow = document\.body\.style\.overflow/);
  assert.match(sidebarCode, /document\.body\.style\.overflow = "hidden"/);
  assert.match(sidebarCode, /document\.body\.style\.overflow = previousOverflow/);
  // 开场焦点进侧栏、关闭归还触发钮。
  assert.match(sidebarCode, /closeButtonRef\.current\?\.focus\(\)/);
  assert.match(sidebarCode, /triggerRef\?\.current\?\.focus\(\)/);
  // aria 契约。
  assert.match(sidebarCode, /role="dialog"/);
  assert.match(sidebarCode, /aria-modal="true"/);
  assert.match(sidebarCode, /aria-label="主导航"/);
  // reduced-motion 出口。
  assert.match(sidebarCss, /prefers-reduced-motion/);
});

// ── ⑥ 44px 触控目标 ＋ 无嵌套 button ────────────────────────────────────────

test("侧栏内每个可按元素触控目标 ≥44px（页尾细字连结带为既定例外）", () => {
  const interactive = renderPanel().filter((el) => {
    // 页尾「技能·工作流·状态·帮助」是刻意的小字连结带，不是 52px 列，排除。
    if (el.props["data-mobile-footer-link"] === "true") return false;
    const isButton = el.type === "button";
    const isLink = typeof el.props.href === "string";
    return isButton || isLink;
  });
  // 第四轮删掉「账号设置／退出登录／dock 搜索」三颗 ⇒ 常驻可按元素由 11 降为 8。
  assert.ok(interactive.length >= 8, `可按元素太少（${interactive.length}），侧栏没接上`);
  for (const el of interactive) {
    const cls = String(el.props.className ?? "");
    assert.match(
      cls,
      /(min-h-\[52px\]|\bh-11\b|\bh-12\b|\bh-14\b)/,
      `可按元素缺 44px 触控高度：${cls}`,
    );
    assert.match(cls, /touch-manipulation/, `可按元素缺 touch-manipulation：${cls}`);
  }
});

test("新元件不嵌套 button，也不改 agent-chat 档", () => {
  assert.ok(!hasNestedButtons(sidebarSrc), "MobileSidebar 不得有 button 套 button");
  // 只新建 mobile-nav 下的档：不得 import 或改动 agent-chat 目录下的 CSS。
  assert.doesNotMatch(sidebarCode, /import "\.\.\/agent-chat\/agent-chat\.css"/);
  assert.doesNotMatch(sidebarCode, /import "\.\.\/\.\.\/app\/globals\.css"/);
});

// ── ⑨ 手机字级对齐（2026-10-03 对标 Grok 侧栏）──────────────────────────────
// 说明：以下是 CSS/JSX 源码断言（变更探针）；渲染 oracle 由本地 390×844
// Playwright 实测承担（见回报数字）。

test("导览列标签 17px（text-ios-body 挂标签 span、不进 cn）＋列高 ≥52px＋icon 20px", () => {
  const els = renderPanel();
  const navItem = els.find((el) => el.props.href === "/history");
  assert.ok(navItem, "导览列缺 /history");
  const anchorCls = String(navItem.props.className ?? "");
  assert.match(anchorCls, /min-h-\[52px\]/, "导览列高必须 ≥52px（17px 不撑破/不挤掉垂直置中）");
  // twMerge 陷阱：cn() 会把不认识的 `text-ios-body` 归到 text-color 群组，再被同串
  // 之后的 `text-[rgba(…)]` 吃掉（实测 twMerge 直接移除）；所以 17px token 必须落在
  // 内层 span 的纯字串 className，不可放在 cn 的 anchor 上。
  assert.doesNotMatch(anchorCls, /\btext-ios-body\b/, "text-ios-body 不得放进 cn（会被 twMerge 吃掉）");
  const labelSpan = els.find(
    (el) => el.type === "span" && /\btext-ios-body\b/.test(String(el.props.className ?? "")),
  );
  assert.ok(labelSpan, "标签 span 缺 text-ios-body（17px）");
  assert.match(String(labelSpan.props.className), /truncate/);
  // icon：20px（h-5 w-5），与 17px 字级相衬、不被字级压过。
  assert.ok(
    els.some((el) => String(el.props.className ?? "") === "h-5 w-5 shrink-0"),
    "导览 icon 应为 20px（h-5 w-5）",
  );
});

test("侧栏作用域把 footnote 层抬到 14px 地板，且只作用 ≤639.98px", () => {
  const NARROW = "@media (max-width: 639.98px)";
  const at = sidebarCss.indexOf(NARROW);
  assert.ok(at >= 0, "mobile-sidebar.css 缺 ≤639.98px 地板块");
  const narrowBlock = sidebarCss.slice(at);
  // 2026-10-04 窄屏字级地板合并成一条分组规则（footnote／caption1／caption2／
  // 12-13px 裸值共用 14px），仍必须把 footnote 层包含在内。
  assert.match(
    narrowBlock,
    /\.mobile-sidebar-panel\s+\.text-ios-footnote\s*,[\s\S]{0,400}?\{[^}]*font-size:\s*14px/,
    "侧栏缺 footnote→14px 地板规则（会话日期行／身份副标）",
  );
  // 桌面 ≥640px 一字不动：14px 只准出现在窄屏块内。
  assert.ok(
    !sidebarCss.slice(0, at).includes("font-size: 14px"),
    "14px 地板泄漏到窄屏块之外",
  );
  // 共用件基础 class 不得被改：AgentSessionList 仍是 text-ios-footnote（13px）。
  const sessionListSrc = read("src/components/agent-chat/AgentSessionList.tsx");
  assert.match(
    sessionListSrc,
    /text-ios-subhead font-medium leading-snug/,
    "共用件 AgentSessionList 标题基础 class 被改动",
  );
  assert.match(
    sessionListSrc,
    /gap-1\.5 text-ios-footnote text-foreground\/45/,
    "共用件 AgentSessionList 日期行基础 class 被改动（应只在 mobile-sidebar.css 覆写）",
  );
});
