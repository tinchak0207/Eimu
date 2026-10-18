/**
 * memory-http.ts — `/internal/memory/{save,list,read}` 内部端点。
 *
 * 约束：
 * - loopback 鉴权由 router 上游 `/internal/*` 闸门负责；本档不重复鉴权。
 * - **租户隔离（P0-1）**：tenant/workspace/session 一律由网关 `resolveSession(session_id)`
 *   解析得出，绝不信任请求体的 tenant_id/workspace_dir；请求体显式给出且与解析结果不符
 *   时直接 403（跨 tenant 读必须 403）。
 * - **只接 POST**：router 也只路由 POST；不保留 GET 死码（P1-12）。
 * - 错误只回 code + 一句话，不回声内容、凭据或栈。
 */
import { resolve } from "node:path"
import { billingPermissionTenant } from "./charge-approval-policy.ts"
import { resolveSession } from "./sessions-core.ts"
import { subagentParentState } from "./subagent.ts"
import {
  fenceMemoryForPrompt,
  memoryList,
  memoryRead,
  memorySave,
  MemoryError,
  type MemoryLocation,
  type MemoryScope,
  type MemoryWriteMode,
} from "./agent-memory-write.ts"

const PREFIX = "/internal/memory/"
const DEFAULT_WORKSPACE_DIR = "/opt/agent-harness/workspace"
/** JSON 转义会膨胀，给 content 的 100KB 上限留足余量；仍然有界。 */
const MEMORY_HTTP_BODY_MAX_BYTES = 2 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "string") return value
  }
  return undefined
}

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json(
    { success: false, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  )
}

function badRequest(message: string): Response {
  return errorResponse("invalid_request", message, 400)
}

/**
 * 约束（P2-9）：先看 Content-Length；chunked 请求流式累计，超限立即停止读取
 * 并回 413，绝不先 `req.json()` 把整个 body 读进内存。
 */
async function readBodyLimited(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; tooLarge: boolean }> {
  const declared = req.headers.get("content-length")
  if (declared !== null && declared.trim().length > 0) {
    const size = Number(declared)
    if (Number.isFinite(size) && size > maxBytes) return { ok: false, tooLarge: true }
  }
  if (req.body === null) return { ok: true, text: "" }
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          // 约束：取消失败不改变超限结论。
        }
        return { ok: false, tooLarge: true }
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, tooLarge: false }
  }
  return { ok: true, text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8") }
}

/** workspace 只来自网关配置/部署环境，不从请求体取。 */
function gatewayWorkspaceDir(): string {
  const configured = process.env.HARNESS_WORKSPACE?.trim()
  return resolve(configured && configured.length > 0 ? configured : DEFAULT_WORKSPACE_DIR)
}

export async function handleMemory(req: Request, pathname: string): Promise<Response> {
  if (!pathname.startsWith(PREFIX)) return errorResponse("not_found", "unknown memory route", 404)
  const route = pathname.slice(PREFIX.length)
  if (route !== "save" && route !== "list" && route !== "read") {
    return errorResponse("not_found", "unknown memory route", 404)
  }
  if (req.method !== "POST") {
    return errorResponse("method_not_allowed", "use POST", 405)
  }

  let parsed: unknown
  const rawBody = await readBodyLimited(req, MEMORY_HTTP_BODY_MAX_BYTES)
  if (!rawBody.ok) {
    if (!("tooLarge" in rawBody) || !rawBody.tooLarge) return badRequest("cannot read request body")
    return errorResponse(
      "body_too_large",
      `request body exceeds ${MEMORY_HTTP_BODY_MAX_BYTES} bytes`,
      413,
    )
  }
  try {
    parsed = JSON.parse(rawBody.text)
  } catch {
    return badRequest("invalid json body")
  }
  if (!isRecord(parsed)) return badRequest("json body must be an object")
  const body: Record<string, unknown> = isRecord(parsed.payload) ? parsed.payload : parsed

  const scopeRaw = readString(body, ["scope"])
  if (scopeRaw !== "user" && scopeRaw !== "project" && scopeRaw !== "local") {
    return badRequest("scope must be user, project or local")
  }
  const scope: MemoryScope = scopeRaw
  const agent = readString(body, ["agent", "agent_id", "agentId"])
  if (agent === undefined || agent.trim().length === 0) return badRequest("agent is required")

  // ── 会话解析：tenant/workspace/session 的唯一真源 ──────────────────────
  const requestedSessionId = readString(body, ["session_id", "sessionId"])
  if (requestedSessionId === undefined || requestedSessionId.trim().length === 0) {
    return errorResponse("session_required", "session_id is required", 401)
  }
  // 子代理的 opencode session id 不在 resolveSession 表里：与其它 internal 端点
  // 一致，经 subagentParentState 回溯父 gateway 会话（P1-5）。
  const state = resolveSession(requestedSessionId.trim()) ?? subagentParentState(requestedSessionId.trim())
  if (!state || !state.sessionId || !state.apiKey) {
    return errorResponse("session_not_found", "unknown session", 401)
  }
  const tenant = await billingPermissionTenant(state)
  if (!tenant) return errorResponse("session_not_found", "session has no tenant identity", 401)
  const workspaceDir = gatewayWorkspaceDir()

  // 显式跨租户/跨 workspace 请求一律 403，不静默改写到本会话目录。
  const bodyTenant = readString(body, ["tenant_id", "tenantId"])
  if (bodyTenant !== undefined && bodyTenant.trim() !== tenant) {
    return errorResponse("tenant_mismatch", "tenant does not match the resolved session", 403)
  }
  const bodyWorkspace = readString(body, ["workspace_dir", "workspaceDir"])
  if (bodyWorkspace !== undefined) {
    const trimmed = bodyWorkspace.trim()
    if (trimmed.length === 0 || !trimmed.startsWith("/") || resolve(trimmed) !== workspaceDir) {
      return errorResponse("workspace_mismatch", "workspace does not match the gateway workspace", 403)
    }
  }

  const location: MemoryLocation & { name?: string } = {
    scope,
    agent,
    // 这些字段全部来自 resolveSession / 网关配置，不接受请求体覆盖。
    tenantId: tenant,
    workspaceDir,
    sessionId: state.sessionId,
    name: readString(body, ["name", "path"]),
  }

  try {
    if (route === "save") {
      const content = readString(body, ["content"])
      if (content === undefined) return badRequest("content is required")
      const modeRaw = readString(body, ["mode"])
      if (modeRaw !== undefined && modeRaw !== "overwrite" && modeRaw !== "append") {
        return badRequest("mode must be overwrite or append")
      }
      const result = await memorySave({
        ...location,
        content,
        mode: modeRaw as MemoryWriteMode | undefined,
      })
      return Response.json({ success: true, ...result }, { headers: { "Cache-Control": "no-store" } })
    }
    if (route === "list") {
      const result = await memoryList(location)
      return Response.json({ success: true, ...result }, { headers: { "Cache-Control": "no-store" } })
    }
    const result = await memoryRead(location)
    // 约束：content 保持原文给工具返回值；注入层只读围栏后的字段（P1-13）。
    return Response.json(
      { success: true, ...result, content_for_prompt: fenceMemoryForPrompt(result.content) },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (error) {
    if (error instanceof MemoryError) {
      return errorResponse(error.code, error.message, error.status)
    }
    // 约束：未预期错误不把内部路径/栈回给调用方。
    return errorResponse("internal_error", "memory operation failed", 500)
  }
}
