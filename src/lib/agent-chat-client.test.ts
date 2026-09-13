import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentChatError,
  buildEventsUrl,
  createDirectSendCapability,
  deriveMessagesUrl,
  readCachedAgentSettings,
  sendAgentMessage,
  writeCachedAgentSettings,
  DEFAULT_AGENT_SETTINGS,
} from "./agent-chat-client";

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

// ─── 09-12 直連發送腿（ticket-scoped direct POST to gateway）───
//
// 三態要求：票可用直連／票失效（401）回落／直連 5xx 回落不重放；
// 外加「無票＝純中繼（舊路徑逐字元等價）」與網路失手閂鎖。
// mock 方式：直接換 globalThis.fetch 記錄每一次請求（agentFetch 與直連腿
// 都走全域 fetch），風格對齊本檔既有的 window/localStorage 樁。

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const GATEWAY_EVENTS_URL = "https://store.tinchak0207.xyz/agent/v1/sessions/ses_abc/events";
const GATEWAY_MESSAGES_URL = "https://store.tinchak0207.xyz/agent/v1/sessions/ses_abc/messages";
const RELAY_MESSAGES_URL = "/api/agent/sessions/ses_abc/messages";

/** 「已登入 + fetch 可窵」的最小瀏覽器環境：authHeaders 讀 window/document/localStorage。 */
async function withClientEnv(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const store = new Map<string, string>();
  store.set("napi_token", "tok-1");
  store.set("napi_user", JSON.stringify({ id: 7, username: "u7" }));
  const localStorageStub = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const g = globalThis as Record<string, unknown>;
  const prev = { window: g.window, document: g.document, localStorage: g.localStorage, fetch: g.fetch };
  g.window = { localStorage: localStorageStub, location: { href: "https://image.test/" } };
  g.document = { cookie: "" };
  g.localStorage = localStorageStub;
  g.fetch = fetchImpl;
  try {
    await fn();
  } finally {
    g.window = prev.window;
    g.document = prev.document;
    g.localStorage = prev.localStorage;
    g.fetch = prev.fetch;
  }
}

function recorder(script: (url: string, index: number) => Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return script(url, calls.length - 1);
  };
  return { calls, fetchImpl };
}

const ok202 = () => new Response(JSON.stringify({ success: true }), { status: 202 });

test("state 1 — valid ticket: POST goes straight to gateway /messages, relay untouched", async () => {
  const { calls, fetchImpl } = recorder(async () => ok202());
  await withClientEnv(fetchImpl as typeof fetch, async () => {
    const cap = createDirectSendCapability();
    await sendAgentMessage("ses_abc", "  hi  ", undefined, {
      ticket: { ticket: "TK", events_url: GATEWAY_EVENTS_URL },
      capability: cap,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, GATEWAY_MESSAGES_URL);
    assert.equal(calls[0].method, "POST");
    // 憑證在 Authorization 頭（票不入 URL/query，防 nginx access log 記票）。
    assert.equal(calls[0].headers.Authorization, "Bearer TK");
    // 兩路徑語義等價：content 先 trim（中繼 handler 也會 trim 後才轉發）。
    assert.equal(JSON.parse(calls[0].body!).content, "hi");
    assert.equal(cap.rejected, false);
    assert.equal(cap.networkStrikes, 0);
  });
});

test("state 2 — dead ticket (401): falls back to relay exactly once and latches the ticket generation", async () => {
  const { calls, fetchImpl } = recorder(async (url) =>
    url.startsWith("http") ? new Response(JSON.stringify({ error: { message: "invalid ticket" } }), { status: 401 }) : ok202(),
  );
  await withClientEnv(fetchImpl as typeof fetch, async () => {
    const cap = createDirectSendCapability();
    const ctx = { ticket: { ticket: "TK", events_url: GATEWAY_EVENTS_URL }, capability: cap };
    await sendAgentMessage("ses_abc", "first", undefined, ctx);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, GATEWAY_MESSAGES_URL);
    assert.equal(calls[1].url, RELAY_MESSAGES_URL);
    // 回落走的是既有中繼：站內身份頭照常（token+user id 成對），零感知降級。
    assert.equal(calls[1].headers.Authorization, "Bearer tok-1");
    assert.equal(calls[1].headers["x-user-id"], "7");
    assert.equal(cap.rejected, true);

    // 閂鎖生效：同一票代的後續發送不再付直連學費。
    await sendAgentMessage("ses_abc", "second", undefined, ctx);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].url, RELAY_MESSAGES_URL);
  });
});

