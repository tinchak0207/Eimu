// desktop/device-bridge-client.js
//
// W6b：device bridge「本機側」主進程客戶端。方向永遠是**出站**：本機主動向閘道
// 註冊 → 心跳 → 長輪詢取件 → 在本機執行白名單唯讀工具 → 回傳結果。雲端永不
// inbound 打使用者機器。
//
// 與雲端契約逐欄對齊：deploy-staging/gateway/device-bridge.ts（handleDeviceBridgeRoutes）
//   POST /agent/v1/device-bridge/register  → { device_id, connection_id, heartbeat_interval_ms, poll_url }
//   POST /agent/v1/device-bridge/heartbeat → { device_id, connection_id }            → { pending_count, server_time_ms }
//   POST /agent/v1/device-bridge/poll      → { device_id, connection_id, wait_ms }   → { request|null }
//   POST /agent/v1/device-bridge/result    → { device_id, connection_id, request_id, consent_token, result|error }
//   POST /agent/v1/device-bridge/invoke    → 雲端 agent 發起（本檔不呼叫）
// 錯誤碼：device_connection_stale / device_offline / device_request_not_found /
// consent_token_{not_found,expired,mismatch,replayed}（閘道於 result 時再驗票）。
//
// ── 預設 OFF（硬性）─────────────────────────────────────────────────────
// 只有 opts.enabled === true 才連；否則停在 "off"，一個位元組都不出網。
//
// ── 憑證缺口（誠實處理，不自造鑑權）─────────────────────────────────────
// 閘道鑑權沿用既有 Bearer sk-biz-*（auth-gw.ts）。桌面殼載入遠端頁面、只有
// session，**沒有** biz key，也**不**在此硬編任何 key。改以 credentialProvider
// 注入點接受憑證；回 null/空 → bridge 不啟動並回報 credentials_unavailable。
// 補法見 desktop/DEVICE-BRIDGE.md。
//
// ── 安全邊界（能力寧可少；執行器抽到 lib/bridge-executor.js，可測）────────
//  1. 工具白名單＝list_dir/read_file/grep/stat（無寫/刪/執行）。
//  2. 路徑先 realpath 解 symlink，再過 policy.js isSensitivePath（denylist，掃所有
//     路徑段，與雲端 device-bridge-policy.ts 同語義）。
//  3. allowlist **必填**：授權根來自 local-worker.js 的**同一份** authorizedRoots
//     （使用者由 pickFiles 顯式挑選的根），空集＝全拒並拒絕服務；**不得**退回
//     「只驗 denylist」。
//  4. 拒絕檔案系統根路徑（path_is_root）；grep 逐檔大小上限，避免整檔入記憶體。
//  5. 回傳前 clampResult 夾 256KB＋截斷標記（與雲端側同上限）。
//  6. consent_token 執行前先驗形狀/有效期（真正的原子驗票在閘道 result 時）；
//     **錯誤回報同樣帶票**（M4，否則閘道先 consume 一律 not_found 吃滿逾時）。
//  7. 任何 log 只寫狀態與錯誤碼，**永不**寫憑證或檔案內容。

"use strict";

const proto = require("./lib/bridge-protocol.js");
const { createBridgeExecutor, BridgeError } = require("./lib/bridge-executor.js");
const localWorker = require("./local-worker.js");

const PREFIX = "/agent/v1/device-bridge";
const DEFAULT_GATEWAY_BASE_URL = "https://image.tinchak0207.xyz";
const DEFAULT_POLL_WAIT_MS = 20000; // <= 閘道 DEVICE_POLL_MAX_WAIT_MS(25000)
const DEFAULT_HEARTBEAT_MS = 30000;

// 單一授權來源：直接讀 local-worker 的 authorizedRoots（pickFiles 顯式挑選）。
// 不另造第二套授權機制；空集 ⇒ bridge 拒絕服務（見 startDeviceBridge）。
const executor = createBridgeExecutor({ roots: () => Array.from(localWorker.authorizedRoots) });

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
  gen: 0, // 連線世代：重連/停止時遞增，讓舊迴圈自行退場（防重連後雙迴圈）
  controller: null,
  heartbeatTimer: null,
  reconnectTimer: null,
  lastError: null,
  onStatus: null,
};

function snapshot() {
  return {
    status: runtime.status,
    enabled: runtime.enabled,
    deviceId: runtime.deviceId,
    heartbeatIntervalMs: runtime.heartbeatIntervalMs,
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
      /* 指示器失敗不得影響 bridge */
    }
  }
}

// ── HTTP（唯一出網點；憑證只進 Authorization 標頭，永不入 log）────────────

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

// ── 路徑閘與四個唯讀工具：已抽到 lib/bridge-executor.js（可測）────────────
// client 只保留連線與編排；executeTool/requireLocalPath/resolveReal 一律走
// executor（同一份 policy denylist + 必填 allowlist 語義）。

// ── 取件 → 執行 → 回傳 ─────────────────────────────────────────────────

