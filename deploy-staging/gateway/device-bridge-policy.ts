// device-bridge-policy.ts — W6a 裝置橋雲端側：**純函式** 政策層（零 I/O、零狀態）。
//
// 這一層是「雲端 agent 經由使用者機器的出站連線讀本機檔案」的四道守門裡，
// 掛在**雲端閘道**上的那一道（縱深防禦的第二層）。第一層是使用者本機 daemon：
// daemon 在真正開檔前必須 `realpath` 後再跑同一組 denylist（本檔的 isSensitivePath
// 是字串判定，跟不了 symlink，見下方註釋）。兩層都要擋，不能只信本機端。
//
// 為什麼是純函式：MCP/HTTP 兩條路徑都要複用同一份判定，且測試要能在不碰檔案系統、
// 不碰網路的前提下逐條斷言。任何 I/O（實際讀檔、realpath、網路）都不進本檔。
//
// 預設 OFF：本檔本身不含開關；開關與否在 device-bridge.ts（EIMU_DEVICE_BRIDGE）。

/** 允許經裝置橋執行的工具**最小集合**。刻意不含任何寫入／刪除／執行命令工具。 */
export const DEVICE_BRIDGE_TOOLS = ["list_dir", "read_file", "grep", "stat"] as const
export type DeviceBridgeTool = (typeof DEVICE_BRIDGE_TOOLS)[number]

/** 單次回傳內容硬上限。避免把整個檔案灌進模型上下文。 */
export const MAX_READ_BYTES = 256 * 1024
/** 未指定 limit 時的預設讀取量。 */
export const DEFAULT_READ_BYTES = 64 * 1024
/**
 * H2 輸入側上限（契約）：遞迴型工具（grep）在裝置端逐檔讀取時，**每個檔案**
 * 的讀入位元組上限。雲端本身讀不到裝置上的檔，故由契約要求裝置端遵守；
 * 雲端把這個值隨 `grep` 參數下發（`max_file_bytes`）並在回傳時夾總量。
 * 沒有這條上限，一個超大／特殊檔（FIFO、巨大 log）可在裝置端把記憶體吃爆。
 */
export const MAX_FILE_READ_BYTES = 1024 * 1024
/** 裝置端授權根數量上限（避免註冊表被灌爆）。 */
export const MAX_AUTHORIZED_ROOTS = 64

/** 敏感目錄**段**（任一層級出現即敏感，不限 home 前綴）。 */
const SENSITIVE_DIR_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker"])

/** 敏感檔案**basename**（精確整段相等，防前綴混淆）。 */
const SENSITIVE_FILE_BASENAMES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pgpass",
  ".bash_history",
  ".zsh_history",
])

