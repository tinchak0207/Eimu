/**
 * memory-http.ts — `/internal/memory/{save,list,read,note}` 内部端点。
 *
 * 约束：
 * - loopback 鉴权由 router 上游 `/internal/*` 闸门负责；本档不重复鉴权。
 * - **租户隔离（P0-1）**：tenant/workspace/session 一律由网关 `resolveSession(session_id)`
 *   解析得出，绝不信任请求体的 tenant_id/workspace_dir；请求体显式给出且与解析结果不符
 *   时直接 403（跨 tenant 读必须 403）。
 * - **只接 POST**：router 也只路由 POST；不保留 GET 死码（P1-12）。
 * - 错误只回 code + 一句话，不回声内容、凭据或栈。
 * - `note`（2026-10-19）：模型只交事实＋证据，结构由 `memory-note.ts` 确定性补齐；
 *   ownerKey 一律取服务端解析出的会话身份（`hashKey(state.apiKey)`），**不信请求体**；
 *   正文（fact/evidence）永不进 log。
 */
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { hashKey } from "./auth-gw.ts"
import { billingPermissionTenant } from "./charge-approval-policy.ts"
import { MEMORY_INGEST_BASE_URL, MEMORY_INGEST_SECRET, MEMORY_SHARED_ENABLED } from "./constants-gateway.ts"
import { MEMORY_PROMPT_VERSION, MEMORY_SIGNATURE_HEADER, signMemoryBytes } from "./memory-batch.ts"
import { applyMemoryGates } from "./memory-gate.ts"
import { normalizeMemoryNote } from "./memory-note.ts"
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

// ─────────────────────────── note 通道（低成本记忆，2026-10-19）

const NOTE_INGEST_PATH = "/api/agent/memory/ingest"
/** 单次上游送出上限：与批次同数量级，但 note 是交互路径 → 不重试、不排队。 */
const NOTE_INGEST_TIMEOUT_MS = 15_000

/**
 * POST /internal/memory/note 的实作。
 *
 * 顺序＝确定性规范化（memory-note）→ 既有闸门 G1-G7（与批次同一份 `applyMemoryGates`）
 * → 单文档 HMAC 批次送出。任何失败只回 reason 代号，不回显正文。
 * `sessionId` / `apiKey` 必须来自 `resolveSession`，ownerKey 只在此处派生。
 */
async function handleMemoryNote(
  body: Record<string, unknown>,
  sessionId: string,
  apiKey: string,
): Promise<Response> {
  const fact = readString(body, ["fact"])
  const evidence = readString(body, ["evidence"])
  const source = readString(body, ["source"])
  if (fact === undefined || evidence === undefined || source === undefined) {
    return badRequest("fact, evidence and source are required")
  }

  // 身份唯一真源：服务端会话 → hashKey(apiKey)（与 memory-batch 的 session.ownerKey 同算法）。
  const ownerKey = await hashKey(apiKey)

  const normalized = normalizeMemoryNote(
    {
      fact,
      evidence,
      source: source as "tool_result" | "user_confirmed",
      scope: readString(body, ["scope"]) as "private" | "shared" | undefined,
      domain: readString(body, ["domain"]),
      slug: readString(body, ["slug"]),
      type: readString(body, ["type"]) as
        | "user"
        | "feedback"
        | "project"
        | "domain"
        | "workflow"
        | undefined,
    },
    { ownerKeyHint: ownerKey },
  )
  if (normalized.ok !== true) return badRequest(normalized.reason)

  // 再走一遍与批次共用的 G1-G7：结构/证据之外，G3 凭证、G4 身份、G7 跨租户注入。
  const gated = applyMemoryGates(normalized.candidate, {
    sharedEnabled: MEMORY_SHARED_ENABLED,
    ownerKeyHint: ownerKey,
  })
  if (gated.action === "drop" || !gated.doc) return badRequest(gated.reason)

  const doc = { ...gated.doc }
  // private 的归属由服务端身份补齐（与 memory-batch 逐行同义）；shared 由 gates 填 contributorKey。
  if (doc.scope === "private" && !doc.ownerKey) doc.ownerKey = ownerKey

  // batch_id 不含正文：note-<UTC 日期>-<session 短哈希>。
  const day = new Date().toISOString().slice(0, 10)
  const sessionShort = createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 8)
  const batchId = `note-${day}-${sessionShort}`
  const rawBody = JSON.stringify({
    batch_id: batchId,
    prompt_version: MEMORY_PROMPT_VERSION,
    docs: [doc],
  })

  const secret = String(MEMORY_INGEST_SECRET ?? "").trim()
  if (!secret) {
    // 配置缺失属服务端状态，不把任何密钥派生/路径细节回给调用方。
    return errorResponse("ingest_unavailable", "memory ingest is not configured", 503)
  }

  let status: number
  let json: unknown = null
  try {
    const res = await fetch(`${MEMORY_INGEST_BASE_URL}${NOTE_INGEST_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [MEMORY_SIGNATURE_HEADER]: signMemoryBytes(rawBody, secret),
      },
      body: rawBody, // 原样位元组串，严禁重新序列化（签名即失效）
      signal: AbortSignal.timeout(NOTE_INGEST_TIMEOUT_MS),
    })
    status = res.status
    json = await res.json().catch(() => null)
  } catch {
    // 不重试：交互路径重放会放大写入（幂等由端点 G5 兜，但这里不做重试队列）。
    return errorResponse("ingest_failed", "memory ingest request failed", 502)
  }
  if (status < 200 || status >= 300) {
    return errorResponse("ingest_failed", "memory ingest rejected the batch", 502)
  }

  const record = isRecord(json) ? json : {}
  const accepted = Array.isArray(record.accepted)
    ? record.accepted.filter((id): id is string => typeof id === "string")
    : []
  const rejected = Array.isArray(record.rejected) ? record.rejected : []
  // 未提升的正文提案（`proposals`）：不是真写入，原样带回给工具端区分「实写／提案」。
  const proposals = Array.isArray(record.proposals)
    ? record.proposals.filter((id): id is string => typeof id === "string")
    : []
  return Response.json(
    { ok: true, accepted, rejected, proposals },
    { headers: { "Cache-Control": "no-store" } },
  )
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
  if (route !== "save" && route !== "list" && route !== "read" && route !== "note") {
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
  const isNote = route === "note"
  let scope: MemoryScope | undefined
  let agent: string | undefined
  // note 的 scope 是 private|shared（由 memory-note 校验）；save/list/read 沿用 user|project|local。
  if (!isNote) {
    if (scopeRaw !== "user" && scopeRaw !== "project" && scopeRaw !== "local") {
      return badRequest("scope must be user, project or local")
    }
    scope = scopeRaw
    agent = readString(body, ["agent", "agent_id", "agentId"])
    if (agent === undefined || agent.trim().length === 0) return badRequest("agent is required")
  }

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

  // note：session/tenant 已解析完毕，ownerKey 由 state.apiKey 派生（绝不看请求体）。
  if (isNote) return await handleMemoryNote(body, state.sessionId, state.apiKey)

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
