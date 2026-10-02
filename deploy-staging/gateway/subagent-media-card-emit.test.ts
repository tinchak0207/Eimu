// 2026-10-02 FIX-A／FIX-B：子代理媒體成品出卡 ＋ 子會話→父會話映射耐久化的真行為驗收。
//   FIX-A：野獸模式下音樂/影片只能在 Expert 子代理裡產生，而其 tool part 此前整類被丟棄
//          → 子代理做出的影片/音樂永遠不出卡。此處餵真 message.part.updated 事件，斷言
//          **父會話** 的 SSE 收到恰好 1 條 media 幀；running／無媒體 URL → 0 條。
//   FIX-B：byChildOc 收尾刪除後，poller 用子會話 id 晚到取件仍須解析到父會話；超過 TTL 則解析不到。
// harness 複製既有 subagent.test.ts（mock fetch 建子會話／prompt_async）＋
// video-audio-media-card-emit.test.ts（makeState 收父會話 SSE 幀），不自創框架。
// 跑法：cd deploy-staging/gateway && bun test subagent-media-card-emit.test.ts
import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test"
import {
  handleSubagentDispatch,
  handleSubagentEvent,
  initSubagent,
  findRunningRun,
  stopSubagentRun,
  subagentParentState,
  subagentHandlesSession,
} from "./subagent.ts"
import { collectToolOutputMediaUrls, parseToolOutput } from "./events-translate.ts"
import { sessions, dirtySessions } from "./sessions-core.ts"
import type { SessionState } from "./types-gateway.ts"

// ── mock fetch（複製 subagent.test.ts 骨架：建會話／prompt_async／abort／DELETE／message）──
// 未知 URL（含 jev LLM 呼叫）一律回空物件 → jev 側 fail-open，dispatch 不觸網。
const realFetch = globalThis.fetch
const createdChildren: string[] = []
let sessionSeq = 0

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } })
}

globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input)
  const method = (init?.method ?? "GET").toUpperCase()
  if (method === "POST" && /\/session$/.test(url)) {
    sessionSeq += 1
    const id = `ses_media_${sessionSeq}`
    createdChildren.push(id)
    return json({ id })
  }
  if (url.includes("/prompt_async")) return json({})
  if (url.includes("/abort")) return json({})
  if (method === "DELETE") return json({})
  if (url.includes("/message")) return json([])
  return json({})
}) as typeof fetch

// ── 父會話 state（複製 video-audio-media-card-emit.test.ts 的 makeState／frames）──────────
function makeState(id: string, captured: string[]): SessionState {
  const client = {
    controller: { enqueue: (f: Uint8Array) => captured.push(new TextDecoder().decode(f)) },
  }
  return {
    sessionId: id,
    apiKey: "sk-test",
    opencodeSessionId: `${id}-oc`,
    clients: new Set([client]),
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
    turnGen: 1,
  } as unknown as SessionState
}

// 從收集到的原始 SSE 幀字串（id:/event:/data:）取指定事件名的 payload。
function frames(captured: string[], name: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const f of captured) {
    const lines = f.split("\n")
    if (lines[1] !== `event: ${name}`) continue
    const dataLine = lines.find((l) => l.startsWith("data: "))
    if (dataLine) out.push(JSON.parse(dataLine.slice(6)) as Record<string, unknown>)
  }
  return out
}

const tick = () => new Promise((r) => setTimeout(r, 0))

// ── 父會話登錄（deps.resolveSession 由此解析；state 帶真的 clients → 收到媒體幀）──────────
type Parent = { sessionId: string; opencodeSessionId: string; turnGen: number; captured: string[]; state: SessionState }
const parents = new Map<string, Parent>()
// deps.emitToSession（subagent.delta/done）的捕獲槽——媒體幀不走這裡，走 sse-core。
const subagentFrames: Array<{ name: string; data: any }> = []
let parentSeq = 0

function makeParent(tag: string): Parent {
  const sid = `gw-media-${tag}-${(parentSeq++).toString(36)}`
  const captured: string[] = []
  const state = makeState(sid, captured)
  sessions.set(sid, state)
  const p: Parent = { sessionId: sid, opencodeSessionId: `ses_parent_${sid}`, turnGen: 1, captured, state }
  parents.set(sid, p)
  return p
}

beforeAll(() => {
  initSubagent({
    emitToSession: (_s: unknown, name: string, data: unknown) => {
      subagentFrames.push({ name, data })
    },
    resolveSession: (id: string) => parents.get(id)?.state,
    findSessionByOpenCodeId: (oc: string) => [...parents.values()].find((p) => p.opencodeSessionId === oc)?.state,
    openCodeUrl: "http://gw.test",
    openCodeHeaders: () => ({}),
    describeError: (e: unknown) => String(e),
    subagentModelChain: () => [{ providerID: "p", modelID: "m" }],
    beastMode: () => false,
    wakeParent: () => {},
  })
})

afterAll(() => {
  globalThis.fetch = realFetch
  for (const p of parents.values()) {
    sessions.delete(p.sessionId)
    dirtySessions.delete(p.sessionId)
  }
})

