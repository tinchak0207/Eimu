// desktop/lib/policy.js
//
// W3 壳层本地能力：安全与 ffmpeg 策略「纯函式」层。
//
// 本档是 electron 无关的（可直接被 node:test 测），所有安全判断都收敛在这里，
// local-worker.js 只负责把 IO 接上去。设计原则：能力宁可少，攻击面必须小。
//
// 依赖来源（形态照抄，未 import 闸道码）：
//   - ffmpeg 侦测候选表：deploy-staging/gateway/editor/canvas/videoCompose.ts
//     `detectFfmpeg()`（候选含 /opt/eimu-harness/bin/ffmpeg、~/.kunpeng/bin/ffmpeg）。
//   - 并发／记忆体闸 FfmpegGate：deploy-staging/gateway/ffmpeg-limiter.ts
//     （FFMPEG_MAX_CONCURRENT 预设 2、MemAvailable < 400MB 排队）。以同语义
//     重写为壳内模组（不直接 import deploy-staging/，那是闸道码）。
//   - 敏感路径 denylist 清单形状照抄 Claude Code（~/.ssh、~/.aws、浏览器 profile…）。

"use strict";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

// ---------------------------------------------------------------------------
// 错误型别：跨 IPC 时 Electron 只保证 message 抵达 renderer，故 code 同时
// 编进 message 前缀（`E_XXX: detail`），并挂为 .code 供同 realm 使用。
// ---------------------------------------------------------------------------

class LocalError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "LocalError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 敏感路径（denylist）
// ---------------------------------------------------------------------------

// 语义与云端 `deploy-staging/gateway/device-bridge-policy.ts:isSensitivePath` 对齐
// （单一真源语义）：**扫描所有路径段**（不限 $HOME 之下）、一律转小写、fail-closed。
// 跨 runtime（Electron CJS ↔ bun TS）无法共用模组，故两边各自实作同一语义。
//
// **唯一真源＝云端向量表** `deploy-staging/gateway/device-bridge-policy.vectors.json`：
// 本机 `policy.test.js` 直接 `fs.readFileSync` 载入该档的 `sensitive` 段落逐条断言
// （不 import TS 模组、不再自带第二份 JSON）。云端侧 `device-bridge.test.ts` 读同一份。
//
// 与云端的已知差异：本机是**保守超集**，只多挡不松绑——额外单段目录 `.mozilla`、
// 额外序列 `.config/{gcloud,gh,git,code,electron}`、额外档名 `.python_history`。
// 这些本机加固项由 `policy.test.js` 显式列出并逐条断言（不进云端真源档）。

// 单一路径段：任一层级命中即敏感。
const SENSITIVE_DIR_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".mozilla",
]);

// 敏感档名：只看 basename 且需整段相等（`.npmrc.bak` 不等于 `.npmrc`）。
const SENSITIVE_FILE_BASENAMES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pgpass",
  ".bash_history",
  ".zsh_history",
  ".python_history",
]);

// 多段序列：需连续出现（已做大小写/分隔符正规化）。涵盖 Linux `~/.config/*`、
// `~/.mozilla/firefox` 与 macOS `~/Library/Application Support/*`。
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

// 保留旧名供外部引用（形状：目录段／序列字串 + 档名）。
const SENSITIVE_DIRS = Array.from(SENSITIVE_DIR_SEGMENTS).concat(
  SENSITIVE_DIR_SEQUENCES.map((s) => s.join("/")),
);
const SENSITIVE_FILES = Array.from(SENSITIVE_FILE_BASENAMES);

const isWin = (platform) => platform === "win32";

/** 把已正规化的绝对路径切成小写路径段（去空段与 . / ..）。 */
function pathSegments(abs) {
  return abs
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
}

/** needle 是否以连续子序列出现在 haystack 中。 */
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

/** 展开 ~ 并转成规范化的绝对路径；失败回 null（呼叫端据此拒）。 */
function normalizePath(p, home, platform) {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0")) return null;
  let s = p;
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) {
    if (!home) return null;
    s = path.join(home, s.slice(2));
  }
  try {
    // Windows 上 path.resolve 用 \ 分隔，先在这里统一判断语义（大小写不敏感）。
    return path.resolve(s);
  } catch {
    return null;
  }
}

