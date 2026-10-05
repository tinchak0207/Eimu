// desktop/device-bridge-client.js
//
// W6b：device bridge「本机侧」主进程客户端。方向永远是**出站**：本机主动向闸道
// 注册 → 心跳 → 长轮询取件 → 在本机执行白名单唯读工具 → 回传结果。云端永不
// inbound 打使用者机器。
//
// 与云端契约逐栏对齐：deploy-staging/gateway/device-bridge.ts（handleDeviceBridgeRoutes）
//   POST /agent/v1/device-bridge/register  → { device_id, connection_id, heartbeat_interval_ms, poll_url }
//   POST /agent/v1/device-bridge/heartbeat → { device_id, connection_id }            → { pending_count, server_time_ms }
//   POST /agent/v1/device-bridge/poll      → { device_id, connection_id, wait_ms }   → { request|null }
//   POST /agent/v1/device-bridge/result    → { device_id, connection_id, request_id, consent_token, result|error }
//   POST /agent/v1/device-bridge/invoke    → 云端 agent 发起（本档不呼叫）
// 错误码：device_connection_stale / device_offline / device_request_not_found /
// consent_token_{not_found,expired,mismatch,replayed}（闸道于 result 时再验票）。
//
// ── 预设 OFF（硬性）─────────────────────────────────────────────────────
// 只有 opts.enabled === true 才连；否则停在 "off"，一个位元组都不出网。
//
// ── 凭证缺口（诚实处理，不自造鉴权）─────────────────────────────────────
// 闸道鉴权沿用既有 Bearer sk-biz-*（auth-gw.ts）。桌面壳载入远端页面、只有
// session，**没有** biz key，也**不**在此硬编任何 key。改以 credentialProvider
// 注入点接受凭证；回 null/空 → bridge 不启动并回报 credentials_unavailable。
// 补法见 desktop/DEVICE-BRIDGE.md。
//
// ── 安全边界（能力宁可少；执行器抽到 lib/bridge-executor.js，可测）────────
//  1. 工具白名单＝list_dir/read_file/grep/stat（无写/删/执行）。
//  2. 路径先 realpath 解 symlink，再过 policy.js isSensitivePath（denylist，扫所有
//     路径段，与云端 device-bridge-policy.ts 同语义）。
//  3. allowlist **必填**：授权根来自 local-worker.js 的**同一份** authorizedRoots
//     （使用者由 pickFiles 显式挑选的根），空集＝全拒并拒绝服务；**不得**退回
//     「只验 denylist」。
//  4. 拒绝档案系统根路径（path_is_root）；grep 逐档大小上限，避免整档入记忆体。
//  5. 回传前 clampResult 夹 256KB＋截断标记（与云端侧同上限）。
//  6. consent_token 执行前先验形状/有效期（真正的原子验票在闸道 result 时）；
//     **错误回报同样带票**（M4，否则闸道先 consume 一律 not_found 吃满逾时）。
//  7. 任何 log 只写状态与错误码，**永不**写凭证或档案内容。

"use strict";

const crypto = require("node:crypto");
const os = require("node:os");

const proto = require("./lib/bridge-protocol.js");
const { createBridgeExecutor, BridgeError } = require("./lib/bridge-executor.js");
const { PERMISSION_MODES, allowRuleForRoot } = require("./lib/permission-rules.js");
const localWorker = require("./local-worker.js");

const PREFIX = "/agent/v1/device-bridge";
// 真闸道域名（2026-10-05 修正）：`image.tinchak0207.xyz` 的 /agent/healthz 是 404，
// `/agent/v1/device-bridge/register` 也 404 —— 装置桥其实挂在 `store.tinchak0207.xyz`
// （healthz 200、无鉴权 register 401）。旧值让「有凭证但没带 gatewayBaseUrl」的壳
// 打到不存在的端点，等于永远连不上。页面换票路径会把闸道回的真值覆写进来，
// 这里只是操作者/后备路径的预设值。
const DEFAULT_GATEWAY_BASE_URL = "https://store.tinchak0207.xyz";
const DEFAULT_POLL_WAIT_MS = 20000; // <= 闸道 DEVICE_POLL_MAX_WAIT_MS(25000)
const DEFAULT_HEARTBEAT_MS = 30000;

