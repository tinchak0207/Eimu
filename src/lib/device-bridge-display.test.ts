// device-bridge-display 单元测试（runner：npx --yes tsx --test）。
//
// 只测纯逻辑边界（无真桌面壳、无 DOM、无 React）：
//   1. 无 eimuLocal ⇒ 不可用且「需要桌面版」；任何呼叫不得 throw。
//   2. state 六值 → 文案／色调；credentials_unavailable / no_authorized_roots 逐字钉死。
//   3. controller：init 订阅 onBridgeStatus、setEnabled 叫 enable/disable、
//      pickDirectory 叫 pickFiles({kind:"directory"}) 且重读 status、dispose 取消订阅。

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

// ─────────────────────────── 测试辅助

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
  /** 加 bridge.setMode（模拟新桌面产物）；不给＝旧产物（只有 enable/disable）。 */
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

// ─────────────────────────── 1. 可用性（纯浏览器＝渐进增强）

test("无 eimuLocal：isDeviceBridgeApi false、不可用、文案为『需要桌面版』，且不 throw", () => {
  delete (globalThis as { eimuLocal?: unknown }).eimuLocal;
  assert.equal(isDeviceBridgeApi(undefined), false);
  assert.equal(isDeviceBridgeApi(null), false);
  assert.equal(isDeviceBridgeApi({}), false);
  const avail = describeBridgeAvailability(undefined);
  assert.equal(avail.available, false);
  assert.equal(avail.label, BRIDGE_UNAVAILABLE_LABEL);
});

test("形状不全（缺 bridge / pickFiles）⇒ 视为不可用，不是报错", () => {
  assert.equal(isDeviceBridgeApi({ pickFiles: () => {}, onBridgeStatus: () => () => {} }), false);
  assert.equal(isDeviceBridgeApi({ bridge: { status: () => {} }, pickFiles: () => {}, onBridgeStatus: () => {} }), false);
  assert.equal(isDeviceBridgeApi(makeApi()), true);
});

// ─────────────────────────── 2. state → 文案／色调

test("status=null 显示『读取中…』而非假装未开启", () => {
  const d = describeBridgeStatus(null);
  assert.equal(d.label, "读取中…");
  assert.equal(d.tone, "info");
  assert.equal(d.connected, false);
});

test("三态人话：off / no_authorized_roots / online", () => {
  const off = describeBridgeStatus(status({ state: "off", enabled: false }));
  assert.equal(off.label, "未开启");
  assert.equal(off.tone, "off");
  assert.equal(off.connected, false);

  const noRoots = describeBridgeStatus(status({ state: "no_authorized_roots", enabled: true }));
  assert.equal(noRoots.label, "已开启 · 尚未选择资料夹");
  assert.equal(noRoots.description, "请先选择要授权的资料夹。");

  const online = describeBridgeStatus(status({ state: "online", enabled: true, roots: ["/a", "/b"] }));
  assert.equal(online.label, "已连上");
  assert.equal(online.tone, "ok");
  assert.equal(online.connected, true);
  assert.deepEqual(online.roots, ["/a", "/b"]);
});

test("credentials_unavailable 文案逐字符合规格", () => {
  const d = describeBridgeStatus(status({ state: "credentials_unavailable", enabled: true }));
  // 2026-10-12（f6ab6475）：文案改为「正在获取权限」的进行态 + 重试/重新登入指引
  // （旧的「桌面版还没设定装置凭证」在页面换装置票的新链路下已不准确）。
  assert.equal(
    d.description,
    "正在获取本机文件权限…若一直停在这里，请点「重试」或重新登录。",
  );
  assert.equal(d.tone, "warn");
});

test("connecting / error / 未知 state 各有分流（error 带 lastError）", () => {
  assert.equal(describeBridgeStatus(status({ state: "connecting" })).tone, "info");
  const err = describeBridgeStatus(status({ state: "error", lastError: "E_UPSTREAM 502" }));
  assert.equal(err.label, "连线出错");
  assert.equal(err.tone, "error");
  assert.equal(err.description, "E_UPSTREAM 502");
  const unknown = describeBridgeStatus({ ...status(), state: "wat" as never });
  assert.equal(unknown.label, BRIDGE_UNKNOWN_LABEL);
});

