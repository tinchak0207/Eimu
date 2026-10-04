// desktop/lib/permission-rules.js
//
// W6c 装置桥「第二道防线」：**纯函式**权限规则评估 + 硬 denylist（零 I/O、零状态、
// 零 Electron 依赖，CommonJS，形态照 desktop/lib/policy.js）。
//
// 为什么要有这一层（机制原则）：「gateway 与装置桥各挡一次」。云端闸道即使被 prompt
// injection 绕过、或规则被下发端篡改，本机仍以**同一份决策语义**独立拒绝。唯一执法点
// 不得只放在云端。
//
// 语义来源（逐项对齐，非自创）：
//   - 规则形式 `ToolName` / `ToolName(specifier)`、三桶 deny/ask/allow 首命中、
//     路径前缀 `//` / `~/` / `/` / 无前缀、`/**`：Claude Code v2.1.88 源码
//     `/tmp/teacher-repo/src/utils/permissions/permissionRuleParser.ts`、
//     `src/utils/permissions/filesystem.ts:patternWithRoot/matchSpecifier` 等。
//   - safetyCheck 清单：`src/utils/permissions/filesystem.ts:57-79`
//     DANGEROUS_FILES / DANGEROUS_DIRECTORIES（照抄）。
//   - 硬 denylist 是**我方自补**（Claude Code 并无全域硬编码 denylist；其二进位那串
//     `Read(~/.ssh/**)` 是某内建 skill 的 disallowedTools，非全域预设——见记忆
//     `2026-10-04-claude-code-permission-model-anatomy.md` 第 37-41 行）。清单取本任务
//     spec 逐条落地：「任何模式都拒」。
//
// 判定序（与 gateway 那路逐项一致，固定不可调换）：
//   硬 denylist(一律 deny) → safety-check(一律 ask) → 规则 deny → 规则 ask
//   → 规则 allow → 模式语义 → 预设 ask
//
// 与 policy.js 的关系：**刻意不动 policy.js**。policy.js 的 isSensitivePath 是与云端
// `device-bridge-policy.ts` 逐字对齐的单一真源（云端向量表 device-bridge-policy.vectors.json
// 钉住），且被 local-worker.js / device-bridge-client.js / bridge-executor.js /
// bridge-protocol.js 四个 live 呼叫端使用。把 isSensitivePath 改成转呼叫本档的硬 denylist
// 会让它比云端语义更严（例：整个 `~/.config` 段、`*.pem` 任意位置），**改动既有呼叫端语义**，
// 故本模组独立存在为「更严的第二道」，policy.js 一行不动（不得让既有检查变松）。

"use strict";

const posix = require("node:path").posix;
const os = require("node:os");

// ---------------------------------------------------------------------------
// 常数（单一真源）
// ---------------------------------------------------------------------------

/** 规则效果三桶。顺序即判定优先序：deny → ask → allow。 */
const RULE_EFFECTS = Object.freeze(["deny", "ask", "allow"]);

/**
 * 权限模式（我方定义，非 Claude Code 的 default/acceptEdits/…；语义见本任务 spec）：
 *   off  — 一律拒
 *   ask  — 根内也问
 *   auto — 授权根内自动、根外问
 *   full — 家目录内自动、家目录外问（硬 denylist 仍拒）
 */
const PERMISSION_MODES = Object.freeze(["off", "ask", "auto", "full"]);

/** 决策理由（结构化，非自由字串；正对应 Claude PermissionDecisionReason 的精神）。 */
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

/** safety-check 档案（bypass-immune，一律 ask）：清单照 Claude Code filesystem.ts:57-68。 */
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

/** safety-check 目录（bypass-immune，一律 ask）：清单照 Claude Code filesystem.ts:74-79。 */
const SAFETY_CHECK_DIRS = Object.freeze([".git", ".vscode", ".idea", ".claude"]);

/**
 * 硬 denylist（**我方自补**，任何模式都拒、先于一切）：
 * 逐条附来源。`kind` 决定比对方式：
 *   home-dir       — 家目录下的目录本身与其下
 *   home-file      — 家目录下精确档名
 *   abs-file       — 档案系统绝对精确路径
 *   abs-glob       — 档案系统绝对 glob（`*` 不跨 `/`）
 *   basename-glob  — 任意位置的 basename glob
 *   basename-exact — 任意位置的 basename 精确相等
 * 全部大小写折叠（macOS/APFS 不敏感，避免 `.SSH` 绕过）。
 */
