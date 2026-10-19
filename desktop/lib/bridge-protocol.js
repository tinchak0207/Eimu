// desktop/lib/bridge-protocol.js
//
// W6b：device bridge「本机侧」的**纯函式**层（零 I/O、零状态、electron 无关）。
//
// 这一层与云端闸道 deploy-staging/gateway/device-bridge.ts /
// device-bridge-policy.ts 逐栏对齐（同一组工具白名单、同样的栏位夹制、
// 同样的 256KB 上限与 `…[truncated N bytes]` 标记）。客户端与闸道是同一份
// 契约的两半：闸道那份是云端纵深防御的第二道，本档是本机端执行前的第一道。
//
// denylist **不自造第二份清单**：直接 require ./policy.js 的 isSensitivePath
// （来源＝desktop/lib/policy.js，W3 壳层安全层）。本机实作与闸道
// `device-bridge-policy.ts:isSensitivePath` **同一语义**：扫描所有路径段
// （不限家目录之下）、一律转小写、fail-closed（纯空白/非字串/无法解析 → 敏感）。
// 两者跨 runtime 无法共用模组，故以**云端向量表**
// `deploy-staging/gateway/device-bridge-policy.vectors.json` 为唯一真源；
// 本机 `policy.test.js` 用 fs.readFileSync 载入该档逐条断言（见 Gap2）。

"use strict";

const policy = require("./policy.js");

// ── 与云端侧一致的常数（device-bridge-policy.ts / device-bridge.ts）──────────

/** 允许经装置桥执行的工具**最小集合**。无任何写入／删除／执行命令工具。 */
const TOOLS = Object.freeze(["list_dir", "read_file", "grep", "stat"]);

/** 单次回传内容硬上限（与云端 MAX_READ_BYTES 相同）。 */
const MAX_READ_BYTES = 256 * 1024;
/** 未指定 limit 时的预设读取量。 */
const DEFAULT_READ_BYTES = 64 * 1024;
/** 回传 payload 硬上限（同云端 finalizeDeviceResult 的 256KB）。 */
const MAX_RESULT_BYTES = MAX_READ_BYTES;

const MAX_LIST_ENTRIES = 2000;
const MAX_GREP_MATCHES = 500;

/**
 * grep 逐档读入硬上限（与云端 `device-bridge-policy.ts:MAX_FILE_READ_BYTES` 同值）。
 * 云端随 `grep` 参数下发 `max_file_bytes`；本机 `sanitizeToolArgs` 保留并夹制它，
 * 且**本机上限不得比云端契约宽松**——effective = min(云端下发值, 本值)。
 */
const MAX_FILE_READ_BYTES = 1024 * 1024;

// ── 工具白名单 ─────────────────────────────────────────────────────────

/** 非字串／不在白名单 → false（呼叫端一律拒收）。 */
function isToolAllowed(tool) {
  return typeof tool === "string" && TOOLS.includes(tool);
}

// ── 大小夹制（与 device-bridge-policy.ts 同语义）──────────────────────────

function clampReadSize(requested) {
  const n = typeof requested === "number" ? requested : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_READ_BYTES;
  return Math.min(Math.floor(n), MAX_READ_BYTES);
}

function clampResultBytes(requested) {
  const n = typeof requested === "number" ? requested : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return MAX_RESULT_BYTES;
  return Math.min(Math.floor(n), MAX_RESULT_BYTES);
}

/**
 * grep 单档读入上限夹制（逐栏对齐 device-bridge-policy.ts:clampFileBytes）。
 * 非有限／<=0 → 上限（此处即契约上限）；其余向下取整并夹到
 * `min(请求值, MAX_FILE_READ_BYTES)`——本机只能更严、不得更松。
 */
