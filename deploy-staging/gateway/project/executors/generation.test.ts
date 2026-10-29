// S7 执行器测试：reference / script / shotlist / keyframe / clip。
// 上游全部是本文件自起的 fake HTTP（/v1/models 价目 + /files/* 产物字节）；提交一律走注入的 fake SubmitGenerationFn，
// 断言执行器自身不做任何真实网络提交、不自行 fetch 平台。
// 期望值来源（手写常量，不读实现）：NODE_SPECS 的参数名、artifact 的 sha256 = 手算 crypto、目录价 × 数量。
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SANDBOX = mkdtempSync(join(tmpdir(), "s7-executors-"))
const WORKSPACE = join(SANDBOX, "workspace")
process.env.WORKSPACE_DIR = WORKSPACE
process.env.SESSIONS_DB_PATH = join(SANDBOX, "sessions.db") // 隔离网关会话库，测试不碰真实数据
const SESSION = "s1"

const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")
const MP4_BYTES = Buffer.from("000000186674797069736f6d0000020069736f6d", "hex")
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex")
const PNG_SHA = sha(PNG_BYTES)
const MP4_SHA = sha(MP4_BYTES)

// 目录价：img-fast standard 0.5 / hd 1 币/张；img-std-only 只有 standard 0.25；img-hd-only 只有 hd 2。
// vid-fast 按条 5 秒 1.5 币（720p，无音轨 1.5 / 带音轨 2）。
const CATALOG = {
  data: [
    { id: "img-fast", x_coins_per_image: { standard: 0.5, hd: 1 } },
    { id: "img-std-only", x_coins_per_image: { standard: 0.25 } },
    { id: "img-hd-only", x_coins_per_image: { hd: 2 } },
    {
      id: "vid-fast",
      x_coins_per_second: { "720p": 0.3 },
      x_capabilities: { defaultResolution: "720p", defaultAudio: false, audio: true },
      x_billing: {
        currency: "coins", unit: "per_video",
        prices: { "720p": { "5": 1.5, "10": 3 } },
        prices_with_audio: { "720p": { "5": 2, "10": 4 } },
      },
    },
  ],
}
let networkPosts = 0
let fileHits = 0
const base = () => `http://127.0.0.1:${server.port}`
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    if (req.method === "POST") { networkPosts++; return Response.json({}, { status: 500 }) } // 执行器不许自己 POST 平台
    if (url.pathname === "/v1/models") return Response.json(CATALOG)
    if (url.pathname.startsWith("/files/")) {
      fileHits++
      const video = url.pathname.endsWith(".mp4")
      return new Response(video ? MP4_BYTES : PNG_BYTES, { headers: { "content-type": video ? "video/mp4" : "image/png" } })
    }
    return Response.json({}, { status: 404 })
  },
})
process.env.PLATFORM_BASE = base()

// 价目目录是 pricing-gateway 的模块级共享状态，且 constants-gateway 的 PLATFORM_BASE 在首次 import 时冻结。
// 全量跑时 submit-generation.test.ts 先执行（它把 PLATFORM_BASE 指向自己的 fake 服务器并暖过同名缓存），
// 我们这份价目表就永远拿不到。隔离方式：本文件自己接管 /v1/models 的 fetch（不论冻结的是哪个 host），
// 并在每个用例前清空目录缓存 —— 前置状态由本文件保证，不是放宽断言。
const realFetch = globalThis.fetch
let modelFetches = 0
globalThis.fetch = (async (input: any, init?: any) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input?.url
  try {
    if (typeof raw === "string" && new URL(raw).pathname === "/v1/models") {
      modelFetches++
      return Response.json(CATALOG)
    }
  } catch { /* 非法 URL 交给真实 fetch 报错 */ }
  return realFetch(input, init)
}) as typeof fetch

