// I6（设计文档 §8 第六行）：改一个节点只重跑它与下游；pinned 不动且进 drift。
//
// 独立期望来源 = 本档按拓扑**手写**的集合（3 镜图：kf2 → clip2 → timeline → subtitle/mix → export → qc），
// fake 执行器按 node 计调用数；不读 planRun 的输出当期望。
// 双侧：其余节点 reused 事件与 reused 账本行齐全（5 个）。
import "./fixtures/env"
import "./fixtures/fake-platform"
import { beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const { registerExecutor, clearExecutors } = await import("../executor-registry.ts")
const { ensureProject } = await import("../store.ts")
const { runProject } = await import("../run.ts")

type Call = { node: string; take: number; attempt: number }
let calls: Call[] = []
let artifactSeq = 0

function rawNode(id: string, type: string, params: Record<string, unknown>, inputs: Record<string, { from: string }>) {
  return {
    id, type, intent: "", params, inputs, refs: [], pinned: null,
    status: "pending", signature: null, lastRun: null, outputs: [], rev: 1,
  }
}

async function makeOutput(ctx: any): Promise<any> {
  const dir = join(process.env.WORKSPACE_DIR!, "projects", ctx.sessionId, "tmp")
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `i6-${++artifactSeq}-${ctx.node.id.replace(/#/g, "_")}.bin`)
  writeFileSync(file, `artifact ${artifactSeq} ${ctx.node.id}`)
  const out = await ctx.ingest({ path: file }, { port: "out", mime: "application/octet-stream", origin: "generated" })
  return { ...out, port: "out" }
}

function installFakes(): void {
  const types = ["shotlist", "keyframe", "clip", "music", "timeline", "subtitle", "mix", "export", "qc"]
  for (const type of types) {
    registerExecutor({
      type,
      specVersion: 1,
      async estimate() { return 0 },
      async run(ctx: any) {
        calls.push({ node: ctx.node.id, take: ctx.take, attempt: ctx.attempt })
        return { ok: true, outputs: [await makeOutput(ctx)], costCoins: 0 }
      },
    } as never)
  }
}

beforeEach(() => {
  calls = []
  clearExecutors()
  installFakes()
})

function makeDeps(sessionId: string) {
  const ledger: any[] = []
  const deps = {
    session: { sessionId, apiKey: "sk-i6-test-only", opencodeSessionId: `oc-${sessionId}` },
    ledger: { write: async (e: any) => { ledger.push(e) } },
    submitGeneration: async () => ({ ok: false, code: "bad_input" as const, message: "unused", retryable: false }),
    execBridge: {
      call: async () => ({ ok: false, code: "bridge_unavailable" as const, message: "unused", retryable: false }),
      result: async () => ({ state: "unknown" as const }),
    },
  }
  return { deps, ledger }
}

/** 3 镜图：改 kf2 的 prompt 期望重跑集合 = 手写的 7 个节点。 */
const EXPECTED_RERUN = ["clip2", "export", "kf2", "mix", "qc", "subtitle", "timeline"].sort()
/** 其余未 pinned 节点必须 reused。 */
const EXPECTED_REUSE = ["clip3", "kf1", "kf3", "music", "shotlist"].sort()

