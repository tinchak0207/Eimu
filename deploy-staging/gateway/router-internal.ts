import { jsonError } from "./gw-lib.ts"
import { handlePlan } from "./plan-http.ts"
import { handlePermission } from "./permission-http.ts"
import { runHooksWithBudget } from "./hooks-http.ts"
import { escapeInjectedData, type HookRunResult } from "./harness-hooks.ts"
import type { PrecheckChild } from "./router-types.ts"

// ── 工具前置检查合并端点（2026-10-18）────────────────────────────────────────
// 背景：eimu-guard 的 tool.execute.before 对每个非只读工具最多 3 个 loopback 往返
// （/internal/plan/state 与 /internal/permission/evaluate 并发 + /internal/hooks/run 串行）。
// 本端点把三项合成一次请求：内部并发执行，逐项回传**等价 HTTP 状态 + 已解析 body**，
// 调用方原样套用各自原有的 fail-open/fail-closed 语义（本档不复制任何策略判断）。
// 旧三端点保留不删：旧客户端继续可用，新客户端遇到 404/405（旧网关）也回退到旧三次呼叫。
export const PRECHECK_PATH = "/internal/tool/precheck"
const PRECHECK_BODY_MAX_BYTES = 1024 * 1024
// 与插件原预算一致：plan/permission 各 800ms、hook 800ms；三者并发 ⇒ 总预算约 800ms。
const PRECHECK_STAGE_TIMEOUT_MS = 800
const PRECHECK_HOOK_BUDGET_MS = 800

function precheckIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function jsonInternalRequest(pathname: string, body: unknown): Request {
  return new Request(`http://127.0.0.1${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** 进程内调用既有 handler（零额外网络往返），单阶段预算耗尽回 status:0。 */
async function precheckChild(run: () => Promise<Response>, budgetMs: number): Promise<PrecheckChild> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = run()
    .then(async (res) => ({ status: res.status, body: (await res.json().catch(() => null)) as unknown }))
    .catch(() => ({ status: 500, body: null as unknown }))
  const timeout = new Promise<PrecheckChild>((resolve) => {
    timer = setTimeout(() => resolve({ status: 0, body: null }), budgetMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** PreToolUse hook：返回与 /internal/hooks/run 完全同形状的 body（插件用同一消费逻辑）。 */
async function precheckHook(
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<HookRunResult | null> {
  try {
    const result = await runHooksWithBudget("PreToolUse", payload, {
      timeoutMs: PRECHECK_HOOK_BUDGET_MS,
      signal,
    })
    return result
  } catch {
    // runHooksWithBudget 自身不 throw；到达这里只可能是运行器以外的事故 → hook 不可用。
    return null
  }
}

async function readPrecheckBody(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; tooLarge: boolean }> {
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
        await reader.cancel().catch(() => {})
        return { ok: false, tooLarge: true }
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, tooLarge: false }
  }
  return { ok: true, text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8") }
}

/**
 * POST /internal/tool/precheck
 * body {
 *   session_id: string,
 *   tool: string,
 *   input?: object,
 *   cwd?: string,
 *   checks?: { plan?: boolean, permission?: boolean }
 * }
 * → {
 *   ok: true,
 *   plan: { status, body } | null,          // null = 本次未请求（只读工具）
 *   permission: { status, body } | null,
 *   hook: { ok, blocked, reason…, timed_out… } | null
 * }
 * 鉴权：/internal/* loopback 门 + 可选 HARNESS_INTERNAL_TOKEN（与 hooks/plan/permission 同闸门）。
 */
export async function handleToolPrecheck(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonError(405, "method not allowed", "bad_request", "method_not_allowed")
  }
  const declared = Number.parseInt(req.headers.get("content-length") || "", 10)
  if (Number.isFinite(declared) && declared > PRECHECK_BODY_MAX_BYTES) {
    return jsonError(413, `precheck body exceeds ${PRECHECK_BODY_MAX_BYTES} bytes`, "bad_request", "body_too_large")
  }
  const bodyRead = await readPrecheckBody(req, PRECHECK_BODY_MAX_BYTES)
  if (!bodyRead.ok) {
    if (!("tooLarge" in bodyRead) || !bodyRead.tooLarge) {
      return jsonError(400, "cannot read request body", "bad_request", "bad_request")
    }
    return jsonError(413, `precheck body exceeds ${PRECHECK_BODY_MAX_BYTES} bytes`, "bad_request", "body_too_large")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyRead.text)
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  if (!precheckIsRecord(parsed)) {
    return jsonError(400, "json body must be an object", "bad_request", "bad_request")
  }
  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id.trim() : ""
  const tool = typeof parsed.tool === "string" ? parsed.tool.trim() : ""
  if (!sessionId || !tool) {
    return jsonError(400, "session_id and tool are required", "bad_request", "bad_request")
  }
  const input = precheckIsRecord(parsed.input) ? parsed.input : {}
  const checks = precheckIsRecord(parsed.checks) ? parsed.checks : {}
  // 只读工具原本就不查 plan/permission（插件短路径），保持零评估。
  const wantPlan = checks.plan !== false
  const wantPermission = checks.permission !== false
  // cwd 必须由插件传入：hook 的语义是「以工具执行进程的 cwd 为准」，网关自身 cwd 不同。
  const payload: Record<string, unknown> = {
    tool_name: tool,
    tool_input: input,
    ...(typeof parsed.cwd === "string" && parsed.cwd ? { cwd: parsed.cwd } : {}),
    hook_event_name: "PreToolUse",
    session_id: sessionId,
  }

  const [plan, permission, hook] = await Promise.all([
    wantPlan
      ? precheckChild(
          () => handlePlan(jsonInternalRequest("/internal/plan/state", { session_id: sessionId }), "/internal/plan/state"),
          PRECHECK_STAGE_TIMEOUT_MS,
        )
      : null,
    wantPermission
      ? precheckChild(
          () =>
            handlePermission(
              jsonInternalRequest("/internal/permission/evaluate", { session_id: sessionId, tool, input }),
              "/internal/permission/evaluate",
            ),
          PRECHECK_STAGE_TIMEOUT_MS,
        )
      : null,
    precheckHook(payload, req.signal),
  ])

  // hook 回传与 /internal/hooks/run 同形状（含转义字段）；插件用同一消费函数。
  const hookBody = hook
    ? {
        ok: true,
        blocked: hook.blocked === true,
        ...(hook.reason !== undefined ? { reason: hook.reason, reason_escaped: escapeInjectedData(hook.reason) } : {}),
        ...(hook.additionalContext !== undefined
          ? {
              additional_context: hook.additionalContext,
              additional_context_escaped: escapeInjectedData(hook.additionalContext),
            }
          : {}),
        ...(hook.systemMessage !== undefined
          ? { system_message: hook.systemMessage, system_message_escaped: escapeInjectedData(hook.systemMessage) }
          : {}),
        ...(hook.timedOut === true ? { timed_out: true } : {}),
        supported: hook.supported,
        result_count: hook.results?.length ?? 0,
        errors: hook.errors ?? [],
      }
    : null

  return Response.json({ ok: true, plan, permission, hook: hookBody })
}
