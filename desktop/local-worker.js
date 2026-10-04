// desktop/local-worker.js
//
// W3：主進程側的本機媒體工人。以 ipcMain.handle 實作 preload 暴露的 5 個 API。
//
// 安全模型（詳見 LOCAL-CAPABILITIES.md）：
//   1. 每個 handler 先驗 event.senderFrame 的 host 屬於 APP_HOSTS，否則拒。
//   2. 路徑一律先 realpath（解 symlink）再過 isPathAllowed：
//      只有使用者「剛用 pickFiles 主動挑選」過的檔案本身或其授權根之下才放行。
//   3. 再過 isSensitivePath denylist（~/.ssh、憑證、瀏覽器 profile…）。
//   4. ffmpeg 一律 spawn(bin, argv, {shell:false})，argv 由 policy.buildFfmpegArgs
//      以白名單／數值校驗生成，逾時 SIGKILL。
//   5. 輸出檔預設寫入本進程管理的臨時目錄；只有落在授權根內的使用者指定
//      輸出路徑才接受。
//
// 本檔不做任何業務邏輯，只做 IO 與授權閘。

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { ipcMain, dialog, BrowserWindow, app } = require("electron");
const { spawn } = require("node:child_process");

const policy = require("./lib/policy.js");
const { LocalError } = policy;

const CHANNELS = {
  capabilities: "eimu-local:capabilities",
  pickFiles: "eimu-local:pick-files",
  probe: "eimu-local:probe",
  extractFrames: "eimu-local:extract-frames",
  transcode: "eimu-local:transcode",
  // W6c：device bridge 的使用者介面（本機檔案授權）。invoke 三個 + 一個 event。
  authorizedRoots: "eimu-local:authorized-roots",
  bridgeStatus: "eimu-local:bridge-status",
  bridgeEnable: "eimu-local:bridge-enable",
  bridgeDisable: "eimu-local:bridge-disable",
  // 主進程 → 頁面的狀態推送（preload 的 onBridgeStatus 訂閱此 channel）。
  bridgeEvent: "eimu-local:bridge-state",
};

const PROBE_TIMEOUT_MS = 15000;
const FRAME_TIMEOUT_MS = 45000;
const TRANSCODE_TIMEOUT_DEFAULT_MS = 300000;
const TRANSCODE_TIMEOUT_MAX_MS = 600000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

// 使用者逐次挑選後累積的授權集（真實絕對路徑，已解 symlink）。
const authorizedRoots = new Set();

let appHosts = new Set();
// device bridge 生命週期控制器（由 main.js 於 registerLocalWorker 注入；見下方
// createBridgeController）。null＝尚未接線，bridge.* 的查詢會回 off、啟停會拒絕。
let bridgeController = null;
let registered = false;
let ffmpegBin = null; // 解析結果快取（含 null = 已探測無）
let ffmpegProbed = false;
let ffprobeBin = null;
let ffprobeProbed = false;
const gate = new policy.FfmpegGate();

// ---------------------------------------------------------------------------
// 信封 / origin
// ---------------------------------------------------------------------------

const ok = (value) => ({ ok: true, value });
const fail = (err) => {
  const code = err instanceof LocalError ? err.code : "E_INTERNAL";
  return { ok: false, code, message: err && err.message ? String(err.message) : "未知錯誤" };
};

/** 設定 APP_HOSTS 白名單（main.js 與測試共用同一入口）。 */
function setAppHosts(hosts) {
  appHosts = hosts instanceof Set ? hosts : new Set(Array.isArray(hosts) ? hosts : []);
}

/** 只有 APP_HOSTS 的頂層 frame 可呼叫；其餘（含 iframe 外部站）一律拒。 */
function assertTrustedSender(event) {
  let frame = null;
  let url = "";
  try {
    frame = event.senderFrame;
    url = frame && frame.url ? frame.url : "";
  } catch {
    throw new LocalError("E_UNTRUSTED_ORIGIN", "無法解析來源 frame");
  }
  if (!policy.isAppHost(url, appHosts)) {
    throw new LocalError("E_UNTRUSTED_ORIGIN", `來源不在 App 白名單：${String(url).slice(0, 120)}`);
  }
  if (frame && frame.parent) {
    throw new LocalError("E_UNTRUSTED_ORIGIN", "僅接受頂層 frame 呼叫");
  }
}