// ── 稳定「安装」装置识别（缺陷修复；纯函式、零 IO）───────────────────────
// 病因：register 不带 device_id ⇒ 闸道对每次重连都 randomId("dev") 配一个**新的**
// deviceId；同一 tenant 的注册表在 heartbeat TTL 内累积多笔 online ⇒
// pickDeviceForTenant 回 `device_ambiguous`（闸道「多台不猜」是刻意的安全语义，**不动**），
// 或把请求送到已死那台 ⇒ 同一壳内第二发 invoke 起吃满 30s 的 device_request_timeout。
// 正解在装置端：同一安装回报**稳定** deviceId，让重注册取代同一笔
// `deviceKey(tenant, deviceId)` 纪录（闸道 register 收 body.device_id，见
// deploy-staging/gateway/device-bridge.ts:1038、:561）。
//
// 产生与持久化由 host（main.js）负责：本 helper 只做「读 store → 有值沿用／无值产生
// 一次并写回」的纯语义，store 由 main.js 以 <userData>/settings.json 的白名单栏位
// deviceBridgeDeviceId 适配（比照 deviceBridgeEnabled/deviceBridgeMode 的读写惯例）。
// 形状对齐闸道 randomId("dev")：`dev_` + 32 hex（36 字元，远低于闸道 128 上限）。

