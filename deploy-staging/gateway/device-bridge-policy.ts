// device-bridge-policy.ts — W6a 装置桥云端侧：**纯函式** 政策层（零 I/O、零状态）。
//
// 这一层是「云端 agent 经由使用者机器的出站连线读本机档案」的四道守门里，
// 挂在**云端闸道**上的那一道（纵深防御的第二层）。第一层是使用者本机 daemon：
// daemon 在真正开档前必须 `realpath` 后再跑同一组 denylist（本档的 isSensitivePath
// 是字串判定，跟不了 symlink，见下方注释）。两层都要挡，不能只信本机端。
//
// 为什么是纯函式：MCP/HTTP 两条路径都要复用同一份判定，且测试要能在不碰档案系统、
// 不碰网路的前提下逐条断言。任何 I/O（实际读档、realpath、网路）都不进本档。
//
// 预设 OFF：本档本身不含开关；开关与否在 device-bridge.ts（EIMU_DEVICE_BRIDGE）。

/** 允许经装置桥执行的工具**最小集合**。刻意不含任何写入／删除／执行命令工具。 */
export const DEVICE_BRIDGE_TOOLS = ["list_dir", "read_file", "grep", "stat"] as const
export type DeviceBridgeTool = (typeof DEVICE_BRIDGE_TOOLS)[number]

/** 单次回传内容硬上限。避免把整个档案灌进模型上下文。 */
export const MAX_READ_BYTES = 256 * 1024
/** 未指定 limit 时的预设读取量。 */
export const DEFAULT_READ_BYTES = 64 * 1024
/**
 * H2 输入侧上限（契约）：递回型工具（grep）在装置端逐档读取时，**每个档案**
 * 的读入位元组上限。云端本身读不到装置上的档，故由契约要求装置端遵守；
 * 云端把这个值随 `grep` 参数下发（`max_file_bytes`）并在回传时夹总量。
 * 没有这条上限，一个超大／特殊档（FIFO、巨大 log）可在装置端把记忆体吃爆。
 */
export const MAX_FILE_READ_BYTES = 1024 * 1024
/** 装置端授权根数量上限（避免注册表被灌爆）。 */
export const MAX_AUTHORIZED_ROOTS = 64

/** 敏感目录**段**（任一层级出现即敏感，不限 home 前缀）。 */
const SENSITIVE_DIR_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker"])

/** 敏感档案**basename**（精确整段相等，防前缀混淆）。 */
const SENSITIVE_FILE_BASENAMES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pgpass",
  ".bash_history",
  ".zsh_history",
])

/**
 * 浏览器 profile 目录：以「连续段序列」匹配（做了大小写/分隔符正规化）。
 * 涵盖 Linux（~/.config/*、~/.mozilla/firefox）与 macOS（~/Library/Application Support/*）。
 */
const BROWSER_PROFILE_SEQUENCES: readonly (readonly string[])[] = [
  [".mozilla", "firefox"],
  [".config", "google-chrome"],
  [".config", "chromium"],
  [".config", "brave-browser"],
  [".config", "bravesoftware"],
  [".config", "microsoft-edge"],
  ["library", "application support", "google", "chrome"],
  ["library", "application support", "firefox"],
  ["application support", "google", "chrome"],
]

function splitSegments(normalized: string): string[] {
  return normalized
    .split("/")
    .filter((s) => s.length > 0 && s !== "." && s !== "..")
}

