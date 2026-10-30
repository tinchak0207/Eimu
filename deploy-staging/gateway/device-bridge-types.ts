import { memoryEnvBool } from "./constants-gateway.ts"
import { MAX_READ_BYTES, clampFileBytes, clampReadSize, expandToAbsolute, isHardDeniedPath, isSensitivePath, recursiveRootProblem, truncateWithMarker, type DeviceBridgeMode, type DeviceBridgeTool, type PermissionRule, type PermissionTool } from "./device-bridge-policy.ts"
// ── 开关／时序常数 ──────────────────────────────────────────────────────

/** 总开关：预设 OFF。任何非空呼叫都会经过这条，未开启时能力不存在。 */
export function deviceBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return memoryEnvBool(env.EIMU_DEVICE_BRIDGE, false)
}

/** 装置心跳有效期；超过视为离线，invoke 直接回 device_offline。 */
export const DEVICE_HEARTBEAT_TTL_MS = Number.parseInt(process.env.EIMU_DEVICE_BRIDGE_HEARTBEAT_TTL_MS || "90000", 10) || 90_000
/** 单次呼叫等待装置回传的上限；到点取消并回 device_request_timeout。 */
export const DEVICE_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.EIMU_DEVICE_BRIDGE_REQUEST_TIMEOUT_MS || "30000", 10) || 30_000
/** 同意票 TTL（>= 请求逾时，否则票比请求先死）。 */
export const DEVICE_CONSENT_TTL_MS = Number.parseInt(process.env.EIMU_DEVICE_BRIDGE_CONSENT_TTL_MS || "45000", 10) || 45_000
/** 一次性授权许可（scope=once）TTL。 */
export const DEVICE_ONCE_GRANT_TTL_MS = Number.parseInt(process.env.EIMU_DEVICE_BRIDGE_ONCE_GRANT_TTL_MS || "120000", 10) || 120_000
/** 轮询长连线上界（<= 闸道 idleTimeout 255s）。 */
export const DEVICE_POLL_MAX_WAIT_MS = 25_000
/**
 * 铸票端点回给页面／壳的闸道基址真源（壳必须打到**真正伺服装置桥的那台主机**；
 * 2026-10-05 实测 `image.tinchak0207.xyz` 的 /agent/healthz 是 404、`store.` 才 200，
 * 故此处不给客户端自己猜）。
 */
