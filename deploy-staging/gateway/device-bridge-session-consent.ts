// device-bridge-session-consent.ts — W6 裝置橋雲端側：**會話同意**的行程外持久化。
//
// 背景（2026-10-04 真殼定位，缺陷 2）：`DeviceBridge` 的 `sessionRules`／`sessionConsent`
// 是行程內 `Map`，gateway 一重啟（每次部署）就清空，已 `session` 授權的子目錄立刻回
// `needs_authorization`——「同意」在使用者眼中是會話級的，卻活不過一次部署。
// 本檔把 **session 同意的根**（連同 permanent，保留其原 scope）落 gateway 本地單檔，
// 啟動時載入、由 DeviceBridge 重建規則與同意記錄。
//
// 紀律（逐條對應 spec 硬要求）：
//   - **只存** tenant id ＋ root 路徑 ＋ scope ＋ tool ＋ 到期時間；**絕不存任何
//     token／憑證／session id**（檔內出現即違規）。
//   - **原子寫入**：同目錄暫存檔 → `rename` 覆蓋；權限 0600（寫入後再 chmod 一次，
//     不受進程 umask 影響）。
//   - **有 TTL**（預設 12h，`EIMU_DEVICE_BRIDGE_SESSION_CONSENT_TTL_MS` 可覆寫）；
//     載入時丟棄過期項。
//   - **`once` 不進本檔**：一次性授權走 `OnceGrantStore` 核銷，重啟即失效。
//   - **不升級同意**：`session` 記錄永遠以 `scope:"session"` 讀回，絕不因落盤而變成
//     permanent（permanent 只在使用者明確選擇時才以 permanent 名義下發裝置落盤）。
//   - **載入即安全複核**：每個 root 重新過 policy 的檔案系統根／硬 denylist／敏感集合；
//     即使檔案被竄改，敏感根也載入不進（denylist 重啟後仍硬拒）。
//   - **落點**＝gateway 執行時狀態目錄（與 `sessions.db` 同目錄者；部署目錄每次換版、
//     狀態目錄不隨版本搬移），**不在 web 可服務目錄**下。
//   - 任何 IO 失敗只以「檔名層級」記 log、**不拋**：持久化失敗只等於退回「重啟即忘」的
//     舊行為，絕不得讓授權流程掛掉。

import { chmodSync, mkdirSync, readFileSync, renameSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  expandToAbsolutePreserveCase,
  isFilesystemRoot,
  isHardDeniedPath,
  isSensitivePath,
} from "./device-bridge-policy.ts"

export type PersistedConsentScope = "session" | "permanent"
export type PersistedConsentTool = "list_dir" | "read_file" | "grep" | "stat" | "*"

/** 持久化的單筆同意（**無任何憑證欄位**）。 */
export interface PersistedConsentEntry {
  /** 租戶（userId 字串）；與 DeviceBridge 的 tenant key 同一把。 */
  tenant: string
  /** 已同意的絕對路徑根（**保留原大小寫**，裝置端要逐字比對）。 */
  root: string
  scope: PersistedConsentScope
  tool: PersistedConsentTool
  /** 到期時間（epoch ms）；載入時 <= now 即丟棄。 */
  expiresAt: number
}

const FILE_NAME = "device-bridge-session-consent.json"
const STORE_VERSION = 1
/** 預設 TTL 12h（spec 建議值）。 */
export const DEFAULT_SESSION_CONSENT_TTL_MS = 12 * 60 * 60 * 1000
/** 載入筆數上限（防被灌爆的檔案把記憶體吃爆）。 */
const MAX_LOADED_ENTRIES = 512

const CONSENT_TOOLS: readonly PersistedConsentTool[] = ["list_dir", "read_file", "grep", "stat", "*"]

/** TTL 讀取：非有限／<=0 → 預設 12h。 */
export function sessionConsentTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(String(env.EIMU_DEVICE_BRIDGE_SESSION_CONSENT_TTL_MS ?? ""), 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_CONSENT_TTL_MS
}

/**
 * 落點解析（優先序）：
 *   1. `EIMU_DEVICE_BRIDGE_CONSENT_FILE`（明確覆寫，測試／維運用）。
 *   2. `MEMORY_STATE_DIR/device-bridge-session-consent.json`（若設）。
 *   3. `dirname(realpath(SESSIONS_DB_PATH))`——生產 `sessions.db` 是「release 目錄 →
 *      狀態目錄」的 symlink，realpath 後即 `/opt/agent-harness/state`（與代碼目錄分離、
 *      不在 web 可服務目錄、不隨部署換版消失）。取不到（開發／尚未建庫）退回設定路徑目錄。
 */