async function dispatchSub(p: Parent, label: string): Promise<string> {
  const before = createdChildren.length
  const res = await handleSubagentDispatch(
    new Request("http://gw.test/internal/subagent/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: p.sessionId, label, prompt: "【任務】产出交付物（预期 5 分钟）。", async: true }),
    }),
  )
  expect(res.status).toBe(200)
  const child = createdChildren[before]
  expect(typeof child).toBe("string")
  return child!
}

async function feedTool(childId: string, part: Record<string, unknown>): Promise<void> {
  await handleSubagentEvent({ type: "message.part.updated", properties: { part } }, childId)
  await tick()
}

// ── 1. 純函式：巢狀成品形狀識別 ───────────────────────────────────────────────
test("collectToolOutputMediaUrls：{jobs:[{video_url,cost_coins}]} → video 恰 1 且 cost 13", () => {
  const parsed = parseToolOutput(
    JSON.stringify({
      ok: true,
      jobs: [{ task_id: "j1", status: "succeeded", video_url: "https://store.tinchak0207.xyz/x/a.mp4", cost_coins: 13 }],
    }),
  )
  const r = collectToolOutputMediaUrls(parsed)
  expect(r.video.length).toBe(1)
  expect(r.video[0]!.url).toBe("https://store.tinchak0207.xyz/x/a.mp4")
  expect(r.video[0]!.cost_coins).toBe(13)
  expect(r.audio.length).toBe(0)
})

test("collectToolOutputMediaUrls：{shots:[{mp4_url}]} → video 恰 1", () => {
  const r = collectToolOutputMediaUrls({ ok: true, shots: [{ index: 0, mp4_url: "https://store.tinchak0207.xyz/x/b.mp4" }] })
  expect(r.video.length).toBe(1)
  expect(r.video[0]!.url).toBe("https://store.tinchak0207.xyz/x/b.mp4")
  expect(r.audio.length).toBe(0)
})

test("collectToolOutputMediaUrls：{audios:[{url:.m4a}]} → audio 恰 1", () => {
  const r = collectToolOutputMediaUrls({ ok: true, audios: [{ url: "https://store.tinchak0207.xyz/x/c.m4a" }] })
  expect(r.audio.length).toBe(1)
  expect(r.audio[0]!.url).toBe("https://store.tinchak0207.xyz/x/c.m4a")
  expect(r.video.length).toBe(0)
})

test("collectToolOutputMediaUrls：未完成 {jobs:[{status:queued}]} → 0（負向防偽陽性）", () => {
  const r = collectToolOutputMediaUrls({ ok: true, jobs: [{ task_id: "j3", status: "queued" }] })
  expect(r.video.length).toBe(0)
  expect(r.audio.length).toBe(0)
})

test("collectToolOutputMediaUrls：'not json' → parseToolOutput null → 0", () => {
  expect(parseToolOutput("not json")).toBeNull()
  const r = collectToolOutputMediaUrls(parseToolOutput("not json"))
  expect(r.video.length).toBe(0)
  expect(r.audio.length).toBe(0)
})

// ── 2. FIX-A：子代理 tool completed 的媒體成品 → 父會話出卡（恰 1 條）─────────
test("FIX-A：子代理 tool part completed 含影片 URL → 父會話恰 1 條 video.done（帶 cost）", async () => {
  const p = makeParent("fixa-video")
  const childId = await dispatchSub(p, "影片专家")
  await feedTool(childId, {
    type: "tool",
    id: "pt-v",
    callID: "c-v",
    tool: "video_result_fetch",
    state: {
      status: "completed",
      input: {},
      output: JSON.stringify({
        ok: true,
        jobs: [{ task_id: "j1", status: "succeeded", video_url: "https://store.tinchak0207.xyz/x/a.mp4", cost_coins: 13 }],
      }),
    },
  })
  const v = frames(p.captured, "video.done")
  expect(v.length).toBe(1)
  expect(v[0]!.url).toBe("https://store.tinchak0207.xyz/x/a.mp4")
  expect(v[0]!.cost_coins).toBe(13)
  expect(v[0]!.media_kind).toBe("video")
  expect(frames(p.captured, "audio.done").length).toBe(0)
})

test("FIX-A：子代理 tool part completed 含音頻 URL → 父會話恰 1 條 audio.done", async () => {
  const p = makeParent("fixa-audio")
  const childId = await dispatchSub(p, "音乐专家")
  await feedTool(childId, {
    type: "tool",
    id: "pt-a",
    callID: "c-a",
    tool: "music_gen",
    state: { status: "completed", input: {}, output: { ok: true, audios: [{ url: "https://store.tinchak0207.xyz/x/c.m4a" }] } },
  })
  const a = frames(p.captured, "audio.done")
  expect(a.length).toBe(1)
  expect(a[0]!.url).toBe("https://store.tinchak0207.xyz/x/c.m4a")
  expect(a[0]!.media_kind).toBe("audio")
  expect(frames(p.captured, "video.done").length).toBe(0)
})

