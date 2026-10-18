// ScheduleWakeup 的网关内部端点。
//
// 路由（均只允许 POST，挂在既有 loopback-only /internal/ 闸之后）：
//   POST /internal/wakeup/schedule  { session_id, delaySeconds, reason, prompt, noop?, stop? }
//   POST /internal/wakeup/stop      { session_id }
//   POST /internal/wakeup/list      { session_id }
//
// 约束：本档只做参数校验与错误转译；落库/调度全部走 session-wakeups.ts，
// 真正的唤醒投递由 index.ts 注入 startWakeupTicker({ wake })（复用既有 prompt_async 轮子）。
import { scheduleWakeup, stopWakeups, listWakeups, WAKEUP_MIN_DELAY_SECONDS, WAKEUP_MAX_DELAY_SECONDS } from "./session-wakeups.ts"

function bad(message: string, code: string, status = 400): Response {
  return Response.json({ ok: false, error: message, code }, { status })
}

function pickSessionId(body: Record<string, unknown>): string {
  const raw = body.session_id ?? body.sessionId ?? body.session
  return typeof raw === "string" ? raw.trim() : ""
}

export async function handleWakeup(req: Request, pathname: string): Promise<Response> {
  if (req.method !== "POST") return bad("wakeup endpoints are POST-only", "method_not_allowed", 405)
  if (
    pathname !== "/internal/wakeup/schedule" &&
    pathname !== "/internal/wakeup/stop" &&
    pathname !== "/internal/wakeup/list"
  ) {
    return bad(`unknown wakeup endpoint: ${pathname}`, "not_found", 404)
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== "object") return bad("request body must be a JSON object", "bad_request")
  const sessionId = pickSessionId(body)
  if (!sessionId) return bad("session_id is required", "bad_request")

  try {
    if (pathname === "/internal/wakeup/list") {
      return Response.json({ ok: true, wakeups: listWakeups(sessionId) })
    }
    if (pathname === "/internal/wakeup/stop" || body.stop === true) {
      const result = stopWakeups(sessionId)
      return Response.json({ ok: true, ...result })
    }

    const rawDelay = body.delaySeconds ?? body.delay_seconds
    if (typeof rawDelay !== "number" || !Number.isFinite(rawDelay)) {
      return bad(`delaySeconds must be a number in [${WAKEUP_MIN_DELAY_SECONDS},${WAKEUP_MAX_DELAY_SECONDS}]`, "bad_delay")
    }
    const prompt = typeof body.prompt === "string" ? body.prompt : ""
    if (!prompt.trim()) return bad("prompt is required and must be non-empty", "bad_prompt")
    const reason = typeof body.reason === "string" ? body.reason : undefined
    const noop = body.noop === true
    const result = scheduleWakeup(sessionId, { delaySeconds: rawDelay, reason, prompt, noop })
    return Response.json({ ok: true, ...result })
  } catch (e) {
    return bad((e as Error)?.message || String(e), "wakeup_failed")
  }
}
