import { PLATFORM_BASE } from "./constants-gateway.ts"
import { getOwnedSession } from "./sessions-core.ts"
import { generationReceipt } from "./job-store.ts"

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