function clampFileBytes(requested) {
  const n = typeof requested === "number" ? requested : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return MAX_FILE_READ_BYTES;
  return Math.min(Math.floor(n), MAX_FILE_READ_BYTES);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * 以位元组截断并附标记（逐字对齐 device-bridge-policy.ts:truncateWithMarker）。
 * UTF-8 边界安全：切到多位元组字元中间时退位元组直到尾端不再是 U+FFFD。
 * 保证 keptBytes <= cap；标记是内容外的后设资讯。
 */
function truncateWithMarker(text, max) {
  const input = typeof text === "string" ? text : String(text ?? "");
  const cap = clampResultBytes(max);
  const bytes = encoder.encode(input);
  const originalBytes = bytes.length;
  if (originalBytes <= cap) {
    return { text: input, truncated: false, originalBytes, keptBytes: originalBytes };
  }
  let kept = bytes.slice(0, cap);
  let decoded = decoder.decode(kept);
  while (decoded.endsWith("\uFFFD") && kept.length > 0) {
    kept = kept.slice(0, kept.length - 1);
    decoded = decoder.decode(kept);
  }
  const marker = `\n…[truncated ${originalBytes - kept.length} bytes]`;
  return { text: decoded + marker, truncated: true, originalBytes, keptBytes: kept.length };
}

/**
 * 把本机工具结果套上大小硬上限与截断标记（与闸道 finalizeDeviceResult 同形）。
 *  - payload 是字串 → 视为 text 栏位。
 *  - payload 物件含 string `text` → 只夹 text，保留其余后设栏位。
 *  - 其余 → JSON 序列化后夹制；超限时以 { truncated, truncated_bytes, text } 取代。
 * @returns {{ result: object, truncated: boolean, bytes: number, original_bytes: number }}
 */
function clampResult(payload, maxBytes) {
  const cap = clampResultBytes(maxBytes);
  if (typeof payload === "string") {
    const t = truncateWithMarker(payload, cap);
    return { result: { text: t.text, truncated: t.truncated }, truncated: t.truncated, bytes: t.keptBytes, original_bytes: t.originalBytes };
  }
  const obj = typeof payload === "object" && payload !== null ? payload : { value: payload };
  if (typeof obj.text === "string") {
    const t = truncateWithMarker(obj.text, cap);
    const result = { ...obj, text: t.text, truncated: t.truncated };
    if (t.truncated) result.truncated_bytes = t.originalBytes - t.keptBytes;
    return { result, truncated: t.truncated, bytes: t.keptBytes, original_bytes: t.originalBytes };
  }
  const serialized = JSON.stringify(obj);
  const t = truncateWithMarker(serialized, cap);
  if (!t.truncated) return { result: obj, truncated: false, bytes: t.originalBytes, original_bytes: t.originalBytes };
  return {
    result: { truncated: true, truncated_bytes: t.originalBytes - t.keptBytes, text: t.text },
    truncated: true,
    bytes: t.keptBytes,
    original_bytes: t.originalBytes,
  };
}

// ── 参数净化（逐栏对齐 device-bridge.ts:sanitizeToolArgs）───────────────

function asString(v) {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function asIntInRange(v, min, max) {
  const n = typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < min || i > max) return null;
  return i;
}

/**
 * denylist 判定：复用 policy.js 的 isSensitivePath（唯一真源语义＝云端
 * device-bridge-policy.vectors.json），不放行任何自造清单。
 * @param {unknown} p
 * @param {{home?: string, platform?: string}} [ctx] 测试可注入（预设真实家目录/平台）
 * @returns {string|null} 拒收原因码；null＝放行。
 */
function denyReason(p, ctx) {
  if (typeof p !== "string" || p.trim().length === 0) return "bad_path";
  const home = ctx ? ctx.home : undefined;
  const platform = ctx ? ctx.platform : undefined;
  if (policy.isSensitivePath(p, home, platform)) return "sensitive_path";
  return null;
}

/**
 * 只放行工具需要的栏位，未知栏位一律剥除；敏感路径在此就被挡下。
 * 与 device-bridge.ts:sanitizeToolArgs 逐栏等价（同夹制界、同错误码）。
 * @returns {{ok:true,args:object}|{ok:false,code:string,message:string}}
 */
function sanitizeToolArgs(tool, raw, ctx) {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, code: "bad_request", message: "args must be an object" };
  }
  const r = raw;
  const p = asString(r.path);
  if (!p) return { ok: false, code: "bad_request", message: "args.path is required" };
  const denied = denyReason(p, ctx);
  if (denied) return { ok: false, code: denied, message: "path is denied by policy" };

  switch (tool) {
    case "list_dir": {
      const args = { path: p };
      if (r.max_entries !== undefined) {
        const n = asIntInRange(r.max_entries, 1, MAX_LIST_ENTRIES);
        if (n === null) return { ok: false, code: "bad_request", message: `max_entries must be 1..${MAX_LIST_ENTRIES}` };
        args.max_entries = n;
      }
      return { ok: true, args };
    }
    case "read_file": {
      const args = { path: p, offset: 0, limit: clampReadSize(r.limit) };
      if (r.offset !== undefined) {
        const off = asIntInRange(r.offset, 0, Number.MAX_SAFE_INTEGER);
        if (off === null) return { ok: false, code: "bad_request", message: "offset must be a non-negative integer" };
        args.offset = off;
      }
      return { ok: true, args };
    }
    case "grep": {
      const pattern = asString(r.pattern);
      if (!pattern) return { ok: false, code: "bad_request", message: "args.pattern is required" };
      // max_file_bytes：H2 输入侧契约。云端下发此值；本机保留并夹制到本机上限
      // （effective = min(云端值, MAX_FILE_READ_BYTES)），执行器逐档读取真的用它。
      const args = { path: p, pattern, max_matches: 100, max_file_bytes: clampFileBytes(r.max_file_bytes) };
      if (r.max_matches !== undefined) {
        const n = asIntInRange(r.max_matches, 1, MAX_GREP_MATCHES);
        if (n === null) return { ok: false, code: "bad_request", message: `max_matches must be 1..${MAX_GREP_MATCHES}` };
        args.max_matches = n;
      }
      return { ok: true, args };
    }
    case "stat":
      return { ok: true, args: { path: p } };
    default:
      return { ok: false, code: "tool_not_allowed", message: `tool not allowed: ${String(tool)}` };
  }
}