/**
 * 瀏覽器 profile 目錄：以「連續段序列」匹配（做了大小寫/分隔符正規化）。
 * 涵蓋 Linux（~/.config/*、~/.mozilla/firefox）與 macOS（~/Library/Application Support/*）。
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
 * 敏感路徑 denylist（Claude Code 清單照抄 + 瀏覽器 profile）。
 *
 * 判定語義（刻意偏 fail-closed）：
 *  - 非字串／空字串 → 視為敏感（true），呼叫端不得據此放行。
 *  - 反斜線一律正規成 `/`（Windows 路徑也擋）。
 *  - 全部轉小寫後判定：大小寫碰撞（`.SSH`）在區分大小寫的 FS 上雖非真敏感目錄，
 *    但擋掉無害、放行有害。
 *  - 掃描**所有**路徑段，不是只比前綴：`/home/x/.ssh/id_rsa`、`/tmp/../.ssh/x`
 *    都命中；因此 `..` 逃逸、深層巢狀都擋得住。
 *  - 前綴混淆不誤命中：`~/.sshfoo`、`~/.ssh-backup` 的段是 `.sshfoo`／`.ssh-backup`，
 *    與 `.ssh` 整段不等 → 放行（這是真檔名，不是敏感目錄）。
 *
 * 已知限制（必須由本機 daemon 的 realpath 補上）：
 *  純字串判定跟不了 symlink。若 `~/link_to_ssh -> ~/.ssh`，這段字串不含 `.ssh` 段，
 *  本函式回 false。故 daemon 必須對「要開的檔」做 realpath 後**再跑一次**本函式；
 *  雲端這層是第二道，不是唯一一道。
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

// ── H2：遞迴型工具（grep / list_dir）的根夾制 ─────────────────────────────
//
// 為什麼需要（第一性原理）：雲端只在**請求路徑**上跑 denylist。`path="/home/u/project"`
// 本身不含敏感段而放行，但裝置端 grep 會**遞迴**進 `project/.ssh/` 並只回截斷後的行，
// 雲端看不到遞迴到底收集了哪些檔。純字串 denylist 補不了這個洞（它跟不了遞迴），
// 故雲端第二道防禦＝把遞迴根**夾在使用者已授權的根之下**：
//   1. 檔案系統根（`/`、Windows 磁碟根、UNC share）一律拒——遞迴整碟。
//   2. 遞迴根必須落在某個裝置回報的「已授權根」之內（含相等）。
//      ⇒ 授權根 `/home/u/project` 時，父目錄 `/home/u`、`/home`、`/` 都被拒
//        （「父目錄路徑被拒」），前綴混淆 `/home/u/project-evil` 也被拒。
//   3. 已授權根本身（或請求路徑的任一祖先段）命中敏感名 → 拒（見 isSensitivePath）。
//
// 這是**契約面**處理：雲端不知道裝置遞迴會收到哪些檔，故以「把根關進授權集」+
// 「裝置端逐檔 denylist（另一包修 all-segment 語義）」+「裝置自報觸碰敏感即整筆拒
// （sensitiveResultProblem）」三層合力，而非假裝雲端能列舉遞迴結果。

/**
 * 去掉 Windows 裝置路徑前綴（`\\?\`、`\\.\`，正規化後為 `//?/`、`//./`），
 * 使 `\\?\C:\` 與 `C:\` 同判。
 */
