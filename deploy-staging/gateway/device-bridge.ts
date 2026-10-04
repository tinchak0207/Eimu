// device-bridge.ts — W6a：裝置橋**雲端側**（閘道端）。
//
// 目的：讓**雲端 agent** 經由使用者機器的**出站連線**讀本機檔案——雲端永不 inbound
// 打使用者機器；方向永遠是「本機 daemon 主動對外註冊／心跳／輪詢，取回雲端下發的
// 工作，執行後把**必要片段**回傳」。本檔實作閘道這半邊：把「本機檔案工具」呼叫
// 轉下去、驗同意票、夾大小、逾時取消。
//
// 為什麼要這一層（第一性原理）：agent 的推理在雲端，檔案在使用者機器；主流解法是
// 「檔案 I/O 留在本機、只把 agent 實際打開的那一小片內容回填」——companion daemon
// ＋出站通道正是這條。這與「把整個 repo 搬上雲」是兩個極端。
//
// ── 預設 OFF（硬性）─────────────────────────────────────────────────────
// 總開關＝env `EIMU_DEVICE_BRIDGE`。未設／非 truthy（1/true/yes/on）＝整個能力不掛載：
// router 連路由前綴都不進（見 router.ts 的 `deviceBridgeEnabled()` 閘），對既有生產
// 行為零影響。開啟方式：`EIMU_DEVICE_BRIDGE=1`（通常寫進 VPS systemd 的 gateway env）。
//
// ── 鑑權（複用，不造第二套）─────────────────────────────────────────────
// 裝置端與雲端 agent 都走**既有** Bearer sk-biz-* 閘門：router 已完成
// validateApiKey + resolveCanonicalKey；本檔再用 auth-gw 的 resolveCanonicalIdentity
// 取 userId（正典化緩存命中，幾乎零成本），綁定 userId ↔ deviceId ↔ connection。
//
// ── 安全模型 ────────────────────────────────────────────────────────────
//   1. 工具面收斂成最小集合 list_dir/read_file/grep/stat（無寫/刪/執行）。
//   2. 伺服器側 denylist（device-bridge-policy.isSensitivePath）：路徑敏感一律拒，
//      不倚賴本機端自報（縱深防禦）。
//   3. 逐次同意票（consent token）：每次下發一票，單次可用、綁
//      deviceId+tool+requestId、短 TTL；本機端**執行前驗票**，閘道端在回傳時再驗
//      （過期／不匹配／重放各回明確錯誤碼）。
//   4. 回傳內容大小硬上限 MAX_READ_BYTES（256KB）＋截斷標記。
//   5. 請求逾時可取消，回 `device_request_timeout`。
//   6. H2（2026-10-04）遞迴根夾制：`grep`/`list_dir` 會由裝置**遞迴**收集檔案，
//      雲端看不到收集結果，故要求裝置在 register 回報使用者已授權根（`roots`），
//      遞迴根必須落在授權根之下；檔案系統根（`/`、Windows 磁碟根、UNC share）一律拒。
//      未授權任何根 ⇒ 遞迴型工具全拒（fail-closed）。
//   7. H2 輸入側契約：`grep` 隨參數下發 `max_file_bytes`（單檔讀入上限
//      MAX_FILE_READ_BYTES=1MB，裝置端遵守）；裝置若自報遞迴觸碰敏感段
//      （`sensitive_path_touched`／`excluded_sensitive_count`／`sensitive_paths`），
//      雲端整筆拒絕、結果不落地。
//
// 本檔只准動 deploy-staging/gateway/ 之下；未部署、未接 VPS。

import { memoryEnvBool } from "./constants-gateway.ts"
import { hashKey, resolveCanonicalIdentity } from "./auth-gw.ts"
import {
  MAX_READ_BYTES,
  authorizationRootProblem,
  authorizationRuleSpecifier,
  clampFileBytes,
  clampReadSize,
  evaluatePermission,
  expandToAbsolute,
  expandToAbsolutePreserveCase,
  isDeviceBridgeMode,
  isHardDeniedPath,
  isSensitivePath,
  isToolAllowed,
  recursiveRootProblem,
  sanitizeAuthorizedRoots,
  sanitizePermissionRules,
  sensitiveResultProblem,
  suggestAuthorizationRoot,
  truncateWithMarker,
  type DeviceBridgeMode,
  type DeviceBridgeTool,
  type PermissionRule,
  type PermissionTool,
} from "./device-bridge-policy.ts"

// ── 開關／時序常數 ──────────────────────────────────────────────────────

/** 總開關：預設 OFF。任何非空呼叫都會經過這條，未開啟時能力不存在。 */
export function deviceBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return memoryEnvBool(env.EIMU_DEVICE_BRIDGE, false)
}

/** 裝置心跳有效期；超過視為離線，invoke 直接回 device_offline。 */
export const DEVICE_HEARTBEAT_TTL_MS = Number.parseInt(process.env.EIMU_DEVICE_BRIDGE_HEARTBEAT_TTL_MS || "90000", 10) || 90_000
/** 單次呼叫等待裝置回傳的上限；到點取消並回 device_request_timeout。 */
export const DEVICE_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.EIMU_DEVICE_BRIDGE_REQUEST_TIMEOUT_MS || "30000", 10) || 30_000
/** 同意票 TTL（>= 請求逾時，否則票比請求先死）。 */
export const DEVICE_CONSENT_TTL_MS = Number.parseInt(process.env.EIMU_DEVICE_BRIDGE_CONSENT_TTL_MS || "45000", 10) || 45_000
/** 一次性授權許可（scope=once）TTL。 */
export const DEVICE_ONCE_GRANT_TTL_MS = Number.parseInt(process.env.EIMU_DEVICE_BRIDGE_ONCE_GRANT_TTL_MS || "120000", 10) || 120_000
/** 輪詢長連線上界（<= 閘道 idleTimeout 255s）。 */
export const DEVICE_POLL_MAX_WAIT_MS = 25_000

export type DeviceBridgeErrorCode =
  | "bad_request"
  | "tool_not_allowed"
  | "sensitive_path"
  | "path_not_authorized"
  | "permission_denied"
  | "mode_off"
  | "needs_authorization"
  | "device_offline"
  | "device_connection_stale"
  | "device_request_timeout"
  | "device_request_not_found"
  | "device_op_failed"
  | "consent_token_not_found"
  | "consent_token_expired"
  | "consent_token_mismatch"
  | "consent_token_replayed"

