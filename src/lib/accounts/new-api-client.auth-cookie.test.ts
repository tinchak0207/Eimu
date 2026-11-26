import test from "node:test";
import assert from "node:assert/strict";
import { getStoredToken, getStoredUser, setStoredToken, syncStoredAuthFromCookie } from "./new-api-client.ts";

const sampleUser = {
  id: 42,
  username: "github_123456789",
  display_name: "github_123456789",
  email: "github-123456789-gh4@users.noreply.github.com",
  quota: 0,
  used_quota: 0,
};

/** 桥接浏览器环境；withLocalStorage=false 模拟 localStorage 被清空。 */
function installBrowserEnv(cookie: string, withLocalStorage: boolean): void {
  const storage = new Map<string, string>();
  const ls = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  globalThis.localStorage = (withLocalStorage
    ? ls
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} }) as Storage;
  globalThis.window = {
    location: { href: "https://image.tinchak0207.xyz/?auth=github", pathname: "/", search: "?auth=github", hash: "" },
    history: { replaceState: (_state: unknown, _title: string, url: string) => { globalThis.window.location.href = url; } },
    localStorage: globalThis.localStorage,
  } as unknown as Window & typeof globalThis;

  // 模拟浏览器的 document.cookie：setter 是「追加+覆盖同名」，getter 返回全部。
  const map = new Map<string, string>();
  if (cookie) cookie.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx > 0) map.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  });
  const getter = () => Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
  const setter = (value: string) => {
    value.split(";").forEach((seg) => {
      const idx = seg.indexOf("=");
      if (idx < 0) return;
      const name = seg.slice(0, idx).trim();
      const val = seg.slice(idx + 1).trim();
      if (val === "" || /max-age=0/.test(val) || /expires=Thu, 01 Jan 1970/.test(val)) map.delete(name);
      else map.set(name, val);
    });
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { get cookie() { return getter(); }, set cookie(v: string) { setter(v); } },
  });
}

test("syncStoredAuthFromCookie copies github callback cookies into localStorage", () => {
  const cookie = `napi_token=tok123; napi_user=${encodeURIComponent(JSON.stringify(sampleUser))}`;
  installBrowserEnv(cookie, true);

  assert.equal(syncStoredAuthFromCookie(), true);
  assert.equal(getStoredToken(), "tok123");
  assert.equal(getStoredUser()?.username, "github_123456789");
  assert.equal(globalThis.window.location.href, "/");
});

test("setStoredToken writes a persistent cookie (cookie 固化)", () => {
  installBrowserEnv("", true);
  setStoredToken("tok456", sampleUser);

  const cookie = globalThis.document.cookie;
  assert.match(cookie, /napi_token=tok456/);
  assert.match(cookie, /napi_user=/);
  assert.match(cookie, /max-age/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /path=\/;/);
});

test("getStoredToken falls back to the cookie when localStorage is empty (localStorage 被清仍不掉登录)", () => {
  const cookie = `napi_token=cookie_tok; napi_user=${encodeURIComponent(JSON.stringify(sampleUser))}`;
  installBrowserEnv(cookie, false); // localStorage 空 → 从 cookie 恢复

  assert.equal(getStoredToken(), "cookie_tok");
  assert.equal(getStoredUser()?.username, "github_123456789");
});
