// desktop/lib/permission-rules.js
//
// W6c 裝置橋「第二道防線」：**純函式**權限規則評估 + 硬 denylist（零 I/O、零狀態、
// 零 Electron 依賴，CommonJS，形態照 desktop/lib/policy.js）。
//
// 為什麼要有這一層（機制原則）：「gateway 與裝置橋各擋一次」。雲端閘道即使被 prompt
// injection 繞過、或規則被下發端篡改，本機仍以**同一份決策語義**獨立拒絕。唯一執法點
// 不得只放在雲端。
//
// 語義來源（逐項對齊，非自創）：
//   - 規則形式 `ToolName` / `ToolName(specifier)`、三桶 deny/ask/allow 首命中、
//     路徑前綴 `//` / `~/` / `/` / 無前綴、`/**`：Claude Code v2.1.88 源碼
//     `/tmp/teacher-repo/src/utils/permissions/permissionRuleParser.ts`、
//     `src/utils/permissions/filesystem.ts:patternWithRoot/matchSpecifier` 等。
//   - safetyCheck 清單：`src/utils/permissions/filesystem.ts:57-79`
//     DANGEROUS_FILES / DANGEROUS_DIRECTORIES（照抄）。
//   - 硬 denylist 是**我方自補**（Claude Code 並無全域硬編碼 denylist；其二進位那串
//     `Read(~/.ssh/**)` 是某內建 skill 的 disallowedTools，非全域預設——見記憶
//     `2026-10-04-claude-code-permission-model-anatomy.md` 第 37-41 行）。清單取本任務
//     spec 逐條落地：「任何模式都拒」。
//
// 判定序（與 gateway 那路逐項一致，固定不可調換）：
//   硬 denylist(一律 deny) → safety-check(一律 ask) → 規則 deny → 規則 ask
//   → 規則 allow → 模式語義 → 預設 ask
//
// 與 policy.js 的關係：**刻意不動 policy.js**。policy.js 的 isSensitivePath 是與雲端
// `device-bridge-policy.ts` 逐字對齊的單一真源（雲端向量表 device-bridge-policy.vectors.json
// 釘住），且被 local-worker.js / device-bridge-client.js / bridge-executor.js /
// bridge-protocol.js 四個 live 呼叫端使用。把 isSensitivePath 改成轉呼叫本檔的硬 denylist
// 會讓它比雲端語義更嚴（例：整個 `~/.config` 段、`*.pem` 任意位置），**改動既有呼叫端語義**，
// 故本模組獨立存在為「更嚴的第二道」，policy.js 一行不動（不得讓既有檢查變鬆）。

"use strict";

const posix = require("node:path").posix;
const os = require("node:os");

// ---------------------------------------------------------------------------
// 常數（單一真源）
// ---------------------------------------------------------------------------

/** 規則效果三桶。順序即判定優先序：deny → ask → allow。 */
const RULE_EFFECTS = Object.freeze(["deny", "ask", "allow"]);

/**
 * 權限模式（我方定義，非 Claude Code 的 default/acceptEdits/…；語義見本任務 spec）：
 *   off  — 一律拒
 *   ask  — 根內也問
 *   auto — 授權根內自動、根外問
 *   full — 家目錄內自動、家目錄外問（硬 denylist 仍拒）
 */
const PERMISSION_MODES = Object.freeze(["off", "ask", "auto", "full"]);

/** 決策理由（結構化，非自由字串；正對應 Claude PermissionDecisionReason 的精神）。 */
const REASONS = Object.freeze({
  HARD_DENY: "hard_deny",
  SAFETY_CHECK: "safety_check",
  RULE_DENY: "rule_deny",
  RULE_ASK: "rule_ask",
  RULE_ALLOW: "rule_allow",
  MODE_OFF: "mode_off",
  MODE_ASK: "mode_ask",
  MODE_AUTO: "mode_auto",
  MODE_FULL: "mode_full",
  DEFAULT_ASK: "default_ask",
  INVALID_MODE: "invalid_mode",
});

/** safety-check 檔案（bypass-immune，一律 ask）：清單照 Claude Code filesystem.ts:57-68。 */
const SAFETY_CHECK_FILES = Object.freeze([
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
  ".claude.json",
]);