const { ArtifactStore } = await import("../artifacts.ts")
const jobStore = await import("../../job-store.ts")
const pricing = await import("../../pricing-gateway.ts")
jobStore.reopenSessionsDbForTest()
pricing.resetCatalogCacheForTest()
const { referenceExecutor } = await import("./reference.ts")
const { scriptExecutor, shotlistExecutor } = await import("./authored.ts")
const { keyframeExecutor } = await import("./keyframe.ts")
const { clipExecutor, setClipSubjectCheckForTest } = await import("./clip.ts")

beforeEach(() => { pricing.invalidateWorkflowPriceCatalog() })
afterAll(() => {
  globalThis.fetch = realFetch
  server.stop(true)
})

// ---------------------------------------------------------------- fixtures
const stores = new Map<string, InstanceType<typeof ArtifactStore>>()
function storeFor(sessionId: string) {
  let s = stores.get(sessionId)
  if (!s) {
    s = new ArtifactStore({ projectDir: join(WORKSPACE, "projects", sessionId), allowPrivateNetwork: true })
    stores.set(sessionId, s)
  }
  return s
}
const artifactsDir = (sessionId = SESSION) => join(WORKSPACE, "projects", sessionId, "artifacts")

function out(artifactId: string, s: string, extra: any = {}) {
  return { port: "out", artifactId, sha256: s, path: join(artifactsDir(), `${artifactId}.bin`), mime: "image/png", bytes: 8, origin: "generated", ...extra }
}

function node(id: string, type: string, params: any = {}, extra: any = {}) {
  return {
    id, type, intent: "", params, inputs: {}, refs: [], forEach: undefined, takes: undefined, onFail: undefined,
    locked: undefined, pinned: null, status: "pending", signature: null, lastRun: null, outputs: [], rev: 0, ...extra,
  }
}

function graphOf(nodes: any[], defaults: any = {}) {
  return {
    schema: 1, id: "p1", sessionId: SESSION, version: 1, createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z",
    brief: [{messageId:"real-user-fixture",at:"2026-10-28T00:00:00.000Z",text:"请制作这些镜头，保留镜头动作与声音参数。"}], entry:{via:"session_api",messageId:"real-user-fixture"}, decisions: [], targets: null, defaults, nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), order: nodes.map((n) => n.id),
    budget: { capCoins: null, spentCoins: 0, savedCoins: 0 }, activeRun: null, seq: 0,
  }
}

type Submit = (req: any) => any
function ctxOf(node: any, graph: any, respond: Submit, inputs: Record<string, any[]> = {}, refs: any[] = []) {
  const store = storeFor(SESSION)
  const ingestCalls: any[] = []
  const submitCalls: any[] = []
  const ingest = async (src: any, hint: any) => { ingestCalls.push({ src, hint }); return store.ingest(src, hint) }
  const submitGeneration = async (req: any) => { submitCalls.push(req); return respond(req) }
  const ctx = {
    project: graph, node, signature: "sig-1", runId: "run-1", attempt: 0, take: 0, sessionId: SESSION,
    session: { sessionId: SESSION, opencodeSessionId: "ses_test", apiKey: "sk-test" },
    params: node.params, inputs, refs,
    signal: new AbortController().signal,
    ingest,
    ledger: { write: async () => undefined },
    submitGeneration,
    execBridge: { call: async () => { throw new Error("bridge not used") }, result: async () => ({ state: "unknown" as const }) },
  }
  return { ctx, ingestCalls, submitCalls }
}

const okImage = (urls: string[], cost = 0.5, taskId = "task-1") => () => ({
  ok: true as const, taskId, urls, costCoins: cost, requestId: "pg:p1:sig:t0:a0", executedModel: "img-fast",
})
const okVideo = (urls: string[], taskId = "task-2") => () => ({
  ok: true as const, taskId, urls, costCoins: 1.5, requestId: "pg:p1:sig:t0:a0", executedModel: "vid-fast",
})

/** 预置 S5 的权威收据（succeeded + 全部 artifact url），让执行器的 downloaded ACK 有对象可对。 */
function readyReceipt(taskId: string, urls: string[], kind: "image" | "video" = "image") {
  jobStore.registerGenerationReceipt({
    task_id: taskId, parent_gw: SESSION, producer_oc: "ses_test", consumer_oc: "ses_test",
    kind, node_id: "n", requested_count: urls.length,
  })
  jobStore.completeGenerationReceipt(taskId, "succeeded", urls.map((url) => ({ url })), {})
}

