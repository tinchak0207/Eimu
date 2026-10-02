// steer-turn-liveness.test.ts —— 2026-10-02「正常 steer 被誤判未生效」的真行為回歸。
//
// 病徵（使用者）：回合明明在跑，追加的引導卻彈「引導未能送達（未生效）＋当前没有
// 进行中的回合，已改为直接发送消息。」。
//
// 根因：steer 受理閘（steer-gw.turnInFlight）只認 state.lastTurnActiveAt，而舊版在
// session.idle 一到就把它清 0——但 idle 不等於回合結束：同一輪內 failover／jitter
// 兩台重試機會再送一次 prompt_async（且刻意不發 turn.done，前端維持進行中）。
// 打點先被清、重投腿又不補 ⇒ 整條重投輪的 steer 全被 409。
//
// 本檔的斷言刻意走**真輸入→真輸出**，不用源碼字串鎖：
//   真 handleOpencodeEvent(session.idle) → 真 state 變更 → 真 gateSteerAcceptance 裁決
//   ＋ 真 replayBuffer 幀（turn.done 有沒有發出去）。
//
// 跑法（需 bun：真 session DB = bun:sqlite，tsx/node 載不動，同 collaborate-gate.test.ts）：
//   timeout 120 bun run deploy-staging/gateway/steer-turn-liveness.test.ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionState } from "./types-gateway.ts"

const dir = mkdtempSync(join(tmpdir(), "steer-liveness-"))
process.env.SESSIONS_DB_PATH = join(dir, "sessions.db")
process.env.GATEWAY_DB_PATH = join(dir, "gw.db")
// 上游一律指向不可達埠：任何走真網路的殘餘路徑都立刻失敗，測試不對生產發任何請求。
process.env.OPENCODE_URL = "http://127.0.0.1:1"
// 重投延遲拉到 60s：本檔只驗「重投已排定」當下的閘門狀態，不讓真重投在測試期間發車
//（它會去 fetch 上游並改寫 state，屬另一條路徑的驗收範圍）。
process.env.TURN_RETRY_DELAY_MS = "60000"

const DECODER = new TextDecoder()

function frames(state: SessionState): string[] {
  const out: string[] = []
  for (const f of state.replayBuffer as { frame: Uint8Array }[]) {
    const head = DECODER.decode(f.frame.subarray(0, Math.min(f.frame.length, 80)))
    const ev = head.match(/^id: \d+\nevent: ([a-z.]+)\n/)?.[1]
    if (ev) out.push(ev)
  }
  return out
}

function makeState(id: string): SessionState {
  return {
    sessionId: id,
    apiKey: "sk-steer-liveness",
    opencodeSessionId: `oc_${id}`,
    clients: new Set(),
    pendingConfirms: new Map(),
    pendingQuestions: new Map(),
    resolvedConfirms: new Map(),
    eventCounter: 0,
    replayBuffer: [],
    lastActivityAt: Date.now(),
    turnTerminalNodes: [],
    partTextEmitted: new Map(),
    partStripState: new Map(),
    announcedUrls: new Set(),
    toolStatusSeen: new Set(),
    toolInvokeSeen: new Set(),
    stepCostLogged: new Set(),
    messageRole: new Map(),
    suppressedParts: new Set(),
    canvasUnitByCall: new Map(),
    canvasUnitByTask: new Map(),
    sessionTasks: new Map(),
    // 回合在跑：這是三條路徑（用戶發消息／重投／喚醒）打點的現場狀態。
    lastTurnActiveAt: Date.now(),
    turnGen: 1,
    turnTextChars: 0,
    turnToolStarted: false,
    turnRetries: 0,
    turnAborted: false,
    retryQueued: false,
    lastPromptBody: { parts: [{ type: "text", text: "做一支 MV" }] },
  } as unknown as SessionState
}

