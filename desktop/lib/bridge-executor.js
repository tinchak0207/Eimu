// desktop/lib/bridge-executor.js
//
// W6b：device bridge 的「四個唯讀工具執行器」——自 device-bridge-client.js 抽出的
// 可測模組（純邏輯 + **注入 fs**）。device-bridge-client.js 只負責連線與編排
// （register/heartbeat/poll/result）；真正的檔案存取與安全閘全收斂在本檔，故危險
// 路徑可被 node:test 直接執行（device-bridge-client.js 的舊版執行器零測試）。
//
// 安全邊界（與 local-worker.js 同語義，單一授權來源）：
//  1. 工具白名單＝list_dir/read_file/grep/stat（無寫/刪/執行）。
//  2. 路徑先 realpath 解 symlink，再過 policy.isSensitivePath（denylist，掃所有路徑段）。
//  3. allowlist **必填**：授權根為空集 ⇒ 一律拒（no_authorized_roots）。授權來源與
//     local-worker.js 是**同一份** authorizedRoots（使用者由 pickFiles 顯式挑選的根），
//     不另造第二套授權機制。空集**不得**退回「只驗 denylist」。
//  4. 拒絕檔案系統根路徑（path_is_root），避免整盤掃描。
//  5. grep 逐檔先 stat 再決定是否讀取；單檔上限 = min(雲端下發 max_file_bytes,
//     本機 MAX_GREP_FILE_BYTES)，超過者**跳過並計數**（避免整檔入記憶體）。
//  6. grep/list_dir 自報 `sensitive_path_touched`／`excluded_sensitive_count`（H2 契約：
//     遞迴/列舉碰到敏感段即計數；雲端 sensitiveResultProblem 據此整筆拒絕）。
//
// 注入介面（測試可替換）：fs 需提供 realpathSync(.native)、existsSync、statSync、
// readdirSync、readFileSync、openSync/readSync/closeSync；roots 為回傳授權根陣列的
// 函式（或直接給陣列）。

"use strict";

const path = require("node:path");
const nodeFs = require("node:fs");
const policy = require("./policy.js");
const proto = require("./bridge-protocol.js");

const MAX_LIST_DEFAULT = 200;
const MAX_GREP_FILES = 5000;
const MAX_GREP_DEPTH = 12;
/**
 * 單檔讀取上限（grep 逐檔）：超過即跳過，避免整檔入記憶體。
 * 本機自有天花板**不得比雲端契約寬鬆**：等於 `proto.MAX_FILE_READ_BYTES`（1MB），
 * 且執行時取 `min(args.max_file_bytes, 本值)`——雲端下發更小值時以雲端值為準，
 * 下發更大值（或直接呼叫執行器繞過淨化）時一律被本值夾住。
 */
const MAX_GREP_FILE_BYTES = proto.MAX_FILE_READ_BYTES;
const GREP_LINE_MAX = 400;

class BridgeError extends Error {
  constructor(code, status, detail) {
    super(`${code}${detail ? `: ${detail}` : ""}`);
    this.name = "BridgeError";
    this.code = code;
    this.status = status || 0;
  }
}

/** 是否為檔案系統根（POSIX "/"、Windows "C:\"）。根必拒，禁整盤掃描。 */
function isFsRoot(abs) {
  if (typeof abs !== "string" || abs.length === 0) return false;
  return path.parse(abs).root === abs;
}

/**
 * 建立一個執行器實例。
 * @param {{fs?: object, roots?: string[]|(() => string[])}} [options]
 */
