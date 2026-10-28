// S8a 音频执行器测试：voice / music + 旧 /tts 路由逐字节等价。
//
// 期望值来源（不镜像实现）：
// - 旧 /tts 响应形状与错误字符串：media-internal-routes.ts 改造前的 handleTts（设计文档 §4.2 S8a 判准“逐字节不变”）
// - 计价 0.001 币/字：pricing-and-validation.ts 的 MODEL_PRICING['tts-zh'] = { base_cost: 0, per_char: 0.001 }
// - 1 币/次音乐：记忆 2026-10-10-music-one-coin-billing + 设计文档 §3.5
// - durationSec：ffmpeg 生成的 1 秒 MP3 夹具，ffprobe 实测；执行器必须自己量出来
// - 幂等：同 idemKey 只让 fake 上游生成一次（桥的 musicChargeRef 语义，设计文档 §3.6）
// 全程不碰真实上游：TTS 用 127.0.0.1 假服务器，音乐用 fake ExecBridgeClient。
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { handleTts } from "../../media-internal-routes.ts"
import { synthesizeSpeech, type SpeechDeps } from "../speech"
import { createVoiceExecutor } from "./voice"
import { createMusicExecutor, musicBridgeParams } from "./music"
import { NODE_SPECS } from "../specs"
import { validateGraph } from "../validate"
import type { ExecBridgeClient, ExecContext, Json, NodeExecutor, Output, ProjectGraph } from "../types"

const WS = mkdtempSync(path.join(tmpdir(), "s8a-audio-test-"))
const AUDIO_DIR = path.join(WS, "tts-audio")
const PUBLIC_BASE = "https://cdn.example.test/agent/v1/audio"
const TTS_TEXT = "他终于回来了。"

let MP3: Buffer
let ttsServer: ReturnType<typeof Bun.serve>
let ttsCalls = 0
let ttsMode: "ok" | "empty" | "error" = "ok"
let ttsBodies: Array<Record<string, unknown>> = []

// 夹具与假上游在模块载入时建好：describe 里创建执行器时 speechDeps() 就要用到端口。
const fixture = path.join(WS, "fixture.mp3")
execFileSync("ffmpeg", [
  "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
  "-codec:a", "libmp3lame", "-b:a", "64k", "-y", fixture,
])
MP3 = readFileSync(fixture)
ttsServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    ttsCalls++
    ttsBodies.push((await req.json().catch(() => ({}))) as Record<string, unknown>)
    if (ttsMode === "error") return new Response("upstream boom", { status: 500 })
    if (ttsMode === "empty") return new Response(new Uint8Array(10), { headers: { "content-type": "audio/mpeg" } })
    return new Response(MP3, { headers: { "content-type": "audio/mpeg" } })
  },
})

afterAll(() => {
  ttsServer?.stop(true)
  rmSync(WS, { recursive: true, force: true })
})

beforeEach(() => {
  ttsCalls = 0
  ttsBodies = []
  ttsMode = "ok"
})

/** 假 TTS 上游 + 临时目录 + 确定性 URL（now/random 固定，两条路才可能逐字节相等）。 */
function speechDeps(over: Partial<SpeechDeps> = {}): SpeechDeps {
  return {
    upstream: {
      base: `http://127.0.0.1:${ttsServer.port}`,
      speechPath: "/openai/v1/audio/speech",
      model: "fake-tts",
      voice: "fake_voice",
    },
    audioDir: AUDIO_DIR,
    publicBase: PUBLIC_BASE,
    probe: async () => ({ available: true, note: "上游可用" }),
    resolveEntityTokens: async (text) => ({ prompt: text }),
    now: () => 1_700_000_000_000,
    random: () => 0.5,
    ...over,
  }
}

const ttsRequest = (body: unknown): Request =>
  new Request("http://gateway.local/agent/v1/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex")

