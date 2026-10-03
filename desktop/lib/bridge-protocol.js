// desktop/lib/bridge-protocol.js
//
// W6b：device bridge「本機側」的**純函式**層（零 I/O、零狀態、electron 無關）。
//
// 這一層與雲端閘道 deploy-staging/gateway/device-bridge.ts /
// device-bridge-policy.ts 逐欄對齊（同一組工具白名單、同樣的欄位夾制、
// 同樣的 256KB 上限與 `…[truncated N bytes]` 標記）。客戶端與閘道是同一份
// 契約的兩半：閘道那份是雲端縱深防禦的第二道，本檔是本機端執行前的第一道。
//
// denylist **不自造第二份清單**：直接 require ./policy.js 的 isSensitivePath
// （來源＝desktop/lib/policy.js，W3 殼層安全層）。本機實作與閘道
// `device-bridge-policy.ts:isSensitivePath` **同一語義**：掃描所有路徑段
// （不限家目錄之下）、一律轉小寫、fail-closed（純空白/非字串/無法解析 → 敏感）。
// 兩者跨 runtime 無法共用模組，故以**雲端向量表**
// `deploy-staging/gateway/device-bridge-policy.vectors.json` 為唯一真源；
// 本機 `policy.test.js` 用 fs.readFileSync 載入該檔逐條斷言（見 Gap2）。

"use strict";

const policy = require("./policy.js");

// ── 與雲端側一致的常數（device-bridge-policy.ts / device-bridge.ts）──────────

/** 允許經裝置橋執行的工具**最小集合**。無任何寫入／刪除／執行命令工具。 */
const TOOLS = Object.freeze(["list_dir", "read_file", "grep", "stat"]);

/** 單次回傳內容硬上限（與雲端 MAX_READ_BYTES 相同）。 */
const MAX_READ_BYTES = 256 * 1024;
/** 未指定 limit 時的預設讀取量。 */
const DEFAULT_READ_BYTES = 64 * 1024;
/** 回傳 payload 硬上限（同雲端 finalizeDeviceResult 的 256KB）。 */
const MAX_RESULT_BYTES = MAX_READ_BYTES;

const MAX_LIST_ENTRIES = 2000;
const MAX_GREP_MATCHES = 500;

/**
 * grep 逐檔讀入硬上限（與雲端 `device-bridge-policy.ts:MAX_FILE_READ_BYTES` 同值）。
 * 雲端隨 `grep` 參數下發 `max_file_bytes`；本機 `sanitizeToolArgs` 保留並夾制它，
 * 且**本機上限不得比雲端契約寬鬆**——effective = min(雲端下發值, 本值)。
 */
const MAX_FILE_READ_BYTES = 1024 * 1024;

// ── 工具白名單 ─────────────────────────────────────────────────────────

/** 非字串／不在白名單 → false（呼叫端一律拒收）。 */
function isToolAllowed(tool) {
  return typeof tool === "string" && TOOLS.includes(tool);
}

// ── 大小夾制（與 device-bridge-policy.ts 同語義）──────────────────────────

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
 * grep 單檔讀入上限夾制（逐欄對齊 device-bridge-policy.ts:clampFileBytes）。
 * 非有限／<=0 → 上限（此處即契約上限）；其餘向下取整並夾到
 * `min(請求值, MAX_FILE_READ_BYTES)`——本機只能更嚴、不得更鬆。
 */
function clampFileBytes(requested) {
  const n = typeof requested === "number" ? requested : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return MAX_FILE_READ_BYTES;
  return Math.min(Math.floor(n), MAX_FILE_READ_BYTES);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * 以位元組截斷並附標記（逐字對齊 device-bridge-policy.ts:truncateWithMarker）。
 * UTF-8 邊界安全：切到多位元組字元中間時退位元組直到尾端不再是 U+FFFD。
 * 保證 keptBytes <= cap；標記是內容外的後設資訊。
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
 * 把本機工具結果套上大小硬上限與截斷標記（與閘道 finalizeDeviceResult 同形）。
 *  - payload 是字串 → 視為 text 欄位。
 *  - payload 物件含 string `text` → 只夾 text，保留其餘後設欄位。
 *  - 其餘 → JSON 序列化後夾制；超限時以 { truncated, truncated_bytes, text } 取代。
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

// ── 參數淨化（逐欄對齊 device-bridge.ts:sanitizeToolArgs）───────────────

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
 * denylist 判定：複用 policy.js 的 isSensitivePath（唯一真源語義＝雲端
 * device-bridge-policy.vectors.json），不放行任何自造清單。
 * @param {unknown} p
 * @param {{home?: string, platform?: string}} [ctx] 測試可注入（預設真實家目錄/平台）
 * @returns {string|null} 拒收原因碼；null＝放行。
 */
function denyReason(p, ctx) {
  if (typeof p !== "string" || p.trim().length === 0) return "bad_path";
  const home = ctx ? ctx.home : undefined;
  const platform = ctx ? ctx.platform : undefined;
  if (policy.isSensitivePath(p, home, platform)) return "sensitive_path";
  return null;
}

/**
 * 只放行工具需要的欄位，未知欄位一律剝除；敏感路徑在此就被擋下。
 * 與 device-bridge.ts:sanitizeToolArgs 逐欄等價（同夾制界、同錯誤碼）。
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
      // max_file_bytes：H2 輸入側契約。雲端下發此值；本機保留並夾制到本機上限
      // （effective = min(雲端值, MAX_FILE_READ_BYTES)），執行器逐檔讀取真的用它。
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

// ── 輪詢／重連退避 ─────────────────────────────────────────────────────

const DEFAULT_BACKOFF = Object.freeze({ baseMs: 1000, factor: 2, maxMs: 30000 });

/**
 * 指數退避。attempt 為「已連續失敗次數」（0 起算）。
 * 保證回傳值 ∈ [0, maxMs]，且非有限輸入一律視為 0。
 * jitterRatio > 0 時只在延遲上「加」隨機量（不降到 0，避免忙輪）。
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