/** 产生一枚安装识别（非机密，可下发闸道）。 */
function generateStableDeviceId() {
  return `dev_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * 读取持久化的安装 deviceId；没有（或非法）才产生一次并写回 store。
 * @param {{read?:()=>unknown, write?:(id:string)=>void}} store
 * @returns {string} 非空 deviceId（同一 store 第二次呼叫回同一值、不重生）
 */
function resolveStableDeviceId(store) {
  let existing;
  try {
    existing = store && typeof store.read === "function" ? store.read() : undefined;
  } catch {
    existing = undefined;
  }
  if (typeof existing === "string" && existing.trim().length > 0) return existing.trim().slice(0, 128);
  const id = generateStableDeviceId();
  try {
    if (store && typeof store.write === "function") store.write(id);
  } catch {
    /* 写入失败仍回本次 id（下次启动会重生，但不致命、不影响本次连线） */
  }
  return id;
}

// ── 对话内就地授权（consent）─────────────────────────────────────────────
// 协议（冻结栏位名）：DeviceRequestMessage.consent = { scope: "once"|"session"|"permanent",
// roots: string[] }。三态语义：
//   once      — 只对**这一则**请求有效，不记忆、不落盘。
//   session   — 本壳执行期间有效（记忆体累积、去重）。
//   permanent — 落盘（重启仍有效；由注入的 persistConsentRoots 并入 settings）。
// 云端对 session/permanent 会在其后每次 invoke 幂等重送 ⇒ 装置端去重。
// 形状不合／未知 scope／roots 非阵列 → 当作**没有 consent**（fail-closed，不抛、不放行）。

/** 正规化根清单：仅非空绝对路径字串、去重（fail-closed，非绝对一律略过）。 */
function normalizeConsentRootList(roots) {
  if (!Array.isArray(roots)) return [];
  const out = [];
  for (const r of roots) {
    if (typeof r !== "string") continue;
    const t = r.trim();
    if (t.length === 0 || !t.startsWith("/")) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** 解析 request.consent；形状不合／未知 scope／roots 空 → null（视为无同意）。 */
function parseConsent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const scope = raw.scope;
  if (scope !== "once" && scope !== "session" && scope !== "permanent") return null;
  const roots = normalizeConsentRootList(raw.roots);
  if (roots.length === 0) return null;
  return { scope, roots };
}

/** 联集（a ∪ b），保留 a 的顺序、去重。 */
function unionRoots(a, b) {
  const out = Array.isArray(a) ? a.slice() : [];
  for (const r of Array.isArray(b) ? b : []) {
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

/**
 * 由同意根推出 allow 规则（与闸道 authorizationRuleSpecifier 同形），并入既有 rules。
 * 既有 rules 可为 undefined／阵列／{deny,ask,allow}；不改变既有规则，只加 allow 桶。
 */
function withConsentAllowRules(base, consentRoots) {
  const extra = [];
  for (const root of Array.isArray(consentRoots) ? consentRoots : []) {
    const rule = allowRuleForRoot(root);
    if (rule) extra.push(rule);
  }
  if (extra.length === 0) return base;
  if (Array.isArray(base)) return base.concat(extra);
  if (base && typeof base === "object") {
    const out = { ...base };
    out.allow = Array.isArray(base.allow) ? base.allow.concat(extra) : extra.slice();
    return out;
  }
  return { allow: extra };
}


// 不另造第二套授权机制；空集 ⇒ bridge 拒绝服务（见 startDeviceBridge）。
// W6c：mode/rules 为第二道防线的输入，即时读 runtime（由 startDeviceBridge 注入，
// 未注入＝null/undefined，执行器回退 "auto" 以维持既有呼叫端行为）。
const executor = createBridgeExecutor({
  roots: () => Array.from(localWorker.authorizedRoots),
  mode: () => (runtime.mode === undefined ? undefined : runtime.mode),
  rules: () => runtime.rules,
});

const runtime = {
  running: false,
  polling: false,
  status: "off",
  enabled: false,
  gatewayBaseUrl: DEFAULT_GATEWAY_BASE_URL,
  credential: null,
  deviceId: null,
  connectionId: null,
  heartbeatIntervalMs: DEFAULT_HEARTBEAT_MS,
  pollUrl: `${PREFIX}/poll`,
  attempt: 0,
  gen: 0, // 连线世代：重连/停止时递增，让旧回圈自行退场（防重连后双回圈）
  controller: null,
  heartbeatTimer: null,
  reconnectTimer: null,
  lastError: null,
  onStatus: null,
  // W6c 权限模式与规则（register 下发；未提供＝null/undefined，不下发栏位）。
  mode: null,
  rules: undefined,
  // H(roots 缺陷)：register 必须下发的已授权根（string[]）。由 startDeviceBridge
  // 从 rootsProvider/localWorker.authorizedRoots 取值存入；null＝未设定（不下发）。
  roots: null,
  // 稳定安装识别（缺陷修复）：register body.device_id。由 startDeviceBridge 从
  // deviceIdProvider 取值存入；null＝未设定（不下发，回退闸道自行配 id）。
  installDeviceId: null,
  // 对话内就地授权（缺陷修复）：记忆体累积的同意根（session/permanent 收到的根，
  // 去重）。once 不进此处。register 时与 runtime.roots 联集下发；handleRequest 时
  // 作为 grantedRoots 并入 allowlist 与第二道防线。
  consentRoots: [],
  // 注入点（型别错＝视为未设定，不得把 undefined 当空阵列而清空既有授权）：
  //   persistConsentRoots — 收到 permanent 时落盘（由 main.js 并入 settings 并写回）。
  //   auditConsent        — 每接受一个**新的**同意根追加一行本机稽核（无 token/apiKey）。
  //   consentRootsProvider— 启动时读取已落盘的永久同意根（供 register 与放行）。
  persistConsentRoots: null,
  auditConsent: null,
};

function snapshot() {
  return {
    status: runtime.status,
    enabled: runtime.enabled,
    deviceId: runtime.deviceId,
    heartbeatIntervalMs: runtime.heartbeatIntervalMs,
    mode: runtime.mode,
    lastError: runtime.lastError,
  };
}

function setStatus(status, detail) {
  runtime.status = status;
  runtime.lastError = detail || null;
  if (typeof runtime.onStatus === "function") {
    try {
      runtime.onStatus(snapshot());
    } catch {
      /* 指示器失败不得影响 bridge */
    }
  }
}

// ── HTTP（唯一出网点；凭证只进 Authorization 标头，永不入 log）────────────

function errorCodeOf(status, json) {
  if (json && json.error && typeof json.error.code === "string") return json.error.code;
  return `http_${status}`;
}

async function post(pathname, body) {
  const url = /^https?:\/\//.test(pathname) ? pathname : runtime.gatewayBaseUrl + pathname;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${runtime.credential}`,
    },
    body: JSON.stringify(body || {}),
    signal: runtime.controller ? runtime.controller.signal : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function postOk(pathname, body) {
  const { status, json } = await post(pathname, body);
  if (status !== 200 || !json || json.ok !== true) {
    throw new BridgeError(errorCodeOf(status, json), status);
  }
  return json;
}

// ── 路径闸与四个唯读工具：已抽到 lib/bridge-executor.js（可测）────────────
// client 只保留连线与编排；executeTool/requireLocalPath/resolveReal 一律走
// executor（同一份 policy denylist + 必填 allowlist 语义）。

// ── 取件 → 执行 → 回传 ─────────────────────────────────────────────────

