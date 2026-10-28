// exec-bridge 行为测试（S12）。全部用测试内自起的 fake 工具与 fake HTTP 服务器：不碰真实上游、不碰真实 key。
// 期望值来源：设计文档 §3.6 / S12 判准（403、同 idemKey 只调一次、超时后 result 可取回、并发 music=2 blender=1、
// 产物落 projects/<sid>/tmp/<idemKey>/、token 缺失拒启动），以及手写字节。
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { BRIDGE_CONCURRENCY, BRIDGE_TIMEOUT_MS, createExecBridge, startExecBridge, type ExecTool } from "./server"

const TOKEN = "unit-test-token-not-a-secret"
const WS = mkdtempSync(path.join(tmpdir(), "exec-bridge-test-"))
const AUDIO = Buffer.from("FAKE-MP3-BYTES-0123456789")
const MP4 = Buffer.from("FAKE-MP4-BYTES")
const PNG = Buffer.from("FAKE-PNG")
let files: ReturnType<typeof Bun.serve>
let base = ""

beforeAll(() => {
  files = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url)
      if (u.pathname === "/audio.mp3") return new Response(AUDIO, { headers: { "content-type": "audio/mpeg" } })
      if (u.pathname === "/big.bin") {
        // 40MB，分块流式输出，用来量桥是否整份进内存
        const chunk = new Uint8Array(1024 * 1024).fill(7)
        let sent = 0
        return new Response(new ReadableStream({ pull(c) { if (sent++ >= 40) return c.close(); c.enqueue(chunk) } }), { headers: { "content-type": "audio/mpeg" } })
      }
      if (u.pathname === "/artifact") {
        const p = u.searchParams.get("path") ?? ""
        if (p.endsWith(".mp4")) return new Response(MP4)
        if (p.endsWith(".png")) return new Response(PNG)
        return new Response("nope", { status: 404 })
      }
      return new Response("nf", { status: 404 })
    },
  })
  base = `http://127.0.0.1:${files.port}`
})
afterAll(() => { files.stop(true); rmSync(WS, { recursive: true, force: true }) })

type Call = { args: Record<string, unknown>; ctx: any }
const musicOk = (extra: Record<string, unknown> = {}) => ({ title: "音乐生成完成", output: JSON.stringify({ ok: true, url: `${base}/audio.mp3`, mime_type: "audio/mpeg", duration_seconds: 151.5, cost_coins: 1, channel: "flowmusic2api", ...extra }) })
let seq = 0
const key = (tag = "k") => `pg:p1:${"a".repeat(40)}:t1:a1:${tag}${++seq}`
const body = (idemKey: string, params: Record<string, unknown> = { prompt: "lofi" }) => ({ sessionId: "sess1", projectId: "p1", nodeId: "music_1", signature: "s".repeat(64), idemKey, params })
const post = (b: ReturnType<typeof createExecBridge>, route: string, payload: unknown, token = TOKEN) =>
  b.handle(new Request(`http://x/v1/exec/${route}`, { method: "POST", headers: { "x-internal-token": token, "content-type": "application/json" }, body: JSON.stringify(payload) }))
const getResult = async (b: ReturnType<typeof createExecBridge>, k: string) =>
  (await b.handle(new Request(`http://x/v1/exec/result/${encodeURIComponent(k)}`, { headers: { "x-internal-token": TOKEN } }))).json() as Promise<any>