describe("旧 /tts 路由逐字节不变（handleTts 薄包装）", () => {
  test("成功：状态码与 body 和 synthesizeSpeech 完全一致，上游请求体照旧", async () => {
    const deps = speechDeps()
    const res = await handleTts("biz-key", ttsRequest({ text: TTS_TEXT, voice: "zh_female_1" }), deps)
    const synth = await synthesizeSpeech({ text: TTS_TEXT, voice: "zh_female_1", apiKey: "biz-key" }, deps)
    expect(synth.ok).toBe(true)
    if (!synth.ok) return
    // 0.001 币/字（pricing-and-validation.ts MODEL_PRICING['tts-zh']），7 字 → 0.007
    const expectCost = Math.round(TTS_TEXT.length * 0.001 * 1000) / 1000
    expect(synth.costCoins).toBe(expectCost)
    const expected = JSON.stringify({ ok: true, url: synth.url, chars: TTS_TEXT.length, cost_coins: expectCost, format: "mp3" })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(expected)
    expect(synth.url).toStartWith(`${PUBLIC_BASE}/tts_`)
    expect(synth.url).toEndWith("_i.mp3")
    // 两次调用（旧路由一次、直调一次）打到同一假上游，请求体逐字段相同
    expect(ttsBodies.length).toBe(2)
    expect(ttsBodies[0]).toEqual({ model: "fake-tts", input: TTS_TEXT, voice: "zh_female_1", response_format: "mp3" })
    expect(ttsBodies[1]).toEqual(ttsBodies[0])
  })

  test("text>2000：旧路由与 synthesizeSpeech 同为 400 + 同一错误 body（trim 后计数）", async () => {
    const long = `  ${"字".repeat(2001)}  `
    const deps = speechDeps()
    const res = await handleTts("biz-key", ttsRequest({ text: long }), deps)
    const synth = await synthesizeSpeech({ text: long }, deps)
    expect(res.status).toBe(400)
    expect(await res.text()).toBe(JSON.stringify({
      error: { message: "text too long (max 2000 chars)", type: "bad_request", code: "bad_request" },
    }))
    expect(synth).toEqual({ ok: false, status: 400, code: "bad_request", message: "text too long (max 2000 chars)" })
    expect(ttsCalls).toBe(0)
  })

  test("空文本与非法 JSON：旧路由错误码/文案不变", async () => {
    const deps = speechDeps()
    const empty = await handleTts("biz-key", ttsRequest({ text: "   " }), deps)
    expect(empty.status).toBe(400)
    expect(await empty.text()).toBe(JSON.stringify({
      error: { message: "text is required", type: "bad_request", code: "bad_request" },
    }))
    const badJson = await handleTts("biz-key", ttsRequest("not json"), deps)
    expect(badJson.status).toBe(400)
    expect(await badJson.text()).toBe(JSON.stringify({
      error: { message: "invalid json body", type: "bad_request", code: "bad_request" },
    }))
    expect(ttsCalls).toBe(0)
  })

  test("探针不可用：503 tts_unavailable，消息与 synthesizeSpeech 一致且不打上游", async () => {
    const deps = speechDeps({ probe: async () => ({ available: false, note: "上游不可达: fake" }) })
    const res = await handleTts("biz-key", ttsRequest({ text: TTS_TEXT }), deps)
    const synth = await synthesizeSpeech({ text: TTS_TEXT }, deps)
    const expected = JSON.stringify({
      error: {
        message: "配音（TTS）上游暂不可用：上游不可达: fake。台词已收到，但当前无法真实生成音轨；请如实告知用户，勿编造音频链接。",
        type: "tts_unavailable",
        code: "tts_unavailable",
      },
    })
    expect(res.status).toBe(503)
    expect(await res.text()).toBe(expected)
    expect(synth.ok).toBe(false)
    if (!synth.ok) expect(synth.code).toBe("tts_unavailable")
    expect(ttsCalls).toBe(0)
  })

  test("上游 500 → 502 tts_upstream_error（消息截上游 body）", async () => {
    ttsMode = "error"
    const deps = speechDeps()
    const res = await handleTts("biz-key", ttsRequest({ text: TTS_TEXT }), deps)
    const synth = await synthesizeSpeech({ text: TTS_TEXT }, deps)
    expect(res.status).toBe(502)
    expect(await res.text()).toBe(JSON.stringify({
      error: { message: "TTS upstream error: upstream boom", type: "tts_upstream_error", code: "tts_upstream_error" },
    }))
    expect(synth.ok).toBe(false)
    if (!synth.ok) expect(synth.message).toBe("TTS upstream error: upstream boom")
  })

  test("上游 200 但载荷 <64 字节 → 502 tts_empty_audio", async () => {
    ttsMode = "empty"
    const deps = speechDeps()
    const res = await handleTts("biz-key", ttsRequest({ text: TTS_TEXT }), deps)
    expect(res.status).toBe(502)
    expect(await res.text()).toBe(JSON.stringify({
      error: { message: "TTS upstream returned empty audio", type: "tts_empty_audio", code: "tts_empty_audio" },
    }))
  })
})

