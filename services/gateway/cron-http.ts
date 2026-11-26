// /internal/cron/* 内部端点（loopback-only 由 router 上游闸门负责）。
// 只做参数校验与调度层转接；真正的 fire 由 startCronTicker 注入的 sink 执行。
import { jsonError } from "./gw-lib"
import {
  createCron,
  currentCronTicker,
  deleteCron,
  getCronInitError,
  listCrons,
  parseCronExpression,
} from "./scheduled-crons"

const PREFIX = "/internal/cron/"

class BadField extends Error {
  readonly code = "bad_request"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** P3：类型严格——显式传了非布尔值回 400，不能把 "false"/"true" 静默当成缺省。 */
function readBoolean(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key]
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new BadField(`${key} must be a boolean`)
  return value
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
        // P2/P3：启动期 durable 文件损坏时 ticker 不会启动；创建任务只会永远不触发，
        // 如实拒绝并暴露 corrupt_durable_file，而不是静默收下。
        const initError = getCronInitError()
        if (initError) {
          return jsonError(
            500,
            `scheduled tasks state is unavailable: ${initError.message}`,
            "server_error",
            (initError as { code?: string }).code === "corrupt_durable_file" ? "corrupt_durable_file" : "internal_error",
          )
        }
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
          recurring: readBoolean(body, "recurring", true),
          durable: readBoolean(body, "durable", false),
          permanent: readBoolean(body, "permanent", false),
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
          next_fire_at: row.status === "active" ? row.next_fire_at : null,
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
        const ticker = currentCronTicker()
        if (!ticker) return jsonError(503, "cron ticker is not started", "backend_error", "ticker_not_started")
        const fired = await ticker.tick()
        return Response.json({ success: true, fired })
      }
      default:
        return jsonError(404, "unknown cron route", "not_found", "not_found")
    }
  } catch (error) {
    // M8/M9：错误码如实返回，策略/参数拒绝不再包成 200。
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof BadField) return jsonError(400, error.message, "bad_request", "bad_request")
    // P2：损坏的 durable 文件必须先于 lock / scheduled_tasks.json 的 409 分支匹配。
    if ((error as { code?: string })?.code === "corrupt_durable_file" || /corrupt/i.test(message)) {
      return jsonError(500, message, "server_error", "corrupt_durable_file")
    }
    if (/^never_fires/i.test(message)) {
      return jsonError(400, message, "bad_request", "never_fires")
    }
    if (/^expired:/i.test(message) || /invalid cron expression/i.test(message)) {
      return jsonError(400, message, "bad_request", /^expired:/i.test(message) ? "expired" : "invalid_cron")
    }
    if (/lock|scheduled_tasks\.json/i.test(message)) {
      return jsonError(409, message, "conflict", "lock_unavailable")
    }
    return jsonError(500, message, "server_error", "internal_error")
  }
}