// ---------------------------------------------------------------------------
// 路徑授權
// ---------------------------------------------------------------------------

/** 解 symlink；不存在時對父目錄解 symlink 再接回 basename（輸出檔常用）。 */
function resolveReal(p) {
  const realpath = fs.realpathSync.native || fs.realpathSync;
  try {
    return realpath(p);
  } catch {
    try {
      return path.join(realpath(path.dirname(p)), path.basename(p));
    } catch {
      return path.resolve(p);
    }
  }
}

/** 檢查輸入路徑已授權且非敏感；回傳其 realpath。 */
function requireAuthorizedInput(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new LocalError("E_BAD_ARGS", "路徑必須是非空字串");
  }
  const real = resolveReal(rawPath);
  if (policy.isSensitivePath(real)) {
    throw new LocalError("E_SENSITIVE_PATH", "該路徑屬於敏感位置，拒絕存取");
  }
  if (!policy.isPathAllowed(real, Array.from(authorizedRoots))) {
    throw new LocalError("E_NOT_AUTHORIZED", "尚未透過 pickFiles 授權此路徑");
  }
  if (!fs.existsSync(real)) {
    throw new LocalError("E_NOT_FOUND", "檔案不存在");
  }
  return real;
}

/**
 * 登記使用者**顯式授權**的根（pickFiles 挑選後呼叫；device bridge 共用同一份）。
 * 這是唯一的授權來源：不另造第二套授權機制。敏感位置即使被挑選也拒。
 * @param {string[]} paths 使用者挑選的原始路徑
 * @returns {{input:string, real:string}[]} 實際被接受的項目（input=原樣、real=已解 symlink）
 */
function authorizeRoots(paths) {
  const accepted = [];
  if (!Array.isArray(paths)) return accepted;
  for (const p of paths) {
    if (typeof p !== "string" || p.length === 0) continue;
    const real = resolveReal(p);
    if (policy.isSensitivePath(real)) continue; // 敏感位置即使被挑選也拒
    authorizedRoots.add(real);
    accepted.push({ input: p, real });
  }
  return accepted;
}

function ensureOutputDir() {
  const dir = path.join(app.getPath("temp"), "eimu-local-output");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function defaultOutputPath(inputReal, format) {
  const ext = `.${format}`;
  const base = path.basename(inputReal, path.extname(inputReal));
  const tag = crypto.randomBytes(4).toString("hex");
  return path.join(ensureOutputDir(), `${base}.eimu.${tag}${ext}`);
}

// ---------------------------------------------------------------------------
// ffmpeg 探測與執行
// ---------------------------------------------------------------------------

async function runProcess(bin, args, timeoutMs) {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: String(err && err.message), spawnError: true });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += d.toString();
    });
    child.on("error", (err) => finish({ code: -1, stdout, stderr: String(err && err.message), spawnError: true }));
    child.on("close", (code) => {
      if (timedOut) finish({ code: -1, stdout, stderr: stderr + `\n[timeout ${timeoutMs}ms]`, timedOut: true });
      else finish({ code: code === null ? -1 : code, stdout, stderr });
    });
  });
}

/** ffprobe 候選：由 ffmpeg 候選把 basename 的 ffmpeg 換成 ffprobe，再補 PATH。 */
function ffprobeCandidates() {
  const list = policy.pickFfmpegCandidate(process.env, process.platform);
  const out = list.map((p) => (/ffmpeg(\.exe)?$/i.test(p) ? p.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith(".exe") ? "ffprobe.exe" : "ffprobe")) : `${p}probe`));
  out.unshift("ffprobe");
  return Array.from(new Set(out));
}