test("FIX-A 去重：同一 part completed 重複 updated → 仍只恰 1 條 video.done", async () => {
  const p = makeParent("fixa-dedup")
  const childId = await dispatchSub(p, "去重专家")
  const part = {
    type: "tool",
    id: "pt-d",
    callID: "c-d",
    tool: "video_result_fetch",
    state: {
      status: "completed",
      input: {},
      output: JSON.stringify({ ok: true, jobs: [{ status: "succeeded", video_url: "https://store.tinchak0207.xyz/x/d.mp4" }] }),
    },
  }
  await feedTool(childId, part)
  await feedTool(childId, part)
  expect(frames(p.captured, "video.done").length).toBe(1)
})

// ── 3. FIX-A 負向：running／無媒體 URL → 0 條 ────────────────────────────────
test("FIX-A 負向：tool running → 父會話 0 條 media 幀", async () => {
  const p = makeParent("fixa-running")
  const childId = await dispatchSub(p, "在跑专家")
  await feedTool(childId, {
    type: "tool",
    id: "pt-r",
    callID: "c-r",
    tool: "video_result_fetch",
    state: {
      status: "running",
      input: {},
      output: JSON.stringify({ ok: true, jobs: [{ status: "succeeded", video_url: "https://store.tinchak0207.xyz/x/r.mp4" }] }),
    },
  })
  expect(frames(p.captured, "video.done").length).toBe(0)
  expect(frames(p.captured, "audio.done").length).toBe(0)
})

test("FIX-A 負向：completed 但無媒體 URL → 父會話 0 條 media 幀", async () => {
  const p = makeParent("fixa-nomedia")
  const childId = await dispatchSub(p, "無媒體专家")
  await feedTool(childId, {
    type: "tool",
    id: "pt-n",
    callID: "c-n",
    tool: "video_result_fetch",
    state: { status: "completed", input: {}, output: JSON.stringify({ ok: true, jobs: [{ status: "queued" }] }) },
  })
  expect(frames(p.captured, "video.done").length).toBe(0)
  expect(frames(p.captured, "audio.done").length).toBe(0)
})

// ── 4. 回歸：子代理的 tool part 仍不被轉發成 tool.invoke/tool.result，delta 仍被 suppress ──
test("回歸：tool part 仍不轉發（無 tool.invoke/tool.result），其 delta 仍被 suppress", async () => {
  const p = makeParent("reg-suppress")
  const childId = await dispatchSub(p, "回歸专家")
  await handleSubagentEvent({ type: "message.updated", properties: { info: { id: "m1", role: "assistant" } } }, childId)
  await feedTool(childId, {
    type: "tool",
    id: "pt-reg",
    callID: "c-reg",
    tool: "bash",
    messageID: "m1",
    state: { status: "running", input: { command: "ls" } },
  })
  // tool part 未上屏（既有 suppress 語義）
  expect(frames(p.captured, "tool.invoke").length).toBe(0)
  expect(frames(p.captured, "tool.result").length).toBe(0)
  expect(subagentFrames.some((f) => f.name === "tool.invoke" || f.name === "tool.result")).toBe(false)
  // 其 delta 也一併丟棄（delta 事件自身不帶類型，靠 suppressedParts 判定）
  const before = subagentFrames.length
  await handleSubagentEvent(
    { type: "message.part.delta", properties: { field: "text", messageID: "m1", partID: "pt-reg", delta: "不该上屏" } },
    childId,
  )
  await tick()
  expect(subagentFrames.slice(before).some((f) => f.name === "subagent.delta")).toBe(false)
})

// ── 5. FIX-B：子會話→父會話映射耐久性 ───────────────────────────────────────
test("FIX-B：run 收尾 unbind 後，subagentParentState(childId) 仍解析得到父 state", async () => {
  const p = makeParent("fixb-live")
  const childId = await dispatchSub(p, "耐久甲")
  const run = findRunningRun(p.sessionId, "耐久甲")
  expect(run).toBeTruthy()
  // 模擬 run 收尾（既有 unbind 路徑：removeFromRegistries → byChildOc.delete）
  stopSubagentRun(run!, "orchestrator", "測試收尾")
  // 先證 byChildOc 已 miss（subagentHandlesSession 直讀 byChildOc.has），排除「其實還綁著」的假通過
  expect(subagentHandlesSession(childId)).toBe(false)
  // 仍能經耐久回退表解析到父 state（poller 晚到取件不再 404）
  expect(subagentParentState(childId)).toBe(p.state)
})

test("FIX-B：映射超過 TTL（2h）後解析不到（lazy prune）", async () => {
  const p = makeParent("fixb-ttl")
  const childId = await dispatchSub(p, "耐久乙")
  const run = findRunningRun(p.sessionId, "耐久乙")
  expect(run).toBeTruthy()
  stopSubagentRun(run!, "orchestrator", "測試收尾")
  const realNow = Date.now()
  expect(subagentHandlesSession(childId)).toBe(false)
  expect(subagentParentState(childId)).toBe(p.state)
  setSystemTime(realNow + 2 * 60 * 60 * 1000 + 60_000)
  try {
    expect(subagentParentState(childId)).toBeUndefined()
  } finally {
    setSystemTime(realNow)
  }
})