function createBridgeExecutor(options = {}) {
  const fs = options.fs || nodeFs;
  const rootsProvider =
    typeof options.roots === "function"
      ? options.roots
      : () => (Array.isArray(options.roots) ? options.roots : []);

  /** 解 symlink；不存在時對父目錄解 symlink 再接回 basename（輸出檔常用）。 */
  function resolveReal(p) {
    const realpath = (fs.realpathSync && fs.realpathSync.native) || fs.realpathSync;
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

  /**
   * 檢查路徑已授權且非敏感；回傳其 realpath。
   * 順序：bad_path → 根拒絕 → denylist → allowlist（空集＝全拒）→ 存在性。
   */
  function requireLocalPath(raw) {
    if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0")) {
      throw new BridgeError("bad_path", 400);
    }
    const abs = resolveReal(raw);
    if (isFsRoot(abs)) throw new BridgeError("path_is_root", 403, abs);
    // 解 symlink 後再跑 denylist —— policy 是字串判定，跟不了 symlink（同 local-worker）。
    if (policy.isSensitivePath(abs)) throw new BridgeError("sensitive_path", 403);
    const roots = rootsProvider();
    if (!Array.isArray(roots) || roots.length === 0) {
      // H1：allowlist 必填。空集＝全拒，不得退回「只驗 denylist」。
      throw new BridgeError("no_authorized_roots", 403);
    }
    if (!policy.isPathAllowed(abs, roots)) throw new BridgeError("not_authorized", 403);
    if (!fs.existsSync(abs)) throw new BridgeError("not_found", 404);
    return abs;
  }

  // ── 四個唯讀工具（無寫/刪/執行）────────────────────────────────────────

  function toolListDir(args) {
    const abs = requireLocalPath(args.path);
    const st = fs.statSync(abs);
    if (!st.isDirectory()) throw new BridgeError("not_a_directory", 400);
    const max = Number.isInteger(args.max_entries) ? args.max_entries : MAX_LIST_DEFAULT;
    const all = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 2000);
    const entries = [];
    let excludedSensitive = 0;
    for (const d of all) {
      if (entries.length >= max) break;
      const full = path.join(abs, d.name);
      // 敏感檔名/目錄名不進回傳（與 grep 遞迴剪枝同語義）；計數後回報給雲端。
      if (policy.isSensitivePath(full)) {
        excludedSensitive += 1;
        continue;
      }
      let size = null;
      let mtimeMs = null;
      try {
        const s = fs.statSync(full);
        size = s.size;
        mtimeMs = s.mtimeMs;
      } catch {
        /* 權限/競態：略過後設欄位 */
      }
      const type = d.isDirectory() ? "dir" : d.isSymbolicLink() ? "symlink" : d.isFile() ? "file" : "other";
      entries.push({ name: d.name, type, size, mtime_ms: mtimeMs });
    }
    return {
      path: abs,
      entries,
      count: entries.length,
      // H2 契約面第二層：裝置自報遞迴/列舉時是否碰到敏感段（雲端據此整筆拒絕）。
      sensitive_path_touched: excludedSensitive > 0,
      excluded_sensitive_count: excludedSensitive,
    };
  }

  function toolReadFile(args) {
    const abs = requireLocalPath(args.path);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new BridgeError("not_a_file", 400);
    const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0;
    const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, proto.MAX_READ_BYTES) : proto.DEFAULT_READ_BYTES;
    const fd = fs.openSync(abs, "r");
    try {
      const buf = Buffer.alloc(limit);
      const bytesRead = fs.readSync(fd, buf, 0, limit, offset);
      return {
        path: abs,
        offset,
        limit,
        size: st.size,
        bytes_read: bytesRead,
        text: buf.subarray(0, bytesRead).toString("utf8"),
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * 遞迴收集檔案。敏感段（含目錄）直接剪枝：不進收集、也不讀取，並累計
   * `stats.excludedSensitive`（雲端據此判定裝置是否碰到敏感段）。
   * 不跟 symlink（防逃逸）；上限 GREP_MAX_FILES 檔、GREP_MAX_DEPTH 層。
   */
  function collectFiles(startAbs, st, out, depth, maxDepth, stats) {
    if (out.length >= MAX_GREP_FILES || depth > maxDepth) return;
    if (st.isFile()) {
      out.push(startAbs);
      return;
    }
    if (!st.isDirectory()) return;
    let names;
    try {
      names = fs.readdirSync(startAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (out.length >= MAX_GREP_FILES) return;
      if (d.isSymbolicLink()) continue; // 不跟 symlink，防逃逸
      const full = path.join(startAbs, d.name);
      if (policy.isSensitivePath(full)) {
        stats.excludedSensitive += 1; // 敏感段剪枝（H2：敏感檔被排除）
        continue;
      }
      let s;
      try {
        s = fs.statSync(full);
      } catch {
        continue; // 略過無法 stat 的項
      }
      collectFiles(full, s, out, depth + 1, maxDepth, stats);
    }
  }

  function toolGrep(args) {
    const abs = requireLocalPath(args.path);
    const st = fs.statSync(abs);
    if (!st.isDirectory() && !st.isFile()) throw new BridgeError("not_searchable", 400);
    const maxMatches = Number.isInteger(args.max_matches) ? args.max_matches : 100;
    // H2 輸入側契約：逐檔讀入上限 = min(雲端下發 max_file_bytes, 本機上限)。
    const maxFileBytes =
      Number.isInteger(args.max_file_bytes) && args.max_file_bytes > 0
        ? Math.min(args.max_file_bytes, MAX_GREP_FILE_BYTES)
        : MAX_GREP_FILE_BYTES;
    let re = null;
    try {
      re = new RegExp(args.pattern);
    } catch {
      re = null; // 非法正則 → 退回字面 contains
    }
    const files = [];
    const stats = { excludedSensitive: 0 };
    collectFiles(abs, st, files, 0, MAX_GREP_DEPTH, stats);
    const matches = [];
    let filesScanned = 0;
    let skippedLargeFiles = 0;
    outer: for (const f of files) {
      if (policy.isSensitivePath(f)) {
        stats.excludedSensitive += 1;
        continue;
      }
      // M3：先 stat 再決定是否讀取；超過單檔上限即跳過並計數（不整檔入記憶體）。
      let size = null;
      try {
        size = fs.statSync(f).size;
      } catch {
        continue;
      }
      if (Number.isFinite(size) && size > maxFileBytes) {
        skippedLargeFiles += 1;
        continue;
      }
      let content;
      try {
        content = fs.readFileSync(f, "utf8");
      } catch {
        continue;
      }
      filesScanned += 1;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (re ? re.test(line) : line.includes(args.pattern)) {
          matches.push({ path: f, line: i + 1, text: line.slice(0, GREP_LINE_MAX) });
          if (matches.length >= maxMatches) break outer;
        }
      }
    }
    return {
      path: abs,
      pattern: args.pattern,
      matches,
      count: matches.length,
      files_scanned: filesScanned,
      skipped_large_files: skippedLargeFiles,
      // H2 契約面第二層：自報遞迴時是否碰到敏感段（雲端 sensitiveResultProblem 據此整筆拒）。
      sensitive_path_touched: stats.excludedSensitive > 0,
      excluded_sensitive_count: stats.excludedSensitive,
    };
  }

  function toolStat(args) {
    const abs = requireLocalPath(args.path);
    const st = fs.statSync(abs);
    return {
      path: abs,
      type: st.isDirectory() ? "dir" : st.isFile() ? "file" : "other",
      size: st.size,
      mtime_ms: st.mtimeMs,
      mode: st.mode,
    };
  }

  async function executeTool(tool, args) {
    switch (tool) {
      case "list_dir":
        return toolListDir(args);
      case "read_file":
        return toolReadFile(args);
      case "grep":
        return toolGrep(args);
      case "stat":
        return toolStat(args);
      default:
        throw new BridgeError("tool_not_allowed", 403, String(tool));
    }
  }

  return { executeTool, requireLocalPath, resolveReal, toolListDir, toolReadFile, toolGrep, toolStat };
}

module.exports = {
  createBridgeExecutor,
  BridgeError,
  isFsRoot,
  MAX_LIST_DEFAULT,
  MAX_GREP_FILES,
  MAX_GREP_DEPTH,
  MAX_GREP_FILE_BYTES,
  GREP_LINE_MAX,
};
