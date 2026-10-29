// S9：工程图工具面共用的网关客户端（opencode-runtime 侧）。
//
// 工具不持有 actor：网关按 sessionID 解析席位（主席位=agent／子代理席位=subagent+lane），
// 也不持有用户 key：内部路由鉴权用 loopback + X-Internal-Token（与 task-board 家族同款）。
// {op:"dsl"} 的展开在工具端完成：先取当前图摘要当 current，交站点 compile(target:"project")
// 得到强类型 PatchOp[]，再送 /internal/project/patch（网关不收 dsl，§3.4）。
import { platformFetch } from "./client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

/**
 * 工具侧长轮询上限。契约 LIMITS.WAIT_SEC_MAX=90 不变；但网关 R5-C 中段停滞哨
 * （timers-gw.ts armMidturnStallTimer，MIDTURN_STALL_MS=90000）在「零帧 90 秒」时会单次重投
 * 同一 prompt——一次 90 秒的静默工具调用正好压在阈上。工具侧压到 60 秒留 30 秒余量；
 * 事件到达即返回，所以多数调用远短于此。超出部分由调用方用返回的 cursor 再轮询。
 */
export const PROJECT_WAIT_MAX_SEC = 60

/** 内部路由统一请求头；未配置令牌时兼容 loopback（与 lib/client 的 harnessInternalHeaders 同源）。 */
function internalHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const token = process.env.HARNESS_INTERNAL_TOKEN
  if (token) headers["X-Internal-Token"] = token
  return headers
}

export interface GatewayCallResult<T> {
  ok: boolean
  status: number
  data: T | null
  error?: { code: string; message: string }
}