// ---------------------------------------------------------------- fake ExecContext
function makeContext(over: {
  params: Record<string, Json>
  nodeType: "voice" | "music"
  execBridge?: ExecBridgeClient
  signal?: AbortSignal
}): { ctx: ExecContext; ledger: Array<Record<string, unknown>> } {
  const ledger: Array<Record<string, unknown>> = []
  const ctx = {
    project: { id: "p1", nodes: {} },
    node: { id: over.nodeType === "voice" ? "vo1" : "mu1", type: over.nodeType, params: over.params },
    signature: "a".repeat(64),
    runId: "run1",
    attempt: 0,
    take: 0,
    sessionId: "s1",
    session: { apiKey: "biz-key" },
    params: over.params,
    inputs: {},
    refs: [],
    signal: over.signal ?? new AbortController().signal,
    ingest: async (src: { path: string } | { url: string }, hint: { port: string; mime?: string; origin: Output["origin"] }): Promise<Output> => {
      const file = (src as { path: string }).path
      const bytes = readFileSync(file)
      const sha = sha256(bytes)
      return {
        port: hint.port,
        artifactId: `art_${sha.slice(0, 16)}`,
        sha256: sha,
        path: file, // 测试里不复制：ffprobe 要能读到真文件
        mime: hint.mime ?? "application/octet-stream",
        bytes: bytes.length,
        origin: hint.origin,
      }
    },
    ledger: { write: async (e: Record<string, unknown>) => { ledger.push(e) } },
    submitGeneration: async () => { throw new Error("audio executors must not call submitGeneration") },
    execBridge: over.execBridge ?? { call: async () => { throw new Error("no bridge in this test") }, result: async () => ({ state: "unknown" as const }) },
  } as unknown as ExecContext
  return { ctx, ledger }
}

