// /internal/cron/* 内部端点（loopback-only 由 router 上游闸门负责）。
// 只做参数校验与调度层转接；真正的 fire 由 startCronTicker 注入的 sink 执行。
import { jsonError } from "./gw-lib"
import {
  createCron,
  currentCronFireSink,
  deleteCron,
  listCrons,
  parseCronExpression,
  tickCrons,
} from "./scheduled-crons"

const PREFIX = "/internal/cron/"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

// C9：state_dir 请求参数已删除——durable 文件根一律由 HARNESS_STATE 决定，
// 不允许调用方指到任意目录（锁/路径检查同理）。

export async function handleCron(req: Request, pathname: string): Promise<Response> {
  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  if (!isRecord(parsed)) return jsonError(400, "json body must be an object", "bad_request", "bad_request")
  const body = parsed
  const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : ""

  try {
    switch (pathname.slice(PREFIX.length)) {
      case "create": {
        if (!sessionId) return jsonError(400, "session_id is required", "bad_request", "bad_request")
        const cron = typeof body.cron === "string" ? body.cron.trim() : ""
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
        if (!cron) return jsonError(400, "cron is required", "bad_request", "bad_request")
        if (!prompt) return jsonError(400, "prompt is required", "bad_request", "bad_request")
        if (!parseCronExpression(cron)) {
          return jsonError(400, `invalid cron expression: ${cron}`, "bad_request", "invalid_cron")
        }
        const created = await createCron({
          sessionId,
          cron,
          prompt,
          recurring: asBoolean(body.recurring, true),
          durable: asBoolean(body.durable, false),
          permanent: asBoolean(body.permanent, false),
        })
        return Response.json({
          success: true,
          id: created.id,
          session_id: created.sessionId,
          cron: created.cron,
          prompt: created.prompt,
          recurring: created.recurring,
          durable: created.durable,
          permanent: created.permanent,
          created_at: created.createdAt,
          next_fire_at: created.nextFireAtMs,
        })
      }
      case "list": {
        if (!sessionId) return jsonError(400, "session_id is required", "bad_request", "bad_request")
        const tasks = listCrons(sessionId, { includeInactive: body.include_inactive === true }).map((row) => ({
          id: row.id,
          session_id: row.session_id,
          cron: row.cron,
          prompt: row.prompt,
          recurring: row.recurring === 1,
          durable: row.durable === 1,
          permanent: row.permanent === 1,
          last_fired_at: row.last_fired_at,
          next_fire_at: row.next_fire_at,
          created_at: row.created_at,
          status: row.status,
        }))
        return Response.json({ success: true, tasks })
      }
      case "delete": {
        if (!sessionId) return jsonError(400, "session_id is required", "bad_request", "bad_request")
        const id = typeof body.id === "number" && Number.isInteger(body.id) && body.id > 0 ? body.id : null
        if (id === null) return jsonError(400, "id must be a positive integer", "bad_request", "bad_request")
        const deleted = await deleteCron(sessionId, id)
        if (!deleted) {
          // C3：false 可能是「不存在」也可能是「durable 锁拿不到」；如实区分，不把锁冲突伪装成 404。
          const stillThere = listCrons(sessionId, { includeInactive: true }).some((row) => row.id === id)
          return stillThere
            ? jsonError(409, "cron delete could not acquire scheduled_tasks.json lock", "conflict", "lock_unavailable")
            : jsonError(404, "cron job not found", "not_found", "not_found")
        }
        return Response.json({ success: true, id })
      }
      case "tick": {
        const fire = currentCronFireSink()
        if (!fire) return jsonError(503, "cron ticker is not started", "backend_error", "ticker_not_started")
        const idle = body.is_idle !== false
        const fired = await tickCrons({
          fire,
          isIdle: () => idle,
        })
        return Response.json({ success: true, fired })
      }
      default:
        return jsonError(404, "unknown cron route", "not_found", "not_found")
    }
  } catch (error) {
    // M8/M9：错误码如实返回，策略/参数拒绝不再包成 200。
    const message = error instanceof Error ? error.message : String(error)
    if (/^expired:/i.test(message) || /invalid cron expression/i.test(message)) {
      return jsonError(400, message, "bad_request", /^expired:/i.test(message) ? "expired" : "invalid_cron")
    }
    if (/lock|scheduled_tasks\.json/i.test(message)) {
      return jsonError(409, message, "conflict", "lock_unavailable")
    }
    if (/corrupt/i.test(message)) {
      return jsonError(500, message, "server_error", "corrupt_durable_file")
    }
    return jsonError(500, message, "server_error", "internal_error")
  }
}
