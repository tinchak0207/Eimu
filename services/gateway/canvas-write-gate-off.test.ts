// canvas-write-gate-off.test.ts —— 2026-10-28 用户裁定删「画布写穿收盘闸」的回归。
//
// 独立依据：记忆 2026-10-28-eimu-context-rot-root-cause（闸门奖励形式：workflow_write 86%
// 发生在 nudge 之后、失败率 40%）。期望：多步影音意图的会话在 session.idle 且从未
// workflow_write 时，turn.done 正常放行，网关不向对话注入补写 nudge / 伪用户消息。
//
// 真 handleOpencodeEvent(session.idle) → 真 state / 真 replayBuffer 帧；不用源码字串锁。
//
// 跑法（需 bun，同 steer-turn-liveness.test.ts）：
//   timeout 120 bun run deploy-staging/gateway/canvas-write-gate-off.test.ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionState } from "./types-gateway.ts"

const dir = mkdtempSync(join(tmpdir(), "canvas-gate-off-"))
process.env.SESSIONS_DB_PATH = join(dir, "sessions.db")
process.env.GATEWAY_DB_PATH = join(dir, "gw.db")
// 上游一律指向不可达埠：任何走真网路的残余路径都立刻失败，测试不对生产发任何请求。
process.env.OPENCODE_URL = "http://127.0.0.1:1"
// 重投延迟拉到 60s：本档只验「重投已排定」当下的闸门状态，不让真重投在测试期间发车
//（它会去 fetch 上游并改写 state，属另一条路径的验收范围）。
process.env.TURN_RETRY_DELAY_MS = "60000"

const DECODER = new TextDecoder()

function allText(state: SessionState): string {
  return (state.replayBuffer as { frame: Uint8Array }[]).map((f) => DECODER.decode(f.frame)).join("")
}

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
    apiKey: "sk-canvas-gate-off",
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
    avProductionIntent: true,
    avProductionTemplateId: "feature_film",
    workflowWriteSucceeded: false,
    workflowWriteGateNudgeSent: false,
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

  // 多步影音意图（feature_film）＋本轮有正文有工具产出＋从未 workflow_write，session.idle。
  const s = makeState("cwg-off-1")
  s.turnTextChars = 200
  s.turnToolStarted = true
  sessions.set(s.sessionId, s)
  handleOpencodeEvent({
    type: "session.idle",
    properties: { sessionID: s.opencodeSessionId, info: { id: "m1", sessionID: s.opencodeSessionId } },
  })
  check("turn.done 正常放行", frames(s).includes("turn.done"), frames(s).join(","))
  check("未排定补写重投（retryQueued=false）", s.retryQueued !== true, `retryQueued=${s.retryQueued}`)
  check("未标记 nudge 已发", s.workflowWriteGateNudgeSent !== true)
  check("对话里没有「还差最后一步」伪提示", !allText(s).includes("还差最后一步"))
  check("in-flight 打点已清（回合真收尾）", !((s.lastTurnActiveAt ?? 0) > 0), `lastTurnActiveAt=${s.lastTurnActiveAt}`)

  console.log(`\ncanvas-write-gate-off: ${pass} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    for (const f of failures) console.log(`  FAIL ${f}`)
    process.exit(1)
  }
  process.exit(0)
}

if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  console.log("canvas-write-gate-off: skip（需要 bun；本档载真 session DB）")
  process.exit(0)
}

runChecks().catch((e) => {
  console.error("canvas-write-gate-off crashed:", e)
  process.exit(2)
})
