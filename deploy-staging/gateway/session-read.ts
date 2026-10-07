// session-read.ts —— 自 index.ts 第二阶段 Wave3 无损抽取（2026-09-19）：会话读取与中止——
// handleTranscript/handleAbortSession＋前导注释（原 index.ts 5531–5600 行，逐行原样搬运）。
import { jsonError } from "./gw-lib.ts"
import { isSystemWakeText } from "./system-wake.ts"
import { getOwnedSession } from "./sessions-core.ts"
import { opencodeFetch, opencodeJson } from "./opencode-client.ts"
import { stripStaleTurnTextFromReplay } from "./sse-core.ts"
import { finishTurnMetrics } from "./metrics-gw.ts"
// 0920 停止闸：用户终止连子代理一起停（subagent.ts 不 import 本档，无循环）。
import { stopSubagentsForParent } from "./subagent"
// REQ-D2 停止优先：中止＝待投 steer 全数作废（steer-gw 不 import 本档，无循环）。
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
  } catch { /* 预设 200 */ }
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
  state.turnAborted = true // 用户主动中止：不触发抖动重试
  // D2-1b（2026-09-23）：标明中止来源＝用户。停止优先（丢弃待投 steer）只认这一种；
  // 内部空转断路器同样会设 turnAborted，但它不是用户叫停，不能丢用户的排队指引。
  state.turnAbortSource = "user"
  // REQ-D2 停止优先于 steer（2026-09-22）：用户叫停 = 待投的引导语一律作废并上报
  // aborted（UI 明示「已中止，未生效」）。顺序刻意在这里——abort 已落地、收尾帧
  // 之前，且 flushPendingSteers 看到 turnAborted 也会自己再挡一道（双保险）。
  dropPendingSteers(state, "aborted")
  // 0920 暴君裁定（停止闸）：用户终止＝连子代理一起停。此前 abort 只杀主会话
  // 在途 turn，子代理各自独立子会话照跑，跑完 wakeParent 又把父会话唤起来——
  // 用户视角「按了终止它又自己活了，刹不住车」。此处一并停掉本会话名下全部
  // 在跑子代理（不再唤醒、不再换模重投、不再交付闸门重派）。
  const stoppedCount = stopSubagentsForParent(state.sessionId, "user", "用户终止了本轮，子代理一并停止")
  if (stoppedCount > 0) {
    console.log(`[gateway] user abort: stopped ${stoppedCount} running subagent(s) session=${state.sessionId}`)
  }
  // Phase 0 观测：中止轮同样收档（t_done = 中止时刻，end=aborted），不留悬空档。
  finishTurnMetrics(state, "aborted")
  // N2 同款（2026-09-02）：用户中止即剥掉本轮文本帧——SSE 断线重连不再整段
  // 重放被中止轮的旧文案（stale delta 闪回根治）。
  stripStaleTurnTextFromReplay(state)
  return Response.json({ ok: true })
}
