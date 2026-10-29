// S5：submitGeneration / 账本 / 项目预算 / 收据 的行为测试。
// 期望值来源：设计文档 §3（Idempotency-Key 格式、metadata 必带键）、image_generate.ts:495-511 的载荷字段集（手写常量，非从实现读取）、
// 手算币值（目录价 × 数量）。上游一律是本文件自起的 fake 平台服务器；不碰任何真实上游。
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { fileURLToPath } from "node:url"

const SANDBOX = mkdtempSync(join(tmpdir(), "s5-submit-"))
process.env.SESSIONS_DB_PATH = join(SANDBOX, "sessions.db")
process.env.LEDGER_PATH = join(SANDBOX, "ledger.jsonl")
process.env.EIMU_TASK_JOURNAL_PATH = join(SANDBOX, "tool-journal.sqlite")
process.env.EIMU_RUNTIME_DIR = fileURLToPath(new URL("../../opencode-runtime/", import.meta.url))

type Post = { path: string; key: string | null; auth: string | null; body: any }
const posts: Post[] = []
const deletes: string[] = []
const tasksByKey = new Map<string, string>()
const taskKinds = new Map<string, "image" | "video">()
const taskN = new Map<string, number>()
const polls = new Map<string, number>()
let postMode: "ok" | "reject400" | "no_task_id" | "http502" | "sync" = "ok"
let taskOutcome: "succeed" | "fail" | "hang" = "succeed"

const CATALOG = {
  data: [
    { id: "img-m", x_coins_per_image: { standard: 0.5, hd: 1 } },
    {
      id: "vid-m",
      x_coins_per_second: { "720p": 0.3 },
      x_capabilities: { defaultResolution: "720p", defaultAudio: false, audio: true },
      x_billing: { currency: "coins", unit: "per_video", prices: { "720p": { "5": 1.5, "10": 3 } }, prices_with_audio: { "720p": { "5": 2, "10": 4 } } },
    },
  ],
}
const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } })

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const base = `http://127.0.0.1:${server.port}`
    if (req.method === "GET" && url.pathname === "/v1/model-status") return j({}, 404) // 探测不可达 → fail-open
    if (req.method === "GET" && url.pathname === "/v1/models") return j(CATALOG)
    if (req.method === "DELETE" && url.pathname.startsWith("/api/generation-jobs/")) {
      deletes.push(url.pathname.split("/").pop()!)
      return j({ previous_status: "queued", refund: { coins: 1 } })
    }
    const gen = /^\/v1\/(images|videos)\/generations$/.exec(url.pathname)
    if (req.method === "POST" && gen) {
      const body = await req.json()
      const key = req.headers.get("idempotency-key")
      posts.push({ path: url.pathname, key, auth: req.headers.get("authorization"), body })
      if (postMode === "reject400") return j({ error: { message: "bad size" } }, 400)
      if (postMode === "http502") return j({}, 502)
      if (postMode === "no_task_id") return j({ ok: true })
      if (postMode === "sync") return j({data:[{url:"https://cdn.test/synchronous.png"}],cost_coins:0.5})
      let id = key ? tasksByKey.get(key) : undefined // 平台契约：同 Idempotency-Key 回同一任务
      if (!id) {
        id = crypto.randomUUID()
        if (key) tasksByKey.set(key, id)
        taskKinds.set(id, gen[1] === "videos" ? "video" : "image")
        taskN.set(id, body.n ?? 1)
      }
      return j({ task_id: id, status: "queued" }, 202)
    }
    const poll = /^\/v1\/(images|videos)\/([0-9a-f-]{36})$/.exec(url.pathname)
    if (req.method === "GET" && poll) {
      const id = poll[2]
      const c = (polls.get(id) ?? 0) + 1
      polls.set(id, c)
      if (taskOutcome === "hang" || c < 2) return j({ status: "running" })
      if (taskOutcome === "fail") return j({ status: "failed", error: { message: "boom" } })
      const n = taskN.get(id) ?? 1
      return j({ status: "succeeded", cost_coins: 0.9 * n, data: Array.from({ length: n }, (_, i) => ({ url: `${base}/files/${id}-${i}.${taskKinds.get(id) === "video" ? "mp4" : "png"}` })) })
    }
    return j({}, 404)
  },
})
process.env.PLATFORM_BASE = `http://127.0.0.1:${server.port}`