// ---------------------------------------------------------------- reference
describe("reference 执行器", () => {
  test("素材从工程产物库经 ctx.ingest 入库，Output 指向 artifact-store", async () => {
    const store = storeFor(SESSION)
    const art = await store.putBytes(PNG_BYTES, { port: "out", mime: "image/png", origin: "user" })
    const n = node("ref", "reference", { source: "upload", artifactId: art.artifactId })
    const g = graphOf([n])
    const { ctx, ingestCalls } = ctxOf(n, g, okImage([]))
    const res: any = await referenceExecutor.run(ctx as any)
    expect(res.ok).toBe(true)
    expect(ingestCalls.length).toBe(1)
    expect(ingestCalls[0].hint).toEqual({ port: "out", mime: "image/png", origin: "user" })
    expect(typeof ingestCalls[0].src.path).toBe("string")
    expect(res.outputs.length).toBe(1)
    expect(res.outputs[0].artifactId).toBe(art.artifactId)
    expect(res.outputs[0].sha256).toBe(PNG_SHA)
    expect(res.outputs[0].artifactId).toBe("art_" + PNG_SHA.slice(0, 16))
    expect(res.outputs[0].path.startsWith(artifactsDir())).toBe(true)
    expect(res.costCoins).toBe(0)
  })

  test("产物库里没有该素材 → bad_input，不猜内容", async () => {
    const n = node("ref2", "reference", { source: "library", artifactId: "art_0123456789abcdef" })
    const { ctx, ingestCalls } = ctxOf(n, graphOf([n]), okImage([]))
    const res: any = await referenceExecutor.run(ctx as any)
    expect(res).toMatchObject({ ok: false, code: "bad_input", retryable: false })
    expect(ingestCalls.length).toBe(0)
  })

  test("estimate 恒 0", async () => {
    const n = node("ref3", "reference", { source: "upload", artifactId: "art_0123456789abcdef" })
    expect(await referenceExecutor.estimate(n as any, graphOf([n]) as any, {})).toBe(0)
  })
})

