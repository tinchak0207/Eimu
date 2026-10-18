// permission-http.ts — 权限内核的内部 HTTP 面。
//
// 路由：POST /internal/permission/evaluate | /rules | /state
// 约束：
// - 只做参数校验与转发；求值全部在 permission-policy.ts（纯函数）。
// - 不自行鉴权：/internal/ 由网关既有闸门统一守门。
// - body 上限 1MB；解析失败一律 400，不把异常抛给上层。

import {
  evaluateToolPermission,
  getPolicyState,
  isPermissionMode,
  isRuleDestination,
  updateRules,
  type Behavior,
  type PermissionContext,
  type PermissionMode,
  type RuleAction,
} from "./permission-policy.ts"

const MAX_BODY_BYTES = 1024 * 1024

const ACTIONS: ReadonlySet<string> = new Set([
  "setMode",
  "addRules",
  "replaceRules",
  "removeRules",
  "addDirectories",
  "removeDirectories",
])

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })
}

function error(status: number, code: string, message: string): Response {
  return json(status, { ok: false, code, error: message })
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null
  try {
    const parsed = await req.json()
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  return typeof value === "string" ? value.trim() : ""
}

function objectField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key]
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function booleanField(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key]
  return typeof value === "boolean" ? value : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
}

interface PathFlags {
  symlink?: boolean
  realpath?: string
}

function pathFlagsOf(context: Record<string, unknown>): Record<string, PathFlags> {
  const raw = context.path_flags ?? context.pathFlags
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, PathFlags> = {}
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    out[path] = {
      ...(entry.symlink === true ? { symlink: true } : {}),
      ...(typeof entry.realpath === "string" && entry.realpath ? { realpath: entry.realpath } : {}),
    }
  }
  return out
}

function buildContext(raw: Record<string, unknown>): PermissionContext {
  const pathFlags = pathFlagsOf(raw)
  const readOnlyTools = stringArray(raw.read_only_tools ?? raw.readOnlyTools)
  const pathCaseInsensitive = booleanField(raw, "case_insensitive_path") ?? booleanField(raw, "caseInsensitivePath")
  const context: PermissionContext = {
    ...(typeof raw.mode === "string" && isPermissionMode(raw.mode) ? { mode: raw.mode } : {}),
    ...(typeof raw.cwd === "string" && raw.cwd ? { cwd: raw.cwd } : {}),
    ...(typeof raw.home === "string" && raw.home ? { home: raw.home } : {}),
    ...(typeof raw.settings_dir === "string" && raw.settings_dir ? { settingsDir: raw.settings_dir } : {}),
    ...(typeof raw.settingsDir === "string" && raw.settingsDir ? { settingsDir: raw.settingsDir } : {}),
    restricted: booleanField(raw, "restricted"),
    bypassDisabled: booleanField(raw, "bypass_disabled") ?? booleanField(raw, "bypassDisabled"),
    isBypassPermissionsModeAvailable:
      booleanField(raw, "is_bypass_permissions_mode_available") ??
      booleanField(raw, "isBypassPermissionsModeAvailable"),
    autoModeAvailable: booleanField(raw, "auto_mode_available") ?? booleanField(raw, "autoModeAvailable"),
    dangerouslyDisableSandboxAllowed:
      booleanField(raw, "dangerously_disable_sandbox_allowed") ??
      booleanField(raw, "dangerouslyDisableSandboxAllowed"),
    additionalDirectories:
      stringArray(raw.additional_directories ?? raw.additionalDirectories) ?? undefined,
    ...(pathCaseInsensitive === undefined ? {} : { caseInsensitivePath: pathCaseInsensitive }),
    ...(readOnlyTools
      ? { isReadOnlyTool: (tool: string) => readOnlyTools.includes(tool.toLowerCase()) }
      : {}),
  }

  if (Object.keys(pathFlags).length > 0) {
    context.realpath = (path: string) => pathFlags[path]?.realpath ?? pathFlags[path.replace(/\\/g, "/")]?.realpath
    context.isSymlink = (path: string) =>
      pathFlags[path]?.symlink === true || pathFlags[path.replace(/\\/g, "/")]?.symlink === true
  }

  const rules = objectField(raw, "rules")
  if (Object.keys(rules).length > 0) {
    const parsed: Partial<Record<Behavior, string[]>> = {}
    for (const behavior of ["allow", "ask", "deny"] as const) {
      const values = stringArray(rules[behavior])
      if (values) parsed[behavior] = values
    }
    context.rules = parsed
  }

  return context
}

