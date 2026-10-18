// Monitor 的网关内部端点。
//
// 路由（均只允许 POST，挂在既有 loopback-only /internal/ 闸之后）：
//   POST /internal/monitor/start   { session_id, description, timeout_ms?, command? | ws? }
//   POST /internal/monitor/stop    { session_id, monitor_id }
//   POST /internal/monitor/status  { session_id, monitor_id? }
//
// 约束：start 立即返回 monitor id，绝不阻塞；采集与推送由 session-monitors.ts 负责。
import {
  startMonitor,
  stopMonitor,
  listMonitors,
  MonitorPolicyError,
  MONITOR_DEFAULT_TIMEOUT_MS,
  MONITOR_MAX_TIMEOUT_MS,
} from "./session-monitors.ts"

function bad(message: string, code: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error: message, code, ...extra }, { status })
}

function pickSessionId(body: Record<string, unknown>): string {
  const raw = body.session_id ?? body.sessionId ?? body.session
  return typeof raw === "string" ? raw.trim() : ""
}

function pickMonitorId(body: Record<string, unknown>): number | undefined {
  const raw = body.monitor_id ?? body.monitorId ?? body.id
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw)
  return undefined
}

export async function handleMonitor(req: Request, pathname: string): Promise<Response> {
  if (req.method !== "POST") return bad("monitor endpoints are POST-only", "method_not_allowed", 405)
  if (pathname !== "/internal/monitor/start" && pathname !== "/internal/monitor/stop" && pathname !== "/internal/monitor/status") {
    return bad(`unknown monitor endpoint: ${pathname}`, "not_found", 404)
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== "object") return bad("request body must be a JSON object", "bad_request")
  const sessionId = pickSessionId(body)
  if (!sessionId) return bad("session_id is required", "bad_request")

  try {
    if (pathname === "/internal/monitor/start") {
      const description = typeof body.description === "string" ? body.description : ""
      if (!description.trim()) return bad("description is required", "bad_description")
      const command = typeof body.command === "string" ? body.command : undefined
      const ws = typeof body.ws === "string" ? body.ws : typeof body.ws_url === "string" ? (body.ws_url as string) : undefined
      // M7：显式传入的 timeout_ms 原样下传，非有限数由 normalizeMonitorTimeout 拒绝（400），
      // 不能用 typeof === "number" 把它静默吞成默认值。
      const rawTimeout = body.timeout_ms ?? body.timeoutMs
      const result = startMonitor(sessionId, {
        description,
        timeout_ms: rawTimeout === undefined ? undefined : (rawTimeout as number),
        command,
        ws,
      })
      return Response.json({
        ok: true,
        ...result,
        note: `监视已启动（默认超时 ${MONITOR_DEFAULT_TIMEOUT_MS / 60_000} 分钟，上限 ${MONITOR_MAX_TIMEOUT_MS / 60_000} 分钟）。事件会作为会话事件推送，不会打断当前回合。`,
      })
    }

    if (pathname === "/internal/monitor/stop") {
      const monitorId = pickMonitorId(body)
      if (monitorId === undefined) return bad("monitor_id is required", "bad_monitor_id")
      const result = stopMonitor(sessionId, monitorId)
      return Response.json({ ok: true, ...result })
    }

    const monitorId = pickMonitorId(body)
    const monitors = listMonitors(sessionId)
    if (monitorId !== undefined) {
      const one = monitors.find((m) => m.id === monitorId)
      if (!one) return bad(`monitor ${monitorId} not found for this session`, "not_found", 404)
      return Response.json({ ok: true, monitor: one })
    }
    return Response.json({ ok: true, monitors })
  } catch (e) {
    if (e instanceof MonitorPolicyError) {
      // 契约形状：{ ok:false, error:"command refused by monitor policy" }；具体命中规则放 detail。
      return bad("command refused by monitor policy", "command_refused", 400, { detail: e.message })
    }
    const message = (e as Error)?.message || String(e)
    // M8/M9：错误码如实返回，不把「找不到」或坏参数包成通用 200/500。
    if (/not found/i.test(message)) return bad(message, "not_found", 404)
    if (/timeout_ms must be a finite number/i.test(message)) return bad(message, "bad_timeout", 400)
    if (/exactly one of command or ws|is required|must be a valid|must use ws/i.test(message)) {
      return bad(message, "bad_request", 400)
    }
    return bad(message, "monitor_failed", 500)
  }
}
