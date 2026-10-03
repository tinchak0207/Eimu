import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentChatError,
  buildEventsUrl,
  createDirectSendCapability,
  deriveMessagesUrl,
  isSteerReplayRejected,
  isSteerUnavailableError,
  readCachedAgentSettings,
  readCachedAgentThinkingLevel,
  resolveAgentThinkingLevel,
  inferAgentThinkingLevel,
  agentThinkingLevelPatch,
  AGENT_THINKING_LEVELS,
  AGENT_THINKING_LEVEL_SETTINGS,
  AGENT_THINKING_LEVEL_LABELS,
  AGENT_THINKING_LEVEL_STORAGE_KEY,
  steerReplayStatus,
  sendAgentMessage,
  steerAgentSession,
  writeCachedAgentSettings,
  writeCachedAgentThinkingLevel,
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

// ─── REQ-D2（2026-09-23 F-D2）：steer 端點的 409 契約 ───

test("steer 409：网關回「当前没有正在进行中的回合」→ 分类为 no_active_turn（前端据此改走正常送出）", async () => {
  const { fetchImpl } = recorder(async () =>
    new Response(
      JSON.stringify({
        error: { message: "当前没有正在进行中的回合，请直接发送消息", type: "no_active_turn", code: "no_active_turn" },
      }),
      { status: 409 },
    ),
  );
  await withClientEnv(fetchImpl as typeof fetch, async () => {
    let caught: unknown = null;
    try {
      await steerAgentSession("ses_abc", "先改成冷色调", { steerId: "steer-1" });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof AgentChatError, "409 必须抛 AgentChatError，不能当成成功吞掉");
    assert.equal((caught as AgentChatError).status, 409);
    assert.equal(
      isSteerUnavailableError(caught),
      true,
      "409 = 「没有可引导的回合」契约 → 调用端必须能识别并落回正常送出（D2-2：否则消息被吞）",
    );
  });
});

test("steer 409（turn_aborted 变体）：同样识别为「不可引导」，而非失败的引导", async () => {
  const { fetchImpl } = recorder(async () =>
    new Response(JSON.stringify({ error: { message: "本轮已中止", type: "turn_aborted", code: "turn_aborted" } }), {
      status: 409,
    }),
  );
  await withClientEnv(fetchImpl as typeof fetch, async () => {
    let caught: unknown = null;
    try {
      await steerAgentSession("ses_abc", "先改成冷色调");
    } catch (err) {
      caught = err;
    }
    assert.equal(isSteerUnavailableError(caught), true);
  });
});

test("steer 其它错误不得被误判成 409：网络/服务器错误该走「未生效」提示", async () => {
  const { fetchImpl } = recorder(async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 502 }));
  await withClientEnv(fetchImpl as typeof fetch, async () => {
    let caught: unknown = null;
    try {
      await steerAgentSession("ses_abc", "先改成冷色调");
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof AgentChatError);
    assert.equal(isSteerUnavailableError(caught), false, "5xx / 网络错误不是「没有回合」，不得落回正常送出");
    assert.equal(isSteerUnavailableError(new Error("plain")), false, "非 AgentChatError 一律不是");
  });
});

// ─── REQ-D2b（2026-09-23）：steer 重放拒绝不得被当成「没有可引导的回合」───

test("D2b steer 重放被拒：可辨识码 + 不落回正常送出 + 透传既有真实状态", async () => {
  const { calls, fetchImpl } = recorder(async () =>
    new Response(
      JSON.stringify({
        error: { message: "这条引导已经有结果了，不会重复发送", type: "steer_replay_settled", code: "steer_replay_settled" },
        steer_id: "steer-1",
        status: "uncertain",
      }),
      { status: 409 },
    ),
  );
  await withClientEnv(fetchImpl as typeof fetch, async () => {
    let caught: unknown = null;
    try {
      await steerAgentSession("ses_abc", "先改成冷色调", { steerId: "steer-1" });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof AgentChatError, "重放拒绝必须抛错，不能静默接受成第二次投递");
    assert.equal((caught as AgentChatError).code, "steer_replay_rejected");
    assert.equal((caught as AgentChatError).status, 409);
    assert.equal(isSteerReplayRejected(caught), true);
    assert.equal(
      isSteerUnavailableError(caught),
      false,
      "同样 409 但语义相反：重放被拒 = 不要再送（落回正常送出就等于把同一指引送第二次）",
    );
    assert.equal(steerReplayStatus(caught), "uncertain", "透传网關带回的既有真实状态");
    assert.equal(calls.length, 1);
  });
});

test("D2b 其余重放码同样归类（in_flight / payload_mismatch / id_conflict）", async () => {
  for (const code of ["steer_replay_in_flight", "steer_payload_mismatch", "steer_id_conflict"]) {
    const { fetchImpl } = recorder(async () =>
      new Response(JSON.stringify({ error: { message: "no", type: code, code }, steer_id: "s1", status: "applied" }), {
        status: 409,
      }),
    );
    await withClientEnv(fetchImpl as typeof fetch, async () => {
      let caught: unknown = null;
      try {
        await steerAgentSession("ses_abc", "x", { steerId: "s1" });
      } catch (err) {
        caught = err;
      }
      assert.equal(isSteerReplayRejected(caught), true, `${code} 必须归类为 steer_replay_rejected`);
      assert.equal(isSteerUnavailableError(caught), false, `${code} 不得落回正常送出`);
      assert.equal(steerReplayStatus(caught), "applied", `${code} 必须透传真实状态`);
    });
  }
});