const HARD_DENY_PATTERNS = Object.freeze([
  // —— 凭证/金钥目录（家目录下）——
  { pattern: "~/.ssh", kind: "home-dir", source: "spec 硬 denylist（SSH 私钥）" },
  { pattern: "~/.aws", kind: "home-dir", source: "spec 硬 denylist（云端凭证）" },
  { pattern: "~/.gnupg", kind: "home-dir", source: "spec 硬 denylist（GPG 私钥）" },
  { pattern: "~/.kube", kind: "home-dir", source: "spec 硬 denylist（k8s 凭证）" },
  { pattern: "~/.docker", kind: "home-dir", source: "spec 硬 denylist（registry 凭证）" },
  { pattern: "~/.config", kind: "home-dir", source: "spec 硬 denylist（各 CLI 凭证/profile 集中地）" },
  { pattern: "~/.local/share/keyrings", kind: "home-dir", source: "spec 硬 denylist（GNOME keyring）" },
  // —— 凭证/历史档案（家目录下）——
  { pattern: "~/.git-credentials", kind: "home-file", source: "spec 硬 denylist（git 明文凭证）" },
  { pattern: "~/.netrc", kind: "home-file", source: "spec 硬 denylist（curl/ftp 凭证）" },
  { pattern: "~/.pgpass", kind: "home-file", source: "spec 硬 denylist（PostgreSQL 密码）" },
  { pattern: "~/.bash_history", kind: "home-file", source: "spec 硬 denylist（命令历史含密文）" },
  // —— 系统档案（绝对）——
  { pattern: "/etc/shadow", kind: "abs-file", source: "spec 硬 denylist（密码杂凑）" },
  { pattern: "/etc/sudoers", kind: "abs-file", source: "spec 硬 denylist（提权设定）" },
  { pattern: "/proc/*/environ", kind: "abs-glob", source: "spec 硬 denylist（进程环境变数含 secret）" },
  // —— 档名样式（任意位置）——
  { pattern: "*.pem", kind: "basename-glob", source: "spec 硬 denylist（PEM 凭证）" },
  { pattern: "*.key", kind: "basename-glob", source: "spec 硬 denylist（私钥）" },
  { pattern: "*.p12", kind: "basename-glob", source: "spec 硬 denylist（PKCS#12 凭证）" },
  { pattern: "id_rsa*", kind: "basename-glob", source: "spec 硬 denylist（RSA 私钥）" },
  { pattern: "id_ed25519*", kind: "basename-glob", source: "spec 硬 denylist（Ed25519 私钥）" },
  { pattern: "*credential*", kind: "basename-glob", source: "spec 硬 denylist（凭证档名）" },
  { pattern: "*secret*", kind: "basename-glob", source: "spec 硬 denylist（密文档名）" },
  { pattern: "*service-account*.json", kind: "basename-glob", source: "spec 硬 denylist（GCP service account）" },
  { pattern: ".env", kind: "basename-exact", source: "spec 硬 denylist（dotenv 密文）" },
  { pattern: ".env.*", kind: "basename-glob", source: "spec 硬 denylist（dotenv 变体）" },
]);

// ---------------------------------------------------------------------------
// 路径正规化 / glob 工具（纯函式）
// ---------------------------------------------------------------------------

