// 2026-10-02 影片／音樂成品自動出卡：網關兩個確定缺口的真行為驗收。
//   缺口 1：/internal/emit 的 video.done 早已通過 INTERNAL_EMIT_ALLOWED，卻因 if 鏈
//           無分支而靜默丟幀、仍回 {ok:true}（假成功）→ 用戶看不到卡。
//   缺口 2：工具結果翻譯層的媒體安全網只認頂層 url/video_url/audio_url 與字面
//           videos[]/audios[]，不識真實巢狀形狀（video_result_fetch 的
//           {jobs:[{video_url}]}、last_frame_video_chain 的 {shots:[{mp4_url}]}）。
// 全部為真行為斷言：驅動真實 handler、收集真實 SSE 幀並解析 payload；非源碼字串斷言。
// 跑法：cd deploy-staging/gateway && bun test video-audio-media-card-emit.test.ts
import { afterAll, expect, test } from "bun:test"
import { sessions, dirtySessions } from "./sessions-core.ts"
import { handleToolPartUpdate } from "./events-translate.ts"
import { handleInternalEmit } from "./media-internal-routes.ts"
import type { SessionState } from "./types-gateway.ts"

// ── harness（複製既有測試的建 state／收 SSE 幀寫法：見 template-guard.test.ts 的
//    sessions 註冊面＋workflow-gw-1002-fixes.test.ts 的 client.enqueue 收幀）──
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

const registered: string[] = []
function register(id: string, captured: string[]): SessionState {
  const s = makeState(id, captured)
  sessions.set(s.sessionId, s)
  registered.push(s.sessionId)
  return s
}

const tick = () => new Promise((r) => setTimeout(r, 0))
let seq = 0
async function driveCompleted(state: SessionState, tool: string, output: unknown): Promise<void> {
  handleToolPartUpdate(state, { tool, callID: `call-${++seq}`, state: { status: "completed", input: {}, output } })
  await tick()
}

afterAll(() => {
  for (const id of registered) {
    sessions.delete(id)
    dirtySessions.delete(id)
  }
})

// ── 缺口 2：巢狀成品形狀識別 ────────────────────────────────────────────────
test("video_result_fetch 形狀 {jobs:[{video_url,cost_coins}]} → 恰好 1 條 video.done（帶該項 cost_coins）", async () => {
  const captured: string[] = []
  const s = register("sess-g2-jobs", captured)
  await driveCompleted(s, "video_result_fetch", {
    ok: true,
    title: "取作業結果",
    jobs: [
      { task_id: "j1", status: "succeeded", video_url: "https://store.tinchak0207.xyz/x/a.mp4", cost_coins: 13 },
    ],
  })
  const v = frames(captured, "video.done")
  expect(v.length).toBe(1)
  expect(v[0]!.url).toBe("https://store.tinchak0207.xyz/x/a.mp4")
  expect(v[0]!.cost_coins).toBe(13)
  expect(frames(captured, "audio.done").length).toBe(0)
})

test("last_frame_video_chain 形狀 {shots:[{mp4_url}]} → 恰好 1 條 video.done", async () => {
  const captured: string[] = []
  const s = register("sess-g2-shots", captured)
  await driveCompleted(s, "last_frame_video_chain", {
    ok: true,
    title: "逐鏡鏈",
    shots: [{ index: 0, job_id: "s2", status: "succeeded", mp4_url: "https://store.tinchak0207.xyz/x/b.mp4" }],
  })
  const v = frames(captured, "video.done")
  expect(v.length).toBe(1)
  expect(v[0]!.url).toBe("https://store.tinchak0207.xyz/x/b.mp4")
})

test("未完成作業 {jobs:[{status:queued}]} → 0 條 media 幀（negative，防偽陽性）", async () => {
  const captured: string[] = []
  const s = register("sess-g2-queued", captured)
  await driveCompleted(s, "video_result_fetch", { ok: true, title: "取作業結果", jobs: [{ task_id: "j3", status: "queued" }] })
  expect(frames(captured, "video.done").length).toBe(0)
  expect(frames(captured, "audio.done").length).toBe(0)
})

test("回歸：audios:[{url:.m4a}] 仍恰好 1 條 audio.done（舊行為不可退化）", async () => {
  const captured: string[] = []
  const s = register("sess-g2-audios", captured)
  await driveCompleted(s, "music_gen", { ok: true, audios: [{ url: "https://store.tinchak0207.xyz/x/c.m4a" }] })
  const a = frames(captured, "audio.done")
  expect(a.length).toBe(1)
  expect(a[0]!.url).toBe("https://store.tinchak0207.xyz/x/c.m4a")
  expect(frames(captured, "video.done").length).toBe(0)
})

// ── 缺口 1：/internal/emit 的 video.done 不再靜默丟幀 ────────────────────────
test("handleInternalEmit(video.done) → 200 且 session SSE 恰收到該幀（治靜默丟幀）", async () => {
  const captured: string[] = []
  const s = register("sess-g1-video", captured)
  const req = new Request("http://test.local/internal/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: s.sessionId,
      event: "video.done",
      data: { url: "https://store.tinchak0207.xyz/x/d.mp4", cost_coins: 130, task_id: "j4", media_kind: "video" },
    }),
  })
  const res = await handleInternalEmit(req)
  expect(res.status).toBe(200)
  const v = frames(captured, "video.done")
  expect(v.length).toBe(1)
  expect(v[0]!.url).toBe("https://store.tinchak0207.xyz/x/d.mp4")
  expect(v[0]!.cost_coins).toBe(130)
  expect(v[0]!.task_id).toBe("j4")
  expect(v[0]!.media_kind).toBe("video")
})

// 契約修正（2026-10-02）：audio.done 此前不在 INTERNAL_EMIT_ALLOWED＝遺漏（opencode 工具鏈
// 已放行、網關這頭 400 丟棄＝no-op）。白名單補齊後契約改為「→ 200 且收到幀」。此為修正既存
// 遺漏，非放寬防線——防線仍在：下一條 video.bogus → 400 即是證明。
test("handleInternalEmit(audio.done) → 200 且 session SSE 恰收到該幀（契約修正）", async () => {
  const captured: string[] = []
  const s = register("sess-g1-audio", captured)
  const req = new Request("http://test.local/internal/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: s.sessionId,
      event: "audio.done",
      data: { url: "https://store.tinchak0207.xyz/x/e.m4a", cost_coins: 7, task_id: "j5", media_kind: "audio" },
    }),
  })
  const res = await handleInternalEmit(req)
  expect(res.status).toBe(200)
  const a = frames(captured, "audio.done")
  expect(a.length).toBe(1)
  expect(a[0]!.url).toBe("https://store.tinchak0207.xyz/x/e.m4a")
  expect(a[0]!.cost_coins).toBe(7)
  expect(a[0]!.task_id).toBe("j5")
  expect(a[0]!.media_kind).toBe("audio")
})

test("handleInternalEmit 白名單外事件 video.bogus → 400（防放寬：防線仍在）", async () => {
  const captured: string[] = []
  const s = register("sess-g1-bogus", captured)
  const req = new Request("http://test.local/internal/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: s.sessionId, event: "video.bogus", data: {} }),
  })
  const res = await handleInternalEmit(req)
  expect(res.status).toBe(400)
  expect(frames(captured, "video.bogus").length).toBe(0)
})
