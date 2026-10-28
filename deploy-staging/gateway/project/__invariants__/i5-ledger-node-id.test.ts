// I5（设计文档 §8 第五行）：账本每笔生成带 node_id，直调 = 0。
//
// 独立期望来源 = fake 平台服务器（127.0.0.1）收到的**原始请求**：判 Idempotency-Key 与
// workflow.metadata.node_id，不读账本实现的内部字段。账本行数由本档手算：
//   6 个生成节点（submitted+completed=12）+ 1 次复用（reused=1）+ 1 次失败重试
//   （submitted+failed+refunded=3，重试 submitted+completed=2）= 18 行。
// 反例：直接往假平台发一个没有 key / node_id 的 POST，审计必须报出这条直调。
import "./fixtures/env"
import { directCallViolations, platform } from "./fixtures/fake-platform"
import { beforeEach, describe, expect, test } from "bun:test"

const IMAGE = "gpt-image-2.5-flare"
const SIG = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
/** 每节点不同签名（生产里由参数/上游内容算出；同签名=同内容=同 idemKey）。 */
const sigOf = (tag: string) => tag.repeat(64).slice(0, 64)
const SESSION = { sessionId: "gw_i5", opencodeSessionId: "oc_i5", apiKey: "sk-i5-test-only" }

const storeMod = await import("../../job-store.ts")
storeMod.reopenSessionsDbForTest()
const { createSubmitGeneration, idempotencyKeyOf, __resetSubmitGenerationMemory } = await import("../submit-generation.ts")
const { resetCatalogCacheForTest } = await import("../../pricing-gateway.ts")
resetCatalogCacheForTest()
const { createLedgerWriter, createProjectBudget } = await import("../ledger.ts")
const { markReused } = await import("../scheduler.ts")
const { ensureProject } = await import("../store.ts")

type Req = import("../types.ts").SubmitGenerationReq
type Row = Record<string, any>

let rows: Row[] = []
let submit: ReturnType<typeof createSubmitGeneration>

function deps(ledger: ReturnType<typeof createLedgerWriter>) {
  return {
    session: SESSION,
    ledger,
    submitGeneration: async () => ({ ok: false, code: "bad_input" as const, message: "unused", retryable: false }),
    execBridge: {
      call: async () => ({ ok: false, code: "bridge_unavailable" as const, message: "unused", retryable: false }),
      result: async () => ({ state: "unknown" as const }),
    },
  }
}

beforeEach(() => {
  platform.reset()
  rows = []
  __resetSubmitGenerationMemory()
  storeMod.markProjectSession(SESSION.sessionId)
  submit = createSubmitGeneration({
    session: SESSION,
    ledger: createLedgerWriter(SESSION, async (_s, o) => { rows.push(o as Row) }),
    budget: createProjectBudget({ capOf: async () => null }),
    pollIntervalMs: 5,
  })
})

let seq = 0
function req(over: Partial<Req> = {}): Req {
  seq++
  return {
    kind: "image", model: IMAGE, prompt: `a red fox ${seq}`, projectId: "gw_i5", nodeId: `kf${seq}`, signature: SIG,
    runId: "run_i5", attempt: 0, take: 0, apiKey: SESSION.apiKey, sessionId: SESSION.sessionId,
    signal: new AbortController().signal, ...over,
  }
}

