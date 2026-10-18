// 结构化评审 Findings HTTP 路由（POST /internal/findings/report|list）。
// 约束：
// - 只做 loopback internal 路由（由 router.ts 的 /internal/ 闸门统一守门）。
// - report 整批原子：校验失败回 400 + 具体字段错误，一条都不落库。
// - session_id 与 goal 路由同款收敛到父 gateway 会话（子代理经 subagentParentState 回溯）。
import { jsonError } from "./gw-lib.ts"
import { resolveSession } from "./sessions-core.ts"
import { subagentParentState } from "./subagent.ts"
import {
  FindingsValidationError,
  latestFindingsRun,
  listFindings,
  reportFindings,
} from "./review-findings.ts"

function canonicalFindingsSessionId(sessionId: string): string {
  const state = resolveSession(sessionId) ?? subagentParentState(sessionId)
  return typeof state?.sessionId === "string" && state.sessionId ? state.sessionId : sessionId
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json()
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function handleFindings(req: Request, pathname: string): Promise<Response> {
  if (req.method !== "POST") return jsonError(405, "method not allowed", "bad_request", "method_not_allowed")
  const payload = await readJson(req)
  if (!payload) return jsonError(400, "invalid json body", "bad_request", "bad_request")
  const rawSessionId = typeof payload.session_id === "string" ? payload.session_id.trim() : ""
  if (!rawSessionId) return jsonError(400, "session_id is required", "bad_request", "bad_request")
  const sessionId = canonicalFindingsSessionId(rawSessionId)

  try {
    if (pathname === "/internal/findings/report") {
      const result = reportFindings(sessionId, {
        level: payload.level,
        findings: payload.findings,
        run_id: payload.run_id,
      })
      return Response.json(result)
    }

    if (pathname === "/internal/findings/list") {
      const limitRaw = payload.limit
      const limit = typeof limitRaw === "number" ? limitRaw : 100
      return Response.json({
        ok: true,
        findings: listFindings(sessionId, limit),
        latest_run: latestFindingsRun(sessionId) ?? null,
      })
    }

    return jsonError(404, "unknown findings route", "not_found", "not_found")
  } catch (e) {
    if (e instanceof FindingsValidationError) {
      return Response.json(
        {
          ok: false,
          error: { code: "findings_invalid", hint: e.message },
          errors: e.errors,
        },
        { status: 400 },
      )
    }
    return jsonError(500, e instanceof Error ? e.message : String(e), "server_error", "findings_error")
  }
}
