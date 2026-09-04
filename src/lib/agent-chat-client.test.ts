import test from "node:test";
import assert from "node:assert/strict";
import { buildEventsUrl, readCachedAgentSettings, writeCachedAgentSettings, DEFAULT_AGENT_SETTINGS } from "./agent-chat-client";

test("last_event_id=0 is sent: history switch relies on replay-from-zero", () => {
  const url = new URL(buildEventsUrl("https://gw/sessions/s1/events", "tk", 0));
  assert.equal(url.searchParams.get("last_event_id"), "0");
  assert.equal(url.searchParams.get("ticket"), "tk");
});

test("cursor above zero is sent as-is", () => {
  const url = new URL(buildEventsUrl("https://gw/sessions/s1/events", "tk", 231));
  assert.equal(url.searchParams.get("last_event_id"), "231");
});

test("absent cursor omits the param (legacy first-open behavior)", () => {
  const url = new URL(buildEventsUrl("https://gw/sessions/s1/events", "tk"));
  assert.equal(url.searchParams.get("last_event_id"), null);
});

// ─── 设定缓存 sanitize（interaction_mode 白名单清洗）───

/** node 环境没有 window：临时挂一个最小 localStorage 桩驱动缓存路径。 */
function withLocalStorage(fn: () => void): void {
  const store = new Map<string, string>();
  const stub = {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  } as unknown as typeof globalThis & { localStorage: Storage };
  const prevWindow = globalThis.window;
  (globalThis as { window?: unknown }).window = stub;
  try {
    fn();
  } finally {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
}

test("interaction_mode invalid value falls back to default preset", () => {
  withLocalStorage(() => {
    writeCachedAgentSettings({ ...DEFAULT_AGENT_SETTINGS, interaction_mode: "chaos" as never });
    const s = readCachedAgentSettings();
    assert.equal(s.interaction_mode, "preset");
    assert.equal(s.cost_mode, "balanced");
  });
});

test("interaction_mode legal values roundtrip through the cache", () => {
  withLocalStorage(() => {
    for (const mode of ["collaborate", "preset", "auto"] as const) {
      writeCachedAgentSettings({ ...DEFAULT_AGENT_SETTINGS, interaction_mode: mode });
      assert.equal(readCachedAgentSettings().interaction_mode, mode);
    }
  });
});

test("legacy cache object missing interaction_mode is patched with default without throwing", () => {
  withLocalStorage(() => {
    // 直接塞旧版缓存原文（缺 interaction_mode 字段），模拟历史 localStorage。
    globalThis.window!.localStorage.setItem(
      "agent-settings-v1",
      JSON.stringify({ interrupt_mode: "queue", persona: "thoughtful", cost_mode: "premium" }),
    );
    const s = readCachedAgentSettings();
    assert.equal(s.interrupt_mode, "queue");
    assert.equal(s.persona, "thoughtful");
    assert.equal(s.cost_mode, "premium");
    assert.equal(s.interaction_mode, "preset");
  });
});