async function submitError(requestId, consentToken, message) {
  if (!requestId) return;
  try {
    await post(`${PREFIX}/result`, {
      device_id: runtime.deviceId,
      connection_id: runtime.connectionId,
      request_id: requestId,
      // M4：错误回报同样带票。闸道 result 一律先 consume 同意票，缺票必得
      // consent_token_not_found → 请求吃满逾时。带票＝路径正确。
      consent_token: consentToken || undefined,
      error: String(message).slice(0, 500),
    });
  } catch {
    /* 回报失败：记录状态，不吞掉连线 */
  }
}

async function handleRequest(request) {
  const requestId = request && typeof request.request_id === "string" ? request.request_id : "";
  const consentToken = request && typeof request.consent_token === "string" ? request.consent_token : "";
  if (!requestId) return;
  // 本机端执行前的同意票检（形状/有效期）；真正的单次原子验票在闸道 result 时。
  if (!consentToken) return submitError(requestId, consentToken, "consent_token_missing");
  if (Number.isFinite(request.expires_at) && request.expires_at <= Date.now()) {
    return submitError(requestId, consentToken, "consent_token_expired");
  }
  if (!proto.isToolAllowed(request.tool)) return submitError(requestId, consentToken, `tool_not_allowed: ${String(request.tool)}`);
  const clean = proto.sanitizeToolArgs(request.tool, request.args);
  if (!clean.ok) return submitError(requestId, consentToken, `${clean.code}: ${clean.message}`);

  // 对话内就地授权：解析本请求的 consent（形状不合／未知 scope ＝ 当没有，不得抛）。
  // session/permanent 的根累积进记忆体（去重）；permanent 另呼叫 persistConsentRoots 落盘。
  // once 只对本请求有效（不进记忆体、不落盘）。任一注入缺失＝只影响落盘/稽核，不影响放行。
  const consent = parseConsent(request.consent);
  if (consent && consent.scope !== "once") {
    for (const root of consent.roots) {
      if (runtime.consentRoots.includes(root)) continue;
      runtime.consentRoots.push(root);
      if (typeof runtime.auditConsent === "function") {
        try {
          runtime.auditConsent({ scope: consent.scope, root });
        } catch {
          /* 稽核失败不得影响执行 */
        }
      }
    }
    if (consent.scope === "permanent" && typeof runtime.persistConsentRoots === "function") {
      try {
        runtime.persistConsentRoots(consent.roots.slice());
      } catch {
        /* 落盘失败＝永久授权本轮仍有效，不阻塞本次执行 */
      }
    }
  }
  const grantedRoots = unionRoots(
    runtime.consentRoots,
    consent && consent.scope === "once" ? consent.roots : [],
  );

  let result;
  try {
    result = await executor.executeTool(request.tool, clean.args, { grantedRoots });
  } catch (err) {
    const code = err && err.code ? err.code : "device_op_failed";
    return submitError(requestId, consentToken, `${code}: ${err && err.message ? err.message : "tool failed"}`);
  }
  const clamped = proto.clampResult(result, proto.MAX_RESULT_BYTES);
  await postOk(`${PREFIX}/result`, {
    device_id: runtime.deviceId,
    connection_id: runtime.connectionId,
    request_id: requestId,
    consent_token: consentToken,
    result: clamped.result,
  });
}

// ── 连线生命周期（注册 → 心跳 → 长轮询；失败指数退避重连）───────────────

function stopHeartbeat() {
  if (runtime.heartbeatTimer) {
    clearTimeout(runtime.heartbeatTimer);
    runtime.heartbeatTimer = null;
  }
}

