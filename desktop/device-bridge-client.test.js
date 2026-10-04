// desktop/device-bridge-client.test.js
//
// W6b 客戶端編排層測試：不連真閘道（stub global.fetch）。覆蓋兩條先前無測試的路徑：
//   - H1：無授權根 ⇒ 執行器一律拒；startDeviceBridge 直接拒絕服務。
//   - M4：錯誤回報必須帶 consent_token（否則閘道 result 先 consume 一律 not_found）。
// 跑法：npx --yes tsx --test desktop/device-bridge-client.test.js
// 註：本檔在純 node 下可 require（electron 未就緒時 require("electron") 只回路徑字串，
//     模組頂層不呼叫任何 electron API）。

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nodeFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const client = require("./device-bridge-client.js");
const localWorker = require("./local-worker.js");

/** stub global.fetch，回傳收到的請求並固定回 {ok:true}。 */
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

test("H1(e2e): 無授權根 ⇒ handleRequest 執行被拒且回報帶票", async () => {
  const { handleRequest, runtime } = client.__test;
  runtime.deviceId = "dev-1";
  runtime.connectionId = "conn-1";
  const tmp = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), "eimu-bridge-cli-")));
  try {
    const f = path.join(tmp, "a.txt");
    nodeFs.writeFileSync(f, "hi");
    assert.equal(localWorker.authorizedRoots.size, 0, "測試前提：授權根為空");
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

test("H1: 無授權根 ⇒ startDeviceBridge 拒絕服務（no_authorized_roots）", async () => {
  const snap = await client.startDeviceBridge({ enabled: true, credentialProvider: () => "cred" });
  assert.equal(snap.status, "no_authorized_roots");
  client.stopDeviceBridge();
});

test("M4: 錯誤回報（tool_not_allowed）帶 consent_token", async () => {
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

test("M4: 錯誤回報（consent_token_expired）帶 consent_token", async () => {
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

// ── W6c：register 帶 mode/rules（加性；未提供＝不下發，維持既有呼叫端行為）──────

/**
 * stub：register 成功，poll 卡住（永不結算，避免長輪詢迴圈在測試中空轉）。
 * 只攔 register 的 body 以斷言；不連真閘道。
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
    if (/\/poll$/.test(u)) return new Promise(() => {}); // 不結算
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
  }
}

function mkRoot() {
  return nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), "eimu-bridge-reg-")));
}

test("register: 提供 modeProvider/rulesProvider ⇒ body 帶 mode 與 rules", async () => {
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
      // snapshot 透傳 mode（供 bridge.status()）；在 stop 前斷言。
      assert.equal(client.getDeviceBridgeState().mode, "auto");
      return calls;
    });
    const reg = calls.find((c) => /\/register$/.test(c.url));
    assert.ok(reg, "必須發出 register");
    assert.equal(reg.body.mode, "auto");
    assert.deepEqual(reg.body.rules, [{ effect: "allow", tool: "read_file" }]);
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

test("register: 未提供 modeProvider/rulesProvider ⇒ 不下發 mode/rules 欄位（既有行為不變）", async () => {
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

test("register: modeProvider 回非法值 ⇒ 不下發 mode（注入點驗值，不硬塞壞值）", async () => {
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

// ── roots 上報（缺陷回歸）：register body 必須真的帶 roots ──────────────────
// 教訓：只斷言「有呼叫 register」抓不到漏傳欄位（見 2026-10-04-fetch-receiver-test-green-prod-broken）。
// 這裡斷言請求 body 的**內容**：body.roots 逐值等於注入的 rootsProvider() 回傳。

test("register: body 必須帶 roots，且值等於注入的 rootsProvider() 回傳", async () => {
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
    assert.ok(reg, "必須發出 register");
    assert.ok(Array.isArray(reg.body.roots), "register body 必須含 roots 陣列（漏傳即閘道 no_authorized_root）");
    assert.deepEqual(reg.body.roots, injected);
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

test("register(邊界): rootsProvider 回空陣列 ⇒ 拒絕服務且不發出任何 register", async () => {
  localWorker.authorizedRoots.clear();
  const calls = await withRegisterStub(async (calls) => {
    const snap = await client.startDeviceBridge({
      enabled: true,
      gatewayBaseUrl: "http://127.0.0.1:1",
      credentialProvider: () => "cred-fake",
      rootsProvider: () => [],
    });
    assert.equal(snap.status, "no_authorized_roots", "空 roots 一律拒服務（H1 不變）");
    return calls;
  });
  assert.equal(
    calls.some((c) => /\/register$/.test(c.url)),
    false,
    "空 roots 不得註冊（不誤送空授權集）",
  );
});

test("register: 授權根變更 → 重註冊時 body 帶『新的』roots", async () => {
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
      // stop→start（與 local-worker startNow 同路徑）：換 roots 必須重註冊。
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
    assert.equal(regs.length, 2, "應有兩次 register（stop→start 重註冊）");
    assert.deepEqual(regs[0].body.roots, [rootA]);
    assert.deepEqual(regs[1].body.roots, [rootA, rootB], "重註冊必須帶新的 roots");
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(rootA, { recursive: true, force: true });
    nodeFs.rmSync(rootB, { recursive: true, force: true });
  }
});

// ── 穩定 deviceId（缺陷回歸）：同一次安裝重註冊必須帶同一個 device_id ──────────
// 症狀：register 不帶 device_id ⇒ 閘道每次重連都 randomId("dev") 配「新的」deviceId
// ⇒ 同一 tenant 的 devices 表在 heartbeat TTL 內累積多筆 online ⇒ pickDeviceForTenant
// 回 device_ambiguous，或把請求送到已死那台 ⇒ 同一殼內第二發 invoke 起吃滿 30s 的
// `device_request_timeout`。
//
// 正解在裝置端（閘道「多台 ambiguous 不猜」是刻意的安全語義，不動）：同一安裝回報
// **穩定** deviceId，讓重註冊取代同一筆 `deviceKey(tenant, deviceId)` 紀錄。
// 契約：main.js 產生並持久化一枚 stable id（settings.json 白名單欄位
// deviceBridgeDeviceId），經 deviceIdProvider 注入 client；register body 帶 device_id。

/** 假 settings store：模擬 settings.json 白名單欄位的讀寫（不碰真檔）。 */
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

test("deviceId: 無既有值 ⇒ 產生一次並寫入；同 store 再讀不重生", () => {
  const store = fakeSettingsStore(undefined);
  const a = client.resolveStableDeviceId(store);
  assert.equal(typeof a, "string");
  assert.ok(a.length > 0, "產生的 deviceId 必須非空");
  assert.equal(store.value, a, "必須寫回 store（持久化）");
  assert.equal(store.writes, 1, "只寫一次");
  const b = client.resolveStableDeviceId(store);
  assert.equal(b, a, "第二次回同一 id");
  assert.equal(store.writes, 1, "第二次不重生、不再寫");
});

test("deviceId: store 已有合法值 ⇒ 直接沿用（不重生、不覆寫）", () => {
  const store = fakeSettingsStore("dev_existing0001");
  assert.equal(client.resolveStableDeviceId(store), "dev_existing0001");
  assert.equal(store.writes, 0, "已有值不得寫入");
});

test("deviceId: store 壞值（空字串／非字串）⇒ 視為無值，重生一次", () => {
  const empty = fakeSettingsStore("   ");
  const id = client.resolveStableDeviceId(empty);
  assert.ok(id.length > 0 && id !== "   ");
  assert.equal(empty.value, id);
  assert.equal(empty.writes, 1);
});

test("register: body 必須帶非空 device_id（注入 deviceIdProvider）", async () => {
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
    assert.ok(reg, "必須發出 register");
    assert.equal(reg.body.device_id, stable, "register body 必須帶注入的 device_id");
    assert.ok(String(reg.body.device_id).length > 0, "device_id 必須非空");
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

test("register: 兩次連續啟動（stop→start）送同一個 device_id，且不重生", async () => {
  localWorker.authorizedRoots.clear();
  const root = mkRoot();
  localWorker.authorizeRoots([root]);
  // 模擬 main.js：provider 每次向「同一份」持久化 store 取 id。
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
    assert.equal(regs.length, 2, "stop→start 應有兩次 register");
    assert.ok(regs[0].body.device_id, "第一次 register 必須帶 device_id");
    assert.equal(regs[0].body.device_id, regs[1].body.device_id, "兩次 register 必須是同一個 device_id");
    assert.equal(regs[0].body.device_id, store.value, "送出的 id 必須是持久化 store 的值");
    assert.equal(store.writes, 1, "兩次啟動只產生一次（不重生）");
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

// 邊界：deviceIdProvider 回非法值 ⇒ 不下發 device_id 欄位（與 mode 注入點同規矩：
// 型別/值錯一律視為未設定，不硬塞壞值；閘道屆時自行配 id，維持既有回退）。
test("register(邊界): deviceIdProvider 回空字串 ⇒ 不下發 device_id", async () => {
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
