// desktop/lib/policy.js
//
// W3 殼層本地能力：安全與 ffmpeg 策略「純函式」層。
//
// 本檔是 electron 無關的（可直接被 node:test 測），所有安全判斷都收斂在這裡，
// local-worker.js 只負責把 IO 接上去。設計原則：能力寧可少，攻擊面必須小。
//
// 依賴來源（形態照抄，未 import 閘道碼）：
//   - ffmpeg 偵測候選表：deploy-staging/gateway/editor/canvas/videoCompose.ts
//     `detectFfmpeg()`（候選含 /opt/agent-harness/bin/ffmpeg、~/.kunpeng/bin/ffmpeg）。
//   - 併發／記憶體閘 FfmpegGate：deploy-staging/gateway/ffmpeg-limiter.ts
//     （FFMPEG_MAX_CONCURRENT 預設 2、MemAvailable < 400MB 排隊）。以同語義
//     重寫為殼內模組（不直接 import deploy-staging/，那是閘道碼）。
//   - 敏感路徑 denylist 清單形狀照抄 Claude Code（~/.ssh、~/.aws、瀏覽器 profile…）。

"use strict";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

// ---------------------------------------------------------------------------
// 錯誤型別：跨 IPC 時 Electron 只保證 message 抵達 renderer，故 code 同時
// 編進 message 前綴（`E_XXX: detail`），並掛為 .code 供同 realm 使用。
// ---------------------------------------------------------------------------

class LocalError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "LocalError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 敏感路徑（denylist）
// ---------------------------------------------------------------------------

// 語義與雲端 `deploy-staging/gateway/device-bridge-policy.ts:isSensitivePath` 對齊
// （單一真源語義）：**掃描所有路徑段**（不限 $HOME 之下）、一律轉小寫、fail-closed。
// 跨 runtime（Electron CJS ↔ bun TS）無法共用模組，故兩邊各自實作同一語義。
//
// **唯一真源＝雲端向量表** `deploy-staging/gateway/device-bridge-policy.vectors.json`：
// 本機 `policy.test.js` 直接 `fs.readFileSync` 載入該檔的 `sensitive` 段落逐條斷言
// （不 import TS 模組、不再自帶第二份 JSON）。雲端側 `device-bridge.test.ts` 讀同一份。
//
// 與雲端的已知差異：本機是**保守超集**，只多擋不鬆綁——額外單段目錄 `.mozilla`、
// 額外序列 `.config/{gcloud,gh,git,code,electron}`、額外檔名 `.python_history`。
// 這些本機加固項由 `policy.test.js` 顯式列出並逐條斷言（不進雲端真源檔）。

// 單一路徑段：任一層級命中即敏感。
const SENSITIVE_DIR_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".mozilla",
]);

// 敏感檔名：只看 basename 且需整段相等（`.npmrc.bak` 不等於 `.npmrc`）。
const SENSITIVE_FILE_BASENAMES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pgpass",
  ".bash_history",
  ".zsh_history",
  ".python_history",
]);

// 多段序列：需連續出現（已做大小寫/分隔符正規化）。涵蓋 Linux `~/.config/*`、
// `~/.mozilla/firefox` 與 macOS `~/Library/Application Support/*`。
const SENSITIVE_DIR_SEQUENCES = [
  [".config", "gcloud"],
  [".config", "gh"],
  [".config", "git"],
  [".config", "code"],
  [".config", "electron"],
  [".config", "google-chrome"],
  [".config", "chromium"],
  [".config", "brave-browser"],
  [".config", "bravesoftware"],
  [".config", "microsoft-edge"],
  ["library", "application support", "google", "chrome"],
  ["library", "application support", "firefox"],
  ["application support", "google", "chrome"],
];

// 保留舊名供外部引用（形狀：目錄段／序列字串 + 檔名）。
const SENSITIVE_DIRS = Array.from(SENSITIVE_DIR_SEGMENTS).concat(
  SENSITIVE_DIR_SEQUENCES.map((s) => s.join("/")),
);
const SENSITIVE_FILES = Array.from(SENSITIVE_FILE_BASENAMES);

const isWin = (platform) => platform === "win32";

/** 把已正規化的絕對路徑切成小寫路徑段（去空段與 . / ..）。 */
function pathSegments(abs) {
  return abs
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
}

