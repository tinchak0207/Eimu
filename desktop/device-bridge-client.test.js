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