function containsSequence(haystack: string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

/**
 * 敏感路径 denylist（Claude Code 清单照抄 + 浏览器 profile）。
 *
 * 判定语义（刻意偏 fail-closed）：
 *  - 非字串／空字串 → 视为敏感（true），呼叫端不得据此放行。
 *  - 反斜线一律正规成 `/`（Windows 路径也挡）。
 *  - 全部转小写后判定：大小写碰撞（`.SSH`）在区分大小写的 FS 上虽非真敏感目录，
 *    但挡掉无害、放行有害。
 *  - 扫描**所有**路径段，不是只比前缀：`/home/x/.ssh/id_rsa`、`/tmp/../.ssh/x`
 *    都命中；因此 `..` 逃逸、深层巢状都挡得住。
 *  - 前缀混淆不误命中：`~/.sshfoo`、`~/.ssh-backup` 的段是 `.sshfoo`／`.ssh-backup`，
 *    与 `.ssh` 整段不等 → 放行（这是真档名，不是敏感目录）。
 *
 * 已知限制（必须由本机 daemon 的 realpath 补上）：
 *  纯字串判定跟不了 symlink。若 `~/link_to_ssh -> ~/.ssh`，这段字串不含 `.ssh` 段，
 *  本函式回 false。故 daemon 必须对「要开的档」做 realpath 后**再跑一次**本函式；
 *  云端这层是第二道，不是唯一一道。
 */
export function isSensitivePath(p: unknown): boolean {
  if (typeof p !== "string" || p.trim().length === 0) return true
  const normalized = p.replace(/\\/g, "/").toLowerCase()
  const segs = splitSegments(normalized)
  if (segs.length === 0) return false
  const base = segs[segs.length - 1]
  if (SENSITIVE_FILE_BASENAMES.has(base)) return true
  for (const seg of segs) {
    if (SENSITIVE_DIR_SEGMENTS.has(seg)) return true
  }
  for (const seq of BROWSER_PROFILE_SEQUENCES) {
    if (containsSequence(segs, seq)) return true
  }
  return false
}

// ── H2：递回型工具（grep / list_dir）的根夹制 ─────────────────────────────
//
// 为什么需要（第一性原理）：云端只在**请求路径**上跑 denylist。`path="/home/u/project"`
// 本身不含敏感段而放行，但装置端 grep 会**递回**进 `project/.ssh/` 并只回截断后的行，
// 云端看不到递回到底收集了哪些档。纯字串 denylist 补不了这个洞（它跟不了递回），
// 故云端第二道防御＝把递回根**夹在使用者已授权的根之下**：
//   1. 档案系统根（`/`、Windows 磁碟根、UNC share）一律拒——递回整碟。
//   2. 递回根必须落在某个装置回报的「已授权根」之内（含相等）。
//      ⇒ 授权根 `/home/u/project` 时，父目录 `/home/u`、`/home`、`/` 都被拒
//        （「父目录路径被拒」），前缀混淆 `/home/u/project-evil` 也被拒。
//   3. 已授权根本身（或请求路径的任一祖先段）命中敏感名 → 拒（见 isSensitivePath）。
//
// 这是**契约面**处理：云端不知道装置递回会收到哪些档，故以「把根关进授权集」+
// 「装置端逐档 denylist（另一包修 all-segment 语义）」+「装置自报触碰敏感即整笔拒
// （sensitiveResultProblem）」三层合力，而非假装云端能列举递回结果。

/**
 * 去掉 Windows 装置路径前缀（`\\?\`、`\\.\`，正规化后为 `//?/`、`//./`），
 * 使 `\\?\C:\` 与 `C:\` 同判。
 */
function stripWindowsPrefix(s: string): string {
  return s.replace(/^\/\/[?.]\//, "")
}

/**
 * 是否为档案系统根：POSIX `/`、Windows 磁碟根（`C:`、`C:\`、`C:/`、`\\?\C:\`）、
 * UNC share 根（`\\server\share`）。空值／非字串回 false（由 isSensitivePath 以 fail-closed 处理）。
 */
export function isFilesystemRoot(p: unknown): boolean {
  if (typeof p !== "string") return false
  const s = stripWindowsPrefix(p.trim().replace(/\\/g, "/").toLowerCase())
  if (s === "/") return true
  if (/^[a-z]:/.test(s)) {
    const rest = s.slice(2)
    return rest === "" || /^\/+$/.test(rest)
  }
  // UNC share 根：//server/share（其下才是真正可递回的内容）。
  if (/^\/{2}[^/]+\/[^/]+$/.test(s)) return true
  return false
}

/**
 * 词法归一化成绝对路径段（小写）。相对路径、`~`、无法解析、或 `..` 逃逸超出根
 * 之上者 → null（呼叫端一律当作「不在任何根之下」＝拒）。
 * 不碰档案系统、不解 symlink（那是装置端 realpath 的职责）。
 */
function lexicalSegments(p: unknown): string[] | null {
  if (typeof p !== "string") return null
  const s = stripWindowsPrefix(p.trim().replace(/\\/g, "/").toLowerCase())
  if (s.length === 0) return null
  const isAbs = s.startsWith("/") || /^[a-z]:(\/|$)/.test(s)
  if (!isAbs) return null
  const out: string[] = []
  for (const part of s.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length === 0) return null // 逃逸到根之上 → 不可信
      out.pop()
      continue
    }
    out.push(part)
  }
  return out
}

/**
 * 同 lexicalSegments，但**保留原大小写**（授权回执显示用）。
 * 绝对／相对、`..` 逃逸、Windows 前缀的判定逐条同 lexicalSegments，唯一差别是不 toLowerCase。
 * 既有判定（isPathWithinRoot／matchRuleSpecifier／denylist）一律走 lexicalSegments（小写），
 * 本函式不参与任何放行判断，故不改变大小写不敏感语义。
 */
function lexicalSegmentsPreserveCase(p: unknown): string[] | null {
  if (typeof p !== "string") return null
  const s = stripWindowsPrefix(p.trim().replace(/\\/g, "/"))
  if (s.length === 0) return null
  const isAbs = s.startsWith("/") || /^[a-zA-Z]:(\/|$)/.test(s)
  if (!isAbs) return null
  const out: string[] = []
  for (const part of s.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length === 0) return null // 逃逸到根之上 → 不可信
      out.pop()
      continue
    }
    out.push(part)
  }
  return out
}