export type ConsentTokenError = Extract<DeviceBridgeErrorCode, `consent_token_${string}`>
export type OnceGrantError =
  | "authorization_token_not_found"
  | "authorization_token_expired"
  | "authorization_token_mismatch"
  | "authorization_token_replayed"

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`
}

/**
 * 把 evaluatePermission 的 ask 成因映射成 needs_authorization 的 reason。
 * 凍結四值為 safety_check／outside_roots／mode_ask（＋ denylist 不進此路徑）；
 * 規則明確 ask 另用 `rule_ask`（擴充值，消費端遇到未知值應走預設）。
 */
function mapAskReason(reason: string): string {
  switch (reason) {
    case "safety_check":
      return "safety_check"
    case "outside_roots":
      return "outside_roots"
    case "rule_ask":
      return "rule_ask"
    default:
      return "mode_ask"
  }
}

const AUTHORIZATION_SCOPES = ["once", "session", "permanent"] as const
type AuthorizationScope = (typeof AUTHORIZATION_SCOPES)[number]
function isAuthorizationScope(v: unknown): v is AuthorizationScope {
  return typeof v === "string" && (AUTHORIZATION_SCOPES as readonly string[]).includes(v)
}

// ── 同意票（逐次、單用、綁定）──────────────────────────────────────────

export interface ConsentTokenRecord {
  token: string
  deviceId: string
  tool: string
  requestId: string
  expiresAt: number
  used: boolean
}

export interface ConsentTokenBinding {
  deviceId: string
  tool: string
  requestId: string
}

/**
 * 逐次同意票存放區。純記憶體（與 gateway 其餘會話狀態同款）。
 * mint 產生票；consume 原子地驗證並標記已用（單次）。
 * 驗證順序：找不到 → 過期 → 綁定不匹配 → 已用（重放）。
 * `now` 可注入，測試免睡。
 */
export class ConsentTokenStore {
  private readonly tokens = new Map<string, ConsentTokenRecord>()

  mint(binding: ConsentTokenBinding, ttlMs: number, now: number = Date.now()): string {
    const token = randomId("ct")
    this.tokens.set(token, {
      token,
      deviceId: binding.deviceId,
      tool: binding.tool,
      requestId: binding.requestId,
      expiresAt: now + Math.max(1, Math.floor(ttlMs)),
      used: false,
    })
    return token
  }

  consume(
    token: unknown,
    expected: ConsentTokenBinding,
    now: number = Date.now(),
  ): { ok: true } | { ok: false; code: ConsentTokenError } {
    if (typeof token !== "string" || token.length === 0) return { ok: false, code: "consent_token_not_found" }
    const rec = this.tokens.get(token)
    if (!rec) return { ok: false, code: "consent_token_not_found" }
    if (rec.expiresAt <= now) {
      this.tokens.delete(token)
      return { ok: false, code: "consent_token_expired" }
    }
    if (rec.deviceId !== expected.deviceId || rec.tool !== expected.tool || rec.requestId !== expected.requestId) {
      return { ok: false, code: "consent_token_mismatch" }
    }
    if (rec.used) return { ok: false, code: "consent_token_replayed" }
    rec.used = true
    return { ok: true }
  }

  prune(now: number = Date.now()): void {
    for (const [token, rec] of this.tokens) {
      if (rec.expiresAt <= now || rec.used) this.tokens.delete(token)
    }
  }

  size(): number {
    return this.tokens.size
  }
}

// ── 一次性授權許可（scope=once）──────────────────────────────────────────
//
// 為什麼獨立於同意票：同意票管「一次下發的工作」，授權許可管「一次路徑授權」。
// authorize(scope=once) 產生一枚許可；下一次 invoke 帶 `authorization_token` 使用它，
// 用一次即失效（重放被拒）。綁定 tenant＋（可選 tool）＋root（路徑必須落在 root 之下）。

export interface OnceGrantRecord {
  token: string
  tenant: string
  root: string
  tool: PermissionTool | null
  expiresAt: number
  used: boolean
}

export interface OnceGrantBinding {
  tenant: string
  tool: string
  path: string
}

export class OnceGrantStore {
  private readonly grants = new Map<string, OnceGrantRecord>()

  mint(binding: { tenant: string; root: string; tool?: PermissionTool | null }, ttlMs: number, now: number = Date.now()): string {
    const token = randomId("ag")
    this.grants.set(token, {
      token,
      tenant: binding.tenant,
      root: binding.root,
      tool: binding.tool ?? null,
      expiresAt: now + Math.max(1, Math.floor(ttlMs)),
      used: false,
    })
    return token
  }

  consume(token: unknown, expected: OnceGrantBinding, now: number = Date.now()): { ok: true } | { ok: false; code: OnceGrantError } {
    if (typeof token !== "string" || token.length === 0) return { ok: false, code: "authorization_token_not_found" }
    const rec = this.grants.get(token)
    if (!rec) return { ok: false, code: "authorization_token_not_found" }
    if (rec.expiresAt <= now) {
      this.grants.delete(token)
      return { ok: false, code: "authorization_token_expired" }
    }
    const toolOk = rec.tool === null || rec.tool === expected.tool
    const path = expandToAbsolute(expected.path, null) ?? expected.path
    const rootOk = isHardDeniedPath(expected.path) ? false : pathWithin(rec.root, path)
    if (rec.tenant !== expected.tenant || !toolOk || !rootOk) {
      return { ok: false, code: "authorization_token_mismatch" }
    }
    if (rec.used) return { ok: false, code: "authorization_token_replayed" }
    rec.used = true
    return { ok: true }
  }

  /**
   * 自動核銷：呼叫端（opencode 的 local_files）**從不下發** authorization_token，故在規則
   * 未放行時主動找一筆相符的一次性許可並核銷——`root` 含 `path`、`tool` 相符（或未綁定）、
   * 未過期、未使用。命中即標記已用並回該許可的根；找不到回 `{ ok:false }`（呼叫端維持
   * needs_authorization）。語義與 `consume` 一致：**用一次即失效**，不得重複放行。
   */
  consumeMatching(expected: OnceGrantBinding, now: number = Date.now()): { ok: true; root: string } | { ok: false } {
    const path = expandToAbsolute(expected.path, null) ?? expected.path
    if (isHardDeniedPath(expected.path)) return { ok: false }
    for (const [token, rec] of this.grants) {
      if (rec.used) continue
      if (rec.expiresAt <= now) {
        this.grants.delete(token)
        continue
      }
      if (rec.tenant !== expected.tenant) continue
      if (!(rec.tool === null || rec.tool === expected.tool)) continue
      if (!pathWithin(rec.root, path)) continue
      rec.used = true
      return { ok: true, root: rec.root }
    }
    return { ok: false }
  }

  size(): number {
    return this.grants.size
  }
}

/** 路徑是否落在 root 之內（含相等）；兩者皆先歸一化，相對路徑一律 false。 */
function pathWithin(root: string, path: string): boolean {
  const r = expandToAbsolute(root, null)
  const p = expandToAbsolute(path, null)
  if (!r || !p) return false
  const rs = r.split("/").filter(Boolean)
  const ps = p.split("/").filter(Boolean)
  if (rs.length === 0 || ps.length < rs.length) return false
  for (let i = 0; i < rs.length; i++) if (rs[i] !== ps[i]) return false
  return true
}

// ── 裝置註冊表 ─────────────────────────────────────────────────────────

export interface DeviceRecord {
  deviceId: string
  tenant: string
  userId: number | null
  apiKeyHash: string
  connectionId: string
  /**
   * H2：使用者在本機端「逐次挑選／授權」的根（絕對路徑）。`grep`/`list_dir` 是遞迴型
   * 工具，雲端無法列舉裝置上遞迴會收到哪些檔，故把遞迴根夾在這些根之下（見
   * device-bridge-policy.recursiveRootProblem）。空陣列＝未授權任何根 ⇒ 遞迴型工具一律拒
   * （fail-closed；裝置需在 register 帶 `roots` 才啟用）。
   */
  authorizedRoots: string[]
  /**
   * W6b：本機檔案權限模式（per-device，隨 register 上報；預設 `ask`）。
   * 只有 `permissionsEnabled===true`（呼叫端**明確**送了 mode 或 rules）時，新的決策
   * 引擎才生效；未送時維持升級前行為（denylist ＋ 遞迴根夾制），保證既有呼叫端不受影響。
   */
  mode: DeviceBridgeMode
  /** 是否啟用新決策引擎（呼叫端明確送了 mode／rules）。false＝沿用升級前行為。 */
  permissionsEnabled: boolean
  /** register 帶入的裝置級規則（session 級規則另存 `sessionRules`）。 */
  rules: PermissionRule[]
  /** 裝置自報的家目錄（full 模式的放行範圍、`~` 展開用）；未上報＝null。 */
  home: string | null
  registeredAt: number
  lastSeenAt: number
}

/** needs_authorization 的附帶資訊（供 HTTP 邊界組 body）。 */
export interface NeedsAuthorizationInfo {
  root: string
  reason: string
  options: { scope: "once" | "session" | "permanent" }[]
}

export const AUTHORIZATION_OPTIONS: { scope: "once" | "session" | "permanent" }[] = [
  { scope: "once" },
  { scope: "session" },
  { scope: "permanent" },
]

export interface DeviceRequestMessage {
  request_id: string
  tool: DeviceBridgeTool
  args: Record<string, unknown>
  consent_token: string
  issued_at: number
  expires_at: number
  /** 使用者在對話中授權（authorize 端點）產生的同意記錄，供裝置端落地。
   *  session/permanent 會隨其後每次 invoke 重送（冪等）；once 只出現在核銷成功的那一則。 */
  consent?: { scope: "once" | "session" | "permanent"; roots: string[] }
}

export type InvokeResult =
  | { ok: true; requestId: string; tool: DeviceBridgeTool; result: Record<string, unknown>; truncated: boolean; bytes: number }
  | { ok: false; code: DeviceBridgeErrorCode; message: string; requestId?: string; needsAuthorization?: NeedsAuthorizationInfo }

/**
 * 依租戶挑一台裝置（內部路由的**尋址**步驟）。語義刻意保守、**不猜**：
 *   - 該租戶 0 台已註冊裝置 → `no_device_registered`
 *   - 恰好 1 台：在線 → 回它；離線 → `device_offline`
 *   - 多台：恰 1 台在線 → 回那台；0 台或 >1 台在線（含全部離線）→ `device_ambiguous`
 * 在線判定沿用既有心跳 TTL（`DEVICE_HEARTBEAT_TTL_MS`／建構子覆寫）。
 */
export type PickDeviceResult =
  | { ok: true; deviceId: string }
  | { ok: false; code: "no_device_registered" | "device_offline" | "device_ambiguous"; message: string }

/** 唯讀裝置概況（/internal/device/status 用）。 */
export interface TenantDeviceDescription {
  online: boolean
  roots: string[]
  lastHeartbeatMs: number
}

interface PendingRequest {
  requestId: string
  tenant: string
  deviceId: string
  message: DeviceRequestMessage
  settled: boolean
  timer: ReturnType<typeof setTimeout> | null
  resolve: (r: InvokeResult) => void
}

/**
 * 長輪詢 waiter。**必須綁 connectionId**：同 deviceKey 重連（換連線）時舊 waiter 仍留在
 * `pollWaiters` 內，若只在進入等待前驗一次 connectionId，它醒後會把新連線的請求 shift 走、
 * 回給已 abort 的舊 HTTP（幽靈 waiter 吞第一發）。喚醒後一律重驗連線，不符者不得取件
 * （已取則 re-queue），並以 `device_connection_stale` 收場。
 */
interface PollWaiter {
  tenant: string
  deviceId: string
  connectionId: string
  timer: ReturnType<typeof setTimeout> | null
  wake: () => void
}

// ── 參數淨化（每個工具的最小白名單欄位 + 夾制）─────────────────────────

export interface SanitizeOk { ok: true; args: Record<string, unknown> }
export interface SanitizeErr { ok: false; code: DeviceBridgeErrorCode; message: string }

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null
}

function asIntInRange(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : Number.NaN
  if (!Number.isFinite(n)) return null
  const i = Math.floor(n)
  if (i < min || i > max) return null
  return i
}

/**
 * 只放行該工具需要的欄位，其餘丟棄；敏感路徑在此就被擋下。
 *
 * H2（2026-10-04）：`grep`/`list_dir` 是**遞迴型**工具，除了請求路徑本身的 denylist，
 * 還必須把遞迴根夾在裝置回報的 `authorizedRoots` 之下（`opts.authorizedRoots`）；
 * 無授權根 ⇒ 遞迴型工具一律拒（fail-closed）。`read_file`/`stat` 是單檔操作，不受此限
 * （單檔 denylist 已足）。
 */
export function sanitizeToolArgs(
  tool: DeviceBridgeTool,
  raw: unknown,
  opts?: { authorizedRoots?: unknown; deferRecursiveRootCheck?: boolean },
): SanitizeOk | SanitizeErr {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, code: "bad_request", message: "args must be an object" }
  }
  const r = raw as Record<string, unknown>
  const p = asString(r.path)
  if (!p) return { ok: false, code: "bad_request", message: "args.path is required" }
  // W6b：硬 denylist（全域不可繞；只加嚴既有敏感判定）。任何模式／規則都不得放行。
  if (isHardDeniedPath(p) || isSensitivePath(p)) return { ok: false, code: "sensitive_path", message: "path is denied by policy" }

  switch (tool) {
    case "list_dir": {
      if (!opts?.deferRecursiveRootCheck) {
        const problem = recursiveRootProblem(p, opts?.authorizedRoots)
        if (problem) return { ok: false, code: "path_not_authorized", message: `list_dir root denied: ${problem}` }
      }
      const args: Record<string, unknown> = { path: p }
      if (r.max_entries !== undefined) {
        const n = asIntInRange(r.max_entries, 1, 2000)
        if (n === null) return { ok: false, code: "bad_request", message: "max_entries must be 1..2000" }
        args.max_entries = n
      }
      return { ok: true, args }
    }
    case "read_file": {
      const args: Record<string, unknown> = { path: p, offset: 0, limit: clampReadSize(r.limit) }
      if (r.offset !== undefined) {
        const off = asIntInRange(r.offset, 0, Number.MAX_SAFE_INTEGER)
        if (off === null) return { ok: false, code: "bad_request", message: "offset must be a non-negative integer" }
        args.offset = off
      }
      return { ok: true, args }
    }
    case "grep": {
      const pattern = asString(r.pattern)
      if (!pattern) return { ok: false, code: "bad_request", message: "args.pattern is required" }
      if (!opts?.deferRecursiveRootCheck) {
        const problem = recursiveRootProblem(p, opts?.authorizedRoots)
        if (problem) return { ok: false, code: "path_not_authorized", message: `grep root denied: ${problem}` }
      }
      // max_file_bytes：H2 輸入側契約——逐檔讀入上限（裝置端遵守）。
      const args: Record<string, unknown> = { path: p, pattern, max_matches: 100, max_file_bytes: clampFileBytes(r.max_file_bytes) }
      if (r.max_matches !== undefined) {
        const n = asIntInRange(r.max_matches, 1, 500)
        if (n === null) return { ok: false, code: "bad_request", message: "max_matches must be 1..500" }
        args.max_matches = n
      }
      return { ok: true, args }
    }
    case "stat":
      return { ok: true, args: { path: p } }
    default:
      return { ok: false, code: "tool_not_allowed", message: `tool not allowed: ${String(tool)}` }
  }
}

/** 把裝置回傳的結構化結果套上 256KB 硬上限與截斷標記。 */
export function finalizeDeviceResult(raw: unknown): { result: Record<string, unknown>; truncated: boolean; bytes: number } {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : { value: raw }
  // read_file 家族：直接夾其中的 text 欄位，保留 offset 等後設欄位。
  if (typeof obj.text === "string") {
    const t = truncateWithMarker(obj.text, MAX_READ_BYTES)
    const result: Record<string, unknown> = { ...obj, text: t.text, truncated: t.truncated }
    if (t.truncated) result.truncated_bytes = t.originalBytes - t.keptBytes
    return { result, truncated: t.truncated, bytes: t.keptBytes }
  }
  const serialized = JSON.stringify(obj)
  const t = truncateWithMarker(serialized, MAX_READ_BYTES)
  if (!t.truncated) return { result: obj, truncated: false, bytes: t.originalBytes }
  return { result: { truncated: true, truncated_bytes: t.originalBytes - t.keptBytes, text: t.text }, truncated: true, bytes: t.keptBytes }
}

// ── 橋本體 ─────────────────────────────────────────────────────────────

export class DeviceBridge {
  private readonly devices = new Map<string, DeviceRecord>()
  private readonly byConnection = new Map<string, string>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly queue = new Map<string, string[]>()
  private readonly pollWaiters = new Set<PollWaiter>()
  readonly tokens = new ConsentTokenStore()
  readonly grants = new OnceGrantStore()
  /** session 級規則（記憶體，key＝tenant；只存在本進程，**不持久化到共享庫**）。 */
  private readonly sessionRules = new Map<string, PermissionRule[]>()
  /**
   * 對話內授權的**同意記錄**（key＝tenant）：session/permanent 各記一筆，供 invoke 隨訊息
   * 送到裝置落地（裝置端只認自己的 mode/rules/roots，不知道雲端對話發生了什麼）。
   * 去重、上限 64。`once` **不進此表**（走 OnceGrantStore 的一次性核銷）。
   */
  private readonly sessionConsent = new Map<string, { scope: "session" | "permanent"; root: string }[]>()

  constructor(private readonly opts: { requestTimeoutMs?: number; consentTtlMs?: number; heartbeatTtlMs?: number } = {}) {}

  private requestTimeoutMs(): number {
    return this.opts.requestTimeoutMs ?? DEVICE_REQUEST_TIMEOUT_MS
  }
  private consentTtlMs(): number {
    return this.opts.consentTtlMs ?? DEVICE_CONSENT_TTL_MS
  }
  private heartbeatTtlMs(): number {
    return this.opts.heartbeatTtlMs ?? DEVICE_HEARTBEAT_TTL_MS
  }
  private deviceKey(tenant: string, deviceId: string): string {
    return `${tenant}\u0000${deviceId}`
  }
  private getDevice(tenant: string, deviceId: string): DeviceRecord | undefined {
    return this.devices.get(this.deviceKey(tenant, deviceId))
  }

  // ── W6b：session 規則與權限狀態 ──────────────────────────────────────
  private tenantRules(tenant: string): PermissionRule[] {
    return this.sessionRules.get(tenant) ?? []
  }
  /** 裝置級規則 ＋ 該 tenant 的 session 規則（順序：裝置在前，session 在後）。 */
  private allRulesFor(rec: DeviceRecord): PermissionRule[] {
    return [...rec.rules, ...this.tenantRules(rec.tenant)]
  }
  /** 加一條 session 規則（authorize scope=session/permanent 用）。 */
  addSessionRule(tenant: string, rule: PermissionRule): void {
    const list = this.sessionRules.get(tenant) ?? []
    if (list.length >= 64) return
    list.push(rule)
    this.sessionRules.set(tenant, list)
  }
  /** 清掉某 tenant 的 session 規則（測試／會話結束用）。 */
  clearSessionRules(tenant: string): void {
    this.sessionRules.delete(tenant)
  }
  /** 記錄一筆對話內授權同意（session/permanent）；同 {scope,root} 去重，上限 64。 */
  addSessionConsent(tenant: string, entry: { scope: "session" | "permanent"; root: string }): void {
    const list = this.sessionConsent.get(tenant) ?? []
    if (list.some((e) => e.scope === entry.scope && e.root === entry.root)) return
    if (list.length >= 64) return
    list.push(entry)
    this.sessionConsent.set(tenant, list)
  }
  /** 該 tenant 目前的同意記錄（唯讀快照）。 */
  private tenantConsent(tenant: string): { scope: "session" | "permanent"; root: string }[] {
    return this.sessionConsent.get(tenant) ?? []
  }
  /** 清掉某 tenant 的同意記錄（測試／會話結束用）。 */
  clearSessionConsent(tenant: string): void {
    this.sessionConsent.delete(tenant)
  }
  /** 挑代表裝置（唯讀；與 describeTenantDevices 同一語義）。 */
  private representativeDevice(tenant: string, now: number): DeviceRecord | undefined {
    const mine = [...this.devices.values()].filter((r) => r.tenant === tenant)
    if (mine.length === 0) return undefined
    const picked = this.pickDeviceForTenant(tenant, now)
    if (picked.ok) return mine.find((r) => r.deviceId === picked.deviceId) ?? mine[0]
    return mine.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.deviceId.localeCompare(b.deviceId))[0]
  }
  /** 某租戶目前的權限狀態（mode ＋ 合併規則）；無裝置時回預設 ask 與該 tenant session 規則。 */
  permissionStateForTenant(tenant: string, now: number = Date.now()): { mode: DeviceBridgeMode; rules: PermissionRule[] } {
    const rep = this.representativeDevice(tenant, now)
    if (!rep) return { mode: "ask", rules: [...this.tenantRules(tenant)] }
    return { mode: rep.mode, rules: this.allRulesFor(rep) }
  }
  /** 某租戶代表裝置自報的家目錄（authorize 的 too_broad 判定用）；無＝null。 */
  homeForTenant(tenant: string, now: number = Date.now()): string | null {
    return this.representativeDevice(tenant, now)?.home ?? null
  }

  /**
   * 註冊：綁定 tenant(userId) ↔ deviceId ↔ connectionId。同裝置重註冊＝換連線（舊連線作廢）。
   * `roots`＝使用者已授權的絕對路徑根（H2 遞迴夾制用）；未帶／全非法＝空集 ⇒ grep/list_dir 全拒。
   */
  register(input: {
    tenant: string
    userId: number | null
    apiKeyHash: string
    deviceId?: string
    roots?: unknown
    mode?: unknown
    rules?: unknown
    home?: unknown
    now?: number
  }): {
    deviceId: string
    connectionId: string
    heartbeatIntervalMs: number
    pollUrl: string
    authorizedRoots: string[]
    mode: DeviceBridgeMode
    permissionsEnabled: boolean
  } {
    const now = input.now ?? Date.now()
    const deviceId = input.deviceId && input.deviceId.trim() ? input.deviceId.trim().slice(0, 128) : randomId("dev")
    const key = this.deviceKey(input.tenant, deviceId)
    const prev = this.devices.get(key)
    if (prev) {
      this.byConnection.delete(prev.connectionId)
      // 換連線＝舊連線關閉：喚醒並清掉它殘留的長輪詢 waiter。它醒後重驗 connectionId 會回
      // stale，不會取走新連線的請求（否則幽靈 waiter 會吞掉重連後的第一發 invoke）。
      this.dropWaitersForConnection(prev.connectionId)
    }
    const connectionId = randomId("conn")
    // 相容策略：只有呼叫端**明確**給了 mode 或 rules 才啟用新決策引擎；否則維持升級前
    // 行為（denylist ＋ 遞迴根夾制）。缺省 mode 的「語義預設」仍為 `ask`（status 回報）。
    const modeRaw = input.mode
    const rules = sanitizePermissionRules(input.rules)
    const permissionsEnabled = isDeviceBridgeMode(modeRaw) || rules.length > 0
    const mode: DeviceBridgeMode = isDeviceBridgeMode(modeRaw) ? modeRaw : "ask"
    const home = typeof input.home === "string" && input.home.trim() ? input.home.trim() : null
    this.devices.set(key, {
      deviceId,
      tenant: input.tenant,
      userId: input.userId,
      apiKeyHash: input.apiKeyHash,
      connectionId,
      authorizedRoots: sanitizeAuthorizedRoots(input.roots),
      mode,
      permissionsEnabled,
      rules,
      home,
      registeredAt: now,
      lastSeenAt: now,
    })
    this.byConnection.set(connectionId, key)
    return {
      deviceId,
      connectionId,
      heartbeatIntervalMs: 30_000,
      pollUrl: "/agent/v1/device-bridge/poll",
      authorizedRoots: this.devices.get(key)!.authorizedRoots,
      mode,
      permissionsEnabled,
    }
  }

  /** 心跳：刷新 lastSeenAt；回待辦數。connectionId 不符＝換連線後舊連線不再有效。 */
  heartbeat(input: { tenant: string; deviceId: string; connectionId: string; now?: number }): {
    ok: boolean
    code?: DeviceBridgeErrorCode
    pendingCount: number
    serverTimeMs: number
  } {
    const now = input.now ?? Date.now()
    const rec = this.getDevice(input.tenant, input.deviceId)
    if (!rec) return { ok: false, code: "device_offline", pendingCount: 0, serverTimeMs: now }
    if (rec.connectionId !== input.connectionId) return { ok: false, code: "device_connection_stale", pendingCount: 0, serverTimeMs: now }
    rec.lastSeenAt = now
    return { ok: true, pendingCount: this.queue.get(this.deviceKey(input.tenant, input.deviceId))?.length ?? 0, serverTimeMs: now }
  }

  private isOnline(rec: DeviceRecord, now: number): boolean {
    return now - rec.lastSeenAt <= this.heartbeatTtlMs()
  }

  /**
   * 輪詢（出站長連線的本機端主動來取件）：有待辦立刻回；否則若 waitMs>0，
   * 等到有件或逾時（回 request:null）。本機端執行前必須驗 consent_token。
   */
  async poll(input: { tenant: string; deviceId: string; connectionId: string; waitMs?: number; now?: number }): Promise<
    { ok: true; request: DeviceRequestMessage | null } | { ok: false; code: DeviceBridgeErrorCode }
  > {
    const now = input.now ?? Date.now()
    const rec = this.getDevice(input.tenant, input.deviceId)
    if (!rec) return { ok: false, code: "device_offline" }
    if (rec.connectionId !== input.connectionId) return { ok: false, code: "device_connection_stale" }
    rec.lastSeenAt = now

    const key = this.deviceKey(input.tenant, input.deviceId)
    const take = (): DeviceRequestMessage | null => {
      const q = this.queue.get(key)
      while (q && q.length > 0) {
        const requestId = q.shift()!
        const p = this.pending.get(requestId)
        if (p && !p.settled) return p.message
      }
      return null
    }
    // 本條長輪詢此刻是否仍綁在有效連線上；重連＝換 connectionId ⇒ false。
    const connectionValid = (): boolean => {
      const r = this.getDevice(input.tenant, input.deviceId)
      return !!r && r.connectionId === input.connectionId
    }

    const first = take()
    if (first) return { ok: true, request: first }
    const waitMs = Math.max(0, Math.min(input.waitMs ?? 0, DEVICE_POLL_MAX_WAIT_MS))
    if (waitMs === 0) return { ok: true, request: null }

    const waiter: PollWaiter = {
      tenant: input.tenant,
      deviceId: input.deviceId,
      connectionId: input.connectionId,
      timer: null,
      wake: () => {},
    }
    await new Promise<void>((resolve) => {
      let done = false
      const wake = () => {
        if (done) return
        done = true
        this.pollWaiters.delete(waiter)
        if (waiter.timer) clearTimeout(waiter.timer)
        resolve()
      }
      waiter.wake = wake
      waiter.timer = setTimeout(wake, waitMs)
      this.pollWaiters.add(waiter)
    })

    // 喚醒後**重驗連線**：被重連取代的舊 waiter 不得把新連線剛下發的請求 shift 走、回給已
    // abort 的舊 HTTP。已取到件但連線已失效＝放回佇列頭（re-queue，不吞件），回 stale。
    const taken = take()
    if (!connectionValid()) {
      if (taken) this.requeueRequest(input.tenant, input.deviceId, taken.request_id)
      return { ok: false, code: "device_connection_stale" }
    }
    return { ok: true, request: taken }
  }

  /** 喚醒並清掉某連線殘留的長輪詢 waiter（連線關閉／被取代時呼叫；醒後重驗會回 stale）。 */
  private dropWaitersForConnection(connectionId: string): void {
    for (const w of [...this.pollWaiters]) {
      if (w.connectionId === connectionId) w.wake()
    }
  }

  /** 把已取出的請求放回該 deviceKey 佇列頭（waiter 醒後連線已失效時不得吞件）。 */
  private requeueRequest(tenant: string, deviceId: string, requestId: string): void {
    const key = this.deviceKey(tenant, deviceId)
    const q = this.queue.get(key) ?? []
    q.unshift(requestId)
    this.queue.set(key, q)
  }

  private notifyPoll(): void {
    for (const w of [...this.pollWaiters]) w.wake()
  }

  /** 逾時取消：清待辦與票，回明確錯誤碼。 */
  private cancelPending(requestId: string): void {
    const p = this.pending.get(requestId)
    if (!p) return
    p.settled = true
    if (p.timer) clearTimeout(p.timer)
    this.pending.delete(requestId)
    const q = this.queue.get(this.deviceKey(p.tenant, p.deviceId))
    if (q) {
      const i = q.indexOf(requestId)
      if (i >= 0) q.splice(i, 1)
    }
    p.resolve({ ok: false, code: "device_request_timeout", message: "device did not answer before timeout", requestId })
  }

  /**
   * 雲端 agent 發起一次本機檔案操作：驗工具白名單與路徑 denylist → 檢查裝置在線 →
   * 下發請求（帶逐次同意票）→ 等裝置回傳或逾時。
   */
  async invoke(input: {
    tenant: string
    deviceId: string
    tool: unknown
    args?: unknown
    timeoutMs?: number
    /** scope=once 的一次性授權許可（authorize 端點簽發）。 */
    authorizationToken?: unknown
  }): Promise<InvokeResult> {
    if (!isToolAllowed(input.tool)) {
      return { ok: false, code: "tool_not_allowed", message: `tool not allowed: ${String(input.tool)}` }
    }
    const tool = input.tool
    // H2：遞迴型工具（grep/list_dir）的根夾制需要裝置的授權根，故先取記錄讀授權集
    // （這一步只讀授權集，不是「裝置在線」判定；denylist 仍先於在線檢查）。
    const rec = this.getDevice(input.tenant, input.deviceId)
    const configured = rec?.permissionsEnabled === true
    const cleaned = sanitizeToolArgs(tool, input.args, {
      authorizedRoots: rec?.authorizedRoots,
      // 啟用決策引擎時，遞迴根的授權判斷交給 evaluatePermission（模式語義）；
      // 未啟用＝沿用升級前的遞迴根夾制。
      deferRecursiveRootCheck: configured,
    })
    if (!cleaned.ok) {
      // gateway tsconfig 為 strict:false（boolean 字面量判別式不窄化），顯式轉型。
      const err = cleaned as SanitizeErr
      return { ok: false, code: err.code, message: err.message }
    }

    const now = Date.now()
    if (!rec) return { ok: false, code: "device_offline", message: "device not registered" }
    if (!this.isOnline(rec, now)) return { ok: false, code: "device_offline", message: "device heartbeat expired" }

    // W6b：決策引擎（硬 denylist → safety → 規則 → 模式）。只有明確配置的裝置才啟用；
    // 未配置＝沿用升級前行為（此處不介入）。denylist 已在 sanitizeToolArgs 內先擋。
    let consent: DeviceRequestMessage["consent"] | undefined
    if (rec.permissionsEnabled) {
      const path = typeof cleaned.args.path === "string" ? cleaned.args.path : ""
      const explicitToken = input.authorizationToken !== undefined && input.authorizationToken !== null
      let granted = false
      /** once 自動核銷成功的許可根（僅在無顯式 token 且規則未放行時產生）。 */
      let onceRoot: string | null = null
      if (explicitToken) {
        granted = this.grants.consume(input.authorizationToken, { tenant: input.tenant, tool, path }, now).ok
      }
      if (!granted) {
        const verdict = evaluatePermission({
          tool,
          resolvedPath: path,
          mode: rec.mode,
          rules: this.allRulesFor(rec),
          authorizedRoots: rec.authorizedRoots,
          home: rec.home,
        })
        if (verdict.decision === "deny") {
          const code: DeviceBridgeErrorCode = verdict.reason === "denylist" ? "sensitive_path" : "permission_denied"
          return { ok: false, code, message: `path denied by policy (${verdict.reason})` }
        }
        if (verdict.decision === "ask") {
          // once 自動核銷：opencode 的 local_files 從不下發 authorization_token ⇒ once 結構性
          // 死路。顯式 token 已在上方優先處理；此處只處理「完全沒帶 token」的情形：主動找一筆
          // {tenant, tool, path} 相符、未使用的一次性許可核銷，成功即本次放行。找不到仍維持
          // needs_authorization（且 denylist／safety 的 deny 已先返回，不放寬）。
          if (!explicitToken) {
            const match = this.grants.consumeMatching({ tenant: input.tenant, tool, path }, now)
            if (match.ok) {
              granted = true
              onceRoot = match.root
            }
          }
          if (!granted) {
            const isDirectory = tool === "list_dir" || tool === "grep"
            const root = suggestAuthorizationRoot(path, rec.home, isDirectory) ?? path
            return {
              ok: false,
              code: "needs_authorization",
              message: "此路徑尚未授權。",
              needsAuthorization: { root, reason: mapAskReason(verdict.reason), options: AUTHORIZATION_OPTIONS },
            }
          }
        }
      }
      // 組同意記錄（隨本則 message 送到裝置落地）：once 核銷優先；否則送 session/permanent
      // 的累積同意（roots 取全部、scope 取 permanent 若存在否則 session，裝置端 permanent 落盤
      // 語義更保守）。沒有任何記錄＝不帶此欄位（裝置端不得無條件落盤）。
      if (onceRoot !== null) {
        consent = { scope: "once", roots: [onceRoot] }
      } else {
        const records = this.tenantConsent(input.tenant)
        if (records.length > 0) {
          consent = {
            scope: records.some((r) => r.scope === "permanent") ? "permanent" : "session",
            roots: [...new Set(records.map((r) => r.root))],
          }
        }
      }
    }

    const requestId = randomId("req")
    const token = this.tokens.mint({ deviceId: rec.deviceId, tool, requestId }, this.consentTtlMs(), now)
    const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? this.requestTimeoutMs(), 10 * 60_000))
    const message: DeviceRequestMessage = {
      request_id: requestId,
      tool,
      args: cleaned.args,
      consent_token: token,
      issued_at: now,
      expires_at: now + Math.min(timeoutMs, this.consentTtlMs()),
    }
    if (consent) message.consent = consent

    return await new Promise<InvokeResult>((resolve) => {
      const pending: PendingRequest = {
        requestId,
        tenant: input.tenant,
        deviceId: rec.deviceId,
        message,
        settled: false,
        timer: null,
        resolve,
      }
      this.pending.set(requestId, pending)
      const q = this.queue.get(this.deviceKey(input.tenant, rec.deviceId)) ?? []
      q.push(requestId)
      this.queue.set(this.deviceKey(input.tenant, rec.deviceId), q)
      pending.timer = setTimeout(() => this.cancelPending(requestId), timeoutMs)
      this.notifyPoll()
    })
  }

  /** 本機端執行完（或失敗）後回傳；閘道在此**再驗一次同意票**（過期/不匹配/重放）。 */
  submitResult(input: {
    tenant: string
    deviceId: string
    connectionId: string
    requestId: string
    consentToken: unknown
    result?: unknown
    error?: string
    now?: number
  }): { ok: true } | { ok: false; code: DeviceBridgeErrorCode; message: string } {
    const now = input.now ?? Date.now()
    const rec = this.getDevice(input.tenant, input.deviceId)
    if (!rec) return { ok: false, code: "device_offline", message: "device not registered" }
    if (rec.connectionId !== input.connectionId) return { ok: false, code: "device_connection_stale", message: "connection is stale" }
    rec.lastSeenAt = now

    const p = this.pending.get(input.requestId)
    if (!p || p.settled || p.tenant !== input.tenant || p.deviceId !== rec.deviceId) {
      return { ok: false, code: "device_request_not_found", message: "no pending request with that id" }
    }
    const verdict = this.tokens.consume(
      input.consentToken,
      { deviceId: rec.deviceId, tool: p.message.tool, requestId: p.requestId },
      now,
    )
    if (!verdict.ok) {
      // 驗票失敗不落地：票留給原請求（可能只是本機端送錯票），請求照舊等／逾時。
      const err = verdict as { ok: false; code: ConsentTokenError }
      return { ok: false, code: err.code, message: `consent ${err.code}` }
    }

    p.settled = true
    if (p.timer) clearTimeout(p.timer)
    this.pending.delete(p.requestId)
    if (typeof input.error === "string" && input.error.trim()) {
      p.resolve({ ok: false, code: "device_op_failed", message: input.error.trim().slice(0, 500), requestId: p.requestId })
      return { ok: true }
    }
    // H2 契約面第二層：裝置自報遞迴時觸碰敏感段 → 整筆拒絕、結果不落地。
    const reported = sensitiveResultProblem(input.result)
    if (reported) {
      p.resolve({ ok: false, code: "sensitive_path", message: reported, requestId: p.requestId })
      return { ok: false, code: "sensitive_path", message: reported }
    }
    const finalized = finalizeDeviceResult(input.result)
    p.resolve({
      ok: true,
      requestId: p.requestId,
      tool: p.message.tool,
      result: finalized.result,
      truncated: finalized.truncated,
      bytes: finalized.bytes,
    })
    return { ok: true }
  }

  /**
   * 唯讀快照：某 userId 的裝置在線概況。**不改動任何狀態**（不刷 lastSeenAt、不動
   * 待辦／票），供環境事實層回答「本回合的裝置橋是否可用」。`now` 可注入以便測試逾時。
   */
  runtimeStateFor(userId: number | null, now: number = Date.now()): {
    online: boolean
    deviceCount: number
    authorizedRootCount: number
  } {
    let deviceCount = 0
    let onlineCount = 0
    let authorizedRootCount = 0
    for (const rec of this.devices.values()) {
      if (rec.userId !== userId) continue
      deviceCount++
      if (this.isOnline(rec, now)) {
        onlineCount++
        authorizedRootCount += rec.authorizedRoots.length
      }
    }
    return { online: onlineCount > 0, deviceCount, authorizedRootCount }
  }

  /**
   * W6b：某 userId 目前在線（最近心跳）裝置的權限模式與授權根（環境事實層用）。
   * 無在線裝置 → null（呼叫端不得猜）。**唯讀、零副作用**。
   */
  policyStateFor(userId: number | null, now: number = Date.now()): { mode: DeviceBridgeMode; authorizedRoots: string[] } | null {
    let best: DeviceRecord | undefined
    for (const rec of this.devices.values()) {
      if (rec.userId !== userId) continue
      if (!this.isOnline(rec, now)) continue
      if (!best || rec.lastSeenAt > best.lastSeenAt) best = rec
    }
    if (!best) return null
    return { mode: best.mode, authorizedRoots: [...best.authorizedRoots] }
  }

  /**
   * 依租戶挑一台裝置（內部路由尋址）。**不做任何動作、不改狀態**。
   * 見 `PickDeviceResult` 的五態語義。
   */
  pickDeviceForTenant(tenant: string, now: number = Date.now()): PickDeviceResult {
    const mine = [...this.devices.values()].filter((r) => r.tenant === tenant)
    if (mine.length === 0) {
      return { ok: false, code: "no_device_registered", message: "no device registered for this tenant" }
    }
    const online = mine.filter((r) => this.isOnline(r, now))
    if (mine.length === 1) {
      const only = mine[0]
      return this.isOnline(only, now)
        ? { ok: true, deviceId: only.deviceId }
        : { ok: false, code: "device_offline", message: "the registered device is offline" }
    }
    if (online.length === 1) return { ok: true, deviceId: online[0].deviceId }
    return {
      ok: false,
      code: "device_ambiguous",
      message: `multiple devices registered for tenant (${mine.length}), ${online.length} online`,
    }
  }

  /**
   * 唯讀裝置概況：該租戶的代表裝置（見下）的 online／roots／lastHeartbeat。
   * 0 台已註冊 → null。代表裝置＝`pickDeviceForTenant` 可判斷時取之，否則取最近心跳者
   * （唯讀查詢，不涉及動作選擇，故可回報「最近看到的那台」；**不**用於 invoke 尋址）。
   */
  describeTenantDevices(tenant: string, now: number = Date.now()): TenantDeviceDescription | null {
    const mine = [...this.devices.values()].filter((r) => r.tenant === tenant)
    if (mine.length === 0) return null
    const picked = this.pickDeviceForTenant(tenant, now)
    const rep = picked.ok
      ? mine.find((r) => r.deviceId === picked.deviceId) ?? mine[0]
      : mine.slice().sort((a, b) => (b.lastSeenAt - a.lastSeenAt) || a.deviceId.localeCompare(b.deviceId))[0]
    return { online: this.isOnline(rep, now), roots: [...rep.authorizedRoots], lastHeartbeatMs: rep.lastSeenAt }
  }

  /** 測試/運維用：裝置數、待辦數。 */
  stats(): { devices: number; pending: number; consentTokens: number } {
    return { devices: this.devices.size, pending: this.pending.size, consentTokens: this.tokens.size() }
  }
}

/** 閘道進程單例（記憶體狀態）。 */
export const deviceBridge = new DeviceBridge()

// ── 唯讀查詢（環境事實層用）──────────────────────────────────────────────

/**
 * 本機檔案通道的執行期狀態快照（環境事實層 localBridge 的來源）。
 * `enabled`＝總開關（env）；`online`＝該使用者此刻有在線裝置；`deviceCount`＝該使用者
 * 已註冊裝置數（含離線）；`authorizedRootCount`＝在線裝置合計已授權根數（0＝在線但未授權）。
 */
export interface DeviceBridgeRuntimeState {
  enabled: boolean
  online: boolean
  deviceCount: number
  authorizedRootCount: number
}

/**
 * 回答「某個 userId 目前是否有在線裝置、該裝置是否已授權根」。純讀、零副作用、零網路。
 *
 * 契約：
 *   - 總開關未開 → `{ enabled:false, ... }`（呼叫端據此判 `off`）。
 *   - `userId === null` ＝取不到使用者身分；本函式仍會回報（只匹配 null-tenant 裝置），
 *     但環境事實層對 null 一律維持 `unknown`（不得猜），不採用本回報判定通道狀態。
 *   - 查詢本身不會拋（記憶體 map 遍歷）；呼叫端仍應 try/catch 以求 fail-safe（→ unknown）。
 * 絕不改動註冊／心跳／invoke／同意票的任何行為。
 */
export function deviceBridgeRuntimeState(
  userId: number | null,
  opts: { bridge?: DeviceBridge; env?: NodeJS.ProcessEnv; now?: number } = {},
): DeviceBridgeRuntimeState {
  const enabled = deviceBridgeEnabled(opts.env ?? process.env)
  if (!enabled) return { enabled: false, online: false, deviceCount: 0, authorizedRootCount: 0 }
  const bridge = opts.bridge ?? deviceBridge
  const snapshot = bridge.runtimeStateFor(userId, opts.now)
  return { enabled: true, ...snapshot }
}

/** W6b：本機檔案權限模式與授權根的執行期快照（環境事實層用）。 */
export interface DeviceBridgePolicyState {
  mode: DeviceBridgeMode
  authorizedRoots: string[]
}

/**
 * 回答「某個 userId 目前在線裝置的本機檔案權限模式與授權根清單」。純讀、零副作用。
 * 總開關未開／userId 未知／無在線裝置 → null（呼叫端不得猜）。
 */
export function deviceBridgePolicyState(
  userId: number | null,
  opts: { bridge?: DeviceBridge; env?: NodeJS.ProcessEnv; now?: number } = {},
): DeviceBridgePolicyState | null {
  if (!deviceBridgeEnabled(opts.env ?? process.env)) return null
  if (userId === null || userId === undefined) return null
  const bridge = opts.bridge ?? deviceBridge
  return bridge.policyStateFor(userId, opts.now)
}

// ── HTTP 路由（僅在 deviceBridgeEnabled() 為真時由 router 呼叫）──────────

interface DeviceBridgeRouteCtx {
  rawKey: string
  pathname: string
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
  } catch {
    return null
  }
}

function errorResponse(status: number, code: DeviceBridgeErrorCode | string, message: string): Response {
  return Response.json({ ok: false, error: { code, message } }, { status })
}

/** needs_authorization：**HTTP 200**（授權發生在對話裡，不是錯誤頁；見凍結契約）。 */
function needsAuthorizationResponse(info: NeedsAuthorizationInfo): Response {
  return Response.json(
    {
      ok: false,
      error: {
        code: "needs_authorization",
        message: "此路徑尚未授權。",
        root: info.root,
        reason: info.reason,
        options: info.options,
      },
    },
    { status: 200 },
  )
}

/**
 * 裝置橋 HTTP 路由。掛載點：`/agent/v1/device-bridge/*`，經既有 Bearer sk-biz-* 閘門。
 *  - POST /register  ← 本機 daemon 啟動時註冊（出站）
 *  - POST /heartbeat ← 心跳
 *  - POST /poll      ← 取件（可長輪詢）
 *  - POST /result    ← 執行後回傳（帶同意票）
 *  - POST /invoke    ← 雲端 agent 發起本機檔案操作
 */
