// desktop/local-worker-bridge.test.js
//
// W6c：device bridge 使用者面（本机档案授权）的四个 IPC 之主进程侧行为测试。
// 纯 node（node --test），不启动 Electron：靠在 createBridgeController 注入间谍
// client（startBridge/stopBridge）做真行为断言。
//
// 覆盖：
//   - status 三态：未启用 / 已启用但无授权根 / 已启用有根。
//   - enable 无授权根 ⇒ 不启动、不自动授权。
//   - disable ⇒ enabled:false 且 client 已停。
//   - **核心**：授权根变更后，已启用的 bridge 以**新 roots** 再呼叫 startBridge 一次。
//   - 凭证 fail-closed：无凭证 ⇒ credentials_unavailable（真 client，不连网）。
//   - 来源非白名单一律拒。
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

/** 建一个注入间谍 client 的控制器；回传控制器与呼叫纪录。 */
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

test("bridge.status(): 未启用 ⇒ enabled:false, state:off（mode 预设 ask）", async () => {
  localWorker.authorizedRoots.clear();
  localWorker.__test.setBridgeController(null);
  const s = await localWorker.__test.handleBridgeStatus(APP_EVENT);
  // mode 为 W6c 新增栏位（未接线时预设 ask）。
  assert.deepEqual(s, { enabled: false, state: "off", roots: [], deviceId: null, mode: "ask" });
});

test("bridge.status(): 已启用但无授权根 ⇒ enabled:true, state:no_authorized_roots（且不启动）", async () => {
  localWorker.authorizedRoots.clear();
  const { controller, calls } = freshController();
  localWorker.__test.setBridgeController(controller);

  const enabled = await localWorker.__test.handleBridgeEnable(APP_EVENT);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.state, "no_authorized_roots");
  assert.deepEqual(enabled.roots, []);
  assert.equal(calls.start.length, 0, "无授权根不得启动 client");

  const s = await localWorker.__test.handleBridgeStatus(APP_EVENT);
  assert.equal(s.enabled, true);
  assert.equal(s.state, "no_authorized_roots");
});

test("bridge.enable(): 无授权根不启动且**不自动授权**任何路径", async () => {
  localWorker.authorizedRoots.clear();
  const { controller, calls } = freshController({ writeEnabled: () => {} });
  localWorker.__test.setBridgeController(controller);

  await localWorker.__test.handleBridgeEnable(APP_EVENT);
  assert.equal(calls.start.length, 0, "不得启动");
  assert.equal(localWorker.authorizedRoots.size, 0, "不得自动授权任何路径");
});