export function defaultConsentFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.EIMU_DEVICE_BRIDGE_CONSENT_FILE ?? "").trim()
  if (explicit) return explicit
  const stateDir = String(env.MEMORY_STATE_DIR ?? "").trim()
  if (stateDir) return join(stateDir, FILE_NAME)
  const dbPath = String(env.SESSIONS_DB_PATH ?? "").trim() || "/opt/agent-harness/gateway/sessions.db"
  let dir = dirname(dbPath)
  try {
    dir = dirname(realpathSync(dbPath))
  } catch {
    // sessions.db 尚未建立：退回設定路徑目錄。
  }
  return join(dir, FILE_NAME)
}

/** 會話同意的本地單檔儲存（純 IO，無業務判定；判定由 DeviceBridge 接線）。 */
export class SessionConsentStore {
  private readonly filePath: string
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(opts: { filePath?: string; ttlMs?: number; now?: () => number; env?: NodeJS.ProcessEnv } = {}) {
    const env = opts.env ?? process.env
    this.filePath = opts.filePath && opts.filePath.trim() ? opts.filePath : defaultConsentFilePath(env)
    this.ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : sessionConsentTtlMs(env)
    this.now = opts.now ?? (() => Date.now())
  }

  /** 供運維／測試辨識落點（非敏感）。 */
  get path(): string {
    return this.filePath
  }

  /** 讀回「未過期且通過安全複核」的同意記錄；任何錯誤＝空集（fail-safe，不拋）。 */
  load(): PersistedConsentEntry[] {
    const parsed = this.readFile()
    if (!parsed) return []
    const now = this.now()
    const out: PersistedConsentEntry[] = []
    const seen = new Set<string>()
    for (const raw of parsed) {
      if (out.length >= MAX_LOADED_ENTRIES) break
      const entry = this.sanitizeEntry(raw, now)
      if (!entry) continue
      const key = `${entry.tenant}\u0000${entry.scope}\u0000${entry.tool}\u0000${entry.root}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(entry)
    }
    return out
  }

  /**
   * 記一筆同意（同 tenant+scope+tool+root 覆寫到期時間）並立即原子落盤。
   * 安全複核不通過（非絕對／檔案系統根／硬 denylist／敏感）→ 靜默略過，**不落盤**。
   */
  record(entry: { tenant: string; root: string; scope: PersistedConsentScope; tool: PersistedConsentTool }): void {
    const now = this.now()
    const sanitized = this.sanitizeEntry({ ...entry, expiresAt: now + this.ttlMs }, now)
    if (!sanitized) return
    const kept = this.load().filter(
      (e) =>
        !(
          e.tenant === sanitized.tenant &&
          e.scope === sanitized.scope &&
          e.tool === sanitized.tool &&
          e.root === sanitized.root
        ),
    )
    kept.push(sanitized)
    this.writeFile(kept)
  }

  /** 清空落盤（運維／測試；不影響行程內狀態）。 */
  clear(): void {
    this.writeFile([])
  }

  private readFile(): unknown[] | null {
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown
      if (typeof data !== "object" || data === null) return null
      const entries = (data as { entries?: unknown }).entries
      return Array.isArray(entries) ? entries : null
    } catch {
      return null
    }
  }

  /** 逐欄驗證；任一不合法 → null（不落盤、不載入）。 */
  private sanitizeEntry(raw: unknown, now: number): PersistedConsentEntry | null {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const tenant = typeof r.tenant === "string" && r.tenant.trim().length > 0 ? r.tenant.trim() : null
    if (!tenant) return null
    const scope = r.scope
    if (scope !== "session" && scope !== "permanent") return null
    const tool = CONSENT_TOOLS.includes(r.tool as PersistedConsentTool) ? (r.tool as PersistedConsentTool) : null
    if (!tool) return null
    const rootRaw = r.root
    if (typeof rootRaw !== "string" || rootRaw.trim().length === 0) return null
    // 載入即安全複核：被竄改的檔不得載入檔案系統根／硬 denylist／敏感根。
    if (isFilesystemRoot(rootRaw) || isHardDeniedPath(rootRaw) || isSensitivePath(rootRaw)) return null
    const root = expandToAbsolutePreserveCase(rootRaw, null)
    if (!root) return null
    const expiresAt = typeof r.expiresAt === "number" && Number.isFinite(r.expiresAt) ? r.expiresAt : 0
    if (expiresAt <= now) return null
    return { tenant, root, scope, tool, expiresAt }
  }

  /** 原子寫入：同目錄暫存（0600）→ rename 覆蓋；失敗只記路徑層級、不拋。 */
  private writeFile(entries: PersistedConsentEntry[]): void {
    const tmp = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, entries }, null, 2), { encoding: "utf8", mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.filePath)
    } catch (err) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* 清暫存失敗可忽略 */
      }
      console.error(
        `[device-bridge] session consent persist failed: ${dirname(this.filePath)}`,
        (err as Error)?.name ?? "Error",
      )
    }
  }
}
