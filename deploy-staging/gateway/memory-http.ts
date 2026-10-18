/**
 * memory-http.ts — `/internal/memory/{save,list,read}` 内部端点。
 *
 * 约束：loopback 鉴权由 router 上游 `/internal/*` 闸门负责；本档不重复鉴权。
 * 约束：错误只回 code + 一句话，不回声内容、凭据或栈。
 */
import {
  memoryList,
  memoryRead,
  memorySave,
  MemoryError,
  type MemoryLocation,
  type MemoryScope,
  type MemoryWriteMode,
} from "./agent-memory-write.ts"

const PREFIX = "/internal/memory/"

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

export async function handleMemory(req: Request, pathname: string): Promise<Response> {
  if (!pathname.startsWith(PREFIX)) return errorResponse("not_found", "unknown memory route", 404)
  const route = pathname.slice(PREFIX.length)
  if (route !== "save" && route !== "list" && route !== "read") {
    return errorResponse("not_found", "unknown memory route", 404)
  }

  let body: Record<string, unknown> = {}
  if (req.method === "POST") {
    let parsed: unknown
    try {
      parsed = await req.json()
    } catch {
      return badRequest("invalid json body")
    }
    if (!isRecord(parsed)) return badRequest("json body must be an object")
    body = isRecord(parsed.payload) ? parsed.payload : parsed
  } else if (req.method === "GET") {
    body = Object.fromEntries(new URL(req.url).searchParams.entries())
  } else {
    return errorResponse("method_not_allowed", "use POST or GET", 405)
  }

  const scopeRaw = readString(body, ["scope"])
  if (scopeRaw !== "user" && scopeRaw !== "project" && scopeRaw !== "local") {
    return badRequest("scope must be user, project or local")
  }
  const scope: MemoryScope = scopeRaw
  const agent = readString(body, ["agent", "agent_id", "agentId"])
  if (agent === undefined || agent.trim().length === 0) return badRequest("agent is required")

  const location: MemoryLocation & { name?: string } = {
    scope,
    agent,
    tenantId: readString(body, ["tenant_id", "tenantId"]),
    workspaceDir: readString(body, ["workspace_dir", "workspaceDir"]),
    sessionId: readString(body, ["session_id", "sessionId"]),
    name: readString(body, ["name", "path"]),
  }

  try {
    if (route === "save") {
      if (req.method !== "POST") return badRequest("save requires POST")
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
    return Response.json({ success: true, ...result }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if (error instanceof MemoryError) {
      return errorResponse(error.code, error.message, error.status)
    }
    return errorResponse(
      "internal_error",
      error instanceof Error ? error.message : String(error),
      500,
    )
  }
}