export async function handleDeviceBridgeRoutes(req: Request, ctx: DeviceBridgeRouteCtx): Promise<Response> {
  if (!deviceBridgeEnabled()) {
    // 第二道保險：即使 router 誤掛，開關關閉時端點不存在。
    return errorResponse(404, "not_found", "device bridge is disabled")
  }
  if (req.method !== "POST") return errorResponse(405, "method_not_allowed", "POST only")

  const identity = await resolveCanonicalIdentity(ctx.rawKey)
  const apiKeyHash = await hashKey(ctx.rawKey)
  const tenant = identity.userId != null ? `u:${identity.userId}` : `k:${apiKeyHash}`

  const body = await readJsonBody(req)
  if (body === null) return errorResponse(400, "bad_request", "invalid json body")

  const deviceId = typeof body.device_id === "string" ? body.device_id : ""
  const connectionId = typeof body.connection_id === "string" ? body.connection_id : ""

  switch (ctx.pathname) {
    case "/agent/v1/device-bridge/register": {
      const reg = deviceBridge.register({
        tenant,
        userId: identity.userId,
        apiKeyHash,
        deviceId: deviceId || undefined,
        roots: body.roots,
        mode: body.mode,
        rules: body.rules,
        home: body.home,
      })
      return Response.json({
        ok: true,
        device_id: reg.deviceId,
        connection_id: reg.connectionId,
        heartbeat_interval_ms: reg.heartbeatIntervalMs,
        poll_url: reg.pollUrl,
        authorized_roots: reg.authorizedRoots,
        mode: reg.mode,
        permissions_enabled: reg.permissionsEnabled,
      })
    }
    case "/agent/v1/device-bridge/heartbeat": {
      if (!deviceId || !connectionId) return errorResponse(400, "bad_request", "device_id and connection_id are required")
      const hb = deviceBridge.heartbeat({ tenant, deviceId, connectionId })
      if (!hb.ok) return errorResponse(hb.code === "device_connection_stale" ? 409 : 404, hb.code!, "heartbeat rejected")
      return Response.json({ ok: true, pending_count: hb.pendingCount, server_time_ms: hb.serverTimeMs })
    }
    case "/agent/v1/device-bridge/poll": {
      if (!deviceId || !connectionId) return errorResponse(400, "bad_request", "device_id and connection_id are required")
      const waitMs = typeof body.wait_ms === "number" ? body.wait_ms : 0
      const out = await deviceBridge.poll({ tenant, deviceId, connectionId, waitMs })
      if (!out.ok) {
        const err = out as { ok: false; code: DeviceBridgeErrorCode }
        return errorResponse(err.code === "device_connection_stale" ? 409 : 404, err.code, "poll rejected")
      }
      return Response.json({ ok: true, request: out.request })
    }
    case "/agent/v1/device-bridge/result": {
      if (!deviceId || !connectionId) return errorResponse(400, "bad_request", "device_id and connection_id are required")
      const requestId = typeof body.request_id === "string" ? body.request_id : ""
      if (!requestId) return errorResponse(400, "bad_request", "request_id is required")
      const out = deviceBridge.submitResult({
        tenant,
        deviceId,
        connectionId,
        requestId,
        consentToken: body.consent_token,
        result: body.result,
        error: typeof body.error === "string" ? body.error : undefined,
      })
      if (!out.ok) {
        const err = out as { ok: false; code: DeviceBridgeErrorCode; message: string }
        const status = err.code.startsWith("consent_token_") ? 403 : err.code === "device_connection_stale" ? 409 : 404
        return errorResponse(status, err.code, err.message)
      }
      return Response.json({ ok: true })
    }
    case "/agent/v1/device-bridge/invoke": {
      if (!deviceId) return errorResponse(400, "bad_request", "device_id is required")
      const out = await deviceBridge.invoke({ tenant, deviceId, tool: body.tool, args: body.args, authorizationToken: body.authorization_token })
      if (!out.ok) {
        const err = out as { ok: false; code: DeviceBridgeErrorCode; message: string; requestId?: string; needsAuthorization?: NeedsAuthorizationInfo }
        if (err.code === "needs_authorization" && err.needsAuthorization) return needsAuthorizationResponse(err.needsAuthorization)
        const status =
          err.code === "tool_not_allowed" || err.code === "sensitive_path" || err.code === "path_not_authorized" || err.code === "permission_denied" || err.code === "mode_off"
            ? 403
            : err.code === "device_offline"
              ? 404
              : 400
        return Response.json({ ok: false, error: { code: err.code, message: err.message }, request_id: err.requestId }, { status })
      }
      return Response.json(out)
    }
    default:
      return errorResponse(404, "not_found", "unknown device-bridge route")
  }
}

