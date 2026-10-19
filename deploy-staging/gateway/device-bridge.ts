// device-bridge.ts — W6a：装置桥**云端侧**（闸道端）。
//
// 目的：让**云端 agent** 经由使用者机器的**出站连线**读本机档案——云端永不 inbound
// 打使用者机器；方向永远是「本机 daemon 主动对外注册／心跳／轮询，取回云端下发的
// 工作，执行后把**必要片段**回传」。本档实作闸道这半边：把「本机档案工具」呼叫
// 转下去、验同意票、夹大小、逾时取消。
//
// 为什么要这一层（第一性原理）：agent 的推理在云端，档案在使用者机器；主流解法是
// 「档案 I/O 留在本机、只把 agent 实际打开的那一小片内容回填」——companion daemon
// ＋出站通道正是这条。这与「把整个 repo 搬上云」是两个极端。
//
// ── 预设 OFF（硬性）─────────────────────────────────────────────────────
// 总开关＝env `EIMU_DEVICE_BRIDGE`。未设／非 truthy（1/true/yes/on）＝整个能力不挂载：
// router 连路由前缀都不进（见 router.ts 的 `deviceBridgeEnabled()` 闸），对既有生产
// 行为零影响。开启方式：`EIMU_DEVICE_BRIDGE=1`（通常写进 VPS systemd 的 gateway env）。
//
// ── 鉴权（复用，不造第二套）─────────────────────────────────────────────
// 装置端与云端 agent 都走**既有** Bearer sk-biz-* 闸门：router 已完成
// validateApiKey + resolveCanonicalKey；本档再用 auth-gw 的 resolveCanonicalIdentity
// 取 userId（正典化缓存命中，几乎零成本），绑定 userId ↔ deviceId ↔ connection。
//
// 2026-10-05（W7a）：**装置端多一条短效票路径**。桌面壳载入的是远端页面、壳内不可能有
// 也不该有长期 key，旧设计「使用者自己把 0600 key 档放进 userData」对真实使用者等于
// 功能不存在（实测停在 credentials_unavailable）。新增：已登录页面经站内服务端
// 向 `POST /agent/v1/device-bridge/token`（Bearer sk-biz-*）换一张 `sk-dev-…`
// 短效票，经窄 IPC 交给壳当 Bearer 打 register/heartbeat/poll/result。票由 router 核销后
// 以 `ctx.deviceIdentity` 传进来，tenant 与 sk-biz 路径**逐字同源**；0600 档仍保留为
// 操作者后备。票绝不落盘、绝不入 log。
//
// ── 安全模型 ────────────────────────────────────────────────────────────
//   1. 工具面收敛成最小集合 list_dir/read_file/grep/stat（无写/删/执行）。
//   2. 伺服器侧 denylist（device-bridge-policy.isSensitivePath）：路径敏感一律拒，
//      不倚赖本机端自报（纵深防御）。
//   3. 逐次同意票（consent token）：每次下发一票，单次可用、绑
//      deviceId+tool+requestId、短 TTL；本机端**执行前验票**，闸道端在回传时再验
//      （过期／不匹配／重放各回明确错误码）。
//   4. 回传内容大小硬上限 MAX_READ_BYTES（256KB）＋截断标记。
//   5. 请求逾时可取消，回 `device_request_timeout`。
//   6. H2（2026-10-04）递回根夹制：`grep`/`list_dir` 会由装置**递回**收集档案，
//      云端看不到收集结果，故要求装置在 register 回报使用者已授权根（`roots`），
//      递回根必须落在授权根之下；档案系统根（`/`、Windows 磁碟根、UNC share）一律拒。
//      未授权任何根 ⇒ 递回型工具全拒（fail-closed）。
//   7. H2 输入侧契约：`grep` 随参数下发 `max_file_bytes`（单档读入上限
//      MAX_FILE_READ_BYTES=1MB，装置端遵守）；装置若自报递回触碰敏感段
//      （`sensitive_path_touched`／`excluded_sensitive_count`／`sensitive_paths`），
//      云端整笔拒绝、结果不落地。
//
// 本档只准动 deploy-staging/gateway/ 之下；未部署、未接 VPS。

