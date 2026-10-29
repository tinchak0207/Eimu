// exec-bridge 网关客户端测试（S12）。桥用真的 createExecBridge（fake 工具、fake 文件服务器），客户端走真实 HTTP。
// 期望值来源：设计文档 §3.6（超时 = 桥超时 + 15s；客户端超时 → submitUnknown 语义并可经 result 查询；错 token 403）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createExecBridge } from "../../opencode-runtime/exec-bridge/server"
import { createExecBridgeClient, defaultClientTimeoutMs, EXEC_BRIDGE_CLIENT_GRACE_MS } from "./exec-bridge-client"

const TOKEN = "client-test-token-not-a-secret"
const WS = mkdtempSync(path.join(tmpdir(), "exec-bridge-client-test-"))
let fileServer: ReturnType<typeof Bun.serve>
let bridgeServer: ReturnType<typeof Bun.serve>
let release: () => void = () => {}
let musicCalls = 0
let mode: "ok" | "hang" | "nocharge" = "ok"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const req = (idemKey: string) => ({ sessionId: "s1", projectId: "p1", nodeId: "music_1", signature: "z".repeat(64), idemKey, params: { prompt: "ambient" } })
const identity = { sessionId: "s1", projectId: "p1", nodeId: "music_1", signature: "z".repeat(64) }

beforeAll(() => {
  fileServer = Bun.serve({ port: 0, fetch: () => new Response("AUDIO", { headers: { "content-type": "audio/mpeg" } }) })
  const bridge = createExecBridge({
    token: TOKEN, workspaceDir: WS, timeoutMs: { music_gen: 5000 },
    tools: {
      music_gen: {
        execute: async () => {
          musicCalls++
          if (mode === "hang") await new Promise<void>((r) => (release = r))
          return { output: JSON.stringify({ ok: true, url: `http://127.0.0.1:${fileServer.port}/a.mp3`, mime_type: "audio/mpeg", cost_coins: mode === "nocharge" ? null : 1, ...(mode === "nocharge" ? { charge_error: "扣费失败（HTTP 503）" } : {}), channel: "yue2_modal", duration_seconds: 3 }) }
        },
      },
      blender_render: { execute: async () => ({ output: JSON.stringify({ ok: false, error: { code: "invalid_args", hint: "frames 格式错" } }) }) },
    },
  })
  bridgeServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => bridge.handle(r) })
})
afterAll(() => { fileServer.stop(true); bridgeServer.stop(true); rmSync(WS, { recursive: true, force: true }) })

const client = (over: { token?: string; baseUrl?: string } = {}) =>
  createExecBridgeClient({ baseUrl: over.baseUrl ?? `http://127.0.0.1:${bridgeServer.port}`, token: () => over.token ?? TOKEN })