async function makeThreeShotProject(sessionId: string) {
  const { store } = await ensureProject(sessionId)
  await store.update((g: any) => {
    const nodes = [
      rawNode("shotlist", "shotlist", { kind: "shots", rows: [{ id: "shot1" }, { id: "shot2" }, { id: "shot3" }] }, {}),
      rawNode("kf1", "keyframe", { prompt: "镜 1", model: "m", size: "1024x1024" }, {}),
      rawNode("kf2", "keyframe", { prompt: "镜 2", model: "m", size: "1024x1024" }, {}),
      rawNode("kf3", "keyframe", { prompt: "镜 3", model: "m", size: "1024x1024" }, {}),
      rawNode("clip1", "clip", { prompt: "镜 1 动", model: "m", seconds: 5 }, { first_frame: { from: "kf1" } }),
      rawNode("clip2", "clip", { prompt: "镜 2 动", model: "m", seconds: 5 }, { first_frame: { from: "kf2" } }),
      rawNode("clip3", "clip", { prompt: "镜 3 动", model: "m", seconds: 5 }, { first_frame: { from: "kf3" } }),
      rawNode("music", "music", { prompt: "轻柔钢琴" }, {}),
      rawNode("timeline", "timeline", {}, { clip1: { from: "clip1" }, clip2: { from: "clip2" }, clip3: { from: "clip3" } }),
      rawNode("subtitle", "subtitle", {}, { timeline: { from: "timeline" } }),
      rawNode("mix", "mix", {}, { timeline: { from: "timeline" }, music: { from: "music" } }),
      rawNode("export", "export", { preset: "mp4" }, { mix: { from: "mix" } }),
      rawNode("qc", "qc", { mode: "machine" }, { export: { from: "export" } }),
    ]
    for (const node of nodes) {
      g.nodes[node.id] = node
      g.order.push(node.id)
    }
  })
  return store
}