/** needle 是否以連續子序列出現在 haystack 中。 */
function containsSequence(haystack, needle) {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** 展開 ~ 並轉成規範化的絕對路徑；失敗回 null（呼叫端據此拒）。 */
function normalizePath(p, home, platform) {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0")) return null;
  let s = p;
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) {
    if (!home) return null;
    s = path.join(home, s.slice(2));
  }
  try {
    // Windows 上 path.resolve 用 \ 分隔，先在這裡統一判斷語義（大小寫不敏感）。
    return path.resolve(s);
  } catch {
    return null;
  }
}

/** 已正規化的路徑段是否命中 denylist（目錄段／檔名／序列）。 */
function segmentsSensitive(segs) {
  if (segs.length === 0) return false;
  const base = segs[segs.length - 1];
  if (SENSITIVE_FILE_BASENAMES.has(base)) return true;
  for (const seg of segs) {
    if (SENSITIVE_DIR_SEGMENTS.has(seg)) return true;
  }
  for (const seq of SENSITIVE_DIR_SEQUENCES) {
    if (containsSequence(segs, seq)) return true;
  }
  return false;
}

/**
 * 是否為敏感路徑（denylist）。語義**與雲端 device-bridge-policy.ts 相同**：
 * 掃描所有路徑段（不限 $HOME 之下）、一律轉小寫、fail-closed。
 *
 * 判定分兩趟，任一命中即敏感（只會更嚴，不會更鬆）：
 *  1. **詞法段**：直接切原始字串（反斜線→`/`、轉小寫、丟掉空段/`.`/`..`），
 *     與雲端相同——`..` 不 resolve、只是被丟棄。故 `~/.ssh/../../etc/passwd`
 *     仍因命中 `.ssh` 段而判敏感（雲端向量表 requirement，本機不得比雲端鬆）。
 *  2. **resolve 後的路徑**：再對 `path.resolve` 結果判一次，覆蓋「相對路徑 + cwd
 *     落在敏感段之下」這類本機情境；`~` 無法展開時回 null ⇒ fail-closed。
 * @param {string} p 候選路徑
 * @param {string} [home] 使用者家目錄（預設 os.homedir()；僅用於展開 `~`）
 * @param {string} [platform] 預設 process.platform（保留供相容；denylist 已不分平台）
 */
function isSensitivePath(p, home = os.homedir(), platform = process.platform) {
  // fail-closed：非字串／空／純空白／含 NUL → 視為敏感（與雲端 `p.trim()` 一致）。
  if (typeof p !== "string" || p.trim().length === 0 || p.includes("\0")) return true;
  // 1) 詞法段（雲端語義：不 resolve，`..` 丟棄）——`..` 穿越敏感段仍命中。
  if (segmentsSensitive(pathSegments(p))) return true;
  // 2) resolve 後再判（本機加固：涵蓋 cwd-relative）；無法解析 → fail-closed。
  const abs = normalizePath(p, home, platform);
  if (!abs) return true;
  return segmentsSensitive(pathSegments(abs));
}

// ---------------------------------------------------------------------------
// 路徑授權（allowlist）
// ---------------------------------------------------------------------------

/**
 * 路徑是否落在使用者「逐次挑選」授權的根之內。
 *
 * allowedRoots 是絕對路徑字串陣列，每個元素可以是一份「使用者剛挑選的檔案
 * 本身」或「使用者剛挑選的目錄」。判定以分隔符邊界比對：
 *   - 前綴混淆 `/home/u/allowed-evil` 不會匹配根 `/home/u/allowed`
 *     （因為邊界要求 `root + sep`）。
 *   - `..` 逃逸先經 path.resolve 正規化，`/home/u/allowed/../secret`
 *     會變成 `/home/u/secret`，不匹配。
 *   - 敏感路徑一律先拒，即使落在授權根之下。
 *
 * @param {string} p
 * @param {string[]} allowedRoots
 * @param {{home?: string, platform?: string}} [ctx]
 */