/**
 * 正规化成比对用路径：展开 `~`（需 home）、反斜线→`/`、一律小写、posix 归一化。
 * 相对路径保持相对。无法处理（非字串/空/`~` 但无 home）→ null（呼叫端 fail-closed）。
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

/** 单一字元 regex 转义。 */
function escapeRegExpChar(c) {
  return c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * glob → regex 主体（未加锚点）。`**` 跨 `/`、`*` 不跨 `/`、`?` 单一非 `/`。
 * 输入需已小写、已把 `\` 转 `/`。
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

/** glob 对整个字串的完全比对（basename 样式用）。 */
function globMatches(glob, value) {
  return new RegExp(`^${globBody(glob)}$`).test(value);
}

/** target 是否落在 root 之内（含相等）；两者皆需绝对、已小写正规化。 */
function pathWithin(target, root) {
  if (typeof target !== "string" || typeof root !== "string") return false;
  if (!target.startsWith("/") || !root.startsWith("/")) return false;
  if (target === root) return true;
  return target.startsWith(root === "/" ? "/" : `${root}/`);
}

/**
 * 把规则 specifier 依前缀解析成 {root, rel}：
 *   `//path` → 档案系统根绝对（root `/`）
 *   `~/path` → 家目录
 *   `/path`  → 相对于设定来源（settingsRoot）
 *   无前缀 / `./x` → root null（任意位置）
 * root 为 null 表示不限定根，于任意深度比对。
 */
function resolveSpecifier(specifier, ctx) {
  const s = String(specifier).replace(/\\/g, "/").toLowerCase();
  if (s.startsWith("//")) return { root: "/", rel: s.slice(2) };
  if (s === "~" || s.startsWith("~/")) {
    const homeNorm = toMatchPath(ctx.home, null);
    // ~ 但无 home → fail-closed（不得退化为「任意位置」而意外放行/命中）
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
 * specifier 是否命中指定路径。`/**`＝该目录含其下；无 glob 的目录/档案样式亦比对
 * 「本身与其下」（对齐 Claude ignore() 对裸路径的语义）。
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
    // 无 glob：比对本身与其下（Claude ignore() 对裸路径语义）。
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

/** 找第一个未转义字元（前导反斜线数为偶数＝未转义）。 */
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

/** 找最后一个未转义字元。 */
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

/** 规则内容去转义（照 Claude unescapeRuleContent 的反序）。 */
function unescapeContent(content) {
  return content.replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
}

/**
 * 解析规则字串。
 *
 * 语法：`[effect ":"] ToolName [ "(" specifier ")" ]`
 *   - effect 可省略；省略时回 effect:null，由呼叫端依桶别指派。
 *   - effect 若出现但不在 RULE_EFFECTS → 坏形式（回 null）。
 *   - `Tool()`／`Tool(*)` ≡ 工具级规则（specifier:null），照 Claude。
 *   - 任何括号不匹配、tool 名空、收尾后仍有残字、空字串 → 回 null（坏形式）。
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
    if (!RULE_EFFECTS.includes(cand)) return null; // 非白名单 effect
    effect = cand;
    s = s.slice(m[0].length).trim();
    if (s.length === 0) return null;
  }

  const open = findFirstUnescaped(s, "(");
  if (open === -1) {
    if (s.includes("(") || s.includes(")")) return null; // 孤立括号
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
 * 是否命中硬 denylist（任何模式都拒、先于一切）。
 *
 * 呼叫端契约：**同时传入原始路径与 symlink 解析后路径**，只要任一命中即拒；
 * 这正是「纯字串判定跟不了 symlink」的补位（policy.js 注释已载明）。
 * fail-closed：raw 非字串/空、`~` 无法展开、resolved 有给但不合法 → 一律视为命中。
 * resolved 未提供（如尚不存在的输出路径）→ 只比对 raw（由呼叫端负责补 realpath）。
 *
 * @param {{raw: string, resolved?: string|null, home?: string}} input
 * @param {string} [home] 预设 os.homedir()
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
 * 是否为 safety-check 路径（bypass-immune、一律 ask、先于规则）。
 * 档名精确相等或任一路径段为危险目录即命中；大小写折叠。
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

/** 把 rules（阵列或 {deny,ask,allow} 物件）正规化成三桶 parsed 规则。 */
function normalizeRules(rules) {
  const buckets = { deny: [], ask: [], allow: [] };
  if (rules === null || rules === undefined) return buckets;
  // 已解析的规则物件（`{effect, tool, specifier}`）：直接采用（供装置端把
  // allowRuleForRoot 的物件规则并入既有规则集，与闸道 PermissionRule 同形）。
  const pushObject = (entry) => {
    if (!entry || typeof entry !== "object") return;
    if (typeof entry.tool !== "string" || entry.tool.length === 0) return;
    if (!RULE_EFFECTS.includes(entry.effect)) return;
    let specifier = null;
    if (entry.specifier !== undefined && entry.specifier !== null) {
      if (typeof entry.specifier !== "string" || entry.specifier.length === 0) return;
      specifier = entry.specifier;
    }
    buckets[entry.effect].push({ effect: entry.effect, tool: entry.tool, specifier });
  };
  if (Array.isArray(rules)) {
    for (const entry of rules) {
      if (entry && typeof entry === "object") {
        pushObject(entry);
        continue;
      }
      const parsed = parseRule(entry);
      // 扁平阵列必须自带 effect；无 effect 者不套用（不猜测、不意外放行）。
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
        if (entry && typeof entry === "object") {
          pushObject({ ...entry, effect });
          continue;
        }
        const parsed = parseRule(entry);
        if (!parsed || !parsed.tool) continue;
        // 物件桶别为准（entry 内若自带 effect 一律以桶为准）。
        buckets[effect].push({ effect, tool: parsed.tool, specifier: parsed.specifier });
      }
    }
  }
  return buckets;
}

/** 正规化授权根：绝对、非档案系统根、非硬 denylist 根，去重。 */
function normalizeRoots(roots, home) {
  if (!Array.isArray(roots)) return [];
  const out = [];
  for (const r of roots) {
    if (typeof r !== "string") continue;
    const n = toMatchPath(r, home);
    if (!n || !n.startsWith("/")) continue;
    if (n === "/") continue; // 过宽根不授权
    if (isHardDenied({ raw: n, resolved: n, home }, home)) continue; // 敏感根不授权
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * 权限决策（与 gateway 同一条判定序，逐项一致）：
 *   硬 denylist → safety-check → 规则 deny → 规则 ask → 规则 allow → 模式语义 → 预设 ask
 *
 * 规则的 deny/ask 对「原始路径与 resolved 路径」任一命中即命中（fail-closed）；
 * 规则的 allow 与模式的自动放行要求**所有**提供的路径皆命中（防 symlink 走私出根）。
 *
 * @param {object} opts
 * @param {string} opts.tool
 * @param {string} opts.rawPath
 * @param {string} [opts.resolvedPath]
 * @param {"off"|"ask"|"auto"|"full"} [opts.mode] 预设 "ask"
 * @param {string[]|{deny?:string[],ask?:string[],allow?:string[]}} [opts.rules]
 * @param {string[]} [opts.authorizedRoots]
 * @param {string} [opts.home] 预设 os.homedir()
 * @param {string} [opts.settingsRoot] 单斜线 `/path` 的设定来源根；预设 process.cwd()
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

  // 1. 硬 denylist（一律 deny，先于一切）
  if (isHardDenied({ raw: rawPath, resolved: resolvedPath, home }, home)) {
    return { decision: "deny", reason: REASONS.HARD_DENY };
  }

  // 2. safety-check 档案（一律 ask，先于规则）
  if (
    (typeof rawPath === "string" && rawPath.trim().length > 0 && isSafetyCheckPath(rawPath)) ||
    (typeof resolvedPath === "string" && resolvedPath.trim().length > 0 && isSafetyCheckPath(resolvedPath))
  ) {
    return { decision: "ask", reason: REASONS.SAFETY_CHECK };
  }

  // 建立比对用候选路径（原始 + resolved）
  const candidates = [];
  const rawNorm = typeof rawPath === "string" && rawPath.trim().length > 0 ? toMatchPath(rawPath, home) : null;
  const resNorm =
    typeof resolvedPath === "string" && resolvedPath.trim().length > 0 ? toMatchPath(resolvedPath, home) : null;
  if (rawNorm !== null) candidates.push(rawNorm);
  if (resNorm !== null) candidates.push(resNorm);
  if (candidates.length === 0) return { decision: "deny", reason: REASONS.HARD_DENY };

  const rules = normalizeRules(opts.rules);

  // 工具名比对：`*` 为万用（与闸道 device-bridge-policy.ts toolMatches 同语义）。
  // allowRuleForRoot 产生的规则固定用 tool:"*"（授权根对四个唯读工具皆放行）。
  const toolMatches = (ruleTool) => ruleTool === "*" || ruleTool === tool;

  // 3. 规则 deny（任一候选命中即命中）
  for (const rule of rules.deny) {
    if (!toolMatches(rule.tool)) continue;
    if (candidates.some((c) => matchSpecifier(rule.specifier, c, ctx))) {
      return { decision: "deny", reason: REASONS.RULE_DENY, rule: { ...rule } };
    }
  }

  // 4. 规则 ask
  for (const rule of rules.ask) {
    if (!toolMatches(rule.tool)) continue;
    if (candidates.some((c) => matchSpecifier(rule.specifier, c, ctx))) {
      return { decision: "ask", reason: REASONS.RULE_ASK, rule: { ...rule } };
    }
  }

  // 5. 规则 allow（所有候选皆命中才放行）
  for (const rule of rules.allow) {
    if (!toolMatches(rule.tool)) continue;
    if (candidates.length > 0 && candidates.every((c) => matchSpecifier(rule.specifier, c, ctx))) {
      return { decision: "allow", reason: REASONS.RULE_ALLOW, rule: { ...rule } };
    }
  }

  // 6. 模式语义
  if (mode === "off") return { decision: "deny", reason: REASONS.MODE_OFF };
  if (mode === "ask") return { decision: "ask", reason: REASONS.MODE_ASK };

  if (mode === "auto") {
    const roots = normalizeRoots(opts.authorizedRoots, home);
    const inside = candidates.length > 0 && candidates.every((c) => roots.some((r) => pathWithin(c, r)));
    if (inside) return { decision: "allow", reason: REASONS.MODE_AUTO };
    return { decision: "ask", reason: REASONS.DEFAULT_ASK };
  }

  // mode === "full"（家目录内自动；硬 denylist 已于第 1 步先拒）
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
 * 建议授权的最接近目录（供授权卡「允许此目录」使用）。
 *
 * 契约：把输入当作「被要求的档案」，回其所在目录；**不得**回过宽根
 * （`/`、`~`、`/home`、家目录本身、家目录祖先、单层目录、硬 denylist / safety-check 目录），
 * 这种情况一律回 null，由呼叫端改为要求单档授权。
 *
 * @param {string} resolvedPath 已 realpath 的绝对路径
 * @param {{home?: string}} [opts]
 * @returns {string|null} 正规化后的绝对目录，或 null
 */
function suggestRoot(resolvedPath, opts = {}) {
  const home = opts.home !== undefined ? opts.home : os.homedir();
  if (typeof resolvedPath !== "string") return null;
  // 保留原始大小写（供显示/落盘授权用），比对另以低阶正规化路径为准。
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
  if (segs.length < 2) return null; // /home、/tmp、/etc … 单层＝过宽

  const homeNorm = typeof home === "string" && home.trim().length > 0 ? toMatchPath(home, null) : null;
  if (homeNorm !== null) {
    if (low === homeNorm) return null; // 家目录本身过宽
    if (homeNorm.startsWith(`${low}/`)) return null; // parent 是家目录祖先（如 /home、/Users）
  }
  if (isHardDenied({ raw: parentDisplay, resolved: parentDisplay, home }, home)) return null;
  if (isSafetyCheckPath(parentDisplay)) return null;
  return parentDisplay;
}

/**
 * 产生「已同意授权根」的放行规则（**纯函式**，与闸道 `authorizationRuleSpecifier`
 * 同形：`//<root 去头尾斜线>/**`）。用途：对话内就地授权（session/permanent）后，
 * 装置端第二道防线（mode=ask）必须认得云端已放行的根；规则以 `tool:"*"` 对四个
 * 唯读工具一体放行，路径以 `//`（档案系统绝对）＋`/**`（含其下）表达，装置端既有
 * `matchSpecifier` 语义即可命中。
 *
 * fail-closed：非字串／非绝对（不以 `/` 开头且非 Windows 磁碟）/ 过宽（去头尾斜线后
 * 为空，即 `/`）→ 回 `null`（呼叫端须略过，**不得**当成 `//**` 而意外全放行）。
 *
 * @param {string} root 授权根（绝对路径；可含尾斜线）
 * @returns {{effect:"allow", tool:"*", specifier:string}|null}
 */
function allowRuleForRoot(root) {
  if (typeof root !== "string") return null;
  const trimmed = root.trim();
  if (trimmed.length === 0) return null;
  const isAbsolute = trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed);
  if (!isAbsolute) return null;
  const body = trimmed.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (body.length === 0 || body === ".") return null; // `/`／空＝过宽
  return { effect: "allow", tool: "*", specifier: `//${body}/**` };
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
  allowRuleForRoot,
  // 低阶工具导出供测试与跨模组复用（不改变语义）
  _internals: { toMatchPath, globMatches, matchSpecifier, pathWithin },
};