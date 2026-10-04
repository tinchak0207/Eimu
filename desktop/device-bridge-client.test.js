// desktop/device-bridge-client.test.js
//
// W6b 客户端编排层测试：不连真闸道（stub global.fetch）。覆盖两条先前无测试的路径：
//   - H1：无授权根 ⇒ 执行器一律拒；startDeviceBridge 直接拒绝服务。
//   - M4：错误回报必须带 consent_token（否则闸道 result 先 consume 一律 not_found）。
// 跑法：npx --yes tsx --test desktop/device-bridge-client.test.js
// 注：本档在纯 node 下可 require（electron 未就绪时 require("electron") 只回路径字串，
//     模组顶层不呼叫任何 electron API）。

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nodeFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const client = require("./device-bridge-client.js");
const localWorker = require("./local-worker.js");

/** stub global.fetch，回传收到的请求并固定回 {ok:true}。 */
async function withFetchStub(fn) {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { status: 200, json: async () => ({ ok: true }) };
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = orig;
  }
}

test("H1(e2e): 无授权根 ⇒ handleRequest 执行被拒且回报带票", async () => {
  const { handleRequest, runtime } = client.__test;
  runtime.deviceId = "dev-1";
  runtime.connectionId = "conn-1";
  const tmp = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), "eimu-bridge-cli-")));
  try {
    const f = path.join(tmp, "a.txt");
    nodeFs.writeFileSync(f, "hi");
    assert.equal(localWorker.authorizedRoots.size, 0, "测试前提：授权根为空");
    await withFetchStub(async (calls) => {
      await handleRequest({ request_id: "r1", consent_token: "tok-1", tool: "read_file", args: { path: f } });
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/agent\/v1\/device-bridge\/result$/);
      assert.equal(calls[0].body.consent_token, "tok-1");
      assert.match(String(calls[0].body.error), /no_authorized_roots/);
    });
  } finally {
    nodeFs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("H1: 无授权根 ⇒ startDeviceBridge 拒绝服务（no_authorized_roots）", async () => {
  const snap = await client.startDeviceBridge({ enabled: true, credentialProvider: () => "cred" });
  assert.equal(snap.status, "no_authorized_roots");
  client.stopDeviceBridge();
});

test("M4: 错误回报（tool_not_allowed）带 consent_token", async () => {
  const { handleRequest, runtime } = client.__test;
  runtime.deviceId = "dev-2";
  runtime.connectionId = "conn-2";
  await withFetchStub(async (calls) => {
    await handleRequest({ request_id: "r2", consent_token: "tok-2", tool: "exec", args: {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.consent_token, "tok-2");
    assert.match(String(calls[0].body.error), /tool_not_allowed/);
  });
});

test("M4: 错误回报（consent_token_expired）带 consent_token", async () => {
  const { handleRequest, runtime } = client.__test;
  runtime.deviceId = "dev-3";
  runtime.connectionId = "conn-3";
  await withFetchStub(async (calls) => {
    await handleRequest({ request_id: "r3", consent_token: "tok-3", tool: "read_file", args: { path: "/tmp/x" }, expires_at: 1 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.consent_token, "tok-3");
    assert.match(String(calls[0].body.error), /consent_token_expired/);
  });
});

// ── W6c：register 带 mode/rules（加性；未提供＝不下发，维持既有呼叫端行为）──────

/**
 * stub：register 成功，poll 卡住（永不结算，避免长轮询回圈在测试中空转）。
 * 只拦 register 的 body 以断言；不连真闸道。
 */
async function withRegisterStub(fn) {
  const calls = [];
  const orig = global.fetch;
  global.fetch = (url, init) => {
    const u = String(url);
    calls.push({ url: u, body: init && init.body ? JSON.parse(init.body) : null });
    if (/\/register$/.test(u)) {
      return Promise.resolve({
        status: 200,
        json: async () => ({ ok: true, device_id: "d1", connection_id: "c1", heartbeat_interval_ms: 60000 }),
      });
    }
    if (/\/poll$/.test(u)) return new Promise(() => {}); // 不结算
    return Promise.resolve({ status: 200, json: async () => ({ ok: true }) });
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = orig;
    client.stopDeviceBridge();
    client.__test.runtime.mode = null;
    client.__test.runtime.rules = undefined;
    client.__test.runtime.roots = null;
    client.__test.runtime.installDeviceId = null;
    client.__test.runtime.consentRoots = [];
    client.__test.runtime.persistConsentRoots = null;
    client.__test.runtime.auditConsent = null;
  }
}

function mkRoot() {
  return nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), "eimu-bridge-reg-")));
}