async function registerOnce() {
  // W6c：register body 带上权限模式与规则（未设定＝不下发栏位，维持既有呼叫端行为）。
  // 闸道契约：mode ∈ off/ask/auto/full，缺＝ask；rules 为三桶/扁平规则阵列。
  // roots（缺陷修复）：闸道以 body.roots 建立 authorizedRoots（device-bridge.ts:1048
  // → register() 的 sanitizeAuthorizedRoots(input.roots)）；缺＝空集 ⇒ list_dir/grep
  // 恒 403 `no_authorized_root`。务必下发，形状＝string[]（与闸道契约逐栏一致）。
  // 空值处理：startDeviceBridge 对空授权根已先拒绝服务（no_authorized_roots、根本不会
  // 走到 register），故此处正常必为非空阵列；防御上仍照实下发阵列（闸道对「缺栏位」与
  // 「空阵列」同视为空集，且装置身分由 deviceKey(tenant,deviceId) 决定、与 roots 无关，
  // 不会被误判成「无装置」）——明确空阵列比省栏位更能让闸道端对帐。
  const body = {};
  // home（缺陷修复）：register 从不送 home ⇒ 闸道 authorizationRootProblem 的
  // `root_too_broad`（家目录本身不可授权）判不出来。下发 os.homedir() 让它生效。
  body.home = os.homedir();
  // 稳定安装识别（缺陷修复）：带上即「同装置重注册＝换连线、旧连线作废」，闸道以
  // deviceKey(tenant,deviceId) 取代同一笔纪录，不会累积多台 online（见档头 helper 注解）。
  if (typeof runtime.installDeviceId === "string" && runtime.installDeviceId) body.device_id = runtime.installDeviceId;
  if (runtime.mode !== null && runtime.mode !== undefined) body.mode = runtime.mode;
  // roots/rules ＝ 已设定（使用者挑的根／既有规则）∪ 对话内同意根（及其 allow 规则）。
  // 只做联集，不改变既有 rootsProvider 来源；无同意时逐值等于既有下发内容。
  const consentRoots = Array.isArray(runtime.consentRoots) ? runtime.consentRoots : [];
  if (runtime.rules !== undefined || consentRoots.length > 0) {
    body.rules = withConsentAllowRules(runtime.rules, consentRoots);
  }
  if (Array.isArray(runtime.roots) || consentRoots.length > 0) {
    body.roots = unionRoots(Array.isArray(runtime.roots) ? runtime.roots : [], consentRoots);
  }
  const reg = await postOk(`${PREFIX}/register`, body);
  runtime.deviceId = typeof reg.device_id === "string" ? reg.device_id : null;
  runtime.connectionId = typeof reg.connection_id === "string" ? reg.connection_id : null;
  if (!runtime.deviceId || !runtime.connectionId) throw new BridgeError("register_failed", 200);
  const hb = Number(reg.heartbeat_interval_ms);
  runtime.heartbeatIntervalMs = Number.isFinite(hb) && hb > 0 ? hb : DEFAULT_HEARTBEAT_MS;
  runtime.pollUrl = typeof reg.poll_url === "string" && reg.poll_url ? reg.poll_url : `${PREFIX}/poll`;
}

function startHeartbeat() {
  stopHeartbeat();
  const gen = runtime.gen;
  const tick = async () => {
    if (!runtime.running || runtime.gen !== gen) return;
    try {
      await postOk(`${PREFIX}/heartbeat`, {
        device_id: runtime.deviceId,
        connection_id: runtime.connectionId,
      });
    } catch (err) {
      if (runtime.running && runtime.gen === gen) disconnect(err && err.code ? err.code : "network_error");
      return;
    }
    if (runtime.running && runtime.gen === gen) {
      runtime.heartbeatTimer = setTimeout(tick, Math.max(1000, runtime.heartbeatIntervalMs));
    }
  };
  runtime.heartbeatTimer = setTimeout(tick, Math.max(1000, runtime.heartbeatIntervalMs));
}

function startPoll() {
  runtime.polling = true;
  const gen = runtime.gen;
  void (async () => {
    while (runtime.running && runtime.polling && runtime.gen === gen) {
      let request = null;
      try {
        const json = await postOk(runtime.pollUrl, {
          device_id: runtime.deviceId,
          connection_id: runtime.connectionId,
          wait_ms: DEFAULT_POLL_WAIT_MS,
        });
        request = json.request || null;
      } catch (err) {
        if (!runtime.running || !runtime.polling || runtime.gen !== gen) return;
        disconnect(err && err.code ? err.code : "network_error");
        return;
      }
      if (request) {
        try {
          await handleRequest(request);
        } catch (err) {
          // 单件失败（含回报网路错）不停 loop；连线问题会由下一次 poll 触发重连。
          runtime.lastError = err && err.code ? err.code : "request_failed";
        }
      }
    }
  })();
}

function scheduleReconnect(code) {
  if (!runtime.running || runtime.reconnectTimer) return;
  const delay = proto.nextBackoff(runtime.attempt, { jitterRatio: 0.2 });
  runtime.attempt += 1;
  setStatus("reconnecting", code);
  runtime.reconnectTimer = setTimeout(() => {
    runtime.reconnectTimer = null;
    void connect();
  }, delay);
}