describe("voice 执行器", () => {
  const voiceExecutor: NodeExecutor = createVoiceExecutor({ speech: speechDeps() })

  test("成功后经 ctx.ingest 入库：sha256 与 meta.durationSec 来自真实产物", async () => {
    const { ctx, ledger } = makeContext({ nodeType: "voice", params: { text: "你好世界", voice: "zh_female_1", speed: 1 } })
    const r = await voiceExecutor.run(ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(ttsCalls).toBe(1)
    const out = r.outputs[0]
    expect(out.sha256).toBe(sha256(MP3)) // 独立 oracle：对夹具字节直接 hash
    expect(out.artifactId).toBe(`art_${sha256(MP3).slice(0, 16)}`)
    expect(out.mime).toBe("audio/mpeg")
    expect(out.bytes).toBe(MP3.length)
    expect(out.origin).toBe("generated")
    expect(out.url).toBeUndefined() // 执行器不发布公网 URL，入库交给 ctx.ingest
    expect(typeof out.durationSec).toBe("number")
    expect(out.durationSec!).toBeGreaterThan(0.9)
    expect(out.durationSec!).toBeLessThan(1.2)
    expect(out.meta?.durationSec).toBe(out.durationSec)
    expect(r.costCoins).toBe(0.004) // 4 字 × 0.001 币/字
    expect(ledger.map((e) => e.event)).toEqual(["submitted", "completed"])
    expect(ledger[1].artifact_sha256).toBe(out.sha256)
    // speed=1 是缺省值，不下发（旧上游请求体保持三键 + 响应格式）
    expect(ttsBodies[0]).toEqual({ model: "fake-tts", input: "你好世界", voice: "zh_female_1", response_format: "mp3" })
  })

  test("speed≠1 显式下发（OpenAI speech 参数），voice 执行器使用 specs 真名", async () => {
    const { ctx } = makeContext({ nodeType: "voice", params: { text: "你好世界", voice: "zh_female_1", speed: 1.5 } })
    const r = await voiceExecutor.run(ctx)
    expect(r.ok).toBe(true)
    expect(ttsBodies[0]).toMatchObject({ input: "你好世界", voice: "zh_female_1", speed: 1.5 })
  })

  test("text>2000：与旧路由同一行为（bad_input + 原文案），不碰上游", async () => {
    const { ctx } = makeContext({ nodeType: "voice", params: { text: "字".repeat(2001) } })
    const r = await voiceExecutor.run(ctx)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe("bad_input")
    expect(r.message).toBe("text too long (max 2000 chars)")
    expect(r.retryable).toBe(false)
    expect(ttsCalls).toBe(0)
  })

  test("绑定预算后失败退回预留，成功则实扣；未绑定时不改原账本", async () => {
    const { bindSessionBudget, createProjectBudget } = await import("../ledger.ts")
    const budget = createProjectBudget({ capOf: async () => 1 })
    bindSessionBudget("s1", budget)
    try {
      const { ctx, ledger } = makeContext({ nodeType: "voice", params: { text: "你好世界", voice: "zh_female_1" } })
      const ok = await voiceExecutor.run(ctx)
      expect(ok.ok).toBe(true)
      expect(ledger.map((e) => e.event)).toEqual(["submitted", "completed"])
      expect(budget.snapshot("p1").reserved).toBe(0)
      expect(budget.snapshot("p1").spent).toBeCloseTo(0.004, 6)
      ttsMode = "error"
      const { ctx: badCtx, ledger: badLedger } = makeContext({ nodeType: "voice", params: { text: "你好世界", voice: "zh_female_1" } })
      const fail = await voiceExecutor.run(badCtx)
      expect(fail.ok).toBe(false)
      expect(badLedger.map((e) => e.event)).toEqual(["submitted", "refunded", "failed"])
      expect(budget.snapshot("p1").reserved).toBe(0)
    } finally {
      bindSessionBudget("s1", undefined)
    }
  })

  test("estimate 按字数报价；缺 text 报不出价", async () => {
    const node = (text?: string) => ({ id: "vo1", type: "voice", params: text === undefined ? {} : { text } }) as never
    expect(await voiceExecutor.estimate(node("你好世界"), null as never, null)).toBe(0.004)
    expect(await voiceExecutor.estimate(node(), null as never, null)).toBeNull()
  })
})

// ---------------------------------------------------------------- fake ExecBridgeClient
interface FakeBridge {
  client: ExecBridgeClient
  calls: Array<{ route: string; body: Record<string, unknown>; opts: { timeoutMs: number; signal: AbortSignal } }>
  cache: Map<string, unknown>
  upstreamCalls: number
}

function makeFakeBridge(): FakeBridge {
  const bridge: FakeBridge = {
    calls: [],
    cache: new Map(),
    upstreamCalls: 0,
    client: {
      async call(route, body, opts) {
        bridge.calls.push({ route, body: body as unknown as Record<string, unknown>, opts })
        const hit = bridge.cache.get(body.idemKey)
        if (hit) return hit as never // 桥语义：同 idemKey 直接回缓存，不再调上游
        bridge.upstreamCalls++
        const file = path.join(WS, `music-${bridge.upstreamCalls}.mp3`)
        writeFileSync(file, MP3)
        const res = {
          ok: true as const,
          files: [{ path: file, mime: "audio/mpeg", bytes: MP3.length, durationSec: 30 }],
          costCoins: 1,
          chargeRef: `music:${body.sessionId}:${body.idemKey}`,
          provider: "flowmusic",
        }
        bridge.cache.set(body.idemKey, res)
        return res
      },
      async result() { return { state: "unknown" as const } },
    },
  }
  return bridge
}

describe("music 执行器", () => {
  const OK_PARAMS: Record<string, Json> = {
    title: "配乐",
    prompt: "cinematic orchestral, 90 BPM, key of D minor, mood: heroic",
    lyrics: "[Verse]\n夜雨落在站台",
    seconds: 30,
    durationHint: "clip30",
    model: "flowmusic",
  }

  test("只经 execBridge（music_gen）：durationHint→duration_hint 显式映射，不直呼上游", async () => {
    const bridge = makeFakeBridge()
    const executor = createMusicExecutor()
    const { ctx, ledger } = makeContext({ nodeType: "music", params: OK_PARAMS, execBridge: bridge.client })
    const realFetch = globalThis.fetch
    globalThis.fetch = (() => { throw new Error("music executor must not fetch upstream directly") }) as never
    try {
      const r = await executor.run(ctx)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(bridge.calls.length).toBe(1)
      const [{ route, body, opts }] = bridge.calls
      expect(route).toBe("music_gen")
      expect(body.params).toEqual({
        prompt: OK_PARAMS.prompt,
        lyrics: OK_PARAMS.lyrics,
        duration_hint: "clip30", // 显式映射；durationHint 原键不得透传
      })
      expect((body.params as Record<string, unknown>).durationHint).toBeUndefined()
      expect((body.params as Record<string, unknown>).seconds).toBeUndefined() // 工具无 seconds 控制，不伪造
      expect(body.sessionId).toBe("s1")
      expect(body.projectId).toBe("p1")
      expect(body.nodeId).toBe("mu1")
      expect(body.signature).toBe("a".repeat(64))
      expect(body.idemKey).toBe(`pg:p1:${"a".repeat(40)}:t0:a0`) // types.ts:224 契约式
      expect(opts.timeoutMs).toBe(255_000) // 桥 music 240s + 15s grace（exec-bridge-client.ts）
      expect(opts.signal).toBe(ctx.signal)
      const out = r.outputs[0]
      expect(out.sha256).toBe(sha256(MP3))
      expect(out.url).toBeUndefined()
      expect(out.durationSec).toBe(30)
      expect(out.meta?.chargeRef).toBe(`music:s1:${body.idemKey}`)
      expect(r.costCoins).toBe(1)
      expect(ledger.map((e) => e.event)).toEqual(["submitted", "completed"])
      expect(ledger[1].charge_ref).toBe(`music:s1:${body.idemKey}`)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("同 idemKey 二次执行不二次生成/扣费（桥回缓存，fake 上游只跑一次）", async () => {
    const bridge = makeFakeBridge()
    const executor = createMusicExecutor()
    const first = makeContext({ nodeType: "music", params: OK_PARAMS, execBridge: bridge.client })
    const r1 = await executor.run(first.ctx)
    const r2 = await executor.run(first.ctx)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(bridge.calls.length).toBe(2)
    expect(bridge.upstreamCalls).toBe(1) // 客户端没有第二次调用上游
    expect(bridge.calls[0].body.idemKey).toBe(bridge.calls[1].body.idemKey)

    // 不同签名 → 不同 idemKey → 才允许新的一次生成
    const other = makeContext({ nodeType: "music", params: OK_PARAMS, execBridge: bridge.client })
    ;(other.ctx as unknown as { signature: string }).signature = "b".repeat(64)
    const r3 = await executor.run(other.ctx)
    expect(r3.ok).toBe(true)
    expect(bridge.upstreamCalls).toBe(2)
    expect(bridge.calls[2].body.idemKey).not.toBe(bridge.calls[0].body.idemKey)
  })

  test("J5 版权闸：拒绝 abc / sourceAudioSha / cover / 翻唱措辞 / ABC 谱值，且不调桥", async () => {
    const bridge = makeFakeBridge()
    const executor = createMusicExecutor()
    const cases: Record<string, Json>[] = [
      { ...OK_PARAMS, abc: "X:1\nT:Old Song\nK:C\nCDEF" },
      { ...OK_PARAMS, sourceAudioSha: "0".repeat(64) },
      { ...OK_PARAMS, cover: true },
      { ...OK_PARAMS, prompt: "写一首翻唱版的华语金曲" },
      { ...OK_PARAMS, lyrics: "X:1\nK:C\nCDEF GAB" },
    ]
    for (const params of cases) {
      const { ctx } = makeContext({ nodeType: "music", params, execBridge: bridge.client })
      const r = await executor.run(ctx)
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.code).toBe("bad_input")
      expect(r.retryable).toBe(false)
      expect(r.message).toContain("音乐版权参数闸")
    }
    expect(bridge.calls.length).toBe(0)
  })

  test("J5 版权闸合法放行：正常风格描述 + 原创歌词不误杀", async () => {
    const bridge = makeFakeBridge()
    const executor = createMusicExecutor()
    const { ctx } = makeContext({
      nodeType: "music",
      execBridge: bridge.client,
      params: { prompt: "synthwave, 110 BPM, key of A minor, mood: nostalgic", lyrics: "[Chorus]\n原创歌词一句" },
    })
    const r = await executor.run(ctx)
    expect(r.ok).toBe(true)
    expect(bridge.upstreamCalls).toBe(1)
  })

  test("桥失败原样透传（bad_input 不写失败账，provider_error 写）", async () => {
    const executor = createMusicExecutor()
    const bad = makeContext({
      nodeType: "music",
      params: OK_PARAMS,
      execBridge: { call: async () => ({ ok: false as const, code: "bad_input" as const, message: "duration_hint 非法", retryable: false }), result: async () => ({ state: "unknown" as const }) },
    })
    const rb = await executor.run(bad.ctx)
    expect(rb.ok).toBe(false)
    if (!rb.ok) expect(rb.code).toBe("bad_input")
    expect(bad.ledger.length).toBe(0)

    const down = makeContext({
      nodeType: "music",
      params: OK_PARAMS,
      execBridge: { call: async () => ({ ok: false as const, code: "bridge_unavailable" as const, message: "exec-bridge 连接被拒", retryable: true }), result: async () => ({ state: "unknown" as const }) },
    })
    const rd = await executor.run(down.ctx)
    expect(rd.ok).toBe(false)
    if (!rd.ok) expect(rd.retryable).toBe(true)
    expect(down.ledger.map((e) => e.event)).toEqual(["failed"])
  })

  test("绑定预算后：成功预留再实扣，失败退回且不再占着预留，超限不调桥", async () => {
    const { bindSessionBudget, createProjectBudget } = await import("../ledger.ts")
    const budget = createProjectBudget({ capOf: async () => 3 })
    bindSessionBudget("s1", budget)
    try {
      const bridge = makeFakeBridge()
      const executor = createMusicExecutor()
      const { ctx, ledger } = makeContext({ nodeType: "music", params: OK_PARAMS, execBridge: bridge.client })
      const ok = await executor.run(ctx)
      expect(ok.ok).toBe(true)
      expect(bridge.calls).toHaveLength(1)
      expect(ledger.map((e) => e.event)).toEqual(["submitted", "completed"])
      expect(budget.snapshot("p1")).toEqual({ reserved: 0, spent: 1 })

      const down = makeContext({
        nodeType: "music",
        params: OK_PARAMS,
        execBridge: { call: async () => ({ ok: false as const, code: "bridge_unavailable" as const, message: "down", retryable: true }), result: async () => ({ state: "unknown" as const }) },
      })
      const fail = await executor.run(down.ctx)
      expect(fail.ok).toBe(false)
      expect(down.ledger.map((e) => e.event)).toEqual(["submitted", "refunded", "failed"])
      expect(budget.snapshot("p1").reserved).toBe(0)
      expect(budget.snapshot("p1").spent).toBe(1)

      const tight = createProjectBudget({ capOf: async () => 0.5 })
      bindSessionBudget("s1", tight)
      const blockedBridge = makeFakeBridge()
      const blocked = makeContext({ nodeType: "music", params: OK_PARAMS, execBridge: blockedBridge.client })
      const denied = await executor.run(blocked.ctx)
      expect(denied.ok).toBe(false)
      if (denied.ok === false) expect(denied.code).toBe("bad_input")
      expect(blockedBridge.calls).toHaveLength(0)
      expect(tight.snapshot("p1").reserved).toBe(0)
    } finally {
      bindSessionBudget("s1", undefined)
    }
  })

  test("estimate = 1 币/次（设计文档 §3.5 / 2026-10-10 记忆）", async () => {
    const executor = createMusicExecutor()
    expect(await executor.estimate({ id: "mu1", type: "music", params: OK_PARAMS } as never, null as never, null)).toBe(1)
  })
})

describe("S8a 修订：music 参数表只留桥真正接受的控制", () => {
  test("NODE_SPECS.music 不含 seconds/model；durationHint 签名、rights 不签名", () => {
    const keys = Object.keys(NODE_SPECS.music.params)
    expect(keys).not.toContain("seconds")
    expect(keys).not.toContain("model")
    expect(NODE_SPECS.music.signedParams).toContain("durationHint")
    expect(NODE_SPECS.music.signedParams).not.toContain("rights")
    // durationHint→duration_hint 映射不变；秒数/模型没有可下发的上游参数
    expect(musicBridgeParams({ prompt: "p", durationHint: "clip30", seconds: 30, model: "flowmusic" }))
      .toEqual({ prompt: "p", duration_hint: "clip30" })
  })

  test("带 seconds 的 music 节点过 validateGraph 报错（不再为不存在的控制付费）", () => {
    const music = {
      id: "mu1", type: "music", intent: "", params: { prompt: "cinematic, 90 BPM", seconds: 30 },
      inputs: {}, refs: [], pinned: null, status: "pending", signature: null, lastRun: null, outputs: [], rev: 1,
    }
    const g = {
      schema: 1, id: "p", sessionId: "p", version: 1, createdAt: "t", updatedAt: "t",
      brief: [], decisions: [], targets: null, defaults: {}, nodes: { mu1: music }, order: ["mu1"],
      budget: { capCoins: null, spentCoins: 0, savedCoins: 0 }, activeRun: null, seq: 0,
    } as unknown as ProjectGraph
    const r = validateGraph(g)
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.path === "params.seconds")).toBe(true)
    expect(r.errors.some((e) => e.message.includes("seconds"))).toBe(true)
  })
})