import { memoryEnvBool } from "./constants-gateway.ts"
import { saveTenantPermissionMode } from "./persistence.ts"
import {
  DEVICE_TICKET_TTL_MS,
  hashKey,
  issueDeviceTicket,
  resolveCanonicalIdentity,
} from "./auth-gw.ts"
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
  isPathWithinRoot,
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
import { SessionConsentStore } from "./device-bridge-session-consent.ts"

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

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`
}

/**
 * 把 evaluatePermission 的 ask 成因映射成 needs_authorization 的 reason。
 * 冻结四值为 safety_check／outside_roots／mode_ask（＋ denylist 不进此路径）；
 * 规则明确 ask 另用 `rule_ask`（扩充值，消费端遇到未知值应走预设）。
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
 * 长轮询 waiter。**必须绑 connectionId**：同 deviceKey 重连（换连线）时旧 waiter 仍留在
 * `pollWaiters` 内，若只在进入等待前验一次 connectionId，它醒后会把新连线的请求 shift 走、
 * 回给已 abort 的旧 HTTP（幽灵 waiter 吞第一发）。唤醒后一律重验连线，不符者不得取件
 * （已取则 re-queue），并以 `device_connection_stale` 收场。
 */
interface PollWaiter {
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

// ── 桥本体 ─────────────────────────────────────────────────────────────

export class DeviceBridge {
  private readonly devices = new Map<string, DeviceRecord>()
  private readonly byConnection = new Map<string, string>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly queue = new Map<string, string[]>()
  private readonly pollWaiters = new Set<PollWaiter>()
  readonly tokens = new ConsentTokenStore()
  readonly grants = new OnceGrantStore()
  /**
   * session 级规则（记忆体，key＝tenant；**不持久化到共享库**）。gateway 重启后由落盘的
   * 会话同意（`consentStore`）重建，见 `hydratePersistedConsent`。
   */
  private readonly sessionRules = new Map<string, PermissionRule[]>()
  /**
   * 对话内授权的**同意记录**（key＝tenant）：session/permanent 各记一笔，供 invoke 随讯息
   * 送到装置落地（装置端只认自己的 mode/rules/roots，不知道云端对话发生了什么）。
   * 去重、上限 64。`once` **不进此表**（走 OnceGrantStore 的一次性核销）。
   */
  private readonly sessionConsent = new Map<string, { scope: "session" | "permanent"; root: string }[]>()
  /**
   * 会话同意的**行程外**落点（session 同意跨 gateway 重启续存；见
   * device-bridge-session-consent.ts）。production singleton 注入；未注入（测试／嵌入）
   * ＝纯行程内语义（旧行为）。
   */
  private readonly consentStore: SessionConsentStore | null

  constructor(
    private readonly opts: {
      requestTimeoutMs?: number
      consentTtlMs?: number
      heartbeatTtlMs?: number
      sessionConsentStore?: SessionConsentStore | null
    } = {},
  ) {
    this.consentStore = opts.sessionConsentStore ?? null
    this.hydratePersistedConsent()
  }

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

  // ── W6b：session 规则与权限状态 ──────────────────────────────────────
  private tenantRules(tenant: string): PermissionRule[] {
    return this.sessionRules.get(tenant) ?? []
  }
  /** 装置级规则 ＋ 该 tenant 的 session 规则（顺序：装置在前，session 在后）。 */
  private allRulesFor(rec: DeviceRecord): PermissionRule[] {
    return [...rec.rules, ...this.tenantRules(rec.tenant)]
  }
  /** 加一条 session 规则（authorize scope=session/permanent 用）。 */
  addSessionRule(tenant: string, rule: PermissionRule): void {
    const list = this.sessionRules.get(tenant) ?? []
    if (list.length >= 64) return
    list.push(rule)
    this.sessionRules.set(tenant, list)
  }
  /** 清掉某 tenant 的 session 规则（测试／会话结束用）。 */
  clearSessionRules(tenant: string): void {
    this.sessionRules.delete(tenant)
  }
  /** 记忆体内记一笔同意（同 {scope,root} 去重，上限 64）；不做任何落盘。 */
  private applyConsent(tenant: string, scope: "session" | "permanent", root: string): void {
    const list = this.sessionConsent.get(tenant) ?? []
    if (list.some((e) => e.scope === scope && e.root === root)) return
    if (list.length >= 64) return
    list.push({ scope, root })
    this.sessionConsent.set(tenant, list)
  }
  /**
   * 记录一笔对话内授权同意（session/permanent）；同 {scope,root} 去重，上限 64。
   * session/permanent 另**落 gateway 本地单档**（跨重启续存）；`once` 不走本函式。
   * `tool` 供重启后精确重建规则（缺省＝`*`，与 authorize 端点未指定 tool 的语义一致）。
   */
  addSessionConsent(
    tenant: string,
    entry: { scope: "session" | "permanent"; root: string; tool?: PermissionTool },
  ): void {
    this.applyConsent(tenant, entry.scope, entry.root)
    this.consentStore?.record({ tenant, root: entry.root, scope: entry.scope, tool: entry.tool ?? "*" })
  }
  /**
   * 启动时载入落盘的会话同意并**重建规则与同意记录**：gateway 重启（部署）后，已
   * session 授权的目录不再回 needs_authorization。载入项已在 store 内经安全复核
   * （denylist／档案系统根／敏感一律丢弃）。
   */
  private hydratePersistedConsent(): void {
    const store = this.consentStore
    if (!store) return
    for (const entry of store.load()) {
      const specifier = authorizationRuleSpecifier(entry.root)
      const rules = this.sessionRules.get(entry.tenant) ?? []
      // 同 specifier 只重建一条（session 与 permanent 同根时避免重复规则）。
      if (!rules.some((r) => r.specifier === specifier && r.tool === entry.tool)) {
        this.addSessionRule(entry.tenant, { effect: "allow", tool: entry.tool, specifier })
      }
      this.applyConsent(entry.tenant, entry.scope, entry.root)
    }
  }
  /** 该 tenant 目前的同意记录（唯读快照）。 */
  private tenantConsent(tenant: string): { scope: "session" | "permanent"; root: string }[] {
    return this.sessionConsent.get(tenant) ?? []
  }
  /** 清掉某 tenant 的同意记录（测试／会话结束用）。 */
  clearSessionConsent(tenant: string): void {
    this.sessionConsent.delete(tenant)
  }
  /** 挑代表装置（唯读；与 describeTenantDevices 同一语义）。 */
  private representativeDevice(tenant: string, now: number): DeviceRecord | undefined {
    const mine = [...this.devices.values()].filter((r) => r.tenant === tenant)
    if (mine.length === 0) return undefined
    const picked = this.pickDeviceForTenant(tenant, now)
    if (picked.ok) return mine.find((r) => r.deviceId === picked.deviceId) ?? mine[0]
    return mine.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.deviceId.localeCompare(b.deviceId))[0]
  }
  /** 某租户目前的权限状态（mode ＋ 合并规则）；无装置时回预设 ask 与该 tenant session 规则。 */
  permissionStateForTenant(tenant: string, now: number = Date.now()): { mode: DeviceBridgeMode; rules: PermissionRule[] } {
    const rep = this.representativeDevice(tenant, now)
    if (!rep) return { mode: "ask", rules: [...this.tenantRules(tenant)] }
    return { mode: rep.mode, rules: this.allRulesFor(rep) }
  }
  /** 某租户代表装置自报的家目录（authorize 的 too_broad 判定用）；无＝null。 */
  homeForTenant(tenant: string, now: number = Date.now()): string | null {
    return this.representativeDevice(tenant, now)?.home ?? null
  }

  /**
   * 注册：绑定 tenant(userId) ↔ deviceId ↔ connectionId。同装置重注册＝换连线（旧连线作废）。
   * `roots`＝使用者已授权的绝对路径根（H2 递回夹制用）；未带／全非法＝空集 ⇒ grep/list_dir 全拒。
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
      // 换连线＝旧连线关闭：唤醒并清掉它残留的长轮询 waiter。它醒后重验 connectionId 会回
      // stale，不会取走新连线的请求（否则幽灵 waiter 会吞掉重连后的第一发 invoke）。
      this.dropWaitersForConnection(prev.connectionId)
    }
    const connectionId = randomId("conn")
    // 相容策略：只有呼叫端**明确**给了 mode 或 rules 才启用新决策引擎；否则维持升级前
    // 行为（denylist ＋ 递回根夹制）。缺省 mode 的「语义预设」仍为 `ask`（status 回报）。
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
    if (isDeviceBridgeMode(modeRaw)) saveTenantPermissionMode(input.tenant, mode)
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

  /** 心跳：刷新 lastSeenAt；回待办数。connectionId 不符＝换连线后旧连线不再有效。 */
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
   * 轮询（出站长连线的本机端主动来取件）：有待办立刻回；否则若 waitMs>0，
   * 等到有件或逾时（回 request:null）。本机端执行前必须验 consent_token。
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
    // 本条长轮询此刻是否仍绑在有效连线上；重连＝换 connectionId ⇒ false。
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

    // 唤醒后**重验连线**：被重连取代的旧 waiter 不得把新连线刚下发的请求 shift 走、回给已
    // abort 的旧 HTTP。已取到件但连线已失效＝放回伫列头（re-queue，不吞件），回 stale。
    const taken = take()
    if (!connectionValid()) {
      if (taken) this.requeueRequest(input.tenant, input.deviceId, taken.request_id)
      return { ok: false, code: "device_connection_stale" }
    }
    return { ok: true, request: taken }
  }

  /** 唤醒并清掉某连线残留的长轮询 waiter（连线关闭／被取代时呼叫；醒后重验会回 stale）。 */
  private dropWaitersForConnection(connectionId: string): void {
    for (const w of [...this.pollWaiters]) {
      if (w.connectionId === connectionId) w.wake()
    }
  }

  /** 把已取出的请求放回该 deviceKey 伫列头（waiter 醒后连线已失效时不得吞件）。 */
  private requeueRequest(tenant: string, deviceId: string, requestId: string): void {
    const key = this.deviceKey(tenant, deviceId)
    const q = this.queue.get(key) ?? []
    q.unshift(requestId)
    this.queue.set(key, q)
  }

  private notifyPoll(): void {
    for (const w of [...this.pollWaiters]) w.wake()
  }

  /** 逾时取消：清待办与票，回明确错误码。 */
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
   * 云端 agent 发起一次本机档案操作：验工具白名单与路径 denylist → 检查装置在线 →
   * 下发请求（带逐次同意票）→ 等装置回传或逾时。
   */
  async invoke(input: {
    tenant: string
    deviceId: string
    tool: unknown
    args?: unknown
    timeoutMs?: number
    /** scope=once 的一次性授权许可（authorize 端点签发）。 */
    authorizationToken?: unknown
  }): Promise<InvokeResult> {
    if (!isToolAllowed(input.tool)) {
      return { ok: false, code: "tool_not_allowed", message: `tool not allowed: ${String(input.tool)}` }
    }
    const tool = input.tool
    // H2：递回型工具（grep/list_dir）的根夹制需要装置的授权根，故先取记录读授权集
    // （这一步只读授权集，不是「装置在线」判定；denylist 仍先于在线检查）。
    const rec = this.getDevice(input.tenant, input.deviceId)
    const configured = rec?.permissionsEnabled === true
    const cleaned = sanitizeToolArgs(tool, input.args, {
      authorizedRoots: rec?.authorizedRoots,
      // 启用决策引擎时，递回根的授权判断交给 evaluatePermission（模式语义）；
      // 未启用＝沿用升级前的递回根夹制。
      deferRecursiveRootCheck: configured,
    })
    if (!cleaned.ok) {
      // gateway tsconfig 为 strict:false（boolean 字面量判别式不窄化），显式转型。
      const err = cleaned as SanitizeErr
      return { ok: false, code: err.code, message: err.message }
    }

    const now = Date.now()
    if (!rec) return { ok: false, code: "device_offline", message: "device not registered" }
    if (!this.isOnline(rec, now)) return { ok: false, code: "device_offline", message: "device heartbeat expired" }

    // W6b：决策引擎（硬 denylist → safety → 规则 → 模式）。只有明确配置的装置才启用；
    // 未配置＝沿用升级前行为（此处不介入）。denylist 已在 sanitizeToolArgs 内先挡。
    let consent: DeviceRequestMessage["consent"] | undefined
    if (rec.permissionsEnabled) {
      const path = typeof cleaned.args.path === "string" ? cleaned.args.path : ""
      const explicitToken = input.authorizationToken !== undefined && input.authorizationToken !== null
      let granted = false
      /** once 自动核销成功的许可根（仅在无显式 token 且规则未放行时产生）。 */
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
          // once 自动核销：opencode 的 local_files 从不下发 authorization_token ⇒ once 结构性
          // 死路。显式 token 已在上方优先处理；此处只处理「完全没带 token」的情形：主动找一笔
          // {tenant, tool, path} 相符、未使用的一次性许可核销，成功即本次放行。找不到仍维持
          // needs_authorization（且 denylist／safety 的 deny 已先返回，不放宽）。
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
              message: "此路径尚未授权。",
              needsAuthorization: { root, reason: mapAskReason(verdict.reason), options: AUTHORIZATION_OPTIONS },
            }
          }
        }
      }
      // 组同意记录（随本则 message 送到装置落地）：once 核销优先；否则送 session/permanent
      // 的累积同意。**依本请求路径落在哪种 scope 的根决定下发 scope**，且 roots 只取该
      // scope 的：绝不把 session 同意以 permanent 名义送到装置（否则装置会把 session 根
      // 永久落盘＝把同意升级；spec 硬禁）。没有任何记录＝不带此栏位（装置端不得无条件落盘）。
      if (onceRoot !== null) {
        consent = { scope: "once", roots: [onceRoot] }
      } else {
        const records = this.tenantConsent(input.tenant)
        if (records.length > 0) {
          const reqPath = typeof cleaned.args.path === "string" ? cleaned.args.path : ""
          const withinPermanent = records.some((r) => r.scope === "permanent" && isPathWithinRoot(reqPath, r.root))
          const sendScope: "session" | "permanent" = withinPermanent ? "permanent" : "session"
          const roots = [...new Set(records.filter((r) => r.scope === sendScope).map((r) => r.root))]
          if (roots.length > 0) consent = { scope: sendScope, roots }
        }
      }
      // full 语义＝家目录：装置端 allowlist 需要 home 随 consent 下发才放行家目录。
      if (rec.mode === "full" && rec.home) {
        const home = rec.home
        if (consent && consent.scope === "once") {
          // once 保持 once（不升级成 session），仅并入 home。
          if (!consent.roots.includes(home)) consent.roots = [...consent.roots, home]
        } else {
          // 不得以 permanent 下发 home：装置会把 session 根落盘成永久授权。
          const roots = consent ? consent.roots.slice() : []
          if (!roots.includes(home)) roots.push(home)
          consent = { scope: "session", roots }
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

  /** 本机端执行完（或失败）后回传；闸道在此**再验一次同意票**（过期/不匹配/重放）。 */
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
      // 验票失败不落地：票留给原请求（可能只是本机端送错票），请求照旧等／逾时。
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
    // H2 契约面第二层：装置自报递回时触碰敏感段 → 整笔拒绝、结果不落地。
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
   * 唯读快照：某 userId 的装置在线概况。**不改动任何状态**（不刷 lastSeenAt、不动
   * 待办／票），供环境事实层回答「本回合的装置桥是否可用」。`now` 可注入以便测试逾时。
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
   * W6b：某 userId 目前在线（最近心跳）装置的权限模式与授权根（环境事实层用）。
   * 无在线装置 → null（呼叫端不得猜）。**唯读、零副作用**。
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
   * 依租户挑一台装置（内部路由寻址）。**不做任何动作、不改状态**。
   * 见 `PickDeviceResult` 的五态语义。
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
   * 唯读装置概况：该租户的代表装置（见下）的 online／roots／lastHeartbeat。
   * 0 台已注册 → null。代表装置＝`pickDeviceForTenant` 可判断时取之，否则取最近心跳者
   * （唯读查询，不涉及动作选择，故可回报「最近看到的那台」；**不**用于 invoke 寻址）。
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

  /** 测试/运维用：装置数、待办数。 */
  stats(): { devices: number; pending: number; consentTokens: number } {
    return { devices: this.devices.size, pending: this.pending.size, consentTokens: this.tokens.size() }
  }
}

/** 闸道进程单例（记忆体状态；session 同意另落本地单档以跨重启续存）。 */
export const deviceBridge = new DeviceBridge({ sessionConsentStore: new SessionConsentStore() })

// ── 唯读查询（环境事实层用）──────────────────────────────────────────────

/**
 * 本机档案通道的执行期状态快照（环境事实层 localBridge 的来源）。
 * `enabled`＝总开关（env）；`online`＝该使用者此刻有在线装置；`deviceCount`＝该使用者
 * 已注册装置数（含离线）；`authorizedRootCount`＝在线装置合计已授权根数（0＝在线但未授权）。
 */
export interface DeviceBridgeRuntimeState {
  enabled: boolean
  online: boolean
  deviceCount: number
  authorizedRootCount: number
}

/**
 * 回答「某个 userId 目前是否有在线装置、该装置是否已授权根」。纯读、零副作用、零网路。
 *
 * 契约：
 *   - 总开关未开 → `{ enabled:false, ... }`（呼叫端据此判 `off`）。
 *   - `userId === null` ＝取不到使用者身分；本函式仍会回报（只匹配 null-tenant 装置），
 *     但环境事实层对 null 一律维持 `unknown`（不得猜），不采用本回报判定通道状态。
 *   - 查询本身不会抛（记忆体 map 遍历）；呼叫端仍应 try/catch 以求 fail-safe（→ unknown）。
 * 绝不改动注册／心跳／invoke／同意票的任何行为。
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

/** W6b：本机档案权限模式与授权根的执行期快照（环境事实层用）。 */
export interface DeviceBridgePolicyState {
  mode: DeviceBridgeMode
  authorizedRoots: string[]
}

/**
 * 回答「某个 userId 目前在线装置的本机档案权限模式与授权根清单」。纯读、零副作用。
 * 总开关未开／userId 未知／无在线装置 → null（呼叫端不得猜）。
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

// ── HTTP 路由（仅在 deviceBridgeEnabled() 为真时由 router 呼叫）──────────

interface DeviceBridgeRouteCtx {
  rawKey: string
  pathname: string
  /**
   * 短效装置票（`sk-dev-…`）已由 router 核销好的身分。有值时**不再**打正典化端点
   * （票本身就绑定了当初铸票那一把 sk-biz 的正典身分，tenant 逐字一致）。
   */
  deviceIdentity?: { tenant: string; userId: number | null; keyHash: string }
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

/** needs_authorization：**HTTP 200**（授权发生在对话里，不是错误页；见冻结契约）。 */
function needsAuthorizationResponse(info: NeedsAuthorizationInfo): Response {
  return Response.json(
    {
      ok: false,
      error: {
        code: "needs_authorization",
        message: "此路径尚未授权。",
        root: info.root,
        reason: info.reason,
        options: info.options,
      },
    },
    { status: 200 },
  )
}

/**
 * 装置桥 HTTP 路由。挂载点：`/agent/v1/device-bridge/*`，经既有 Bearer sk-biz-* 闸门。
 *  - POST /register  ← 本机 daemon 启动时注册（出站）
 *  - POST /heartbeat ← 心跳
 *  - POST /poll      ← 取件（可长轮询）
 *  - POST /result    ← 执行后回传（带同意票）
 *  - POST /invoke    ← 云端 agent 发起本机档案操作
 */