test("D2b 状态兜底：带不出真实状态时一律 uncertain，绝不回 queued", () => {
  assert.equal(steerReplayStatus(new AgentChatError("steer_replay_rejected", "x", 409)), "uncertain");
  assert.equal(steerReplayStatus(new Error("plain")), "uncertain");
  // 网關不会说 queued（那是「等一张永远不会来的终态帧」），认不得就退回 uncertain。
  assert.equal(steerReplayStatus(new AgentChatError("steer_replay_rejected", "x", 409, "queued")), "uncertain");
  assert.equal(steerReplayStatus(new AgentChatError("steer_replay_rejected", "x", 409, "injected")), "injected");
  assert.equal(isSteerReplayRejected(new AgentChatError("no_active_turn", "x", 409)), false);
});

// ─── 思考级别（2026-10-03）：mapping 唯一真源 + 持久化/反推 ───

test("思考级别 → AgentSettings 三栏 mapping：四档 × 三栏逐条钉死", () => {
  // 这张表是输入框「+」右上角菜单的唯一真源；四档必须各自可被直接断言。
  assert.deepEqual(AGENT_THINKING_LEVELS, ["low", "medium", "high", "extreme"]);
  const expected = {
    low: { persona: "efficient", cost_mode: "economy", beast_mode: false },
    medium: { persona: "efficient", cost_mode: "balanced", beast_mode: false },
    high: { persona: "thoughtful", cost_mode: "balanced", beast_mode: false },
    extreme: { persona: "thoughtful", cost_mode: "premium", beast_mode: true },
  } as const;
  for (const level of AGENT_THINKING_LEVELS) {
    assert.deepEqual(AGENT_THINKING_LEVEL_SETTINGS[level], expected[level], `档位 ${level} 的三栏映射`);
  }
  // patch 只带三栏，绝不把 interrupt_mode 塞进思考级别（它保持用户原值）。
  for (const level of AGENT_THINKING_LEVELS) {
    assert.deepEqual(Object.keys(agentThinkingLevelPatch(level)).sort(), ["beast_mode", "cost_mode", "persona"]);
    assert.ok(!("interrupt_mode" in agentThinkingLevelPatch(level)));
  }
  // 显示名逐一对应（简体中文）。
  assert.deepEqual(AGENT_THINKING_LEVEL_LABELS, { low: "低", medium: "中", high: "高", extreme: "极限" });
});

test("思考级别反推：四档 settings 各自反推回本档；映射覆盖不到的组合回 null", () => {
  for (const level of AGENT_THINKING_LEVELS) {
    const settings = { ...DEFAULT_AGENT_SETTINGS, ...AGENT_THINKING_LEVEL_SETTINGS[level] };
    assert.equal(inferAgentThinkingLevel(settings), level, `${level} 的 settings 应反推回 ${level}`);
  }
  // 非满射证据：premium + efficient（mapping 表达不出）→ null。
  const unroutable = { ...DEFAULT_AGENT_SETTINGS, persona: "efficient" as const, cost_mode: "premium" as const, beast_mode: false };
  assert.equal(inferAgentThinkingLevel(unroutable), null);
});

test("思考级别持久化：显式记录优先；无记录反推；反推不到显示「中」且不改写 settings", () => {
  withLocalStorage(() => {
    // ① 显式记录优先：即使 settings 是别的档，也按记录显示。
    writeCachedAgentThinkingLevel("extreme");
    const extreme = { ...DEFAULT_AGENT_SETTINGS, ...AGENT_THINKING_LEVEL_SETTINGS.extreme };
    assert.equal(readCachedAgentThinkingLevel(), "extreme");
    assert.equal(resolveAgentThinkingLevel(extreme), "extreme");

    // ② 清掉记录后改由 settings 反推。
    globalThis.window!.localStorage.removeItem(AGENT_THINKING_LEVEL_STORAGE_KEY);
    assert.equal(resolveAgentThinkingLevel(extreme), "extreme", "无记录时由 settings 反推");

    // ③ 反推不到：显示「中」，且不得改写用户的 settings / 不留级别记录。
    const unroutable = { ...DEFAULT_AGENT_SETTINGS, persona: "efficient" as const, cost_mode: "premium" as const, beast_mode: false };
    writeCachedAgentSettings(unroutable);
    assert.equal(inferAgentThinkingLevel(readCachedAgentSettings()), null, "premium+efficient 反推不到");
    assert.equal(resolveAgentThinkingLevel(readCachedAgentSettings()), "medium", "反推不到显示中");
    assert.deepEqual(readCachedAgentSettings(), unroutable, "反推失败绝不改写 settings");
    assert.equal(readCachedAgentThinkingLevel(), null, "反推失败不私自记一个级别");
  });
});