describe("I6 增量重跑与 pinned", () => {
  test("改 kf2：只重跑手写的 7 个节点；其余 5 个 reused 事件与账本行齐全", async () => {
    const sessionId = "s18_i6_three_shot"
    const store = await makeThreeShotProject(sessionId)
    const { deps, ledger } = makeDeps(sessionId)

    const first = await runProject(store, deps)
    expect(first.status).toBe("done")
    expect(new Set(calls.map((c) => c.node)).size).toBe(13)

    // 人手钉住 shot1 的片段。
    const pinned = await store.applyPatches({ ops: [{ op: "pin", node: "clip1", reason: "用户钉住第一镜" }] as never }, { kind: "user" })
    expect(pinned.receipt.ok).toBe(true)
    expect(pinned.receipt.rejected).toEqual([])
    const before = await store.read()
    expect(before.nodes.clip1.pinned?.by).toBe("user")

    calls = []
    ledger.length = 0
    const changed = await store.applyPatches(
      { ops: [{ op: "set", node: "kf2", path: "params.prompt", value: "镜 2：改成雨夜" }] as never },
      { kind: "user" },
    )
    expect(changed.receipt.ok).toBe(true)
    expect(changed.receipt.rejected).toEqual([])

    const second = await runProject(store, deps)
    expect(second.status).toBe("done")

    const ran = [...new Set(calls.map((c) => c.node))].sort()
    expect(ran).toEqual(EXPECTED_RERUN)
    // pinned 的 clip1 一次都没调执行器。
    expect(ran).not.toContain("clip1")
    expect(ran).not.toContain("kf1")

    const events = await store.log.read(0, 100_000)
    const reusedNow = events.filter((e: any) => e.kind === "node_reused").map((e: any) => e.node).sort()
    expect(reusedNow).toEqual(EXPECTED_REUSE)
    const reusedRows = ledger.filter((r) => r.event === "reused")
    expect(reusedRows.map((r) => r.node_id).sort()).toEqual(EXPECTED_REUSE)
    for (const row of reusedRows) expect(row.cost_coins).toBe(0)
    // 13 节点 = 7 重跑 + 5 复用 + 1 pinned。
    expect(EXPECTED_RERUN.length + EXPECTED_REUSE.length + 1).toBe(13)
  }, 30_000)

  test("pinned clip1 在上游 kf1 变化后不重跑、并出现在 drift", async () => {
    const sessionId = "s18_i6_drift"
    const store = await makeThreeShotProject(sessionId)
    const { deps } = makeDeps(sessionId)
    expect((await runProject(store, deps)).status).toBe("done")
    await store.applyPatches({ ops: [{ op: "pin", node: "clip1", reason: "钉住" }] as never }, { kind: "user" })
    // 基线：pin 本身会改变下游读取方式（pinned 当叶子），先让签名落定。
    expect((await runProject(store, deps)).status).toBe("done")
    const baselineRunId = (await store.read()).nodes.clip1.lastRun?.runId
    expect(typeof baselineRunId).toBe("string")

    calls = []
    const patched = await store.applyPatches(
      { ops: [{ op: "set", node: "kf1", path: "params.prompt", value: "镜 1：改成清晨" }] as never },
      { kind: "user" },
    )
    expect(patched.receipt.ok).toBe(true)
    expect(patched.receipt.drift).toContain("clip1")
    // drift 事件也落了（可被 project_get 复盘）。
    expect(patched.events.some((e: any) => e.kind === "pin_drift" && e.node === "clip1")).toBe(true)

    const run = await runProject(store, deps)
    expect(run.status).toBe("done")
    const ran = [...new Set(calls.map((c) => c.node))]
    expect(ran).toEqual(["kf1"])
    expect(ran).not.toContain("clip1")

    const after = await store.read()
    expect(after.nodes.clip1.pinned?.by).toBe("user")
    // 第三轮里 clip1 的产物与上次运行记录都没被改写（pin 保护）。
    expect(after.nodes.clip1.lastRun?.runId).toBe(baselineRunId)
  }, 30_000)

  test("force 重跑 k1 换产物后，下一轮只重跑下游 c1", async () => {
    const sessionId = "s18_i6_force"
    const { store } = await ensureProject(sessionId)
    await store.update((g: any) => {
      for (const node of [
        rawNode("k1", "keyframe", { prompt: "猫", model: "m", size: "1024x1024" }, {}),
        rawNode("c1", "clip", { prompt: "跑", model: "m", seconds: 5 }, { first: { from: "k1" } }),
        rawNode("k2", "keyframe", { prompt: "狗", model: "m", size: "1024x1024" }, {}),
        rawNode("c2", "clip", { prompt: "坐", model: "m", seconds: 5 }, { first: { from: "k2" } }),
      ]) { g.nodes[node.id] = node; g.order.push(node.id) }
    })
    const { deps } = makeDeps(sessionId)
    expect((await runProject(store, deps)).status).toBe("done")
    calls = []
    expect((await runProject(store, deps, { targets: ["k1"], mode: "force" })).status).toBe("done")
    expect(calls.map((c) => c.node)).toEqual(["k1"])
    calls = []
    expect((await runProject(store, deps)).status).toBe("done")
    expect([...new Set(calls.map((c) => c.node))].sort()).toEqual(["c1"])
  }, 30_000)

  test("k1 产物文件丢失后，k1 与 c1 重跑，k2 不跑", async () => {
    const sessionId = "s18_i6_missing"
    const { store } = await ensureProject(sessionId)
    await store.update((g: any) => {
      for (const node of [
        rawNode("k1", "keyframe", { prompt: "猫", model: "m", size: "1024x1024" }, {}),
        rawNode("c1", "clip", { prompt: "跑", model: "m", seconds: 5 }, { first: { from: "k1" } }),
        rawNode("k2", "keyframe", { prompt: "狗", model: "m", size: "1024x1024" }, {}),
      ]) { g.nodes[node.id] = node; g.order.push(node.id) }
    })
    const { deps } = makeDeps(sessionId)
    expect((await runProject(store, deps)).status).toBe("done")
    const path = (await store.read()).nodes.k1.outputs[0].path
    unlinkSync(path)
    calls = []
    expect((await runProject(store, deps)).status).toBe("done")
    expect([...new Set(calls.map((c) => c.node))].sort()).toEqual(["c1", "k1"])
  }, 30_000)

  test("运行中把 k1 prompt 从 OLD 改成 NEW：第二轮执行器拿到 NEW，且是 executed", async () => {
    const sessionId = "s18_i6_midrun"
    const prompts: string[] = []
    let store: Awaited<ReturnType<typeof ensureProject>>["store"]
    clearExecutors()
    registerExecutor({
      type: "keyframe", specVersion: 1,
      async estimate() { return 0 },
      async run(ctx: any) {
        prompts.push(ctx.node.params.prompt)
        calls.push({ node: ctx.node.id, take: ctx.take, attempt: ctx.attempt })
        if (prompts.length === 1) {
          await store.applyPatches({ ops: [{ op: "set", node: "k1", path: "params.prompt", value: "NEW" }] }, { kind: "user" })
        }
        return { ok: true, outputs: [await makeOutput(ctx)], costCoins: 0 }
      },
    } as never)
    store = (await ensureProject(sessionId)).store
    await store.update((g: any) => {
      const node = rawNode("k1", "keyframe", { prompt: "OLD", model: "m", size: "1024x1024" }, {})
      g.nodes.k1 = node
      g.order.push("k1")
    })
    const { deps } = makeDeps(sessionId)
    await runProject(store, deps)
    expect((await store.read()).nodes.k1.status).toBe("stale")
    await runProject(store, deps)
    expect(prompts).toEqual(["OLD", "NEW"])
    expect((await store.read()).nodes.k1.lastRun?.via).toBe("executed")
  }, 30_000)

  test("恢复时 inflight 签名与改过的 prompt 不一致：music 节点 stale 且下一轮会跑", async () => {
    const sessionId = "s18_i6_recover"
    const { store } = await ensureProject(sessionId)
    await store.update((g: any) => {
      const node = rawNode("m1", "music", { prompt: "旧：悲伤钢琴" }, {})
      node.status = "running"
      g.nodes.m1 = node
      g.order.push("m1")
    })
    const { computeSignature, planRun } = await import("../signature.ts")
    const { NODE_SPECS_LITE } = await import("../specs.ts")
    const { recoverProject } = await import("../recovery.ts")
    const g0 = await store.read()
    const oldSig = await computeSignature(g0, "m1", store.artifacts, NODE_SPECS_LITE)
    expect(oldSig.ok).toBe(true)
    if (!oldSig.ok) return
    const inf = { idemKey: `pg:${sessionId}:${oldSig.signature.slice(0, 40)}:t0:a0`, since: "2026-10-28T00:00:00.000Z", submitUnknown: true }
    await store.update((g: any) => { g.nodes.m1.inflight = Object.assign(inf, { sig: oldSig.signature }) })
    expect((await store.applyPatches({ ops: [{ op: "set", node: "m1", path: "params.prompt", value: "新：欢快鼓点" }] }, { kind: "user" })).receipt.ok).toBe(true)
    const dir = join(process.env.WORKSPACE_DIR!, "projects", sessionId, "tmp")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "old.mp3")
    writeFileSync(file, "OLD-PROMPT-AUDIO")
    const { deps } = makeDeps(sessionId)
    deps.execBridge = {
      call: async () => ({ ok: false, code: "bridge_unavailable", message: "no", retryable: false }),
      result: async () => ({ state: "done", files: [{ path: file, mime: "audio/mpeg", bytes: 16 }], costCoins: 1 }),
    } as never
    await recoverProject(store, deps as never)
    const g = await store.read()
    expect(g.nodes.m1.status).toBe("stale")
    expect(g.nodes.m1.outputs.length).toBeGreaterThan(0)
    const plan = await planRun(g, undefined, "incremental", store.artifacts, NODE_SPECS_LITE)
    expect(plan.toRun).toContain("m1")
    expect(plan.reuse).not.toContain("m1")
  }, 30_000)

  test("反例：把 kf2 的改动误算成下游闭包时，期望集合必须报错（防把「重跑一切」当通过）", () => {
    const actual = ["kf2", "clip2", "timeline", "subtitle", "mix", "export", "qc", "kf1"].sort()
    expect(() => {
      if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_RERUN)) throw new Error("重跑集合与拓扑手写集合不一致")
    }).toThrow(/不一致/)
  })
})