/** 已正规化的路径段是否命中 denylist（目录段／档名／序列）。 */
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
 * 是否为敏感路径（denylist）。语义**与云端 device-bridge-policy.ts 相同**：
 * 扫描所有路径段（不限 $HOME 之下）、一律转小写、fail-closed。
 *
 * 判定分两趟，任一命中即敏感（只会更严，不会更松）：
 *  1. **词法段**：直接切原始字串（反斜线→`/`、转小写、丢掉空段/`.`/`..`），
 *     与云端相同——`..` 不 resolve、只是被丢弃。故 `~/.ssh/../../etc/passwd`
 *     仍因命中 `.ssh` 段而判敏感（云端向量表 requirement，本机不得比云端松）。
 *  2. **resolve 后的路径**：再对 `path.resolve` 结果判一次，覆盖「相对路径 + cwd
 *     落在敏感段之下」这类本机情境；`~` 无法展开时回 null ⇒ fail-closed。
 * @param {string} p 候选路径
 * @param {string} [home] 使用者家目录（预设 os.homedir()；仅用于展开 `~`）
 * @param {string} [platform] 预设 process.platform（保留供相容；denylist 已不分平台）
 */
function isSensitivePath(p, home = os.homedir(), platform = process.platform) {
  // fail-closed：非字串／空／纯空白／含 NUL → 视为敏感（与云端 `p.trim()` 一致）。
  if (typeof p !== "string" || p.trim().length === 0 || p.includes("\0")) return true;
  // 1) 词法段（云端语义：不 resolve，`..` 丢弃）——`..` 穿越敏感段仍命中。
  if (segmentsSensitive(pathSegments(p))) return true;
  // 2) resolve 后再判（本机加固：涵盖 cwd-relative）；无法解析 → fail-closed。
  const abs = normalizePath(p, home, platform);
  if (!abs) return true;
  return segmentsSensitive(pathSegments(abs));
}

// ---------------------------------------------------------------------------
// 路径授权（allowlist）
// ---------------------------------------------------------------------------

