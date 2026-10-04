// desktop/local-worker.js
//
// W3：主进程侧的本机媒体工人。以 ipcMain.handle 实作 preload 暴露的 5 个 API。
//
// 安全模型（详见 LOCAL-CAPABILITIES.md）：
//   1. 每个 handler 先验 event.senderFrame 的 host 属于 APP_HOSTS，否则拒。
//   2. 路径一律先 realpath（解 symlink）再过 isPathAllowed：
//      只有使用者「刚用 pickFiles 主动挑选」过的档案本身或其授权根之下才放行。
//   3. 再过 isSensitivePath denylist（~/.ssh、凭证、浏览器 profile…）。
//   4. ffmpeg 一律 spawn(bin, argv, {shell:false})，argv 由 policy.buildFfmpegArgs
//      以白名单／数值校验生成，逾时 SIGKILL。
//   5. 输出档预设写入本进程管理的临时目录；只有落在授权根内的使用者指定
//      输出路径才接受。
//
// 本档不做任何业务逻辑，只做 IO 与授权闸。

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { ipcMain, dialog, BrowserWindow, app } = require("electron");
const { spawn } = require("node:child_process");

const policy = require("./lib/policy.js");
const { LocalError } = policy;
const { PERMISSION_MODES } = require("./lib/permission-rules.js");

const CHANNELS = {
  capabilities: "eimu-local:capabilities",
  pickFiles: "eimu-local:pick-files",
  probe: "eimu-local:probe",
  extractFrames: "eimu-local:extract-frames",
  transcode: "eimu-local:transcode",
  // W6c：device bridge 的使用者介面（本机档案授权）。invoke 四个 + 一个 event。
  authorizedRoots: "eimu-local:authorized-roots",
  bridgeStatus: "eimu-local:bridge-status",
  bridgeEnable: "eimu-local:bridge-enable",
  bridgeDisable: "eimu-local:bridge-disable",
  // W6c：权限模式设定（off/ask/auto/full），持久化并重启桥让新 mode 生效。
  bridgeSetMode: "eimu-local:bridge-set-mode",
  // 主进程 → 页面的状态推送（preload 的 onBridgeStatus 订阅此 channel）。
  bridgeEvent: "eimu-local:bridge-state",
};

const PROBE_TIMEOUT_MS = 15000;
const FRAME_TIMEOUT_MS = 45000;
const TRANSCODE_TIMEOUT_DEFAULT_MS = 300000;
const TRANSCODE_TIMEOUT_MAX_MS = 600000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

// 使用者逐次挑选后累积的授权集（真实绝对路径，已解 symlink）。
const authorizedRoots = new Set();

let appHosts = new Set();
// device bridge 生命周期控制器（由 main.js 于 registerLocalWorker 注入；见下方
// createBridgeController）。null＝尚未接线，bridge.* 的查询会回 off、启停会拒绝。
let bridgeController = null;
let registered = false;
let ffmpegBin = null; // 解析结果快取（含 null = 已探测无）
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
  return { ok: false, code, message: err && err.message ? String(err.message) : "未知错误" };
};

/** 设定 APP_HOSTS 白名单（main.js 与测试共用同一入口）。 */
function setAppHosts(hosts) {
  appHosts = hosts instanceof Set ? hosts : new Set(Array.isArray(hosts) ? hosts : []);
}

/** 只有 APP_HOSTS 的顶层 frame 可呼叫；其余（含 iframe 外部站）一律拒。 */
function assertTrustedSender(event) {
  let frame = null;
  let url = "";
  try {
    frame = event.senderFrame;
    url = frame && frame.url ? frame.url : "";
  } catch {
    throw new LocalError("E_UNTRUSTED_ORIGIN", "无法解析来源 frame");
  }
  if (!policy.isAppHost(url, appHosts)) {
    throw new LocalError("E_UNTRUSTED_ORIGIN", `来源不在 App 白名单：${String(url).slice(0, 120)}`);
  }
  if (frame && frame.parent) {
    throw new LocalError("E_UNTRUSTED_ORIGIN", "仅接受顶层 frame 呼叫");
  }
}

// ---------------------------------------------------------------------------
// 路径授权
// ---------------------------------------------------------------------------

/** 解 symlink；不存在时对父目录解 symlink 再接回 basename（输出档常用）。 */
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

