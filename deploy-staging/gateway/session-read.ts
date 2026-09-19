// session-read.ts —— 自 index.ts 第二階段 Wave3 無損抽取（2026-09-19）：會話讀取與中止——
// handleTranscript/handleAbortSession＋前導註釋（原 index.ts 5531–5600 行，逐行原樣搬運）。
import { OPENCODE_URL } from "./constants-gateway.ts"
import { jsonError } from "./gw-lib.ts"
import { getOwnedSession } from "./sessions-core.ts"
import { opencodeHeaders } from "./opencode-client.ts"
import { stripStaleTurnTextFromReplay } from "./sse-core.ts"
import { finishTurnMetrics } from "./metrics-gw.ts"


// Force-stop the in-flight assistant turn on the opencode side. This is a real
// system-level cancel (not a soft "please stop" prompt): the running turn is
// terminated immediately, no further tools run, no more money is spent.


export async function handleTranscript(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let limit = 200
  try {
    const n = Number(new URL(req.url).searchParams.get("limit"))
    if (Number.isFinite(n) && n > 0) limit = Math.min(500, Math.floor(n))
  } catch { /* 預設 200 */ }
  let msgs: unknown = null
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/message`, {
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return jsonError(502, "upstream unavailable", "upstream_error", "upstream_error")
    msgs = await res.json()
  } catch {
    return jsonError(502, "upstream unavailable", "upstream_error", "upstream_error")
  }
  const out: Array<{ role: string; parts: Array<{ type: "text"; text: string } | { type: "tool"; tool: string; input: unknown }> }> = []
  if (Array.isArray(msgs)) {
    const tail = msgs.slice(-limit)
    for (const m of tail) {
      const role = m?.info?.role === "user" ? "user" : "assistant"
      const parts: Array<{ type: "text"; text: string } | { type: "tool"; tool: string; input: unknown }> = []
      if (Array.isArray(m?.parts)) {
        for (const p of m.parts) {
          if (p?.type === "text" && typeof p.text === "string") {
            parts.push({ type: "text", text: p.text })
          } else if (p?.type === "tool" && typeof p.tool === "string") {
            parts.push({ type: "tool", tool: p.tool, input: p.state?.input ?? null })
          }
        }
      }
      if (parts.length > 0) out.push({ role, parts })
    }
  }
  return Response.json({ messages: out })
}

export async function handleAbortSession(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/abort`, {
      method: "POST",
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      return jsonError(502, `opencode abort failed: ${res.status}`, "backend_error", "backend_error")
    }
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  state.turnAborted = true // 用戶主動中止：不觸發抖動重試
  // Phase 0 觀測：中止輪同樣收檔（t_done = 中止時刻，end=aborted），不留懸空檔。
  finishTurnMetrics(state, "aborted")
  // N2 同款（2026-09-02）：用戶中止即剝掉本輪文本幀——SSE 斷線重連不再整段
  // 重放被中止輪的舊文案（stale delta 閃回根治）。
  stripStaleTurnTextFromReplay(state)
  return Response.json({ ok: true })
}