describe("exec-bridge 客户端", () => {
  test("默认超时 = 桥超时 + 15 秒（music 255s / blender 1215s）", () => {
    expect(EXEC_BRIDGE_CLIENT_GRACE_MS).toBe(15_000)
    expect(defaultClientTimeoutMs("music_gen")).toBe(255_000)
    expect(defaultClientTimeoutMs("blender_render")).toBe(1_215_000)
  })
  test("成功：files/costCoins/chargeRef/provider 原样回给调用方，result 查得到 done", async () => {
    mode = "ok"
    const c = client()
    const r = await c.call("music_gen", req("pg:p1:ok1"), { timeoutMs: 4000, signal: new AbortController().signal })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.costCoins).toBe(1)
    expect(r.chargeRef).toBe("music:s1:pg:p1:ok1")
    expect(r.provider).toBe("yue2_modal")
    expect(r.files[0]).toMatchObject({ mime: "audio/mpeg", bytes: 5, durationSec: 3 })
    expect(r.files[0].path).toContain(path.join("projects", "s1", "tmp", "pg:p1:ok1"))
    expect(await c.result("pg:p1:ok1", identity)).toMatchObject({ state: "done", costCoins: 1, chargeRef: "music:s1:pg:p1:ok1" })
  })
  test("扣费未确认（cost_coins=null）→ 客户端结果带 chargeError，costCoins===0，无 chargeRef", async () => {
    mode = "nocharge"
    const r = await client().call("music_gen", req("pg:p1:nocharge1"), { timeoutMs: 4000, signal: new AbortController().signal })
    mode = "ok"
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.costCoins).toBe(0)
    expect(r.chargeRef).toBeUndefined()
    expect(r.chargeError).toContain("503")
    expect(r.files).toHaveLength(1)
  })
  test("工具失败 → 契约错误码与 retryable 原样映射", async () => {
    const r = await client().call("blender_render", { ...req("pg:p1:bad1"), nodeId: "r3d" }, { timeoutMs: 4000, signal: new AbortController().signal })
    expect(r).toMatchObject({ ok: false, code: "bad_input", retryable: false })
  })
  test("客户端超时 → submit_unknown（retryable=false），之后可经 result 查询到 running，桥完成后查到 done；期间工具只调用 1 次", async () => {
    mode = "hang"
    musicCalls = 0
    const c = client()
    const r = await c.call("music_gen", req("pg:p1:slow1"), { timeoutMs: 150, signal: new AbortController().signal })
    expect(r).toMatchObject({ ok: false, code: "submit_unknown", retryable: false })
    expect((await c.result("pg:p1:slow1", identity)).state).toBe("running")
    release()
    await sleep(150)
    const done = await c.result("pg:p1:slow1", identity)
    expect(done.state).toBe("done")
    expect(done.costCoins).toBe(1)
    expect(musicCalls).toBe(1)
    mode = "ok"
  })
  test("调用方 abort → 同样按 submit_unknown 处理（请求可能已送达）", async () => {
    mode = "hang"
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 80)
    const r = await client().call("music_gen", req("pg:p1:abort1"), { timeoutMs: 4000, signal: ac.signal })
    expect(r).toMatchObject({ ok: false, code: "submit_unknown" })
    release()
    await sleep(100)
    mode = "ok"
  })
  test("错 token → bridge_unavailable（不可重试）；无 token → 不发请求", async () => {
    expect(await client({ token: "wrong" }).call("music_gen", req("pg:p1:tok1"), { timeoutMs: 2000, signal: new AbortController().signal }))
      .toMatchObject({ ok: false, code: "bridge_unavailable", retryable: false })
    const calls = musicCalls
    expect(await client({ token: "" }).call("music_gen", req("pg:p1:tok2"), { timeoutMs: 2000, signal: new AbortController().signal }))
      .toMatchObject({ ok: false, code: "bridge_unavailable" })
    expect(musicCalls).toBe(calls)
  })
  test("连接被拒（桥没起）→ bridge_unavailable 且 retryable=true；result → unknown", async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response("x") })
    const url = `http://127.0.0.1:${dead.port}`
    dead.stop(true)
    const c = client({ baseUrl: url })
    expect(await c.call("music_gen", req("pg:p1:dead1"), { timeoutMs: 2000, signal: new AbortController().signal }))
      .toMatchObject({ ok: false, code: "bridge_unavailable", retryable: true })
    expect(await c.result("pg:p1:dead1")).toEqual({ state: "unknown" })
  })
  test("请求不合法（桥 400）→ bad_input", async () => {
    const r = await client().call("music_gen", { ...req("../evil"), idemKey: "../evil" }, { timeoutMs: 2000, signal: new AbortController().signal })
    expect(r).toMatchObject({ ok: false, code: "bad_input", retryable: false })
  })
})

test("真实HTTP ingested ACK须持久artifact副本，重复同身份可确认", async () => {
  mode = "ok"
  const c = client()
  const request = { ...req("pg:p1:ack1"), runId: "original_gateway_run" }
  const generated = await c.call("music_gen", request, { timeoutMs: 4000, signal: new AbortController().signal })
  expect(generated.ok).toBe(true)
  if (!generated.ok) return
  const { mkdirSync, copyFileSync } = await import("node:fs")
  const durable = path.join(WS, "projects", "s1", "artifacts", "durable.mp3")
  mkdirSync(path.dirname(durable), { recursive: true }); copyFileSync(generated.files[0].path, durable)
  const receipt = { ...identity, idemKey: request.idemKey, runId: request.runId, artifacts: [{ path: durable, sha256: generated.files[0].sha256! }] }
  expect(await c.ingested!({ ...receipt, runId: "wrong_run" })).toEqual({ ok: false })
  expect(await c.ingested!(receipt)).toEqual({ ok: true })
  expect(await c.ingested!(receipt)).toEqual({ ok: true })
})