/**
 * 路径是否落在使用者「逐次挑选」授权的根之内。
 *
 * allowedRoots 是绝对路径字串阵列，每个元素可以是一份「使用者刚挑选的档案
 * 本身」或「使用者刚挑选的目录」。判定以分隔符边界比对：
 *   - 前缀混淆 `/home/u/allowed-evil` 不会匹配根 `/home/u/allowed`
 *     （因为边界要求 `root + sep`）。
 *   - `..` 逃逸先经 path.resolve 正规化，`/home/u/allowed/../secret`
 *     会变成 `/home/u/secret`，不匹配。
 *   - 敏感路径一律先拒，即使落在授权根之下。
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
    // 目录边界：必须是 root + 分隔符开头，杜绝 allowed-evil 这类前缀混淆。
    const prefix = r.endsWith(sep) ? r : r + sep;
    if (target.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * 主进程侧 renderer 来源验证：host 必须在 appHosts 内，且 **protocol 必须是
 * http/https**（fail-closed）。M1：只比 host 会被 `file://www.eimu.dev/x` 冒充
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
// ffmpeg 候选表
// ---------------------------------------------------------------------------

const WIN_FFMPEG_CANDIDATES = (home) => [
  "ffmpeg",
  "ffmpeg.exe",
  home ? path.win32.join(home, ".kunpeng", "bin", "ffmpeg.exe") : null,
  home ? path.win32.join(home, "AppData", "Local", "Microsoft", "WinGet", "Links", "ffmpeg.exe") : null,
  "C:\\ffmpeg\\bin\\ffmpeg.exe",
];

const POSIX_FFMPEG_CANDIDATES = (home) => [
  "/opt/eimu-harness/bin/ffmpeg",
  home ? path.posix.join(home, ".kunpeng", "bin", "ffmpeg") : null,
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
  "ffmpeg",
];

/**
 * 回传有序的 ffmpeg 候选路径（纯函式，不验证存在性；实际探测在 worker）。
 * 形态照抄 videoCompose.ts:detectFfmpeg 的候选表。
 * env.EIMU_FFMPEG 若设定，置顶作为显式覆写。
 *
 * @param {Record<string,string>} [env] 预设 process.env
 * @param {string} [platform] 预设 process.platform
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
// ffmpeg argv 建构（固定 argv，禁止 shell 字串）
// ---------------------------------------------------------------------------

const VIDEO_CODECS = new Set(["libx264", "libx265", "libvpx-vp9", "h264_nvenc", "hevc_nvenc"]);
const PRESETS = new Set(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"]);
const AUDIO_CODECS = new Set(["aac", "libopus", "mp3", "copy"]);

function intInRange(v, min, max, field) {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new LocalError("E_BAD_OPTS", `${field} 必须是 ${min}..${max} 的整数`);
  }
  return n;
}

function enumValue(v, set, field) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !set.has(v)) {
    throw new LocalError("E_BAD_OPTS", `${field} 不在白名单内`);
  }
  return v;
}

/** 把 transcode 选项正规化／校验；任何非白名单值一律拒（不静默丢弃）。 */
function normalizeTranscodeOptions(opts = {}) {
  if (opts === null || typeof opts !== "object") {
    throw new LocalError("E_BAD_OPTS", "opts 必须是物件");
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
  if (out.maxWidth && out.maxWidth % 2 !== 0) out.maxWidth -= 1; // yuv420p 需偶数
  if (out.maxHeight && out.maxHeight % 2 !== 0) out.maxHeight -= 1;
  if (out.format === "webm" && out.videoCodec === "libx264") out.videoCodec = "libvpx-vp9";
  if (out.format === "webm" && out.audioCodec === "aac") out.audioCodec = "libopus";
  return out;
}

/**
 * 建构固定 argv 阵列（不含 ffmpeg 二进位本身；worker 以 spawn(bin, args,
 * {shell:false}) 执行）。所有值都经过白名单／数值校验，注入字串无法变成
 * 额外参数（argv 阵列天生不经 shell 拆词）。
 *
 * @param {"transcode"|"frame"} op
 * @param {string} input 已授权的绝对输入路径
 * @param {string} output 输出档案路径
 * @param {object} [opts]
 * @returns {string[]}
 */
function buildFfmpegArgs(op, input, output, opts = {}) {
  if (typeof input !== "string" || input.includes("\0") || input.length === 0) {
    throw new LocalError("E_BAD_ARGS", "input 必须是非空字串");
  }
  if (typeof output !== "string" || output.includes("\0") || output.length === 0) {
    throw new LocalError("E_BAD_ARGS", "output 必须是非空字串");
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
// 抽帧计画（纯函式）
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
      throw new LocalError("E_BAD_OPTS", `timesSec 必须是 1..${FRAME_MAX_COUNT} 个时间点`);
    }
    timesSec = p.timesSec.map((t) => {
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0 || n > 86400) {
        throw new LocalError("E_BAD_OPTS", "timesSec 每个值必须是 0..86400 秒");
      }
      return Math.round(n * 1000) / 1000;
    });
  }
  return { count, timesSec, maxWidth };
}

/** 依影片时长决定抽帧时间点（等距；避免 0 与结尾误差各留边界内缩）。 */
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
// pickFiles 选项正规化（纯函式）
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
// ffmpeg 并发／记忆体闸（语义照抄 deploy-staging/gateway/ffmpeg-limiter.ts）
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
    return Number.MAX_SAFE_INTEGER; // 非 Linux（macOS/Windows）无此档 → 不因记忆体卡住
  }
}

/**
 * 并发／记忆体闸。放行条件（同时成立，否则排队）：
 *   1. active < maxConcurrent（预设 2；设 0 = 关闭限流）
 *   2. memAvailableMB() >= minMemMB（预设 400）
 * 与 ffmpeg-limiter.ts 的差异：壳内为单进程、无跨进程需求，故不加 1s ticker
 * （release 即唤醒；desktop ffmpeg 结束必经 release）。
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

  /** 执行 fn 并在 finally 保证释放 slot。 */
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