// ── 內部路由（/internal/device/*）──────────────────────────────────────
//
// 為什麼需要（第一性原理）：agent 工具跑在 **opencode-server 服務內**（同一台 VPS、
// loopback），它只知道 `session_id`，不知道裝置憑證／`device_id`；也不該拿到裝置憑證。
// 既有 `/agent/v1/device-bridge/invoke` 需要呼叫方帶 `device_id` 且經 Bearer 閘門，
// 工具端拿不到。此處補一條**只做尋址與轉發**的內部入口：由 `session_id` 解析出租戶
// （`u:<userId>`），挑該租戶唯一在線裝置，再交給既有 `DeviceBridge.invoke`。
//
// 三道防線（denylist `isSensitivePath`／授權根 `path_not_authorized`／工具白名單）
// 全在既有 `invoke` → `sanitizeToolArgs` 內，本路由**不新增、不放寬**任何檢查。
// 保護層＝router 的 `/internal/` loopback 門（與 `/internal/media/upload` 同一層）。

/** 內部裝置路由的依賴注入（測試免真會話/真網路；生產由 router 提供真 resolver）。 */
export interface InternalDeviceRouteDeps {
  /**
   * `session_id` → 租戶（`u:<userId>`）。解析不到回 `null` ⇒ `session_unknown`。
   * 生產實作＝與 `/internal/media/upload` 同源的 session 解析（`resolveSession` →
   * `subagentParentState`）＋既有正典化 `resolveCanonicalIdentity(session.apiKey)`。
   */
  resolveTenant: (sessionId: string) => Promise<string | null>
  /** 裝置橋實例（測試注入）；預設製程單例 `deviceBridge`。 */
  bridge?: DeviceBridge
}

