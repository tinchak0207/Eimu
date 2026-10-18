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
import { escapeInjectedData, runHooks, isHookEvent, type HookRunResult } from "./harness-hooks.ts"

export const HOOKS_HTTP_PATH = "/internal/hooks/run"
export const HOOKS_HTTP_BODY_MAX_BYTES = 1024 * 1024
export const HOOKS_HTTP_TOTAL_BUDGET_MS = 60_000
/** 约束（P1-7）：压缩事件不得拖长；默认 5s，避免 PreCompact 双跑重叠。 */
export const HOOKS_HTTP_COMPACTION_TIMEOUT_MS = 5000

const COMPACTION_EVENTS = new Set(["PreCompact", "PostCompact"])

/** 事件默认预算：压缩事件 5s，其余沿用 60s 硬上限。 */
export function defaultHookBudgetMs(event: string): number {
  return COMPACTION_EVENTS.has(event) ? HOOKS_HTTP_COMPACTION_TIMEOUT_MS : HOOKS_HTTP_TOTAL_BUDGET_MS
}

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
    : defaultHookBudgetMs(event)
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

/**
 * 约束（P2-9）：先看 Content-Length；chunked 请求流式累计，超限立刻 cancel 并 413，
 * 不在 `req.text()` 里无界读入内存。
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
  const bodyRead = await readBodyLimited(req, HOOKS_HTTP_BODY_MAX_BYTES)
  if (!bodyRead.ok) {
    if (!("tooLarge" in bodyRead) || !bodyRead.tooLarge) {
      return jsonError(400, "cannot read request body", "bad_request", "bad_request")
    }
    return jsonError(413, `hook body exceeds ${HOOKS_HTTP_BODY_MAX_BYTES} bytes`, "bad_request", "body_too_large")
  }
  const raw = bodyRead.text

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

  // 压缩事件默认 5s：PreCompact 超时拖长会与 metrics-gw 的压缩任务双跑。
  const result = await runHooksWithBudget(event, input, { timeoutMs: defaultHookBudgetMs(event) })
  return Response.json({
    ok: true,
    blocked: result.blocked === true,
    ...(result.reason !== undefined ? { reason: result.reason, reason_escaped: escapeInjectedData(result.reason) } : {}),
    ...(result.additionalContext !== undefined
      ? {
          additional_context: result.additionalContext,
          // 约束（P1-6）：插件应优先消费已转义字段，避免围栏被正文伪造。
          additional_context_escaped: escapeInjectedData(result.additionalContext),
        }
      : {}),
    ...(result.systemMessage !== undefined
      ? {
          system_message: result.systemMessage,
          system_message_escaped: escapeInjectedData(result.systemMessage),
        }
      : {}),
    ...(result.timedOut === true ? { timed_out: true } : {}),
    supported: result.supported,
    ...(result.decision !== undefined ? { decision: result.decision } : {}),
    results: result.results ?? [],
    errors: result.errors ?? [],
    ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  })
}