const store = await import("../job-store.ts")
store.reopenSessionsDbForTest()
const { createSubmitGeneration, idempotencyKeyOf, __resetSubmitGenerationMemory } = await import("./submit-generation.ts")
const { resetCatalogCacheForTest } = await import("../pricing-gateway.ts")
resetCatalogCacheForTest()
const { accumulatedSpendCoins, createLedgerWriter, createProjectBudget } = await import("./ledger.ts")
type Req = import("./types.ts").SubmitGenerationReq
const { loadGenerationJournal, sharedJournalOperation, sharedGenerationScope, reconcileJournalOperations } = await import("./generation-journal.ts")
const journal = await loadGenerationJournal(process.env.EIMU_RUNTIME_DIR)
journal.getSubmission("fixture-init", "none")
const journalDb = new Database(process.env.EIMU_TASK_JOURNAL_PATH)
let graphCap: number | null = null
function journalFactory() {
  return async (r: Req, payload: Record<string, unknown>, coins: number) => {
    const canonical = structuredClone(payload)
    delete (canonical.workflow as any)?.metadata?.run_id // 运行轮次不是新付费订单或制作输入
    return sharedJournalOperation(journal, "verified-s5-owner", {
    identity: { project: r.projectId, request_id: idempotencyKeyOf(r), session_id: r.sessionId, model: r.model, cost_coins: coins, input_signature: r.signature },
    payload:canonical, lock: null, cap: cap === null ? graphCap ?? undefined : graphCap === null ? cap : Math.min(cap, graphCap),
  })
  }
}

const SIG = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
const session = { sessionId: "gw-s5", opencodeSessionId: "ses_oc5", apiKey: "sk-test" }
let ledgerRows: any[] = []
let cap: number | null = null
let budget: ReturnType<typeof createProjectBudget>
let submit: ReturnType<typeof createSubmitGeneration>
const ac = () => new AbortController()
let seq = 0
function req(over: Partial<Req> = {}): Req {
  seq++
  return {
    kind: "image", model: "img-m", prompt: "a red fox", projectId: "p1", nodeId: `kf${seq}`, signature: SIG,
    runId: "run1", attempt: 0, take: 0, apiKey: "sk-test", sessionId: "gw-s5", signal: ac().signal, ...over,
  }
}

beforeAll(() => { store.markProjectSession("gw-s5") })
beforeEach(() => {
  posts.length = 0; deletes.length = 0; tasksByKey.clear(); polls.clear(); ledgerRows = []
  postMode = "ok"; taskOutcome = "succeed"; cap = null
  __resetSubmitGenerationMemory()
  journalDb.exec("DELETE FROM tool_submission; DELETE FROM tool_project; DELETE FROM tool_artifact;")
  graphCap = null
  budget = createProjectBudget({ capOf: async () => cap })
  budget.reserve = async () => { throw new Error("本夹具不允许第二份图预算预留；必须使用真实共享journal") }
  budget.noteCarry = (carry) => { graphCap = carry.capCoins }
  budget.snapshot = (project) => {
    const rows = journalDb.query("SELECT state,reservation FROM tool_submission WHERE scope=?").all(sharedGenerationScope("verified-s5-owner", project)) as any[]
    return {
      reserved: rows.filter((r) => r.state === "submitting" || r.state === "accepted").reduce((n, r) => n + r.reservation, 0),
      spent: rows.filter((r) => r.state === "completed").reduce((n, r) => n + r.reservation, 0),
    }
  }
  submit = createSubmitGeneration({
    session,
    ledger: createLedgerWriter(session, async (_s, o) => { ledgerRows.push(o) }),
    budget,
    journalOperation: journalFactory(),
    pollIntervalMs: 5,
  })
})
afterAll(() => { server.stop(true) })