export async function handleDeviceBridgeRoutes(req: Request, ctx: DeviceBridgeRouteCtx): Promise<Response> {
  if (!deviceBridgeEnabled()) {
    // 第二道保险：即使 router 误挂，开关关闭时端点不存在。
    return errorResponse(404, "not_found", "device bridge is disabled")
  }
  if (req.method !== "POST") return errorResponse(405, "method_not_allowed", "POST only")

  // 两条鉴权路径（router 已分派好）：
  //   ① 短效装置票（ctx.deviceIdentity 已由 router 核销）：直接采用，不打网路。
  //   ② 既有 Bearer sk-biz-*（云端 agent／操作者）：走正典化，行为逐行不变。
  const identity = ctx.deviceIdentity ?? (await resolveCanonicalIdentity(ctx.rawKey))
  const apiKeyHash = ctx.deviceIdentity?.keyHash ?? (await hashKey(ctx.rawKey))
  const tenant = ctx.deviceIdentity?.tenant ?? (identity.userId != null ? `u:${identity.userId}` : `k:${apiKeyHash}`)

  const body = await readJsonBody(req)
  if (body === null) return errorResponse(400, "bad_request", "invalid json body")

  const deviceId = typeof body.device_id === "string" ? body.device_id : ""
  const connectionId = typeof body.connection_id === "string" ? body.connection_id : ""

  switch (ctx.pathname) {
    case "/agent/v1/device-bridge/permissions": {
      if (!isDeviceBridgeMode(body.mode)) return errorResponse(400, "bad_request", "mode must be off|ask|auto|full")
      saveTenantPermissionMode(tenant, body.mode)
      if (body.mode === "full") {
        const { approveTenantPendingCharges } = await import("./media-internal-routes.ts")
        await approveTenantPendingCharges(tenant)
      }
      return Response.json({ ok: true, mode: body.mode })
    }
    case "/agent/v1/device-bridge/token": {
      // 铸一张短效装置票给**已登录的页面／桌面壳**（页面→站内服务端→此处，Bearer 是
      // 服务端持有的 sk-biz-*）。票本身即身分凭据，故只以 sk-biz 路径可达：
      // router 刻意不把 sk-dev 分派到本端点（禁止以票铸票）。
      if (ctx.deviceIdentity) {
        return errorResponse(401, "unauthorized", "device ticket cannot mint another device ticket")
      }
      const token = issueDeviceTicket({ tenant, userId: identity.userId, keyHash: apiKeyHash })
      return Response.json({
        ok: true,
        token,
        expires_in_sec: Math.floor(DEVICE_TICKET_TTL_MS / 1000),
        gateway_base_url: DEVICE_GATEWAY_BASE_URL,
      })
    }
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
      if (reg.mode === "full") {
        const { approveTenantPendingCharges } = await import("./media-internal-routes.ts")
        await approveTenantPendingCharges(tenant)
      }
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

// ── 内部路由（/internal/device/*）──────────────────────────────────────
//
// 为什么需要（第一性原理）：agent 工具跑在 **opencode-server 服务内**（同一台 VPS、
// loopback），它只知道 `session_id`，不知道装置凭证／`device_id`；也不该拿到装置凭证。
// 既有 `/agent/v1/device-bridge/invoke` 需要呼叫方带 `device_id` 且经 Bearer 闸门，
// 工具端拿不到。此处补一条**只做寻址与转发**的内部入口：由 `session_id` 解析出租户
// （`u:<userId>`），挑该租户唯一在线装置，再交给既有 `DeviceBridge.invoke`。
//
// 三道防线（denylist `isSensitivePath`／授权根 `path_not_authorized`／工具白名单）
// 全在既有 `invoke` → `sanitizeToolArgs` 内，本路由**不新增、不放宽**任何检查。
// 保护层＝router 的 `/internal/` loopback 门（与 `/internal/media/upload` 同一层）。

/** 内部装置路由的依赖注入（测试免真会话/真网路；生产由 router 提供真 resolver）。 */
export interface InternalDeviceRouteDeps {
  /**
   * `session_id` → 租户（`u:<userId>`）。解析不到回 `null` ⇒ `session_unknown`。
   * 生产实作＝与 `/internal/media/upload` 同源的 session 解析（`resolveSession` →
   * `subagentParentState`）＋既有正典化 `resolveCanonicalIdentity(session.apiKey)`。
   */
  resolveTenant: (sessionId: string) => Promise<string | null>
  /** 装置桥实例（测试注入）；预设制程单例 `deviceBridge`。 */
  bridge?: DeviceBridge
}

/** op → 既有 `DeviceBridgeTool` 的**一对一**映射（不得新增／改名工具）。 */
const INTERNAL_DEVICE_OPS: readonly DeviceBridgeTool[] = ["list_dir", "read_file", "grep", "stat"]

function isInternalDeviceOp(v: string): v is DeviceBridgeTool {
  return (INTERNAL_DEVICE_OPS as readonly string[]).includes(v)
}

function internalDeviceError(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, error: { code, message } }, { status })
}

