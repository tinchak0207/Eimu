// device-bridge-display 單元測試（runner：npx --yes tsx --test）。
//
// 只測純邏輯邊界（無真桌面殼、無 DOM、無 React）：
//   1. 無 eimuLocal ⇒ 不可用且「需要桌面版」；任何呼叫不得 throw。
//   2. state 六值 → 文案／色調；credentials_unavailable / no_authorized_roots 逐字釘死。
//   3. controller：init 訂閱 onBridgeStatus、setEnabled 叫 enable/disable、
//      pickDirectory 叫 pickFiles({kind:"directory"}) 且重讀 status、dispose 取消訂閱。

import test from "node:test";
import assert from "node:assert/strict";

import {
  BRIDGE_UNAVAILABLE_LABEL,
  BRIDGE_UNKNOWN_LABEL,
  LOCAL_FILE_MODES,
  bridgeToneClass,
  createDeviceBridgeController,
  describeBridgeAvailability,
  describeBridgeStatus,
  describeLocalFileMode,
  isDeviceBridgeApi,
  isLocalFileMode,
  modeFromStatus,
  supportsSetMode,
  type BridgeStatus,
  type DeviceBridgeApi,
  type LocalFileMode,
  type PickFilesOpts,
} from "./device-bridge-display.ts";

// ─────────────────────────── 測試輔助

function status(partial: Partial<BridgeStatus> = {}): BridgeStatus {
  return {
    enabled: false,
    state: "off",
    roots: [],
    deviceId: null,
    ...partial,
  };
}

interface ApiOptions {
  statuses?: BridgeStatus[];
  onStatus?: (cb: (s: BridgeStatus) => void) => () => void;
  onEnable?: () => void;
  onDisable?: () => void;
  onPick?: (opts: PickFilesOpts) => void;
  picked?: string[];
  pickReject?: unknown;
  /** 加 bridge.setMode（模擬新桌面產物）；不給＝舊產物（只有 enable/disable）。 */
  hasSetMode?: boolean;
  setModeResult?: (mode: LocalFileMode) => BridgeStatus;
}

interface FakeApi extends DeviceBridgeApi {
  calls: {
    status: number;
    enable: number;
    disable: number;
    pick: PickFilesOpts[];
    unsub: number;
    setMode: LocalFileMode[];
  };
  emit: (s: BridgeStatus) => void;
}