describe("图片：载荷、Idempotency-Key、metadata、收据、账本", () => {
  test("每个 POST 带 pg:<pid>:<sig40>:t<take>:a<attempt>，载荷字段集与 image_generate 一致", async () => {
    const r = req({ n: 2, quality: "hd", size: "1536x1024", styleLock: "STYLE-X", referenceImages: ["https://cdn.test/a.png", "https://cdn.test/b.png"], seed: 7, take: 1, attempt: 2 })
    const res = await submit(r)
    expect(res.ok).toBe(true)
    expect(posts).toHaveLength(1)
    const p = posts[0]
    expect(p.path).toBe("/v1/images/generations")
    expect(p.key).toBe(`pg:p1:${SIG.slice(0, 40)}:t1:a2`)
    expect(p.key).toBe(idempotencyKeyOf(r))
    expect(p.auth).toBe("Bearer sk-test")
    // image_generate.ts:499-507 + 510-511 的字段集（手写）
    expect(Object.keys(p.body).sort()).toEqual(["cap_coins", "model", "n", "prompt", "quality", "reference_images", "response_format", "size", "workflow"])
    expect(p.body).toMatchObject({ model: "img-m", n: 2, size: "1536x1024", quality: "hd", response_format: "url", prompt: "STYLE-X\na red fox", reference_images: ["https://cdn.test/a.png", "https://cdn.test/b.png"] })
    // 依据：本文件 CATALOG「img-m」的 x_coins_per_image.hd = 1（standard = 0.5）。
    // 旧逻辑 image_generate.ts:403：quality==="hd" 时 unit = entry.hd ?? entry.standard。
    // cap_coins = hd 单价 × n = 1 × 2 = 2。
    expect(p.body.cap_coins).toBe(2)
    expect(p.body.workflow.metadata).toMatchObject({
      project_id: "p1", node_id: r.nodeId, signature: SIG, run_id: "run1", attempt: 2, take: 1, seed: 7,
      project: "p1", request_id: p.key, session_id: "gw-s5", size: "1536x1024", style_lock: "STYLE-X",
    })
    if (res.ok === false) throw new Error("unreachable")
    expect(res.urls).toHaveLength(2)
    expect(res.costCoins).toBeCloseTo(1.8, 6) // fake 实扣 0.9 × 2
    expect(res.requestId).toBe(p.key)
    expect(res.executedModel).toBe("img-m")
  })

  test("quality=standard、n=1 按目录 standard 单价，不被 hd 分支抬高", async () => {
    const res = await submit(req({ quality: "standard", n: 1 }))
    expect(res.ok).toBe(true)
    expect(posts).toHaveLength(1)
    // 依据：CATALOG img-m.x_coins_per_image.standard = 0.5，不是 hd 的 1。
    expect(posts[0].body.quality).toBe("standard")
    expect(posts[0].body.cap_coins).toBe(0.5)
    expect(posts[0].body.n).toBe(1)
  })

  test("Idempotency-Key 组成是 projectId、signature 前 40 位、take、attempt，没有 runId（需上游实证）", () => {
    const key = idempotencyKeyOf({ projectId: "p1", signature: SIG, take: 1, attempt: 2 })
    expect(key).toBe(`pg:p1:${SIG.slice(0, 40)}:t1:a2`)
    expect(key).toContain("p1")
    expect(key).toContain(SIG.slice(0, 40))
    expect(key).toContain("t1")
    expect(key).toContain("a2")
    const withRunA = idempotencyKeyOf({ projectId: "p1", signature: SIG, take: 1, attempt: 2, runId: "run-A" } as never)
    const withRunB = idempotencyKeyOf({ projectId: "p1", signature: SIG, take: 1, attempt: 2, runId: "run-OTHER" } as never)
    expect(withRunA).toBe(withRunB)
    expect(withRunA.includes("run-A")).toBe(false)
    expect(withRunA.includes("run-OTHER")).toBe(false)
    expect(withRunA.includes("runId")).toBe(false)
  })

  test("收据带 node_id 登记并在成功后完成+observed；账本 submitted→completed 都带 node_id/idem_key；预算 预留→实扣", async () => {
    const r = req()
    const res = await submit(r)
    if (res.ok === false) throw new Error(res.message)
    const receipt = store.generationReceipt(res.taskId)!
    expect(receipt).toMatchObject({ kind: "image", parent_gw: "gw-s5", producer_oc: "ses_oc5", node_id: r.nodeId, signature: SIG, project: "p1", status: "succeeded", request_id: idempotencyKeyOf(r) })
    expect(receipt.artifacts.map((a) => a.url)).toEqual(res.urls)
    expect(receipt.observed_at).not.toBeNull()
    expect(ledgerRows.map((x) => x.event)).toEqual(["submitted", "completed"])
    for (const row of ledgerRows) expect(row).toMatchObject({ kind: "generation", project_id: "p1", node_id: r.nodeId, signature: SIG, run_id: "run1", idem_key: idempotencyKeyOf(r), attempt: 0, take: 0 })
    expect(ledgerRows[0].cost_coins).toBe(0.5)
    expect(ledgerRows[1]).toMatchObject({ task_id: res.taskId, cost_coins: 0.9, result_url: res.urls[0] })
    expect(budget.snapshot("p1").reserved).toBe(0)
    expect(budget.snapshot("p1").spent).toBeCloseTo(0.9, 6)
  })

  test("同 key 重入/进程内记忆丢失后从真实journal恢复，完全不再次POST", async () => {
    const r = req()
    const a = await submit(r)
    const b = await submit(r)
    expect(posts).toHaveLength(1) // 已受理 → 第二次直接续轮询
    __resetSubmitGenerationMemory()
    const c = await submit(r)
    expect(posts).toHaveLength(1)
    expect(tasksByKey.size).toBe(1) // 平台侧只有一个任务
    if (a.ok === false || b.ok === false || c.ok === false) throw new Error("unexpected failure")
    expect(new Set([a.taskId, b.taskId, c.taskId]).size).toBe(1)
    expect(a.costCoins).toBe(0.9)
    expect(b).toMatchObject({ reusedOperation: true, costCoins: 0, originalCostCoins: 0.9 })
    expect(c).toMatchObject({ reusedOperation: true, costCoins: 0, originalCostCoins: 0.9 })
    expect(ledgerRows.filter((row) => row.event === "completed")).toHaveLength(1)
  })

  test("上游任务失败：写 failed+refunded 行（带 node_id），预算释放，收据 failed", async () => {
    taskOutcome = "fail"
    const r = req()
    const res = await submit(r)
    expect(res).toMatchObject({ ok: false, code: "provider_error", retryable: true })
    expect(ledgerRows.map((x) => x.event)).toEqual(["submitted", "failed", "refunded"])
    expect(ledgerRows[2]).toMatchObject({ node_id: r.nodeId, cost_coins: 0.5 })
    expect(budget.snapshot("p1")).toEqual({ reserved: 0, spent: 0 })
    if (res.ok === false) expect(store.generationReceipt(res.taskId!)!.status).toBe("failed")
  })

  test("显式新take同参数允许一笔新POST；旧完成operation恢复不重复完成账或新增费用", async () => {
    const original = req({ take: 0 })
    const first = await submit(original)
    const newTake = { ...original, take: 1 }
    const second = await submit(newTake)
    const restored = await submit(original)
    expect(first.ok && second.ok && restored.ok).toBe(true)
    expect(posts.map((p) => p.key)).toEqual([idempotencyKeyOf(original), idempotencyKeyOf(newTake)])
    if (!first.ok || !second.ok || !restored.ok) throw new Error("expected accepted generations")
    expect(first.taskId).not.toBe(second.taskId)
    expect(restored.taskId).toBe(first.taskId)
    expect(restored).toMatchObject({ costCoins: 0, originalCostCoins: 0.9, reusedOperation: true })
    expect(ledgerRows.filter((row) => row.event === "completed")).toHaveLength(2)
    expect(budget.snapshot("p1").spent).toBe(1.8)
  })

  test("真实故障反例：已结算旧单恢复不得因上游后来矛盾failed释放原费用", async () => {
    const r = req()
    const first = await submit(r)
    expect(first.ok).toBe(true)
    __resetSubmitGenerationMemory()
    taskOutcome = "fail"
    const resumed = await submit(r)
    expect(resumed).toMatchObject({ ok: true, reusedOperation: true, costCoins: 0, originalCostCoins: 0.9 })
    expect(posts).toHaveLength(1)
    expect(ledgerRows.filter((row) => row.event === "refunded")).toHaveLength(0)
    expect(budget.snapshot("p1").spent).toBe(0.9)
  })

  test("真实旧S5 ledger+receipt可幂等导入同journal，旧单恢复不重付且新take继续", async () => {
    const old = req()
    const paid = await submit(old)
    expect(paid.ok).toBe(true)
    const key = idempotencyKeyOf(old)
    const completed = ledgerRows.find((row) => row.event === "completed")
    const submitted = ledgerRows.find((row) => row.event === "submitted")
    // 模拟旧graph已付费但尚无共享journal关联；实际上游收据、实际完成账保持原样。
    journalDb.query("DELETE FROM tool_submission WHERE request_id=?").run(key)
    const graph: any = { id: "p1", sessionId: session.sessionId, nodes: { [old.nodeId]: {} }, budget: { spentCoins: 0.9 } }
    const operations = [{ key, submitted: { ...submitted, session_id: session.sessionId }, completed: { ...completed, session_id: session.sessionId } }]
    const receipts = store.generationReceipts(session.sessionId)
    reconcileJournalOperations(journal, "verified-s5-owner", graph, operations, receipts)
    reconcileJournalOperations(journal, "verified-s5-owner", graph, operations, receipts)
    expect(budget.snapshot("p1").spent).toBe(0.9)
    __resetSubmitGenerationMemory()
    expect(await submit(old)).toMatchObject({ ok: true, reusedOperation: true, costCoins: 0, originalCostCoins: 0.9 })
    expect(posts).toHaveLength(1)
    expect(await submit({ ...old, take: 1 })).toMatchObject({ ok: true, costCoins: 0.9 })
    expect(posts).toHaveLength(2)
    expect(budget.snapshot("p1").spent).toBe(1.8)
  })
})