/**
 * 内部契约错误码（冻结）：把既有 `DeviceBridgeErrorCode` 收敛到冻结清单。
 * `device_request_timeout` → `device_timeout`；`bad_request` 保留；
 * 其余（含 device_op_failed／consent_token_*／device_request_not_found）→ `internal_error`。
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
      // 一般由此前的专属分支处理（HTTP 200）；保留在此作型别闭合（不应走到）。
      return { status: 200, code: "needs_authorization" }
    case "device_offline":
    case "device_connection_stale":
      return { status: 404, code: "device_offline" }
    default:
      return { status: 502, code: "internal_error" }
  }
}

/**
 * 冻结 body → 既有 `sanitizeToolArgs` 的 args 白名单（栏位名映射，语义沿用既有净化）。
 * 只放行冻结契约列出的栏位：path / pattern / max_bytes / limit / offset（+ list_dir 的 max_entries）。
 * 夹制全在 sanitizeToolArgs。
 */
function buildInternalDeviceArgs(tool: DeviceBridgeTool, body: Record<string, unknown>): Record<string, unknown> {
  const path = typeof body.path === "string" ? body.path : ""
  switch (tool) {
    case "list_dir": {
      const args: Record<string, unknown> = { path }
      // 冻结栏位名 max_entries：装置端既有参数（bridge-executor 已读 args.max_entries），
      // 1..2000 夹制仍在 sanitizeToolArgs；缺省时不下发，装置沿用既有 MAX_LIST_DEFAULT。
      if (body.max_entries !== undefined) args.max_entries = body.max_entries
      return args
    }
    case "read_file": {
      const args: Record<string, unknown> = { path }
      if (body.limit !== undefined) args.limit = body.limit
      // 冻结栏位名 offset：装置端既有参数（bridge-executor 已读 args.offset），
      // ≥0 整数夹制仍在 sanitizeToolArgs（唯一夹制点）；缺省时不下发，装置沿用既有预设 0。
      if (body.offset !== undefined) args.offset = body.offset
      return args
    }
    case "grep": {
      const args: Record<string, unknown> = { path, pattern: typeof body.pattern === "string" ? body.pattern : "" }
      // 冻结栏位名 `max_bytes` → 既有净化栏位 `max_file_bytes`（不改语义）。
      if (body.max_bytes !== undefined) args.max_file_bytes = body.max_bytes
      return args
    }
    default:
      return { path }
  }
}