async function projectRequest<T>(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<GatewayCallResult<T>> {
  let res: Response
  try {
    res = await fetch(`${GATEWAY}${path}`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    return { ok: false, status: 0, data: null, error: { code: "gateway_unreachable", message: (e as Error)?.message ?? String(e) } }
  }
  const data = (await res.json().catch(() => null)) as T | null
  if (!res.ok) {
    const err = (data as unknown as { error?: { code?: string; message?: string } } | null)?.error
    return {
      ok: false,
      status: res.status,
      data: null,
      error: { code: typeof err?.code === "string" ? err.code : `http_${res.status}`, message: typeof err?.message === "string" ? err.message : `HTTP ${res.status}` },
    }
  }
  return { ok: true, status: res.status, data }
}

export interface ProjectCallArgs {
  view?: "digest" | "node" | "events" | "brief"
  message_id?: string
  offset?: number
  limit?: number
  node?: string
  since?: number
  wait_sec?: number
  detail?: "summary" | "full"
}

/** 工具侧等待秒数：钳到 0..PROJECT_WAIT_MAX_SEC（HTTP 超时另加 20 秒余量）。 */
export function toolWaitSec(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(PROJECT_WAIT_MAX_SEC, Math.floor(raw))
}

export async function projectGet(sessionID: string, args: ProjectCallArgs): Promise<GatewayCallResult<Record<string, unknown>>> {
  const waitSec = toolWaitSec(args.wait_sec)
  return projectRequest(`/internal/project/get`, {
    session_id: sessionID,
    ...(args.view ? { view: args.view } : {}),
    ...(typeof args.node === "string" ? { node: args.node } : {}),
    ...(typeof args.message_id === "string" ? { message_id: args.message_id } : {}),
    ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
    ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
    ...(typeof args.since === "number" ? { since: args.since } : {}),
    ...(waitSec > 0 ? { wait_sec: waitSec } : {}),
    ...(args.detail ? { detail: args.detail } : {}),
  }, (waitSec + 20) * 1000)
}

/** 工具端展开 DSL 需要的当前图摘要（网关内部扩展视图 view:"nodes"）。 */
export async function projectNodes(sessionID: string): Promise<GatewayCallResult<{ nodes: Record<string, unknown>[]; version?: number; project_mode?: boolean; project_state?: string }>> {
  return projectRequest(`/internal/project/get`, { session_id: sessionID, view: "nodes", create: false }, 20_000)
}

export async function projectPatch(sessionID: string, args: { ops: unknown[]; baseVersion?: number; atomic?: boolean }): Promise<GatewayCallResult<Record<string, unknown>>> {
  return projectRequest(`/internal/project/patch`, {
    session_id: sessionID,
    ops: args.ops,
    ...(typeof args.baseVersion === "number" ? { baseVersion: args.baseVersion } : {}),
    ...(typeof args.atomic === "boolean" ? { atomic: args.atomic } : {}),
  }, 30_000)
}

export interface ProjectGenerateArgs {
  request_id: string
  kind: "image" | "video"
  payload?: Record<string, unknown>
  identity?: Record<string, unknown>
  lock?: Record<string, unknown>
  project_budget_coins?: number
  node_id?: string
  legacy_ref?: { task_id: string; kind: "image" | "video"; request_id?: string; source: "retry_task_id" | "journal" }
}

/** 预处理保留在原工具，付费副作用进入已存在的工程runner。调用体不能指定actor/owner。 */
export async function projectGenerate(sessionID: string, args: ProjectGenerateArgs): Promise<GatewayCallResult<Record<string, unknown>>> {
  return projectRequest("/internal/project/generate", { session_id: sessionID, ...args }, 45_000)
}

export async function projectRun(sessionID: string, args: { targets?: string[]; mode?: "incremental" | "force"; dry_run?: boolean; budget_coins?: number; wait_sec?: number }): Promise<GatewayCallResult<Record<string, unknown>>> {
  const waitSec = toolWaitSec(args.wait_sec)
  return projectRequest(`/internal/project/run`, {
    session_id: sessionID,
    ...(Array.isArray(args.targets) ? { targets: args.targets } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
    ...(typeof args.dry_run === "boolean" ? { dry_run: args.dry_run } : {}),
    ...(typeof args.budget_coins === "number" ? { budget_coins: args.budget_coins } : {}),
    ...(waitSec > 0 ? { wait_sec: waitSec } : {}),
  }, (waitSec + 20) * 1000)
}

export interface DslExpansion {
  ok: boolean
  ops?: unknown[]
  errors?: string[]
  warnings?: string[]
  baseVersion?: number
}

/**
 * {op:"dsl"} → PatchOp[]：站点编译器是唯一 DSL 真源（S13），工具只搬运。
 * current.nodes = 工程图现有节点摘要；缺席按空工程算（首次建图）。
 */
export async function expandProjectDsl(source: unknown, sessionID: string, signal?: AbortSignal): Promise<DslExpansion> {
  const current = await projectNodes(sessionID)
  if (!current.ok) {
    return { ok: false, errors: [`读取当前工程图失败：${current.error?.code ?? "unknown"} ${current.error?.message ?? ""}`.trim()] }
  }
  let res: Response
  try {
    res = await platformFetch(
      "/workflow/compile",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, current: { nodes: current.data?.nodes ?? [] }, target: "project" }),
      },
      sessionID,
      signal ?? AbortSignal.timeout(30_000),
    )
  } catch (e) {
    return { ok: false, errors: [`站点编译器不可达：${(e as Error)?.message ?? String(e)}`] }
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok || body?.success !== true) {
    const errors = Array.isArray(body?.errors)
      ? (body?.errors as unknown[]).map((e) => (typeof e === "string" ? e : JSON.stringify(e))).slice(0, 8)
      : [String(body?.error ?? body?.code ?? `HTTP ${res.status}`)]
    return { ok: false, errors }
  }
  if (!Array.isArray(body?.ops)) return { ok: false, errors: ["编译器回包缺少 ops 数组"] }
  const summary = body?.summary as Record<string, unknown> | undefined
  const warnings = Array.isArray(summary?.warnings) ? (summary?.warnings as unknown[]).map(String).slice(0, 3) : []
  return { ok: true, ops: body.ops as unknown[], errors: [], warnings, baseVersion: current.data?.version }
}