test("state 3 — direct 5xx: falls back to relay, never replays beyond one attempt, no latch", async () => {
  const { calls, fetchImpl } = recorder(async (url) =>
    url.startsWith("http") ? new Response("upstream exploded", { status: 502 }) : ok202(),
  );
  await withClientEnv(fetchImpl as typeof fetch, async () => {
    const cap = createDirectSendCapability();
    await sendAgentMessage("ses_abc", "hello", undefined, {
      ticket: { ticket: "TK", events_url: GATEWAY_EVENTS_URL },
      capability: cap,
    });
    // 恰兩次請求：1 直連 + 1 中繼；中繼成功後沒有第三次（永不重放）。
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, GATEWAY_MESSAGES_URL);
    assert.equal(calls[1].url, RELAY_MESSAGES_URL);
    // 5xx 是服務端瞬態不是「票無權限」：不閂鎖，下輪仍保留直連資格。
    assert.equal(cap.rejected, false);
  });
});

test("no ticket — legacy relay path, byte-for-byte as before", async () => {
  const { calls, fetchImpl } = recorder(async () => ok202());
  await withClientEnv(fetchImpl as typeof fetch, async () => {
    await sendAgentMessage("ses_abc", "plain", { sessionDirective: "guide" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, RELAY_MESSAGES_URL);
    const body = JSON.parse(calls[0].body!);
    assert.equal(body.content, "plain");
    assert.equal(body.session_directive, "guide");
  });
});

test("gateway deterministic 4xx (JSON error body): surfaces like relay, no fallback replay", async () => {
  const { calls, fetchImpl } = recorder(async () =>
    new Response(JSON.stringify({ error: { message: "session not found" } }), { status: 404 }),
  );
  await withClientEnv(fetchImpl as typeof fetch, async () => {
    await assert.rejects(
      sendAgentMessage("ses_abc", "hi", undefined, {
        ticket: { ticket: "TK", events_url: GATEWAY_EVENTS_URL },
        capability: createDirectSendCapability(),
      }),
      (err: unknown) => err instanceof AgentChatError && err.code === "not_found" && err.status === 404,
    );
    // 中繼轉發同一 body 也只會拿到同一個 404 —— 不應出現第二次請求。
    assert.equal(calls.length, 1);
  });
});

test("network errors: first falls back without latch, second latches the generation", async () => {
  const { calls, fetchImpl } = recorder(async (url) => {
    if (url.startsWith("http")) throw new TypeError("network down / CORS preflight rejected");
    return ok202();
  });
  await withClientEnv(fetchImpl as typeof fetch, async () => {
    const cap = createDirectSendCapability();
    const ctx = { ticket: { ticket: "TK", events_url: GATEWAY_EVENTS_URL }, capability: cap };
    await sendAgentMessage("ses_abc", "a", undefined, ctx);
    assert.equal(cap.rejected, false); // 一次可能是真網路抖動，保留資格
    await sendAgentMessage("ses_abc", "b", undefined, ctx);
    assert.equal(cap.rejected, true); // 連兩筆升閂鎖，止血
    await sendAgentMessage("ses_abc", "c", undefined, ctx);
    // 直連 3 次嘗試（前兩輪）＋中繼 3 次 + 第三輪只有中繼：共 5 筆。
    assert.equal(calls.length, 5);
    assert.equal(calls[4].url, RELAY_MESSAGES_URL);
  });
});

test("payload failing relay-equivalent pre-validation skips direct and lets relay answer canonically", async () => {
  const { calls, fetchImpl } = recorder(async () => ok202());
  await withClientEnv(fetchImpl as typeof fetch, async () => {
    const ctx = {
      ticket: { ticket: "TK", events_url: GATEWAY_EVENTS_URL },
      capability: createDirectSendCapability(),
    };
    await sendAgentMessage("ses_abc", "x".repeat(8001), undefined, ctx);
    await sendAgentMessage("ses_abc", "hi", { canvasState: "not-an-object" }, ctx);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.url === RELAY_MESSAGES_URL));
    assert.equal(ctx.capability.rejected, false); // 預檢攔下 ≠ 網關裁決，不計失手
  });
});

test("deriveMessagesUrl: only the relay's events-url shape converts", () => {
  assert.equal(deriveMessagesUrl(GATEWAY_EVENTS_URL), GATEWAY_MESSAGES_URL);
  assert.equal(deriveMessagesUrl("https://gw/agent/v1/sessions/s_1/events?x=1"), "https://gw/agent/v1/sessions/s_1/messages?x=1");
  assert.equal(deriveMessagesUrl("https://gw/agent/v1/sessions/s_1/events/extra"), null);
  assert.equal(deriveMessagesUrl("https://gw/api/whatever"), null);
  assert.equal(deriveMessagesUrl("not a url"), null);
});
