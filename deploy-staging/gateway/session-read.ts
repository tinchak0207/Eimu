// session-read.ts —— 自 index.ts 第二階段 Wave3 無損抽取（2026-09-19）：會話讀取與中止——
// handleTranscript/handleAbortSession＋前導註釋（原 index.ts 5531–5600 行，逐行原樣搬運）。
import { jsonError } from "./gw-lib.ts"
import { isSystemWakeText } from "./system-wake.ts"
import { getOwnedSession } from "./sessions-core.ts"
import { opencodeFetch, opencodeJson } from "./opencode-client.ts"
import { stripStaleTurnTextFromReplay } from "./sse-core.ts"
import { finishTurnMetrics } from "./metrics-gw.ts"
// 0920 停止閘：用戶終止連子代理一起停（subagent.ts 不 import 本檔，無循環）。
import { stopSubagentsForParent } from "./subagent"
// REQ-D2 停止優先：中止＝待投 steer 全數作廢（steer-gw 不 import 本檔，無循環）。
import { dropPendingSteers } from "./steer-gw.ts"


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
    msgs = await opencodeJson<unknown>(`/session/${state.opencodeSessionId}/message`, {
      timeoutMs: 10000,
    })
  } catch {
    return jsonError(502, "upstream unavailable", "upstream_error", "upstream_error")
  }
  const out: Array<{ role: string; parts: Array<{ type: "text"; text: string } | { type: "tool"; tool: string; input: unknown }> }> = []
  if (Array.isArray(msgs)) {
    const tail = msgs.slice(-limit)
    for (const m of tail) {
      let role = m?.info?.role === "user" ? "user" : "assistant"
      if (role === "user" && Array.isArray(m?.parts) && m.parts.some((p: any) => p?.type === "text" && isSystemWakeText(p.text))) role = "system"
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
    const res = await opencodeFetch(`/session/${state.opencodeSessionId}/abort`, {
      method: "POST",
      timeoutMs: 5000,
    })
    if (!res.ok) {
      return jsonError(502, `opencode abort failed: ${res.status}`, "backend_error", "backend_error")
    }
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  state.turnAborted = true // 用戶主動中止：不觸發抖動重試
  // D2-1b（2026-09-23）：標明中止來源＝用戶。停止優先（丟棄待投 steer）只認這一種；
  // 內部空轉斷路器同樣會設 turnAborted，但它不是用戶叫停，不能丟用戶的排隊指引。
  state.turnAbortSource = "user"
  // REQ-D2 停止優先於 steer（2026-09-22）：用戶叫停 = 待投的引導語一律作廢並上報
  // aborted（UI 明示「已中止，未生效」）。順序刻意在這裡——abort 已落地、收尾幀
  // 之前，且 flushPendingSteers 看到 turnAborted 也會自己再擋一道（雙保險）。
  dropPendingSteers(state, "aborted")
  // 0920 暴君裁定（停止閘）：用戶終止＝連子代理一起停。此前 abort 只殺主會話
  // 在途 turn，子代理各自獨立子會話照跑，跑完 wakeParent 又把父會話喚起來——
  // 用戶視角「按了終止它又自己活了，刹不住車」。此處一併停掉本會話名下全部
  // 在跑子代理（不再喚醒、不再換模重投、不再交付閘門重派）。
  const stoppedCount = stopSubagentsForParent(state.sessionId, "user", "用户终止了本轮，子代理一并停止")
  if (stoppedCount > 0) {
    console.log(`[gateway] user abort: stopped ${stoppedCount} running subagent(s) session=${state.sessionId}`)
  }
  // Phase 0 觀測：中止輪同樣收檔（t_done = 中止時刻，end=aborted），不留懸空檔。
  finishTurnMetrics(state, "aborted")
  // N2 同款（2026-09-02）：用戶中止即剝掉本輪文本幀——SSE 斷線重連不再整段
  // 重放被中止輪的舊文案（stale delta 閃回根治）。
  stripStaleTurnTextFromReplay(state)
  return Response.json({ ok: true })
}