/** 任何心跳/轮询失败：停心跳、中止 in-flight 请求、排程退避重连。 */
function disconnect(code) {
  if (!runtime.running) return;
  runtime.gen += 1;
  stopHeartbeat();
  runtime.polling = false;
  if (runtime.controller) {
    try {
      runtime.controller.abort();
    } catch {
      /* noop */
    }
  }
  scheduleReconnect(code);
}

async function connect() {
  if (!runtime.running) return;
  runtime.controller = new AbortController();
  try {
    await registerOnce();
    runtime.attempt = 0;
    setStatus("online");
    startHeartbeat();
    startPoll();
  } catch (err) {
    scheduleReconnect(err && err.code ? err.code : "network_error");
  }
}

// ── 对外 API ───────────────────────────────────────────────────────────

/**
 * 启动 device bridge（预设不启动：enabled !== true 即停在 "off"）。
 * @param {{gatewayBaseUrl?:string, credentialProvider?:()=>Promise<string|null>|string|null, enabled?:boolean, rootsProvider?:()=>string[], modeProvider?:()=>("off"|"ask"|"auto"|"full"), rulesProvider?:()=>unknown, deviceIdProvider?:()=>string, consentRootsProvider?:()=>string[], persistConsentRoots?:(roots:string[])=>void, auditConsent?:(entry:{scope:string,root:string})=>void, onStatus?:(s:object)=>void}} opts
 * @returns {Promise<object>} 状态快照
 */
async function startDeviceBridge(opts = {}) {
  if (runtime.running) return snapshot();
  if (opts.gatewayBaseUrl) runtime.gatewayBaseUrl = String(opts.gatewayBaseUrl).replace(/\/+$/, "");
  if (typeof opts.onStatus === "function") runtime.onStatus = opts.onStatus;
  runtime.enabled = opts.enabled === true;

  // W6c：注入点一律验型别（教训：跨界传错型别会被下游守卫静默降级）。
  // modeProvider 必须是 function 且回白名单值；否则视为未设定（不下发、执行器回退 auto）。
  runtime.mode = null;
  runtime.rules = undefined;
  runtime.roots = null;
  if (typeof opts.modeProvider === "function") {
    try {
      const m = opts.modeProvider();
      runtime.mode = typeof m === "string" && PERMISSION_MODES.includes(m) ? m : null;
    } catch {
      runtime.mode = null;
    }
  }
  if (typeof opts.rulesProvider === "function") {
    try {
      const r = opts.rulesProvider();
      runtime.rules = r === undefined || r === null ? undefined : r;
    } catch {
      runtime.rules = undefined;
    }
  }

  // 稳定安装识别（缺陷修复）：main.js 以 settings.json 白名单栏位（deviceBridgeDeviceId）
  // 适配的 provider 注入；型别/值错一律视为未设定（不下发 device_id，回退闸道自行配 id
  // 的既有行为，与 modeProvider 注入点同规矩）。
  runtime.installDeviceId = null;
  if (typeof opts.deviceIdProvider === "function") {
    try {
      const v = opts.deviceIdProvider();
      runtime.installDeviceId = typeof v === "string" && v.trim() ? v.trim().slice(0, 128) : null;
    } catch {
      runtime.installDeviceId = null;
    }
  }

  // 对话内就地授权（缺陷修复）：注入点一律验型别（同 modeProvider 规矩，型别错＝未设定）。
  // consentRootsProvider 提供**已落盘**的永久同意根（重启后 register/放行仍有效）；
  // persistConsentRoots 于收到 permanent 时落盘；auditConsent 选配（本机稽核，不含机密）。
  runtime.persistConsentRoots = typeof opts.persistConsentRoots === "function" ? opts.persistConsentRoots : null;
  runtime.auditConsent = typeof opts.auditConsent === "function" ? opts.auditConsent : null;
  runtime.consentRoots = [];
  if (typeof opts.consentRootsProvider === "function") {
    try {
      runtime.consentRoots = normalizeConsentRootList(opts.consentRootsProvider());
    } catch {
      runtime.consentRoots = [];
    }
  }

  if (!runtime.enabled) {
    setStatus("off");
    return snapshot();
  }

  // H1：allowlist 必填。无授权根（使用者尚未 pickFiles 挑过任何根）⇒ 整条 bridge
  // 拒绝服务并回明确状态，**不得**退回「只验 denylist」。这是正确且刻意的结果。
  // 有效根 ＝ rootsProvider() ∪ 已落盘的同意根（永久授权在重启后仍能服务）。
  const baseRoots = typeof opts.rootsProvider === "function" ? opts.rootsProvider() : Array.from(localWorker.authorizedRoots);
  const roots = unionRoots(Array.isArray(baseRoots) ? baseRoots : [], runtime.consentRoots);
  if (roots.length === 0) {
    runtime.credential = null;
    setStatus("no_authorized_roots", "no_authorized_roots");
    return snapshot();
  }
  // 存入 runtime 供 registerOnce 下发（H：此前只做本机前置闸，从未上报闸道）。
  runtime.roots = roots;

  let credential = null;
  // W7a（2026-10-05）短效装置票优先：页面（已登录）经窄 IPC 推来 `sk-dev-…`，
  // 壳拿它当 Bearer。票是**记忆体**的东西、分钟级到期、闸道重启即失效（＝可撤销），
  // 取代「使用者手放 0600 key 档」这条对真实使用者不可行的路。票无效／没票才回退
  // 既有 credentialProvider（0600 档），两者皆无 = 今日行为（停在 credentials_unavailable
  // 并主动向页面索取一次）。
  let ticketInfo = null;
  try {
    const cand = typeof opts.tokenProvider === "function" ? opts.tokenProvider() : null;
    if (cand && typeof cand.token === "string" && cand.token.startsWith("sk-dev-")) {
      const exp = Number(cand.expiresAt);
      if (Number.isFinite(exp) && exp > Date.now()) ticketInfo = cand;
    }
  } catch {
    ticketInfo = null;
  }
  if (ticketInfo) {
    if (typeof ticketInfo.gatewayBaseUrl === "string" && /^https?:\/\//.test(ticketInfo.gatewayBaseUrl)) {
      runtime.gatewayBaseUrl = ticketInfo.gatewayBaseUrl.replace(/\/+$/, "");
    }
    credential = ticketInfo.token;
  } else {
    try {
      credential = typeof opts.credentialProvider === "function" ? await opts.credentialProvider() : null;
    } catch {
      credential = null;
    }
  }
  if (typeof credential !== "string" || credential.trim().length === 0) {
    runtime.credential = null;
    setStatus("credentials_unavailable", "credentials_unavailable");
    // 主动向页面索取一张票（页面重新铸票后会再推一次）。失败/无订阅端点一律吞掉，
    // 不得因为「没人给票」而抛错或疯狂重连。
    if (typeof opts.onCredentialRequired === "function") {
      try {
        opts.onCredentialRequired({ reason: "credentials_unavailable" });
      } catch {
        /* noop */
      }
    }
    return snapshot();
  }

  runtime.credential = credential;
  runtime.running = true;
  setStatus("connecting");
  await connect();
  return snapshot();
}