function mkBridge(over: { music?: ExecTool["execute"]; render?: ExecTool["execute"]; exec?: ExecTool["execute"]; timeoutMs?: any; concurrency?: any; now?: () => number } = {}) {
  const calls: Call[] = []
  const music: ExecTool = { execute: over.music ?? (async (args, ctx) => { calls.push({ args, ctx }); return musicOk() }) }
  const render: ExecTool = { execute: over.render ?? (async () => ({ output: "{}" })) }
  const bridge = createExecBridge({
    token: TOKEN, workspaceDir: WS, tools: { music_gen: music, blender_render: render, ...(over.exec ? { blender_exec: { execute: over.exec } } : {}) },
    timeoutMs: over.timeoutMs, concurrency: over.concurrency, now: over.now, artifactHeaders: () => ({}),
  })
  return { bridge, calls }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("启动与鉴权", () => {
  test("HARNESS_INTERNAL_TOKEN 缺失或为空 → 拒绝启动（不降级为回环信任）", async () => {
    await expect(startExecBridge({ WORKSPACE_DIR: WS })).rejects.toThrow(/HARNESS_INTERNAL_TOKEN/)
    await expect(startExecBridge({ WORKSPACE_DIR: WS, HARNESS_INTERNAL_TOKEN: "" })).rejects.toThrow(/HARNESS_INTERNAL_TOKEN/)
    expect(() => createExecBridge({ token: "", workspaceDir: WS, tools: { music_gen: { execute: async () => ({ output: "" }) }, blender_render: { execute: async () => ({ output: "" }) } } })).toThrow()
  })
  test("错 token / 缺 token → 403，且不调用工具", async () => {
    const { bridge, calls } = mkBridge()
    expect((await post(bridge, "music_gen", body(key()), "wrong")).status).toBe(403)
    const noHeader = await bridge.handle(new Request("http://x/v1/exec/music_gen", { method: "POST", body: JSON.stringify(body(key())) }))
    expect(noHeader.status).toBe(403)
    expect((await bridge.handle(new Request("http://x/v1/exec/result/abc", { headers: { "x-internal-token": "wrong" } }))).status).toBe(403)
    expect(calls.length).toBe(0)
  })
  test("请求校验：缺字段 400；idemKey 含路径分隔符 400；未知路由 404", async () => {
    const { bridge, calls } = mkBridge()
    expect((await post(bridge, "music_gen", { sessionId: "s" })).status).toBe(400)
    expect((await post(bridge, "music_gen", body("../../etc/x"))).status).toBe(400)
    expect((await post(bridge, "music_gen", { ...body(key()), params: [] })).status).toBe(400)
    expect((await bridge.handle(new Request("http://x/v1/exec/other", { method: "POST", headers: { "x-internal-token": TOKEN } }))).status).toBe(404)
    expect(calls.length).toBe(0)
  })
})

describe("music_gen", () => {
  test("成功：产物落 projects/<sid>/tmp/<idemKey>/，只回路径；工具以 callID=idemKey 调用；chargeRef=music:<sid>:<idemKey>", async () => {
    const { bridge, calls } = mkBridge()
    const k = key()
    const res = await (await post(bridge, "music_gen", body(k, { prompt: "lofi", lyrics: "[Verse]\n啊" }))).json() as any
    expect(res.ok).toBe(true)
    expect(res.costCoins).toBe(1)
    expect(res.chargeRef).toBe(`music:sess1:${k}`)
    expect(res.provider).toBe("flowmusic2api")
    expect(res.files).toHaveLength(1)
    const f = res.files[0]
    expect(path.dirname(f.path)).toBe(path.join(WS, "projects", "sess1", "tmp", k))
    expect(f.mime).toBe("audio/mpeg")
    expect(f.bytes).toBe(AUDIO.length)
    expect(f.durationSec).toBe(151.5)
    expect(readFileSync(f.path).equals(AUDIO)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].ctx.callID).toBe(k)
    expect(calls[0].ctx.sessionID).toBe("sess1")
    expect(calls[0].args).toEqual({ prompt: "lofi", lyrics: "[Verse]\n啊" })
    expect(await getResult(bridge, k)).toMatchObject({ state: "done", costCoins: 1, files: [{ path: f.path }] })
  })
  test("同 idemKey 二次调用（顺序）→ 工具计数仍为 1，返回同一份结果", async () => {
    const { bridge, calls } = mkBridge()
    const k = key()
    const a = await (await post(bridge, "music_gen", body(k))).json() as any
    const b = await (await post(bridge, "music_gen", body(k))).json() as any
    expect(calls).toHaveLength(1)
    expect(b.files).toEqual(a.files)
    expect(b.costCoins).toBe(1)
  })
  test("同 idemKey 并发调用 → 工具计数为 1", async () => {
    let n = 0
    const { bridge } = mkBridge({ music: async () => { n++; await sleep(60); return musicOk() } })
    const k = key()
    const [a, b] = await Promise.all([post(bridge, "music_gen", body(k)), post(bridge, "music_gen", body(k))])
    expect(n).toBe(1)
    expect((await a.json() as any).files).toEqual((await b.json() as any).files)
  })
  test("多候选 audios[] 全部取回，去重；未知 URL 不扩散", async () => {
    const out = JSON.stringify({ ok: true, cost_coins: 1, mime_type: "audio/mpeg", audios: [
      { url: `${base}/audio.mp3`, duration_seconds: 10, candidate_index: 0 }, { url: `${base}/audio.mp3`, candidate_index: 0 }, { url: `${base}/audio.mp3?x=2`, duration_seconds: 11, candidate_index: 1 },
    ] })
    const { bridge } = mkBridge({ music: async () => ({ output: out }) })
    const r = await (await post(bridge, "music_gen", body(key()))).json() as any
    expect(r.files.map((f: any) => f.durationSec)).toEqual([10, 11])
  })
  test("工具失败回执两种形状 → 映射成契约错误码，且失败也缓存、不二次调用", async () => {
    const shapes: [string, string, boolean][] = [
      [JSON.stringify({ ok: false, error: { code: "invalid_args", hint: "缺少 prompt" } }), "bad_input", false],
      [JSON.stringify({ ok: false, code: "music_price_unknown", message: "缺少权威音乐目录单价，未生成" }), "price_unknown", false],
      [JSON.stringify({ ok: false, code: "music_spend_not_authorized", message: "未获批准" }), "cancelled", false],
      [JSON.stringify({ ok: false, error: { code: "yue2_busy", hint: "繁忙" } }), "provider_error", true],
    ]
    for (const [output, code, retryable] of shapes) {
      let n = 0
      const { bridge } = mkBridge({ music: async () => { n++; return { output } } })
      const k = key()
      const r = await (await post(bridge, "music_gen", body(k))).json() as any
      expect(r).toMatchObject({ ok: false, code, retryable })
      await post(bridge, "music_gen", body(k))
      expect(n).toBe(1)
      expect((await getResult(bridge, k)).state).toBe("failed")
    }
  })
  test("probe=true 不经桥", async () => {
    const { bridge, calls } = mkBridge()
    expect(await (await post(bridge, "music_gen", body(key(), { probe: true }))).json()).toMatchObject({ ok: false, code: "bad_input" })
    expect(calls).toHaveLength(0)
  })
  test("扣费未确认（cost_coins:null）→ 产物照回，costCoins=0 且不带 chargeRef，charge_error 如实透出", async () => {
    const { bridge } = mkBridge({ music: async () => musicOk({ cost_coins: null, charge_error: "扣费失败（HTTP 503）" }) })
    const r = await (await post(bridge, "music_gen", body(key()))).json() as any
    expect(r.ok).toBe(true)
    expect(r.chargeRef).toBeUndefined()
    expect(r.chargeError).toContain("503")
  })
})