/** op → 既有 `DeviceBridgeTool` 的**一對一**映射（不得新增／改名工具）。 */
const INTERNAL_DEVICE_OPS: readonly DeviceBridgeTool[] = ["list_dir", "read_file", "grep", "stat"]

function isInternalDeviceOp(v: string): v is DeviceBridgeTool {
  return (INTERNAL_DEVICE_OPS as readonly string[]).includes(v)
}

function internalDeviceError(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, error: { code, message } }, { status })
}

/**
 * 內部契約錯誤碼（凍結）：把既有 `DeviceBridgeErrorCode` 收斂到凍結清單。
 * `device_request_timeout` → `device_timeout`；`bad_request` 保留；
 * 其餘（含 device_op_failed／consent_token_*／device_request_not_found）→ `internal_error`。
 */
function mapInternalDeviceError(code: DeviceBridgeErrorCode): { status: number; code: string } {
  switch (code) {
    case "device_request_timeout":
      return { status: 504, code: "device_timeout" }
    case "bad_request":
      return { status: 400, code: "bad_request" }
    case "tool_not_allowed":
      return { status: 403, code: "tool_not_allowed" }
    case "sensitive_path":
      return { status: 403, code: "sensitive_path" }
    case "path_not_authorized":
      return { status: 403, code: "path_not_authorized" }
    case "permission_denied":
      return { status: 403, code: "permission_denied" }
    case "mode_off":
      return { status: 403, code: "mode_off" }
    case "needs_authorization":
      // 一般由此前的專屬分支處理（HTTP 200）；保留在此作型別閉合（不應走到）。
      return { status: 200, code: "needs_authorization" }
    case "device_offline":
    case "device_connection_stale":
      return { status: 404, code: "device_offline" }
    default:
      return { status: 502, code: "internal_error" }
  }
}

