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
  clampFileBytes,
  clampReadSize,
  isSensitivePath,
  isToolAllowed,
  recursiveRootProblem,
  sanitizeAuthorizedRoots,
  sensitiveResultProblem,
  truncateWithMarker,
  type DeviceBridgeTool,
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
/** 輪詢長連線上界（<= 閘道 idleTimeout 255s）。 */
export const DEVICE_POLL_MAX_WAIT_MS = 25_000

export type DeviceBridgeErrorCode =
  | "bad_request"
  | "tool_not_allowed"
  | "sensitive_path"
  | "path_not_authorized"
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

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`
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
  registeredAt: number
  lastSeenAt: number
}

export interface DeviceRequestMessage {
  request_id: string
  tool: DeviceBridgeTool
  args: Record<string, unknown>
  consent_token: string
  issued_at: number
  expires_at: number
}

export type InvokeResult =
  | { ok: true; requestId: string; tool: DeviceBridgeTool; result: Record<string, unknown>; truncated: boolean; bytes: number }
  | { ok: false; code: DeviceBridgeErrorCode; message: string; requestId?: string }

interface PendingRequest {
  requestId: string
  tenant: string
  deviceId: string
  message: DeviceRequestMessage
  settled: boolean
  timer: ReturnType<typeof setTimeout> | null
  resolve: (r: InvokeResult) => void
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
  opts?: { authorizedRoots?: unknown },
): SanitizeOk | SanitizeErr {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, code: "bad_request", message: "args must be an object" }
  }
  const r = raw as Record<string, unknown>
  const p = asString(r.path)
  if (!p) return { ok: false, code: "bad_request", message: "args.path is required" }
  if (isSensitivePath(p)) return { ok: false, code: "sensitive_path", message: "path is denied by policy" }

  switch (tool) {
    case "list_dir": {
      const problem = recursiveRootProblem(p, opts?.authorizedRoots)
      if (problem) return { ok: false, code: "path_not_authorized", message: `list_dir root denied: ${problem}` }
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
      const problem = recursiveRootProblem(p, opts?.authorizedRoots)
      if (problem) return { ok: false, code: "path_not_authorized", message: `grep root denied: ${problem}` }
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
  private readonly pollWaiters = new Set<() => void>()
  readonly tokens = new ConsentTokenStore()

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

  /**
   * 註冊：綁定 tenant(userId) ↔ deviceId ↔ connectionId。同裝置重註冊＝換連線（舊連線作廢）。
   * `roots`＝使用者已授權的絕對路徑根（H2 遞迴夾制用）；未帶／全非法＝空集 ⇒ grep/list_dir 全拒。
   */
  register(input: { tenant: string; userId: number | null; apiKeyHash: string; deviceId?: string; roots?: unknown; now?: number }): {
    deviceId: string
    connectionId: string
    heartbeatIntervalMs: number
    pollUrl: string
    authorizedRoots: string[]
  } {
    const now = input.now ?? Date.now()
    const deviceId = input.deviceId && input.deviceId.trim() ? input.deviceId.trim().slice(0, 128) : randomId("dev")
    const key = this.deviceKey(input.tenant, deviceId)
    const prev = this.devices.get(key)
    if (prev) this.byConnection.delete(prev.connectionId)
    const connectionId = randomId("conn")
    this.devices.set(key, {
      deviceId,
      tenant: input.tenant,
      userId: input.userId,
      apiKeyHash: input.apiKeyHash,
      connectionId,
      authorizedRoots: sanitizeAuthorizedRoots(input.roots),
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

    const take = (): DeviceRequestMessage | null => {
      const q = this.queue.get(this.deviceKey(input.tenant, input.deviceId))
      while (q && q.length > 0) {
        const requestId = q.shift()!
        const p = this.pending.get(requestId)
        if (p && !p.settled) return p.message
      }
      return null
    }

    const first = take()
    if (first) return { ok: true, request: first }
    const waitMs = Math.max(0, Math.min(input.waitMs ?? 0, DEVICE_POLL_MAX_WAIT_MS))
    if (waitMs === 0) return { ok: true, request: null }

    await new Promise<void>((resolve) => {
      let done = false
      const wake = () => {
        if (done) return
        done = true
        this.pollWaiters.delete(wake)
        if (timer) clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(wake, waitMs)
      this.pollWaiters.add(wake)
    })
    return { ok: true, request: take() }
  }

  private notifyPoll(): void {
    for (const wake of [...this.pollWaiters]) wake()
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
  }): Promise<InvokeResult> {
    if (!isToolAllowed(input.tool)) {
      return { ok: false, code: "tool_not_allowed", message: `tool not allowed: ${String(input.tool)}` }
    }
    const tool = input.tool
    // H2：遞迴型工具（grep/list_dir）的根夾制需要裝置的授權根，故先取記錄讀授權集
    // （這一步只讀授權集，不是「裝置在線」判定；denylist 仍先於在線檢查）。
    const rec = this.getDevice(input.tenant, input.deviceId)
    const cleaned = sanitizeToolArgs(tool, input.args, { authorizedRoots: rec?.authorizedRoots })
    if (!cleaned.ok) {
      // gateway tsconfig 為 strict:false（boolean 字面量判別式不窄化），顯式轉型。
      const err = cleaned as SanitizeErr
      return { ok: false, code: err.code, message: err.message }
    }

    const now = Date.now()
    if (!rec) return { ok: false, code: "device_offline", message: "device not registered" }
    if (!this.isOnline(rec, now)) return { ok: false, code: "device_offline", message: "device heartbeat expired" }

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

  /** 測試/運維用：裝置數、待辦數。 */
  stats(): { devices: number; pending: number; consentTokens: number } {
    return { devices: this.devices.size, pending: this.pending.size, consentTokens: this.tokens.size() }
  }
}

/** 閘道進程單例（記憶體狀態）。 */
export const deviceBridge = new DeviceBridge()

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
      const reg = deviceBridge.register({ tenant, userId: identity.userId, apiKeyHash, deviceId: deviceId || undefined, roots: body.roots })
      return Response.json({
        ok: true,
        device_id: reg.deviceId,
        connection_id: reg.connectionId,
        heartbeat_interval_ms: reg.heartbeatIntervalMs,
        poll_url: reg.pollUrl,
        authorized_roots: reg.authorizedRoots,
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
      const out = await deviceBridge.invoke({ tenant, deviceId, tool: body.tool, args: body.args })
      if (!out.ok) {
        const err = out as { ok: false; code: DeviceBridgeErrorCode; message: string; requestId?: string }
        const status = err.code === "tool_not_allowed" || err.code === "sensitive_path" || err.code === "path_not_authorized" ? 403 : err.code === "device_offline" ? 404 : 400
        return Response.json({ ok: false, error: { code: err.code, message: err.message }, request_id: err.requestId }, { status })
      }
      return Response.json(out)
    }
    default:
      return errorResponse(404, "not_found", "unknown device-bridge route")
  }
}
