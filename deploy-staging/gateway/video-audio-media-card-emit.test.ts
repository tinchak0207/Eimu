// 2026-10-02 影片／音乐成品自动出卡：网关两个确定缺口的真行为验收。
//   缺口 1：/internal/emit 的 video.done 早已通过 INTERNAL_EMIT_ALLOWED，却因 if 链
//           无分支而静默丢帧、仍回 {ok:true}（假成功）→ 用户看不到卡。
//   缺口 2：工具结果翻译层的媒体安全网只认顶层 url/video_url/audio_url 与字面
//           videos[]/audios[]，不识真实巢状形状（video_result_fetch 的
//           {jobs:[{video_url}]}、last_frame_video_chain 的 {shots:[{mp4_url}]}）。
// 全部为真行为断言：驱动真实 handler、收集真实 SSE 帧并解析 payload；非源码字串断言。
// 跑法：cd deploy-staging/gateway && bun test video-audio-media-card-emit.test.ts
import { afterAll, expect, test } from "bun:test"
import { sessions, dirtySessions } from "./sessions-core.ts"
import { handleToolPartUpdate } from "./events-translate.ts"
import { handleInternalEmit } from "./media-internal-routes.ts"
import type { SessionState } from "./types-gateway.ts"

// ── harness（复制既有测试的建 state／收 SSE 帧写法：见 template-guard.test.ts 的
//    sessions 注册面＋workflow-gw-1002-fixes.test.ts 的 client.enqueue 收帧）──
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

// 从收集到的原始 SSE 帧字串（id:/event:/data:）取指定事件名的 payload。
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

// ── 缺口 2：巢状成品形状识别 ────────────────────────────────────────────────
test("video_result_fetch 形状 {jobs:[{video_url,cost_coins}]} → 恰好 1 条 video.done（带该项 cost_coins）", async () => {
  const captured: string[] = []
  const s = register("sess-g2-jobs", captured)
  await driveCompleted(s, "video_result_fetch", {
    ok: true,
    title: "取作业结果",
    jobs: [
      { task_id: "j1", status: "succeeded", video_url: "https://store.eimu.dev/x/a.mp4", cost_coins: 13 },
    ],
  })
  const v = frames(captured, "video.done")
  expect(v.length).toBe(1)
  expect(v[0]!.url).toBe("https://store.eimu.dev/x/a.mp4")
  expect(v[0]!.cost_coins).toBe(13)
  expect(frames(captured, "audio.done").length).toBe(0)
})

test("last_frame_video_chain 形状 {shots:[{mp4_url}]} → 恰好 1 条 video.done", async () => {
  const captured: string[] = []
  const s = register("sess-g2-shots", captured)
  await driveCompleted(s, "last_frame_video_chain", {
    ok: true,
    title: "逐镜链",
    shots: [{ index: 0, job_id: "s2", status: "succeeded", mp4_url: "https://store.eimu.dev/x/b.mp4" }],
  })
  const v = frames(captured, "video.done")
  expect(v.length).toBe(1)
  expect(v[0]!.url).toBe("https://store.eimu.dev/x/b.mp4")
})

test("未完成作业 {jobs:[{status:queued}]} → 0 条 media 帧（negative，防伪阳性）", async () => {
  const captured: string[] = []
  const s = register("sess-g2-queued", captured)
  await driveCompleted(s, "video_result_fetch", { ok: true, title: "取作业结果", jobs: [{ task_id: "j3", status: "queued" }] })
  expect(frames(captured, "video.done").length).toBe(0)
  expect(frames(captured, "audio.done").length).toBe(0)
})

test("回归：audios:[{url:.m4a}] 仍恰好 1 条 audio.done（旧行为不可退化）", async () => {
  const captured: string[] = []
  const s = register("sess-g2-audios", captured)
  await driveCompleted(s, "music_gen", { ok: true, audios: [{ url: "https://store.eimu.dev/x/c.m4a" }] })
  const a = frames(captured, "audio.done")
  expect(a.length).toBe(1)
  expect(a[0]!.url).toBe("https://store.eimu.dev/x/c.m4a")
  expect(frames(captured, "video.done").length).toBe(0)
})

// ── 缺口 1：/internal/emit 的 video.done 不再静默丢帧 ────────────────────────
test("handleInternalEmit(video.done) → 200 且 session SSE 恰收到该帧（治静默丢帧）", async () => {
  const captured: string[] = []
  const s = register("sess-g1-video", captured)
  const req = new Request("http://test.local/internal/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: s.sessionId,
      event: "video.done",
      data: { url: "https://store.eimu.dev/x/d.mp4", cost_coins: 130, task_id: "j4", media_kind: "video" },
    }),
  })
  const res = await handleInternalEmit(req)
  expect(res.status).toBe(200)
  const v = frames(captured, "video.done")
  expect(v.length).toBe(1)
  expect(v[0]!.url).toBe("https://store.eimu.dev/x/d.mp4")
  expect(v[0]!.cost_coins).toBe(130)
  expect(v[0]!.task_id).toBe("j4")
  expect(v[0]!.media_kind).toBe("video")
})

// 契约修正（2026-10-02）：audio.done 此前不在 INTERNAL_EMIT_ALLOWED＝遗漏（opencode 工具链
// 已放行、网关这头 400 丢弃＝no-op）。白名单补齐后契约改为「→ 200 且收到帧」。此为修正既存
// 遗漏，非放宽防线——防线仍在：下一条 video.bogus → 400 即是证明。
test("handleInternalEmit(audio.done) → 200 且 session SSE 恰收到该帧（契约修正）", async () => {
  const captured: string[] = []
  const s = register("sess-g1-audio", captured)
  const req = new Request("http://test.local/internal/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: s.sessionId,
      event: "audio.done",
      data: { url: "https://store.eimu.dev/x/e.m4a", cost_coins: 7, task_id: "j5", media_kind: "audio" },
    }),
  })
  const res = await handleInternalEmit(req)
  expect(res.status).toBe(200)
  const a = frames(captured, "audio.done")
  expect(a.length).toBe(1)
  expect(a[0]!.url).toBe("https://store.eimu.dev/x/e.m4a")
  expect(a[0]!.cost_coins).toBe(7)
  expect(a[0]!.task_id).toBe("j5")
  expect(a[0]!.media_kind).toBe("audio")
})

test("handleInternalEmit 白名单外事件 video.bogus → 400（防放宽：防线仍在）", async () => {
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
