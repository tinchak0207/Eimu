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