describe("超时、排队与并发", () => {
  test("硬超时常量：music 240s、blender_render 1200s；并发 music=2 blender=1", () => {
    expect(BRIDGE_TIMEOUT_MS).toEqual({ music_gen: 240_000, blender_render: 1_200_000 })
    expect(BRIDGE_CONCURRENCY).toEqual({ music_gen: 2, blender_render: 1 })
  })
  test("执行超时：立即回 timeout(retryable=false)；之后 result 可取回 failed；工具迟到成功则升级为 done 并可取回产物", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { bridge } = mkBridge({ music: async () => { await gate; return musicOk() }, timeoutMs: { music_gen: 80 } })
    const k = key()
    const r = await (await post(bridge, "music_gen", body(k))).json() as any
    expect(r).toMatchObject({ ok: false, code: "timeout", retryable: false })
    expect((await getResult(bridge, k)).state).toBe("failed")
    // 同 key 再 POST 不得再调用工具（回缓存的超时失败）
    expect(await (await post(bridge, "music_gen", body(k))).json()).toMatchObject({ ok: false, code: "timeout" })
    release()
    await sleep(100)
    const late = await getResult(bridge, k)
    expect(late.state).toBe("done")
    expect(late.costCoins).toBe(1)
    expect(readFileSync(late.files[0].path).equals(AUDIO)).toBe(true)
  })
  test("排队中超时：工具从未启动 → retryable=true，且同 key 可重来（记录被撤销）", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let n = 0
    const { bridge } = mkBridge({ music: async () => { n++; await gate; return musicOk() }, concurrency: { music_gen: 1 }, timeoutMs: { music_gen: 150 } })
    const first = post(bridge, "music_gen", body(key("first")))
    await sleep(20)
    const k2 = key("second")
    const r2 = await (await post(bridge, "music_gen", body(k2))).json() as any
    expect(r2).toMatchObject({ ok: false, code: "timeout", retryable: true })
    expect(n).toBe(1)
    expect((await getResult(bridge, k2)).state).toBe("unknown")
    release()
    await first
  })
  test("信号量：同时在跑的 music 不超过 2，blender_render 不超过 1", async () => {
    let cur = 0, maxMusic = 0, curR = 0, maxRender = 0
    const { bridge } = mkBridge({
      music: async () => { cur++; maxMusic = Math.max(maxMusic, cur); await sleep(40); cur--; return musicOk() },
      render: async () => { curR++; maxRender = Math.max(maxRender, curR); await sleep(40); curR--; return { output: JSON.stringify({ ok: true, artifact_base_url: `${base}/artifact`, artifacts: [{ path: "a.png", bytes: 8, kind: "image" }] }) } },
    })
    await Promise.all([
      ...[1, 2, 3, 4].map((i) => post(bridge, "music_gen", body(key("m")))),
      ...[1, 2, 3].map((i) => post(bridge, "blender_render", body(key("r")))),
    ])
    expect(maxMusic).toBe(2)
    expect(maxRender).toBe(1)
  })
})