/**
 * POST /internal/device/invoke?session_id=… — 云端 agent 工具读本机档的**内部**入口。
 * 只寻址＋转发；逾时由既有 `invoke` 的 `DEVICE_REQUEST_TIMEOUT_MS` 保证（不永久 pending）。
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
    // gateway tsconfig strict:false ⇒ boolean 字面量判别式不窄化，显式转型（本档既有同款）。
    const perr = pick as { ok: false; code: "no_device_registered" | "device_offline" | "device_ambiguous"; message: string }
    return internalDeviceError(perr.code === "device_ambiguous" ? 409 : 404, perr.code, perr.message)
  }

  const out = await bridge.invoke({ tenant, deviceId: (pick as { ok: true; deviceId: string }).deviceId, tool, args, authorizationToken: body.authorization_token })
  if (!out.ok) {
    const oerr = out as { ok: false; code: DeviceBridgeErrorCode; message: string; needsAuthorization?: NeedsAuthorizationInfo }
    // needs_authorization：HTTP 200（授权发生在对话里），body 形状照冻结契约。
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
 * GET /internal/device/status?session_id=… — 本会话租户的装置概况（唯读）。
 * 无已注册装置 → `device: null`（不是错误）。
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
 * POST /internal/device/authorize?session_id=… — 对话中授权本机路径（loopback-only）。
 *
 * scope：
 *   - `once`：不落规则，签一枚一次性许可（带 TTL）并回 `token`；
 *     下一次 invoke 带 `authorization_token` 使用，用一次即失效。
 *   - `session`：加进该 session 的规则集（记忆体，随 session 生命周期；本进程内）。
 *   - `permanent`：gateway **不持久化**，回 `persist_on_device:true`，由装置端落地；
 *     gateway 只把它加进当前 session 规则集。
 * **一律不在 gateway 端持久化规则到共享库**（避免跨租户泄漏）。
 *
 * 错误码：bad_request／session_unknown／root_not_absolute／root_too_broad／denylisted_root。
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
    // 另存同意记录：invoke 会把它随 DeviceRequestMessage.consent 送到装置端落地。
    // 带 tool 以便 gateway 重启后从落盘档精确重建规则；session/permanent 会落 gateway 本地档。
    bridge.addSessionConsent(tenant, { scope, root: absRoot, tool: ruleTool })
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
