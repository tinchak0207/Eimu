// desktop/local-worker-bridge.test.js
//
// W6c：device bridge 使用者面（本機檔案授權）的四個 IPC 之主進程側行為測試。
// 純 node（node --test），不啟動 Electron：靠在 createBridgeController 注入間諜
// client（startBridge/stopBridge）做真行為斷言。
//
// 覆蓋：
//   - status 三態：未啟用 / 已啟用但無授權根 / 已啟用有根。
//   - enable 無授權根 ⇒ 不啟動、不自動授權。
//   - disable ⇒ enabled:false 且 client 已停。
//   - **核心**：授權根變更後，已啟用的 bridge 以**新 roots** 再呼叫 startBridge 一次。
//   - 憑證 fail-closed：無憑證 ⇒ credentials_unavailable（真 client，不連網）。
//   - 來源非白名單一律拒。
//
// 跑法：node --test desktop/local-worker-bridge.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nodeFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const localWorker = require("./local-worker.js");
const client = require("./device-bridge-client.js");

const APP_EVENT = { senderFrame: { url: "https://www.eimu.dev/app", parent: null } };
localWorker.__test.setAppHosts(new Set(["www.eimu.dev", "eimu.dev"]));

function mkTmpDir() {
  return nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), "eimu-bridge-cfg-")));
}

/** 建一個注入間諜 client 的控制器；回傳控制器與呼叫紀錄。 */
function freshController(overrides = {}) {
  const calls = { start: [], stop: 0 };
  const controller = localWorker.createBridgeController({
    startBridge: (opts) => {
      calls.start.push(opts);
      return { status: "connecting" };
    },
    stopBridge: () => {
      calls.stop += 1;
    },
    getClientState: () => ({ status: "online", deviceId: "dev-test" }),
    ...overrides,
  });
  return { controller, calls };
}

test("bridge.status(): 未啟用 ⇒ enabled:false, state:off", async () => {
  localWorker.authorizedRoots.clear();
  localWorker.__test.setBridgeController(null);
  const s = await localWorker.__test.handleBridgeStatus(APP_EVENT);
  assert.deepEqual(s, { enabled: false, state: "off", roots: [], deviceId: null });
});

test("bridge.status(): 已啟用但無授權根 ⇒ enabled:true, state:no_authorized_roots（且不啟動）", async () => {
  localWorker.authorizedRoots.clear();
  const { controller, calls } = freshController();
  localWorker.__test.setBridgeController(controller);

  const enabled = await localWorker.__test.handleBridgeEnable(APP_EVENT);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.state, "no_authorized_roots");
  assert.deepEqual(enabled.roots, []);
  assert.equal(calls.start.length, 0, "無授權根不得啟動 client");

  const s = await localWorker.__test.handleBridgeStatus(APP_EVENT);
  assert.equal(s.enabled, true);
  assert.equal(s.state, "no_authorized_roots");
});

test("bridge.enable(): 無授權根不啟動且**不自動授權**任何路徑", async () => {
  localWorker.authorizedRoots.clear();
  const { controller, calls } = freshController({ writeEnabled: () => {} });
  localWorker.__test.setBridgeController(controller);

  await localWorker.__test.handleBridgeEnable(APP_EVENT);
  assert.equal(calls.start.length, 0, "不得啟動");
  assert.equal(localWorker.authorizedRoots.size, 0, "不得自動授權任何路徑");
});