async function resolveFfmpeg() {
  if (ffmpegProbed) return ffmpegBin;
  for (const cand of policy.pickFfmpegCandidate(process.env, process.platform)) {
    const r = await runProcess(cand, ["-version"], 5000);
    if (!r.spawnError && r.code === 0) {
      ffmpegBin = cand;
      break;
    }
  }
  ffmpegProbed = true;
  return ffmpegBin;
}

async function resolveFfprobe() {
  if (ffprobeProbed) return ffprobeBin;
  for (const cand of ffprobeCandidates()) {
    const r = await runProcess(cand, ["-version"], 5000);
    if (!r.spawnError && r.code === 0) {
      ffprobeBin = cand;
      break;
    }
  }
  ffprobeProbed = true;
  return ffprobeBin;
}

function ffmpegVersionLine(stdout) {
  const line = String(stdout).split("\n")[0] || "";
  return line.slice(0, 200);
}

/** 執行已驗證的 ffmpeg op，過閘並處理逾時；失敗擲 LocalError。 */
async function runGatedFfmpeg(args, timeoutMs) {
  const bin = await resolveFfmpeg();
  if (!bin) throw new LocalError("E_FFMPEG_MISSING", "找不到可用的 ffmpeg 執行檔");
  const res = await gate.run(() => runProcess(bin, args, timeoutMs));
  if (res.timedOut) throw new LocalError("E_TIMEOUT", `ffmpeg 逾時（${timeoutMs}ms）`);
  if (res.code !== 0) {
    throw new LocalError("E_FFMPEG_FAILED", (res.stderr || res.stdout || "ffmpeg 非零退出").slice(-600));
  }
  return res;
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

async function handleCapabilities(event) {
  assertTrustedSender(event);
  const bin = await resolveFfmpeg();
  if (!bin) return { ffmpeg: false, version: "", platform: process.platform };
  const r = await runProcess(bin, ["-version"], 5000);
  return { ffmpeg: r.code === 0, version: ffmpegVersionLine(r.stdout || r.stderr), platform: process.platform };
}

// ===========================================================================
// E2E 專用授權閘（**僅測試用；不得用於生產**）
// ---------------------------------------------------------------------------
// 真桌面殼的 E2E 測試需要走完 pickFiles 之後的整條鏈路（probe / extractFrames /
// transcode），但 pickFiles 開的是原生對話框，自動化無法驅動（本機無
// xdotool/ydotool/wtype 可用）。
//
// 因此提供一個**受顯式開關約束的環境變數閘**：只有殼的**啟動環境**（process.env）
// 同時設了 `EIMU_E2E === "1"`（顯式 opt-in）與 `EIMU_E2E_PICK_FILES` 時才生效。
// 其值為分號分隔的絕對路徑，命中時直接當成「使用者剛挑選」的結果回傳並授權，
// 完全不開對話框。**只設 EIMU_E2E_PICK_FILES 而沒有 EIMU_E2E=1 ⇒ 一律忽略**。
//
// 為什麼要這個開關（同意機制旁路風險）：pickFiles 的對話框就是「使用者授權哪些
// 根目錄」的同意動作；授權後 authorizedRoots 才成立，device bridge 的 H1 白名單
// 才成立。若這個閘門隨正式產物無條件生效，任何能控制本機環境變數的程序都能在不
// 經使用者同意的情況下預先授權任意根目錄。加上顯式開關後，正式產物**預設關閉**。
//
// 為什麼不用 `!app.isPackaged` 直接鎖死：E2E harness 跑的就是**打包後**的
// dist-e2e（app.isPackaged === true）；硬門會把 harness 一起鎖死。改以單一顯式
// opt-in 開關取代，兼顧「正式產物預設關閉」與「harness 可運作」（harness 啟動時
// 需一併帶 EIMU_E2E=1；harness.mjs 會把 process.env 透傳給子進程）。
//
// 安全性：遠端頁面（renderer / 遠端內容）碰不到 process.env，無法自行開啟這個閘；
// 只有啟動殼的人（測試 harness）能設定。
//
// 行為不變保證：未設此 env（生產預設）時，下方 handlePickFiles 逐位元組走原本的
// dialog.showOpenDialog 路徑，行為與過往完全相同。
// ===========================================================================
const E2E_ENABLED = process.env.EIMU_E2E === "1";

function e2ePickOverride() {
  if (!E2E_ENABLED) return null;
  const raw = process.env.EIMU_E2E_PICK_FILES;
  if (typeof raw !== "string" || raw.length === 0) return null;
  const paths = raw
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return paths.length ? paths : null;
}

/**
 * 授權使用者挑選的路徑（唯一授權來源 authorizeRoots → authorizedRoots），並在
 * 有新根被接受時通知 bridge 控制器以**當前授權根**重註冊（已啟用才動作）。
 * 回傳實際被接受的項目（input=原樣、real=已解 symlink）。
 */
function applyPickAuthorization(paths) {
  const accepted = authorizeRoots(paths);
  const restarted = notifyRootsAuthorized(accepted); // promise 供測試等待；生產端忽略
  return { accepted, restarted };
}

/**
 * pickFiles 接受新根後通知 bridge（見 createBridgeController.onRootsAuthorized）。
 * 只在已有接受項且控制器已接線時呼叫；重註冊是非同步且**不得**影響 pickFiles
 * 的回傳（不 await、吞錯）。回傳該 promise（供測試等待；生產呼叫端忽略）。
 */
function notifyRootsAuthorized(accepted) {
  if (!bridgeController || !Array.isArray(accepted) || accepted.length === 0) return null;
  try {
    const p = bridgeController.onRootsAuthorized();
    if (p && typeof p.catch === "function") p.catch(() => {});
    return p || null;
  } catch {
    return null;
  }
}

async function handlePickFiles(event, opts) {
  assertTrustedSender(event);
  const e2ePaths = e2ePickOverride();
  if (e2ePaths) {
    // E2E 專用（見上方註解）：不開對話框，直接授權並回傳這些路徑。
    // 留一行可審計的日誌（只在顯式 EIMU_E2E=1 且指定路徑時出現；生產不會有）。
    console.warn(`[eimu-local] E2E 授權閘生效（EIMU_E2E=1）：略過對話框，直接授權 ${e2ePaths.length} 條路徑`);
    return applyPickAuthorization(e2ePaths).accepted.map((entry) => entry.input);
  }
  const clean = policy.sanitizePickOptions(opts);
  const win = BrowserWindow.fromWebContents(event.sender) || undefined;
  const properties = clean.kind === "directory" ? ["openDirectory"] : ["openFile"];
  if (clean.multiple) properties.push("multiSelections");
  const result = await dialog.showOpenDialog(win, {
    title: clean.kind === "directory" ? "選擇資料夾" : "選擇檔案",
    properties,
    filters: clean.filters.length ? clean.filters : undefined,
  });
  if (result.canceled || !Array.isArray(result.filePaths)) return [];
  // 同一份授權來源（authorizeRoots → authorizedRoots）；回傳原始挑選路徑以維持既有行為。
  return applyPickAuthorization(result.filePaths).accepted.map((entry) => entry.input);
}

async function ffprobeJson(inputReal) {
  const bin = await resolveFfprobe();
  if (!bin) throw new LocalError("E_FFPROBE_MISSING", "找不到可用的 ffprobe 執行檔");
  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", inputReal];
  const res = await runProcess(bin, args, PROBE_TIMEOUT_MS);
  if (res.spawnError || res.code !== 0) {
    throw new LocalError("E_FFPROBE_FAILED", (res.stderr || "ffprobe 失敗").slice(-600));
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new LocalError("E_FFPROBE_FAILED", "ffprobe 輸出無法解析");
  }
}

async function handleProbe(event, filePath) {
  assertTrustedSender(event);
  const real = requireAuthorizedInput(filePath);
  const data = await ffprobeJson(real);
  const format = data.format || {};
  const streams = Array.isArray(data.streams) ? data.streams : [];
  return {
    path: real,
    format: format.format_name || null,
    durationSec: Number.isFinite(Number(format.duration)) ? Number(format.duration) : null,
    sizeBytes: Number.isFinite(Number(format.size)) ? Number(format.size) : null,
    streams: streams.map((s) => ({
      index: s.index,
      codecType: s.codec_type,
      codecName: s.codec_name,
      width: s.width || null,
      height: s.height || null,
      channels: s.channels || null,
      sampleRate: s.sample_rate ? Number(s.sample_rate) : null,
    })),
  };
}

async function handleExtractFrames(event, filePath, plan) {
  assertTrustedSender(event);
  const real = requireAuthorizedInput(filePath);
  const clean = policy.sanitizeFramePlan(plan);
  const data = await ffprobeJson(real);
  const duration = Number(data.format && data.format.duration);
  const times = policy.resolveFrameTimes(duration, clean);
  const outDir = path.join(ensureOutputDir(), `frames-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  for (let i = 0; i < times.length; i += 1) {
    const tSec = times[i];
    const outPath = path.join(outDir, `frame_${String(i).padStart(3, "0")}_${tSec.toFixed(2)}.jpg`);
    const args = policy.buildFfmpegArgs("frame", real, outPath, { tSec, maxWidth: clean.maxWidth });
    await runGatedFfmpeg(args, FRAME_TIMEOUT_MS);
    results.push({ tSec, path: outPath });
  }
  return results;
}

async function handleTranscode(event, filePath, opts) {
  assertTrustedSender(event);
  const real = requireAuthorizedInput(filePath);
  const o = opts && typeof opts === "object" ? opts : {};

  let timeoutMs = Number(o.timeoutMs);
  if (!Number.isFinite(timeoutMs)) timeoutMs = TRANSCODE_TIMEOUT_DEFAULT_MS;
  timeoutMs = Math.min(TRANSCODE_TIMEOUT_MAX_MS, Math.max(1000, Math.floor(timeoutMs)));

  const clean = policy.normalizeTranscodeOptions(o);
  let outputPath;
  if (typeof o.outputPath === "string" && o.outputPath.length > 0) {
    const resolved = resolveReal(o.outputPath);
    if (policy.isSensitivePath(resolved)) throw new LocalError("E_SENSITIVE_PATH", "輸出位置屬敏感路徑");
    if (!policy.isPathAllowed(resolved, Array.from(authorizedRoots))) {
      throw new LocalError("E_NOT_AUTHORIZED", "輸出位置不在已授權目錄內");
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    outputPath = resolved;
  } else {
    outputPath = defaultOutputPath(real, clean.format);
  }

  const args = policy.buildFfmpegArgs("transcode", real, outputPath, o);
  await runGatedFfmpeg(args, timeoutMs);
  return { outputPath };
}

// ---------------------------------------------------------------------------
// device bridge 生命週期控制器（可重入；依賴注入以便 node --test）
// ---------------------------------------------------------------------------
// 為什麼把編排放在本檔而不是 main.js：bridge 的四個 API 之 IPC handler 在本檔，
// 且橋必須與 pickFiles 共用同一份 authorizedRoots。做成「純依賴注入」的工廠後，
// 可在純 node 下注入間諜 client（startBridge/stopBridge）對「授權根變更→以新
// roots 重註冊」做真行為斷言，不必啟動 Electron（main.js 頂層呼叫 app API，
// 無法在 node 下 require）。
//
// 授權根**一律即時讀** authorizedRoots（唯一授權來源）；控制器不另存一份。

/**
 * @param {{
 *   startBridge:(opts:object)=>Promise<object>,   // 通常是 device-bridge-client.startDeviceBridge
 *   stopBridge:()=>object|void,                    // 通常是 device-bridge-client.stopDeviceBridge
 *   getClientState?:()=>object,                    // 客戶端狀態快照（status/deviceId/lastError）
 *   readEnabled?:()=>boolean, writeEnabled?:(v:boolean)=>void,  // 使用者設定的持久化
 *   getGatewayBaseUrl?:()=>string|undefined,
 *   credentialProvider?:()=>string|null,
 *   onStatusChange?:(status:object)=>void          // 狀態推送（main 推給所有視窗）
 * }} deps
 */
function createBridgeController(deps = {}) {
  if (typeof deps.startBridge !== "function" || typeof deps.stopBridge !== "function") {
    throw new LocalError("E_BAD_ARGS", "createBridgeController 需要 startBridge/stopBridge");
  }
  const startBridge = deps.startBridge;
  const stopBridge = deps.stopBridge;
  const getClientState = typeof deps.getClientState === "function" ? deps.getClientState : () => ({});
  const writeEnabled = typeof deps.writeEnabled === "function" ? deps.writeEnabled : () => {};
  const getGatewayBaseUrl = typeof deps.getGatewayBaseUrl === "function" ? deps.getGatewayBaseUrl : () => undefined;
  const credentialProvider = typeof deps.credentialProvider === "function" ? deps.credentialProvider : () => null;
  const onStatusChange = typeof deps.onStatusChange === "function" ? deps.onStatusChange : () => {};

  // 使用者「是否已開啟本機檔案授權」的意圖（與客戶端是否真的連上無關）。
  let userEnabled = false;

  const currentRoots = () => Array.from(authorizedRoots);

  // 凍結契約的 state 只有六值（與前端 BridgeState 一致）；客戶端內部的
  // "reconnecting" 一律正規化為 "connecting"，未知值 fail-closed 成 "error"。
  const BRIDGE_STATES = new Set([
    "off",
    "no_authorized_roots",
    "credentials_unavailable",
    "connecting",
    "online",
    "error",
  ]);
  const normalizeState = (raw) => {
    if (raw === "reconnecting") return "connecting";
    return BRIDGE_STATES.has(raw) ? raw : "error";
  };

  /** 凍結契約的狀態形狀：{ enabled, state, roots, deviceId, lastError? }。 */
  function snapshot() {
    if (!userEnabled) return { enabled: false, state: "off", roots: currentRoots(), deviceId: null };
    // 已開啟意圖但尚無授權根：不啟動，狀態一律 no_authorized_roots（不誤報客戶端狀態）。
    if (currentRoots().length === 0) {
      return { enabled: true, state: "no_authorized_roots", roots: [], deviceId: null };
    }
    const cs = getClientState() || {};
    const out = {
      enabled: true,
      state: normalizeState(typeof cs.status === "string" ? cs.status : "off"),
      roots: currentRoots(),
      deviceId: typeof cs.deviceId === "string" ? cs.deviceId : null,
    };
    if (cs.lastError) out.lastError = String(cs.lastError);
    return out;
  }

  function emit(status) {
    try {
      onStatusChange(status);
    } catch {
      /* 狀態推送失敗不得影響 bridge */
    }
    return status;
  }

  function startOptions() {
    return {
      gatewayBaseUrl: getGatewayBaseUrl(),
      enabled: true,
      credentialProvider: credentialProvider(),
      // roots 即時讀同一份 authorizedRoots；不另造授權機制。
      rootsProvider: currentRoots,
      // 客戶端每次狀態變化（connecting/online/reconnecting…）都以當前快照推送。
      onStatus: () => emit(snapshot()),
    };
  }

  /** 重入啟停：先停再起。startDeviceBridge 對 running 狀態直接回舊快照（不會換
   *  roots），且註冊只發生在啟動那一刻，故換 roots 必須 stop→start。 */
  async function startNow() {
    try {
      stopBridge();
    } catch {
      /* noop */
    }
    await startBridge(startOptions());
    return snapshot();
  }

  return {
    status() {
      return snapshot();
    },

    async enable() {
      // 使用者已同意。先記意圖（持久化），無授權根時**不啟動、不自動授權任何路徑**。
      userEnabled = true;
      writeEnabled(true);
      if (currentRoots().length === 0) {
        // 前端據此引導使用者先去 pickFiles 挑資料夾；授權後 onRootsAuthorized 會自動接上。
        return emit(snapshot());
      }
      return emit(await startNow());
    },

    async disable() {
      // 記住「使用者關閉」；停止客戶端並清除其憑證/計時器。
      userEnabled = false;
      writeEnabled(false);
      try {
        stopBridge();
      } catch {
        /* noop */
      }
      return emit({ enabled: false, state: "off", roots: currentRoots(), deviceId: null });
    },

    /** 啟動時由持久化設定／env 覆寫還原意圖；不寫回設定檔（避免把 env 覆寫寫死）。 */
    setEnabledSilently(v) {
      userEnabled = v === true;
    },

    /** whenReady 依已還原的意圖啟動/重啟；未啟用＝不動。 */
    async restart() {
      if (!userEnabled || currentRoots().length === 0) return emit(snapshot());
      return emit(await startNow());
    },

    /**
     * pickFiles 接受新根後呼叫：只有「已啟用」才以**當前（新）roots** 重註冊；
     * 未啟用＝不動作（等使用者按 enable 時自然帶上當時的 roots）。
     */
    async onRootsAuthorized() {
      if (!userEnabled || currentRoots().length === 0) return snapshot();
      return emit(await startNow());
    },
  };
}

/** main.js 注入控制器；測試亦以同一入口替換。 */
function setBridgeController(controller) {
  bridgeController = controller || null;
}

function requireBridgeController() {
  if (!bridgeController) throw new LocalError("E_BRIDGE_UNAVAILABLE", "device bridge 尚未在殼內接線");
  return bridgeController;
}

// ── 四個 bridge IPC 的 handler ──────────────────────────────────────────

async function handleAuthorizedRoots(event) {
  assertTrustedSender(event);
  return Array.from(authorizedRoots);
}

async function handleBridgeStatus(event) {
  assertTrustedSender(event);
  // 未接線時仍回一致的 off 形狀（前端可安全呼叫）。
  if (!bridgeController) return { enabled: false, state: "off", roots: Array.from(authorizedRoots), deviceId: null };
  return bridgeController.status();
}

async function handleBridgeEnable(event) {
  assertTrustedSender(event);
  return await requireBridgeController().enable();
}

async function handleBridgeDisable(event) {
  assertTrustedSender(event);
  return await requireBridgeController().disable();
}

// ---------------------------------------------------------------------------
// 註冊
// ---------------------------------------------------------------------------

/**
 * 註冊 IPC handlers。main.js 於 app.whenReady 呼叫一次。
 * @param {{appHosts?: Set<string>|string[], bridgeController?: object}} options
 */
function registerLocalWorker(options = {}) {
  if (registered) return;
  if (options.appHosts) setAppHosts(options.appHosts);
  if (options.bridgeController) setBridgeController(options.bridgeController);
  registered = true;

  const wrap = (fn) => async (event, ...args) => {
    try {
      return ok(await fn(event, ...args));
    } catch (err) {
      return fail(err);
    }
  };

  ipcMain.handle(CHANNELS.capabilities, wrap(handleCapabilities));
  ipcMain.handle(CHANNELS.pickFiles, wrap(handlePickFiles));
  ipcMain.handle(CHANNELS.probe, wrap(handleProbe));
  ipcMain.handle(CHANNELS.extractFrames, wrap(handleExtractFrames));
  ipcMain.handle(CHANNELS.transcode, wrap(handleTranscode));
  ipcMain.handle(CHANNELS.authorizedRoots, wrap(handleAuthorizedRoots));
  ipcMain.handle(CHANNELS.bridgeStatus, wrap(handleBridgeStatus));
  ipcMain.handle(CHANNELS.bridgeEnable, wrap(handleBridgeEnable));
  ipcMain.handle(CHANNELS.bridgeDisable, wrap(handleBridgeDisable));
}

module.exports = {
  registerLocalWorker,
  CHANNELS,
  // device bridge 生命週期（main.js 注入；測試注入間諜）。
  createBridgeController,
  // 共用的授權來源：device-bridge-client.js 直接讀同一份集合（不另造第二套機制）。
  authorizedRoots,
  authorizeRoots,
  __test: {
    requireAuthorizedInput,
    runProcess,
    authorizeRoots,
    applyPickAuthorization,
    notifyRootsAuthorized,
    createBridgeController,
    setBridgeController,
    setAppHosts,
    handleAuthorizedRoots,
    handleBridgeStatus,
    handleBridgeEnable,
    handleBridgeDisable,
  },
};