function stripWindowsPrefix(s: string): string {
  return s.replace(/^\/\/[?.]\//, "")
}

/**
 * 是否為檔案系統根：POSIX `/`、Windows 磁碟根（`C:`、`C:\`、`C:/`、`\\?\C:\`）、
 * UNC share 根（`\\server\share`）。空值／非字串回 false（由 isSensitivePath 以 fail-closed 處理）。
 */
export function isFilesystemRoot(p: unknown): boolean {
  if (typeof p !== "string") return false
  const s = stripWindowsPrefix(p.trim().replace(/\\/g, "/").toLowerCase())
  if (s === "/") return true
  if (/^[a-z]:/.test(s)) {
    const rest = s.slice(2)
    return rest === "" || /^\/+$/.test(rest)
  }
  // UNC share 根：//server/share（其下才是真正可遞迴的內容）。
  if (/^\/{2}[^/]+\/[^/]+$/.test(s)) return true
  return false
}

/**
 * 詞法歸一化成絕對路徑段（小寫）。相對路徑、`~`、無法解析、或 `..` 逃逸超出根
 * 之上者 → null（呼叫端一律當作「不在任何根之下」＝拒）。
 * 不碰檔案系統、不解 symlink（那是裝置端 realpath 的職責）。
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
 * 同 lexicalSegments，但**保留原大小寫**（授權回執顯示用）。
 * 絕對／相對、`..` 逃逸、Windows 前綴的判定逐條同 lexicalSegments，唯一差別是不 toLowerCase。
 * 既有判定（isPathWithinRoot／matchRuleSpecifier／denylist）一律走 lexicalSegments（小寫），
 * 本函式不參與任何放行判斷，故不改變大小寫不敏感語義。
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
 * candidate 是否落在 root 之內（含相等）。
 * 以「段」逐段比對，天生杜絕前綴混淆（`/home/u/project-evil` 不匹配 `/home/u/project`）。
 * root 為檔案系統根、相對路徑、`..` 逃逸 → false（fail-closed）。
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
 * grep/list_dir 的遞迴根判定。回傳 null＝放行；否則回拒收原因字串。
 * 順序：檔案系統根 → 無授權根 → 不在任何授權根之下。
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
 * 淨化裝置回報的已授權根：只留可歸一化的絕對路徑、非敏感、非檔案系統根；去重、限量。
 * 敏感／根／相對／`~` 一律**丟棄**（不是報錯）——授權集寧缺勿濫，缺了只是少放行。
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
    if (!segs || segs.length === 0) continue // 相對／`~`／無法歸一化／空段 → 不可作根
    if (!out.includes(p)) out.push(p)
    if (out.length >= MAX_AUTHORIZED_ROOTS) break
  }
  return out
}

/**
 * H2 契約面第二層：裝置自報「遞迴時是否觸碰到敏感段」。
 * 若裝置在 result 標記 `sensitive_path_touched===true`、`excluded_sensitive_count>0`
 * 或 `sensitive_paths` 非空，雲端**整筆拒絕**（不落地結果）。這是裝置端逐檔 denylist
 * 的旁證；裝置誠實（威脅模型＝雲端 agent 被誘導），故自報可用作縱深。
 * 未攜帶欄位不視為「有觸碰」（避免與既有客戶端不相容）。
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

/** grep 逐檔讀取上限夾制：非有限／<=0 → 上限；其餘向下取整並夾到上限。 */
export function clampFileBytes(requested: unknown): number {
  const n = typeof requested === "number" ? requested : Number.NaN
  if (!Number.isFinite(n) || n <= 0) return MAX_FILE_READ_BYTES
  return Math.min(Math.floor(n), MAX_FILE_READ_BYTES)
}

/** 工具白名單。非字串或不在白名單 → false（呼叫端一律拒收）。 */
export function isToolAllowed(tool: unknown): tool is DeviceBridgeTool {
  return typeof tool === "string" && (DEVICE_BRIDGE_TOOLS as readonly string[]).includes(tool)
}

/**
 * 讀取大小夾制：非有限數／<=0 → 預設；超過上限 → 上限；其餘向下取整。
 * 回傳值保證落在 [1, MAX_READ_BYTES]。
 */
export function clampReadSize(requested: unknown): number {
  const n = typeof requested === "number" ? requested : Number.NaN
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_READ_BYTES
  return Math.min(Math.floor(n), MAX_READ_BYTES)
}

export interface TruncatedText {
  /** 實際要回給 agent 的文字；若被截斷，尾端附帶截斷標記。 */
  text: string
  truncated: boolean
  /** 原始內容位元組數。 */
  originalBytes: number
  /** 保留（未含標記）的內容位元組數，保證 <= max。 */
  keptBytes: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * 以位元組為單位截斷，並附上明確標記 `…[truncated N bytes]`。
 *
 * 語義：
 *  - 內容位元組 <= max → 原樣回傳，truncated=false。
 *  - 超過 → 內容截到 <=max（UTF-8 邊界安全），再附加標記；`keptBytes <= max`。
 *  - 標記本身是「內容之外」的後設資訊，故回傳 text 的總位元組可能略大於 max；
 *    呼叫端若需要硬上限，對 `keptBytes` 設限（本函式保證它不超）。
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
  // UTF-8 切在多位元組字元中間會產生 U+FFFD；退回一個位元組直到解碼尾端不再是替換字元。
  let decoded = decoder.decode(kept)
  while (decoded.endsWith("\uFFFD") && kept.length > 0) {
    kept = kept.slice(0, kept.length - 1)
    decoded = decoder.decode(kept)
  }
  const marker = `\n…[truncated ${originalBytes - kept.length} bytes]`
  return { text: decoded + marker, truncated: true, originalBytes, keptBytes: kept.length }
}

// ══════════════════════════════════════════════════════════════════════════
// 權限決策引擎（W6b, 2026-10-04）—— Claude Code 式三桶規則 ＋ 模式檔次。
//
// 為什麼是純函式：判定必須可被兩端（雲端閘道、本機 daemon）以同一份向量表逐條
// 斷言；同一輸入必得同一輸出（無 I/O、無時間、無隨機）。模式／規則的來源（register
// 的 body、session 授權）在 device-bridge.ts 接線，本檔只做判定。
//
// 判定序（**固定，不得調換**）：
//   0. mode === "off" → deny（任何 invoke 一律拒，不進入授權流程）
//   1. 硬 denylist（`isHardDeniedPath` ∪ 既有 `isSensitivePath`）→ deny，先於一切
//   2. 檔案系統根 → deny（遞迴整碟／非具體授權目標）
//   3. safety-check 檔案／目錄 → ask（**先於規則**；session/permanent 規則不得自動放行）
//   4. 規則 deny（bucket denylist ⇒ 首命中）
//   5. 規則 ask
//   6. 規則 allow
//   7. 模式語義（ask／auto／full）
//   8. 預設 ask
//
// 三桶互斥優先序由 4→6 保證：deny 壓過 ask 壓過 allow；掃描各桶時「各取首命中」。
// ══════════════════════════════════════════════════════════════════════════

/** 規則的效果桶（三桶，判定序 deny → ask → allow）。 */
export type PermissionEffect = "allow" | "deny" | "ask"
/** 規則的作用工具；`*` 為通配。 */
export type PermissionTool = DeviceBridgeTool | "*"
/** session 級權限規則（`tool` 或 `tool(specifier)` 的形式化落點）。 */
export interface PermissionRule {
  effect: PermissionEffect
  tool: PermissionTool
  /** `tool(specifier)` 的 specifier；缺＝`tool(*)` ≡ 該工具任意路徑。 */
  specifier?: string
}

/** 判定結果。`reason` 為人類可讀（並供 needs_authorization 映射）。 */
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
  /** 命中的規則（四桶之一命中時才有）。 */
  rule?: PermissionRule
}

