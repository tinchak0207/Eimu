// hooks-http.ts — harness hook 总线的进程内 HTTP 面（2026-10-18 接线）。
//
// 存在理由：hook 消费者有两个进程——
//   ① gateway 自身（SessionStart/UserPromptSubmit/Stop/PreCompact/PostCompact/
//      TaskCreated/TaskCompleted/SubagentStart/SubagentStop）；
//   ② opencode 的 eimu-guard plugin（PreToolUse/PostToolUse，跨进程）。
// ② 只能走 loopback HTTP，本档就是那条唯一入口，避免 plugin 自建第二套 hook 运行器。
//
// 契约：
//   POST /internal/hooks/run
//   body {session_id, event, payload}
//   → {ok:true, blocked, reason, additional_context, results, errors}
//   - 未知 event → 400；body >1MB → 413；坏 JSON/缺字段 → 400。
//   - 配置缺失/损坏、单个 hook 失败、总预算超时一律 fail-open：ok:true，原因进 errors，
//     绝不 500 把调用方卡死（PreToolUse 的 fail-open 语义由此保证）。
//   - 总预算 60s 是硬上限；调用方（plugin）自己用更短的 800ms 超时。
//   - 无 hooks 配置时 runHooks 只做一次文件读取即返回，零额外等待。
import { jsonError } from "./gw-lib.ts"
import { runHooks, isHookEvent, type HookRunResult } from "./harness-hooks.ts"

export const HOOKS_HTTP_PATH = "/internal/hooks/run"
export const HOOKS_HTTP_BODY_MAX_BYTES = 1024 * 1024
export const HOOKS_HTTP_TOTAL_BUDGET_MS = 60_000

export interface RunHooksBudgetOptions {
  /** 调用方预算；硬上限 60s。 */
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * runHooks 的统一入口：调用方预算 + 硬上限 + 永不 throw。
 * 超时通过 AbortSignal 传到 command/http action（harness-hooks 会杀进程组），
 * 仍以合成结果返回，调用方按 fail-open 继续。
 */
export async function runHooksWithBudget(
  event: string,
  input: Record<string, unknown>,
  opts: RunHooksBudgetOptions = {},
): Promise<HookRunResult> {
  const requested = typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.floor(opts.timeoutMs)
    : HOOKS_HTTP_TOTAL_BUDGET_MS
  const timeoutMs = Math.min(HOOKS_HTTP_TOTAL_BUDGET_MS, requested)
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener("abort", onOuterAbort, { once: true })
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await runHooks(event, input, { timeoutMs, signal: controller.signal })
  } catch (error) {
    // runHooks 内部已吞掉 action 级错误；能到这里只有运行器自身异常。
    return {
      event,
      supported: isHookEvent(event),
      blocked: false,
      results: [],
      errors: [`hook runner failed: ${error instanceof Error ? error.message : String(error)}`],
    }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener("abort", onOuterAbort)
    if (timedOut) {
      // 超时已由 AbortSignal 传下去；这里只留可对帐的一行，不改变返回值。
      console.warn(`[gateway] hooks: ${event} exceeded total budget ${timeoutMs}ms (fail-open)`)
    }
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

interface HooksRequestBody {
  session_id?: unknown
  event?: unknown
  payload?: unknown
}

/** POST /internal/hooks/run。router 只在该路径调用本函数。 */
export async function handleHooks(req: Request, pathname: string): Promise<Response> {
  if (pathname !== HOOKS_HTTP_PATH) return jsonError(404, "not found", "not_found", "not_found")
  if (req.method !== "POST") return jsonError(405, "method not allowed", "bad_request", "method_not_allowed")

  const declared = Number.parseInt(req.headers.get("content-length") || "", 10)
  if (Number.isFinite(declared) && declared > HOOKS_HTTP_BODY_MAX_BYTES) {
    return jsonError(413, `hook body exceeds ${HOOKS_HTTP_BODY_MAX_BYTES} bytes`, "bad_request", "body_too_large")
  }
  let raw: string
  try {
    raw = await req.text()
  } catch {
    return jsonError(400, "cannot read request body", "bad_request", "bad_request")
  }
  if (byteLength(raw) > HOOKS_HTTP_BODY_MAX_BYTES) {
    return jsonError(413, `hook body exceeds ${HOOKS_HTTP_BODY_MAX_BYTES} bytes`, "bad_request", "body_too_large")
  }

  let body: HooksRequestBody
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return jsonError(400, "body must be a JSON object", "bad_request", "bad_request")
    }
    body = parsed as HooksRequestBody
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }

  const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : ""
  if (!sessionId) return jsonError(400, "session_id is required", "bad_request", "bad_request")

  const event = typeof body.event === "string" ? body.event.trim() : ""
  // 未知事件名（含拼错）直接 400；33 个保留事件名全都算已知，未启用的由 runHooks
  // 返回 supported:false（ok:true），调用方零动作。
  if (!event || !isHookEvent(event)) {
    return jsonError(400, `unknown hook event: ${event || "(empty)"}`, "bad_request", "bad_request")
  }

  let payload: Record<string, unknown> = {}
  if (body.payload !== undefined && body.payload !== null) {
    if (typeof body.payload !== "object" || Array.isArray(body.payload)) {
      return jsonError(400, "payload must be a JSON object", "bad_request", "bad_request")
    }
    payload = body.payload as Record<string, unknown>
  }

  // hook_event_name/session_id 由服务端写入；payload 只能补字段，不能覆盖这两个权威值。
  const input: Record<string, unknown> = { ...payload, hook_event_name: event, session_id: sessionId }

  const result = await runHooksWithBudget(event, input)
  return Response.json({
    ok: true,
    blocked: result.blocked === true,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(result.additionalContext !== undefined
      ? { additional_context: result.additionalContext }
      : {}),
    supported: result.supported,
    ...(result.decision !== undefined ? { decision: result.decision } : {}),
    results: result.results ?? [],
    errors: result.errors ?? [],
    ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  })
}