describe("blender_render", () => {
  const render = (artifacts: any[]) => async () => ({ output: JSON.stringify({ ok: true, artifact_base_url: `${base}/artifact`, artifacts }) })
  test("有 mp4 成片就只搬成片，不搬中间帧；mime 来自扩展名；costCoins=0", async () => {
    const { bridge } = mkBridge({ render: render([{ path: "turntable_frames/0001.png", bytes: 8, kind: "image" }, { path: "turntable.mp4", bytes: 14, kind: "video" }]) })
    const k = key("r")
    const r = await (await post(bridge, "blender_render", body(k, { turntable: true, engine: "eevee" }))).json() as any
    expect(r.ok).toBe(true)
    expect(r.costCoins).toBe(0)
    expect(r.files).toHaveLength(1)
    expect(r.files[0].mime).toBe("video/mp4")
    expect(r.files[0].bytes).toBe(MP4.length)
    expect(path.dirname(r.files[0].path)).toBe(path.join(WS, "projects", "sess1", "tmp", k))
  })
  test("无成片时搬全部帧；engine 映射为 render_engine；带 script 时先 exec 再 render，exec 失败则不渲染", async () => {
    const seen: any[] = []
    const execFail = JSON.stringify({ ok: false, error: { code: "invalid_args", hint: "脚本坏了" } })
    let renders = 0
    const { bridge } = mkBridge({
      exec: async (a) => { seen.push(["exec", a]); return { output: a.script === "bad" ? execFail : JSON.stringify({ ok: true }) } },
      render: async (a) => { renders++; seen.push(["render", a]); return render([{ path: "f/1.png", bytes: 8, kind: "image" }, { path: "f/2.png", bytes: 8, kind: "image" }])() },
    })
    const ok = await (await post(bridge, "blender_render", body(key("r"), { script: "import bpy", engine: "cycles", frames: "1-2" }))).json() as any
    expect(ok.files).toHaveLength(2)
    expect(seen[0]).toEqual(["exec", { script: "import bpy" }])
    expect(seen[1]).toEqual(["render", { frames: "1-2", render_engine: "cycles" }])
    const bad = await (await post(bridge, "blender_render", body(key("r"), { script: "bad" }))).json() as any
    expect(bad).toMatchObject({ ok: false, code: "bad_input" })
    expect(renders).toBe(1)
  })
  test("产物取回失败（桥 404）→ provider_error，不假装成功", async () => {
    const { bridge } = mkBridge({ render: render([{ path: "x.glb", bytes: 1, kind: "model" }]) })
    const r = await (await post(bridge, "blender_render", body(key("r")))).json() as any
    expect(r).toMatchObject({ ok: false, code: "provider_error" })
    expect(r.message).toContain("404")
  })
})