function isPathAllowed(p, allowedRoots, ctx = {}) {
  const platform = ctx.platform || process.platform;
  const home = ctx.home !== undefined ? ctx.home : os.homedir();
  const abs = normalizePath(p, home, platform);
  if (!abs) return false;
  if (isSensitivePath(abs, home, platform)) return false;
  if (!Array.isArray(allowedRoots)) return false;

  const fold = isWin(platform) ? (s) => s.toLowerCase() : (s) => s;
  const target = fold(abs);

  for (const root of allowedRoots) {
    const absRoot = normalizePath(root, home, platform);
    if (!absRoot) continue;
    if (isSensitivePath(absRoot, home, platform)) continue;
    const r = fold(absRoot);
    const sep = path.sep;
    if (target === r) return true;
    // 目錄邊界：必須是 root + 分隔符開頭，杜絕 allowed-evil 這類前綴混淆。
    const prefix = r.endsWith(sep) ? r : r + sep;
    if (target.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * 主進程側 renderer 來源驗證：host 必須在 appHosts 內，且 **protocol 必須是
 * http/https**（fail-closed）。M1：只比 host 會被 `file://www.eimu.dev/x` 冒充
 * （`new URL("file://www.eimu.dev/x").host === "www.eimu.dev"`）。
 */
function isAppHost(url, appHosts) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return appHosts instanceof Set ? appHosts.has(u.host) : Array.isArray(appHosts) && appHosts.includes(u.host);
}

// ---------------------------------------------------------------------------
// ffmpeg 候選表
// ---------------------------------------------------------------------------

const WIN_FFMPEG_CANDIDATES = (home) => [
  "ffmpeg",
  "ffmpeg.exe",
  home ? path.win32.join(home, ".kunpeng", "bin", "ffmpeg.exe") : null,
  home ? path.win32.join(home, "AppData", "Local", "Microsoft", "WinGet", "Links", "ffmpeg.exe") : null,
  "C:\\ffmpeg\\bin\\ffmpeg.exe",
];

const POSIX_FFMPEG_CANDIDATES = (home) => [
  "/opt/agent-harness/bin/ffmpeg",
  home ? path.posix.join(home, ".kunpeng", "bin", "ffmpeg") : null,
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
  "ffmpeg",
];

/**
 * 回傳有序的 ffmpeg 候選路徑（純函式，不驗證存在性；實際探測在 worker）。
 * 形態照抄 videoCompose.ts:detectFfmpeg 的候選表。
 * env.EIMU_FFMPEG 若設定，置頂作為顯式覆寫。
 *
 * @param {Record<string,string>} [env] 預設 process.env
 * @param {string} [platform] 預設 process.platform
 * @returns {string[]}
 */
function pickFfmpegCandidate(env = process.env, platform = process.platform) {
  const home = (env.HOME || env.USERPROFILE || "").replace(/[\\/]+$/, "") || null;
  const base = isWin(platform) ? WIN_FFMPEG_CANDIDATES(home) : POSIX_FFMPEG_CANDIDATES(home);
  const out = [];
  if (env.EIMU_FFMPEG) out.push(env.EIMU_FFMPEG);
  for (const c of base) if (c) out.push(c);
  return out;
}

// ---------------------------------------------------------------------------
// ffmpeg argv 建構（固定 argv，禁止 shell 字串）
// ---------------------------------------------------------------------------

const VIDEO_CODECS = new Set(["libx264", "libx265", "libvpx-vp9", "h264_nvenc", "hevc_nvenc"]);
const PRESETS = new Set(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"]);
const AUDIO_CODECS = new Set(["aac", "libopus", "mp3", "copy"]);

function intInRange(v, min, max, field) {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new LocalError("E_BAD_OPTS", `${field} 必須是 ${min}..${max} 的整數`);
  }
  return n;
}

function enumValue(v, set, field) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !set.has(v)) {
    throw new LocalError("E_BAD_OPTS", `${field} 不在白名單內`);
  }
  return v;
}

/** 把 transcode 選項正規化／校驗；任何非白名單值一律拒（不靜默丟棄）。 */
function normalizeTranscodeOptions(opts = {}) {
  if (opts === null || typeof opts !== "object") {
    throw new LocalError("E_BAD_OPTS", "opts 必須是物件");
  }
  const copy = opts.copy === true;
  const out = {
    copy,
    videoCodec: enumValue(opts.videoCodec, VIDEO_CODECS, "videoCodec") || "libx264",
    preset: enumValue(opts.preset, PRESETS, "preset") || "medium",
    crf: intInRange(opts.crf, 0, 51, "crf"),
    audioCodec: enumValue(opts.audioCodec, AUDIO_CODECS, "audioCodec") || "aac",
    audioBitrateKbps: intInRange(opts.audioBitrateKbps, 32, 512, "audioBitrateKbps"),
    maxWidth: intInRange(opts.maxWidth, 16, 7680, "maxWidth"),
    maxHeight: intInRange(opts.maxHeight, 16, 4320, "maxHeight"),
    faststart: opts.faststart === true,
    format: enumValue(opts.format, new Set(["mp4", "webm", "mkv", "mov"]), "format") || "mp4",
  };
  if (out.maxWidth && out.maxWidth % 2 !== 0) out.maxWidth -= 1; // yuv420p 需偶數
  if (out.maxHeight && out.maxHeight % 2 !== 0) out.maxHeight -= 1;
  if (out.format === "webm" && out.videoCodec === "libx264") out.videoCodec = "libvpx-vp9";
  if (out.format === "webm" && out.audioCodec === "aac") out.audioCodec = "libopus";
  return out;
}

