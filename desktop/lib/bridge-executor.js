// desktop/lib/bridge-executor.js
//
// W6b：device bridge 的「四个唯读工具执行器」——自 device-bridge-client.js 抽出的
// 可测模组（纯逻辑 + **注入 fs**）。device-bridge-client.js 只负责连线与编排
// （register/heartbeat/poll/result）；真正的档案存取与安全闸全收敛在本档，故危险
// 路径可被 node:test 直接执行（device-bridge-client.js 的旧版执行器零测试）。
//
// 安全边界（与 local-worker.js 同语义，单一授权来源）：
//  1. 工具白名单＝list_dir/read_file/grep/stat（无写/删/执行）。
//  2. 路径先 realpath 解 symlink，再过 policy.isSensitivePath（denylist，扫所有路径段）。
//  3. allowlist **必填**：授权根为空集 ⇒ 一律拒（no_authorized_roots）。授权来源与
//     local-worker.js 是**同一份** authorizedRoots（使用者由 pickFiles 显式挑选的根），
//     不另造第二套授权机制。空集**不得**退回「只验 denylist」。
//  4. 拒绝档案系统根路径（path_is_root），避免整盘扫描。
//  5. grep 逐档先 stat 再决定是否读取；单档上限 = min(云端下发 max_file_bytes,
//     本机 MAX_GREP_FILE_BYTES)，超过者**跳过并计数**（避免整档入记忆体）。
//  6. grep/list_dir 自报 `sensitive_path_touched`／`excluded_sensitive_count`（H2 契约：
//     递回/列举碰到敏感段即计数；云端 sensitiveResultProblem 据此整笔拒绝）。
//
// 注入介面（测试可替换）：fs 需提供 realpathSync(.native)、existsSync、statSync、
// readdirSync、readFileSync、openSync/readSync/closeSync；roots 为回传授权根阵列的
// 函式（或直接给阵列）。

"use strict";

const path = require("node:path");
const os = require("node:os");
const nodeFs = require("node:fs");
const policy = require("./policy.js");
const proto = require("./bridge-protocol.js");
// 第二道防线（W6c）：本机独立复核的权限决策（硬 denylist／safety-check／规则／模式）。
// 与 gateway 同一条判定序（见 permission-rules.js 档头）；本档只负责在**执行前**
// 以本机自身状态（模式／规则／授权根／home）再判一次，云端被绕过也挡得住。
const permissionRules = require("./permission-rules.js");

const MAX_LIST_DEFAULT = 200;
const MAX_GREP_FILES = 5000;
const MAX_GREP_DEPTH = 12;
/**
 * 单档读取上限（grep 逐档）：超过即跳过，避免整档入记忆体。
 * 本机自有天花板**不得比云端契约宽松**：等于 `proto.MAX_FILE_READ_BYTES`（1MB），
 * 且执行时取 `min(args.max_file_bytes, 本值)`——云端下发更小值时以云端值为准，
 * 下发更大值（或直接呼叫执行器绕过净化）时一律被本值夹住。
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

/** 是否为档案系统根（POSIX "/"、Windows "C:\"）。根必拒，禁整盘扫描。 */
function isFsRoot(abs) {
  if (typeof abs !== "string" || abs.length === 0) return false;
  return path.parse(abs).root === abs;
}

/**
 * 建立一个执行器实例。
 *
 * 第二道防线注入点（形状同 roots，可传值或函式；值注入须为字串/阵列）：
 *   - `mode`  当前权限模式（"off"|"ask"|"auto"|"full"）。未提供时回退 `"auto"`
 *     （升级前行为：授权根内自动；硬 denylist／safety-check 仍生效），刻意**不**
 *     改用 `"ask"` 以免让未接权限模式的既有呼叫端全部变成待授权。
 *   - `rules` 规则集（阵列或 {deny,ask,allow} 物件）。
 *   - `home`  家目录（仅供硬 denylist 展开 `~`／mode=full 判定）。
 *
 * @param {{fs?: object, roots?: string[]|(() => string[]), mode?: string|(() => string), rules?: unknown|(() => unknown), home?: string|(() => string)}} [options]
 */