describe("result、崩溃遗留、保留期、内存", () => {
  test("未知 key → unknown；执行中 → running", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { bridge } = mkBridge({ music: async () => { await gate; return musicOk() } })
    expect((await getResult(bridge, "pg:nope:1")).state).toBe("unknown")
    const k = key()
    const p = post(bridge, "music_gen", body(k))
    await sleep(30)
    expect((await getResult(bridge, k)).state).toBe("running")
    release()
    await p
    expect((await getResult(bridge, k)).state).toBe("done")
  })
  test("桥重启前遗留的 running 记录：POST 不重投（工具 0 次调用）并报 submit_unknown；result=unknown", async () => {
    const k = key("crash")
    mkdirSync(path.join(WS, "exec-bridge", "results"), { recursive: true })
    writeFileSync(path.join(WS, "exec-bridge", "results", `${k}.json`), JSON.stringify({ idemKey: k, sessionId: "sess1", route: "music_gen", startedAt: Date.now(), state: "running" }))
    const { bridge, calls } = mkBridge()
    expect(await (await post(bridge, "music_gen", body(k))).json()).toMatchObject({ ok: false, code: "submit_unknown", retryable: false })
    expect(calls).toHaveLength(0)
    expect((await getResult(bridge, k)).state).toBe("unknown")
  })
  test("保留 24h：23h 仍可取回；25h 后 result=unknown，sweep 删除索引与产物目录", async () => {
    let t = 1_800_000_000_000
    const { bridge } = mkBridge({ now: () => t })
    const k = key("ret")
    const r = await (await post(bridge, "music_gen", body(k))).json() as any
    const dir = path.dirname(r.files[0].path)
    t += 23 * 3600_000
    expect((await getResult(bridge, k)).state).toBe("done")
    t += 2 * 3600_000
    expect((await getResult(bridge, k)).state).toBe("unknown")
    expect(existsSync(dir)).toBe(true)
    expect(await bridge.sweep()).toBeGreaterThanOrEqual(1)
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(path.join(WS, "exec-bridge", "results", `${k}.json`))).toBe(false)
  })
  test("内存：40MB 产物流式落盘，RSS 增量 < 50MB", async () => {
    const out = JSON.stringify({ ok: true, url: `${base}/big.bin`, mime_type: "audio/mpeg", cost_coins: 1 })
    const { bridge } = mkBridge({ music: async () => ({ output: out }) })
    Bun.gc(true)
    const before = process.memoryUsage().rss
    const r = await (await post(bridge, "music_gen", body(key("big")))).json() as any
    Bun.gc(true)
    const grown = process.memoryUsage().rss - before
    expect(r.files[0].bytes).toBe(40 * 1024 * 1024)
    expect(grown).toBeLessThan(50 * 1024 * 1024)
  })
})