// ---------------------------------------------------------------- authored
describe("authored 执行器（script / shotlist）", () => {
  test("script：params.text 落盘为 text/plain，sha256 实算，零提交", async () => {
    const text = "第一场 夜，雨中的站台。\n男主背影。"
    const n = node("script", "script", { text })
    const { ctx, ingestCalls, submitCalls } = ctxOf(n, graphOf([n]), okImage([]))
    const res: any = await scriptExecutor.run(ctx as any)
    expect(res.ok).toBe(true)
    expect(submitCalls.length).toBe(0)
    expect(ingestCalls.length).toBe(1)
    expect(ingestCalls[0].hint.mime).toBe("text/plain")
    expect(res.outputs[0].sha256).toBe(sha(Buffer.from(text, "utf-8")))
    expect(res.outputs[0].mime).toBe("text/plain")
    expect(res.outputs[0].path.startsWith(artifactsDir())).toBe(true)
    expect(res.costCoins).toBe(0)
  })

  test("shotlist：JSON.stringify({kind, rows}) 与 write_result 同口径", async () => {
    const rows = [{ id: "s1", action: "男主走进站台" }]
    const n = node("shots", "shotlist", { kind: "shots", rows })
    const { ctx, submitCalls } = ctxOf(n, graphOf([n]), okImage([]))
    const res: any = await shotlistExecutor.run(ctx as any)
    expect(res.ok).toBe(true)
    expect(submitCalls.length).toBe(0)
    expect(res.outputs[0].sha256).toBe(sha(Buffer.from(JSON.stringify({ kind: "shots", rows }), "utf-8")))
    expect(res.outputs[0].mime).toBe("application/json")
  })

  test("没有内容 → bad_input awaiting authored content，不提交生成", async () => {
    for (const [exec, type] of [[scriptExecutor, "script"], [shotlistExecutor, "shotlist"]] as const) {
      const n = node("empty", type, {})
      const { ctx, ingestCalls, submitCalls } = ctxOf(n, graphOf([n]), okImage([]))
      const res: any = await exec.run(ctx as any)
      expect(res).toMatchObject({ ok: false, code: "bad_input", retryable: false, message: "awaiting authored content" })
      expect(ingestCalls.length).toBe(0)
      expect(submitCalls.length).toBe(0)
    }
  })

  test("shotlist rows 为空数组同样算没有内容", async () => {
    const n = node("emptyrows", "shotlist", { kind: "shots", rows: [] })
    const { ctx } = ctxOf(n, graphOf([n]), okImage([]))
    const res: any = await shotlistExecutor.run(ctx as any)
    expect(res).toMatchObject({ ok: false, code: "bad_input", message: "awaiting authored content" })
  })

  test("已有 outputs（写好的内容已落盘）→ 直接交回，不重写", async () => {
    const existing = out("art_0123456789abcdef", "a".repeat(64), { mime: "text/plain", origin: "generated" })
    const n = node("script2", "script", {}, { outputs: [existing] })
    const { ctx, ingestCalls } = ctxOf(n, graphOf([n]), okImage([]))
    const res: any = await scriptExecutor.run(ctx as any)
    expect(res.ok).toBe(true)
    expect(res.outputs[0].artifactId).toBe(existing.artifactId)
    expect(ingestCalls.length).toBe(0)
  })

  test("参数存在但为空 → awaiting（不回退旧 outputs，避免旧内容冒充新签名）", async () => {
    const existing = out("art_0123456789abcdef", "a".repeat(64), { mime: "text/plain" })
    const n = node("script2b", "script", { text: "   " }, { outputs: [existing] })
    const { ctx } = ctxOf(n, graphOf([n]), okImage([]))
    const res: any = await scriptExecutor.run(ctx as any)
    expect(res).toMatchObject({ ok: false, code: "bad_input", message: "awaiting authored content" })
  })

  test("estimate 0", async () => {
    const n = node("script3", "script", { text: "x" })
    expect(await scriptExecutor.estimate(n as any, graphOf([n]) as any, {})).toBe(0)
    expect(await shotlistExecutor.estimate(n as any, graphOf([n]) as any, {})).toBe(0)
  })
})