export const DEVICE_GATEWAY_BASE_URL = (process.env.EIMU_DEVICE_GATEWAY_BASE_URL || "https://store.tinchak0207.xyz").replace(/\/+$/, "")
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

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`
}

/**
 * 把 evaluatePermission 的 ask 成因映射成 needs_authorization 的 reason。
 * 冻结四值为 safety_check／outside_roots／mode_ask（＋ denylist 不进此路径）；
 * 规则明确 ask 另用 `rule_ask`（扩充值，消费端遇到未知值应走预设）。
 */
export function mapAskReason(reason: string): string {
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
export function isAuthorizationScope(v: unknown): v is AuthorizationScope {
  return typeof v === "string" && (AUTHORIZATION_SCOPES as readonly string[]).includes(v)
}
// ── 同意票（逐次、单用、绑定）──────────────────────────────────────────

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
 * 逐次同意票存放区。纯记忆体（与 gateway 其余会话状态同款）。
 * mint 产生票；consume 原子地验证并标记已用（单次）。
 * 验证顺序：找不到 → 过期 → 绑定不匹配 → 已用（重放）。
 * `now` 可注入，测试免睡。
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

// ── 一次性授权许可（scope=once）──────────────────────────────────────────
//
// 为什么独立于同意票：同意票管「一次下发的工作」，授权许可管「一次路径授权」。
// authorize(scope=once) 产生一枚许可；下一次 invoke 带 `authorization_token` 使用它，
// 用一次即失效（重放被拒）。绑定 tenant＋（可选 tool）＋root（路径必须落在 root 之下）。

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
   * 自动核销：呼叫端（opencode 的 local_files）**从不下发** authorization_token，故在规则
   * 未放行时主动找一笔相符的一次性许可并核销——`root` 含 `path`、`tool` 相符（或未绑定）、
   * 未过期、未使用。命中即标记已用并回该许可的根；找不到回 `{ ok:false }`（呼叫端维持
   * needs_authorization）。语义与 `consume` 一致：**用一次即失效**，不得重复放行。
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

/** 路径是否落在 root 之内（含相等）；两者皆先归一化，相对路径一律 false。 */
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
// ── 装置注册表 ─────────────────────────────────────────────────────────

export interface DeviceRecord {
  deviceId: string
  tenant: string
  userId: number | null
  apiKeyHash: string
  connectionId: string
  /**
   * H2：使用者在本机端「逐次挑选／授权」的根（绝对路径）。`grep`/`list_dir` 是递回型
   * 工具，云端无法列举装置上递回会收到哪些档，故把递回根夹在这些根之下（见
   * device-bridge-policy.recursiveRootProblem）。空阵列＝未授权任何根 ⇒ 递回型工具一律拒
   * （fail-closed；装置需在 register 带 `roots` 才启用）。
   */
  authorizedRoots: string[]
  /**
   * W6b：本机档案权限模式（per-device，随 register 上报；预设 `ask`）。
   * 只有 `permissionsEnabled===true`（呼叫端**明确**送了 mode 或 rules）时，新的决策
   * 引擎才生效；未送时维持升级前行为（denylist ＋ 递回根夹制），保证既有呼叫端不受影响。
   */
  mode: DeviceBridgeMode
  /** 是否启用新决策引擎（呼叫端明确送了 mode／rules）。false＝沿用升级前行为。 */
  permissionsEnabled: boolean
  /** register 带入的装置级规则（session 级规则另存 `sessionRules`）。 */
  rules: PermissionRule[]
  /** 装置自报的家目录（full 模式的放行范围、`~` 展开用）；未上报＝null。 */
  home: string | null
  registeredAt: number
  lastSeenAt: number
}

/** needs_authorization 的附带资讯（供 HTTP 边界组 body）。 */
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
  /** 使用者在对话中授权（authorize 端点）产生的同意记录，供装置端落地。
   *  session/permanent 会随其后每次 invoke 重送（幂等）；once 只出现在核销成功的那一则。 */
  consent?: { scope: "once" | "session" | "permanent"; roots: string[] }
}

export type InvokeResult =
  | { ok: true; requestId: string; tool: DeviceBridgeTool; result: Record<string, unknown>; truncated: boolean; bytes: number }
  | { ok: false; code: DeviceBridgeErrorCode; message: string; requestId?: string; needsAuthorization?: NeedsAuthorizationInfo }

/**
 * 依租户挑一台装置（内部路由的**寻址**步骤）。语义刻意保守、**不猜**：
 *   - 该租户 0 台已注册装置 → `no_device_registered`
 *   - 恰好 1 台：在线 → 回它；离线 → `device_offline`
 *   - 多台：恰 1 台在线 → 回那台；0 台或 >1 台在线（含全部离线）→ `device_ambiguous`
 * 在线判定沿用既有心跳 TTL（`DEVICE_HEARTBEAT_TTL_MS`／建构子覆写）。
 */
export type PickDeviceResult =
  | { ok: true; deviceId: string }
  | { ok: false; code: "no_device_registered" | "device_offline" | "device_ambiguous"; message: string }

/** 唯读装置概况（/internal/device/status 用）。 */
export interface TenantDeviceDescription {
  online: boolean
  roots: string[]
  lastHeartbeatMs: number
}

export interface PendingRequest {
  requestId: string
  tenant: string
  deviceId: string
  message: DeviceRequestMessage
  settled: boolean
  timer: ReturnType<typeof setTimeout> | null
  resolve: (r: InvokeResult) => void
}

/**
 * 长轮询 waiter。**必须绑 connectionId**：同 deviceKey 重连（换连线）时旧 waiter 仍留在
 * `pollWaiters` 内，若只在进入等待前验一次 connectionId，它醒后会把新连线的请求 shift 走、
 * 回给已 abort 的旧 HTTP（幽灵 waiter 吞第一发）。唤醒后一律重验连线，不符者不得取件
 * （已取则 re-queue），并以 `device_connection_stale` 收场。
 */
export interface PollWaiter {
  tenant: string
  deviceId: string
  connectionId: string
  timer: ReturnType<typeof setTimeout> | null
  wake: () => void
}
// ── 参数净化（每个工具的最小白名单栏位 + 夹制）─────────────────────────

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
 * 只放行该工具需要的栏位，其余丢弃；敏感路径在此就被挡下。
 *
 * H2（2026-10-04）：`grep`/`list_dir` 是**递回型**工具，除了请求路径本身的 denylist，
 * 还必须把递回根夹在装置回报的 `authorizedRoots` 之下（`opts.authorizedRoots`）；
 * 无授权根 ⇒ 递回型工具一律拒（fail-closed）。`read_file`/`stat` 是单档操作，不受此限
 * （单档 denylist 已足）。
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
  // W6b：硬 denylist（全域不可绕；只加严既有敏感判定）。任何模式／规则都不得放行。
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
      // max_file_bytes：H2 输入侧契约——逐档读入上限（装置端遵守）。
      const args: Record<string, unknown> = { path: p, pattern, max_matches: 100, max_file_bytes: clampFileBytes(r.max_file_bytes) }
      if (r.max_matches !== undefined) {
        const n = asIntInRange(r.max_matches, 1, 500)
        if (n === null) return { ok: false, code: "bad_request", message: "max_matches must be 1..500" }
        args.max_matches = n
      }
      return { ok: true, args }
    }
    case "stat":
      // stat 仅需 path（无额外冻结栏位）；denylist 已于函式开头套用。
      return { ok: true, args: { path: p } }
    default:
      return { ok: false, code: "tool_not_allowed", message: `tool not allowed: ${String(tool)}` }
  }
}

/** U+FFFD（替换字元）占比门槛：与前端 detectBinaryText 同值（0.5%）。 */
const BINARY_FFFD_RATIO = 0.005
/** 二进位读取的人话指引（装置回的是位元组被 utf8 解码后的结果，闸道据此判定）。 */
const BINARY_READ_NOTE =
  "这是二进制文件（图片/压缩/可执行等），无法当文字读取；请改用附件/下载路径获取原始内容。"

/**
 * 二进位判定（可证标准）：文字含 NUL 位元组（`\u0000`，纯文字不可能有）＝二进位；
 * 或 U+FFFD 占比 ≥ 0.5%（二进位被 utf8 解码的典型指纹；真壳实测 64KB 有 21,386 个）。
 */
export function isBinaryTextPayload(text: unknown): boolean {
  if (typeof text !== "string" || text.length === 0) return false
  if (text.includes("\u0000")) return true
  let fffd = 0
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 0xfffd) fffd += 1
  return fffd / text.length >= BINARY_FFFD_RATIO
}

/**
 * 把装置回传的结构化结果套上 256KB 硬上限与截断标记。
 *
 * read_file 家族另做两件事（2026-10-04 缺陷 B，只动闸道）：
 *  1. 二进位侦测：命中即清空 text、标 `binary:true` 并附人话指引，**不得**把 21k 个
 *     U+FFFD 的乱码当成功文字回。
 *  2. `truncated` 改由「实际读到的 bytes（offset+bytes_read）对比档案 size」决定，
 *     不再只看 256KB 容量截断（真壳实锤 64KB/4.4MB 却回 truncated=false）。
 */
export function finalizeDeviceResult(raw: unknown): { result: Record<string, unknown>; truncated: boolean; bytes: number } {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : { value: raw }
  // read_file 家族：直接夹其中的 text 栏位，保留 offset 等后设栏位。
  if (typeof obj.text === "string") {
    const offset = typeof obj.offset === "number" && Number.isFinite(obj.offset) && obj.offset >= 0 ? obj.offset : 0
    const size = typeof obj.size === "number" && Number.isFinite(obj.size) ? obj.size : null
    const bytesRead = typeof obj.bytes_read === "number" && Number.isFinite(obj.bytes_read) ? obj.bytes_read : null
    const sizeTruncated = size !== null && bytesRead !== null ? offset + bytesRead < size : false
    if (isBinaryTextPayload(obj.text)) {
      const result: Record<string, unknown> = { ...obj, binary: true, text: "", note: BINARY_READ_NOTE }
      // 拿不到 size 时保守视为「还有后续」（不得宣称读完整份二进位档）。
      const truncated = size !== null && bytesRead !== null ? sizeTruncated : true
      if (truncated) {
        result.truncated = true
        if (size !== null && bytesRead !== null) result.truncated_bytes = Math.max(0, size - (offset + bytesRead))
      }
      return { result, truncated, bytes: bytesRead ?? 0 }
    }
    const t = truncateWithMarker(obj.text, MAX_READ_BYTES)
    const truncated = t.truncated || sizeTruncated
    const result: Record<string, unknown> = { ...obj, text: t.text, truncated }
    if (truncated) {
      result.truncated_bytes =
        size !== null && bytesRead !== null ? Math.max(0, size - (offset + bytesRead)) : t.originalBytes - t.keptBytes
    }
    return { result, truncated, bytes: bytesRead ?? t.keptBytes }
  }
  const serialized = JSON.stringify(obj)
  const t = truncateWithMarker(serialized, MAX_READ_BYTES)
  if (!t.truncated) return { result: obj, truncated: false, bytes: t.originalBytes }
  return { result: { truncated: true, truncated_bytes: t.originalBytes - t.keptBytes, text: t.text }, truncated: true, bytes: t.keptBytes }
}