/** per-device 模式（隨 register 上報）。預設語義為 `ask`。 */
export type DeviceBridgeMode = "off" | "ask" | "auto" | "full"
export const DEVICE_BRIDGE_MODES = ["off", "ask", "auto", "full"] as const

export function isDeviceBridgeMode(v: unknown): v is DeviceBridgeMode {
  return typeof v === "string" && (DEVICE_BRIDGE_MODES as readonly string[]).includes(v)
}

/** session 規則數量上限（避免註冊表／會話被灌爆）。 */
export const MAX_PERMISSION_RULES = 64

// ── 硬 denylist（全域，任何模式／規則不得繞）─────────────────────────────
//
// 為什麼獨立於既有 `isSensitivePath`：既有清單是「Claude Code 洩漏源碼的敏感清單照抄」，
// 偏瀏覽器 profile；硬 denylist 是**我方補上的全域不可繞集合**（私鑰、憑證、雲端
// 設定、系統影子檔、行程環境），份額內所有樣式在任何模式（含 full）與任何 allow
// 規則下都必須 deny。兩者取**聯集**參與判定（既有 isSensitivePath 只加不減）。

/** 敏感目錄段（任一層級出現即硬拒）。含 `~/.config`（整個設定目錄）。 */
const HARD_DENY_DIR_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config"])

/** 連續段序列（正規化後比對）：`~/.local/share/keyrings`、`/etc/shadow`、`/etc/sudoers`。 */
const HARD_DENY_SEQUENCES: readonly (readonly string[])[] = [
  [".local", "share", "keyrings"],
  ["etc", "shadow"],
  ["etc", "sudoers"],
]

/** 精確 basename（防前綴混淆：`.env.bak` 不因本集合命中，但 `^\.env\.` 樣式會命中）。 */
const HARD_DENY_BASENAMES = new Set([".git-credentials", ".netrc", ".pgpass", ".bash_history", ".env"])

/** basename 樣式（已轉小寫後比對）：私鑰／憑證／service account／dotenv 家族。 */
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
 * 全域硬 denylist：任何模式（含 full）與任何 allow 規則**都不得繞過**。
 * 語義與 isSensitivePath 同款 fail-closed：
 *  - 非字串／空字串 → true（呼叫端不得據此放行）。
 *  - 反斜線正規成 `/`、全部轉小寫、掃描所有段。
 *  - 另涵蓋 `/proc/<pid>/environ`（行程環境）。
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

// ── safety check（auto-edit 安全網；一律 ask，規則不得自動放行）────────────
//
// 照抄 Claude Code 的 DANGEROUS_FILES／DANGEROUS_DIRECTORIES：這些是 shell／git／
// agent 自身的設定與狀態檔，改動（含被模型引導的讀取脈絡）風險最高，故強制詢問、
// 不可由 session/permanent 授權自動放行。**硬 denylist 仍先於本節**（deny > ask）。
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