// ---------------------------------------------------------------- keyframe
describe("keyframe 执行器", () => {
  test("只走注入的 submitGeneration；body 逐字段对齐 NODE_SPECS，产物入库带 sha256", async () => {
    const n = node("kf", "keyframe", {
      prompt: "雨夜站台，男主背影，电影感", model: "img-fast", size: "1024x1536",
      seed: 7, n: 2, quality: "hd", role: "keyframe", styleLock: "统一赛璐珞风格",
    })
    const urls = [`${base()}/files/kf-0.png`, `${base()}/files/kf-1.png`]
    readyReceipt("task-kf-1", urls)
    const { ctx, ingestCalls, submitCalls } = ctxOf(n, graphOf([n]), okImage(urls, 1, "task-kf-1"))
    const res: any = await keyframeExecutor.run(ctx as any)

    expect(res.ok).toBe(true)
    expect(submitCalls.length).toBe(1) // 只走注入通道，且只提交一次
    const req = submitCalls[0]
    expect(req).toMatchObject({
      kind: "image", model: "img-fast", prompt: "雨夜站台，男主背影，电影感",
      n: 2, size: "1024x1536", seed: 7, quality: "hd", styleLock: "统一赛璐珞风格",
      projectId: "p1", nodeId: "kf", signature: "sig-1", runId: "run-1", attempt: 0, take: 0, sessionId: SESSION, apiKey: "sk-test",
    })
    expect(req.prompt).not.toContain("${")
    expect(req.referenceImages).toBeUndefined()
    expect(res.costCoins).toBe(1)
    expect(res.outputs.length).toBe(2)
    expect(ingestCalls.length).toBe(2)
    expect(ingestCalls[0].hint).toEqual({ port: "out", origin: "generated" })
    expect(res.outputs[0]).toMatchObject({ port: "out", sha256: PNG_SHA, artifactId: "art_" + PNG_SHA.slice(0, 16), url: urls[0] })
    expect(res.outputs[1].sha256).toBe(PNG_SHA)
    expect(res.outputs[0].path.startsWith(artifactsDir())).toBe(true)
    expect(res.outputs[0].meta).toMatchObject({ executedModel: "img-fast", seed: 7, task_id: "task-kf-1" })
    // 产物入库后执行器自己记 downloaded ACK（不是调度器）：receipt 带齐 url 与实际 sha256。
    const receipt = jobStore.generationReceipt("task-kf-1") as any
    expect(receipt.downloaded_at).toBeGreaterThan(0)
    expect(jobStore.generationArtifactSha256("task-kf-1")).toEqual({ [urls[0]]: PNG_SHA, [urls[1]]: PNG_SHA })
    expect(networkPosts).toBe(0) // 执行器没有自己 POST 平台
  })

  test("prompt 仍含未解析 ${} → bad_input，不提交", async () => {
    const n = node("kf2", "keyframe", { prompt: "画 ${cast_sheet}", model: "img-fast" })
    const { ctx, submitCalls } = ctxOf(n, graphOf([n]), okImage([]))
    const res: any = await keyframeExecutor.run(ctx as any)
    expect(res).toMatchObject({ ok: false, code: "bad_input", retryable: false })
    expect(res.message).toContain("${")
    expect(submitCalls.length).toBe(0)
  })

  test("参考图从 inputs（image/file 口）与 refs 解析，URL 去重保序", async () => {
    const upstream = node("ref", "reference", { source: "upload", artifactId: "art_aaaaaaaaaaaaaaaa" })
    const refOut = out("art_aaaaaaaaaaaaaaaa", "a".repeat(64), { url: `${base()}/files/ref-a.png` })
    const styleOut = out("art_bbbbbbbbbbbbbbbb", "b".repeat(64), { url: `${base()}/files/ref-b.png` })
    const n = node("kf3", "keyframe", { prompt: "角色定妆照", model: "img-fast" }, { inputs: { image: { from: "ref", port: "out" } } })
    const g = graphOf([upstream, n])
    const kfUrls = [`${base()}/files/kf-3.png`]
    readyReceipt("task-kf-3", kfUrls)
    const { ctx, submitCalls } = ctxOf(n, g, okImage(kfUrls, 0.5, "task-kf-3"), { image: [refOut] }, [{ role: "style", output: styleOut }])
    const res: any = await keyframeExecutor.run(ctx as any)
    expect(res.ok).toBe(true)
    expect(submitCalls[0].referenceImages).toEqual([`${base()}/files/ref-a.png`, `${base()}/files/ref-b.png`])
  })

  test("参考图只有本地 artifact 路径 → bad_input，不截断也不提交", async () => {
    const upstream = node("ref2", "reference", { source: "upload", artifactId: "art_cccccccccccccccc" })
    const local = out("art_cccccccccccccccc", "c".repeat(64))
    const n = node("kf4", "keyframe", { prompt: "角色定妆照", model: "img-fast" }, { inputs: { image: { from: "ref2", port: "out" } } })
    const { ctx, submitCalls } = ctxOf(n, graphOf([upstream, n]), okImage([]), { image: [local] })
    const res: any = await keyframeExecutor.run(ctx as any)
    expect(res).toMatchObject({ ok: false, code: "bad_input", retryable: false })
    expect(res.message).toContain("art_cccccccccccccccc")
    expect(submitCalls.length).toBe(0)
  })

  test("estimate 用目录价 × n；缺价 → null", async () => {
    const priced = node("kf5", "keyframe", { prompt: "p", model: "img-fast", n: 2 })
    expect(await keyframeExecutor.estimate(priced as any, graphOf([priced]) as any, { apiKey: "sk-test" })).toBe(1) // 0.5 × 2
    expect(modelFetches).toBeGreaterThan(0) // 报价确实来自本文件的目录，不是别处暖过的缓存
    const unpriced = node("kf6", "keyframe", { prompt: "p", model: "no-such-image" })
    expect(await keyframeExecutor.estimate(unpriced as any, graphOf([unpriced]) as any, { apiKey: "sk-test" })).toBeNull()
    // 物化硬默认 gpt-image-2.5-flare 但目录没有该档 → null（不猜价）
    const defaulted = node("kf7", "keyframe", { prompt: "p" })
    expect(await keyframeExecutor.estimate(defaulted as any, graphOf([defaulted]) as any, { apiKey: "sk-test" })).toBeNull()
    expect(await keyframeExecutor.estimate(priced as any, graphOf([priced]) as any, {})).toBeNull() // 没凭证拿不到目录
  })

  test("quality=hd 用 hd 单价 × params.n；standard 与缺省仍是 standard", async () => {
    const hd = node("kf-hd", "keyframe", { prompt: "p", model: "img-fast", n: 2, quality: "hd" }, { takes: { n: 4, select: "first" } })
    // 依据：本文件 CATALOG img-fast.x_coins_per_image.hd = 1（standard = 0.5）。
    // 乘法在 estimate 内只乘 params.n：1 × 2 = 2。takes.n 由 admission.computeQuote 再乘，这里不乘。
    expect(await keyframeExecutor.estimate(hd as any, graphOf([hd]) as any, { apiKey: "sk-test" })).toBe(2)
    const standard = node("kf-std", "keyframe", { prompt: "p", model: "img-fast", n: 2, quality: "standard" })
    // 依据：x_coins_per_image.standard = 0.5，不是 hd 的 1。estimate 内 0.5 × params.n(2) = 1。
    expect(await keyframeExecutor.estimate(standard as any, graphOf([standard]) as any, { apiKey: "sk-test" })).toBe(1)
    const omitted = node("kf-omit", "keyframe", { prompt: "p", model: "img-fast", n: 1 })
    // 缺省 quality 落到硬默认 standard。报价是 standard 单价 0.5 × params.n(1) = 0.5，不抬成 hd。
    expect(await keyframeExecutor.estimate(omitted as any, graphOf([omitted]) as any, { apiKey: "sk-test" })).toBe(0.5)
    // 不传 quality 的 estimateNodeCoins 仍回 standard，不读 hd 键。
    expect(await pricing.estimateNodeCoins({ kind: "image", metadata: { model: "img-fast" } }, "sk-test")).toBe(0.5)
  })

  test("hd 缺价回 standard，standard 缺价回 hd", async () => {
    const hdFallback = node("kf-hd-fb", "keyframe", { prompt: "p", model: "img-std-only", n: 2, quality: "hd" })
    // 依据：img-std-only 只有 x_coins_per_image.standard = 0.25，没有 hd。规则 hd ?? standard。0.25 × params.n(2) = 0.5。
    expect(await keyframeExecutor.estimate(hdFallback as any, graphOf([hdFallback]) as any, { apiKey: "sk-test" })).toBe(0.5)
    const standardFallback = node("kf-std-fb", "keyframe", { prompt: "p", model: "img-hd-only", n: 1, quality: "standard" })
    // 依据：img-hd-only 只有 x_coins_per_image.hd = 2，没有 standard。规则 standard ?? hd。2 × params.n(1) = 2。
    expect(await keyframeExecutor.estimate(standardFallback as any, graphOf([standardFallback]) as any, { apiKey: "sk-test" })).toBe(2)
  })

  test("失败码透传：provider_error / timeout / submit_unknown", async () => {
    const cases = [
      { code: "provider_error", retryable: true },
      { code: "timeout", retryable: true },
      { code: "submit_unknown", retryable: false, submitUnknown: true },
    ] as const
    for (const c of cases) {
      const n = node("kf8", "keyframe", { prompt: "p", model: "img-fast" })
      const responder = () => ({ ok: false as const, message: "upstream said no", ...c })
      const { ctx, ingestCalls } = ctxOf(n, graphOf([n]), responder as any)
      const res: any = await keyframeExecutor.run(ctx as any)
      expect(res).toMatchObject({ ok: false, code: c.code, retryable: c.retryable, message: "upstream said no" })
      expect(res.submitUnknown).toBe(c.submitUnknown === true ? true : undefined)
      expect(ingestCalls.length).toBe(0)
    }
  })
})