/**
 * candidate 是否落在 root 之内（含相等）。
 * 以「段」逐段比对，天生杜绝前缀混淆（`/home/u/project-evil` 不匹配 `/home/u/project`）。
 * root 为档案系统根、相对路径、`..` 逃逸 → false（fail-closed）。
 */
export function isPathWithinRoot(candidate: unknown, root: unknown): boolean {
  if (isFilesystemRoot(root) || isSensitivePath(root)) return false
  const c = lexicalSegments(candidate)
  const r = lexicalSegments(root)
  if (!c || !r || r.length === 0) return false
  if (c.length < r.length) return false
  for (let i = 0; i < r.length; i++) if (c[i] !== r[i]) return false
  return true
}

/**
 * grep/list_dir 的递回根判定。回传 null＝放行；否则回拒收原因字串。
 * 顺序：档案系统根 → 无授权根 → 不在任何授权根之下。
 */
export function recursiveRootProblem(p: unknown, authorizedRoots: unknown): string | null {
  if (isFilesystemRoot(p)) return "filesystem_root"
  if (!Array.isArray(authorizedRoots) || authorizedRoots.length === 0) return "no_authorized_root"
  for (const root of authorizedRoots) {
    if (isSensitivePath(root)) continue
    if (isFilesystemRoot(root)) continue
    if (isPathWithinRoot(p, root)) return null
  }
  return "not_within_authorized_root"
}

/**
 * 净化装置回报的已授权根：只留可归一化的绝对路径、非敏感、非档案系统根；去重、限量。
 * 敏感／根／相对／`~` 一律**丢弃**（不是报错）——授权集宁缺勿滥，缺了只是少放行。
 */
export function sanitizeAuthorizedRoots(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== "string") continue
    const p = item.trim()
    if (p.length === 0) continue
    if (isSensitivePath(p) || isFilesystemRoot(p)) continue
    const segs = lexicalSegments(p)
    if (!segs || segs.length === 0) continue // 相对／`~`／无法归一化／空段 → 不可作根
    if (!out.includes(p)) out.push(p)
    if (out.length >= MAX_AUTHORIZED_ROOTS) break
  }
  return out
}

/**
 * H2 契约面第二层：装置自报「递回时是否触碰到敏感段」。
 * 若装置在 result 标记 `sensitive_path_touched===true`、`excluded_sensitive_count>0`
 * 或 `sensitive_paths` 非空，云端**整笔拒绝**（不落地结果）。这是装置端逐档 denylist
 * 的旁证；装置诚实（威胁模型＝云端 agent 被诱导），故自报可用作纵深。
 * 未携带栏位不视为「有触碰」（避免与既有客户端不相容）。
 */
export function sensitiveResultProblem(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null
  const r = result as Record<string, unknown>
  if (r.sensitive_path_touched === true) return "device reported touching a sensitive path"
  if (Array.isArray(r.sensitive_paths) && r.sensitive_paths.length > 0) return "device reported sensitive paths in recursion"
  const n = r.excluded_sensitive_count
  if (typeof n === "number" && Number.isFinite(n) && n > 0) return "device reported excluding sensitive paths"
  return null
}

/** grep 逐档读取上限夹制：非有限／<=0 → 上限；其余向下取整并夹到上限。 */
export function clampFileBytes(requested: unknown): number {
  const n = typeof requested === "number" ? requested : Number.NaN
  if (!Number.isFinite(n) || n <= 0) return MAX_FILE_READ_BYTES
  return Math.min(Math.floor(n), MAX_FILE_READ_BYTES)
}

/** 工具白名单。非字串或不在白名单 → false（呼叫端一律拒收）。 */
export function isToolAllowed(tool: unknown): tool is DeviceBridgeTool {
  return typeof tool === "string" && (DEVICE_BRIDGE_TOOLS as readonly string[]).includes(tool)
}

/**
 * 读取大小夹制：非有限数／<=0 → 预设；超过上限 → 上限；其余向下取整。
 * 回传值保证落在 [1, MAX_READ_BYTES]。
 */
export function clampReadSize(requested: unknown): number {
  const n = typeof requested === "number" ? requested : Number.NaN
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_READ_BYTES
  return Math.min(Math.floor(n), MAX_READ_BYTES)
}