test("同步真实产物取得稳定耐久receipt，恢复不轮询虚构provider任务或再次扣费", async () => {
  postMode="sync"
  const r=req()
  const result=await submit(r)
  expect(result.ok).toBe(true)
  if(!result.ok)throw new Error(result.message)
  expect(result.taskId).toMatch(/^[a-f0-9-]{36}$/)
  expect(store.generationReceipt(result.taskId)?.status).toBe("succeeded")
  __resetSubmitGenerationMemory()
  const restored=await submit({...r,runId:"later"})
  expect(restored).toMatchObject({ok:true,taskId:result.taskId,costCoins:0,originalCostCoins:0.5})
  expect(posts.length).toBe(1)
  expect(polls.size).toBe(0)
})

describe("视频载荷", () => {
  test("字段集=image_generate 视频分支；动作兜底追加；cap_coins=目录整档价（含音轨）", async () => {
    const r = req({ kind: "video", model: "vid-m", seconds: 5, generateAudio: true, resolution: "720p", referenceImages: ["https://cdn.test/f0.png"], size: "9:16" })
    const res = await submit(r)
    if (res.ok === false) throw new Error(res.message)
    const p = posts[0]
    expect(p.path).toBe("/v1/videos/generations")
    expect(Object.keys(p.body).sort()).toEqual(["cap_coins", "duration_seconds", "generate_audio", "model", "n", "prompt", "reference_images", "resolution", "size", "workflow"])
    expect(p.body).toMatchObject({ duration_seconds: 5, generate_audio: true, resolution: "720p", size: "9:16", cap_coins: 2 })
    expect(p.body.prompt.startsWith("a red fox ")).toBe(true)
    expect(p.body.prompt).toContain("Continuous physical action")
    expect(p.body.workflow.metadata).toMatchObject({ node_id: r.nodeId, signature: SIG, project_id: "p1" })
    expect(res.urls[0].endsWith(".mp4")).toBe(true)
  })

  test("缺时长 / 非 http 参考图 / 目录无价 → 未提交（0 个 POST）", async () => {
    expect(await submit(req({ kind: "video", model: "vid-m" }))).toMatchObject({ ok: false, code: "bad_input" })
    expect(await submit(req({ kind: "image", referenceImages: ["/tmp/local.png"] }))).toMatchObject({ ok: false, code: "bad_input" })
    expect(await submit(req({ model: "no-such-model" }))).toMatchObject({ ok: false, code: "price_unknown" })
    expect(posts).toHaveLength(0)
  })
})

