/**
 * subagent-http.ts — 用户面「peek 子代理」HTTP 处理。
 *
 * 鉴权＝既有 Bearer 闸门（router 已解析 key）＋ getOwnedSession（防跨 key 越权）。
 * 数据源：live run 快照（subagent.ts 导出，HTTP 层不猜内部字段）∪ 转录目录里的终态 run。
 * runId 一律先过白名单再交给下层拼路径；未通过即 400，绝不做未校验字符串的路径拼接。
 */
import { jsonError } from "./gw-lib.ts"
import { getOwnedSession } from "./sessions-core.ts"
import { listLiveSubagentRuns, stopLiveSubagentRun } from "./subagent.ts"
import { RUN_ID_RE, getTranscriptParent, listTranscriptsForParent, readTranscriptDelta } from "./subagent-transcript.ts"

const LIST_MAX = 30

function transcriptAvailable(size: number): { available: boolean; bytes: number; truncated: boolean } {
  return { available: size > 0, bytes: size, truncated: false }
}

export function handleSubagentListPublic(key: string, sid: string): Response {
  if (!getOwnedSession(key, sid)) return jsonError(404, "session not found", "not_found", "not_found")
  const now = Date.now()
  const live = listLiveSubagentRuns(sid)
  const liveIds = new Set(live.map((row) => row.id))
  const terminal = listTranscriptsForParent(sid)
    .filter((row) => !liveIds.has(row.runId))
    .map((row) => {
      const ended = row.endStatus === "ok" || row.endStatus === "error" || row.endStatus === "stopped"
      const lastActivityAt = row.endAt ?? row.updatedAt
      return {
        id: row.runId,
        label: row.label,
        agent: row.agent ?? "",
        // 没有终态行的转录不得伪称成功：按 stopped 呈现并如实标注。
        status: ended ? (row.endStatus as "ok" | "error" | "stopped") : ("stopped" as const),
        started_at: row.startedAt,
        last_activity_at: lastActivityAt,
        elapsed_ms: Math.max(0, lastActivityAt - row.startedAt),
        silent_ms: Math.max(0, now - lastActivityAt),
        tool: null,
        pending_tools: 0,
        tools: [] as Array<{ call_id: string; tool: string; status: string; at: number; ended_at?: number }>,
        artifacts: [] as Array<{ kind: string; url: string }>,
        ...(ended
          ? row.summary
            ? { summary: row.summary }
            : {}
          : { summary: "转录缺终态记录" }),
        transcript: { ...transcriptAvailable(row.size), truncated: row.baseOffset > 0 },
      }
    })

  const merged = [...live, ...terminal]
  merged.sort((a, b) => {
    const rank = (status: string) => (status === "running" ? 0 : 1)
    return rank(a.status) - rank(b.status) || b.started_at - a.started_at
  })
  return Response.json({ object: "agent.subagent.list", subagents: merged.slice(0, LIST_MAX) })
}

export function handleSubagentTranscriptPublic(key: string, sid: string, runId: string, url: string): Response {
  if (!RUN_ID_RE.test(runId)) return jsonError(400, "invalid run_id", "bad_request", "bad_request")
  if (!getOwnedSession(key, sid)) return jsonError(404, "session not found", "not_found", "not_found")
  const live = listLiveSubagentRuns(sid).some((row) => row.id === runId)
  const owner = getTranscriptParent(runId)
  if (!live && owner !== sid) return jsonError(404, "subagent not found", "not_found", "not_found")

  const raw = new URL(url).searchParams.get("offset") ?? ""
  const offset = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0
  const delta = readTranscriptDelta(runId, Number.isFinite(offset) ? offset : 0)
  return Response.json({
    object: "agent.subagent.transcript",
    run_id: runId,
    entries: delta.entries,
    next_offset: delta.next_offset,
    truncated: delta.truncated,
    eof: delta.eof,
    size: delta.size,
    // 仅超长行被跳过时附带：前端可据此提示「有内容跳过」，不改变既有必需栏位。
    ...(delta.skipped ? { skipped: true } : {}),
  })
}

export function handleSubagentStopPublic(key: string, sid: string, runId: string): Response {
  if (!RUN_ID_RE.test(runId)) return jsonError(400, "invalid run_id", "bad_request", "bad_request")
  if (!getOwnedSession(key, sid)) return jsonError(404, "session not found", "not_found", "not_found")
  if (!stopLiveSubagentRun(sid, runId)) {
    return Response.json({ ok: false, code: "not_running", error: "该子代理已不在运行" }, { status: 409 })
  }
  return Response.json({ ok: true })
}
