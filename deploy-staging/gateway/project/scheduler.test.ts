// S6 调度器判准测试（设计文档 §10 S6 的双侧判准）。
//
// 期望值来源：
//   - 「命中节点执行器 0 调用」「reused 事件/账本行数=复用节点数、cost_coins=0」= 设计文档 §3.2 planRun 语义 + §3.1 字段归属；
//   - 「regenerate(max=2) 执行器调用 1+2 次、种子按 effectiveSeed 递增」= §3.3 + S4 takes.ts 的 effectiveSeed（take 步长=REGENERATE_MAX+1=3）；
//   - 「层内并发峰值=层宽（受上限约束）」= §3.4「同层并行」；上限 0=不限，与网关 workflow 引擎同层 Promise.all 一致；
//   - 「重启恢复同 idemKey、不二次提交」= §3.4 崩溃恢复段 + 记忆 2026-08-31-provider-reconciliation（真相未明不重投）；
//   - 「运行期间用户改参数 → 结果照存、节点 stale」= §3.4 并发段；
//   - 「作者节点无内容 → pending + 下游 blocked(reason awaiting author)、整轮不算失败」= §10 S6 第 7 条；
//   - 「报价 ≥ CONFIRM_THRESHOLD_COINS 且非 auto/full → 非阻塞确认」= §3.9 + memory workflow-template-abandon-incident-fix。
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// 沙箱必须早于 store.ts（连带 job-store.ts）载入。
const SANDBOX = mkdtempSync(join(tmpdir(), "s6-scheduler-"))
process.env.WORKSPACE_DIR = join(SANDBOX, "workspace")
process.env.SESSIONS_DB_PATH = join(SANDBOX, "sessions.db")
process.env.LEDGER_PATH = join(SANDBOX, "ledger.jsonl")
process.env.CONFIRM_THRESHOLD_COINS = "5"

const { registerExecutor, clearExecutors } = await import("./executor-registry.ts")
const { ensureProject, openProject, projectDirFor } = await import("./store.ts")
const { runProject } = await import("./run.ts")
const { recoverProject } = await import("./recovery.ts")
const { idempotencyKeyOf } = await import("./submit-generation.ts")
const { reopenSessionsDbForTest } = await import("../job-store.ts")
reopenSessionsDbForTest()
const { resetCatalogCacheForTest } = await import("../pricing-gateway.ts")
resetCatalogCacheForTest()
type ExecContext = import("./types.ts").ExecContext
type ExecResult = import("./types.ts").ExecResult
type NodeExecutor = import("./types.ts").NodeExecutor
type NodeType = import("./types.ts").NodeType
type Output = import("./types.ts").Output
type ProjectNode = import("./types.ts").ProjectNode
type ProjectEvent = import("./types.ts").ProjectEvent
type SubmitGenerationReq = import("./types.ts").SubmitGenerationReq
type SubmitGenerationRes = import("./types.ts").SubmitGenerationRes

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))
beforeEach(() => clearExecutors())

const NODE = (id: string, type: NodeType, extra: Partial<ProjectNode> = {}): ProjectNode => ({
  id, type, intent: "", params: {}, inputs: {}, refs: [], pinned: null,
  status: "pending", signature: null, lastRun: null, outputs: [], rev: 0, ...extra,
})

async function makeProject(sessionId: string, nodes: ProjectNode[], opts: { capCoins?: number | null } = {}) {
  const { store } = await ensureProject(sessionId, {})
  await store.update((g) => {
    for (const n of nodes) {
      g.nodes[n.id] = n
      g.order.push(n.id)
    }
    if (opts.capCoins !== undefined) g.budget.capCoins = opts.capCoins
  })
  return store
}

function makeSession(sessionId: string) {
  return { sessionId, apiKey: "sk-test", opencodeSessionId: `oc-${sessionId}` }
}

function makeLedger() {
  const rows: { event: string; cost_coins?: number; node_id?: string; signature?: string }[] = []
  return { rows, write: async (e: any) => { rows.push(e) } }
}

function fakeBridge(): import("./types.ts").ExecBridgeClient {
  return {
    async call() { return { ok: false, code: "bridge_unavailable", message: "test bridge", retryable: false } },
    async result() { return { state: "unknown" } },
  }
}

let artifactSeq = 0
/** 真产物（写盘→ctx.ingest→sha256）：复用判定要看文件还在且 sha 对得上。 */
async function makeOutput(ctx: ExecContext, extra: Partial<Output> = {}): Promise<Output> {
  const dir = join(process.env.WORKSPACE_DIR!, "projects", ctx.sessionId, "tmp")
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `fake-${++artifactSeq}-${ctx.node.id.replace(/#/g, "_")}-t${ctx.take}.png`)
  writeFileSync(file, `fake artifact ${artifactSeq} ${ctx.node.id} t${ctx.take} a${ctx.attempt}`)
  const out = await ctx.ingest({ path: file }, { port: "out", mime: "image/png", origin: "generated" })
  return { ...out, port: "out", ...(ctx.node.takes ? { take: ctx.take } : {}), ...extra }
}

interface Call { node: string; take: number; attempt: number; seed: number | undefined; nodeSeed: number | undefined }

function installExecutor(type: NodeType, opts: {
  estimate?: number | null
  calls: Call[]
  state?: { active: number; peak: number }
  delayMs?: number
  run: (ctx: ExecContext, callNo: number) => Promise<ExecResult> | ExecResult
}): NodeExecutor {
  const exec: NodeExecutor = {
    type,
    specVersion: 1,
    async estimate() { return opts.estimate === undefined ? 0 : opts.estimate },
    async run(ctx) {
      opts.calls.push({
        node: ctx.node.id, take: ctx.take, attempt: ctx.attempt,
        seed: ctx.params.seed as number | undefined,
        nodeSeed: ctx.node.params.seed as number | undefined,
      })
      const s = opts.state
      if (s) { s.active += 1; s.peak = Math.max(s.peak, s.active) }
      try {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
        return await opts.run(ctx, opts.calls.length)
      } finally {
        if (s) s.active -= 1
      }
    },
  }
  registerExecutor(exec)
  return exec
}

const okOne = (ctx: ExecContext): Promise<ExecResult> => makeOutput(ctx).then((out) => ({ ok: true, outputs: [out], costCoins: 0 }))