describe("预算与 submit_unknown", () => {
  test("跨轮已花费 + 本次报价超过图上 capCoins：不发 POST", async () => {
    // 旧消耗来自独立已存在操作，不把总额凭空写入新订单。
    const prior = sharedJournalOperation(journal, "verified-s5-owner", { identity: { project: "p1", request_id: "prior-operation", session_id: session.sessionId, model: "img-m", cost_coins: 0.4 }, payload: { prior: true }, lock: null })
    prior.reserve(); prior.settle(0.4)
    budget.noteCarry?.({ spentCoins: 0.4, capCoins: 0.6 })
    const res = await submit(req())
    expect(res.ok).toBe(false)
    expect(posts).toHaveLength(0)
    expect(budget.snapshot("p1").reserved).toBe(0)
  })

  test("未设 cap，或已花费未超 cap，仍然提交（fake，不打上游）", async () => {
    budget.noteCarry?.({ spentCoins: 100, capCoins: null })
    const open = await submit(req())
    expect(open.ok).toBe(true)
    expect(posts).toHaveLength(1)
    posts.length = 0
    __resetSubmitGenerationMemory()
    const underBudget = createProjectBudget({ capOf: async () => null })
    underBudget.noteCarry?.({ spentCoins: 0.2, capCoins: 1 })
    graphCap = 1
    const known = sharedJournalOperation(journal, "verified-s5-owner", { identity: { project: "under-cap-project", request_id: "known-prior", session_id: session.sessionId, model: "img-m", cost_coins: 0.2 }, payload: { prior: true }, lock: null, cap: 1 })
    known.reserve(); known.settle(0.2)
    const underSubmit = createSubmitGeneration({
      session, ledger: createLedgerWriter(session, async () => {}), budget: underBudget, pollIntervalMs: 5, journalOperation: journalFactory(),
    })
    const under = await underSubmit(req({ projectId: "under-cap-project" }))
    expect(under.ok).toBe(true)
    expect(posts).toHaveLength(1)
    expect(posts[0].body.cap_coins).toBe(0.5)
  })

  test("账本未决 submitted 计入已花费，完成与退回不重复加", () => {
    const text = [
      JSON.stringify({ project_id: "p1", event: "submitted", idem_key: "k-open", cost_coins: 0.5 }),
      JSON.stringify({ project_id: "p1", event: "submitted", idem_key: "k-done", cost_coins: 0.5 }),
      JSON.stringify({ project_id: "p1", event: "completed", idem_key: "k-done", cost_coins: 0.4 }),
      JSON.stringify({ project_id: "p1", event: "submitted", idem_key: "k-back", cost_coins: 0.5 }),
      JSON.stringify({ project_id: "p1", event: "refunded", idem_key: "k-back", cost_coins: 0.5 }),
      JSON.stringify({ project_id: "other", event: "submitted", idem_key: "k-x", cost_coins: 9 }),
    ].join("\n")
    // 图上已花 0.4 与 completed 0.4 取较大值，再加未决 0.5。退回的 k-back 和其他项目不加。
    expect(accumulatedSpendCoins({ id: "p1", budget: { spentCoins: 0.4 } }, text)).toBeCloseTo(0.9, 6)
  })

  test("超项目硬预算：不发 POST，不留预留", async () => {
    cap = 0.4
    const res = await submit(req())
    expect(res).toMatchObject({ ok: false, code: "bad_input" })
    expect(posts).toHaveLength(0)
    expect(budget.snapshot("p1").reserved).toBe(0)
  })

  test("预算读取失败 → fail-closed 不提交", async () => {
    const b2 = createProjectBudget({ capOf: async () => { throw new Error("owner unavailable") } })
    const s2 = createSubmitGeneration({ session, ledger: createLedgerWriter(session, async () => {}), budget: b2, pollIntervalMs: 5, journalOperation: async () => { throw new Error("project_budget_unavailable: owner unavailable") } })
    expect(await s2(req())).toMatchObject({ ok: false, code: "provider_error", retryable: true })
    expect(posts).toHaveLength(0)
  })

  test("4xx 明确拒收：释放预留，不判 unknown", async () => {
    postMode = "reject400"
    const res = await submit(req())
    expect(res).toMatchObject({ ok: false, code: "bad_input", retryable: false })
    expect(res.ok === false && res.submitUnknown).toBeFalsy()
    expect(budget.snapshot("p1").reserved).toBe(0)
  })

  for (const mode of ["http502", "no_task_id"] as const) {
    test(`${mode}：submit_unknown，保留预留与 key；恢复时用同一 key 续上，不产生第二个任务`, async () => {
      postMode = mode
      const r = req()
      const res = await submit(r)
      expect(res).toMatchObject({ ok: false, code: "submit_unknown", submitUnknown: true, retryable: false })
      expect(budget.snapshot("p1").reserved).toBe(0.5) // 没释放
      expect(ledgerRows.map((x) => x.event)).toEqual(["submitted"]) // 订单可能存在：账本留 submitted，不假装失败
      postMode = "ok"
      const again = await submit(r)
      expect(again).toMatchObject({ ok: false, code: "submit_unknown", submitUnknown: true })
      expect(posts.map((p) => p.key)).toEqual([idempotencyKeyOf(r)])
      expect(ledgerRows.filter((x) => x.event === "submitted")).toHaveLength(1) // 不重复记 submitted
      expect(budget.snapshot("p1").reserved).toBe(0.5)
    })
  }

  test("signal 中止：取消平台任务，写 refunded，预算释放", async () => {
    taskOutcome = "hang"
    const c = ac()
    const p = submit(req({ signal: c.signal }))
    await Bun.sleep(60)
    c.abort()
    const res = await p
    expect(res).toMatchObject({ ok: false, code: "cancelled" })
    expect(deletes).toHaveLength(1)
    expect(ledgerRows.map((x) => x.event)).toEqual(["submitted", "failed", "refunded"])
    expect(budget.snapshot("p1").reserved).toBe(0)
  })
})