test("roots 非阵列时不炸、回空阵列", () => {
  const d = describeBridgeStatus({ ...status({ state: "online" }), roots: undefined as never });
  assert.deepEqual(d.roots, []);
});

test("tone→class：每个 tone 都有对应色 class", () => {
  for (const tone of ["ok", "warn", "error", "info", "off"] as const) {
    assert.match(bridgeToneClass(tone), /^text-\[/);
  }
});

// ─────────────────────────── 3. controller（互动可测）

test("无 eimuLocal：init/refresh/setEnabled/pickDirectory 全部不 throw 且 no-op", async () => {
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

test("有假 eimuLocal：init 订阅 onBridgeStatus 并读一次 status", async () => {
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
  assert.ok(notifications >= 1, "订阅者应被通知");
  ctl.dispose();
});

test("开关：setEnabled(true) 叫 bridge.enable()、setEnabled(false) 叫 bridge.disable()", async () => {
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

test("选资料夹：叫 pickFiles({kind:'directory',multiple:true}) 并重读 status", async () => {
  const api = makeApi({ statuses: [status({ state: "no_authorized_roots", enabled: true }), status({ state: "online", enabled: true, roots: ["/授权夹"] })] });
  const ctl = createDeviceBridgeController(() => api);
  ctl.init();
  await tick();
  const before = api.calls.status;
  const picked = await ctl.pickDirectory();
  assert.deepEqual(api.calls.pick, [{ kind: "directory", multiple: true }]);
  assert.deepEqual(picked, ["/home/me/授权夹"]);
  assert.ok(api.calls.status > before, "选完资料夹应重读 status");
  assert.equal(ctl.getSnapshot().status?.state, "online");
  assert.deepEqual(ctl.getSnapshot().status?.roots, ["/授权夹"]);
  ctl.dispose();
});

test("onBridgeStatus 推播会更新 snapshot", async () => {
  const api = makeApi();
  const ctl = createDeviceBridgeController(() => api);
  ctl.init();
  await tick();
  api.emit(status({ state: "online", enabled: true, roots: ["/pushed"] }));
  assert.equal(ctl.getSnapshot().status?.state, "online");
  assert.deepEqual(ctl.getSnapshot().status?.roots, ["/pushed"]);
  ctl.dispose();
});

test("卸载：dispose 取消订阅；之后推播不再改 snapshot（unsub 只叫一次）", async () => {
  const api = makeApi();
  const ctl = createDeviceBridgeController(() => api);
  ctl.init();
  await tick();
  ctl.dispose();
  assert.equal(api.calls.unsub, 1);
  const frozen = ctl.getSnapshot();
  api.emit(status({ state: "error", enabled: true }));
  assert.equal(ctl.getSnapshot(), frozen, "dispose 后不得再 notify/改 snapshot");
  ctl.dispose(); // 幂等
  assert.equal(api.calls.unsub, 1);
});

test("操作失败转成 notice，不 throw（enable reject / pickFiles reject）", async () => {
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

// ─────────────────────────── 4. 本机档案权限模式（四档纯函式；单一真源）

test("LOCAL_FILE_MODES：四档 id 顺序与文案逐字（单一真源）", () => {
  assert.deepEqual(
    LOCAL_FILE_MODES.map((m) => m.id),
    ["off", "ask", "auto", "full"],
  );
  assert.deepEqual(
    LOCAL_FILE_MODES.map((m) => [m.icon, m.title, m.subtitle]),
    [
      ["power", "关闭", "agent 不能读取本机档案。"],
      // 2026-10-05（a9cd889d）：授权根内读取不再逐次问，只有写入/范围外才问。
      ["message-circle-question", "读取允许，写入询问", "已授权资料夹内直接读取；范围外或要写入时才问你。"],
      ["folder-check", "授权范围内自动", "已授权资料夹内自动读取，范围外会先问你。"],
      // 2026-10-12（f6ab6475）：full 档补上「自动执行并同意扣费」的授权口径。
      ["globe", "完全访问", "自动执行并同意所有扣费；整个家目录可读，敏感位置（~/.ssh、~/.aws、私钥等）仍不读取。"],
    ],
  );
});

test("describeLocalFileMode：四档 tone 分流；未知值保守回退 off", () => {
  assert.deepEqual(describeLocalFileMode("off"), { title: "关闭", subtitle: "agent 不能读取本机档案。", tone: "off" });
  assert.deepEqual(describeLocalFileMode("ask"), {
    title: "读取允许，写入询问",
    subtitle: "已授权资料夹内直接读取；范围外或要写入时才问你。",
    tone: "info",
  });
  assert.deepEqual(describeLocalFileMode("auto"), {
    title: "授权范围内自动",
    subtitle: "已授权资料夹内自动读取，范围外会先问你。",
    tone: "ok",
  });
  assert.deepEqual(describeLocalFileMode("full"), {
    title: "完全访问",
    subtitle: "自动执行并同意所有扣费；整个家目录可读，敏感位置（~/.ssh、~/.aws、私钥等）仍不读取。",
    tone: "warn",
  });
  assert.equal(describeLocalFileMode("wat" as never).title, "关闭");
});

test("modeFromStatus：status 有真值 mode ⇒ derived:false", () => {
  assert.deepEqual(modeFromStatus(status({ enabled: true, state: "online", mode: "full" })), {
    mode: "full",
    derived: false,
    known: true,
  });
  // 真值优先于「能推导出的值」：即使 enabled 且 roots 非空（会推成 auto），仍以 full 为准。
  assert.deepEqual(modeFromStatus(status({ enabled: true, state: "online", roots: ["/a"], mode: "ask" })), {
    mode: "ask",
    derived: false,
    known: true,
  });
});

test("modeFromStatus：旧 status 无 mode 栏位 ⇒ 由 enabled/roots 推导并标 derived:true", () => {
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
  // roots 非阵列（契约漂移）不炸
  assert.equal(modeFromStatus({ ...status({ enabled: true }), roots: undefined as never }).mode, "ask");
});

test("modeFromStatus：status=null ⇒ known:false（UI 不得显示成已选中）", () => {
  assert.deepEqual(modeFromStatus(null), { mode: "off", derived: true, known: false });
});

test("isLocalFileMode：只认四档字面，其余为 false", () => {
  for (const m of ["off", "ask", "auto", "full"] as const) assert.equal(isLocalFileMode(m), true);
  for (const bad of ["", "OFF", "always", null, undefined, 3]) assert.equal(isLocalFileMode(bad), false);
});

test("supportsSetMode：有 bridge.setMode 才真；旧产物／纯浏览器为假，不 throw", () => {
  assert.equal(supportsSetMode(makeApi({ hasSetMode: true })), true);
  assert.equal(supportsSetMode(makeApi()), false, "旧产物（无 setMode）必须判假");
  assert.equal(supportsSetMode(undefined), false);
  assert.equal(supportsSetMode(null), false);
  assert.equal(supportsSetMode({}), false);
  assert.equal(supportsSetMode({ bridge: { status: () => {} } }), false);
});

// ─────────────────────────── 5. controller.setMode（降级可测）

test("controller.setMode：有 setMode 直接切，且非 off 未启用时补一次 enable", async () => {
  const api = makeApi({ hasSetMode: true, setModeResult: () => status({ enabled: false, state: "off", mode: "ask" }) });
  const ctl = createDeviceBridgeController(() => api);
  ctl.init();
  await tick();
  await ctl.setMode("ask");
  assert.deepEqual(api.calls.setMode, ["ask"]);
  assert.equal(api.calls.enable, 1, "非 off 且壳回报未启用 → 补 enable");
  assert.equal(ctl.getSnapshot().status?.enabled, true);
  ctl.dispose();
});

test("controller.setMode：切 off 不补 enable", async () => {
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

test("controller.setMode：旧产物（无 setMode）→ off 走 disable、非 off 走 enable", async () => {
  const api = makeApi(); // 无 hasSetMode ⇒ 旧产物
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

test("controller.setMode：无 eimuLocal 时 no-op 不 throw", async () => {
  const ctl = createDeviceBridgeController(() => undefined);
  ctl.init();
  await ctl.setMode("full");
  assert.equal(ctl.getSnapshot().available, false);
  ctl.dispose();
});

test("controller.setMode：setMode reject ⇒ 收敛成 notice，不 throw", async () => {
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