function depsFor(sessionId: string, extra: Record<string, unknown> = {}) {
  const ledger = makeLedger()
  const submitCalls: string[] = []
  const submit: (req: SubmitGenerationReq) => Promise<SubmitGenerationRes> = async (req) => {
    submitCalls.push(idempotencyKeyOf(req))
    return { ok: true, taskId: "task-1", urls: ["https://example.invalid/a.png"], costCoins: 1, requestId: idempotencyKeyOf(req), executedModel: "m" }
  }
  const deps = {
    session: makeSession(sessionId),
    ledger,
    submitGeneration: submit,
    execBridge: fakeBridge(),
    ...extra,
  }
  return { deps, ledger, submitCalls }
}

async function nodeOf(store: { read(): Promise<{ nodes: Record<string, ProjectNode> }> }, id: string) {
  return (await store.read()).nodes[id]
}

async function eventsOf(store: { log: { read(since?: number, limit?: number): Promise<ProjectEvent[]> } }): Promise<ProjectEvent[]> {
  return store.log.read(0, 100_000)
}

// ─────────────────────────────────────────────────────────────── 1. 命中节点 0 调用 + reused 事件/账本行
describe("复用（planRun 命中）", () => {
  test("第二次 run 不调执行器；node_reused 事件与 reused 账本行各 = 复用节点数，cost_coins=0", async () => {
    const calls: Call[] = []
    installExecutor("script", { calls, run: okOne })
    installExecutor("keyframe", { calls, run: okOne })
    const store = await makeProject("s6_reuse", [
      NODE("sc", "script", { params: { text: "剧本" } }),
      NODE("kf", "keyframe", { params: { prompt: "p", model: "m" }, inputs: { in: { from: "sc" } } }),
    ])
    const { deps, ledger } = depsFor("s6_reuse")

    const first = await runProject(store, deps)
    expect(first.status).toBe("done")
    expect(calls.length).toBe(2)

    const second = await runProject(store, deps)
    expect(second.status).toBe("done")
    expect(calls.length).toBe(2) // 命中节点 fake 调用数 = 0 增量

    const evs = await eventsOf(store)
    expect(evs.filter((e) => e.kind === "node_reused").map((e) => e.node).sort()).toEqual(["kf", "sc"])
    const reusedRows = ledger.rows.filter((r) => r.event === "reused")
    expect(reusedRows.length).toBe(2)
    expect(reusedRows.every((r) => r.cost_coins === 0)).toBe(true)
    expect((await nodeOf(store, "kf")).lastRun?.via).toBe("reused")
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────── 1b. 跨节点缓存索引
describe("缓存索引（§3.2 第 6 条）", () => {
  test("同签名的新节点命中 cache.json，不重复执行", async () => {
    const calls: Call[] = []
    installExecutor("keyframe", { calls, run: okOne })
    const store = await makeProject("s6_cache", [
      NODE("a", "keyframe", { params: { prompt: "same", model: "m" } }),
    ])
    const { deps } = depsFor("s6_cache")
    const first = await runProject(store, deps)
    expect(first.status).toBe("done")
    expect(calls.length).toBe(1)

    // 新节点 b：与 a 完全同参数、无依赖 → 同签名；缓存里有 a 的产出
    await store.update((g) => {
      const b = NODE("b", "keyframe", { params: { prompt: "same", model: "m" } })
      g.nodes.b = b
      g.order.push("b")
    })
    const second = await runProject(store, deps)
    expect(second.status).toBe("done")
    expect(calls.length).toBe(1) // b 走缓存，不调执行器
    const b = await nodeOf(store, "b")
    expect(b.status).toBe("done")
    expect(b.lastRun?.via).toBe("reused")
    expect(b.outputs.length).toBe(1)
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────── 2. 层内并发
describe("层内并发", () => {
  test("同层 3 个节点峰值=3；上限=2 时峰值=2（层宽受限）", async () => {
    const state = { active: 0, peak: 0 }
    const calls: Call[] = []
    installExecutor("keyframe", { calls, state, delayMs: 30, run: okOne })
    const store = await makeProject("s6_par", [
      NODE("a", "keyframe", { params: { prompt: "a", model: "m" } }),
      NODE("b", "keyframe", { params: { prompt: "b", model: "m" } }),
      NODE("c", "keyframe", { params: { prompt: "c", model: "m" } }),
      NODE("d", "keyframe", { params: { prompt: "d", model: "m" }, inputs: { in: { from: "a" } } }),
    ])
    const { deps } = depsFor("s6_par")
    const r = await runProject(store, deps)
    expect(r.status).toBe("done")
    expect(calls.length).toBe(4)
    expect(state.peak).toBe(3) // 层宽 3

    const state2 = { active: 0, peak: 0 }
    const calls2: Call[] = []
    installExecutor("keyframe", { calls: calls2, state: state2, delayMs: 30, run: okOne })
    const store2 = await makeProject("s6_par2", [
      NODE("a", "keyframe", { params: { prompt: "a", model: "m" } }),
      NODE("b", "keyframe", { params: { prompt: "b", model: "m" } }),
      NODE("c", "keyframe", { params: { prompt: "c", model: "m" } }),
    ])
    const d2 = depsFor("s6_par2")
    await runProject(store2, { ...d2.deps, concurrency: 2 })
    expect(calls2.length).toBe(3)
    expect(state2.peak).toBe(2)
  }, 30_000)
})

// ─────────────────────────────────────────────────────────────── 3. regenerate(max=2) 与种子
describe("onFail=regenerate", () => {
  test("max=2 → 执行器调用 1+2=3 次；种子=effectiveSeed(base, 0..2)", async () => {
    const calls: Call[] = []
    installExecutor("keyframe", {
      calls,
      run: async () => ({ ok: false, code: "provider_error", message: "boom", retryable: true }),
    })
    const store = await makeProject("s6_regen", [
      NODE("kf", "keyframe", {
        params: { prompt: "p", model: "m", seed: 100 },
        onFail: { action: "regenerate", max: 2, then: "fail" },
      }),
    ])
    const { deps } = depsFor("s6_regen")
    const r = await runProject(store, deps)
    expect(calls.length).toBe(3)
    expect(calls.map((c) => c.attempt)).toEqual([0, 1, 2])
    // take=0 → effectiveSeed = base + take*3 + retries = 100,101,102
    expect(calls.map((c) => c.seed)).toEqual([100, 101, 102])
    expect(calls.map((c) => c.nodeSeed)).toEqual([100, 101, 102]) // S7 执行器读 ctx.node.params（effectiveParams）
    expect(r.status).toBe("failed")
    expect((await nodeOf(store, "kf")).status).toBe("failed")
  }, 20_000)

  test("retryable===false 不重生：节点 failed，原因透传", async () => {
    const calls: Call[] = []
    installExecutor("keyframe", {
      calls,
      run: async () => ({ ok: false, code: "safety_blocked", message: "safety: blocked", retryable: false }),
    })
    const store = await makeProject("s6_noretry", [
      NODE("kf", "keyframe", {
        params: { prompt: "p", model: "m" },
        onFail: { action: "regenerate", max: 2, then: "skip" },
      }),
    ])
    const r = await runProject(store, depsFor("s6_noretry").deps)
    expect(calls.length).toBe(1)
    expect(r.status).toBe("failed")
    const node = await nodeOf(store, "kf")
    expect(node.status).toBe("failed")
    expect(node.error?.code).toBe("safety_blocked")
    expect(node.error?.message).toBe("safety: blocked")
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────── 4. takes 选优
describe("takes", () => {
  test("n=3 并发产出，select:qc 取分数最高的 take", async () => {
    const calls: Call[] = []
    const scores = [40, 90, 70]
    installExecutor("keyframe", {
      calls,
      run: async (ctx) => {
        const out = await makeOutput(ctx, { meta: { qcScore: scores[ctx.take] } })
        return { ok: true, outputs: [out], costCoins: 0 }
      },
    })
    const store = await makeProject("s6_takes", [
      NODE("kf", "keyframe", { params: { prompt: "p", model: "m" }, takes: { n: 3, select: "qc" } }),
    ])
    const { deps } = depsFor("s6_takes")
    const r = await runProject(store, deps)
    const node = await nodeOf(store, "kf")
    expect(r.status).toBe("done")
    expect(calls.length).toBe(3) // 同一签名 3 个候选
    expect(new Set(calls.map((c) => c.take))).toEqual(new Set([0, 1, 2]))
    expect(node.status).toBe("done")
    expect(node.takesPool?.length).toBe(3)
    expect(node.outputs.length).toBe(1)
    expect(node.outputs[0].take).toBe(1) // 90 分
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────── 5. 失败下游 blocked
describe("失败传播", () => {
  test("上游失败 → 下游 blocked 且下游执行器 0 调用", async () => {
    const calls: Call[] = []
    installExecutor("keyframe", {
      calls,
      run: async (ctx) => ctx.node.id === "a"
        ? { ok: false, code: "provider_error", message: "provider down", retryable: false }
        : okOne(ctx),
    })
    const store = await makeProject("s6_block", [
      NODE("a", "keyframe", { params: { prompt: "a", model: "m" } }),
      NODE("b", "keyframe", { params: { prompt: "b", model: "m" }, inputs: { in: { from: "a" } } }),
      NODE("c", "keyframe", { params: { prompt: "c", model: "m" }, inputs: { in: { from: "b" } } }),
    ])
    const { deps } = depsFor("s6_block")
    const r = await runProject(store, deps)
    expect(r.status).toBe("failed")
    expect(calls.map((c) => c.node)).toEqual(["a"])
    expect((await nodeOf(store, "b")).status).toBe("blocked")
    expect((await nodeOf(store, "c")).status).toBe("blocked")
    expect(r.blocked?.map((b) => b.node).sort()).toEqual(["b", "c"])
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────── 6. 重启恢复：同 idemKey
describe("崩溃恢复", () => {
  test("新 store 实例扫描在途节点 → 用同一 idemKey 重提交；第二次扫描不再提交", async () => {
    const calls: Call[] = []
    const submitCalls: string[] = []
    const submit: (req: SubmitGenerationReq) => Promise<SubmitGenerationRes> = async (req) => {
      const key = idempotencyKeyOf(req)
      submitCalls.push(key)
      return { ok: true, taskId: "task-r", urls: ["https://example.invalid/r.png"], costCoins: 1, requestId: key, executedModel: "m" }
    }
    installExecutor("keyframe", {
      calls,
      run: async (ctx) => {
        const res = await ctx.submitGeneration({
          kind: "image", model: "m", prompt: "p", projectId: ctx.project.id, nodeId: ctx.node.id,
          signature: ctx.signature, runId: ctx.runId, attempt: ctx.attempt, take: ctx.take,
          apiKey: "sk-test", sessionId: ctx.sessionId, signal: ctx.signal,
        })
        if (!res.ok) return { ok: false, code: res.code, message: res.message, retryable: res.retryable }
        return { ok: true, outputs: [await makeOutput(ctx)], costCoins: res.costCoins }
      },
    })
    const store = await makeProject("s6_recover", [
      NODE("kf", "keyframe", { params: { prompt: "p", model: "m" }, status: "running" }),
    ])
    const { computeSignature } = await import("./signature.ts")
    const { NODE_SPECS_LITE } = await import("./specs.ts")
    const sig = await computeSignature(await store.read(), "kf", store.artifacts, NODE_SPECS_LITE)
    expect(sig.ok).toBe(true)
    const key = idempotencyKeyOf({ projectId: "s6_recover", signature: (sig as { signature: string }).signature, take: 0, attempt: 0 })
    await store.update((g) => {
      g.nodes.kf.inflight = { idemKey: key, since: "2026-10-28T00:00:00.000Z" }
    })

    const reopened = await openProject("s6_recover")
    const { deps } = depsFor("s6_recover", { submitGeneration: submit })
    const out = await recoverProject(reopened, deps)
    expect(out.resumed.map((r) => r.result)).toEqual(["done"])
    expect(submitCalls).toEqual([key]) // 同一个 key，不是新 key
    expect((await nodeOf(reopened, "kf")).status).toBe("done")

    const again = await recoverProject(await openProject("s6_recover"), deps)
    expect(again.resumed.length).toBe(0)
    expect(submitCalls.length).toBe(1) // 不二次提交
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────── 6b. onFail=skip / ask_user
describe("onFail：skip / ask_user", () => {
  test("skip → 节点 skipped；下游 blocked(upstream skipped)，下游执行器 0 调用", async () => {
    const calls: Call[] = []
    installExecutor("keyframe", {
      calls,
      run: async (ctx) => ctx.node.id === "a"
        ? { ok: false, code: "provider_error", message: "boom", retryable: true }
        : okOne(ctx),
    })
    const store = await makeProject("s6_skip", [
      NODE("a", "keyframe", { params: { prompt: "a", model: "m" }, onFail: { action: "skip" } }),
      NODE("b", "keyframe", { params: { prompt: "b", model: "m" }, inputs: { in: { from: "a" } } }),
    ])
    const { deps } = depsFor("s6_skip")
    const r = await runProject(store, deps)
    expect((await nodeOf(store, "a")).status).toBe("skipped")
    expect(calls.map((c) => c.node)).toEqual(["a"])
    expect(r.status).toBe("partial")
    expect(r.blocked?.find((b) => b.node === "b")?.reason).toBe("upstream skipped: a")
  }, 20_000)

  test("ask_user → 不进 failed、返回 needs_user，整轮不等用户", async () => {
    const calls: Call[] = []
    installExecutor("keyframe", {
      calls,
      run: async () => ({ ok: false, code: "provider_error", message: "quota unclear", retryable: false }),
    })
    const store = await makeProject("s6_ask", [
      NODE("kf", "keyframe", { params: { prompt: "p", model: "m" }, onFail: { action: "ask_user" } }),
    ])
    const { deps } = depsFor("s6_ask")
    const r = await runProject(store, deps)
    expect(r.status).toBe("needs_user")
    expect(r.failed ?? []).toEqual([])
    expect(r.needsUser).toEqual(["kf"])
    const node = await nodeOf(store, "kf")
    expect(node.status).toBe("pending")
    expect(node.error?.code).toBe("ask_user")
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────── 6c. takes select:"user"
describe("takes：select user", () => {
  test("产出 n 个候选后返回等待状态；重跑不再生成；用户选定后交下游", async () => {
    const calls: Call[] = []
    installExecutor("keyframe", {
      calls,
      run: async (ctx) => {
        const out = await makeOutput(ctx)
        return { ok: true, outputs: [out], costCoins: 0 }
      },
    })
    const store = await makeProject("s6_takesuser", [
      NODE("kf", "keyframe", { params: { prompt: "p", model: "m" }, takes: { n: 2, select: "user" } }),
      NODE("kf2", "keyframe", { params: { prompt: "p2", model: "m" }, inputs: { in: { from: "kf" } } }),
    ])
    const { deps } = depsFor("s6_takesuser")
    const first = await runProject(store, deps)
    expect(first.status).toBe("needs_user")
    expect(calls.length).toBe(2)
    let node = await nodeOf(store, "kf")
    expect(node.status).toBe("pending")
    expect(node.takesPool?.length).toBe(2)
    expect(node.outputs.length).toBe(0)
    expect((await nodeOf(store, "kf2")).status).toBe("blocked")

    const second = await runProject(store, deps)
    expect(second.status).toBe("needs_user")
    expect(calls.length).toBe(2) // 不重复花钱

    // 用户 select_take：patch 的语义就是 outputs=takesPool.filter(take)
    await store.update((g) => {
      const n = g.nodes.kf
      n.outputs = structuredClone((n.takesPool ?? []).filter((o) => o.take === 1))
      n.status = "done"
    })
    const third = await runProject(store, deps)
    node = await nodeOf(store, "kf")
    expect(node.status).toBe("done")
    expect(calls.length).toBe(3) // 只多跑了下游 kf2；kf 没重生成
    expect(third.status).toBe("done")
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────── 7. 预算超限
describe("准入：预算", () => {
  test("报价超过工程 budget.capCoins → rejected 且给 reason，执行器 0 调用", async () => {
    const calls: Call[] = []
    installExecutor("keyframe", { calls, estimate: 2, run: okOne })
    const store = await makeProject("s6_budget", [
      NODE("kf", "keyframe", { params: { prompt: "p", model: "m" } }),
    ], { capCoins: 1 })
    const { deps } = depsFor("s6_budget")
    const r = await runProject(store, deps)
    expect(r.status).toBe("rejected")
    expect(r.reason).toContain("预算不足")
    expect(r.quote.coins).toBe(2)
    expect(calls.length).toBe(0)
    expect((await nodeOf(store, "kf")).status).toBe("pending")
  }, 20_000)

  test("S5 在途预留计入预算：已花+预留+报价 > cap → rejected", async () => {
    const calls: Call[] = []
    installExecutor("keyframe", { calls, estimate: 2, run: okOne })
    const store = await makeProject("s6_reserved", [
      NODE("kf", "keyframe", { params: { prompt: "p", model: "m" } }),
    ], { capCoins: 10 })
    await store.update((g) => { g.budget.spentCoins = 0 })
    const { deps } = depsFor("s6_reserved", {
      budget: { snapshot: () => ({ reserved: 9, spent: 0 }) },
    })
    const r = await runProject(store, deps)
    expect(r.status).toBe("rejected")
    expect(r.reason).toContain("在途预留 9")
    expect(calls.length).toBe(0)
  }, 20_000)

  test("价目缺失（estimate=null）→ rejected，原因点名节点", async () => {
    const calls: Call[] = []
    installExecutor("keyframe", { calls, estimate: null, run: okOne })
    const store = await makeProject("s6_noprice", [NODE("kf", "keyframe", { params: { prompt: "p", model: "m" } })])
    const { deps } = depsFor("s6_noprice")
    const r = await runProject(store, deps)
    expect(r.status).toBe("rejected")
    expect(r.reason).toContain("报不出价")
    expect(r.quote.unknownPrice).toEqual(["kf"])
    expect(calls.length).toBe(0)
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────── 8. 运行期间用户改参数 → stale
describe("运行期间改图", () => {
  test("结果照存（钱已花）、节点置 stale", async () => {
    const calls: Call[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    installExecutor("keyframe", {
      calls,
      run: async (ctx) => { await gate; return okOne(ctx) },
    })
    const store = await makeProject("s6_stale", [NODE("kf", "keyframe", { params: { prompt: "old", model: "m" } })])
    const { deps } = depsFor("s6_stale")
    const running = runProject(store, deps)
    for (let i = 0; i < 200 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
    expect(calls.length).toBe(1)
    await store.update((g) => { g.nodes.kf.params.prompt = "new" })
    release()
    const r = await running
    const node = await nodeOf(store, "kf")
    expect(r.status).toBe("done")
    expect(node.outputs.length).toBe(1) // 结果照存
    expect(node.status).toBe("stale")
    expect(node.lastRun?.via).toBe("executed")
  }, 20_000)

  test("运行中改参数：旧产物只登记在启动签名下，下一轮执行器拿到新参数", async () => {
    const prompts: string[] = []
    const calls: Call[] = []
    const store = await makeProject("s6_mid_sig", [NODE("k1", "keyframe", { params: { prompt: "OLD", model: "m", size: "1024x1024" } })])
    installExecutor("keyframe", {
      calls,
      run: async (ctx) => {
        prompts.push(String(ctx.node.params.prompt))
        if (prompts.length === 1) {
          await store.applyPatches({ ops: [{ op: "set", node: "k1", path: "params.prompt", value: "NEW" }] }, { kind: "user" })
        }
        return okOne(ctx)
      },
    })
    const { deps } = depsFor("s6_mid_sig")
    await runProject(store, deps)
    const g1 = await store.read()
    expect(g1.nodes.k1.status).toBe("stale")
    expect(g1.nodes.k1.params.prompt).toBe("NEW")
    const { computeSignature } = await import("./signature.ts")
    const { NODE_SPECS_LITE } = await import("./specs.ts")
    const post = await computeSignature(g1, "k1", store.artifacts, NODE_SPECS_LITE)
    expect(post.ok).toBe(true)
    if (post.ok) {
      expect(g1.nodes.k1.signature).not.toBe(post.signature)
      expect(g1.nodes.k1.lastRun?.signature).not.toBe(post.signature)
    }
    await runProject(store, deps)
    const g2 = await store.read()
    expect(prompts).toEqual(["OLD", "NEW"])
    expect(g2.nodes.k1.lastRun?.via).toBe("executed")
    expect(g2.nodes.k1.status).toBe("done")
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────── 9. 作者节点无内容
describe("作者节点（script/shotlist）", () => {
  test("无内容 → 节点 pending、下游 blocked(reason=awaiting author)、整轮不算失败", async () => {
    const calls: Call[] = []
    installExecutor("script", {
      calls,
      run: async () => ({ ok: false, code: "bad_input", message: "awaiting authored content", retryable: false }),
    })
    installExecutor("keyframe", { calls, run: okOne })
    const store = await makeProject("s6_author", [
      NODE("sc", "script", {}),
      NODE("kf", "keyframe", { params: { prompt: "p", model: "m" }, inputs: { in: { from: "sc" } } }),
    ])
    const { deps } = depsFor("s6_author")
    const r = await runProject(store, deps)
    expect(r.status).toBe("partial") // 不是 failed
    expect(r.failed ?? []).toEqual([])
    expect(r.awaitingAuthor).toEqual(["sc"])
    expect((await nodeOf(store, "sc")).status).toBe("pending")
    const kf = await nodeOf(store, "kf")
    expect(kf.status).toBe("blocked")
    expect(r.blocked?.find((b) => b.node === "kf")?.reason).toBe("awaiting author")
    expect(calls.map((c) => c.node)).toEqual(["sc"]) // 下游执行器 0 调用
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────── 10. dry_run
describe("准入：dry_run", () => {
  test("只报价不执行：status=quoted、执行器 0 调用", async () => {
    const calls: Call[] = []
    installExecutor("keyframe", { calls, estimate: 3, run: okOne })
    const store = await makeProject("s6_dry", [
      NODE("kf", "keyframe", { params: { prompt: "p", model: "m" } }),
      NODE("kf2", "keyframe", { params: { prompt: "p2", model: "m" } }),
    ])
    const { deps } = depsFor("s6_dry")
    const r = await runProject(store, { ...deps, concurrency: 1 }, { dry_run: true })
    expect(r.status).toBe("quoted")
    expect(r.quote.run).toBe(2)
    expect(r.quote.coins).toBe(6)
    expect(calls.length).toBe(0)
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────── 11. 确认阈值：非阻塞
describe("准入：确认", () => {
  test("sessionConfirmPort：登记 pendingConfirms + emit 一次 + 立即返回 pending（settleConfirm 语义、非阻塞）", async () => {
    const { sessionConfirmPort } = await import("./admission.ts")
    const pending = new Map<string, { timer: unknown; ledger?: { amount_coins: number } }>()
    const emitted: { name: string; data: unknown }[] = []
    const settled: string[] = []
    const port = sessionConfirmPort({
      state: { sessionId: "s6_port", pendingConfirms: pending },
      createEntry: ({ amountCoins }) => ({ timer: null, ledger: { amount_coins: amountCoins } }),
      emit: (name, data) => emitted.push({ name, data }),
      settle: (id) => { settled.push(id); return true },
      statusOf: (id) => (pending.has(id) ? "pending" : "unknown"),
      timeoutMs: 60_000,
    })
    const started = Date.now()
    const st = await port.request({ sessionId: "s6_port", requestId: "r1", amountCoins: 7, description: "d" })
    expect(st).toBe("pending")
    expect(Date.now() - started).toBeLessThan(1000) // 没有等任何用户答复
    expect([...pending.keys()]).toEqual(["r1"])
    expect(pending.get("r1")?.ledger?.amount_coins).toBe(7)
    expect(emitted.map((e) => e.name)).toEqual(["confirm.request"])
    expect(await port.status!("r1")).toBe("pending")
    expect(settled).toEqual([])
    // 清理定时器（测试进程不挂 15 分钟）
    clearTimeout(pending.get("r1")!.timer as ReturnType<typeof setTimeout>)
  })

  test("报价 ≥ 阈值且非 auto/full → needs_user + 确认卡登记一次，run 立即返回（不 await 用户）", async () => {
    const calls: Call[] = []
    installExecutor("keyframe", { calls, estimate: 6, run: okOne })
    const store = await makeProject("s6_confirm", [NODE("kf", "keyframe", { params: { prompt: "p", model: "m" } })])
    const requests: { requestId: string; amountCoins: number }[] = []
    const { deps } = depsFor("s6_confirm")
    const r = await runProject(store, deps, {
      confirmThreshold: 5,
      authorized: async () => false,
      confirm: {
        async request(a) { requests.push({ requestId: a.requestId, amountCoins: a.amountCoins }); return "pending" },
        async status() { return "pending" },
      },
    })
    expect(r.status).toBe("needs_user")
    expect(r.requestId).toBeTruthy()
    expect(requests.length).toBe(1)
    expect(requests[0].amountCoins).toBe(6)
    expect(calls.length).toBe(0) // 没批准 = 一币不烧
  }, 20_000)

  test("确认卡展示预计 x–y 币（含最多 k 次重生）；阈值仍比不含重生的底价", async () => {
    installExecutor("keyframe", { calls: [], estimate: 3, run: okOne })
    const store = await makeProject("s6_regen_quote", [
      NODE("kf", "keyframe", {
        params: { prompt: "p", model: "m" },
        takes: { n: 2, select: "first" },
        onFail: { action: "regenerate", max: 2, then: "fail" },
      }),
    ])
    const requests: { amountCoins: number; description: string }[] = []
    const { deps } = depsFor("s6_regen_quote")
    const r = await runProject(store, deps, {
      confirmThreshold: 5,
      authorized: async () => false,
      confirm: {
        async request(a) { requests.push({ amountCoins: a.amountCoins, description: a.description }); return "pending" },
        async status() { return "pending" },
      },
    })
    // 底价 = 3 × takes.n(2) = 6。最坏 = 6 × (1+max 2) = 18。k = 2。
    expect(r.quote.coins).toBe(6)
    expect(r.quote.coinsHigh).toBe(18)
    expect(r.quote.regenMax).toBe(2)
    expect(r.quote.rangeLabel).toBe("预计 6–18 币（含最多 2 次重生）")
    expect(r.status).toBe("needs_user")
    expect(requests).toHaveLength(1)
    expect(requests[0].amountCoins).toBe(6)
    expect(requests[0].description).toContain("预计 6–18 币（含最多 2 次重生）")
  }, 20_000)

  test("auto/full 授权直接放行；用户批准后重入也放行", async () => {
    const calls: Call[] = []
    installExecutor("keyframe", { calls, estimate: 6, run: okOne })
    const store = await makeProject("s6_auto", [NODE("kf", "keyframe", { params: { prompt: "p", model: "m" } })])
    const { deps } = depsFor("s6_auto")
    const auto = await runProject(store, deps, { confirmThreshold: 5, authorized: async () => true })
    expect(auto.status).toBe("done")
    expect(calls.length).toBe(1)

    const calls2: Call[] = []
    installExecutor("keyframe", { calls: calls2, estimate: 6, run: okOne })
    const store2 = await makeProject("s6_confirm2", [NODE("kf", "keyframe", { params: { prompt: "p", model: "m" } })])
    const d2 = depsFor("s6_confirm2")
    const approved = await runProject(store2, d2.deps, {
      confirmThreshold: 5,
      authorized: async () => false,
      confirm_request_id: "pgrun_test",
      confirm: { async request() { return "pending" }, async status() { return "approved" } },
    })
    expect(approved.status).toBe("done")
    expect(calls2.length).toBe(1)
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────── 12. loss / 图变不重投
describe("恢复：不换 key", () => {
  test("图已变（key 对不上）→ 不重投，标人工确认", async () => {
    const calls: Call[] = []
    const submitCalls: string[] = []
    installExecutor("keyframe", {
      calls,
      run: async (ctx) => {
        submitCalls.push(idempotencyKeyOf({ projectId: ctx.project.id, signature: ctx.signature, take: ctx.take, attempt: ctx.attempt }))
        return { ok: true, outputs: [await makeOutput(ctx)], costCoins: 0 }
      },
    })
    const store = await makeProject("s6_nokey", [
      NODE("kf", "keyframe", { params: { prompt: "p", model: "m" }, status: "running" }),
    ])
    await store.update((g) => {
      g.nodes.kf.inflight = { idemKey: "pg:s6_nokey:deadbeef:t0:a0", since: "2026-10-28T00:00:00.000Z" }
    })
    const { deps } = depsFor("s6_nokey")
    const reopened = await openProject("s6_nokey")
    const out = await recoverProject(reopened, deps)
    expect(out.manual).toEqual(["kf"])
    expect(calls.length).toBe(0)
    expect(submitCalls.length).toBe(0)
    expect((await nodeOf(reopened, "kf")).error?.code).toBe("recovery_manual")
  }, 20_000)

  test("lost（running 但没有 inflight）→ 置 pending 并交调用方重跑", async () => {
    const calls: Call[] = []
    installExecutor("keyframe", { calls, run: okOne })
    const store = await makeProject("s6_lost", [
      NODE("kf", "keyframe", { params: { prompt: "p", model: "m" }, status: "running" }),
    ])
    const { deps } = depsFor("s6_lost")
    const out = await recoverProject(store, deps)
    expect(out.rerun).toEqual(["kf"])
    expect((await nodeOf(store, "kf")).status).toBe("pending")

    const resumedRun = await runProject(store, deps, { resume: true })
    expect(resumedRun.status).toBe("done")
    expect(calls.length).toBe(1)
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────── 13. poll_task / confirm_unknown
describe("恢复：poll_task", () => {
  test("平台任务已失败 → 节点 failed（只读查询一次，不重投）", async () => {
    const calls: Call[] = []
    installExecutor("clip", { calls, run: okOne })
    const store = await makeProject("s6_poll", [
      NODE("v", "clip", { params: { prompt: "p", model: "m", seconds: 5 }, status: "running" }),
    ])
    await store.update((g) => {
      g.nodes.v.inflight = { idemKey: "pg:s6_poll:x:t0:a0", taskId: "task-v", since: "2026-10-28T00:00:00.000Z" }
    })
    const queried: string[] = []
    const { deps } = depsFor("s6_poll", {
      queryTask: {
        async query(a: { kind: string; taskId: string }) {
          queried.push(`${a.kind}:${a.taskId}`)
          return { state: "failed", message: "upstream failed" }
        },
      },
    })
    const out = await recoverProject(await openProject("s6_poll"), deps)
    expect(queried).toEqual(["video:task-v"])
    expect(out.resumed.map((r) => r.result)).toEqual(["failed"])
    const node = await nodeOf(await openProject("s6_poll"), "v")
    expect(node.status).toBe("failed")
    expect(calls.length).toBe(0)
  }, 20_000)
})

describe("恢复：confirm_unknown", () => {
  test("exec-bridge 报 done → 用 result(idemKey) 取回文件并入库；报 unknown → 保持 running 不重投", async () => {
    const calls: Call[] = []
    installExecutor("music", { calls, run: okOne })
    const store = await makeProject("s6_unknown", [
      NODE("m1", "music", { params: { prompt: "score" }, status: "running" }),
      NODE("m2", "music", { params: { prompt: "score2" }, status: "running" }),
    ])
    const dir = join(projectDirFor("s6_unknown"), "tmp")
    mkdirSync(dir, { recursive: true })
    const doneFile = join(dir, "music.mp3")
    writeFileSync(doneFile, "fake mp3 bytes")
    const asked: string[] = []
    const bridge = {
      async call() { return { ok: false as const, code: "bridge_unavailable" as const, message: "no", retryable: false } },
      async result(idemKey: string) {
        asked.push(idemKey)
        if (idemKey === "k-done") return { state: "done" as const, files: [{ path: doneFile, mime: "audio/mpeg", bytes: 14 }], costCoins: 1 }
        return { state: "unknown" as const }
      },
    }
    await store.update((g) => {
      g.nodes.m1.inflight = { idemKey: "k-done", since: "2026-10-28T00:00:00.000Z", submitUnknown: true }
      g.nodes.m2.inflight = { idemKey: "k-unknown", since: "2026-10-28T00:00:01.000Z", submitUnknown: true }
    })
    const { deps } = depsFor("s6_unknown", { execBridge: bridge })
    const reopened = await openProject("s6_unknown")
    const out = await recoverProject(reopened, deps)
    expect(asked.sort()).toEqual(["k-done", "k-unknown"])
    const m1 = (await reopened.read()).nodes.m1
    expect(m1.status).toBe("done")
    expect(m1.outputs.length).toBe(1)
    expect(m1.outputs[0].mime).toBe("audio/mpeg")
    const m2 = (await reopened.read()).nodes.m2
    expect(m2.status).toBe("running") // 真相未明：不宣判、不重投
    expect(out.resumed.find((r) => r.node === "m2")?.result).toBe("running")
    expect(calls.length).toBe(0)
  }, 20_000)

  test("提交时签名与当前 prompt 不一致：产物留下，节点 stale，planRun 判 toRun", async () => {
    const store = await makeProject("s6_rec_stale", [
      NODE("m1", "music", { params: { prompt: "旧：悲伤钢琴" }, status: "running" }),
    ])
    const { computeSignature, planRun } = await import("./signature.ts")
    const { NODE_SPECS_LITE } = await import("./specs.ts")
    const g0 = await store.read()
    const oldSig = await computeSignature(g0, "m1", store.artifacts, NODE_SPECS_LITE)
    expect(oldSig.ok).toBe(true)
    if (!oldSig.ok) return
    const inf = { idemKey: `pg:s6_rec_stale:${oldSig.signature.slice(0, 40)}:t0:a0`, since: "2026-10-28T00:00:00.000Z", submitUnknown: true as const }
    await store.update((g) => { g.nodes.m1.inflight = Object.assign(inf, { sig: oldSig.signature }) })
    const edited = await store.applyPatches({ ops: [{ op: "set", node: "m1", path: "params.prompt", value: "新：欢快鼓点" }] }, { kind: "user" })
    expect(edited.receipt.ok).toBe(true)
    const dir = join(projectDirFor("s6_rec_stale"), "tmp")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "old.mp3")
    writeFileSync(file, "OLD-PROMPT-AUDIO")
    const { deps } = depsFor("s6_rec_stale", {
      execBridge: {
        async call() { return { ok: false as const, code: "bridge_unavailable" as const, message: "no", retryable: false } },
        async result() { return { state: "done" as const, files: [{ path: file, mime: "audio/mpeg", bytes: 16 }], costCoins: 1 } },
      },
    })
    await recoverProject(await openProject("s6_rec_stale"), deps)
    const reopened = await openProject("s6_rec_stale")
    const g = await reopened.read()
    expect(g.nodes.m1.status).toBe("stale")
    expect(g.nodes.m1.outputs.length).toBeGreaterThan(0)
    const cur = await computeSignature(g, "m1", reopened.artifacts, NODE_SPECS_LITE)
    expect(cur.ok).toBe(true)
    if (cur.ok) expect(g.nodes.m1.lastRun?.signature).not.toBe(cur.signature)
    const plan = await planRun(g, undefined, "incremental", reopened.artifacts, NODE_SPECS_LITE)
    expect(plan.toRun).toContain("m1")
    expect(plan.reuse).not.toContain("m1")
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────── 14. plan.unknown（保守视为要跑）
describe("planRun 的 unknown 节点", () => {
  test("content 模式下游签名未知 → 仍然入队执行（干跑报价也算它）", async () => {
    const calls: Call[] = []
    installExecutor("keyframe", { calls, estimate: 1, run: okOne })
    installExecutor("reference", { calls, estimate: 1, run: okOne })
    const store = await makeProject("s6_unknown_plan", [
      NODE("kf", "keyframe", { params: { prompt: "p", model: "m" } }),
    ])
    // reference 的签名指纹 = params.artifactId 的内容 sha：必须是真产物，否则签名 unstable（S1 语义）
    const srcDir = join(projectDirFor("s6_unknown_plan"), "tmp")
    mkdirSync(srcDir, { recursive: true })
    const src = join(srcDir, "ref-src.png")
    writeFileSync(src, "reference bytes")
    const refArt = await store.putArtifact({ path: src }, { port: "out", mime: "image/png", origin: "user" })
    await store.update((g) => {
      const n = NODE("ref", "reference", { params: { source: "upload", artifactId: refArt.artifactId } })
      n.params.source = "${kf}"
      g.nodes.ref = n
      g.order.push("ref")
    })
    const { deps } = depsFor("s6_unknown_plan")
    const dry = await runProject(store, deps, { dry_run: true })
    expect(dry.status).toBe("quoted")
    expect(dry.quote.run).toBe(2)
    expect(dry.quote.coins).toBe(2)

    const r = await runProject(store, deps)
    expect(r.status).toBe("done")
    expect(calls.map((c) => c.node).sort()).toEqual(["kf", "ref"])
    expect((await nodeOf(store, "ref")).status).toBe("done")
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────── 14b. 并发双跑
describe("并发保护", () => {
  test("同一个工程同时只允许一轮 run（第二个入口 rejected，不双扣费）", async () => {
    const calls: Call[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    installExecutor("keyframe", { calls, run: async (ctx) => { await gate; return okOne(ctx) } })
    const store = await makeProject("s6_double", [NODE("kf", "keyframe", { params: { prompt: "p", model: "m" } })])
    const { deps } = depsFor("s6_double")
    const first = runProject(store, deps)
    for (let i = 0; i < 200 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
    const second = await runProject(store, deps)
    expect(second.status).toBe("rejected")
    expect(second.reason).toContain("已经在跑")
    expect(calls.length).toBe(1)
    release()
    expect((await first).status).toBe("done")
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────── 15. submit_unknown 冻结
describe("submit_unknown", () => {
  test("不当作失败、不重试（即使 onFail=regenerate）、保持 running+inflight 交恢复核对", async () => {
    const calls: Call[] = []
    installExecutor("keyframe", {
      calls,
      run: async (ctx) => {
        const res = await ctx.submitGeneration({
          kind: "image", model: "m", prompt: "p", projectId: ctx.project.id, nodeId: ctx.node.id,
          signature: ctx.signature, runId: ctx.runId, attempt: ctx.attempt, take: ctx.take,
          apiKey: "sk-test", sessionId: ctx.sessionId, signal: ctx.signal,
        })
        if (res.ok) return { ok: true, outputs: [await makeOutput(ctx)], costCoins: 0 }
        return { ok: false, code: res.code, message: res.message, retryable: false, ...(res.submitUnknown ? { submitUnknown: true } : {}) }
      },
    })
    const store = await makeProject("s6_unknown_submit", [
      NODE("kf", "keyframe", {
        params: { prompt: "p", model: "m" },
        onFail: { action: "regenerate", max: 2, then: "fail" },
      }),
    ])
    const { deps } = depsFor("s6_unknown_submit", {
      submitGeneration: async () => ({ ok: false, code: "submit_unknown", message: "network cut", submitUnknown: true, retryable: false }),
    })
    const r = await runProject(store, deps)
    expect(calls.length).toBe(1) // 绝不盲重投
    expect(r.status).toBe("partial") // 不宣判失败
    expect(r.failed ?? []).toEqual([])
    expect(r.inFlightUnknown).toEqual(["kf"])
    const node = await nodeOf(store, "kf")
    expect(node.status).toBe("running")
    expect(node.inflight?.submitUnknown).toBe(true)
    expect(node.error?.code).toBe("submit_unknown")
  }, 20_000)

  test("任一 take 为 submit_unknown 则整轮冻结：其它 take 不重生，inflight 记下全部 key", async () => {
    const seen: { take: number; attempt: number }[] = []
    installExecutor("keyframe", {
      calls: [],
      run: async (ctx) => {
        seen.push({ take: ctx.take, attempt: ctx.attempt })
        if (ctx.take === 0) return { ok: false, code: "provider_error", message: "boom", retryable: true }
        return { ok: false, code: "submit_unknown", message: "cut", retryable: false, submitUnknown: true }
      },
    })
    const store = await makeProject("s6_multi_unknown", [
      NODE("kf", "keyframe", {
        params: { prompt: "p", model: "m" },
        takes: { n: 2, select: "first" },
        onFail: { action: "regenerate", max: 2, then: "fail" },
      }),
    ])
    const { deps } = depsFor("s6_multi_unknown")
    const r = await runProject(store, deps)
    expect(seen).toHaveLength(2)
    expect(seen.map((s) => s.take).sort()).toEqual([0, 1])
    expect(seen.every((s) => s.attempt === 0)).toBe(true)
    expect(r.inFlightUnknown).toEqual(["kf"])
    expect(r.failed ?? []).toEqual([])
    const node = await nodeOf(store, "kf")
    expect(node.status).toBe("running")
    expect(node.inflight?.submitUnknown).toBe(true)
    const keys = (node.inflight as { keys?: string[] } | undefined)?.keys ?? []
    expect(keys).toHaveLength(2)
    expect(keys.some((k) => k.endsWith(":t0:a0"))).toBe(true)
    expect(keys.some((k) => k.endsWith(":t1:a0"))).toBe(true)
  }, 20_000)

  test("两个 take 都成功时各跑一次并完成，不因为冻结逻辑少跑", async () => {
    const seen: number[] = []
    installExecutor("keyframe", {
      calls: [],
      run: async (ctx) => {
        seen.push(ctx.take)
        return { ok: true, outputs: [await makeOutput(ctx)], costCoins: 0 }
      },
    })
    const store = await makeProject("s6_multi_ok", [
      NODE("kf", "keyframe", {
        params: { prompt: "p", model: "m" },
        takes: { n: 2, select: "first" },
        onFail: { action: "regenerate", max: 2, then: "fail" },
      }),
    ])
    const { deps } = depsFor("s6_multi_ok")
    const r = await runProject(store, deps)
    expect(r.status).toBe("done")
    expect(seen.sort()).toEqual([0, 1])
    expect((await nodeOf(store, "kf")).status).toBe("done")
  }, 20_000)

  test("恢复续上 inflight.keys 里的每个 take，无 sig 的单 key 旧记录仍只续那一把", async () => {
    const seen: number[] = []
    installExecutor("keyframe", {
      calls: [],
      run: async (ctx) => {
        seen.push(ctx.take)
        return { ok: true, outputs: [await makeOutput(ctx)], costCoins: 0 }
      },
    })
    const store = await makeProject("s6_resume_keys", [
      NODE("kf", "keyframe", { params: { prompt: "p", model: "m" }, status: "running", takes: { n: 2, select: "first" } }),
    ])
    const { computeSignature } = await import("./signature.ts")
    const { NODE_SPECS_LITE } = await import("./specs.ts")
    const g0 = await store.read()
    const sig = await computeSignature(g0, "kf", store.artifacts, NODE_SPECS_LITE)
    expect(sig.ok).toBe(true)
    if (!sig.ok) return
    const keys = [0, 1].map((take) => idempotencyKeyOf({ projectId: g0.id, signature: sig.signature, take, attempt: 0 }))
    await store.update((g) => {
      g.nodes.kf.inflight = Object.assign({ idemKey: keys[0], since: "2026-10-28T00:00:00.000Z" }, { sig: sig.signature, keys })
    })
    const { deps } = depsFor("s6_resume_keys")
    const out = await recoverProject(await openProject("s6_resume_keys"), deps)
    expect(seen.sort()).toEqual([0, 1])
    expect(out.resumed[0]?.result).toBe("done")

    const seenOld: number[] = []
    installExecutor("keyframe", {
      calls: [],
      run: async (ctx) => {
        seenOld.push(ctx.take)
        return { ok: true, outputs: [await makeOutput(ctx)], costCoins: 0 }
      },
    })
    const old = await makeProject("s6_resume_oldkey", [
      NODE("kf", "keyframe", { params: { prompt: "p", model: "m" }, status: "running" }),
    ])
    const gOld = await old.read()
    const oldSig = await computeSignature(gOld, "kf", old.artifacts, NODE_SPECS_LITE)
    expect(oldSig.ok).toBe(true)
    if (!oldSig.ok) return
    const oldKey = idempotencyKeyOf({ projectId: gOld.id, signature: oldSig.signature, take: 0, attempt: 0 })
    await old.update((g) => {
      g.nodes.kf.inflight = { idemKey: oldKey, since: "2026-10-28T00:00:00.000Z" }
    })
    const oldDeps = depsFor("s6_resume_oldkey")
    const oldOut = await recoverProject(await openProject("s6_resume_oldkey"), oldDeps.deps)
    expect(seenOld).toEqual([0])
    expect(oldOut.manual).toEqual([])
    expect(oldOut.resumed[0]?.result).toBe("done")
  }, 20_000)
})