describe("job-store 与账本写入器", () => {
  test("工程会话里无 node_id 的图/视频登记 → 409；有 node_id 与旧会话不受影响", () => {
    const mk = (parent: string, extra: object = {}) => ({ task_id: crypto.randomUUID(), parent_gw: parent, producer_oc: "ses_x", consumer_oc: "ses_x", kind: "image", ...extra })
    let err: any
    try { store.registerGenerationReceipt(mk("gw-s5")) } catch (e) { err = e }
    expect(err).toBeInstanceOf(store.ProjectNodeRequiredError)
    expect(err.status).toBe(409)
    expect(() => store.registerGenerationReceipt(mk("gw-s5", { node_id: "kf1" }))).not.toThrow()
    expect(() => store.registerGenerationReceipt(mk("gw-legacy"))).not.toThrow()
    expect(() => store.registerGenerationReceipt(mk("gw-s5", { kind: "message" }))).not.toThrow()
  })

  test("downloaded ACK 保留实算 sha256；重复终态回调不清 downloaded_at", () => {
    const id = crypto.randomUUID()
    const art = [{ url: "https://cdn.test/x.png" }]
    store.registerGenerationReceipt({ task_id: id, parent_gw: "gw-s5", producer_oc: "ses_x", consumer_oc: "ses_x", kind: "image", node_id: "kf1" })
    store.completeGenerationReceipt(id, "succeeded", art, {})
    store.acknowledgeGeneration(id, "downloaded", { artifact_urls: ["https://cdn.test/x.png"], downloaded_artifacts: [{ url: "https://cdn.test/x.png", path: "/w/x.png", sha256: "ab".repeat(32), bytes: 3 }] })
    expect(store.generationArtifactSha256(id)).toEqual({ "https://cdn.test/x.png": "ab".repeat(32) })
    expect(store.generationReceipt(id)!.downloaded_at).not.toBeNull()
    store.completeGenerationReceipt(id, "succeeded", art, {})
    expect(store.generationReceipt(id)!.downloaded_at).not.toBeNull()
    expect(store.generationArtifactSha256(id)["https://cdn.test/x.png"]).toBe("ab".repeat(32))
  })

  test("LedgerWriter：reused 行恒 0 币且 reused:true；真实 appendLedgerFor 落到 ledger.jsonl 并带工程字段", async () => {
    const seen: any[] = []
    const w = createLedgerWriter(session, async (_s, o) => { seen.push(o) })
    await w.write({ event: "reused", project_id: "p1", node_id: "n1", signature: SIG, cost_coins: 9, artifact_sha256: "cd".repeat(32) })
    expect(seen[0]).toMatchObject({ kind: "generation", event: "reused", cost_coins: 0, reused: true, node_id: "n1", artifact_sha256: "cd".repeat(32) })
    await createLedgerWriter(session).write({ event: "completed", project_id: "p9", node_id: "n9", signature: SIG, idem_key: "k", charge_ref: "c1", cost_coins: 1.25, task_id: "t1" })
    const last = JSON.parse(readFileSync(process.env.LEDGER_PATH!, "utf-8").trim().split("\n").pop()!)
    expect(last).toMatchObject({ kind: "generation", event: "completed", project_id: "p9", node_id: "n9", idem_key: "k", charge_ref: "c1", cost_coins: 1.25, session_id: "gw-s5", opencode_session_id: "ses_oc5" })
    expect(typeof last.user_id).toBe("string")
    expect(JSON.stringify(last)).not.toContain("sk-test")
  })
})