/**
 * 凍結 body → 既有 `sanitizeToolArgs` 的 args 白名單（欄位名映射，語義沿用既有淨化）。
 * 只放行凍結契約列出的欄位：path / pattern / max_bytes / limit。夾制全在 sanitizeToolArgs。
 */
function buildInternalDeviceArgs(tool: DeviceBridgeTool, body: Record<string, unknown>): Record<string, unknown> {
  const path = typeof body.path === "string" ? body.path : ""
  switch (tool) {
    case "list_dir":
      return { path }
    case "read_file": {
      const args: Record<string, unknown> = { path }
      if (body.limit !== undefined) args.limit = body.limit
      return args
    }
    case "grep": {
      const args: Record<string, unknown> = { path, pattern: typeof body.pattern === "string" ? body.pattern : "" }
      // 凍結欄位名 `max_bytes` → 既有淨化欄位 `max_file_bytes`（不改語義）。
      if (body.max_bytes !== undefined) args.max_file_bytes = body.max_bytes
      return args
    }
    default:
      return { path }
  }
}

/**
 * POST /internal/device/invoke?session_id=… — 雲端 agent 工具讀本機檔的**內部**入口。
 * 只尋址＋轉發；逾時由既有 `invoke` 的 `DEVICE_REQUEST_TIMEOUT_MS` 保證（不永久 pending）。
 */