test("bridge.status(): 已启用有根 ⇒ 反映 client 状态与 deviceId", async () => {
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

test("state 正规化：reconnecting → connecting；未知值 fail-closed → error（契约六值）", async () => {
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
    assert.ok(calls.stop > stopAfterEnable, "disable 必须停止 client");
    assert.equal((await localWorker.__test.handleBridgeStatus(APP_EVENT)).enabled, false);
  } finally {
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("核心：授权根变更 → 已启用的 bridge 以**新 roots** 重注册（startBridge 再呼叫一次）", async () => {
  localWorker.authorizedRoots.clear();
  const A = mkTmpDir();
  const B = mkTmpDir();
  const { controller, calls } = freshController();
  localWorker.__test.setBridgeController(controller);
  try {
    // 1) 授权 A，但尚未启用 ⇒ 不重注册（控制器未启用＝不动作）。
    const first = localWorker.__test.applyPickAuthorization([A]);
    await first.restarted;
    assert.equal(calls.start.length, 0, "未启用时 pickFiles 不得启动/重注册");

    // 2) 启用 ⇒ 以 A 启动。
    await controller.enable();
    assert.equal(calls.start.length, 1);
    assert.deepEqual(calls.start[0].rootsProvider(), [A]);

    // 3) 授权新根 B（已启用）⇒ 以新 roots 重注册。
    const stopBefore = calls.stop;
    const second = localWorker.__test.applyPickAuthorization([B]);
    assert.ok(second.restarted, "已启用时 pickFiles 必须触发重注册");
    await second.restarted;

    assert.equal(calls.start.length, 2, "startBridge 必须被再呼叫一次");
    assert.deepEqual([...calls.start[1].rootsProvider()].sort(), [A, B].sort(), "第二次必须带新 roots（A+B）");
    assert.ok(calls.stop > stopBefore, "重注册前必须先停止旧连线（stop→start）");
  } finally {
    nodeFs.rmSync(A, { recursive: true, force: true });
    nodeFs.rmSync(B, { recursive: true, force: true });
  }
});

test("授权根未变（取消／空）⇒ 不重注册", async () => {
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
    assert.equal(calls.start.length, startCount, "取消不得触发重注册");
  } finally {
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("凭证 fail-closed：无凭证 ⇒ credentials_unavailable（真 client，不连网）", async () => {
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

// ── 型别契约（2026-10-04 补）────────────────────────────────────────────
// 教训来源：local-worker 曾在 startOptions() 写 `credentialProvider: credentialProvider()`
// ——把**呼叫后的结果（字串）**传给 client，而 client 只在 `typeof === "function"` 时才
// 呼叫它 ⇒ 恒为 null ⇒ 恒停 credentials_unavailable、装置永不注册。
// 既有测试只用间谍 startBridge 断言「被呼叫了」，**断言不到型别**，所以漏掉（同源断言
// 的典型失效）。以下两条专抓此类：①对注入点的**型别**断言（非值）②用**真** client 走
// 一遍，断言状态不再卡在 credentials_unavailable。

test("型别契约：startOptions() 传给 client 的 credentialProvider/rootsProvider/onStatus 必须是 function", async () => {
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
    assert.equal(captured.length, 1, "startBridge 应被呼叫一次");
    const opts = captured[0];

    // 三个注入点都必须是**函式**（client 端是 typeof === "function" 才呼叫）——
    // 传值＝型别错，client 一律视为 null/预设。
    assert.equal(
      typeof opts.credentialProvider,
      "function",
      `credentialProvider 必须是 function（client 只在 typeof==='function' 时呼叫它），实际收到 ${typeof opts.credentialProvider}`,
    );
    assert.equal(typeof opts.rootsProvider, "function", `rootsProvider 必须是 function，实际 ${typeof opts.rootsProvider}`);
    assert.equal(typeof opts.onStatus, "function", `onStatus 必须是 function，实际 ${typeof opts.onStatus}`);
    // gatewayBaseUrl 是**值**注入点：client 期望字串（非函式）。
    assert.equal(typeof opts.gatewayBaseUrl, "string", `gatewayBaseUrl 必须是 string，实际 ${typeof opts.gatewayBaseUrl}`);

    // 函式呼叫后必须得到非空字串（否则 client 仍会判 credentials_unavailable）。
    const cred = await opts.credentialProvider();
    assert.equal(typeof cred, "string", "credentialProvider() 必须回字串");
    assert.ok(cred.length > 0, "credentialProvider() 不得回空字串");

    // rootsProvider() 回当前授权根（供 client 判 allowlist 必填）。
    assert.deepEqual(opts.rootsProvider(), [A]);
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("整合（真 client）：注入 credentialProvider ⇒ 状态不再 credentials_unavailable（凭证已被接受）", async () => {
  localWorker.authorizedRoots.clear();
  const A = mkTmpDir();
  const seen = [];
  const controller = localWorker.createBridgeController({
    startBridge: (opts) => client.startDeviceBridge(opts),
    stopBridge: () => client.stopDeviceBridge(),
    getClientState: () => client.getDeviceBridgeState(),
    // 不可达埠（:1）：立即连线失败 ⇒ reconnecting/network_error，**不触生产闸道**。
    getGatewayBaseUrl: () => "http://127.0.0.1:1",
    credentialProvider: () => "sk-cred-fake-nonempty",
    onStatusChange: (s) => seen.push(s.state),
  });
  localWorker.__test.setBridgeController(controller);
  try {
    localWorker.__test.applyPickAuthorization([A]);
    const snap = await controller.enable();
    const raw = client.getDeviceBridgeState();

    assert.notEqual(snap.state, "credentials_unavailable", `控制器状态不得为 credentials_unavailable（实际 ${snap.state}）`);
    assert.notEqual(raw.status, "credentials_unavailable", `client 状态不得为 credentials_unavailable（实际 ${raw.status}）`);
    // 凭证被接受 ⇒ 进入连线阶段（reconnecting/connecting/online 皆可），不再是凭证错。
    assert.ok(
      ["reconnecting", "connecting", "online"].includes(raw.status),
      `凭证被接受后状态应进入连线阶段，实际 ${raw.status}`,
    );
    assert.equal(client.__test.runtime.credential, "sk-cred-fake-nonempty", "client 应持有注入的凭证");
    assert.ok(seen.length > 0, "onStatus 注入点应被 client 呼叫（状态推送有接上）");
  } finally {
    client.stopDeviceBridge();
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("bridge IPC：非白名单来源一律拒（E_UNTRUSTED_ORIGIN）", async () => {
  localWorker.__test.setBridgeController(freshController().controller);
  const evil = { senderFrame: { url: "https://evil.example/x", parent: null } };
  await assert.rejects(() => localWorker.__test.handleBridgeStatus(evil), /E_UNTRUSTED_ORIGIN/);
  await assert.rejects(() => localWorker.__test.handleBridgeEnable(evil), /E_UNTRUSTED_ORIGIN/);
  await assert.rejects(() => localWorker.__test.handleBridgeDisable(evil), /E_UNTRUSTED_ORIGIN/);
  await assert.rejects(() => localWorker.__test.handleAuthorizedRoots(evil), /E_UNTRUSTED_ORIGIN/);
});

test("authorizedRoots(): 回已授权根（realpath 绝对路径）", async () => {
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

// ── W6c：权限模式（bridge.setMode）──────────────────────────────────────
// 契约：四值皆可；非法值 E_BAD_ARGS 且不打网路/不改状态；off＝停桥；非 off＝
// 启用并以 stop→start 重注册（register 带新模式）；模式持久化并可还原。

/** 带写入间谍与可控授权根的控制器。 */
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

test("bridge.status(): 未设定模式 ⇒ 预设 mode=ask", async () => {
  const { controller } = modeController();
  assert.equal(controller.status().mode, "ask");
});

test("bridge.setMode(): 四值皆可且状态反映最新模式", async () => {
  localWorker.authorizedRoots.clear();
  const A = mkTmpDir();
  try {
    const { controller } = modeController();
    localWorker.__test.setBridgeController(controller);
    localWorker.__test.applyPickAuthorization([A]);
    for (const m of ["ask", "auto", "full", "ask"]) {
      const s = await localWorker.__test.handleBridgeSetMode(APP_EVENT, m);
      assert.equal(s.mode, m, `mode 应为 ${m}`);
      assert.equal(controller.status().mode, m);
    }
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("bridge.setMode(): 非法值 ⇒ E_BAD_ARGS，不打网路、不改状态、不写持久化", async () => {
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
    assert.equal(calls.start.length, 0, "非法值不得启动");
    assert.equal(calls.stop, 0, "非法值不得停桥（不打网路）");
    assert.equal(calls.written.length, 0, "非法值不得写持久化");
    assert.deepEqual(controller.status(), before, "状态不得改变");
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("bridge.setMode('off'): 停桥（等同 disable），enabled:false state:off mode:off", async () => {
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
    assert.ok(calls.stop > stopBefore, "off 必须停桥");
    assert.equal(calls.start.length, startCount, "off 不得再启动");
    assert.deepEqual(calls.enabled.at(-1), false, "off 应记为未启用");
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("bridge.setMode(非 off): 启用并以 stop→start 重注册，register 带新模式", async () => {
  localWorker.authorizedRoots.clear();
  const A = mkTmpDir();
  try {
    const { controller, calls } = modeController();
    localWorker.__test.setBridgeController(controller);
    localWorker.__test.applyPickAuthorization([A]);

    const s1 = await controller.setMode("auto");
    assert.equal(s1.mode, "auto");
    assert.equal(s1.enabled, true);
    assert.equal(calls.start.length, 1, "非 off 应启动");
    assert.ok(calls.stop >= 1, "启动前应先停（stop→start）");
    assert.equal(calls.start[0].modeProvider(), "auto", "register 应带新模式");

    const stopBefore = calls.stop;
    await controller.setMode("full");
    assert.equal(calls.start.length, 2, "改模式应重注册");
    assert.ok(calls.stop > stopBefore, "重注册前必须先停旧连线");
    assert.equal(calls.start[1].modeProvider(), "full", "第二次 register 带更新后的模式");
    assert.deepEqual(calls.written, ["auto", "full"], "每次 setMode 都持久化");
    assert.equal(calls.enabled.at(-1), true, "非 off 应记为已启用");
  } finally {
    localWorker.authorizedRoots.clear();
    nodeFs.rmSync(A, { recursive: true, force: true });
  }
});

test("bridge.setMode(): 无授权根 ⇒ 记住模式且启用，但不启动（不自动授权）", async () => {
  localWorker.authorizedRoots.clear();
  const { controller, calls } = modeController();
  localWorker.__test.setBridgeController(controller);
  const s = await controller.setMode("auto");
  assert.equal(s.mode, "auto");
  assert.equal(s.enabled, true);
  assert.equal(s.state, "no_authorized_roots");
  assert.equal(calls.start.length, 0, "无授权根不得启动");
  assert.equal(localWorker.authorizedRoots.size, 0, "不得自动授权任何路径");
});

test("持久化：setMode 写入后，重启（新控制器读同一来源）status().mode 仍是它", async () => {
  localWorker.authorizedRoots.clear();
  const store = {};
  try {
    const c1 = modeController({ writeMode: (m) => { store.mode = m; } }).controller;
    await c1.setMode("full");
    assert.equal(store.mode, "full", "setMode 应持久化 mode");

    // 模拟重启：新控制器以 readMode 还原同一持久化来源。
    const c2 = modeController({ readMode: () => store.mode }).controller;
    assert.equal(c2.status().mode, "full", "重启后 status().mode 应为持久化值");

    // 非法持久化值 ⇒ 回预设 ask（fail-safe，不沿用坏值）。
    const c3 = modeController({ readMode: () => "garbage" }).controller;
    assert.equal(c3.status().mode, "ask");
  } finally {
    localWorker.authorizedRoots.clear();
  }
});

test("bridge IPC：handleBridgeSetMode 非白名单来源一律拒", async () => {
  localWorker.__test.setBridgeController(modeController().controller);
  const evil = { senderFrame: { url: "https://evil.example/x", parent: null } };
  await assert.rejects(() => localWorker.__test.handleBridgeSetMode(evil, "auto"), /E_UNTRUSTED_ORIGIN/);
});