// /internal/plan/* 内部端点（loopback-only 由 router 上游闸门负责）。
import { jsonError } from "./gw-lib"
import { PLAN_READ_ONLY_TOOLS, enterPlanMode, exitPlanMode, getPlanState } from "./plan-mode"

const PREFIX = "/internal/plan/"
const MAX_EXIT_WAIT_MS = 240_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function waitMsOf(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(Math.floor(n), MAX_EXIT_WAIT_MS)
}

export async function handlePlan(req: Request, pathname: string): Promise<Response> {
  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  if (!isRecord(parsed)) return jsonError(400, "json body must be an object", "bad_request", "bad_request")
  const body = parsed
  const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : ""
  if (!sessionId) return jsonError(400, "session_id is required", "bad_request", "bad_request")

  try {
    switch (pathname.slice(PREFIX.length)) {
      case "enter": {
        const result = await enterPlanMode(sessionId, {
          prePlanMode: typeof body.pre_plan_mode === "string" ? body.pre_plan_mode : undefined,
          plansDir: typeof body.plans_dir === "string" ? body.plans_dir : undefined,
        })
        return Response.json({ success: true, ...result })
      }
      case "exit": {
        const result = await exitPlanMode(sessionId, { waitMs: waitMsOf(body.wait_ms) })
        if ("error" in result) return Response.json({ success: false, ...result })
        return Response.json({ success: true, ...result })
      }
      case "state": {
        // H5/H6：inPlanMode 必须显式；只读清单由网关下发，插件不在本地维护第二份。
        return Response.json({
          success: true,
          ...getPlanState(sessionId),
          read_only_tools: [...PLAN_READ_ONLY_TOOLS],
        })
      }
      default:
        return jsonError(404, "unknown plan route", "not_found", "not_found")
    }
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : String(error), "server_error", "internal_error")
  }
}