test("bridge.status(): 已啟用有根 ⇒ 反映 client 狀態與 deviceId", async () => {
  localWorker.authorizedRoots.clear();
  const A = mkTmpDir();
  const { controller } = freshController({ getClientState: () => ({ status: "online", deviceId: "dev-42" }) });
  localWorker.__test.setBridgeController(controller);
  try {
    localWorker.__test.applyPickAuthorization([A]);
    const s = await localWorker.__test.handleBridgeEnable(APP_EVENT);
    assert.equal(s.enabled, true);
    assert.equal(s.state, "online");
    assert.deepEqual(s.roots, [A]);
    assert.equal(s.deviceId, "dev-42");
  } finally {
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("state 正規化：reconnecting → connecting；未知值 fail-closed → error（契約六值）", async () => {
  localWorker.authorizedRoots.clear();
  const A = mkTmpDir();
  try {
    const { controller } = freshController({ getClientState: () => ({ status: "reconnecting" }) });
    localWorker.__test.setBridgeController(controller);
    localWorker.__test.applyPickAuthorization([A]);
    assert.equal((await controller.enable()).state, "connecting");

    const unknown = freshController({ getClientState: () => ({ status: "weird_state" }) }).controller;
    localWorker.__test.setBridgeController(unknown);
    await unknown.enable();
    assert.equal(unknown.status().state, "error");
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("bridge.disable(): enabled:false 且 client 已停", async () => {
  localWorker.authorizedRoots.clear();
  const A = mkTmpDir();
  const { controller, calls } = freshController();
  localWorker.__test.setBridgeController(controller);
  try {
    localWorker.__test.applyPickAuthorization([A]);
    await controller.enable();
    assert.equal(calls.start.length, 1);
    const stopAfterEnable = calls.stop;

    const s = await localWorker.__test.handleBridgeDisable(APP_EVENT);
    assert.equal(s.enabled, false);
    assert.equal(s.state, "off");
    assert.ok(calls.stop > stopAfterEnable, "disable 必須停止 client");
    assert.equal((await localWorker.__test.handleBridgeStatus(APP_EVENT)).enabled, false);
  } finally {
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("核心：授權根變更 → 已啟用的 bridge 以**新 roots** 重註冊（startBridge 再呼叫一次）", async () => {
  localWorker.authorizedRoots.clear();
  const A = mkTmpDir();
  const B = mkTmpDir();
  const { controller, calls } = freshController();
  localWorker.__test.setBridgeController(controller);
  try {
    // 1) 授權 A，但尚未啟用 ⇒ 不重註冊（控制器未啟用＝不動作）。
    const first = localWorker.__test.applyPickAuthorization([A]);
    await first.restarted;
    assert.equal(calls.start.length, 0, "未啟用時 pickFiles 不得啟動/重註冊");

    // 2) 啟用 ⇒ 以 A 啟動。
    await controller.enable();
    assert.equal(calls.start.length, 1);
    assert.deepEqual(calls.start[0].rootsProvider(), [A]);

    // 3) 授權新根 B（已啟用）⇒ 以新 roots 重註冊。
    const stopBefore = calls.stop;
    const second = localWorker.__test.applyPickAuthorization([B]);
    assert.ok(second.restarted, "已啟用時 pickFiles 必須觸發重註冊");
    await second.restarted;

    assert.equal(calls.start.length, 2, "startBridge 必須被再呼叫一次");
    assert.deepEqual([...calls.start[1].rootsProvider()].sort(), [A, B].sort(), "第二次必須帶新 roots（A+B）");
    assert.ok(calls.stop > stopBefore, "重註冊前必須先停止舊連線（stop→start）");
  } finally {
    nodeFs.rmSync(A, { recursive: true, force: true });
    nodeFs.rmSync(B, { recursive: true, force: true });
  }
});

test("授權根未變（取消／空）⇒ 不重註冊", async () => {
  localWorker.authorizedRoots.clear();
  const { controller, calls } = freshController();
  localWorker.__test.setBridgeController(controller);
  const A = mkTmpDir();
  try {
    localWorker.__test.applyPickAuthorization([A]);
    await controller.enable();
    const startCount = calls.start.length;

    const cancelled = localWorker.__test.applyPickAuthorization([]);
    assert.equal(cancelled.restarted, null);
    assert.equal(calls.start.length, startCount, "取消不得觸發重註冊");
  } finally {
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("憑證 fail-closed：無憑證 ⇒ credentials_unavailable（真 client，不連網）", async () => {
  localWorker.authorizedRoots.clear();
  const A = mkTmpDir();
  localWorker.authorizeRoots([A]);
  try {
    const snap = await client.startDeviceBridge({ enabled: true, credentialProvider: () => null });
    assert.equal(snap.status, "credentials_unavailable");
    assert.equal(snap.enabled, true);
  } finally {
    client.stopDeviceBridge();
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("bridge IPC：非白名單來源一律拒（E_UNTRUSTED_ORIGIN）", async () => {
  localWorker.__test.setBridgeController(freshController().controller);
  const evil = { senderFrame: { url: "https://evil.example/x", parent: null } };
  await assert.rejects(() => localWorker.__test.handleBridgeStatus(evil), /E_UNTRUSTED_ORIGIN/);
  await assert.rejects(() => localWorker.__test.handleBridgeEnable(evil), /E_UNTRUSTED_ORIGIN/);
  await assert.rejects(() => localWorker.__test.handleBridgeDisable(evil), /E_UNTRUSTED_ORIGIN/);
  await assert.rejects(() => localWorker.__test.handleAuthorizedRoots(evil), /E_UNTRUSTED_ORIGIN/);
});

test("authorizedRoots(): 回已授權根（realpath 絕對路徑）", async () => {
  localWorker.authorizedRoots.clear();
  const A = mkTmpDir();
  try {
    localWorker.authorizeRoots([A]);
    const roots = await localWorker.__test.handleAuthorizedRoots(APP_EVENT);
    assert.deepEqual(roots, [A]);
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});