function makeApi(opts: ApiOptions = {}): FakeApi {
  const calls: FakeApi["calls"] = { status: 0, enable: 0, disable: 0, pick: [], unsub: 0, setMode: [] };
  let cbs: Array<(s: BridgeStatus) => void> = [];
  const queue = [...(opts.statuses ?? [])];
  const next = () => queue.shift() ?? status({ state: "online", enabled: true });
  const bridge: FakeApi["bridge"] = {
    async status() {
      calls.status += 1;
      return next();
    },
    async enable() {
      calls.enable += 1;
      opts.onEnable?.();
      return status({ enabled: true, state: "no_authorized_roots" });
    },
    async disable() {
      calls.disable += 1;
      opts.onDisable?.();
      return status({ enabled: false, state: "off" });
    },
  };
  if (opts.hasSetMode) {
    bridge.setMode = async (mode: LocalFileMode) => {
      calls.setMode.push(mode);
      return opts.setModeResult?.(mode) ?? status({ enabled: mode !== "off", state: "online", mode });
    };
  }
  const api: FakeApi = {
    calls,
    emit: (s) => cbs.forEach((cb) => cb(s)),
    bridge,
    onBridgeStatus(cb) {
      cbs.push(cb);
      const custom = opts.onStatus?.(cb);
      return () => {
        calls.unsub += 1;
        cbs = cbs.filter((c) => c !== cb);
        custom?.();
      };
    },
    async pickFiles(o) {
      calls.pick.push(o);
      opts.onPick?.(o);
      if (opts.pickReject !== undefined) throw opts.pickReject;
      return opts.picked ?? ["/home/me/授权夹"];
    },
  };
  return api;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ─────────────────────────── 1. 可用性（純瀏覽器＝漸進增強）

test("無 eimuLocal：isDeviceBridgeApi false、不可用、文案為『需要桌面版』，且不 throw", () => {
  delete (globalThis as { eimuLocal?: unknown }).eimuLocal;
  assert.equal(isDeviceBridgeApi(undefined), false);
  assert.equal(isDeviceBridgeApi(null), false);
  assert.equal(isDeviceBridgeApi({}), false);
  const avail = describeBridgeAvailability(undefined);
  assert.equal(avail.available, false);
  assert.equal(avail.label, BRIDGE_UNAVAILABLE_LABEL);
});

test("形狀不全（缺 bridge / pickFiles）⇒ 視為不可用，不是報錯", () => {
  assert.equal(isDeviceBridgeApi({ pickFiles: () => {}, onBridgeStatus: () => () => {} }), false);
  assert.equal(isDeviceBridgeApi({ bridge: { status: () => {} }, pickFiles: () => {}, onBridgeStatus: () => {} }), false);
  assert.equal(isDeviceBridgeApi(makeApi()), true);
});

// ─────────────────────────── 2. state → 文案／色調

test("status=null 顯示『讀取中…』而非假裝未開啟", () => {
  const d = describeBridgeStatus(null);
  assert.equal(d.label, "讀取中…");
  assert.equal(d.tone, "info");
  assert.equal(d.connected, false);
});

test("三態人話：off / no_authorized_roots / online", () => {
  const off = describeBridgeStatus(status({ state: "off", enabled: false }));
  assert.equal(off.label, "未開啟");
  assert.equal(off.tone, "off");
  assert.equal(off.connected, false);

  const noRoots = describeBridgeStatus(status({ state: "no_authorized_roots", enabled: true }));
  assert.equal(noRoots.label, "已開啟 · 尚未選擇資料夾");
  assert.equal(noRoots.description, "請先選擇要授權的資料夾。");

  const online = describeBridgeStatus(status({ state: "online", enabled: true, roots: ["/a", "/b"] }));
  assert.equal(online.label, "已連上");
  assert.equal(online.tone, "ok");
  assert.equal(online.connected, true);
  assert.deepEqual(online.roots, ["/a", "/b"]);
});

test("credentials_unavailable 文案逐字符合規格", () => {
  const d = describeBridgeStatus(status({ state: "credentials_unavailable", enabled: true }));
  assert.equal(d.description, "桌面版還沒設定裝置憑證（見說明）；此功能需要一次性設定。");
  assert.equal(d.tone, "warn");
});

test("connecting / error / 未知 state 各有分流（error 帶 lastError）", () => {
  assert.equal(describeBridgeStatus(status({ state: "connecting" })).tone, "info");
  const err = describeBridgeStatus(status({ state: "error", lastError: "E_UPSTREAM 502" }));
  assert.equal(err.label, "連線出錯");
  assert.equal(err.tone, "error");
  assert.equal(err.description, "E_UPSTREAM 502");
  const unknown = describeBridgeStatus({ ...status(), state: "wat" as never });
  assert.equal(unknown.label, BRIDGE_UNKNOWN_LABEL);
});

test("roots 非陣列時不炸、回空陣列", () => {
  const d = describeBridgeStatus({ ...status({ state: "online" }), roots: undefined as never });
  assert.deepEqual(d.roots, []);
});

test("tone→class：每個 tone 都有對應色 class", () => {
  for (const tone of ["ok", "warn", "error", "info", "off"] as const) {
    assert.match(bridgeToneClass(tone), /^text-\[/);
  }
});

// ─────────────────────────── 3. controller（互動可測）

test("無 eimuLocal：init/refresh/setEnabled/pickDirectory 全部不 throw 且 no-op", async () => {
  const ctl = createDeviceBridgeController(() => undefined);
  ctl.init();
  await ctl.refresh();
  await ctl.setEnabled(true);
  const picked = await ctl.pickDirectory();
  assert.deepEqual(picked, []);
  assert.equal(ctl.getSnapshot().available, false);
  assert.equal(ctl.getSnapshot().loading, false);
  ctl.dispose();
});

test("有假 eimuLocal：init 訂閱 onBridgeStatus 並讀一次 status", async () => {
  const api = makeApi({ statuses: [status({ state: "online", enabled: true, roots: ["/x"] })] });
  let notifications = 0;
  const ctl = createDeviceBridgeController(() => api);
  ctl.subscribe(() => (notifications += 1));
  ctl.init();
  assert.equal(ctl.getSnapshot().available, true);
  await tick();
  assert.equal(api.calls.status, 1);
  assert.equal(ctl.getSnapshot().status?.state, "online");
  assert.equal(ctl.getSnapshot().loading, false);
  assert.ok(notifications >= 1, "訂閱者應被通知");
  ctl.dispose();
});

test("開關：setEnabled(true) 叫 bridge.enable()、setEnabled(false) 叫 bridge.disable()", async () => {
  const api = makeApi();
  const ctl = createDeviceBridgeController(() => api);
  ctl.init();
  await tick();
  await ctl.setEnabled(true);
  assert.equal(api.calls.enable, 1);
  assert.equal(api.calls.disable, 0);
  assert.equal(ctl.getSnapshot().status?.enabled, true);
  await ctl.setEnabled(false);
  assert.equal(api.calls.disable, 1);
  assert.equal(ctl.getSnapshot().status?.enabled, false);
  assert.equal(ctl.getSnapshot().busy, false);
  ctl.dispose();
});

test("選資料夾：叫 pickFiles({kind:'directory',multiple:true}) 並重讀 status", async () => {
  const api = makeApi({ statuses: [status({ state: "no_authorized_roots", enabled: true }), status({ state: "online", enabled: true, roots: ["/授权夹"] })] });
  const ctl = createDeviceBridgeController(() => api);
  ctl.init();
  await tick();
  const before = api.calls.status;
  const picked = await ctl.pickDirectory();
  assert.deepEqual(api.calls.pick, [{ kind: "directory", multiple: true }]);
  assert.deepEqual(picked, ["/home/me/授权夹"]);
  assert.ok(api.calls.status > before, "選完資料夾應重讀 status");
  assert.equal(ctl.getSnapshot().status?.state, "online");
  assert.deepEqual(ctl.getSnapshot().status?.roots, ["/授权夹"]);
  ctl.dispose();
});

test("onBridgeStatus 推播會更新 snapshot", async () => {
  const api = makeApi();
  const ctl = createDeviceBridgeController(() => api);
  ctl.init();
  await tick();
  api.emit(status({ state: "online", enabled: true, roots: ["/pushed"] }));
  assert.equal(ctl.getSnapshot().status?.state, "online");
  assert.deepEqual(ctl.getSnapshot().status?.roots, ["/pushed"]);
  ctl.dispose();
});

test("卸載：dispose 取消訂閱；之後推播不再改 snapshot（unsub 只叫一次）", async () => {
  const api = makeApi();
  const ctl = createDeviceBridgeController(() => api);
  ctl.init();
  await tick();
  ctl.dispose();
  assert.equal(api.calls.unsub, 1);
  const frozen = ctl.getSnapshot();
  api.emit(status({ state: "error", enabled: true }));
  assert.equal(ctl.getSnapshot(), frozen, "dispose 後不得再 notify/改 snapshot");
  ctl.dispose(); // 冪等
  assert.equal(api.calls.unsub, 1);
});

test("操作失敗轉成 notice，不 throw（enable reject / pickFiles reject）", async () => {
  const api = makeApi({ pickReject: new Error("E_DENIED") });
  const ctl = createDeviceBridgeController(() => api);
  ctl.init();
  await tick();
  const picked = await ctl.pickDirectory();
  assert.deepEqual(picked, []);
  assert.equal(ctl.getSnapshot().notice, "E_DENIED");
  assert.equal(ctl.getSnapshot().busy, false);
  ctl.dispose();
});

// ─────────────────────────── 4. 本機檔案權限模式（四檔純函式；單一真源）

test("LOCAL_FILE_MODES：四檔 id 順序與文案逐字（單一真源）", () => {
  assert.deepEqual(
    LOCAL_FILE_MODES.map((m) => m.id),
    ["off", "ask", "auto", "full"],
  );
  assert.deepEqual(
    LOCAL_FILE_MODES.map((m) => [m.icon, m.title, m.subtitle]),
    [
      ["power", "關閉", "agent 不能讀取本機檔案。"],
      ["message-circle-question", "每次詢問", "每次讀取前先問你。"],
      ["folder-check", "授權範圍內自動", "已授權資料夾內自動讀取，範圍外會先問你。"],
      ["globe", "完全訪問", "整個家目錄可讀；敏感位置（~/.ssh、~/.aws、私鑰等）一律不讀。"],
    ],
  );
});

test("describeLocalFileMode：四檔 tone 分流；未知值保守回退 off", () => {
  assert.deepEqual(describeLocalFileMode("off"), { title: "關閉", subtitle: "agent 不能讀取本機檔案。", tone: "off" });
  assert.deepEqual(describeLocalFileMode("ask"), { title: "每次詢問", subtitle: "每次讀取前先問你。", tone: "info" });
  assert.deepEqual(describeLocalFileMode("auto"), {
    title: "授權範圍內自動",
    subtitle: "已授權資料夾內自動讀取，範圍外會先問你。",
    tone: "ok",
  });
  assert.deepEqual(describeLocalFileMode("full"), {
    title: "完全訪問",
    subtitle: "整個家目錄可讀；敏感位置（~/.ssh、~/.aws、私鑰等）一律不讀。",
    tone: "warn",
  });
  assert.equal(describeLocalFileMode("wat" as never).title, "關閉");
});

test("modeFromStatus：status 有真值 mode ⇒ derived:false", () => {
  assert.deepEqual(modeFromStatus(status({ enabled: true, state: "online", mode: "full" })), {
    mode: "full",
    derived: false,
    known: true,
  });
  // 真值優先於「能推導出的值」：即使 enabled 且 roots 非空（會推成 auto），仍以 full 為準。
  assert.deepEqual(modeFromStatus(status({ enabled: true, state: "online", roots: ["/a"], mode: "ask" })), {
    mode: "ask",
    derived: false,
    known: true,
  });
});

test("modeFromStatus：舊 status 無 mode 欄位 ⇒ 由 enabled/roots 推導並標 derived:true", () => {
  // !enabled → off
  assert.deepEqual(modeFromStatus(status({ enabled: false, state: "off" })), {
    mode: "off",
    derived: true,
    known: true,
  });
  // enabled && roots 空 → ask
  assert.deepEqual(modeFromStatus(status({ enabled: true, state: "no_authorized_roots", roots: [] })), {
    mode: "ask",
    derived: true,
    known: true,
  });
  // enabled && roots 非空 → auto
  assert.deepEqual(modeFromStatus(status({ enabled: true, state: "online", roots: ["/a", "/b"] })), {
    mode: "auto",
    derived: true,
    known: true,
  });
  // roots 非陣列（契約漂移）不炸
  assert.equal(modeFromStatus({ ...status({ enabled: true }), roots: undefined as never }).mode, "ask");
});

test("modeFromStatus：status=null ⇒ known:false（UI 不得顯示成已選中）", () => {
  assert.deepEqual(modeFromStatus(null), { mode: "off", derived: true, known: false });
});

test("isLocalFileMode：只認四檔字面，其餘為 false", () => {
  for (const m of ["off", "ask", "auto", "full"] as const) assert.equal(isLocalFileMode(m), true);
  for (const bad of ["", "OFF", "always", null, undefined, 3]) assert.equal(isLocalFileMode(bad), false);
});

test("supportsSetMode：有 bridge.setMode 才真；舊產物／純瀏覽器為假，不 throw", () => {
  assert.equal(supportsSetMode(makeApi({ hasSetMode: true })), true);
  assert.equal(supportsSetMode(makeApi()), false, "舊產物（無 setMode）必須判假");
  assert.equal(supportsSetMode(undefined), false);
  assert.equal(supportsSetMode(null), false);
  assert.equal(supportsSetMode({}), false);
  assert.equal(supportsSetMode({ bridge: { status: () => {} } }), false);
});

// ─────────────────────────── 5. controller.setMode（降級可測）

test("controller.setMode：有 setMode 直接切，且非 off 未啟用時補一次 enable", async () => {
  const api = makeApi({ hasSetMode: true, setModeResult: () => status({ enabled: false, state: "off", mode: "ask" }) });
  const ctl = createDeviceBridgeController(() => api);
  ctl.init();
  await tick();
  await ctl.setMode("ask");
  assert.deepEqual(api.calls.setMode, ["ask"]);
  assert.equal(api.calls.enable, 1, "非 off 且殼回報未啟用 → 補 enable");
  assert.equal(ctl.getSnapshot().status?.enabled, true);
  ctl.dispose();
});

test("controller.setMode：切 off 不補 enable", async () => {
  const api = makeApi({ hasSetMode: true, setModeResult: () => status({ enabled: false, state: "off", mode: "off" }) });
  const ctl = createDeviceBridgeController(() => api);
  ctl.init();
  await tick();
  await ctl.setMode("off");
  assert.deepEqual(api.calls.setMode, ["off"]);
  assert.equal(api.calls.enable, 0);
  assert.equal(ctl.getSnapshot().status?.mode, "off");
  ctl.dispose();
});

test("controller.setMode：舊產物（無 setMode）→ off 走 disable、非 off 走 enable", async () => {
  const api = makeApi(); // 無 hasSetMode ⇒ 舊產物
  const ctl = createDeviceBridgeController(() => api);
  ctl.init();
  await tick();
  await ctl.setMode("full");
  assert.equal(api.calls.enable, 1);
  assert.equal(api.calls.disable, 0);
  assert.deepEqual(api.calls.setMode, []);
  await ctl.setMode("off");
  assert.equal(api.calls.disable, 1);
  ctl.dispose();
});

test("controller.setMode：無 eimuLocal 時 no-op 不 throw", async () => {
  const ctl = createDeviceBridgeController(() => undefined);
  ctl.init();
  await ctl.setMode("full");
  assert.equal(ctl.getSnapshot().available, false);
  ctl.dispose();
});

test("controller.setMode：setMode reject ⇒ 收斂成 notice，不 throw", async () => {
  const api = makeApi({ hasSetMode: true });
  api.bridge.setMode = async () => {
    throw new Error("E_MODE_REJECTED");
  };
  const ctl = createDeviceBridgeController(() => api);
  ctl.init();
  await tick();
  await ctl.setMode("full");
  assert.equal(ctl.getSnapshot().notice, "E_MODE_REJECTED");
  assert.equal(ctl.getSnapshot().busy, false);
  ctl.dispose();
});