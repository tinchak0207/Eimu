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

test("bridge.status(): 未啟用 ⇒ enabled:false, state:off（mode 預設 ask）", async () => {
  localWorker.authorizedRoots.clear();
  localWorker.__test.setBridgeController(null);
  const s = await localWorker.__test.handleBridgeStatus(APP_EVENT);
  // mode 為 W6c 新增欄位（未接線時預設 ask）。
  assert.deepEqual(s, { enabled: false, state: "off", roots: [], deviceId: null, mode: "ask" });
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

// ── 型別契約（2026-10-04 補）────────────────────────────────────────────
// 教訓來源：local-worker 曾在 startOptions() 寫 `credentialProvider: credentialProvider()`
// ——把**呼叫後的結果（字串）**傳給 client，而 client 只在 `typeof === "function"` 時才
// 呼叫它 ⇒ 恆為 null ⇒ 恆停 credentials_unavailable、裝置永不註冊。
// 既有測試只用間諜 startBridge 斷言「被呼叫了」，**斷言不到型別**，所以漏掉（同源斷言
// 的典型失效）。以下兩條專抓此類：①對注入點的**型別**斷言（非值）②用**真** client 走
// 一遍，斷言狀態不再卡在 credentials_unavailable。

test("型別契約：startOptions() 傳給 client 的 credentialProvider/rootsProvider/onStatus 必須是 function", async () => {
  localWorker.authorizedRoots.clear();
  const A = mkTmpDir();
  const captured = [];
  const controller = localWorker.createBridgeController({
    startBridge: (opts) => {
      captured.push(opts);
      return { status: "connecting" };
    },
    stopBridge: () => {},
    getClientState: () => ({ status: "connecting" }),
    getGatewayBaseUrl: () => "https://gw.example.invalid",
    credentialProvider: () => "sk-cred-fake-nonempty",
  });
  localWorker.__test.setBridgeController(controller);
  try {
    localWorker.__test.applyPickAuthorization([A]);
    await controller.enable();
    assert.equal(captured.length, 1, "startBridge 應被呼叫一次");
    const opts = captured[0];

    // 三個注入點都必須是**函式**（client 端是 typeof === "function" 才呼叫）——
    // 傳值＝型別錯，client 一律視為 null/預設。
    assert.equal(
      typeof opts.credentialProvider,
      "function",
      `credentialProvider 必須是 function（client 只在 typeof==='function' 時呼叫它），實際收到 ${typeof opts.credentialProvider}`,
    );
    assert.equal(typeof opts.rootsProvider, "function", `rootsProvider 必須是 function，實際 ${typeof opts.rootsProvider}`);
    assert.equal(typeof opts.onStatus, "function", `onStatus 必須是 function，實際 ${typeof opts.onStatus}`);
    // gatewayBaseUrl 是**值**注入點：client 期望字串（非函式）。
    assert.equal(typeof opts.gatewayBaseUrl, "string", `gatewayBaseUrl 必須是 string，實際 ${typeof opts.gatewayBaseUrl}`);

    // 函式呼叫後必須得到非空字串（否則 client 仍會判 credentials_unavailable）。
    const cred = await opts.credentialProvider();
    assert.equal(typeof cred, "string", "credentialProvider() 必須回字串");
    assert.ok(cred.length > 0, "credentialProvider() 不得回空字串");

    // rootsProvider() 回當前授權根（供 client 判 allowlist 必填）。
    assert.deepEqual(opts.rootsProvider(), [A]);
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("整合（真 client）：注入 credentialProvider ⇒ 狀態不再 credentials_unavailable（憑證已被接受）", async () => {
  localWorker.authorizedRoots.clear();
  const A = mkTmpDir();
  const seen = [];
  const controller = localWorker.createBridgeController({
    startBridge: (opts) => client.startDeviceBridge(opts),
    stopBridge: () => client.stopDeviceBridge(),
    getClientState: () => client.getDeviceBridgeState(),
    // 不可達埠（:1）：立即連線失敗 ⇒ reconnecting/network_error，**不觸生產閘道**。
    getGatewayBaseUrl: () => "http://127.0.0.1:1",
    credentialProvider: () => "sk-cred-fake-nonempty",
    onStatusChange: (s) => seen.push(s.state),
  });
  localWorker.__test.setBridgeController(controller);
  try {
    localWorker.__test.applyPickAuthorization([A]);
    const snap = await controller.enable();
    const raw = client.getDeviceBridgeState();

    assert.notEqual(snap.state, "credentials_unavailable", `控制器狀態不得為 credentials_unavailable（實際 ${snap.state}）`);
    assert.notEqual(raw.status, "credentials_unavailable", `client 狀態不得為 credentials_unavailable（實際 ${raw.status}）`);
    // 憑證被接受 ⇒ 進入連線階段（reconnecting/connecting/online 皆可），不再是憑證錯。
    assert.ok(
      ["reconnecting", "connecting", "online"].includes(raw.status),
      `憑證被接受後狀態應進入連線階段，實際 ${raw.status}`,
    );
    assert.equal(client.__test.runtime.credential, "sk-cred-fake-nonempty", "client 應持有注入的憑證");
    assert.ok(seen.length > 0, "onStatus 注入點應被 client 呼叫（狀態推送有接上）");
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

// ── W6c：權限模式（bridge.setMode）──────────────────────────────────────
// 契約：四值皆可；非法值 E_BAD_ARGS 且不打網路/不改狀態；off＝停橋；非 off＝
// 啟用並以 stop→start 重註冊（register 帶新模式）；模式持久化並可還原。

/** 帶寫入間諜與可控授權根的控制器。 */
function modeController(overrides = {}) {
  const calls = { start: [], stop: 0, written: [], enabled: [] };
  const controller = localWorker.createBridgeController({
    startBridge: (opts) => {
      calls.start.push(opts);
      return { status: "connecting" };
    },
    stopBridge: () => {
      calls.stop += 1;
    },
    getClientState: () => ({ status: "online", deviceId: "dev-mode" }),
    writeEnabled: (v) => calls.enabled.push(v),
    writeMode: (m) => calls.written.push(m),
    ...overrides,
  });
  return { controller, calls };
}

test("bridge.status(): 未設定模式 ⇒ 預設 mode=ask", async () => {
  const { controller } = modeController();
  assert.equal(controller.status().mode, "ask");
});

test("bridge.setMode(): 四值皆可且狀態反映最新模式", async () => {
  localWorker.authorizedRoots.clear();
  const A = mkTmpDir();
  try {
    const { controller } = modeController();
    localWorker.__test.setBridgeController(controller);
    localWorker.__test.applyPickAuthorization([A]);
    for (const m of ["ask", "auto", "full", "ask"]) {
      const s = await localWorker.__test.handleBridgeSetMode(APP_EVENT, m);
      assert.equal(s.mode, m, `mode 應為 ${m}`);
      assert.equal(controller.status().mode, m);
    }
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("bridge.setMode(): 非法值 ⇒ E_BAD_ARGS，不打網路、不改狀態、不寫持久化", async () => {
  localWorker.authorizedRoots.clear();
  const A = mkTmpDir();
  try {
    const { controller, calls } = modeController();
    localWorker.__test.setBridgeController(controller);
    localWorker.__test.applyPickAuthorization([A]);
    const before = controller.status();

    for (const bad of ["bogus", "", null, undefined, 123, "ASK ", "full2"]) {
      await assert.rejects(() => controller.setMode(bad), (err) => err && err.code === "E_BAD_ARGS", String(bad));
    }
    assert.equal(calls.start.length, 0, "非法值不得啟動");
    assert.equal(calls.stop, 0, "非法值不得停橋（不打網路）");
    assert.equal(calls.written.length, 0, "非法值不得寫持久化");
    assert.deepEqual(controller.status(), before, "狀態不得改變");
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("bridge.setMode('off'): 停橋（等同 disable），enabled:false state:off mode:off", async () => {
  localWorker.authorizedRoots.clear();
  const A = mkTmpDir();
  try {
    const { controller, calls } = modeController();
    localWorker.__test.setBridgeController(controller);
    localWorker.__test.applyPickAuthorization([A]);
    await controller.setMode("auto");
    const startCount = calls.start.length;
    const stopBefore = calls.stop;

    const s = await controller.setMode("off");
    assert.equal(s.enabled, false);
    assert.equal(s.state, "off");
    assert.equal(s.mode, "off");
    assert.ok(calls.stop > stopBefore, "off 必須停橋");
    assert.equal(calls.start.length, startCount, "off 不得再啟動");
    assert.deepEqual(calls.enabled.at(-1), false, "off 應記為未啟用");
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("bridge.setMode(非 off): 啟用並以 stop→start 重註冊，register 帶新模式", async () => {
  localWorker.authorizedRoots.clear();
  const A = mkTmpDir();
  try {
    const { controller, calls } = modeController();
    localWorker.__test.setBridgeController(controller);
    localWorker.__test.applyPickAuthorization([A]);

    const s1 = await controller.setMode("auto");
    assert.equal(s1.mode, "auto");
    assert.equal(s1.enabled, true);
    assert.equal(calls.start.length, 1, "非 off 應啟動");
    assert.ok(calls.stop >= 1, "啟動前應先停（stop→start）");
    assert.equal(calls.start[0].modeProvider(), "auto", "register 應帶新模式");

    const stopBefore = calls.stop;
    await controller.setMode("full");
    assert.equal(calls.start.length, 2, "改模式應重註冊");
    assert.ok(calls.stop > stopBefore, "重註冊前必須先停舊連線");
    assert.equal(calls.start[1].modeProvider(), "full", "第二次 register 帶更新後的模式");
    assert.deepEqual(calls.written, ["auto", "full"], "每次 setMode 都持久化");
    assert.equal(calls.enabled.at(-1), true, "非 off 應記為已啟用");
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("bridge.setMode(): 無授權根 ⇒ 記住模式且啟用，但不啟動（不自動授權）", async () => {
  localWorker.authorizedRoots.clear();
  const { controller, calls } = modeController();
  localWorker.__test.setBridgeController(controller);
  const s = await controller.setMode("auto");
  assert.equal(s.mode, "auto");
  assert.equal(s.enabled, true);
  assert.equal(s.state, "no_authorized_roots");
  assert.equal(calls.start.length, 0, "無授權根不得啟動");
  assert.equal(localWorker.authorizedRoots.size, 0, "不得自動授權任何路徑");
});

test("持久化：setMode 寫入後，重啟（新控制器讀同一來源）status().mode 仍是它", async () => {
  localWorker.authorizedRoots.clear();
  const store = {};
  try {
    const c1 = modeController({ writeMode: (m) => { store.mode = m; } }).controller;
    await c1.setMode("full");
    assert.equal(store.mode, "full", "setMode 應持久化 mode");

    // 模擬重啟：新控制器以 readMode 還原同一持久化來源。
    const c2 = modeController({ readMode: () => store.mode }).controller;
    assert.equal(c2.status().mode, "full", "重啟後 status().mode 應為持久化值");

    // 非法持久化值 ⇒ 回預設 ask（fail-safe，不沿用壞值）。
    const c3 = modeController({ readMode: () => "garbage" }).controller;
    assert.equal(c3.status().mode, "ask");
  } finally {
    localWorker.authorizedRoots.clear();
  }
});

test("bridge IPC：handleBridgeSetMode 非白名單來源一律拒", async () => {
  localWorker.__test.setBridgeController(modeController().controller);
  const evil = { senderFrame: { url: "https://evil.example/x", parent: null } };
  await assert.rejects(() => localWorker.__test.handleBridgeSetMode(evil, "auto"), /E_UNTRUSTED_ORIGIN/);
});