describe("I5 账本 node_id 与直调 = 0", () => {
  test("6 生成 + 1 复用 + 1 失败重试：18 行账本，每一笔带 node_id；8 个 POST 全部带 key 与 node_id", async () => {
    // ① 6 个生成节点：每个 submitted + completed。
    for (let i = 0; i < 6; i++) {
      const res = await submit(req({ nodeId: `gen_${i}`, signature: sigOf(`${i.toString(16).padStart(2, "0")}`) }))
      if (res.ok === false) throw new Error(`gen_${i}: ${res.message}`)
    }
    expect(rows.filter((r) => r.event === "submitted").length).toBe(6)
    expect(rows.filter((r) => r.event === "completed").length).toBe(6)

    // ② 1 次复用：走调度器真实的 markReused（不是手写账本行）。
    const { store } = await ensureProject(SESSION.sessionId)
    await store.update((g: any) => {
      g.nodes.reuse_node = {
        id: "reuse_node", type: "keyframe", intent: "", params: {}, inputs: {}, refs: [], pinned: null,
        status: "done", signature: SIG, lastRun: null, outputs: [], rev: 1,
      }
      g.order.push("reuse_node")
    })
    const out = {
      port: "out", artifactId: "art_0123456789abcdef", sha256: "ab".repeat(32), path: "/tmp/reuse.png",
      mime: "image/png", bytes: 3, origin: "generated" as const,
    }
    const reusedLedger = createLedgerWriter(SESSION, async (_s, o) => { rows.push(o as Row) })
    await markReused(store, deps(reusedLedger) as never, "run_i5", "reuse_node", SIG, [out], 0.5)
    expect(rows.filter((r) => r.event === "reused").length).toBe(1)

    // ③ 1 次失败重试：attempt 0 失败（submitted+failed+refunded），attempt 1 成功（submitted+completed）。
    platform.taskOutcome = "fail"
    const failed = await submit(req({ nodeId: "retry_node", attempt: 0, signature: sigOf("ee") }))
    expect(failed.ok).toBe(false)
    platform.taskOutcome = "succeed"
    const retried = await submit(req({ nodeId: "retry_node", attempt: 1, signature: sigOf("ee") }))
    if (retried.ok === false) throw new Error(`retry: ${retried.message}`)

    // 手算总账：12 + 1 + 5 = 18。
    expect(rows.length).toBe(18)
    expect(rows.filter((r) => r.event === "submitted").length).toBe(8)
    expect(rows.filter((r) => r.event === "completed").length).toBe(7)
    expect(rows.filter((r) => r.event === "failed").length).toBe(1)
    expect(rows.filter((r) => r.event === "refunded").length).toBe(1)
    expect(rows.filter((r) => r.event === "reused").length).toBe(1)
    for (const row of rows) {
      expect(typeof row.node_id).toBe("string")
      expect(row.node_id.length).toBeGreaterThan(0)
      expect(row.project_id).toBe("gw_i5")
      if (row.event === "reused") expect(row.cost_coins).toBe(0)
    }

    // 直调 = 0：每个生成 POST 都有 Idempotency-Key 与 metadata.node_id。
    expect(platform.posts.length).toBe(8)
    expect(directCallViolations(platform.posts)).toEqual([])
    for (const post of platform.posts) {
      expect(post.key).toMatch(/^pg:gw_i5:[0-9a-f]{40}:t0:a[01]$/)
      expect(typeof post.body.workflow.metadata.node_id).toBe("string")
      expect(post.body.workflow.metadata.project_id).toBe("gw_i5")
      expect(post.body.workflow.metadata.signature).toBeTruthy()
    }
    // 每个生成节点的 key 唯一（同 attempt 不重复提交）。
    expect(new Set(platform.posts.map((p) => p.key)).size).toBe(8)
  }, 30_000)

  test("项目会话里无 node_id 的 job-register → HTTP 409；有 node_id 或旧会话不拦", async () => {
    const { sessions } = await import("../../sessions-core.ts")
    const { handleGenerationDelivery } = await import("../../job-delivery.ts")
    const httpSessionId = "gw_i5_http"
    storeMod.markProjectSession(httpSessionId)
    sessions.set(httpSessionId, {
      sessionId: httpSessionId,
      opencodeSessionId: "oc_i5_http",
      apiKey: "sk-i5-test-only",
      pendingConfirms: new Map(),
      resolvedConfirms: new Map(),
      pendingQuestions: new Map(),
      replayBuffer: [],
      clients: new Set(),
      eventCounter: 0,
    } as never)
    const register = (sessionId: string, extra: Record<string, unknown> = {}) =>
      handleGenerationDelivery(
        new Request("http://127.0.0.1/internal/job-register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task_id: crypto.randomUUID(), session_id: sessionId, kind: "image", ...extra }),
        }),
        "/internal/job-register",
      )
    const rejected = await register(httpSessionId)
    expect(rejected.status).toBe(409)
    expect((await rejected.json() as any).error).toContain("node_id")
    const accepted = await register(httpSessionId, { node_id: "kf1" })
    expect(accepted.status).toBe(200)
    // 合法放行：旧会话（非工程模式）本来就不传 node_id。
    const legacyHttp = "gw_i5_legacy_http"
    sessions.set(legacyHttp, {
      sessionId: legacyHttp,
      opencodeSessionId: "oc_i5_legacy_http",
      apiKey: "sk-i5-test-only",
      pendingConfirms: new Map(),
      resolvedConfirms: new Map(),
      pendingQuestions: new Map(),
      replayBuffer: [],
      clients: new Set(),
      eventCounter: 0,
    } as never)
    expect((await register(legacyHttp)).status).toBe(200)

    const mk = (parent: string, extra: object = {}) => ({
      task_id: crypto.randomUUID(), parent_gw: parent, producer_oc: "oc_i5", consumer_oc: "oc_i5", kind: "image", ...extra,
    })
    let err: any
    try {
      storeMod.registerGenerationReceipt(mk(SESSION.sessionId) as never)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(storeMod.ProjectNodeRequiredError)
    expect(err.status).toBe(409)
    expect(() => storeMod.registerGenerationReceipt(mk(SESSION.sessionId, { node_id: "kf1" }) as never)).not.toThrow()
    expect(() => storeMod.registerGenerationReceipt(mk("gw_i5_legacy") as never)).not.toThrow()
  })

  test("反例：手工直调（无 key / 无 node_id）必须被审计报出", async () => {
    await fetch(`${process.env.PLATFORM_BASE}/v1/images/generations`, {
      method: "POST",
      headers: { authorization: "Bearer sk-i5-test-only", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "直调", model: IMAGE }),
    })
    expect(platform.posts.length).toBe(1)
    const bad = directCallViolations(platform.posts)
    expect(bad.length).toBe(1)
    expect(bad[0].key).toBeNull()
    expect(bad[0].body?.workflow).toBeUndefined()
  })
})