/** safety-check 目錄（bypass-immune，一律 ask）：清單照 Claude Code filesystem.ts:74-79。 */
const SAFETY_CHECK_DIRS = Object.freeze([".git", ".vscode", ".idea", ".claude"]);

/**
 * 硬 denylist（**我方自補**，任何模式都拒、先於一切）：
 * 逐條附來源。`kind` 決定比對方式：
 *   home-dir       — 家目錄下的目錄本身與其下
 *   home-file      — 家目錄下精確檔名
 *   abs-file       — 檔案系統絕對精確路徑
 *   abs-glob       — 檔案系統絕對 glob（`*` 不跨 `/`）
 *   basename-glob  — 任意位置的 basename glob
 *   basename-exact — 任意位置的 basename 精確相等
 * 全部大小寫折疊（macOS/APFS 不敏感，避免 `.SSH` 繞過）。
 */
const HARD_DENY_PATTERNS = Object.freeze([
  // —— 憑證/金鑰目錄（家目錄下）——
  { pattern: "~/.ssh", kind: "home-dir", source: "spec 硬 denylist（SSH 私鑰）" },
  { pattern: "~/.aws", kind: "home-dir", source: "spec 硬 denylist（雲端憑證）" },
  { pattern: "~/.gnupg", kind: "home-dir", source: "spec 硬 denylist（GPG 私鑰）" },
  { pattern: "~/.kube", kind: "home-dir", source: "spec 硬 denylist（k8s 憑證）" },
  { pattern: "~/.docker", kind: "home-dir", source: "spec 硬 denylist（registry 憑證）" },
  { pattern: "~/.config", kind: "home-dir", source: "spec 硬 denylist（各 CLI 憑證/profile 集中地）" },
  { pattern: "~/.local/share/keyrings", kind: "home-dir", source: "spec 硬 denylist（GNOME keyring）" },
  // —— 憑證/歷史檔案（家目錄下）——
  { pattern: "~/.git-credentials", kind: "home-file", source: "spec 硬 denylist（git 明文憑證）" },
  { pattern: "~/.netrc", kind: "home-file", source: "spec 硬 denylist（curl/ftp 憑證）" },
  { pattern: "~/.pgpass", kind: "home-file", source: "spec 硬 denylist（PostgreSQL 密碼）" },
  { pattern: "~/.bash_history", kind: "home-file", source: "spec 硬 denylist（命令歷史含密文）" },
  // —— 系統檔案（絕對）——
  { pattern: "/etc/shadow", kind: "abs-file", source: "spec 硬 denylist（密碼雜湊）" },
  { pattern: "/etc/sudoers", kind: "abs-file", source: "spec 硬 denylist（提權設定）" },
  { pattern: "/proc/*/environ", kind: "abs-glob", source: "spec 硬 denylist（進程環境變數含 secret）" },
  // —— 檔名樣式（任意位置）——
  { pattern: "*.pem", kind: "basename-glob", source: "spec 硬 denylist（PEM 憑證）" },
  { pattern: "*.key", kind: "basename-glob", source: "spec 硬 denylist（私鑰）" },
  { pattern: "*.p12", kind: "basename-glob", source: "spec 硬 denylist（PKCS#12 憑證）" },
  { pattern: "id_rsa*", kind: "basename-glob", source: "spec 硬 denylist（RSA 私鑰）" },
  { pattern: "id_ed25519*", kind: "basename-glob", source: "spec 硬 denylist（Ed25519 私鑰）" },
  { pattern: "*credential*", kind: "basename-glob", source: "spec 硬 denylist（憑證檔名）" },
  { pattern: "*secret*", kind: "basename-glob", source: "spec 硬 denylist（密文檔名）" },
  { pattern: "*service-account*.json", kind: "basename-glob", source: "spec 硬 denylist（GCP service account）" },
  { pattern: ".env", kind: "basename-exact", source: "spec 硬 denylist（dotenv 密文）" },
  { pattern: ".env.*", kind: "basename-glob", source: "spec 硬 denylist（dotenv 變體）" },
]);

// ---------------------------------------------------------------------------
// 路徑正規化 / glob 工具（純函式）
// ---------------------------------------------------------------------------