let pass = 0
const failures: string[] = []
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    failures.push(label + (detail ? ` — ${detail}` : ""))
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`)
  }
}

async function runChecks(): Promise<void> {
  const { sessions } = await import("./sessions-core.ts")
  const { handleOpencodeEvent } = await import("./opencode-event-handler.ts")
  const { gateSteerAcceptance } = await import("./steer-core.ts")

  // steer-gw.turnInFlight 的判據（唯一權威仍在 steer-gw，這裡照抄同一行以免誤導）。
  const inFlight = (s: SessionState): boolean => (s.lastTurnActiveAt ?? 0) > 0

  const idle = (ocId: string) =>
    handleOpencodeEvent({
      type: "session.idle",
      properties: { sessionID: ocId, info: { id: "m1", sessionID: ocId } },
    })

  // ── ① jitter 重投輪：零產出的 idle → 排定重投 → 閘門必須仍然開著 ──────────
  {
    const s = makeState("jit-1")
    sessions.set(s.sessionId, s)
    idle(s.opencodeSessionId)
    check("jitter 輪：重投已排定（retryQueued）", s.retryQueued === true, `retryQueued=${s.retryQueued}`)
    check("jitter 輪：未發 turn.done（前端維持進行中）", !frames(s).includes("turn.done"), frames(s).join(","))
    check("jitter 輪：in-flight 打點未被清", inFlight(s), `lastTurnActiveAt=${s.lastTurnActiveAt}`)
    check(
      "jitter 輪：steer 閘門回 accept（不是 no_active_turn）",
      gateSteerAcceptance({ turnInFlight: inFlight(s), turnAborted: s.turnAborted === true, turnAbortSource: s.turnAbortSource }).kind === "accept",
    )
  }

  // ── ② failover 重投輪（上游報錯後換模型續跑同一輪）：同上 ─────────────────
  {
    const s = makeState("fo-1")
    s.turnUpstreamError = "upstream 502 bad gateway"
    s.turnTextChars = 120
    s.turnToolStarted = true
    sessions.set(s.sessionId, s)
    idle(s.opencodeSessionId)
    check("failover 輪：重投已排定（retryQueued）", s.retryQueued === true, `retryQueued=${s.retryQueued}`)
    check("failover 輪：未發 turn.done", !frames(s).includes("turn.done"), frames(s).join(","))
    check("failover 輪：in-flight 打點未被清", inFlight(s), `lastTurnActiveAt=${s.lastTurnActiveAt}`)
    check(
      "failover 輪：steer 閘門回 accept",
      gateSteerAcceptance({ turnInFlight: inFlight(s), turnAborted: s.turnAborted === true, turnAbortSource: s.turnAbortSource }).kind === "accept",
    )
  }

  // ── ③ 真收尾：重試已用滿 → 發 turn.done 且清打點（回歸：修復不得讓回合永不收尾）──
  {
    const s = makeState("end-1")
    s.turnTextChars = 80
    s.turnToolStarted = true
    s.turnRetries = 99 // >= TURN_MAX_RETRIES：不再重投，走正常收尾
    sessions.set(s.sessionId, s)
    idle(s.opencodeSessionId)
    check("正常收尾：發了 turn.done", frames(s).includes("turn.done"), frames(s).join(","))
    check("正常收尾：in-flight 打點已清", !inFlight(s), `lastTurnActiveAt=${s.lastTurnActiveAt}`)
    check(
      "正常收尾後：steer 閘門回 no_active_turn（改走普通送出，不排隊等一張不會來的回合）",
      gateSteerAcceptance({ turnInFlight: inFlight(s), turnAborted: s.turnAborted === true, turnAbortSource: s.turnAbortSource }).kind === "reject",
    )
  }

  console.log(`\nsteer-turn-liveness: ${pass} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    for (const f of failures) console.log(`  FAIL ${f}`)
    process.exit(1)
  }
  process.exit(0)
}

// 非 bun 環境（tsx/node 載不動 bun:sqlite）：顯式 skip，不冒充通過也不製造假失敗。
if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  console.log("steer-turn-liveness: skip（需要 bun；本檔載真 session DB）")
  process.exit(0)
}

runChecks().catch((e) => {
  console.error("steer-turn-liveness crashed:", e)
  process.exit(2)
})
