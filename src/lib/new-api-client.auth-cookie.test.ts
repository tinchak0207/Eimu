import test from "node:test";
import assert from "node:assert/strict";
import { getStoredToken, getStoredUser, syncStoredAuthFromCookie } from "./new-api-client.ts";

test("syncStoredAuthFromCookie copies github callback cookies into localStorage", () => {
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  globalThis.localStorage = localStorage as Storage;
  globalThis.window = {
    location: { href: "https://image.tinchak0207.xyz/?auth=github", pathname: "/", search: "?auth=github", hash: "" },
    history: { replaceState: (_state: unknown, _title: string, url: string) => { globalThis.window.location.href = url; } },
    localStorage,
  } as unknown as Window & typeof globalThis;
  globalThis.document = {
    cookie: `napi_token=tok123; napi_user=${encodeURIComponent(JSON.stringify({
      id: 42,
      username: "github_123456789",
      display_name: "github_123456789",
      email: "github-123456789-gh4@users.noreply.github.com",
      quota: 0,
      used_quota: 0,
    }))}`,
  } as Document;

  assert.equal(syncStoredAuthFromCookie(), true);
  assert.equal(getStoredToken(), "tok123");
  assert.equal(getStoredUser()?.username, "github_123456789");
  assert.equal(globalThis.window.location.href, "/");
});