/**
 * 正規化成比對用路徑：展開 `~`（需 home）、反斜線→`/`、一律小寫、posix 歸一化。
 * 相對路徑保持相對。無法處理（非字串/空/`~` 但無 home）→ null（呼叫端 fail-closed）。
 */
function toMatchPath(p, home) {
  if (typeof p !== "string") return null;
  let s = p.trim();
  if (s.length === 0) return null;
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) {
    if (typeof home !== "string" || home.trim().length === 0) return null;
    s = home.replace(/[\\/]+$/, "") + "/" + s.slice(s === "~" ? 1 : 2);
  }
  s = s.replace(/\\/g, "/").toLowerCase();
  const normalized = posix.normalize(s);
  if (normalized === "." || normalized.length === 0) return null;
  return normalized;
}

/** 單一字元 regex 轉義。 */
function escapeRegExpChar(c) {
  return c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * glob → regex 主體（未加錨點）。`**` 跨 `/`、`*` 不跨 `/`、`?` 單一非 `/`。
 * 輸入需已小寫、已把 `\` 轉 `/`。
 */
function globBody(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExpChar(c);
    }
  }
  return out;
}

/** glob 對整個字串的完全比對（basename 樣式用）。 */
function globMatches(glob, value) {
  return new RegExp(`^${globBody(glob)}$`).test(value);
}

/** target 是否落在 root 之內（含相等）；兩者皆需絕對、已小寫正規化。 */
function pathWithin(target, root) {
  if (typeof target !== "string" || typeof root !== "string") return false;
  if (!target.startsWith("/") || !root.startsWith("/")) return false;
  if (target === root) return true;
  return target.startsWith(root === "/" ? "/" : `${root}/`);
}

/**
 * 把規則 specifier 依前綴解析成 {root, rel}：
 *   `//path` → 檔案系統根絕對（root `/`）
 *   `~/path` → 家目錄
 *   `/path`  → 相對於設定來源（settingsRoot）
 *   無前綴 / `./x` → root null（任意位置）
 * root 為 null 表示不限定根，於任意深度比對。
 */
function resolveSpecifier(specifier, ctx) {
  const s = String(specifier).replace(/\\/g, "/").toLowerCase();
  if (s.startsWith("//")) return { root: "/", rel: s.slice(2) };
  if (s === "~" || s.startsWith("~/")) {
    const homeNorm = toMatchPath(ctx.home, null);
    // ~ 但無 home → fail-closed（不得退化為「任意位置」而意外放行/命中）
    if (homeNorm === null) return { invalid: true };
    return { root: homeNorm, rel: s === "~" ? "" : s.slice(2) };
  }
  if (s.startsWith("/")) {
    const rootNorm = toMatchPath(ctx.settingsRoot, null);
    if (rootNorm === null) return { invalid: true };
    return { root: rootNorm, rel: s.slice(1) };
  }
  const rel = s.startsWith("./") ? s.slice(2) : s;
  return { root: null, rel, anywhere: true };
}

/**
 * specifier 是否命中指定路徑。`/**`＝該目錄含其下；無 glob 的目錄/檔案樣式亦比對
 * 「本身與其下」（對齊 Claude ignore() 對裸路徑的語義）。
 */
function matchSpecifier(specifier, targetNorm, ctx) {
  if (typeof specifier !== "string" || specifier.length === 0) return false;
  if (typeof targetNorm !== "string") return false;
  const spec = resolveSpecifier(specifier, ctx);
  if (spec.invalid) return false;
  const { root, rel } = spec;
  if (typeof rel !== "string" || rel.length === 0) return false;

  let relTarget;
  if (spec.anywhere) {
    relTarget = targetNorm;
  } else {
    if (typeof root !== "string") return false;
    if (!pathWithin(targetNorm, root)) return false;
    relTarget = targetNorm === root ? "" : targetNorm.slice(root.length + (root === "/" ? 0 : 1));
    if (relTarget === "") return false;
  }

  let body;
  let suffix = "";
  if (rel.endsWith("/**")) {
    body = globBody(rel.slice(0, -3));
    suffix = "(?:/.*)?";
  } else if (!/[*?]/.test(rel)) {
    // 無 glob：比對本身與其下（Claude ignore() 對裸路徑語義）。
    body = globBody(rel);
    suffix = "(?:/.*)?";
  } else {
    body = globBody(rel);
  }

  const anywhere = spec.anywhere ? "(?:.*/)?" : "";
  return new RegExp(`^${anywhere}${body}${suffix}$`).test(relTarget);
}

// ---------------------------------------------------------------------------
// parseRule
// ---------------------------------------------------------------------------

/** 找第一個未轉義字元（前導反斜線數為偶數＝未轉義）。 */
function findFirstUnescaped(str, char) {
  for (let i = 0; i < str.length; i += 1) {
    if (str[i] !== char) continue;
    let n = 0;
    let j = i - 1;
    while (j >= 0 && str[j] === "\\") {
      n += 1;
      j -= 1;
    }
    if (n % 2 === 0) return i;
  }
  return -1;
}

/** 找最後一個未轉義字元。 */
function findLastUnescaped(str, char) {
  for (let i = str.length - 1; i >= 0; i -= 1) {
    if (str[i] !== char) continue;
    let n = 0;
    let j = i - 1;
    while (j >= 0 && str[j] === "\\") {
      n += 1;
      j -= 1;
    }
    if (n % 2 === 0) return i;
  }
  return -1;
}

/** 規則內容去轉義（照 Claude unescapeRuleContent 的反序）。 */
function unescapeContent(content) {
  return content.replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
}

/**
 * 解析規則字串。
 *
 * 語法：`[effect ":"] ToolName [ "(" specifier ")" ]`
 *   - effect 可省略；省略時回 effect:null，由呼叫端依桶別指派。
 *   - effect 若出現但不在 RULE_EFFECTS → 壞形式（回 null）。
 *   - `Tool()`／`Tool(*)` ≡ 工具級規則（specifier:null），照 Claude。
 *   - 任何括號不匹配、tool 名空、收尾後仍有殘字、空字串 → 回 null（壞形式）。
 *
 * @returns {{effect: "deny"|"ask"|"allow"|null, tool: string, specifier: string|null}|null}
 */
function parseRule(text) {
  if (typeof text !== "string") return null;
  let s = text.trim();
  if (s.length === 0) return null;

  let effect = null;
  const m = /^([A-Za-z]+):/.exec(s);
  if (m) {
    const cand = m[1].toLowerCase();
    if (!RULE_EFFECTS.includes(cand)) return null; // 非白名單 effect
    effect = cand;
    s = s.slice(m[0].length).trim();
    if (s.length === 0) return null;
  }

  const open = findFirstUnescaped(s, "(");
  if (open === -1) {
    if (s.includes("(") || s.includes(")")) return null; // 孤立括號
    const tool = s.trim();
    if (tool.length === 0) return null;
    return { effect, tool, specifier: null };
  }

  const close = findLastUnescaped(s, ")");
  if (close === -1 || close !== s.length - 1 || close <= open) return null;
  const tool = s.slice(0, open).trim();
  if (tool.length === 0) return null;
  const raw = s.slice(open + 1, close);
  if (raw === "" || raw === "*") return { effect, tool, specifier: null };
  const specifier = unescapeContent(raw);
  if (specifier.trim().length === 0) return null;
  return { effect, tool, specifier };
}

// ---------------------------------------------------------------------------
// 硬 denylist
// ---------------------------------------------------------------------------

function hardDenyMatchNorm(norm, homeNorm) {
  if (typeof norm !== "string" || norm.length === 0) return false;
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  for (const p of HARD_DENY_PATTERNS) {
    if (p.kind === "home-dir" || p.kind === "home-file") {
      if (typeof homeNorm !== "string") continue;
      const target = `${homeNorm}/${p.pattern.slice(2)}`;
      if (p.kind === "home-dir") {
        if (norm === target || norm.startsWith(`${target}/`)) return true;
      } else if (norm === target) {
        return true;
      }
    } else if (p.kind === "abs-file") {
      if (norm === p.pattern.toLowerCase()) return true;
    } else if (p.kind === "abs-glob") {
      if (globMatches(p.pattern.toLowerCase(), norm)) return true;
    } else if (p.kind === "basename-glob") {
      if (globMatches(p.pattern.toLowerCase(), base)) return true;
    } else if (p.kind === "basename-exact") {
      if (base === p.pattern.toLowerCase()) return true;
    }
  }
  return false;
}

/**
 * 是否命中硬 denylist（任何模式都拒、先於一切）。
 *
 * 呼叫端契約：**同時傳入原始路徑與 symlink 解析後路徑**，只要任一命中即拒；
 * 這正是「純字串判定跟不了 symlink」的補位（policy.js 註釋已載明）。
 * fail-closed：raw 非字串/空、`~` 無法展開、resolved 有給但不合法 → 一律視為命中。
 * resolved 未提供（如尚不存在的輸出路徑）→ 只比對 raw（由呼叫端負責補 realpath）。
 *
 * @param {{raw: string, resolved?: string|null, home?: string}} input
 * @param {string} [home] 預設 os.homedir()
 */
function isHardDenied(input, home = os.homedir()) {
  if (!input || typeof input !== "object") return true;
  const h = input.home !== undefined ? input.home : home;
  const raw = input.raw;
  if (typeof raw !== "string" || raw.trim().length === 0) return true;
  const rawNorm = toMatchPath(raw, h);
  if (rawNorm === null) return true; // fail-closed
  const homeNorm = typeof h === "string" && h.trim().length > 0 ? toMatchPath(h, null) : null;

  let hit = hardDenyMatchNorm(rawNorm, homeNorm);

  const { resolved } = input;
  if (resolved !== undefined && resolved !== null) {
    if (typeof resolved !== "string" || resolved.trim().length === 0) return true; // fail-closed
    const resNorm = toMatchPath(resolved, h);
    if (resNorm === null) return true; // fail-closed
    hit = hit || hardDenyMatchNorm(resNorm, homeNorm);
  }
  return hit;
}

// ---------------------------------------------------------------------------
// safety-check
// ---------------------------------------------------------------------------

/**
 * 是否為 safety-check 路徑（bypass-immune、一律 ask、先於規則）。
 * 檔名精確相等或任一路徑段為危險目錄即命中；大小寫折疊。
 * 亦接受 `{raw, resolved}`（任一命中即命中）。非字串/空 → fail-closed true（＝ask）。
 *
 * @param {string|{raw?: string, resolved?: string|null}} p
 */
function isSafetyCheckPath(p) {
  if (p && typeof p === "object") {
    return (
      (typeof p.raw === "string" && p.raw.trim().length > 0 && isSafetyCheckPath(p.raw)) ||
      (typeof p.resolved === "string" && p.resolved.trim().length > 0 && isSafetyCheckPath(p.resolved))
    );
  }
  if (typeof p !== "string" || p.trim().length === 0) return true; // fail-closed
  const segs = p
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
  if (segs.length === 0) return true;
  const base = segs[segs.length - 1];
  if (SAFETY_CHECK_FILES.includes(base)) return true;
  for (const seg of segs) {
    if (SAFETY_CHECK_DIRS.includes(seg)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// evaluatePermission
// ---------------------------------------------------------------------------

/** 把 rules（陣列或 {deny,ask,allow} 物件）正規化成三桶 parsed 規則。 */
function normalizeRules(rules) {
  const buckets = { deny: [], ask: [], allow: [] };
  if (rules === null || rules === undefined) return buckets;
  if (Array.isArray(rules)) {
    for (const entry of rules) {
      const parsed = parseRule(entry);
      // 扁平陣列必須自帶 effect；無 effect 者不套用（不猜測、不意外放行）。
      if (!parsed || !parsed.tool || !parsed.effect) continue;
      buckets[parsed.effect].push(parsed);
    }
    return buckets;
  }
  if (typeof rules === "object") {
    for (const effect of RULE_EFFECTS) {
      const list = rules[effect];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const parsed = parseRule(entry);
        if (!parsed || !parsed.tool) continue;
        // 物件桶別為準（entry 內若自帶 effect 一律以桶為準）。
        buckets[effect].push({ effect, tool: parsed.tool, specifier: parsed.specifier });
      }
    }
  }
  return buckets;
}

/** 正規化授權根：絕對、非檔案系統根、非硬 denylist 根，去重。 */
function normalizeRoots(roots, home) {
  if (!Array.isArray(roots)) return [];
  const out = [];
  for (const r of roots) {
    if (typeof r !== "string") continue;
    const n = toMatchPath(r, home);
    if (!n || !n.startsWith("/")) continue;
    if (n === "/") continue; // 過寬根不授權
    if (isHardDenied({ raw: n, resolved: n, home }, home)) continue; // 敏感根不授權
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * 權限決策（與 gateway 同一條判定序，逐項一致）：
 *   硬 denylist → safety-check → 規則 deny → 規則 ask → 規則 allow → 模式語義 → 預設 ask
 *
 * 規則的 deny/ask 對「原始路徑與 resolved 路徑」任一命中即命中（fail-closed）；
 * 規則的 allow 與模式的自動放行要求**所有**提供的路徑皆命中（防 symlink 走私出根）。
 *
 * @param {object} opts
 * @param {string} opts.tool
 * @param {string} opts.rawPath
 * @param {string} [opts.resolvedPath]
 * @param {"off"|"ask"|"auto"|"full"} [opts.mode] 預設 "ask"
 * @param {string[]|{deny?:string[],ask?:string[],allow?:string[]}} [opts.rules]
 * @param {string[]} [opts.authorizedRoots]
 * @param {string} [opts.home] 預設 os.homedir()
 * @param {string} [opts.settingsRoot] 單斜線 `/path` 的設定來源根；預設 process.cwd()
 * @returns {{decision: "allow"|"deny"|"ask", reason: string, rule?: object}}
 */
function evaluatePermission(opts = {}) {
  const home = opts.home !== undefined ? opts.home : os.homedir();
  const settingsRoot = opts.settingsRoot !== undefined ? opts.settingsRoot : process.cwd();
  const ctx = { home, settingsRoot };
  const tool = opts.tool;
  const rawPath = opts.rawPath;
  const resolvedPath = opts.resolvedPath;

  const mode = opts.mode === undefined || opts.mode === null ? "ask" : opts.mode;
  if (typeof mode !== "string" || !PERMISSION_MODES.includes(mode)) {
    return { decision: "deny", reason: REASONS.INVALID_MODE };
  }

  // 1. 硬 denylist（一律 deny，先於一切）
  if (isHardDenied({ raw: rawPath, resolved: resolvedPath, home }, home)) {
    return { decision: "deny", reason: REASONS.HARD_DENY };
  }

  // 2. safety-check 檔案（一律 ask，先於規則）
  if (
    (typeof rawPath === "string" && rawPath.trim().length > 0 && isSafetyCheckPath(rawPath)) ||
    (typeof resolvedPath === "string" && resolvedPath.trim().length > 0 && isSafetyCheckPath(resolvedPath))
  ) {
    return { decision: "ask", reason: REASONS.SAFETY_CHECK };
  }

  // 建立比對用候選路徑（原始 + resolved）
  const candidates = [];
  const rawNorm = typeof rawPath === "string" && rawPath.trim().length > 0 ? toMatchPath(rawPath, home) : null;
  const resNorm =
    typeof resolvedPath === "string" && resolvedPath.trim().length > 0 ? toMatchPath(resolvedPath, home) : null;
  if (rawNorm !== null) candidates.push(rawNorm);
  if (resNorm !== null) candidates.push(resNorm);
  if (candidates.length === 0) return { decision: "deny", reason: REASONS.HARD_DENY };

  const rules = normalizeRules(opts.rules);

  // 3. 規則 deny（任一候選命中即命中）
  for (const rule of rules.deny) {
    if (rule.tool !== tool) continue;
    if (candidates.some((c) => matchSpecifier(rule.specifier, c, ctx))) {
      return { decision: "deny", reason: REASONS.RULE_DENY, rule: { ...rule } };
    }
  }

  // 4. 規則 ask
  for (const rule of rules.ask) {
    if (rule.tool !== tool) continue;
    if (candidates.some((c) => matchSpecifier(rule.specifier, c, ctx))) {
      return { decision: "ask", reason: REASONS.RULE_ASK, rule: { ...rule } };
    }
  }

  // 5. 規則 allow（所有候選皆命中才放行）
  for (const rule of rules.allow) {
    if (rule.tool !== tool) continue;
    if (candidates.length > 0 && candidates.every((c) => matchSpecifier(rule.specifier, c, ctx))) {
      return { decision: "allow", reason: REASONS.RULE_ALLOW, rule: { ...rule } };
    }
  }

  // 6. 模式語義
  if (mode === "off") return { decision: "deny", reason: REASONS.MODE_OFF };
  if (mode === "ask") return { decision: "ask", reason: REASONS.MODE_ASK };

  if (mode === "auto") {
    const roots = normalizeRoots(opts.authorizedRoots, home);
    const inside = candidates.length > 0 && candidates.every((c) => roots.some((r) => pathWithin(c, r)));
    if (inside) return { decision: "allow", reason: REASONS.MODE_AUTO };
    return { decision: "ask", reason: REASONS.DEFAULT_ASK };
  }

  // mode === "full"（家目錄內自動；硬 denylist 已於第 1 步先拒）
  const homeNorm = typeof home === "string" && home.trim().length > 0 ? toMatchPath(home, null) : null;
  const withinHome =
    homeNorm !== null && candidates.length > 0 && candidates.every((c) => pathWithin(c, homeNorm));
  if (withinHome) return { decision: "allow", reason: REASONS.MODE_FULL };
  return { decision: "ask", reason: REASONS.DEFAULT_ASK };
}

// ---------------------------------------------------------------------------
// suggestRoot
// ---------------------------------------------------------------------------

/**
 * 建議授權的最接近目錄（供授權卡「允許此目錄」使用）。
 *
 * 契約：把輸入當作「被要求的檔案」，回其所在目錄；**不得**回過寬根
 * （`/`、`~`、`/home`、家目錄本身、家目錄祖先、單層目錄、硬 denylist / safety-check 目錄），
 * 這種情況一律回 null，由呼叫端改為要求單檔授權。
 *
 * @param {string} resolvedPath 已 realpath 的絕對路徑
 * @param {{home?: string}} [opts]
 * @returns {string|null} 正規化後的絕對目錄，或 null
 */
function suggestRoot(resolvedPath, opts = {}) {
  const home = opts.home !== undefined ? opts.home : os.homedir();
  if (typeof resolvedPath !== "string") return null;
  // 保留原始大小寫（供顯示/落盤授權用），比對另以低階正規化路徑為準。
  let s = resolvedPath.trim();
  if (s.length === 0) return null;
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) {
    if (typeof home !== "string" || home.trim().length === 0) return null;
    s = home.replace(/[\\/]+$/, "") + "/" + s.slice(s === "~" ? 1 : 2);
  }
  s = s.replace(/\\/g, "/");
  const display = posix.normalize(s);
  if (!display.startsWith("/") || display === "/") return null;
  const parentDisplay = posix.dirname(display);
  if (!parentDisplay || parentDisplay === "/" || !parentDisplay.startsWith("/")) return null;

  const low = parentDisplay.toLowerCase();
  const segs = low.split("/").filter((x) => x.length > 0);
  if (segs.length < 2) return null; // /home、/tmp、/etc … 單層＝過寬

  const homeNorm = typeof home === "string" && home.trim().length > 0 ? toMatchPath(home, null) : null;
  if (homeNorm !== null) {
    if (low === homeNorm) return null; // 家目錄本身過寬
    if (homeNorm.startsWith(`${low}/`)) return null; // parent 是家目錄祖先（如 /home、/Users）
  }
  if (isHardDenied({ raw: parentDisplay, resolved: parentDisplay, home }, home)) return null;
  if (isSafetyCheckPath(parentDisplay)) return null;
  return parentDisplay;
}

module.exports = {
  RULE_EFFECTS,
  PERMISSION_MODES,
  REASONS,
  HARD_DENY_PATTERNS,
  SAFETY_CHECK_FILES,
  SAFETY_CHECK_DIRS,
  parseRule,
  isHardDenied,
  isSafetyCheckPath,
  evaluatePermission,
  suggestRoot,
  // 低階工具導出供測試與跨模組複用（不改變語義）
  _internals: { toMatchPath, globMatches, matchSpecifier, pathWithin },
};