// ---------------------------------------------------------------- clip
describe("clip 执行器", () => {
  // 本文件测提交/入库/ACK契约；主体识别的正反例由clip-admission独立测试维护。
  beforeEach(() => setClipSubjectCheckForTest(() => ({present:true})))
  afterAll(() => setClipSubjectCheckForTest(null))
  test("只走注入的 submitGeneration；seconds/resolution/generateAudio 逐字段提交，产物入库", async () => {
    const n = node("clip", "clip", {
      prompt: "镜头缓推，雨滴落在伞面，人物回头", model: "vid-fast", seconds: 5,
      resolution: "720p", seed: 3, generateAudio: false, size: "16:9", styleLock: "青橙调",
    })
    const urls = [`${base()}/files/clip-0.mp4`]
    readyReceipt("task-clip-1", urls, "video")
    const { ctx, ingestCalls, submitCalls } = ctxOf(n, graphOf([n]), okVideo(urls, "task-clip-1"))
    const res: any = await clipExecutor.run(ctx as any)
    expect(res.ok).toBe(true)
    expect(submitCalls.length).toBe(1)
    expect(submitCalls[0]).toMatchObject({
      kind: "video", model: "vid-fast", seconds: 5,
      resolution: "720p", generateAudio: false, size: "16:9", seed: 3, styleLock: "青橙调",
      projectId: "p1", nodeId: "clip", signature: "sig-1", runId: "run-1",
    })
    expect(submitCalls[0].prompt).toContain("镜头缓推，雨滴落在伞面，人物回头")
    expect(submitCalls[0].prompt).toContain("画面中不要出现任何文字")
    expect(submitCalls[0].prepared).toBeUndefined() // 默认{}不是原工具订单
    expect(submitCalls[0].prompt).not.toContain("${")
    expect(ingestCalls.length).toBe(1)
    expect(res.outputs[0]).toMatchObject({ port: "out", sha256: MP4_SHA, artifactId: "art_" + MP4_SHA.slice(0, 16), url: urls[0], durationSec: 5 })
    expect(res.outputs[0].meta).toMatchObject({ executedModel: "vid-fast", seed: 3 })
    expect(res.costCoins).toBe(1.5)
    expect((jobStore.generationReceipt("task-clip-1") as any).downloaded_at).toBeGreaterThan(0)
    expect(jobStore.generationArtifactSha256("task-clip-1")).toEqual({ [urls[0]]: MP4_SHA })
    expect(networkPosts).toBe(0)
  })

  test("参考图/未解析引用/失败码：与 keyframe 同一套纪律", async () => {
    const unresolvedNode = node("clip2", "clip", { prompt: "镜头 ${shot.action}", model: "vid-fast", seconds: 5 })
    {
      const { ctx, submitCalls } = ctxOf(unresolvedNode, graphOf([unresolvedNode]), okVideo([]))
      const res: any = await clipExecutor.run(ctx as any)
      expect(res).toMatchObject({ ok: false, code: "bad_input" })
      expect(submitCalls.length).toBe(0)
    }
    const upstream = node("kfup", "keyframe", { prompt: "p", model: "img-fast" })
    const refOut = out("art_dddddddddddddddd", "d".repeat(64), { mime: "image/png", url: `${base()}/files/first-frame.png` })
    const n = node("clip3", "clip", { prompt: "缓推", model: "vid-fast", seconds: 5 }, { inputs: { image: { from: "kfup", port: "out" } } })
    {
      const clipUrls = [`${base()}/files/clip-1.mp4`]
      readyReceipt("task-clip-2", clipUrls, "video")
      const { ctx, submitCalls } = ctxOf(n, graphOf([upstream, n]), okVideo(clipUrls, "task-clip-2"), { image: [refOut] })
      const res: any = await clipExecutor.run(ctx as any)
      expect(res.ok).toBe(true)
      expect(submitCalls[0].referenceImages).toEqual([`${base()}/files/first-frame.png`])
    }
    {
      const { ctx } = ctxOf(n, graphOf([upstream, n]), () => ({ ok: false as const, code: "submit_unknown", message: "unknown", retryable: false, submitUnknown: true }), { image: [refOut] })
      const res: any = await clipExecutor.run(ctx as any)
      expect(res).toMatchObject({ ok: false, code: "submit_unknown", submitUnknown: true, retryable: false })
    }
  })

  test("estimate 用 videoNodeCoinsSync；缺价/缺秒数/缺凭证 → null", async () => {
    const priced = node("clip4", "clip", { prompt: "p", model: "vid-fast", seconds: 5, resolution: "720p" })
    expect(await clipExecutor.estimate(priced as any, graphOf([priced]) as any, { apiKey: "sk-test" })).toBe(1.5)
    const withAudio = node("clip5", "clip", { prompt: "p", model: "vid-fast", seconds: 5, resolution: "720p", generateAudio: true })
    expect(await clipExecutor.estimate(withAudio as any, graphOf([withAudio]) as any, { apiKey: "sk-test" })).toBe(2)
    const unpriced = node("clip6", "clip", { prompt: "p", model: "vid-unknown", seconds: 5 })
    expect(await clipExecutor.estimate(unpriced as any, graphOf([unpriced]) as any, { apiKey: "sk-test" })).toBeNull()
    const missingSeconds = node("clip7", "clip", { prompt: "p", model: "vid-fast", resolution: "720p" })
    expect(await clipExecutor.estimate(missingSeconds as any, graphOf([missingSeconds]) as any, { apiKey: "sk-test" })).toBeNull() // 默认 15 秒无价
    expect(await clipExecutor.estimate(priced as any, graphOf([priced]) as any, {})).toBeNull()
  })

  test("缺 seconds 时按物化硬默认 15 秒提交（NODE_SPECS/HARD_DEFAULTS 同口径）", async () => {
    const n = node("clip8", "clip", { prompt: "p", model: "vid-fast" })
    const urls = [`${base()}/files/clip-default.mp4`]
    readyReceipt("task-clip-3", urls, "video")
    const { ctx, submitCalls } = ctxOf(n, graphOf([n]), okVideo(urls, "task-clip-3"))
    const res: any = await clipExecutor.run(ctx as any)
    expect(res.ok).toBe(true) // materializeDefaults 补了硬默认 seconds=15，执行器按 15 提交
    expect(submitCalls[0].seconds).toBe(15)
  })

  test("ACK 失败只记日志，不把已入库的成功翻成失败（与 S5 轮询记账同语义）", async () => {
    const n = node("kf-ack-fail", "keyframe", { prompt: "p", model: "img-fast" })
    const urls = [`${base()}/files/ack-fail.png`]
    // 不放收据：ackProjectArtifacts 会因 "unregistered job" 抛错。
    const { ctx } = ctxOf(n, graphOf([n]), okImage(urls, 0.5, "task-no-receipt-kf"))
    const errors: string[] = []
    const spy = spyOn(console, "error").mockImplementation((...args: any[]) => { errors.push(args.map(String).join(" ")) })
    try {
      const res: any = await keyframeExecutor.run(ctx as any)
      expect(res.ok).toBe(true)
      expect(res.outputs[0].sha256).toBe(PNG_SHA)
    } finally { spy.mockRestore() }
    expect(errors.some((e) => e.includes("downloaded ACK failed") && e.includes("task-no-receipt-kf"))).toBe(true)
  })
})

// ---------------------------------------------------------------- 全局纪律
describe("全局纪律", () => {
  test("全程没有执行器自己发起的平台 POST", () => {
    expect(networkPosts).toBe(0)
    expect(fileHits).toBeGreaterThan(0) // 产物/参考图字节只从测试内 fake 服务器取
  })
})