/**
 * 建構固定 argv 陣列（不含 ffmpeg 二進位本身；worker 以 spawn(bin, args,
 * {shell:false}) 執行）。所有值都經過白名單／數值校驗，注入字串無法變成
 * 額外參數（argv 陣列天生不經 shell 拆詞）。
 *
 * @param {"transcode"|"frame"} op
 * @param {string} input 已授權的絕對輸入路徑
 * @param {string} output 輸出檔案路徑
 * @param {object} [opts]
 * @returns {string[]}
 */
function buildFfmpegArgs(op, input, output, opts = {}) {
  if (typeof input !== "string" || input.includes("\0") || input.length === 0) {
    throw new LocalError("E_BAD_ARGS", "input 必須是非空字串");
  }
  if (typeof output !== "string" || output.includes("\0") || output.length === 0) {
    throw new LocalError("E_BAD_ARGS", "output 必須是非空字串");
  }

  if (op === "frame") {
    const o = opts && typeof opts === "object" ? opts : {};
    const ss = typeof o.tSec === "number" && Number.isFinite(o.tSec) && o.tSec >= 0 ? o.tSec : 0;
    const maxWidth = intInRange(o.maxWidth, 16, 7680, "maxWidth") || 720;
    return [
      "-hide_banner", "-nostdin", "-y",
      "-ss", String(ss),
      "-i", input,
      "-frames:v", "1",
      "-vf", `scale=${maxWidth}:-2`,
      "-q:v", "3",
      output,
    ];
  }

  if (op !== "transcode") {
    throw new LocalError("E_BAD_ARGS", `未知 op: ${String(op)}`);
  }

  const o = normalizeTranscodeOptions(opts);
  const args = ["-hide_banner", "-nostdin", "-y", "-i", input];
  if (o.copy) {
    args.push("-c", "copy");
  } else {
    args.push("-c:v", o.videoCodec, "-preset", o.preset);
    if (o.videoCodec === "libx264" || o.videoCodec === "libx265") {
      args.push("-crf", String(o.crf === null ? 23 : o.crf));
    }
    if (o.videoCodec === "libvpx-vp9") {
      args.push("-crf", String(o.crf === null ? 32 : o.crf), "-b:v", "0");
    }
    args.push("-pix_fmt", "yuv420p");
    if (o.maxWidth || o.maxHeight) {
      const w = o.maxWidth ? o.maxWidth : -2;
      const h = o.maxHeight ? o.maxHeight : -2;
      args.push("-vf", `scale=${w}:${h}`);
    }
    args.push("-c:a", o.audioCodec);
    if (o.audioCodec !== "copy") args.push("-b:a", `${o.audioBitrateKbps === null ? 128 : o.audioBitrateKbps}k`);
  }
  if (o.faststart) args.push("-movflags", "+faststart");
  args.push(output);
  return args;
}

// ---------------------------------------------------------------------------
// 抽幀計畫（純函式）
// ---------------------------------------------------------------------------

const FRAME_MAX_COUNT = 24;

/**
 * @param {object|null} plan
 * @returns {{count:number, timesSec:number[]|null, maxWidth:number}}
 */
function sanitizeFramePlan(plan) {
  const p = plan && typeof plan === "object" ? plan : {};
  const count = intInRange(p.count, 1, FRAME_MAX_COUNT, "count") || 8;
  const maxWidth = intInRange(p.maxWidth, 16, 7680, "maxWidth") || 720;
  let timesSec = null;
  if (p.timesSec !== undefined && p.timesSec !== null) {
    if (!Array.isArray(p.timesSec) || p.timesSec.length === 0 || p.timesSec.length > FRAME_MAX_COUNT) {
      throw new LocalError("E_BAD_OPTS", `timesSec 必須是 1..${FRAME_MAX_COUNT} 個時間點`);
    }
    timesSec = p.timesSec.map((t) => {
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0 || n > 86400) {
        throw new LocalError("E_BAD_OPTS", "timesSec 每個值必須是 0..86400 秒");
      }
      return Math.round(n * 1000) / 1000;
    });
  }
  return { count, timesSec, maxWidth };
}