async function handleEvaluate(body: Record<string, unknown>): Promise<Response> {
  const sessionId = stringField(body, "session_id")
  if (!sessionId) return error(400, "bad_request", "session_id is required")
  const tool = stringField(body, "tool")
  if (!tool) return error(400, "bad_request", "tool is required")
  const tenant = stringField(body, "tenant") || "default"
  const input = objectField(body, "input")
  const contextRaw = objectField(body, "context")

  const rawMode = contextRaw.mode
  if (rawMode !== undefined && !isPermissionMode(rawMode)) {
    return error(400, "invalid_mode", `unknown permission mode: ${String(rawMode)}`)
  }

  const decision = evaluateToolPermission({
    sessionId,
    tenant,
    tool,
    input,
    context: buildContext(contextRaw),
  })

  return json(200, {
    ok: true,
    behavior: decision.behavior,
    reason: decision.reason,
    ...(decision.suggestions ? { suggestions: decision.suggestions } : {}),
  })
}

async function handleRules(body: Record<string, unknown>): Promise<Response> {
  const sessionId = stringField(body, "session_id")
  if (!sessionId) return error(400, "bad_request", "session_id is required")
  const tenant = stringField(body, "tenant") || "default"
  const action = stringField(body, "action")
  if (!ACTIONS.has(action)) {
    return error(400, "invalid_action", `unknown action: ${action || "(empty)"}`)
  }

  const destination = stringField(body, "destination")
  if (action !== "setMode" && !isRuleDestination(destination)) {
    return error(400, "invalid_destination", "destination must be session, localSettings, userSettings or projectSettings")
  }

  const modeRaw = body.mode
  if (modeRaw !== undefined && !isPermissionMode(modeRaw)) {
    return error(400, "invalid_mode", `unknown permission mode: ${String(modeRaw)}`)
  }

  const rules = body.rules === undefined ? undefined : stringArray(body.rules)
  if (body.rules !== undefined && rules === undefined) {
    return error(400, "invalid_rules", "rules must be an array of rule strings")
  }

  const behavior = stringField(body, "behavior")
  if (behavior && behavior !== "allow" && behavior !== "ask" && behavior !== "deny") {
    return error(400, "invalid_behavior", "behavior must be allow, ask or deny")
  }

  const result = updateRules({
    sessionId,
    tenant,
    destination: destination || undefined,
    action: action as RuleAction,
    rules,
    mode: modeRaw as PermissionMode | undefined,
    behavior: behavior ? (behavior as Behavior) : undefined,
    directories: stringArray(body.directories),
    restricted: booleanField(body, "restricted"),
    bypassDisabled: booleanField(body, "bypass_disabled") ?? booleanField(body, "bypassDisabled"),
    isBypassPermissionsModeAvailable:
      booleanField(body, "is_bypass_permissions_mode_available") ??
      booleanField(body, "isBypassPermissionsModeAvailable"),
    autoModeAvailable: booleanField(body, "auto_mode_available") ?? booleanField(body, "autoModeAvailable"),
  })

  if (!result.ok) {
    const status = result.code === "bypass_restricted" || result.code === "bypass_disabled" || result.code === "bypass_not_launched" ? 403 : 400
    return json(status, result)
  }
  return json(200, result)
}

async function handleState(body: Record<string, unknown>): Promise<Response> {
  const sessionId = stringField(body, "session_id")
  if (!sessionId) return error(400, "bad_request", "session_id is required")
  const tenant = stringField(body, "tenant") || "default"
  return json(200, { ok: true, session_id: sessionId, tenant, state: getPolicyState(sessionId, tenant) })
}

/**
 * POST /internal/permission/evaluate|rules|state
 * 非 POST 一律 405；未知路由 404。
 */
export async function handlePermission(req: Request, pathname: string): Promise<Response> {
  if (req.method !== "POST") {
    return error(405, "method_not_allowed", "method not allowed")
  }

  const body = await readBody(req)
  if (!body) return error(400, "bad_request", "invalid json body")

  try {
    if (pathname === "/internal/permission/evaluate") return await handleEvaluate(body)
    if (pathname === "/internal/permission/rules") return await handleRules(body)
    if (pathname === "/internal/permission/state") return await handleState(body)
    return error(404, "not_found", "unknown permission route")
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "permission handler failed"
    return error(500, "internal_error", message)
  }
}