export interface TruncatedText {
  /** 实际要回给 agent 的文字；若被截断，尾端附带截断标记。 */
  text: string
  truncated: boolean
  /** 原始内容位元组数。 */
  originalBytes: number
  /** 保留（未含标记）的内容位元组数，保证 <= max。 */
  keptBytes: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * 以位元组为单位截断，并附上明确标记 `…[truncated N bytes]`。
 *
 * 语义：
 *  - 内容位元组 <= max → 原样回传，truncated=false。
 *  - 超过 → 内容截到 <=max（UTF-8 边界安全），再附加标记；`keptBytes <= max`。
 *  - 标记本身是「内容之外」的后设资讯，故回传 text 的总位元组可能略大于 max；
 *    呼叫端若需要硬上限，对 `keptBytes` 设限（本函式保证它不超）。
 */
export function truncateWithMarker(text: unknown, max: unknown): TruncatedText {
  const input = typeof text === "string" ? text : String(text ?? "")
  const cap = clampReadSize(max)
  const bytes = encoder.encode(input)
  const originalBytes = bytes.length
  if (originalBytes <= cap) {
    return { text: input, truncated: false, originalBytes, keptBytes: originalBytes }
  }
  let kept = bytes.slice(0, cap)
  // UTF-8 切在多位元组字元中间会产生 U+FFFD；退回一个位元组直到解码尾端不再是替换字元。
  let decoded = decoder.decode(kept)
  while (decoded.endsWith("\uFFFD") && kept.length > 0) {
    kept = kept.slice(0, kept.length - 1)
    decoded = decoder.decode(kept)
  }
  const marker = `\n…[truncated ${originalBytes - kept.length} bytes]`
  return { text: decoded + marker, truncated: true, originalBytes, keptBytes: kept.length }
}

// ══════════════════════════════════════════════════════════════════════════
// 权限决策引擎（W6b, 2026-10-04）—— Claude Code 式三桶规则 ＋ 模式档次。
//
// 为什么是纯函式：判定必须可被两端（云端闸道、本机 daemon）以同一份向量表逐条
// 断言；同一输入必得同一输出（无 I/O、无时间、无随机）。模式／规则的来源（register
// 的 body、session 授权）在 device-bridge.ts 接线，本档只做判定。
//
// 判定序（**固定，不得调换**）：
//   0. mode === "off" → deny（任何 invoke 一律拒，不进入授权流程）
//   1. 硬 denylist（`isHardDeniedPath` ∪ 既有 `isSensitivePath`）→ deny，先于一切
//   2. 档案系统根 → deny（递回整碟／非具体授权目标）
//   3. safety-check 档案／目录 → ask（**先于规则**；session/permanent 规则不得自动放行）
//   4. 规则 deny（bucket denylist ⇒ 首命中）
//   5. 规则 ask
//   6. 规则 allow
//   7. 模式语义（ask／auto／full）
//   8. 预设 ask
//
// 三桶互斥优先序由 4→6 保证：deny 压过 ask 压过 allow；扫描各桶时「各取首命中」。
// ══════════════════════════════════════════════════════════════════════════

/** 规则的效果桶（三桶，判定序 deny → ask → allow）。 */
export type PermissionEffect = "allow" | "deny" | "ask"
/** 规则的作用工具；`*` 为通配。 */
export type PermissionTool = DeviceBridgeTool | "*"
/** session 级权限规则（`tool` 或 `tool(specifier)` 的形式化落点）。 */
export interface PermissionRule {
  effect: PermissionEffect
  tool: PermissionTool
  /** `tool(specifier)` 的 specifier；缺＝`tool(*)` ≡ 该工具任意路径。 */
  specifier?: string
}

/** 判定结果。`reason` 为人类可读（并供 needs_authorization 映射）。 */
export type PermissionDecision = "allow" | "deny" | "ask"
export type PermissionReason =
  | "mode_off"
  | "denylist"
  | "filesystem_root"
  | "safety_check"
  | "rule_deny"
  | "rule_ask"
  | "rule_allow"
  | "mode_ask"
  | "authorized_root"
  | "home"
  | "outside_roots"
  | "default_ask"

export interface PermissionVerdict {
  decision: PermissionDecision
  reason: PermissionReason
  /** 命中的规则（四桶之一命中时才有）。 */
  rule?: PermissionRule
}

/** per-device 模式（随 register 上报）。预设语义为 `ask`。 */
export type DeviceBridgeMode = "off" | "ask" | "auto" | "full"
export const DEVICE_BRIDGE_MODES = ["off", "ask", "auto", "full"] as const

export function isDeviceBridgeMode(v: unknown): v is DeviceBridgeMode {
  return typeof v === "string" && (DEVICE_BRIDGE_MODES as readonly string[]).includes(v)
}

/** session 规则数量上限（避免注册表／会话被灌爆）。 */
export const MAX_PERMISSION_RULES = 64

// ── 硬 denylist（全域，任何模式／规则不得绕）─────────────────────────────
//
// 为什么独立于既有 `isSensitivePath`：既有清单是「Claude Code 泄漏源码的敏感清单照抄」，
// 偏浏览器 profile；硬 denylist 是**我方补上的全域不可绕集合**（私钥、凭证、云端
// 设定、系统影子档、行程环境），份额内所有样式在任何模式（含 full）与任何 allow
// 规则下都必须 deny。两者取**联集**参与判定（既有 isSensitivePath 只加不减）。

/** 敏感目录段（任一层级出现即硬拒）。含 `~/.config`（整个设定目录）。 */
const HARD_DENY_DIR_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config"])

/** 连续段序列（正规化后比对）：`~/.local/share/keyrings`、`/etc/shadow`、`/etc/sudoers`。 */
const HARD_DENY_SEQUENCES: readonly (readonly string[])[] = [
  [".local", "share", "keyrings"],
  ["etc", "shadow"],
  ["etc", "sudoers"],
]

/** 精确 basename（防前缀混淆：`.env.bak` 不因本集合命中，但 `^\.env\.` 样式会命中）。 */
const HARD_DENY_BASENAMES = new Set([".git-credentials", ".netrc", ".pgpass", ".bash_history", ".env"])

/** basename 样式（已转小写后比对）：私钥／凭证／service account／dotenv 家族。 */
const HARD_DENY_BASENAME_PATTERNS: readonly RegExp[] = [
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /^id_rsa/,
  /^id_ed25519/,
  /credential/,
  /secret/,
  /service-account.*\.json$/,
  /^\.env\./,
]

/**
 * 全域硬 denylist：任何模式（含 full）与任何 allow 规则**都不得绕过**。
 * 语义与 isSensitivePath 同款 fail-closed：
 *  - 非字串／空字串 → true（呼叫端不得据此放行）。
 *  - 反斜线正规成 `/`、全部转小写、扫描所有段。
 *  - 另涵盖 `/proc/<pid>/environ`（行程环境）。
 */
export function isHardDeniedPath(p: unknown): boolean {
  if (typeof p !== "string" || p.trim().length === 0) return true
  const normalized = p.replace(/\\/g, "/").toLowerCase()
  const segs = splitSegments(normalized)
  if (segs.length === 0) return false
  const base = segs[segs.length - 1]
  if (HARD_DENY_BASENAMES.has(base)) return true
  for (const pat of HARD_DENY_BASENAME_PATTERNS) if (pat.test(base)) return true
  for (const seg of segs) if (HARD_DENY_DIR_SEGMENTS.has(seg)) return true
  for (const seq of HARD_DENY_SEQUENCES) if (containsSequence(segs, seq)) return true
  if (segs.includes("proc") && base === "environ") return true
  return false
}

// ── safety check（auto-edit 安全网；一律 ask，规则不得自动放行）────────────
//
// 照抄 Claude Code 的 DANGEROUS_FILES／DANGEROUS_DIRECTORIES：这些是 shell／git／
// agent 自身的设定与状态档，改动（含被模型引导的读取脉络）风险最高，故强制询问、
// 不可由 session/permanent 授权自动放行。**硬 denylist 仍先于本节**（deny > ask）。
export const DANGEROUS_FILES: ReadonlySet<string> = new Set([
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
])

export const DANGEROUS_DIRECTORIES: ReadonlySet<string> = new Set([".git", ".vscode", ".idea", ".claude"])

/** 是否为 safety-check 档案／目录（一律 ask；判定先于规则）。 */
export function isSafetyCheckPath(p: unknown): boolean {
  if (typeof p !== "string" || p.trim().length === 0) return false
  const segs = splitSegments(p.replace(/\\/g, "/").toLowerCase())
  if (segs.length === 0) return false
  if (DANGEROUS_FILES.has(segs[segs.length - 1])) return true
  for (const seg of segs) if (DANGEROUS_DIRECTORIES.has(seg)) return true
  return false
}

// ── 路径展开／规则 specifier 比对 ────────────────────────────────────────

function expandTilde(s: string, home: string | null | undefined): string | null {
  const norm = s.replace(/\\/g, "/")
  if (norm === "~" || norm.startsWith("~/")) {
    if (!home) return null
    const h = home.replace(/\\/g, "/").replace(/\/+$/, "")
    const rest = norm.length > 1 ? "/" + norm.slice(2).replace(/^\/+/, "") : ""
    return h + rest
  }
  return norm
}

/**
 * 把路径展开成归一化的绝对路径（`~`→home、反斜线→`/`、丢 `.`／`..`、全小写）。
 * 相对路径／无法展开／`..` 逃逸根之上 → null（呼叫端一律当「不可信」）。
 */
export function expandToAbsolute(p: unknown, home?: string | null): string | null {
  if (typeof p !== "string" || p.trim().length === 0) return null
  const expanded = expandTilde(p.trim(), home)
  if (expanded === null) return null
  const segs = lexicalSegments(expanded)
  if (!segs || segs.length === 0) return null
  if (/^[a-z]:/.test(expanded)) return `${expanded[0].toLowerCase()}:/${segs.slice(1).join("/")}`
  if (!expanded.startsWith("/")) return null
  return "/" + segs.join("/")
}

/**
 * 同 expandToAbsolute（`~`→home、反斜线→`/`、丢 `.`／`..`），但**保留原大小写**。
 * 授权端点（authorize）回执的 `applied.root` 与规则 specifier 用本函式，让使用者看到自己
 * 输入的真实大小写；规则**比对**仍走 expandToAbsolute／lexicalSegments（小写），语义不变。
 */
export function expandToAbsolutePreserveCase(p: unknown, home?: string | null): string | null {
  if (typeof p !== "string" || p.trim().length === 0) return null
  const expanded = expandTilde(p.trim(), home)
  if (expanded === null) return null
  const segs = lexicalSegmentsPreserveCase(expanded)
  if (!segs || segs.length === 0) return null
  if (/^[a-zA-Z]:/.test(expanded)) return `${expanded[0]}:/${segs.slice(1).join("/")}`
  if (!expanded.startsWith("/")) return null
  return "/" + segs.join("/")
}

interface ParsedSpecifier {
  kind: "absolute" | "anywhere"
  base?: string
  pattern?: string
  recursive: boolean
}

/**
 * 解析规则 specifier 的路径前缀语义（照 Claude Code）：
 *   - `//path` → 档案系统根绝对（去一个 `/` 后当绝对路径）。
 *   - `~/path` → 家目录。
 *   - `/path`  → 相对于**设定档所在目录**（未提供 configDir 时退回绝对路径）。
 *   - 无前缀 / `./x` → 任意位置（gitignore 式比对）。
 *   - 尾端 `/**` → 该目录**含其下**（递回）。
 */
export function parseRuleSpecifier(specifier: string, opts: { home?: string | null; configDir?: string } = {}): ParsedSpecifier | null {
  if (typeof specifier !== "string") return null
  let s = specifier.trim().replace(/\\/g, "/")
  if (s.length === 0) return null
  let recursive = false
  if (s.endsWith("/**")) {
    recursive = true
    s = s.slice(0, -3)
  } else if (s.length > 1 && s.endsWith("/")) {
    recursive = true
    s = s.replace(/\/+$/, "")
  }
  if (s.startsWith("//")) return { kind: "absolute", base: s.slice(1), recursive }
  if (s === "~" || s.startsWith("~/")) {
    if (!opts.home) return null
    const h = opts.home.replace(/\\/g, "/").replace(/\/+$/, "")
    const rest = s.length > 1 ? s.slice(2) : ""
    return { kind: "absolute", base: h + (rest ? "/" + rest.replace(/^\/+/, "") : ""), recursive }
  }
  if (s.startsWith("/")) {
    const base = opts.configDir ? opts.configDir.replace(/\/+$/, "") + s : s
    return { kind: "absolute", base, recursive }
  }
  return { kind: "anywhere", pattern: s.replace(/^\.\//, ""), recursive }
}

function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp("^" + esc + "$")
}

/**
 * 单一 specifier 是否命中单一路径（specifier 的四种前缀语义 ＋ `/**` 递回）。
 * 全部转小写比对；段级相等杜绝前缀混淆。
 */
export function matchRuleSpecifier(
  specifier: string,
  targetPath: string,
  opts: { home?: string | null; configDir?: string } = {},
): boolean {
  const parsed = parseRuleSpecifier(specifier, opts)
  if (!parsed) return false
  const abs = expandToAbsolute(targetPath, opts.home)
  if (!abs) return false
  if (parsed.kind === "absolute") {
    const base = parsed.base!
    if (parsed.recursive) return isPathWithinRoot(abs, base)
    const a = lexicalSegments(abs)
    const b = lexicalSegments(base)
    if (!a || !b) return false
    return a.length === b.length && a.every((x, i) => x === b[i])
  }
  const t = abs
  const pat = parsed.pattern!.toLowerCase()
  const base = t.split("/").filter(Boolean).pop() ?? ""
  if (pat.includes("*") || pat.includes("?")) {
    const re = globToRegex(pat)
    return re.test(t) || re.test(base)
  }
  return base === pat || t === pat || t.endsWith("/" + pat)
}

function toolMatches(ruleTool: PermissionTool, tool: PermissionTool): boolean {
  return ruleTool === "*" || ruleTool === tool
}

/** specifier 缺／空 → 该工具任意路径（`Tool()`／`Tool(*)` ≡ `Tool`）。 */
function ruleMatchesPath(rule: PermissionRule, paths: readonly string[], opts: { home?: string | null; configDir?: string }): boolean {
  if (rule.specifier === undefined || rule.specifier === "") return true
  return paths.some((p) => matchRuleSpecifier(rule.specifier!, p, opts))
}

// ── 规则净化 ────────────────────────────────────────────────────────────

/**
 * 净化（未信任的）规则阵列：只留合法 effect／tool，specifier 只留非空字串，
 * 去重、限量。未知工具／效果的规则**丢弃**（不是报错）——规则集宁缺勿滥。
 */
export function sanitizePermissionRules(raw: unknown): PermissionRule[] {
  if (!Array.isArray(raw)) return []
  const out: PermissionRule[] = []
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue
    const r = item as Record<string, unknown>
    const effect = r.effect
    if (effect !== "allow" && effect !== "deny" && effect !== "ask") continue
    const toolRaw = r.tool
    let tool: PermissionTool
    if (toolRaw === "*") tool = "*"
    else if (isToolAllowed(toolRaw)) tool = toolRaw
    else continue
    const rule: PermissionRule = { effect, tool }
    if (typeof r.specifier === "string" && r.specifier.trim().length > 0) rule.specifier = r.specifier.trim()
    if (out.some((x) => x.effect === rule.effect && x.tool === rule.tool && (x.specifier ?? "") === (rule.specifier ?? ""))) continue
    out.push(rule)
    if (out.length >= MAX_PERMISSION_RULES) break
  }
  return out
}

// ── 判定函式 ────────────────────────────────────────────────────────────

export interface PermissionQuery {
  tool: PermissionTool
  /** 被存取的路径（可为 `~` 形式）。 */
  resolvedPath: string
  mode?: DeviceBridgeMode | string
  /** session 规则（未净化；函式内净化）。 */
  rules?: unknown
  authorizedRoots?: unknown
  home?: string | null
  /** symlink 解析后的真实路径；与 resolvedPath **任一命中即算命中**。 */
  realPath?: string
  /** `/path` 前缀语义的设定档所在目录（未提供时退回首码 `/` 的绝对路径）。 */
  configDir?: string
}

/**
 * 决策函式：**硬 denylist → safety-check → 规则 deny/ask/allow → 模式 → 预设 ask**。
 * 固定顺序见档头注释；任何规则或模式都不得绕过硬 denylist 与 safety-check。
 */
export function evaluatePermission(q: PermissionQuery): PermissionVerdict {
  const mode: DeviceBridgeMode = isDeviceBridgeMode(q.mode) ? q.mode : "ask"
  const rawPaths = [typeof q.resolvedPath === "string" ? q.resolvedPath : ""]
  if (typeof q.realPath === "string" && q.realPath.length > 0) rawPaths.push(q.realPath)
  const nonEmpty = rawPaths.filter((p) => p.length > 0)

  // 0. mode off：一律拒，不进入授权流程。
  if (mode === "off") return { decision: "deny", reason: "mode_off" }

  // 1. 硬 denylist（联集既有 isSensitivePath，只加不减）→ deny，先于一切。
  if (nonEmpty.length === 0) return { decision: "deny", reason: "denylist" }
  for (const p of nonEmpty) {
    if (isHardDeniedPath(p) || isSensitivePath(p)) return { decision: "deny", reason: "denylist" }
  }

  // 2. 档案系统根 → deny（递回整碟／非具体授权目标）。
  if (nonEmpty.some((p) => isFilesystemRoot(expandTilde(p, q.home) ?? p))) return { decision: "deny", reason: "filesystem_root" }

  // 3. safety-check → ask（先于规则；session/permanent 不得自动放行）。
  if (nonEmpty.some((p) => isSafetyCheckPath(p))) return { decision: "ask", reason: "safety_check" }

  // 4-6. 三桶规则，判定序 deny → ask → allow，各取首命中。
  const rules = sanitizePermissionRules(q.rules)
  const shared = { home: q.home, configDir: q.configDir }
  const eligible = rules.filter((r) => toolMatches(r.tool, q.tool) && ruleMatchesPath(r, nonEmpty, shared))
  const deny = eligible.find((r) => r.effect === "deny")
  if (deny) return { decision: "deny", reason: "rule_deny", rule: deny }
  const ask = eligible.find((r) => r.effect === "ask")
  if (ask) return { decision: "ask", reason: "rule_ask", rule: ask }
  const allow = eligible.find((r) => r.effect === "allow")
  if (allow) return { decision: "allow", reason: "rule_allow", rule: allow }

  // 7. 模式语义。
  if (mode === "ask") return { decision: "ask", reason: "mode_ask" }
  const absPaths = nonEmpty.map((p) => expandToAbsolute(p, q.home)).filter((x): x is string => x !== null)
  if (mode === "auto") {
    const roots = sanitizeAuthorizedRoots(q.authorizedRoots)
    if (absPaths.some((p) => roots.some((r) => isPathWithinRoot(p, r)))) return { decision: "allow", reason: "authorized_root" }
    return { decision: "ask", reason: "outside_roots" }
  }
  if (mode === "full") {
    const homeAbs = q.home ? expandToAbsolute(q.home, null) : null
    if (homeAbs && absPaths.some((p) => isPathWithinRoot(p, homeAbs))) return { decision: "allow", reason: "home" }
    return { decision: "ask", reason: "outside_roots" }
  }

  // 8. 预设 ask。
  return { decision: "ask", reason: "default_ask" }
}

// ── 授权根（authorize 端点用）────────────────────────────────────────────

export type AuthorizationRootProblem = "root_not_absolute" | "root_too_broad" | "denylisted_root"

/**
 * 检核「建议授权的根」是否可用；回 null＝可用，否则回拒收原因。
 *  - `root_not_absolute`：相对路径／`~` 无法展开。
 *  - `denylisted_root`：根落在硬 denylist 或既有敏感集合内（denylist 没有「授权」选项）。
 *  - `root_too_broad`：`/`、`/home`、使用者家目录本身（除非 mode=full）、空根。
 */
export function authorizationRootProblem(root: unknown, home: string | null | undefined, mode: DeviceBridgeMode | string = "ask"): AuthorizationRootProblem | null {
  if (typeof root !== "string" || root.trim().length === 0) return "root_not_absolute"
  if (isFilesystemRoot(root)) return "root_too_broad"
  const abs = expandToAbsolute(root, home)
  if (!abs) return "root_not_absolute"
  if (isFilesystemRoot(abs)) return "root_too_broad"
  if (isHardDeniedPath(abs) || isSensitivePath(abs)) return "denylisted_root"
  const segs = lexicalSegments(abs) ?? []
  if (segs.length === 0) return "root_too_broad"
  if (segs.length === 1 && segs[0] === "home") return "root_too_broad"
  if (home) {
    const h = expandToAbsolute(home, null)
    const hs = h ? lexicalSegments(h) : null
    if (hs && hs.length === segs.length && hs.every((x, i) => x === segs[i]) && mode !== "full") return "root_too_broad"
  }
  return null
}

/**
 * 建议授权的根。
 *  - `isDirectory=false`（read_file／stat；预设）：取被存取路径**之上最接近的目录**
 *    （档案→父目录；已是单段则回该段）。
 *  - `isDirectory=true`（list_dir／grep，被存取者本身是目录）：建议**该目录本身**，
 *    避免对 `…/Downloads` 建议其父目录（家目录）而引导使用者永久授权整个家目录。
 *
 * **夹制**：建议值若等于家目录、等于档案系统根、或落在 authorizationRootProblem 会判
 * `root_too_broad` 的范围，则退回「被存取路径本身（档案则其父目录）」，且**不得回 null**
 * （null 会让呼叫端退化成请求路径，使用者更无从判断）。
 * 无法归一化（相对路径／`~` 且无 home）→ null（呼叫端据此不可建议）。
 *
 * **大小写（2026-10-04 修）**：本函式回传值会被（a）显示在授权卡、（b）使用者据以呼叫
 * authorize 端点、（c）成为下发给装置的授权根／规则 specifier ⇒ 必须**保留使用者路径
 * 的原始大小写**。装置端（Linux，大小写敏感）`policy.isPathAllowed` 做的是逐字比对，
 * 若这里折成小写（旧版 `expandToAbsolute`＋`lexicalSegments`），含大写段的路径
 * （`~/Desktop`、`~/Downloads`）授权后一律 `not_authorized`。夹制判定仍走
 * `authorizationRootProblem`（内部折小写），安全语义不变。
 */
export function suggestAuthorizationRoot(p: unknown, home?: string | null, isDirectory: boolean = false): string | null {
  // 档案系统根本身没有任何「更窄的目录」可建议；原样回（呼叫端授权时仍会被 root_too_broad 挡）。
  if (isFilesystemRoot(p)) return typeof p === "string" ? p.trim().replace(/\\/g, "/") : null
  const abs = expandToAbsolutePreserveCase(p, home)
  if (!abs) return null
  const segs = lexicalSegmentsPreserveCase(abs)
  if (!segs || segs.length === 0) return null
  const selfDir = "/" + segs.join("/")
  const parentDir = segs.length >= 2 ? "/" + segs.slice(0, -1).join("/") : selfDir
  const base = isDirectory ? selfDir : parentDir
  if (isFilesystemRoot(base) || authorizationRootProblem(base, home, "ask") === "root_too_broad") {
    return isDirectory ? selfDir : parentDir
  }
  return base
}

/**
 * 授权规则的 specifier：以 `//` 明确标示档案系统绝对根 ＋ `/**` 递回，
 * 使规则不依赖 configDir 语义（自动授权的根永远是绝对、含其下）。
 * 保留传入 root 的大小写（回执一致）；比对端照旧大小写不敏感。
 */
export function authorizationRuleSpecifier(root: string): string {
  const abs = expandToAbsolutePreserveCase(root, null)
  const body = (abs ?? root).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "")
  return `//${body}/**`
}
