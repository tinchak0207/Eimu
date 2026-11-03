import { PLATFORM_BASE } from "./constants-gateway.ts"
import { getOwnedSession } from "./sessions-core.ts"
import { generationReceipt, generationReceipts } from "./job-store.ts"

const headers = { "Cache-Control": "private, no-store" }
function unavailable(status: number, code: string): Response {
  return Response.json({ ok: false, code, status: "unknown", cost_coins: null }, { status, headers })
}

/** Read-only delegation: owned session AND durable task binding AND the original tenant's lookup. */
export async function handleSessionGeneration(key: string, sessionId: string, taskId: string): Promise<Response> {
  const session = getOwnedSession(key, sessionId)
  if (!session) return unavailable(404, "task_not_found")
  const receipt = generationReceipt(taskId)
  if (!receipt || receipt.parent_gw !== session.sessionId || !["image", "video"].includes(receipt.kind)) {
    return unavailable(404, "task_not_found")
  }
  try {
    // Never trust receipt/model text for price or status. The existing platform tenant check
    // still decides access; no caller-provided key, URL or tenant enters this request.
    const upstream = await fetch(`${PLATFORM_BASE}/v1/images/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${session.apiKey}` },
      signal: AbortSignal.timeout(8_000),
      redirect: "error",
    })
    if (upstream.status === 404) return unavailable(404, "task_not_found")
    if (!upstream.ok) return unavailable(503, "task_lookup_unavailable")
    const task = await upstream.json()
    if (task?.task_id !== taskId || task?.id !== taskId || typeof task.status !== "string") {
      return unavailable(503, "task_lookup_unavailable")
    }
    return Response.json({
      ok: true,
      session_id: session.sessionId,
      task_id: taskId,
      object: task.object,
      status: task.status,
      created: task.created,
      model: task.model,
      requested_count: task.requested_count,
      completed_count: task.completed_count,
      cost_coins: typeof task.cost_coins === "number" && Number.isFinite(task.cost_coins) ? task.cost_coins : null,
      cost_source: typeof task.cost_coins === "number" && Number.isFinite(task.cost_coins) ? "platform_billing_ledger" : "unknown",
      data: task.data,
      result_ids: task.result_ids,
      primary_result_id: task.primary_result_id,
      cancellation_requested: task.cancellation_requested,
      // Keep users on this session-scoped receipt path; the ordinary key-scoped task URL
      // would reproduce the original 404 under the user's different API key.
      task_url: `/api/agent/biz/sessions/${encodeURIComponent(session.sessionId)}/generations/${encodeURIComponent(taskId)}`,
    }, { headers })
  } catch {
    return unavailable(503, "task_lookup_unavailable")
  }
}

const LISTED_GENERATION_KINDS = new Set(["image", "video", "audio"])
const MAX_LISTED_GENERATIONS = 200

/**
 * 只读：列出本会话（owned）成功落地的生成回执及其公开产物 URL。
 * 导演终稿回覆里可能只引用 workspace 路径（出站被净化成「（内部存档）」），
 * MCP 只靠回覆文本抽 URL 会丢产物；回执表才是产物真源。
 * 只投影 url/mime/宽高，不外露供应商、端点等内部字段。
 */
export function handleSessionGenerations(key: string, sessionId: string): Response {
  const session = getOwnedSession(key, sessionId)
  if (!session) return Response.json({ ok: false, code: "not_found" }, { status: 404, headers })
  const all = generationReceipts(session.sessionId)
    .filter((r) => LISTED_GENERATION_KINDS.has(r.kind) && r.status === "succeeded")
  const items = all.slice(-MAX_LISTED_GENERATIONS).map((r) => ({
    task_id: r.task_id,
    kind: r.kind,
    created_at: r.created_at,
    artifacts: (Array.isArray(r.artifacts) ? r.artifacts : [])
      .filter((a) => typeof a?.url === "string" && /^https?:\/\//.test(a.url))
      .map((a) => ({
        url: a.url,
        mime: typeof a.mimeType === "string" ? a.mimeType : null,
        width: typeof a.width === "number" && a.width > 0 ? a.width : null,
        height: typeof a.height === "number" && a.height > 0 ? a.height : null,
      })),
  })).filter((r) => r.artifacts.length > 0)
  return Response.json({
    ok: true,
    session_id: session.sessionId,
    total_succeeded: all.length,
    truncated: all.length > MAX_LISTED_GENERATIONS,
    generations: items,
  }, { headers })
}