/** 停止并清除所有计时器/请求；幂等。 */
function stopDeviceBridge() {
  runtime.running = false;
  runtime.polling = false;
  runtime.gen += 1;
  stopHeartbeat();
  if (runtime.reconnectTimer) {
    clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = null;
  }
  if (runtime.controller) {
    try {
      runtime.controller.abort();
    } catch {
      /* noop */
    }
    runtime.controller = null;
  }
  runtime.deviceId = null;
  runtime.connectionId = null;
  runtime.credential = null; // 不保留凭证
  runtime.attempt = 0;
  setStatus("off");
  return snapshot();
}

/** 观测用状态快照。 */
function getDeviceBridgeState() {
  return snapshot();
}

/**
 * 程式化登记授权根（与 pickFiles 写入的是**同一份** authorizedRoots；非第二套机制）。
 * 回传目前授权根清单（realpath）。正常路径由 W3 的 pickFiles 在使用者挑选时登记。
 */
function authorizeDeviceBridgeRoots(paths) {
  return localWorker.authorizeRoots(paths).map((entry) => entry.real);
}

module.exports = {
  startDeviceBridge,
  stopDeviceBridge,
  getDeviceBridgeState,
  authorizeDeviceBridgeRoots,
  resolveStableDeviceId,
  generateStableDeviceId,
  PREFIX,
  DEFAULT_GATEWAY_BASE_URL,
  __test: {
    handleRequest,
    executeTool: executor.executeTool,
    requireLocalPath: executor.requireLocalPath,
    resolveReal: executor.resolveReal,
    runtime,
    BridgeError,
    parseConsent,
    withConsentAllowRules,
    normalizeConsentRootList,
  },
};