/** 是否為 safety-check 檔案／目錄（一律 ask；判定先於規則）。 */
export function isSafetyCheckPath(p: unknown): boolean {
  if (typeof p !== "string" || p.trim().length === 0) return false
  const segs = splitSegments(p.replace(/\\/g, "/").toLowerCase())
  if (segs.length === 0) return false
  if (DANGEROUS_FILES.has(segs[segs.length - 1])) return true
  for (const seg of segs) if (DANGEROUS_DIRECTORIES.has(seg)) return true
  return false
}

// ── 路徑展開／規則 specifier 比對 ────────────────────────────────────────

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
 * 把路徑展開成歸一化的絕對路徑（`~`→home、反斜線→`/`、丟 `.`／`..`、全小寫）。
 * 相對路徑／無法展開／`..` 逃逸根之上 → null（呼叫端一律當「不可信」）。
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
 * 同 expandToAbsolute（`~`→home、反斜線→`/`、丟 `.`／`..`），但**保留原大小寫**。
 * 授權端點（authorize）回執的 `applied.root` 與規則 specifier 用本函式，讓使用者看到自己
 * 輸入的真實大小寫；規則**比對**仍走 expandToAbsolute／lexicalSegments（小寫），語義不變。
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
 * 解析規則 specifier 的路徑前綴語義（照 Claude Code）：
 *   - `//path` → 檔案系統根絕對（去一個 `/` 後當絕對路徑）。
 *   - `~/path` → 家目錄。
 *   - `/path`  → 相對於**設定檔所在目錄**（未提供 configDir 時退回絕對路徑）。
 *   - 無前綴 / `./x` → 任意位置（gitignore 式比對）。
 *   - 尾端 `/**` → 該目錄**含其下**（遞迴）。
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
 * 單一 specifier 是否命中單一路徑（specifier 的四種前綴語義 ＋ `/**` 遞迴）。
 * 全部轉小寫比對；段級相等杜絕前綴混淆。
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

/** specifier 缺／空 → 該工具任意路徑（`Tool()`／`Tool(*)` ≡ `Tool`）。 */
function ruleMatchesPath(rule: PermissionRule, paths: readonly string[], opts: { home?: string | null; configDir?: string }): boolean {
  if (rule.specifier === undefined || rule.specifier === "") return true
  return paths.some((p) => matchRuleSpecifier(rule.specifier!, p, opts))
}

// ── 規則淨化 ────────────────────────────────────────────────────────────

/**
 * 淨化（未信任的）規則陣列：只留合法 effect／tool，specifier 只留非空字串，
 * 去重、限量。未知工具／效果的規則**丟棄**（不是報錯）——規則集寧缺勿濫。
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
  /** 被存取的路徑（可為 `~` 形式）。 */
  resolvedPath: string
  mode?: DeviceBridgeMode | string
  /** session 規則（未淨化；函式內淨化）。 */
  rules?: unknown
  authorizedRoots?: unknown
  home?: string | null
  /** symlink 解析後的真實路徑；與 resolvedPath **任一命中即算命中**。 */
  realPath?: string
  /** `/path` 前綴語義的設定檔所在目錄（未提供時退回首碼 `/` 的絕對路徑）。 */
  configDir?: string
}

/**
 * 決策函式：**硬 denylist → safety-check → 規則 deny/ask/allow → 模式 → 預設 ask**。
 * 固定順序見檔頭註釋；任何規則或模式都不得繞過硬 denylist 與 safety-check。
 */