/** 检查输入路径已授权且非敏感；回传其 realpath。 */
function requireAuthorizedInput(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new LocalError("E_BAD_ARGS", "路径必须是非空字串");
  }
  const real = resolveReal(rawPath);
  if (policy.isSensitivePath(real)) {
    throw new LocalError("E_SENSITIVE_PATH", "该路径属于敏感位置，拒绝存取");
  }
  if (!policy.isPathAllowed(real, Array.from(authorizedRoots))) {
    throw new LocalError("E_NOT_AUTHORIZED", "尚未透过 pickFiles 授权此路径");
  }
  if (!fs.existsSync(real)) {
    throw new LocalError("E_NOT_FOUND", "档案不存在");
  }
  return real;
}

/**
 * 登记使用者**显式授权**的根（pickFiles 挑选后呼叫；device bridge 共用同一份）。
 * 这是唯一的授权来源：不另造第二套授权机制。敏感位置即使被挑选也拒。
 * @param {string[]} paths 使用者挑选的原始路径
 * @returns {{input:string, real:string}[]} 实际被接受的项目（input=原样、real=已解 symlink）
 */
function authorizeRoots(paths) {
  const accepted = [];
  if (!Array.isArray(paths)) return accepted;
  for (const p of paths) {
    if (typeof p !== "string" || p.length === 0) continue;
    const real = resolveReal(p);
    if (policy.isSensitivePath(real)) continue; // 敏感位置即使被挑选也拒
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
// ffmpeg 探测与执行
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

/** ffprobe 候选：由 ffmpeg 候选把 basename 的 ffmpeg 换成 ffprobe，再补 PATH。 */
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

/** 执行已验证的 ffmpeg op，过闸并处理逾时；失败掷 LocalError。 */
async function runGatedFfmpeg(args, timeoutMs) {
  const bin = await resolveFfmpeg();
  if (!bin) throw new LocalError("E_FFMPEG_MISSING", "找不到可用的 ffmpeg 执行档");
  const res = await gate.run(() => runProcess(bin, args, timeoutMs));
  if (res.timedOut) throw new LocalError("E_TIMEOUT", `ffmpeg 逾时（${timeoutMs}ms）`);
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
// E2E 专用授权闸（**仅测试用；不得用于生产**）
// ---------------------------------------------------------------------------
// 真桌面壳的 E2E 测试需要走完 pickFiles 之后的整条链路（probe / extractFrames /
// transcode），但 pickFiles 开的是原生对话框，自动化无法驱动（本机无
// xdotool/ydotool/wtype 可用）。
//
// 因此提供一个**受显式开关约束的环境变数闸**：只有壳的**启动环境**（process.env）
// 同时设了 `EIMU_E2E === "1"`（显式 opt-in）与 `EIMU_E2E_PICK_FILES` 时才生效。
// 其值为分号分隔的绝对路径，命中时直接当成「使用者刚挑选」的结果回传并授权，
// 完全不开对话框。**只设 EIMU_E2E_PICK_FILES 而没有 EIMU_E2E=1 ⇒ 一律忽略**。
//
// 为什么要这个开关（同意机制旁路风险）：pickFiles 的对话框就是「使用者授权哪些
// 根目录」的同意动作；授权后 authorizedRoots 才成立，device bridge 的 H1 白名单
// 才成立。若这个闸门随正式产物无条件生效，任何能控制本机环境变数的程序都能在不
// 经使用者同意的情况下预先授权任意根目录。加上显式开关后，正式产物**预设关闭**。
//
// 为什么不用 `!app.isPackaged` 直接锁死：E2E harness 跑的就是**打包后**的
// dist-e2e（app.isPackaged === true）；硬门会把 harness 一起锁死。改以单一显式
// opt-in 开关取代，兼顾「正式产物预设关闭」与「harness 可运作」（harness 启动时
// 需一并带 EIMU_E2E=1；harness.mjs 会把 process.env 透传给子进程）。
//
// 安全性：远端页面（renderer / 远端内容）碰不到 process.env，无法自行开启这个闸；
// 只有启动壳的人（测试 harness）能设定。
//
// 行为不变保证：未设此 env（生产预设）时，下方 handlePickFiles 逐位元组走原本的
// dialog.showOpenDialog 路径，行为与过往完全相同。
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
 * 授权使用者挑选的路径（唯一授权来源 authorizeRoots → authorizedRoots），并在
 * 有新根被接受时通知 bridge 控制器以**当前授权根**重注册（已启用才动作）。
 * 回传实际被接受的项目（input=原样、real=已解 symlink）。
 */
function applyPickAuthorization(paths) {
  const accepted = authorizeRoots(paths);
  const restarted = notifyRootsAuthorized(accepted); // promise 供测试等待；生产端忽略
  return { accepted, restarted };
}

/**
 * pickFiles 接受新根后通知 bridge（见 createBridgeController.onRootsAuthorized）。
 * 只在已有接受项且控制器已接线时呼叫；重注册是非同步且**不得**影响 pickFiles
 * 的回传（不 await、吞错）。回传该 promise（供测试等待；生产呼叫端忽略）。
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
    // E2E 专用（见上方注解）：不开对话框，直接授权并回传这些路径。
    // 留一行可审计的日志（只在显式 EIMU_E2E=1 且指定路径时出现；生产不会有）。
    console.warn(`[eimu-local] E2E 授权闸生效（EIMU_E2E=1）：略过对话框，直接授权 ${e2ePaths.length} 条路径`);
    return applyPickAuthorization(e2ePaths).accepted.map((entry) => entry.input);
  }
  const clean = policy.sanitizePickOptions(opts);
  const win = BrowserWindow.fromWebContents(event.sender) || undefined;
  const properties = clean.kind === "directory" ? ["openDirectory"] : ["openFile"];
  if (clean.multiple) properties.push("multiSelections");
  const result = await dialog.showOpenDialog(win, {
    title: clean.kind === "directory" ? "选择资料夹" : "选择档案",
    properties,
    filters: clean.filters.length ? clean.filters : undefined,
  });
  if (result.canceled || !Array.isArray(result.filePaths)) return [];
  // 同一份授权来源（authorizeRoots → authorizedRoots）；回传原始挑选路径以维持既有行为。
  return applyPickAuthorization(result.filePaths).accepted.map((entry) => entry.input);
}

async function ffprobeJson(inputReal) {
  const bin = await resolveFfprobe();
  if (!bin) throw new LocalError("E_FFPROBE_MISSING", "找不到可用的 ffprobe 执行档");
  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", inputReal];
  const res = await runProcess(bin, args, PROBE_TIMEOUT_MS);
  if (res.spawnError || res.code !== 0) {
    throw new LocalError("E_FFPROBE_FAILED", (res.stderr || "ffprobe 失败").slice(-600));
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new LocalError("E_FFPROBE_FAILED", "ffprobe 输出无法解析");
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
    if (policy.isSensitivePath(resolved)) throw new LocalError("E_SENSITIVE_PATH", "输出位置属敏感路径");
    if (!policy.isPathAllowed(resolved, Array.from(authorizedRoots))) {
      throw new LocalError("E_NOT_AUTHORIZED", "输出位置不在已授权目录内");
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
// device bridge 生命周期控制器（可重入；依赖注入以便 node --test）
// ---------------------------------------------------------------------------
// 为什么把编排放在本档而不是 main.js：bridge 的四个 API 之 IPC handler 在本档，
// 且桥必须与 pickFiles 共用同一份 authorizedRoots。做成「纯依赖注入」的工厂后，
// 可在纯 node 下注入间谍 client（startBridge/stopBridge）对「授权根变更→以新
// roots 重注册」做真行为断言，不必启动 Electron（main.js 顶层呼叫 app API，
// 无法在 node 下 require）。
//
// 授权根**一律即时读** authorizedRoots（唯一授权来源）；控制器不另存一份。

/**
 * @param {{
 *   startBridge:(opts:object)=>Promise<object>,   // 通常是 device-bridge-client.startDeviceBridge
 *   stopBridge:()=>object|void,                    // 通常是 device-bridge-client.stopDeviceBridge
 *   getClientState?:()=>object,                    // 客户端状态快照（status/deviceId/lastError）
 *   readEnabled?:()=>boolean, writeEnabled?:(v:boolean)=>void,  // 使用者设定的持久化
 *   readMode?:()=>string|undefined, writeMode?:(m:string)=>void, // 权限模式持久化
 *   rulesProvider?:()=>unknown,                     // 规则（下发闸道＋第二道防线共用）
 *   getGatewayBaseUrl?:()=>string|undefined,
 *   credentialProvider?:()=>string|null,
 *   onStatusChange?:(status:object)=>void          // 状态推送（main 推给所有视窗）
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
  const readMode = typeof deps.readMode === "function" ? deps.readMode : () => undefined;
  const writeMode = typeof deps.writeMode === "function" ? deps.writeMode : () => {};
  const rulesProvider = typeof deps.rulesProvider === "function" ? deps.rulesProvider : () => undefined;
  const getGatewayBaseUrl = typeof deps.getGatewayBaseUrl === "function" ? deps.getGatewayBaseUrl : () => undefined;
  const credentialProvider = typeof deps.credentialProvider === "function" ? deps.credentialProvider : () => null;
  const onStatusChange = typeof deps.onStatusChange === "function" ? deps.onStatusChange : () => {};

  // 使用者「是否已开启本机档案授权」的意图（与客户端是否真的连上无关）。
  let userEnabled = false;
  // 权限模式（off/ask/auto/full）。预设 ask（契约预设值）；由持久化设定／env 还原。
  const normalizeMode = (m) =>
    typeof m === "string" && PERMISSION_MODES.includes(m) ? m : "ask";
  let userMode = normalizeMode(readMode());

  const currentRoots = () => Array.from(authorizedRoots);

  // 冻结契约的 state 只有六值（与前端 BridgeState 一致）；客户端内部的
  // "reconnecting" 一律正规化为 "connecting"，未知值 fail-closed 成 "error"。
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

  /** 冻结契约的状态形状：{ enabled, state, roots, deviceId, mode, lastError? }。 */
  function snapshot() {
    if (!userEnabled) return { enabled: false, state: "off", roots: currentRoots(), deviceId: null, mode: userMode };
    // 已开启意图但尚无授权根：不启动，状态一律 no_authorized_roots（不误报客户端状态）。
    if (currentRoots().length === 0) {
      return { enabled: true, state: "no_authorized_roots", roots: [], deviceId: null, mode: userMode };
    }
    const cs = getClientState() || {};
    const out = {
      enabled: true,
      state: normalizeState(typeof cs.status === "string" ? cs.status : "off"),
      roots: currentRoots(),
      deviceId: typeof cs.deviceId === "string" ? cs.deviceId : null,
      mode: userMode,
    };
    if (cs.lastError) out.lastError = String(cs.lastError);
    return out;
  }

  function emit(status) {
    try {
      onStatusChange(status);
    } catch {
      /* 状态推送失败不得影响 bridge */
    }
    return status;
  }

  function startOptions() {
    return {
      gatewayBaseUrl: getGatewayBaseUrl(),
      enabled: true,
      // 传**函式本身**，不传呼叫结果：client 只在 typeof === "function" 时呼叫它
      // （device-bridge-client.js startDeviceBridge 的 typeof 检），且刻意先判
      // roots 再读凭证——提早呼叫会让无授权根时也白读凭证档。
      credentialProvider,
      // roots 即时读同一份 authorizedRoots；不另造授权机制。
      rootsProvider: currentRoots,
      // W6c：权限模式即时读（setMode 后重启即生效）；rules 由注入的 provider 决定。
      modeProvider: () => userMode,
      rulesProvider,
      // 客户端每次状态变化（connecting/online/reconnecting…）都以当前快照推送。
      onStatus: () => emit(snapshot()),
    };
  }

  /** 重入启停：先停再起。startDeviceBridge 对 running 状态直接回旧快照（不会换
   *  roots），且注册只发生在启动那一刻，故换 roots 必须 stop→start。 */
  async function startNow() {
    try {
      stopBridge();
    } catch {
      /* noop */
    }
    await startBridge(startOptions());
    return snapshot();
  }

  /** 停桥并记住「使用者关闭」（等同 disable 的核心）。mode 不动。 */
  function applyDisable() {
    userEnabled = false;
    writeEnabled(false);
    try {
      stopBridge();
    } catch {
      /* noop */
    }
    return emit({ enabled: false, state: "off", roots: currentRoots(), deviceId: null, mode: userMode });
  }

  /**
   * 设定权限模式（off/ask/auto/full）：
   *   1. 验值：非法值丢 E_BAD_ARGS（**不打网路、不改状态**，含不写入持久化）。
   *   2. 持久化 writeMode（比照 writeEnabled 的注入方式）。
   *   3. off ＝ 停桥（等同 disable）；其余＝若未启用则启用，并以 stop→start 重注册
   *      让新模式在 register 生效（**复用**既有「授权根变更→重注册」同一条 startNow）。
   */
  async function setMode(mode) {
    if (typeof mode !== "string" || !PERMISSION_MODES.includes(mode)) {
      throw new LocalError("E_BAD_ARGS", `非法权限模式：${String(mode)}`);
    }
    userMode = mode;
    writeMode(mode);
    if (mode === "off") {
      return applyDisable();
    }
    userEnabled = true;
    writeEnabled(true);
    if (currentRoots().length === 0) {
      // 无授权根 ⇒ 不启动；前端引导 pickFiles，授权后 onRootsAuthorized 会自动接上。
      return emit(snapshot());
    }
    return emit(await startNow());
  }

  return {
    status() {
      return snapshot();
    },

    async enable() {
      // 使用者已同意。先记意图（持久化），无授权根时**不启动、不自动授权任何路径**。
      userEnabled = true;
      writeEnabled(true);
      if (currentRoots().length === 0) {
        // 前端据此引导使用者先去 pickFiles 挑资料夹；授权后 onRootsAuthorized 会自动接上。
        return emit(snapshot());
      }
      return emit(await startNow());
    },

    async disable() {
      // 记住「使用者关闭」；停止客户端并清除其凭证/计时器。
      return applyDisable();
    },

    /** 设定权限模式（见上方 setMode 说明）。 */
    setMode,

    /** 启动时由持久化设定／env 覆写还原意图；不写回设定档（避免把 env 覆写写死）。 */
    setEnabledSilently(v) {
      userEnabled = v === true;
    },

    /** 启动时还原权限模式；不写回设定档（env 覆写不落地）。非法值回预设 ask。 */
    setModeSilently(m) {
      userMode = normalizeMode(m);
    },

    /** whenReady 依已还原的意图启动/重启；未启用＝不动。 */
    async restart() {
      if (!userEnabled || currentRoots().length === 0) return emit(snapshot());
      return emit(await startNow());
    },

    /**
     * pickFiles 接受新根后呼叫：只有「已启用」才以**当前（新）roots** 重注册；
     * 未启用＝不动作（等使用者按 enable 时自然带上当时的 roots）。
     */
    async onRootsAuthorized() {
      if (!userEnabled || currentRoots().length === 0) return snapshot();
      return emit(await startNow());
    },
  };
}

/** main.js 注入控制器；测试亦以同一入口替换。 */
function setBridgeController(controller) {
  bridgeController = controller || null;
}

function requireBridgeController() {
  if (!bridgeController) throw new LocalError("E_BRIDGE_UNAVAILABLE", "device bridge 尚未在壳内接线");
  return bridgeController;
}

// ── 四个 bridge IPC 的 handler ──────────────────────────────────────────

async function handleAuthorizedRoots(event) {
  assertTrustedSender(event);
  return Array.from(authorizedRoots);
}

async function handleBridgeStatus(event) {
  assertTrustedSender(event);
  // 未接线时仍回一致的 off 形状（前端可安全呼叫）。mode 预设 ask（契约预设）。
  if (!bridgeController) {
    return { enabled: false, state: "off", roots: Array.from(authorizedRoots), deviceId: null, mode: "ask" };
  }
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

async function handleBridgeSetMode(event, mode) {
  assertTrustedSender(event);
  return await requireBridgeController().setMode(mode);
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

/**
 * 注册 IPC handlers。main.js 于 app.whenReady 呼叫一次。
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
  ipcMain.handle(CHANNELS.bridgeSetMode, wrap(handleBridgeSetMode));
}

module.exports = {
  registerLocalWorker,
  CHANNELS,
  // device bridge 生命周期（main.js 注入；测试注入间谍）。
  createBridgeController,
  // 共用的授权来源：device-bridge-client.js 直接读同一份集合（不另造第二套机制）。
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
    handleBridgeSetMode,
  },
};
