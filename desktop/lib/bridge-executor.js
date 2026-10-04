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
const os = require("node:os");
const nodeFs = require("node:fs");
const policy = require("./policy.js");
const proto = require("./bridge-protocol.js");
// 第二道防線（W6c）：本機獨立複核的權限決策（硬 denylist／safety-check／規則／模式）。
// 與 gateway 同一條判定序（見 permission-rules.js 檔頭）；本檔只負責在**執行前**
// 以本機自身狀態（模式／規則／授權根／home）再判一次，雲端被繞過也擋得住。
const permissionRules = require("./permission-rules.js");

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
 *
 * 第二道防線注入點（形狀同 roots，可傳值或函式；值注入須為字串/陣列）：
 *   - `mode`  當前權限模式（"off"|"ask"|"auto"|"full"）。未提供時回退 `"auto"`
 *     （升級前行為：授權根內自動；硬 denylist／safety-check 仍生效），刻意**不**
 *     改用 `"ask"` 以免讓未接權限模式的既有呼叫端全部變成待授權。
 *   - `rules` 規則集（陣列或 {deny,ask,allow} 物件）。
 *   - `home`  家目錄（僅供硬 denylist 展開 `~`／mode=full 判定）。
 *
 * @param {{fs?: object, roots?: string[]|(() => string[]), mode?: string|(() => string), rules?: unknown|(() => unknown), home?: string|(() => string)}} [options]
 */
