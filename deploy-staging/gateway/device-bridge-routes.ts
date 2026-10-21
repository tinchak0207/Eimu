import { DEVICE_TICKET_TTL_MS, hashKey, issueDeviceTicket, resolveCanonicalIdentity } from "./auth-gw.ts"
import { saveTenantPermissionMode } from "./persistence.ts"
import { authorizationRootProblem, authorizationRuleSpecifier, expandToAbsolutePreserveCase, isDeviceBridgeMode, isToolAllowed, type DeviceBridgeMode, type DeviceBridgeTool, type PermissionRule, type PermissionTool } from "./device-bridge-policy.ts"
import { SessionConsentStore } from "./device-bridge-session-consent.ts"
import { DeviceBridge } from "./device-bridge-class.ts"
import { DEVICE_GATEWAY_BASE_URL, DEVICE_ONCE_GRANT_TTL_MS, deviceBridgeEnabled, isAuthorizationScope, type DeviceBridgeErrorCode, type NeedsAuthorizationInfo } from "./device-bridge-types.ts"
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