test("register: 提供 modeProvider/rulesProvider ⇒ body 带 mode 与 rules", async () => {
  localWorker.authorizedRoots.clear();
  const root = mkRoot();
  localWorker.authorizeRoots([root]);
  try {
    const calls = await withRegisterStub(async (calls) => {
      await client.startDeviceBridge({
        enabled: true,
        gatewayBaseUrl: "http://127.0.0.1:1",
        credentialProvider: () => "cred-fake",
        modeProvider: () => "auto",
        rulesProvider: () => [{ effect: "allow", tool: "read_file" }],
      });
      // snapshot 透传 mode（供 bridge.status()）；在 stop 前断言。
      assert.equal(client.getDeviceBridgeState().mode, "auto");
      return calls;
    });
    const reg = calls.find((c) => /\/register$/.test(c.url));
    assert.ok(reg, "必须发出 register");
    assert.equal(reg.body.mode, "auto");
    assert.deepEqual(reg.body.rules, [{ effect: "allow", tool: "read_file" }]);
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

test("register: 未提供 modeProvider/rulesProvider ⇒ 不下发 mode/rules 栏位（既有行为不变）", async () => {
  localWorker.authorizedRoots.clear();
  const root = mkRoot();
  localWorker.authorizeRoots([root]);
  try {
    const calls = await withRegisterStub(async (calls) => {
      await client.startDeviceBridge({
        enabled: true,
        gatewayBaseUrl: "http://127.0.0.1:1",
        credentialProvider: () => "cred-fake",
      });
      return calls;
    });
    const reg = calls.find((c) => /\/register$/.test(c.url));
    assert.ok(reg);
    assert.equal(Object.prototype.hasOwnProperty.call(reg.body, "mode"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(reg.body, "rules"), false);
    assert.equal(client.getDeviceBridgeState().mode, null);
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

test("register: modeProvider 回非法值 ⇒ 不下发 mode（注入点验值，不硬塞坏值）", async () => {
  localWorker.authorizedRoots.clear();
  const root = mkRoot();
  localWorker.authorizeRoots([root]);
  try {
    const calls = await withRegisterStub(async (calls) => {
      await client.startDeviceBridge({
        enabled: true,
        gatewayBaseUrl: "http://127.0.0.1:1",
        credentialProvider: () => "cred-fake",
        modeProvider: () => "bogus",
      });
      return calls;
    });
    const reg = calls.find((c) => /\/register$/.test(c.url));
    assert.equal(Object.prototype.hasOwnProperty.call(reg.body, "mode"), false);
    assert.equal(client.getDeviceBridgeState().mode, null);
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

// ── roots 上报（缺陷回归）：register body 必须真的带 roots ──────────────────
// 教训：只断言「有呼叫 register」抓不到漏传栏位（见 2026-10-04-fetch-receiver-test-green-prod-broken）。
// 这里断言请求 body 的**内容**：body.roots 逐值等于注入的 rootsProvider() 回传。

test("register: body 必须带 roots，且值等于注入的 rootsProvider() 回传", async () => {
  localWorker.authorizedRoots.clear();
  const root = mkRoot();
  const injected = [root];
  try {
    const calls = await withRegisterStub(async (calls) => {
      await client.startDeviceBridge({
        enabled: true,
        gatewayBaseUrl: "http://127.0.0.1:1",
        credentialProvider: () => "cred-fake",
        rootsProvider: () => injected.slice(),
      });
      return calls;
    });
    const reg = calls.find((c) => /\/register$/.test(c.url));
    assert.ok(reg, "必须发出 register");
    assert.ok(Array.isArray(reg.body.roots), "register body 必须含 roots 阵列（漏传即闸道 no_authorized_root）");
    assert.deepEqual(reg.body.roots, injected);
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

test("register(边界): rootsProvider 回空阵列 ⇒ 拒绝服务且不发出任何 register", async () => {
  localWorker.authorizedRoots.clear();
  const calls = await withRegisterStub(async (calls) => {
    const snap = await client.startDeviceBridge({
      enabled: true,
      gatewayBaseUrl: "http://127.0.0.1:1",
      credentialProvider: () => "cred-fake",
      rootsProvider: () => [],
    });
    assert.equal(snap.status, "no_authorized_roots", "空 roots 一律拒服务（H1 不变）");
    return calls;
  });
  assert.equal(
    calls.some((c) => /\/register$/.test(c.url)),
    false,
    "空 roots 不得注册（不误送空授权集）",
  );
});

test("register: 授权根变更 → 重注册时 body 带『新的』roots", async () => {
  localWorker.authorizedRoots.clear();
  const rootA = mkRoot();
  const rootB = mkRoot();
  try {
    const calls = await withRegisterStub(async (calls) => {
      await client.startDeviceBridge({
        enabled: true,
        gatewayBaseUrl: "http://127.0.0.1:1",
        credentialProvider: () => "cred-fake",
        rootsProvider: () => [rootA],
      });
      // stop→start（与 local-worker startNow 同路径）：换 roots 必须重注册。
      client.stopDeviceBridge();
      await client.startDeviceBridge({
        enabled: true,
        gatewayBaseUrl: "http://127.0.0.1:1",
        credentialProvider: () => "cred-fake",
        rootsProvider: () => [rootA, rootB],
      });
      return calls;
    });
    const regs = calls.filter((c) => /\/register$/.test(c.url));
    assert.equal(regs.length, 2, "应有两次 register（stop→start 重注册）");
    assert.deepEqual(regs[0].body.roots, [rootA]);
    assert.deepEqual(regs[1].body.roots, [rootA, rootB], "重注册必须带新的 roots");
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(rootA, { recursive: true, force: true });
    nodeFs.rmSync(rootB, { recursive: true, force: true });
  }
});

// ── 稳定 deviceId（缺陷回归）：同一次安装重注册必须带同一个 device_id ──────────
// 症状：register 不带 device_id ⇒ 闸道每次重连都 randomId("dev") 配「新的」deviceId
// ⇒ 同一 tenant 的 devices 表在 heartbeat TTL 内累积多笔 online ⇒ pickDeviceForTenant
// 回 device_ambiguous，或把请求送到已死那台 ⇒ 同一壳内第二发 invoke 起吃满 30s 的
// `device_request_timeout`。
//
// 正解在装置端（闸道「多台 ambiguous 不猜」是刻意的安全语义，不动）：同一安装回报
// **稳定** deviceId，让重注册取代同一笔 `deviceKey(tenant, deviceId)` 纪录。
// 契约：main.js 产生并持久化一枚 stable id（settings.json 白名单栏位
// deviceBridgeDeviceId），经 deviceIdProvider 注入 client；register body 带 device_id。

/** 假 settings store：模拟 settings.json 白名单栏位的读写（不碰真档）。 */
function fakeSettingsStore(initial) {
  let value = initial;
  let writes = 0;
  return {
    read: () => value,
    write: (v) => {
      value = v;
      writes += 1;
    },
    get value() {
      return value;
    },
    get writes() {
      return writes;
    },
  };
}

test("deviceId: 无既有值 ⇒ 产生一次并写入；同 store 再读不重生", () => {
  const store = fakeSettingsStore(undefined);
  const a = client.resolveStableDeviceId(store);
  assert.equal(typeof a, "string");
  assert.ok(a.length > 0, "产生的 deviceId 必须非空");
  assert.equal(store.value, a, "必须写回 store（持久化）");
  assert.equal(store.writes, 1, "只写一次");
  const b = client.resolveStableDeviceId(store);
  assert.equal(b, a, "第二次回同一 id");
  assert.equal(store.writes, 1, "第二次不重生、不再写");
});

test("deviceId: store 已有合法值 ⇒ 直接沿用（不重生、不覆写）", () => {
  const store = fakeSettingsStore("dev_existing0001");
  assert.equal(client.resolveStableDeviceId(store), "dev_existing0001");
  assert.equal(store.writes, 0, "已有值不得写入");
});

test("deviceId: store 坏值（空字串／非字串）⇒ 视为无值，重生一次", () => {
  const empty = fakeSettingsStore("   ");
  const id = client.resolveStableDeviceId(empty);
  assert.ok(id.length > 0 && id !== "   ");
  assert.equal(empty.value, id);
  assert.equal(empty.writes, 1);
});

test("register: body 必须带非空 device_id（注入 deviceIdProvider）", async () => {
  localWorker.authorizedRoots.clear();
  const root = mkRoot();
  localWorker.authorizeRoots([root]);
  const stable = "dev_teststable0001";
  try {
    const calls = await withRegisterStub(async (calls) => {
      await client.startDeviceBridge({
        enabled: true,
        gatewayBaseUrl: "http://127.0.0.1:1",
        credentialProvider: () => "cred-fake",
        deviceIdProvider: () => stable,
      });
      return calls;
    });
    const reg = calls.find((c) => /\/register$/.test(c.url));
    assert.ok(reg, "必须发出 register");
    assert.equal(reg.body.device_id, stable, "register body 必须带注入的 device_id");
    assert.ok(String(reg.body.device_id).length > 0, "device_id 必须非空");
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

test("register: 两次连续启动（stop→start）送同一个 device_id，且不重生", async () => {
  localWorker.authorizedRoots.clear();
  const root = mkRoot();
  localWorker.authorizeRoots([root]);
  // 模拟 main.js：provider 每次向「同一份」持久化 store 取 id。
  const store = fakeSettingsStore(undefined);
  const deviceIdProvider = () => client.resolveStableDeviceId(store);
  try {
    const regs = await withRegisterStub(async (calls) => {
      await client.startDeviceBridge({
        enabled: true,
        gatewayBaseUrl: "http://127.0.0.1:1",
        credentialProvider: () => "cred-fake",
        deviceIdProvider,
      });
      client.stopDeviceBridge();
      await client.startDeviceBridge({
        enabled: true,
        gatewayBaseUrl: "http://127.0.0.1:1",
        credentialProvider: () => "cred-fake",
        deviceIdProvider,
      });
      return calls.filter((c) => /\/register$/.test(c.url));
    });
    assert.equal(regs.length, 2, "stop→start 应有两次 register");
    assert.ok(regs[0].body.device_id, "第一次 register 必须带 device_id");
    assert.equal(regs[0].body.device_id, regs[1].body.device_id, "两次 register 必须是同一个 device_id");
    assert.equal(regs[0].body.device_id, store.value, "送出的 id 必须是持久化 store 的值");
    assert.equal(store.writes, 1, "两次启动只产生一次（不重生）");
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

// 边界：deviceIdProvider 回非法值 ⇒ 不下发 device_id 栏位（与 mode 注入点同规矩：
// 型别/值错一律视为未设定，不硬塞坏值；闸道届时自行配 id，维持既有回退）。
test("register(边界): deviceIdProvider 回空字串 ⇒ 不下发 device_id", async () => {
  localWorker.authorizedRoots.clear();
  const root = mkRoot();
  localWorker.authorizeRoots([root]);
  try {
    const calls = await withRegisterStub(async (calls) => {
      await client.startDeviceBridge({
        enabled: true,
        gatewayBaseUrl: "http://127.0.0.1:1",
        credentialProvider: () => "cred-fake",
        deviceIdProvider: () => "   ",
      });
      return calls;
    });
    const reg = calls.find((c) => /\/register$/.test(c.url));
    assert.ok(reg);
    assert.equal(Object.prototype.hasOwnProperty.call(reg.body, "device_id"), false);
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 对话内就地授权（consent）：接收并落地（session 记忆／permanent 落盘／once 单次）
// 用注入假 deps 测（runtime 直接设为测试夹具），不连真闸道。
// ---------------------------------------------------------------------------
const { handleRequest: handleConsentRequest } = client.__test;

/** 建立 consent 测试夹具：parent（同意根，含 sub）＋ other（其他已授权根）。 */
async function withConsentEnv(fn) {
  const parent = mkRoot();
  const other = mkRoot();
  const sub = path.join(parent, "sub");
  nodeFs.mkdirSync(sub);
  nodeFs.writeFileSync(path.join(sub, "a.txt"), "hi");
  const r = client.__test.runtime;
  const saved = {
    mode: r.mode,
    roots: r.roots,
    consentRoots: r.consentRoots,
    persist: r.persistConsentRoots,
    audit: r.auditConsent,
    deviceId: r.deviceId,
    connectionId: r.connectionId,
  };
  localWorker.authorizedRoots.clear();
  localWorker.authorizeRoots([sub, other]);
  r.mode = "ask";
  r.roots = null;
  r.consentRoots = [];
  r.persistConsentRoots = null;
  r.auditConsent = null;
  r.deviceId = "dev-consent";
  r.connectionId = "conn-consent";
  try {
    return await fn({ parent, sub, other, runtime: r });
  } finally {
    localWorker.authorizedRoots.clear();
    Object.assign(r, {
      mode: saved.mode,
      roots: saved.roots,
      consentRoots: saved.consentRoots,
      persistConsentRoots: saved.persist,
      auditConsent: saved.audit,
      deviceId: saved.deviceId,
      connectionId: saved.connectionId,
    });
    nodeFs.rmSync(parent, { recursive: true, force: true });
    nodeFs.rmSync(other, { recursive: true, force: true });
  }
}

test("① consent permanent：同请求与后续请求对 X 内路径皆放行（mode=ask）", async () => {
  await withConsentEnv(async ({ parent, sub, runtime }) => {
    await withFetchStub(async (calls) => {
      await handleConsentRequest({
        request_id: "c1",
        consent_token: "t1",
        tool: "list_dir",
        args: { path: sub },
        consent: { scope: "permanent", roots: [parent] },
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.error, undefined, `意外的错误：${calls[0].body.error}`);
      assert.ok(calls[0].body.result, "应回结果");
    });
    assert.deepEqual(runtime.consentRoots, [parent], "permanent 根应进记忆体");
    // 后续请求（无 consent）：仍放行
    await withFetchStub(async (calls) => {
      await handleConsentRequest({ request_id: "c2", consent_token: "t2", tool: "list_dir", args: { path: sub } });
      assert.equal(calls[0].body.error, undefined, `意外的错误：${calls[0].body.error}`);
      assert.ok(calls[0].body.result);
    });
  });
});

test("② consent once：只对该请求放行，下一则（无 consent）回 needs_authorization", async () => {
  await withConsentEnv(async ({ parent, sub, runtime }) => {
    await withFetchStub(async (calls) => {
      await handleConsentRequest({
        request_id: "o1",
        consent_token: "t1",
        tool: "list_dir",
        args: { path: sub },
        consent: { scope: "once", roots: [parent] },
      });
      assert.equal(calls[0].body.error, undefined, `once 应放行本请求：${calls[0].body.error}`);
      assert.ok(calls[0].body.result);
    });
    assert.deepEqual(runtime.consentRoots, [], "once 不得进记忆体");
    await withFetchStub(async (calls) => {
      await handleConsentRequest({ request_id: "o2", consent_token: "t2", tool: "list_dir", args: { path: sub } });
      assert.match(String(calls[0].body.error), /needs_authorization/);
    });
  });
});

test("③ consent：X 之外的路径在 mode=ask 仍 needs_authorization（不放宽）", async () => {
  await withConsentEnv(async ({ parent, other, runtime }) => {
    runtime.consentRoots = [parent];
    await withFetchStub(async (calls) => {
      await handleConsentRequest({ request_id: "x1", consent_token: "t1", tool: "list_dir", args: { path: other } });
      assert.match(String(calls[0].body.error), /needs_authorization/);
    });
  });
});

test("⑤ consent permanent 呼叫 persistConsentRoots；session/once 不得落盘", async () => {
  await withConsentEnv(async ({ parent, sub, runtime }) => {
    const persisted = [];
    runtime.persistConsentRoots = (roots) => persisted.push(roots.slice());
    await withFetchStub(async () => {
      await handleConsentRequest({
        request_id: "p1",
        consent_token: "t1",
        tool: "list_dir",
        args: { path: sub },
        consent: { scope: "session", roots: [parent] },
      });
    });
    assert.equal(persisted.length, 0, "session 不得落盘");
    await withFetchStub(async () => {
      await handleConsentRequest({
        request_id: "p2",
        consent_token: "t2",
        tool: "list_dir",
        args: { path: sub },
        consent: { scope: "once", roots: [parent] },
      });
    });
    assert.equal(persisted.length, 0, "once 不得落盘");
    await withFetchStub(async () => {
      await handleConsentRequest({
        request_id: "p3",
        consent_token: "t3",
        tool: "list_dir",
        args: { path: sub },
        consent: { scope: "permanent", roots: [parent] },
      });
    });
    assert.deepEqual(persisted, [[parent]], "permanent 必须落盘一次");
  });
});

test("⑦ consent 形状不合（字串／未知 scope／roots 非阵列）不抛、不得放行任何东西", async () => {
  await withConsentEnv(async ({ parent, sub, runtime }) => {
    const bads = [
      "permanent",
      { scope: "god", roots: [parent] },
      { scope: "permanent", roots: "not-array" },
      { scope: "permanent" },
      { scope: "permanent", roots: [123, "relative/x"] },
      { scope: "once" },
      null,
      42,
    ];
    for (const bad of bads) {
      await withFetchStub(async (calls) => {
        await handleConsentRequest({
          request_id: "m1",
          consent_token: "t1",
          tool: "list_dir",
          args: { path: sub },
          consent: bad,
        });
        assert.match(String(calls[0].body.error), /needs_authorization/, JSON.stringify(bad));
      });
    }
    assert.deepEqual(runtime.consentRoots, [], "坏形状不得写入任何同意根");
  });
});

test("⑥ register：body 含 home；roots 含同意根；rules 含对应 allow 规则", async () => {
  const grant = mkRoot();
  localWorker.authorizedRoots.clear();
  const base = path.join(grant, "base");
  nodeFs.mkdirSync(base);
  localWorker.authorizeRoots([base]);
  try {
    const calls = await withRegisterStub(async (calls) => {
      await client.startDeviceBridge({
        enabled: true,
        gatewayBaseUrl: "http://127.0.0.1:1",
        credentialProvider: () => "cred-fake",
        rootsProvider: () => Array.from(localWorker.authorizedRoots),
        consentRootsProvider: () => [grant],
      });
      return calls;
    });
    const reg = calls.find((c) => /\/register$/.test(c.url));
    assert.ok(reg, "必须有 register");
    assert.equal(reg.body.home, os.homedir(), "register 必须带 home");
    assert.ok(reg.body.roots.includes(grant), "roots 必须含同意根");
    assert.ok(reg.body.roots.includes(base), "roots 必须含既有已设定根");
    assert.ok(reg.body.rules && Array.isArray(reg.body.rules.allow), "rules.allow 必为阵列");
    const wanted = `//${grant.replace(/^\/+/, "")}/**`;
    assert.ok(
      reg.body.rules.allow.some((r) => r && r.effect === "allow" && r.tool === "*" && r.specifier === wanted),
      `rules.allow 应含 ${wanted}`,
    );
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(grant, { recursive: true, force: true });
  }
});