function createBridgeExecutor(options = {}) {
  const fs = options.fs || nodeFs;
  const rootsProvider =
    typeof options.roots === "function"
      ? options.roots
      : () => (Array.isArray(options.roots) ? options.roots : []);
  // 注入點一律驗型別（教訓：跨界傳錯型別會被下游守衛靜默降級，只失效不報錯）。
  const modeProvider =
    typeof options.mode === "function"
      ? options.mode
      : () => (typeof options.mode === "string" ? options.mode : undefined);
  const rulesProvider =
    typeof options.rules === "function"
      ? options.rules
      : () => (options.rules !== undefined ? options.rules : undefined);
  const homeProvider =
    typeof options.home === "function"
      ? options.home
      : () => (typeof options.home === "string" ? options.home : undefined);

  /** 當前家目錄（未注入＝os.homedir()）。 */
  const currentHome = () => {
    const h = homeProvider();
    return typeof h === "string" && h.length > 0 ? h : os.homedir();
  };

  // ── 對話內就地授權（consent）的「已同意根」支持 ─────────────────────────
  // 雲端在對話中取得使用者同意（once/session/permanent）後，會在其後每次 invoke
  // 隨 DeviceRequestMessage.consent 重送（冪等）。裝置端第二道防線只看自己的
  // mode/rules/roots，**不知道**雲端剛發生的授權 ⇒ mode=ask 下永遠回 needs_authorization
  // （實機缺陷）。修法：把本次請求的 grantedRoots 併入（a）allowlist 與（b）有效規則
  // 的 allow 桶；硬 denylist／safety-check 仍在最前，grantedRoots **不得**繞過。
  //
  // fail-closed：grantedRoots 非陣列／元素非非空字串 → 該元素略過（不當空陣列清空既有授權）。

  /** 正規化 grantedRoots：僅保留非空字串、去重（undefined／型別錯＝空）。 */
  function normalizeGrantedRoots(grantedRoots) {
    if (!Array.isArray(grantedRoots)) return [];
    const out = [];
    for (const r of grantedRoots) {
      if (typeof r !== "string") continue;
      const t = r.trim();
      if (t.length === 0) continue;
      if (!out.includes(t)) out.push(t);
    }
    return out;
  }

  /** 有效 allowlist ＝ rootsProvider() ∪ grantedRoots（順序保留 roots 在前，維持既有斷言）。 */
  function effectiveRoots(grantedRoots) {
    const base = rootsProvider();
    const arr = Array.isArray(base) ? base.slice() : [];
    for (const g of normalizeGrantedRoots(grantedRoots)) {
      if (!arr.includes(g)) arr.push(g);
    }
    return arr;
  }

  /** 有效規則 ＝ 既有 rules ∪ grantedRoots.map(allowRuleForRoot)（物件或陣列型皆支援）。 */
  function withGrantedAllowRules(base, grantedRoots) {
    const granted = normalizeGrantedRoots(grantedRoots);
    if (granted.length === 0) return base;
    const extra = [];
    for (const g of granted) {
      const rule = permissionRules.allowRuleForRoot(g);
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
   * 第二道防線：以本機自身狀態（模式／規則／授權根／home）獨立複核。
   * 判定序全部來自 permission-rules.evaluatePermission（硬 denylist → safety-check
   * → 規則 deny/ask/allow → 模式 → 預設 ask）。雲端即使被繞過或規則被篡改，這裡仍
   * 以同一語義拒絕。不執行時的錯誤碼（供 gateway 流程對上）：
   *   - deny → `permission_denied`（403）
   *   - ask  → `needs_authorization`（403，對上凍結契約的授權流程）
   */
  function enforcePermission(tool, raw, resolved, grantedRoots) {
    const mode = modeProvider();
    const effectiveMode = typeof mode === "string" && mode.length > 0 ? mode : "auto";
    const rules = rulesProvider();
    const mergedRules = withGrantedAllowRules(rules === undefined ? undefined : rules, grantedRoots);
    const verdict = permissionRules.evaluatePermission({
      tool,
      rawPath: raw,
      resolvedPath: resolved,
      mode: effectiveMode,
      rules: mergedRules === undefined ? undefined : mergedRules,
      authorizedRoots: effectiveRoots(grantedRoots),
      home: currentHome(),
    });
    if (verdict.decision === "allow") return;
    if (verdict.decision === "deny") {
      throw new BridgeError("permission_denied", 403, verdict.reason);
    }
    throw new BridgeError("needs_authorization", 403, verdict.reason);
  }

  /**
   * 硬 denylist 複核（模式／規則無關，一律拒）：供列舉／遞迴剪枝使用。
   * 檔名樣式（`*.pem`、`.env`…）在 policy denylist 之外，這裡補上，避免
   * grep/list_dir 在授權根內把硬 denylist 檔名曝露或讀入。
   */
  function isHardDeniedPath(p) {
    return permissionRules.isHardDenied({ raw: p, resolved: p, home: currentHome() }, currentHome());
  }

  /**
   * 檢查路徑已授權且非敏感；回傳其 realpath。
   * 順序：bad_path → 根拒絕 → policy denylist → allowlist（空集＝全拒）
   *       → 第二道防線（permission-rules）→ 存在性。
   * 既有檢查（policy denylist／allowlist 必填）在前且一行不放寬；第二道防線為純加嚴。
   */
  function requireLocalPath(raw, tool = "read_file", grantedRoots) {
    if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0")) {
      throw new BridgeError("bad_path", 400);
    }
    const abs = resolveReal(raw);
    if (isFsRoot(abs)) throw new BridgeError("path_is_root", 403, abs);
    // 解 symlink 後再跑 denylist —— policy 是字串判定，跟不了 symlink（同 local-worker）。
    if (policy.isSensitivePath(abs)) throw new BridgeError("sensitive_path", 403);
    // 有效 allowlist ＝ rootsProvider() ∪ grantedRoots（對話內已同意的根）。
    const roots = effectiveRoots(grantedRoots);
    if (roots.length === 0) {
      // H1：allowlist 必填。空集＝全拒，不得退回「只驗 denylist」。
      throw new BridgeError("no_authorized_roots", 403);
    }
    if (!policy.isPathAllowed(abs, roots)) throw new BridgeError("not_authorized", 403);
    // 第二道防線（執行前獨立複核）：以本機真值判 deny/ask/allow；grantedRoots 產生
    // allow 規則，使「已同意」的根走 rule_allow 放行（未同意者仍 needs_authorization）。
    enforcePermission(tool, raw, abs, grantedRoots);
    if (!fs.existsSync(abs)) throw new BridgeError("not_found", 404);
    return abs;
  }

  // ── 四個唯讀工具（無寫/刪/執行）────────────────────────────────────────

  function toolListDir(args, grantedRoots) {
    const abs = requireLocalPath(args.path, "list_dir", grantedRoots);
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
      // 第二道防線補位：policy 之外的硬 denylist 檔名（`*.pem`、`.env`…）同樣不曝露。
      if (policy.isSensitivePath(full) || isHardDeniedPath(full)) {
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

  function toolReadFile(args, grantedRoots) {
    const abs = requireLocalPath(args.path, "read_file", grantedRoots);
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
      if (policy.isSensitivePath(full) || isHardDeniedPath(full)) {
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

  function toolGrep(args, grantedRoots) {
    const abs = requireLocalPath(args.path, "grep", grantedRoots);
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
      if (policy.isSensitivePath(f) || isHardDeniedPath(f)) {
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

  function toolStat(args, grantedRoots) {
    const abs = requireLocalPath(args.path, "stat", grantedRoots);
    const st = fs.statSync(abs);
    return {
      path: abs,
      type: st.isDirectory() ? "dir" : st.isFile() ? "file" : "other",
      size: st.size,
      mtime_ms: st.mtimeMs,
      mode: st.mode,
    };
  }

  /**
   * 執行工具。第三參數 opts.grantedRoots（可選）：本次請求可用的「已在對話內同意的根」，
   * 併入 allowlist 與第二道防線的 allow 規則；硬 denylist／safety-check 不受影響。
   */
  async function executeTool(tool, args, opts) {
    const grantedRoots = opts && typeof opts === "object" ? opts.grantedRoots : undefined;
    switch (tool) {
      case "list_dir":
        return toolListDir(args, grantedRoots);
      case "read_file":
        return toolReadFile(args, grantedRoots);
      case "grep":
        return toolGrep(args, grantedRoots);
      case "stat":
        return toolStat(args, grantedRoots);
      default:
        throw new BridgeError("tool_not_allowed", 403, String(tool));
    }
  }

  return { executeTool, requireLocalPath, resolveReal, enforcePermission, toolListDir, toolReadFile, toolGrep, toolStat };
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