async function submitError(requestId, consentToken, message) {
  if (!requestId) return;
  try {
    await post(`${PREFIX}/result`, {
      device_id: runtime.deviceId,
      connection_id: runtime.connectionId,
      request_id: requestId,
      // M4：錯誤回報同樣帶票。閘道 result 一律先 consume 同意票，缺票必得
      // consent_token_not_found → 請求吃滿逾時。帶票＝路徑正確。
      consent_token: consentToken || undefined,
      error: String(message).slice(0, 500),
    });
  } catch {
    /* 回報失敗：記錄狀態，不吞掉連線 */
  }
}

async function handleRequest(request) {
  const requestId = request && typeof request.request_id === "string" ? request.request_id : "";
  const consentToken = request && typeof request.consent_token === "string" ? request.consent_token : "";
  if (!requestId) return;
  // 本機端執行前的同意票檢（形狀/有效期）；真正的單次原子驗票在閘道 result 時。
  if (!consentToken) return submitError(requestId, consentToken, "consent_token_missing");
  if (Number.isFinite(request.expires_at) && request.expires_at <= Date.now()) {
    return submitError(requestId, consentToken, "consent_token_expired");
  }
  if (!proto.isToolAllowed(request.tool)) return submitError(requestId, consentToken, `tool_not_allowed: ${String(request.tool)}`);
  const clean = proto.sanitizeToolArgs(request.tool, request.args);
  if (!clean.ok) return submitError(requestId, consentToken, `${clean.code}: ${clean.message}`);

  let result;
  try {
    result = await executor.executeTool(request.tool, clean.args);
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

// ── 連線生命週期（註冊 → 心跳 → 長輪詢；失敗指數退避重連）───────────────

function stopHeartbeat() {
  if (runtime.heartbeatTimer) {
    clearTimeout(runtime.heartbeatTimer);
    runtime.heartbeatTimer = null;
  }
}

async function registerOnce() {
  const reg = await postOk(`${PREFIX}/register`, {});
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
          // 單件失敗（含回報網路錯）不停 loop；連線問題會由下一次 poll 觸發重連。
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

/** 任何心跳/輪詢失敗：停心跳、中止 in-flight 請求、排程退避重連。 */
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

// ── 對外 API ───────────────────────────────────────────────────────────

/**
 * 啟動 device bridge（預設不啟動：enabled !== true 即停在 "off"）。
 * @param {{gatewayBaseUrl?:string, credentialProvider?:()=>Promise<string|null>|string|null, enabled?:boolean, rootsProvider?:()=>string[], onStatus?:(s:object)=>void}} opts
 * @returns {Promise<object>} 狀態快照
 */
async function startDeviceBridge(opts = {}) {
  if (runtime.running) return snapshot();
  if (opts.gatewayBaseUrl) runtime.gatewayBaseUrl = String(opts.gatewayBaseUrl).replace(/\/+$/, "");
  if (typeof opts.onStatus === "function") runtime.onStatus = opts.onStatus;
  runtime.enabled = opts.enabled === true;

  if (!runtime.enabled) {
    setStatus("off");
    return snapshot();
  }

  // H1：allowlist 必填。無授權根（使用者尚未 pickFiles 挑過任何根）⇒ 整條 bridge
  // 拒絕服務並回明確狀態，**不得**退回「只驗 denylist」。這是正確且刻意的結果。
  const roots = typeof opts.rootsProvider === "function" ? opts.rootsProvider() : Array.from(localWorker.authorizedRoots);
  if (!Array.isArray(roots) || roots.length === 0) {
    runtime.credential = null;
    setStatus("no_authorized_roots", "no_authorized_roots");
    return snapshot();
  }

  let credential = null;
  try {
    credential = typeof opts.credentialProvider === "function" ? await opts.credentialProvider() : null;
  } catch {
    credential = null;
  }
  if (typeof credential !== "string" || credential.trim().length === 0) {
    runtime.credential = null;
    setStatus("credentials_unavailable", "credentials_unavailable");
    return snapshot();
  }

  runtime.credential = credential;
  runtime.running = true;
  setStatus("connecting");
  await connect();
  return snapshot();
}

/** 停止並清除所有計時器/請求；冪等。 */
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
  runtime.credential = null; // 不保留憑證
  runtime.attempt = 0;
  setStatus("off");
  return snapshot();
}

/** 觀測用狀態快照。 */
function getDeviceBridgeState() {
  return snapshot();
}

/**
 * 程式化登記授權根（與 pickFiles 寫入的是**同一份** authorizedRoots；非第二套機制）。
 * 回傳目前授權根清單（realpath）。正常路徑由 W3 的 pickFiles 在使用者挑選時登記。
 */
function authorizeDeviceBridgeRoots(paths) {
  return localWorker.authorizeRoots(paths).map((entry) => entry.real);
}

module.exports = {
  startDeviceBridge,
  stopDeviceBridge,
  getDeviceBridgeState,
  authorizeDeviceBridgeRoots,
  PREFIX,
  DEFAULT_GATEWAY_BASE_URL,
  __test: {
    handleRequest,
    executeTool: executor.executeTool,
    requireLocalPath: executor.requireLocalPath,
    resolveReal: executor.resolveReal,
    runtime,
    BridgeError,
  },
};
