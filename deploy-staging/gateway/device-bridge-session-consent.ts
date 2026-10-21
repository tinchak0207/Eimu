// device-bridge-session-consent.ts — W6 装置桥云端侧：**会话同意**的行程外持久化。
//
// 背景（2026-10-04 真壳定位，缺陷 2）：`DeviceBridge` 的 `sessionRules`／`sessionConsent`
// 是行程内 `Map`，gateway 一重启（每次部署）就清空，已 `session` 授权的子目录立刻回
// `needs_authorization`——「同意」在使用者眼中是会话级的，却活不过一次部署。
// 本档把 **session 同意的根**（连同 permanent，保留其原 scope）落 gateway 本地单档，
// 启动时载入、由 DeviceBridge 重建规则与同意记录。
//
// 纪律（逐条对应 spec 硬要求）：
//   - **只存** tenant id ＋ root 路径 ＋ scope ＋ tool ＋ 到期时间；**绝不存任何
//     token／凭证／session id**（档内出现即违规）。
//   - **原子写入**：同目录暂存档 → `rename` 覆盖；权限 0600（写入后再 chmod 一次，
//     不受进程 umask 影响）。
//   - **有 TTL**（预设 12h，`EIMU_DEVICE_BRIDGE_SESSION_CONSENT_TTL_MS` 可覆写）；
//     载入时丢弃过期项。
//   - **`once` 不进本档**：一次性授权走 `OnceGrantStore` 核销，重启即失效。
//   - **不升级同意**：`session` 记录永远以 `scope:"session"` 读回，绝不因落盘而变成
//     permanent（permanent 只在使用者明确选择时才以 permanent 名义下发装置落盘）。
//   - **载入即安全复核**：每个 root 重新过 policy 的档案系统根／硬 denylist／敏感集合；
//     即使档案被窜改，敏感根也载入不进（denylist 重启后仍硬拒）。
//   - **落点**＝gateway 执行时状态目录（与 `sessions.db` 同目录者；部署目录每次换版、
//     状态目录不随版本搬移），**不在 web 可服务目录**下。
//   - 任何 IO 失败只以「档名层级」记 log、**不抛**：持久化失败只等于退回「重启即忘」的
//     旧行为，绝不得让授权流程挂掉。

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

/** 持久化的单笔同意（**无任何凭证栏位**）。 */
export interface PersistedConsentEntry {
  /** 租户（userId 字串）；与 DeviceBridge 的 tenant key 同一把。 */
  tenant: string
  /** 已同意的绝对路径根（**保留原大小写**，装置端要逐字比对）。 */
  root: string
  scope: PersistedConsentScope
  tool: PersistedConsentTool
  /** 到期时间（epoch ms）；载入时 <= now 即丢弃。 */
  expiresAt: number
}

const FILE_NAME = "device-bridge-session-consent.json"
const STORE_VERSION = 1
/** 预设 TTL 12h（spec 建议值）。 */
export const DEFAULT_SESSION_CONSENT_TTL_MS = 12 * 60 * 60 * 1000
/** 载入笔数上限（防被灌爆的档案把记忆体吃爆）。 */
const MAX_LOADED_ENTRIES = 512

const CONSENT_TOOLS: readonly PersistedConsentTool[] = ["list_dir", "read_file", "grep", "stat", "*"]

/** TTL 读取：非有限／<=0 → 预设 12h。 */
export function sessionConsentTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(String(env.EIMU_DEVICE_BRIDGE_SESSION_CONSENT_TTL_MS ?? ""), 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_CONSENT_TTL_MS
}

/**
 * 落点解析（优先序）：
 *   1. `EIMU_DEVICE_BRIDGE_CONSENT_FILE`（明确覆写，测试／维运用）。
 *   2. `MEMORY_STATE_DIR/device-bridge-session-consent.json`（若设）。
 *   3. `dirname(realpath(SESSIONS_DB_PATH))`——生产 `sessions.db` 是「release 目录 →
 *      状态目录」的 symlink，realpath 后即 `/opt/agent-harness/state`（与代码目录分离、
 *      不在 web 可服务目录、不随部署换版消失）。取不到（开发／尚未建库）退回设定路径目录。
 */
export function defaultConsentFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.EIMU_DEVICE_BRIDGE_CONSENT_FILE ?? "").trim()
  if (explicit) return explicit
  const stateDir = String(env.MEMORY_STATE_DIR ?? "").trim()
  if (stateDir) return join(stateDir, FILE_NAME)
  const dbPath = String(env.SESSIONS_DB_PATH ?? "").trim() || "/opt/agent-harness/state/sessions.db"
  let dir = dirname(dbPath)
  try {
    dir = dirname(realpathSync(dbPath))
  } catch {
    // sessions.db 尚未建立：退回设定路径目录。
  }
  return join(dir, FILE_NAME)
}

/** 会话同意的本地单档储存（纯 IO，无业务判定；判定由 DeviceBridge 接线）。 */
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

  /** 供运维／测试辨识落点（非敏感）。 */
  get path(): string {
    return this.filePath
  }

  /** 读回「未过期且通过安全复核」的同意记录；任何错误＝空集（fail-safe，不抛）。 */
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
   * 记一笔同意（同 tenant+scope+tool+root 覆写到期时间）并立即原子落盘。
   * 安全复核不通过（非绝对／档案系统根／硬 denylist／敏感）→ 静默略过，**不落盘**。
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

  /** 清空落盘（运维／测试；不影响行程内状态）。 */
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

  /** 逐栏验证；任一不合法 → null（不落盘、不载入）。 */
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
    // 载入即安全复核：被窜改的档不得载入档案系统根／硬 denylist／敏感根。
    if (isFilesystemRoot(rootRaw) || isHardDeniedPath(rootRaw) || isSensitivePath(rootRaw)) return null
    const root = expandToAbsolutePreserveCase(rootRaw, null)
    if (!root) return null
    const expiresAt = typeof r.expiresAt === "number" && Number.isFinite(r.expiresAt) ? r.expiresAt : 0
    if (expiresAt <= now) return null
    return { tenant, root, scope, tool, expiresAt }
  }

  /** 原子写入：同目录暂存（0600）→ rename 覆盖；失败只记路径层级、不抛。 */
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
        /* 清暂存失败可忽略 */
      }
      console.error(
        `[device-bridge] session consent persist failed: ${dirname(this.filePath)}`,
        (err as Error)?.name ?? "Error",
      )
    }
  }
}