function createBridgeExecutor(options = {}) {
  const fs = options.fs || nodeFs;
  const rootsProvider =
    typeof options.roots === "function"
      ? options.roots
      : () => (Array.isArray(options.roots) ? options.roots : []);
  // 注入点一律验型别（教训：跨界传错型别会被下游守卫静默降级，只失效不报错）。
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

  /** 当前家目录（未注入＝os.homedir()）。 */
  const currentHome = () => {
    const h = homeProvider();
    return typeof h === "string" && h.length > 0 ? h : os.homedir();
  };

  // ── 对话内就地授权（consent）的「已同意根」支持 ─────────────────────────
  // 云端在对话中取得使用者同意（once/session/permanent）后，会在其后每次 invoke
  // 随 DeviceRequestMessage.consent 重送（幂等）。装置端第二道防线只看自己的
  // mode/rules/roots，**不知道**云端刚发生的授权 ⇒ mode=ask 下永远回 needs_authorization
  // （实机缺陷）。修法：把本次请求的 grantedRoots 并入（a）allowlist 与（b）有效规则
  // 的 allow 桶；硬 denylist／safety-check 仍在最前，grantedRoots **不得**绕过。
  //
  // fail-closed：grantedRoots 非阵列／元素非非空字串 → 该元素略过（不当空阵列清空既有授权）。

  /** 正规化 grantedRoots：仅保留非空字串、去重（undefined／型别错＝空）。 */
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

  /** 有效 allowlist ＝ rootsProvider() ∪ grantedRoots（顺序保留 roots 在前，维持既有断言）。 */
  function effectiveRoots(grantedRoots) {
    const base = rootsProvider();
    const arr = Array.isArray(base) ? base.slice() : [];
    for (const g of normalizeGrantedRoots(grantedRoots)) {
      if (!arr.includes(g)) arr.push(g);
    }
    return arr;
  }

  /** 有效规则 ＝ 既有 rules ∪ grantedRoots.map(allowRuleForRoot)（物件或阵列型皆支援）。 */
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

  /** 解 symlink；不存在时对父目录解 symlink 再接回 basename（输出档常用）。 */
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
   * 第二道防线：以本机自身状态（模式／规则／授权根／home）独立复核。
   * 判定序全部来自 permission-rules.evaluatePermission（硬 denylist → safety-check
   * → 规则 deny/ask/allow → 模式 → 预设 ask）。云端即使被绕过或规则被篡改，这里仍
   * 以同一语义拒绝。不执行时的错误码（供 gateway 流程对上）：
   *   - deny → `permission_denied`（403）
   *   - ask  → `needs_authorization`（403，对上冻结契约的授权流程）
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
   * 硬 denylist 复核（模式／规则无关，一律拒）：供列举／递回剪枝使用。
   * 档名样式（`*.pem`、`.env`…）在 policy denylist 之外，这里补上，避免
   * grep/list_dir 在授权根内把硬 denylist 档名曝露或读入。
   */
  function isHardDeniedPath(p) {
    return permissionRules.isHardDenied({ raw: p, resolved: p, home: currentHome() }, currentHome());
  }

  /**
   * 检查路径已授权且非敏感；回传其 realpath。
   * 顺序：bad_path → 根拒绝 → policy denylist → allowlist（空集＝全拒）
   *       → 第二道防线（permission-rules）→ 存在性。
   * 既有检查（policy denylist／allowlist 必填）在前且一行不放宽；第二道防线为纯加严。
   */
  function requireLocalPath(raw, tool = "read_file", grantedRoots) {
    if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0")) {
      throw new BridgeError("bad_path", 400);
    }
    const abs = resolveReal(raw);
    if (isFsRoot(abs)) throw new BridgeError("path_is_root", 403, abs);
    // 解 symlink 后再跑 denylist —— policy 是字串判定，跟不了 symlink（同 local-worker）。
    if (policy.isSensitivePath(abs)) throw new BridgeError("sensitive_path", 403);
    // 有效 allowlist ＝ rootsProvider() ∪ grantedRoots（对话内已同意的根）。
    const roots = effectiveRoots(grantedRoots);
    if (roots.length === 0) {
      // H1：allowlist 必填。空集＝全拒，不得退回「只验 denylist」。
      throw new BridgeError("no_authorized_roots", 403);
    }
    if (!policy.isPathAllowed(abs, roots)) throw new BridgeError("not_authorized", 403);
    // 第二道防线（执行前独立复核）：以本机真值判 deny/ask/allow；grantedRoots 产生
    // allow 规则，使「已同意」的根走 rule_allow 放行（未同意者仍 needs_authorization）。
    enforcePermission(tool, raw, abs, grantedRoots);
    if (!fs.existsSync(abs)) throw new BridgeError("not_found", 404);
    return abs;
  }

  // ── 四个唯读工具（无写/删/执行）────────────────────────────────────────

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
      // 敏感档名/目录名不进回传（与 grep 递回剪枝同语义）；计数后回报给云端。
      // 第二道防线补位：policy 之外的硬 denylist 档名（`*.pem`、`.env`…）同样不曝露。
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
        /* 权限/竞态：略过后设栏位 */
      }
      const type = d.isDirectory() ? "dir" : d.isSymbolicLink() ? "symlink" : d.isFile() ? "file" : "other";
      entries.push({ name: d.name, type, size, mtime_ms: mtimeMs });
    }
    return {
      path: abs,
      entries,
      count: entries.length,
      // H2 契约面第二层：装置自报递回/列举时是否碰到敏感段（云端据此整笔拒绝）。
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
   * 递回收集档案。敏感段（含目录）直接剪枝：不进收集、也不读取，并累计
   * `stats.excludedSensitive`（云端据此判定装置是否碰到敏感段）。
   * 不跟 symlink（防逃逸）；上限 GREP_MAX_FILES 档、GREP_MAX_DEPTH 层。
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
        stats.excludedSensitive += 1; // 敏感段剪枝（H2：敏感档被排除）
        continue;
      }
      let s;
      try {
        s = fs.statSync(full);
      } catch {
        continue; // 略过无法 stat 的项
      }
      collectFiles(full, s, out, depth + 1, maxDepth, stats);
    }
  }

  function toolGrep(args, grantedRoots) {
    const abs = requireLocalPath(args.path, "grep", grantedRoots);
    const st = fs.statSync(abs);
    if (!st.isDirectory() && !st.isFile()) throw new BridgeError("not_searchable", 400);
    const maxMatches = Number.isInteger(args.max_matches) ? args.max_matches : 100;
    // H2 输入侧契约：逐档读入上限 = min(云端下发 max_file_bytes, 本机上限)。
    const maxFileBytes =
      Number.isInteger(args.max_file_bytes) && args.max_file_bytes > 0
        ? Math.min(args.max_file_bytes, MAX_GREP_FILE_BYTES)
        : MAX_GREP_FILE_BYTES;
    let re = null;
    try {
      re = new RegExp(args.pattern);
    } catch {
      re = null; // 非法正则 → 退回字面 contains
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
      // M3：先 stat 再决定是否读取；超过单档上限即跳过并计数（不整档入记忆体）。
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
      // H2 契约面第二层：自报递回时是否碰到敏感段（云端 sensitiveResultProblem 据此整笔拒）。
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
   * 执行工具。第三参数 opts.grantedRoots（可选）：本次请求可用的「已在对话内同意的根」，
   * 并入 allowlist 与第二道防线的 allow 规则；硬 denylist／safety-check 不受影响。
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