// ── 轮询／重连退避 ─────────────────────────────────────────────────────

const DEFAULT_BACKOFF = Object.freeze({ baseMs: 1000, factor: 2, maxMs: 30000 });

/**
 * 指数退避。attempt 为「已连续失败次数」（0 起算）。
 * 保证回传值 ∈ [0, maxMs]，且非有限输入一律视为 0。
 * jitterRatio > 0 时只在延迟上「加」随机量（不降到 0，避免忙轮）。
 */
function nextBackoff(attempt, opts = {}) {
  const baseMs = Number.isFinite(opts.baseMs) && opts.baseMs > 0 ? opts.baseMs : DEFAULT_BACKOFF.baseMs;
  const factor = Number.isFinite(opts.factor) && opts.factor >= 1 ? opts.factor : DEFAULT_BACKOFF.factor;
  const maxMs = Number.isFinite(opts.maxMs) && opts.maxMs > 0 ? opts.maxMs : DEFAULT_BACKOFF.maxMs;
  const jitterRatio = Number.isFinite(opts.jitterRatio) && opts.jitterRatio > 0 ? opts.jitterRatio : 0;
  const a = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  let delay = baseMs * Math.pow(factor, a);
  if (!Number.isFinite(delay)) delay = maxMs;
  if (jitterRatio > 0) delay += delay * jitterRatio * Math.random();
  return Math.max(0, Math.min(maxMs, Math.round(delay)));
}

module.exports = {
  TOOLS,
  MAX_READ_BYTES,
  DEFAULT_READ_BYTES,
  MAX_RESULT_BYTES,
  MAX_LIST_ENTRIES,
  MAX_GREP_MATCHES,
  MAX_FILE_READ_BYTES,
  isToolAllowed,
  clampReadSize,
  clampResultBytes,
  clampFileBytes,
  truncateWithMarker,
  clampResult,
  sanitizeToolArgs,
  denyReason,
  nextBackoff,
  DEFAULT_BACKOFF,
};