export function evaluatePermission(q: PermissionQuery): PermissionVerdict {
  const mode: DeviceBridgeMode = isDeviceBridgeMode(q.mode) ? q.mode : "ask"
  const rawPaths = [typeof q.resolvedPath === "string" ? q.resolvedPath : ""]
  if (typeof q.realPath === "string" && q.realPath.length > 0) rawPaths.push(q.realPath)
  const nonEmpty = rawPaths.filter((p) => p.length > 0)

  // 0. mode off：一律拒，不進入授權流程。
  if (mode === "off") return { decision: "deny", reason: "mode_off" }

  // 1. 硬 denylist（聯集既有 isSensitivePath，只加不減）→ deny，先於一切。
  if (nonEmpty.length === 0) return { decision: "deny", reason: "denylist" }
  for (const p of nonEmpty) {
    if (isHardDeniedPath(p) || isSensitivePath(p)) return { decision: "deny", reason: "denylist" }
  }

  // 2. 檔案系統根 → deny（遞迴整碟／非具體授權目標）。
  if (nonEmpty.some((p) => isFilesystemRoot(expandTilde(p, q.home) ?? p))) return { decision: "deny", reason: "filesystem_root" }

  // 3. safety-check → ask（先於規則；session/permanent 不得自動放行）。
  if (nonEmpty.some((p) => isSafetyCheckPath(p))) return { decision: "ask", reason: "safety_check" }

  // 4-6. 三桶規則，判定序 deny → ask → allow，各取首命中。
  const rules = sanitizePermissionRules(q.rules)
  const shared = { home: q.home, configDir: q.configDir }
  const eligible = rules.filter((r) => toolMatches(r.tool, q.tool) && ruleMatchesPath(r, nonEmpty, shared))
  const deny = eligible.find((r) => r.effect === "deny")
  if (deny) return { decision: "deny", reason: "rule_deny", rule: deny }
  const ask = eligible.find((r) => r.effect === "ask")
  if (ask) return { decision: "ask", reason: "rule_ask", rule: ask }
  const allow = eligible.find((r) => r.effect === "allow")
  if (allow) return { decision: "allow", reason: "rule_allow", rule: allow }

  // 7. 模式語義。
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

  // 8. 預設 ask。
  return { decision: "ask", reason: "default_ask" }
}

// ── 授權根（authorize 端點用）────────────────────────────────────────────

export type AuthorizationRootProblem = "root_not_absolute" | "root_too_broad" | "denylisted_root"

/**
 * 檢核「建議授權的根」是否可用；回 null＝可用，否則回拒收原因。
 *  - `root_not_absolute`：相對路徑／`~` 無法展開。
 *  - `denylisted_root`：根落在硬 denylist 或既有敏感集合內（denylist 沒有「授權」選項）。
 *  - `root_too_broad`：`/`、`/home`、使用者家目錄本身（除非 mode=full）、空根。
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
 * 建議授權的根。
 *  - `isDirectory=false`（read_file／stat；預設）：取被存取路徑**之上最接近的目錄**
 *    （檔案→父目錄；已是單段則回該段）。
 *  - `isDirectory=true`（list_dir／grep，被存取者本身是目錄）：建議**該目錄本身**，
 *    避免對 `…/Downloads` 建議其父目錄（家目錄）而引導使用者永久授權整個家目錄。
 *
 * **夾制**：建議值若等於家目錄、等於檔案系統根、或落在 authorizationRootProblem 會判
 * `root_too_broad` 的範圍，則退回「被存取路徑本身（檔案則其父目錄）」，且**不得回 null**
 * （null 會讓呼叫端退化成請求路徑，使用者更無從判斷）。
 * 無法歸一化（相對路徑／`~` 且無 home）→ null（呼叫端據此不可建議）。
 *
 * **大小寫（2026-10-04 修）**：本函式回傳值會被（a）顯示在授權卡、（b）使用者據以呼叫
 * authorize 端點、（c）成為下發給裝置的授權根／規則 specifier ⇒ 必須**保留使用者路徑
 * 的原始大小寫**。裝置端（Linux，大小寫敏感）`policy.isPathAllowed` 做的是逐字比對，
 * 若這裡折成小寫（舊版 `expandToAbsolute`＋`lexicalSegments`），含大寫段的路徑
 * （`~/Desktop`、`~/Downloads`）授權後一律 `not_authorized`。夾制判定仍走
 * `authorizationRootProblem`（內部折小寫），安全語義不變。
 */
export function suggestAuthorizationRoot(p: unknown, home?: string | null, isDirectory: boolean = false): string | null {
  // 檔案系統根本身沒有任何「更窄的目錄」可建議；原樣回（呼叫端授權時仍會被 root_too_broad 擋）。
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
 * 授權規則的 specifier：以 `//` 明確標示檔案系統絕對根 ＋ `/**` 遞迴，
 * 使規則不依賴 configDir 語義（自動授權的根永遠是絕對、含其下）。
 * 保留傳入 root 的大小寫（回執一致）；比對端照舊大小寫不敏感。
 */
export function authorizationRuleSpecifier(root: string): string {
  const abs = expandToAbsolutePreserveCase(root, null)
  const body = (abs ?? root).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "")
  return `//${body}/**`
}