/** 依影片時長決定抽幀時間點（等距；避免 0 與結尾誤差各留邊界內縮）。 */
function resolveFrameTimes(durationSec, plan) {
  const { count, timesSec } = plan;
  if (timesSec) return timesSec;
  const d = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 1;
  if (count === 1) return [Math.round((d / 2) * 1000) / 1000];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const t = (d * (i + 0.5)) / count;
    out.push(Math.round(t * 1000) / 1000);
  }
  return out;
}

// ---------------------------------------------------------------------------
// pickFiles 選項正規化（純函式）
// ---------------------------------------------------------------------------

function sanitizePickOptions(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const kind = o.kind === "directory" ? "directory" : "files";
  let filters = [];
  if (Array.isArray(o.filters)) {
    filters = o.filters
      .filter((f) => f && typeof f === "object" && typeof f.name === "string")
      .slice(0, 8)
      .map((f) => ({
        name: String(f.name).slice(0, 64),
        extensions: Array.isArray(f.extensions)
          ? f.extensions.filter((e) => typeof e === "string" && /^[A-Za-z0-9*]+$/.test(e)).slice(0, 24)
          : [],
      }));
  }
  return { kind, multiple: o.multiple !== false, filters };
}

// ---------------------------------------------------------------------------
// ffmpeg 併發／記憶體閘（語義照抄 deploy-staging/gateway/ffmpeg-limiter.ts）
// ---------------------------------------------------------------------------

function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

function defaultMemAvailableMB() {
  try {
    const m = fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) / 1024 : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER; // 非 Linux（macOS/Windows）無此檔 → 不因記憶體卡住
  }
}

/**
 * 併發／記憶體閘。放行條件（同時成立，否則排隊）：
 *   1. active < maxConcurrent（預設 2；設 0 = 關閉限流）
 *   2. memAvailableMB() >= minMemMB（預設 400）
 * 與 ffmpeg-limiter.ts 的差異：殼內為單進程、無跨進程需求，故不加 1s ticker
 * （release 即喚醒；desktop ffmpeg 結束必經 release）。
 */
class FfmpegGate {
  constructor(options = {}) {
    this.maxConcurrent = Number.isFinite(options.maxConcurrent)
      ? options.maxConcurrent
      : envInt("FFMPEG_MAX_CONCURRENT", 2);
    this.minMemMB = Number.isFinite(options.minMemMB) ? options.minMemMB : envInt("FFMPEG_MIN_MEM_MB", 400);
    this._mem = typeof options.memAvailableMB === "function" ? options.memAvailableMB : defaultMemAvailableMB;
    this._active = 0;
    this._waiters = [];
  }

  async acquire() {
    for (;;) {
      const throttling = this.maxConcurrent > 0;
      if (!throttling || (this._active < this.maxConcurrent && this._mem() >= this.minMemMB)) {
        this._active += 1;
        return;
      }
      await new Promise((resolve) => this._waiters.push(resolve));
    }
  }

  release() {
    this._active = Math.max(0, this._active - 1);
    this._wakeAll();
  }

  _wakeAll() {
    if (this._waiters.length === 0) return;
    const q = this._waiters.splice(0, this._waiters.length);
    for (const w of q) w();
  }

  /** 執行 fn 並在 finally 保證釋放 slot。 */
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  stats() {
    return {
      active: this._active,
      queued: this._waiters.length,
      memAvailableMB: Math.round(this._mem()),
      maxConcurrent: this.maxConcurrent,
      minMemMB: this.minMemMB,
    };
  }
}

module.exports = {
  LocalError,
  isSensitivePath,
  isPathAllowed,
  isAppHost,
  normalizePath,
  pickFfmpegCandidate,
  buildFfmpegArgs,
  normalizeTranscodeOptions,
  sanitizeFramePlan,
  resolveFrameTimes,
  sanitizePickOptions,
  FfmpegGate,
  SENSITIVE_DIRS,
  SENSITIVE_FILES,
  FRAME_MAX_COUNT,
};
