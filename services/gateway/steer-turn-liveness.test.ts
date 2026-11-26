// steer-turn-liveness.test.ts —— 2026-10-02「正常 steer 被误判未生效」的真行为回归。
//
// 病征（使用者）：回合明明在跑，追加的引导却弹「引导未能送达（未生效）＋当前没有
// 进行中的回合，已改为直接发送消息。」。
//
// 根因：steer 受理闸（steer-gw.turnInFlight）只认 state.lastTurnActiveAt，而旧版在
// session.idle 一到就把它清 0——但 idle 不等于回合结束：同一轮内 failover／jitter
// 两台重试机会再送一次 prompt_async（且刻意不发 turn.done，前端维持进行中）。
// 打点先被清、重投腿又不补 ⇒ 整条重投轮的 steer 全被 409。
//
// 本档的断言刻意走**真输入→真输出**，不用源码字串锁：
//   真 handleOpencodeEvent(session.idle) → 真 state 变更 → 真 gateSteerAcceptance 裁决
//   ＋ 真 replayBuffer 帧（turn.done 有没有发出去）。
//
// 跑法（需 bun：真 session DB = bun:sqlite，tsx/node 载不动，同 collaborate-gate.test.ts）：
//   timeout 120 bun run deploy-staging/gateway/steer-turn-liveness.test.ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionState } from "./types-gateway.ts"

const dir = mkdtempSync(join(tmpdir(), "steer-liveness-"))
process.env.SESSIONS_DB_PATH = join(dir, "sessions.db")
process.env.GATEWAY_DB_PATH = join(dir, "gw.db")
// 上游一律指向不可达埠：任何走真网路的残余路径都立刻失败，测试不对生产发任何请求。
process.env.OPENCODE_URL = "http://127.0.0.1:1"
// 重投延迟拉到 60s：本档只验「重投已排定」当下的闸门状态，不让真重投在测试期间发车
//（它会去 fetch 上游并改写 state，属另一条路径的验收范围）。
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
    // 回合在跑：这是三条路径（用户发消息／重投／唤醒）打点的现场状态。
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

  // steer-gw.turnInFlight 的判据（唯一权威仍在 steer-gw，这里照抄同一行以免误导）。
  const inFlight = (s: SessionState): boolean => (s.lastTurnActiveAt ?? 0) > 0

  const idle = (ocId: string) =>
    handleOpencodeEvent({
      type: "session.idle",
      properties: { sessionID: ocId, info: { id: "m1", sessionID: ocId } },
    })

  // ── ① jitter 重投轮：零产出的 idle → 排定重投 → 闸门必须仍然开著 ──────────
  {
    const s = makeState("jit-1")
    sessions.set(s.sessionId, s)
    idle(s.opencodeSessionId)
    check("jitter 轮：重投已排定（retryQueued）", s.retryQueued === true, `retryQueued=${s.retryQueued}`)
    check("jitter 轮：未发 turn.done（前端维持进行中）", !frames(s).includes("turn.done"), frames(s).join(","))
    check("jitter 轮：in-flight 打点未被清", inFlight(s), `lastTurnActiveAt=${s.lastTurnActiveAt}`)
    check(
      "jitter 轮：steer 闸门回 accept（不是 no_active_turn）",
      gateSteerAcceptance({ turnInFlight: inFlight(s), turnAborted: s.turnAborted === true, turnAbortSource: s.turnAbortSource }).kind === "accept",
    )
  }

  // ── ② failover 重投轮（上游报错后换模型续跑同一轮）：同上 ─────────────────
  {
    const s = makeState("fo-1")
    s.turnUpstreamError = "upstream 502 bad gateway"
    s.turnTextChars = 120
    s.turnToolStarted = true
    sessions.set(s.sessionId, s)
    idle(s.opencodeSessionId)
    check("failover 轮：重投已排定（retryQueued）", s.retryQueued === true, `retryQueued=${s.retryQueued}`)
    check("failover 轮：未发 turn.done", !frames(s).includes("turn.done"), frames(s).join(","))
    check("failover 轮：in-flight 打点未被清", inFlight(s), `lastTurnActiveAt=${s.lastTurnActiveAt}`)
    check(
      "failover 轮：steer 闸门回 accept",
      gateSteerAcceptance({ turnInFlight: inFlight(s), turnAborted: s.turnAborted === true, turnAbortSource: s.turnAbortSource }).kind === "accept",
    )
  }

  // ── ③ 真收尾：重试已用满 → 发 turn.done 且清打点（回归：修复不得让回合永不收尾）──
  {
    const s = makeState("end-1")
    s.turnTextChars = 80
    s.turnToolStarted = true
    s.turnRetries = 99 // >= TURN_MAX_RETRIES：不再重投，走正常收尾
    sessions.set(s.sessionId, s)
    idle(s.opencodeSessionId)
    check("正常收尾：发了 turn.done", frames(s).includes("turn.done"), frames(s).join(","))
    check("正常收尾：in-flight 打点已清", !inFlight(s), `lastTurnActiveAt=${s.lastTurnActiveAt}`)
    check(
      "正常收尾后：steer 闸门回 no_active_turn（改走普通送出，不排队等一张不会来的回合）",
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

// 非 bun 环境（tsx/node 载不动 bun:sqlite）：显式 skip，不冒充通过也不制造假失败。
if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  console.log("steer-turn-liveness: skip（需要 bun；本档载真 session DB）")
  process.exit(0)
}

runChecks().catch((e) => {
  console.error("steer-turn-liveness crashed:", e)
  process.exit(2)
})
