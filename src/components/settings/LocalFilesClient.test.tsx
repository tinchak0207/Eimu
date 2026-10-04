/** @jsxRuntime automatic @jsxImportSource react */
// LocalFilesClient 元件層測試（runner：npx --yes tsx --test；無 jsdom，用 react-dom/server）。
//
// 覆蓋：
//   1. 真元件 LocalFilesClient 在「無 window.eimuLocal」時 ⇒ 顯示「需要桌面版」、**不含開關**、
//      不含桌面殼面板（漸進增強，不是報錯）。
//   2. 展示層 LocalFilesView 各態渲染（離線文案／色調、已連上含資料夾清單、開關 aria 狀態）。
// 互動（按下開關叫 bridge.enable、選資料夾叫 pickFiles、卸載取消訂閱）由
// device-bridge-display.test.ts 對 controller 直接驗（同一份被元件驅動的邏輯）。

import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { LocalFilesClient, LocalFilesView, type LocalFilesViewProps } from "./LocalFilesClient.tsx";
import { describeBridgeStatus, type BridgeStatus } from "@/lib/device-bridge-display";

function status(partial: Partial<BridgeStatus> = {}): BridgeStatus {
  return { enabled: false, state: "off", roots: [], deviceId: null, ...partial };
}

function view(overrides: Partial<LocalFilesViewProps> = {}): string {
  const props: LocalFilesViewProps = {
    available: true,
    availability: { available: true, label: "", description: "" },
    display: describeBridgeStatus(status({ state: "off" })),
    enabled: false,
    loading: false,
    busy: false,
    notice: null,
    onToggle: () => {},
    onPickFolder: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(<LocalFilesView {...props} />);
}

// ─────────────────────────── 1. 真元件：無 eimuLocal（漸進增強）

test("真元件 + 無 window.eimuLocal：顯示『需要桌面版』且不含開關／桌面殼面板", () => {
  const g = globalThis as typeof globalThis & { eimuLocal?: unknown };
  const saved = g.eimuLocal;
  delete g.eimuLocal;
  try {
    const html = renderToStaticMarkup(<LocalFilesClient />);
    assert.match(html, /此功能需要桌面版/);
    assert.ok(html.includes('data-testid="bridge-unavailable"'), "應顯示『需要桌面版』區塊");
    assert.equal(html.includes('data-testid="bridge-enabled-surface"'), false, "純瀏覽器不得出桌面殼面板");
    assert.equal(html.includes('data-testid="bridge-toggle"'), false, "純瀏覽器不得顯示開關");
  } finally {
    if (saved === undefined) delete g.eimuLocal;
    else g.eimuLocal = saved;
  }
});

// ─────────────────────────── 2. 展示層：無 eimuLocal 分支

test("展示層 available:false ⇒ 只出『需要桌面版』，無開關、無選擇資料夾鈕", () => {
  const html = view({ available: false, availability: { available: false, label: "此功能需要桌面版", description: "下載桌面版後才能授權。" } });
  assert.match(html, /此功能需要桌面版/);
  assert.match(html, /下載桌面版後才能授權/);
  assert.equal(html.includes('data-testid="bridge-toggle"'), false);
  assert.equal(html.includes('data-testid="bridge-pick-folder"'), false);
});

// ─────────────────────────── 3. 展示層：三態

test("off 態：標籤『未開啟』、開關 aria-checked=false、資料夾清單空提示", () => {
  const html = view({ display: describeBridgeStatus(status({ state: "off" })) });
  assert.match(html, /未開啟/);
  assert.match(html, /aria-checked="false"/);
  assert.match(html, /尚未授權任何資料夾/);
  assert.ok(html.includes('data-testid="bridge-pick-folder"'), "有桌面殼即顯示選擇資料夾");
});

test("已開啟未選資料夾態：標籤與提示，開關 aria-checked=true", () => {
  const html = view({
    enabled: true,
    display: describeBridgeStatus(status({ state: "no_authorized_roots", enabled: true })),
  });
  assert.match(html, /已開啟 · 尚未選擇資料夾/);
  assert.match(html, /請先選擇要授權的資料夾/);
  assert.match(html, /aria-checked="true"/);
});

test("credentials_unavailable 態：逐字顯示裝置憑證說明", () => {
  const html = view({
    enabled: true,
    display: describeBridgeStatus(status({ state: "credentials_unavailable", enabled: true })),
  });
  assert.match(html, /桌面版還沒設定裝置憑證（見說明）；此功能需要一次性設定。/);
});

test("已連上態：標籤『已連上』並列出每個已授權資料夾", () => {
  const html = view({
    enabled: true,
    display: describeBridgeStatus(status({ state: "online", enabled: true, roots: ["/home/me/作品", "/mnt/data"] })),
  });
  assert.match(html, /已連上/);
  assert.match(html, /\/home\/me\/作品/);
  assert.match(html, /\/mnt\/data/);
  assert.ok(html.includes('data-testid="bridge-roots"'), "應有資料夾清單");
  assert.equal(html.includes('data-testid="bridge-roots-empty"'), false);
});

test("notice 渲染為錯誤提示；誠實說明含敏感路徑字樣", () => {
  const html = view({ notice: "E_DENIED：授權被拒" });
  assert.match(html, /E_DENIED：授權被拒/);
  assert.ok(html.includes('data-testid="bridge-notice"'));
  assert.match(html, /~\/\.ssh/);
  assert.match(html, /一律不讀/);
});