export async function handleInternalDeviceInvoke(req: Request, deps: InternalDeviceRouteDeps): Promise<Response> {
  const bridge = deps.bridge ?? deviceBridge
  const sessionId = new URL(req.url).searchParams.get("session_id") ?? ""
  if (!sessionId) return internalDeviceError(400, "bad_request", "session_id is required")
  const body = await readJsonBody(req)
  if (body === null) return internalDeviceError(400, "bad_request", "invalid json body")
  const op = typeof body.op === "string" ? body.op : ""
  if (!op) return internalDeviceError(400, "bad_request", "op is required")

  let tenant: string | null = null
  try {
    tenant = await deps.resolveTenant(sessionId)
  } catch {
    tenant = null
  }
  if (!tenant) return internalDeviceError(404, "session_unknown", "session_id could not be resolved to an owner")

  if (!isInternalDeviceOp(op)) return internalDeviceError(403, "tool_not_allowed", `op not allowed: ${op}`)
  const tool: DeviceBridgeTool = op
  const args = buildInternalDeviceArgs(tool, body)

  const pick = bridge.pickDeviceForTenant(tenant)
  if (!pick.ok) {
    // gateway tsconfig strict:false ⇒ boolean 字面量判別式不窄化，顯式轉型（本檔既有同款）。
    const perr = pick as { ok: false; code: "no_device_registered" | "device_offline" | "device_ambiguous"; message: string }
    return internalDeviceError(perr.code === "device_ambiguous" ? 409 : 404, perr.code, perr.message)
  }

  const out = await bridge.invoke({ tenant, deviceId: (pick as { ok: true; deviceId: string }).deviceId, tool, args, authorizationToken: body.authorization_token })
  if (!out.ok) {
    const oerr = out as { ok: false; code: DeviceBridgeErrorCode; message: string; needsAuthorization?: NeedsAuthorizationInfo }
    // needs_authorization：HTTP 200（授權發生在對話裡），body 形狀照凍結契約。
    if (oerr.code === "needs_authorization" && oerr.needsAuthorization) return needsAuthorizationResponse(oerr.needsAuthorization)
    const mapped = mapInternalDeviceError(oerr.code)
    return internalDeviceError(mapped.status, mapped.code, oerr.message)
  }
  const ores = out as { ok: true; requestId: string; tool: DeviceBridgeTool; result: Record<string, unknown>; truncated: boolean; bytes: number }
  return Response.json({
    ok: true,
    request_id: ores.requestId,
    tool: ores.tool,
    result: ores.result,
    truncated: ores.truncated,
    bytes: ores.bytes,
  })
}

/**
 * GET /internal/device/status?session_id=… — 本會話租戶的裝置概況（唯讀）。
 * 無已註冊裝置 → `device: null`（不是錯誤）。
 */
export async function handleInternalDeviceStatus(req: Request, deps: InternalDeviceRouteDeps): Promise<Response> {
  const bridge = deps.bridge ?? deviceBridge
  const sessionId = new URL(req.url).searchParams.get("session_id") ?? ""
  if (!sessionId) return internalDeviceError(400, "bad_request", "session_id is required")
  let tenant: string | null = null
  try {
    tenant = await deps.resolveTenant(sessionId)
  } catch {
    tenant = null
  }
  if (!tenant) return internalDeviceError(404, "session_unknown", "session_id could not be resolved to an owner")
  const desc = bridge.describeTenantDevices(tenant)
  const perm = bridge.permissionStateForTenant(tenant)
  return Response.json({
    ok: true,
    device: desc
      ? { online: desc.online, roots: desc.roots, last_heartbeat_ms: desc.lastHeartbeatMs, mode: perm.mode, rules: perm.rules }
      : null,
  })
}

/**
 * POST /internal/device/authorize?session_id=… — 對話中授權本機路徑（loopback-only）。
 *
 * scope：
 *   - `once`：不落規則，簽一枚一次性許可（帶 TTL）並回 `token`；
 *     下一次 invoke 帶 `authorization_token` 使用，用一次即失效。
 *   - `session`：加進該 session 的規則集（記憶體，隨 session 生命週期；本進程內）。
 *   - `permanent`：gateway **不持久化**，回 `persist_on_device:true`，由裝置端落地；
 *     gateway 只把它加進當前 session 規則集。
 * **一律不在 gateway 端持久化規則到共享庫**（避免跨租戶洩漏）。
 *
 * 錯誤碼：bad_request／session_unknown／root_not_absolute／root_too_broad／denylisted_root。
 */
export async function handleInternalDeviceAuthorize(req: Request, deps: InternalDeviceRouteDeps): Promise<Response> {
  const bridge = deps.bridge ?? deviceBridge
  const sessionId = new URL(req.url).searchParams.get("session_id") ?? ""
  if (!sessionId) return internalDeviceError(400, "bad_request", "session_id is required")
  const body = await readJsonBody(req)
  if (body === null) return internalDeviceError(400, "bad_request", "invalid json body")
  const scope = body.scope
  if (!isAuthorizationScope(scope)) return internalDeviceError(400, "bad_request", "scope must be once|session|permanent")
  const toolRaw = body.tool
  if (toolRaw !== undefined && toolRaw !== "*" && !isToolAllowed(toolRaw)) {
    return internalDeviceError(400, "bad_request", "tool must be a device-bridge tool or *")
  }
  if (typeof body.root !== "string" || body.root.trim().length === 0) {
    return internalDeviceError(400, "bad_request", "root is required")
  }

  let tenant: string | null = null
  try {
    tenant = await deps.resolveTenant(sessionId)
  } catch {
    tenant = null
  }
  if (!tenant) return internalDeviceError(404, "session_unknown", "session_id could not be resolved to an owner")

  const home = bridge.homeForTenant(tenant)
  const mode = bridge.permissionStateForTenant(tenant).mode
  const problem = authorizationRootProblem(body.root, home, mode)
  if (problem) {
    const status = problem === "root_not_absolute" ? 400 : 403
    return internalDeviceError(status, problem, `authorization root rejected: ${problem}`)
  }
  const absRoot = expandToAbsolutePreserveCase(body.root, home)!
  const ruleTool: PermissionTool = toolRaw === "*" || toolRaw === undefined ? "*" : (toolRaw as DeviceBridgeTool)
  const rule: PermissionRule = { effect: "allow", tool: ruleTool, specifier: authorizationRuleSpecifier(absRoot) }
  if (scope === "session" || scope === "permanent") {
    bridge.addSessionRule(tenant, rule)
    // 另存同意記錄：invoke 會把它隨 DeviceRequestMessage.consent 送到裝置端落地。
    bridge.addSessionConsent(tenant, { scope, root: absRoot })
  }

  const state = bridge.permissionStateForTenant(tenant)
  const payload: Record<string, unknown> = { ok: true, applied: { scope, root: absRoot }, rules: state.rules }
  if (scope === "once") {
    payload.token = bridge.grants.mint(
      { tenant, root: absRoot, tool: toolRaw === undefined || toolRaw === "*" ? null : (toolRaw as DeviceBridgeTool) },
      DEVICE_ONCE_GRANT_TTL_MS,
    )
  }
  if (scope === "permanent") payload.persist_on_device = true
  return Response.json(payload)
}
