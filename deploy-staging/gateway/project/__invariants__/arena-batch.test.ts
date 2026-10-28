import "./fixtures/env"
import { expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const { registerExecutor, clearExecutors } = await import("../executor-registry.ts")
const { ensureProject } = await import("../store.ts")
const { runProject } = await import("../run.ts")
const { recoverProject } = await import("../recovery.ts")
const { appendBriefEntry } = await import("../brief.ts")
const { checkExportArtifacts } = await import("../gates.ts")

type Scene = { id: string; goal: string; correction: string; shot3: string }
type Fault = "timeout" | "bad_file" | "gateway_restart" | "user_changes_mind" | "leave_and_return"
type Row = { event?: string; node_id?: string; signature?: string; cost_coins?: number }

const FAULTS: Fault[] = ["timeout", "bad_file", "gateway_restart", "user_changes_mind", "leave_and_return"]
const SEEDS = [
  "婚礼晚宴歌单，四小时，长辈占一半，不放分手和离世",
  "月亮代表我的心改成 City Pop，先不要生成",
  "晨时梳妆，15 秒，四镜，窗棂光束",
  "古风酒楼，12 秒，中景切特写",
]
/** 手写期望：kf3 的 prompt 一变，只重跑它和下游。不读 planRun。 */
const KF3_RERUN = ["clip3", "export", "kf3", "mix", "qc", "subtitle", "timeline"]

const scenes = JSON.parse(readFileSync(new URL("./fixtures/scenes.json", import.meta.url), "utf8")) as Scene[]

type Live = { fault: Fault; calls: { node: string }[] }
const live = new Map<string, Live>()
let artifactSeq = 0

function rawNode(id: string, type: string, params: Record<string, unknown>, inputs: Record<string, { from: string }>) {
  return {
    id, type, intent: "", params, inputs, refs: [], pinned: null,
    status: "pending", signature: null, lastRun: null, outputs: [], rev: 1,
  }
}

function artifactFile(ctx: { sessionId: string; node: { id: string } }, name: string): string {
  const dir = join(process.env.WORKSPACE_DIR!, "projects", ctx.sessionId, "tmp")
  mkdirSync(dir, { recursive: true })
  return join(dir, `${name}-${++artifactSeq}-${ctx.node.id}.bin`)
}

async function charge(ctx: any, event: "submitted" | "completed"): Promise<void> {
  await ctx.ledger.write({
    event,
    cost_coins: 1,
    project_id: ctx.sessionId,
    node_id: ctx.node.id,
    signature: ctx.signature,
    run_id: ctx.runId,
    attempt: ctx.attempt,
  })
}

async function makeOutput(ctx: any): Promise<any> {
  const file = artifactFile(ctx, "out")
  writeFileSync(file, `artifact ${artifactSeq} ${ctx.node.id}`)
  const out = await ctx.ingest({ path: file }, { port: "out", mime: "application/octet-stream", origin: "generated" })
  return { ...out, port: "out" }
}

function installFakes(): void {
  const types = ["shotlist", "keyframe", "clip", "timeline", "subtitle", "mix", "export", "qc"]
  for (const type of types) {
    registerExecutor({
      type,
      specVersion: 1,
      async estimate() { return 0 },
      async run(ctx: any) {
        const st = live.get(ctx.sessionId)
        if (!st) throw new Error(`没有这场的状态：${ctx.sessionId}`)
        st.calls.push({ node: ctx.node.id })
        if (st.fault === "timeout" && ctx.node.id === "kf3") {
          await charge(ctx, "submitted")
          throw new Error("timeout")
        }
        if (st.fault === "bad_file" && ctx.node.id === "export") {
          const file = artifactFile(ctx, "export-0000")
          writeFileSync(file, "0000")
          const out = await ctx.ingest({ path: file }, { port: "out", mime: "video/mp4", origin: "generated" })
          await charge(ctx, "completed")
          return { ok: true, outputs: [{ ...out, port: "out" }], costCoins: 0 }
        }
        await charge(ctx, "completed")
        return { ok: true, outputs: [await makeOutput(ctx)], costCoins: 0 }
      },
    } as never)
  }
}

function makeDeps(sessionId: string, ledger: Row[]) {
  return {
    session: { sessionId, apiKey: "sk-arena-test-only", opencodeSessionId: `oc-${sessionId}` },
    ledger: { write: async (e: Row) => { ledger.push(e) } },
    submitGeneration: async () => ({ ok: false, code: "bad_input" as const, message: "unused", retryable: false }),
    execBridge: {
      call: async () => ({ ok: false, code: "bridge_unavailable" as const, message: "unused", retryable: false }),
      result: async () => ({ state: "unknown" as const }),
    },
  }
}

function chargesOf(rows: Row[], nodeId?: string): Row[] {
  return rows.filter((r) =>
    (r.event === "submitted" || r.event === "completed")
    && Number(r.cost_coins) > 0
    && (nodeId === undefined || r.node_id === nodeId))
}

function duplicateCharges(rows: Row[]): string[] {
  const n = new Map<string, number>()
  for (const r of chargesOf(rows)) {
    const k = `${r.node_id}|${r.signature}`
    n.set(k, (n.get(k) ?? 0) + 1)
  }
  return [...n.entries()].filter(([, c]) => c > 1).map(([k, c]) => `${k}×${c}`)
}

function doneCount(g: any): number {
  return Object.values(g.nodes).filter((n: any) => n.status === "done").length
}

function goalInBrief(g: any, goal: string): boolean {
  return Array.isArray(g.brief) && g.brief.some((b: any) => typeof b.text === "string" && b.text.includes(goal))
}

async function makeThreeShotProject(sessionId: string, scene: Scene) {
  const { store } = await ensureProject(sessionId)
  await store.update((g: any) => {
    const entry = appendBriefEntry(g.brief, {
      at: "2026-10-29T00:00:00.000Z",
      messageId: `goal-${sessionId}`,
      text: scene.goal,
    })
    if (!entry) throw new Error("goal 没有写入 brief")
    const nodes = [
      rawNode("shotlist", "shotlist", { kind: "shots", rows: [{ id: "shot1" }, { id: "shot2" }, { id: "shot3" }] }, {}),
      rawNode("kf1", "keyframe", { prompt: "镜 1", model: "m", size: "1024x1024" }, {}),
      rawNode("kf2", "keyframe", { prompt: "镜 2", model: "m", size: "1024x1024" }, {}),
      rawNode("kf3", "keyframe", { prompt: scene.shot3, model: "m", size: "1024x1024" }, {}),
      rawNode("clip1", "clip", { prompt: "镜 1 动", model: "m", seconds: 5 }, { first_frame: { from: "kf1" } }),
      rawNode("clip2", "clip", { prompt: "镜 2 动", model: "m", seconds: 5 }, { first_frame: { from: "kf2" } }),
      rawNode("clip3", "clip", { prompt: "镜 3 动", model: "m", seconds: 5 }, { first_frame: { from: "kf3" } }),
      rawNode("timeline", "timeline", {}, { clip1: { from: "clip1" }, clip2: { from: "clip2" }, clip3: { from: "clip3" } }),
      rawNode("subtitle", "subtitle", {}, { timeline: { from: "timeline" } }),
      rawNode("mix", "mix", {}, { timeline: { from: "timeline" } }),
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

function sessionIdOf(scene: Scene, fault: Fault): string {
  const code = { timeout: "t", bad_file: "b", gateway_restart: "g", user_changes_mind: "u", leave_and_return: "l" }[fault]
  return `ab-${scene.id}-${code}`
}

function runLabel(run: any): string {
  return `status=${run?.status} reason=${run?.reason ?? ""} failed=${(run?.failed ?? []).join(",")}`
}

async function runScenario(scene: Scene, fault: Fault): Promise<void> {
  const sessionId = sessionIdOf(scene, fault)
  const ledger: Row[] = []
  const st: Live = { fault, calls: [] }
  live.set(sessionId, st)
  try {
    const deps = makeDeps(sessionId, ledger)
    let store = await makeThreeShotProject(sessionId, scene)
    const built = await store.read()
    if (!goalInBrief(built, scene.goal)) throw new Error("建图后 brief 不含 goal 原文")

    if (fault === "timeout") {
      const run = await runProject(store, deps)
      engineCalls++
      const g = await store.read()
      const kf3Calls = st.calls.filter((c) => c.node === "kf3")
      if (kf3Calls.length !== 1) throw new Error(`kf3 调用 ${kf3Calls.length} 次，不应自动再跑`)
      if (g.nodes.kf3.status !== "failed") throw new Error(`kf3 应失败，实际 ${g.nodes.kf3.status} ${runLabel(run)}`)
      if (g.nodes.kf3.status === "done") throw new Error("超时被自动跑成成功")
      const kf3Charges = chargesOf(ledger, "kf3")
      if (kf3Charges.length !== 1) throw new Error(`kf3 扣费 ${kf3Charges.length} 条，应正好 1`)
    } else if (fault === "bad_file") {
      const run = await runProject(store, deps)
      engineCalls++
      if (run.status !== "done") throw new Error(`bad_file 跑图失败 ${runLabel(run)}`)
      const g = await store.read()
      const outs = g.nodes.export?.outputs ?? []
      if (outs.length === 0) throw new Error("export 没有产物，交付检查没有文件可看")
      const buf = readFileSync(outs[0].path)
      if (buf.length !== 4 || buf.toString("utf8") !== "0000") {
        throw new Error(`export 写出的不是 4 字节 0000：len=${buf.length} hex=${buf.toString("hex")}`)
      }
      const gate = await checkExportArtifacts(outs)
      if (gate.ok) throw new Error("GATE_IGNORES_0000")
      const badIds = gate.checks.filter((c) => !c.ok).map((c) => c.id)
      if (!badIds.includes("decodable") && !badIds.includes("duration")) {
        throw new Error(`GATE_IGNORES_0000 没看文件内容，失败项=${badIds.join(",") || "无"}`)
      }
    } else if (fault === "gateway_restart") {
      const first = await runProject(store, deps, { targets: ["kf1"] })
      engineCalls++
      if (first.status !== "done") throw new Error(`kf1 没跑完 ${runLabel(first)}`)
      const before = await store.read()
      if (before.nodes.kf1.status !== "done") throw new Error(`kf1 未 done：${before.nodes.kf1.status}`)
      const doneBefore = doneCount(before)
      const sig = chargesOf(ledger, "kf1")[0]?.signature
      if (!sig) throw new Error("kf1 没有扣费签名")
      if (chargesOf(ledger, "kf1").filter((r) => r.signature === sig).length !== 1) throw new Error("kf1 首跑扣费不是 1")
      store = null as never
      const opened = await ensureProject(sessionId)
      if (opened.created) throw new Error("重启后 ensureProject 当成新建")
      await recoverProject(opened.store, deps)
      engineCalls++
      const mid = await opened.store.read()
      if (mid.nodes.kf1.status !== "done") throw new Error(`重启后 kf1 变成 ${mid.nodes.kf1.status}`)
      if (doneCount(mid) < doneBefore) throw new Error(`重启后 done ${doneCount(mid)} < ${doneBefore}`)
      if (chargesOf(ledger, "kf1").filter((r) => r.signature === sig).length !== 1) throw new Error("重启给 kf1 又记了一笔同样签名")
      st.calls = []
      const second = await runProject(opened.store, deps)
      engineCalls++
      if (second.status !== "done") throw new Error(`重启后续跑失败 ${runLabel(second)}`)
      const after = await opened.store.read()
      if (after.nodes.kf1.status !== "done") throw new Error(`续跑后 kf1 变成 ${after.nodes.kf1.status}`)
      if (doneCount(after) < doneBefore) throw new Error("续跑后 done 变少")
      if (st.calls.some((c) => c.node === "kf1")) throw new Error("已 done 的 kf1 被再执行")
      if (chargesOf(ledger, "kf1").filter((r) => r.signature === sig).length !== 1) throw new Error("续跑又扣了 kf1 同一签名")
      if (!goalInBrief(after, scene.goal)) throw new Error("重启后 brief 丢了 goal 原文")
    } else if (fault === "user_changes_mind") {
      const first = await runProject(store, deps)
      engineCalls++
      if (first.status !== "done") throw new Error(`第一轮失败 ${runLabel(first)}`)
      await store.update((g: any) => {
        const entry = appendBriefEntry(g.brief, {
          at: "2026-10-29T00:00:01.000Z",
          messageId: `corr-${sessionId}`,
          text: scene.correction,
        })
        if (!entry) throw new Error("correction 没有写入 brief")
      })
      const patched = await store.applyPatches(
        { ops: [{ op: "set", node: "kf3", path: "params.prompt", value: scene.correction }] as never },
        { kind: "user" },
      )
      if (!patched.receipt.ok || patched.receipt.rejected.length) {
        throw new Error(`kf3 prompt 没改上：${JSON.stringify(patched.receipt.rejected)}`)
      }
      st.calls = []
      const second = await runProject(store, deps)
      engineCalls++
      if (second.status !== "done") throw new Error(`第二轮失败 ${runLabel(second)}`)
      const ran = [...new Set(st.calls.map((c) => c.node))].sort()
      if (JSON.stringify(ran) !== JSON.stringify(KF3_RERUN)) {
        throw new Error(`重跑集合与手写不一致：${ran.join(",")}`)
      }
      const after = await store.read()
      if (!goalInBrief(after, scene.goal)) throw new Error("改口后 brief 丢了 goal 原文")
      if (!goalInBrief(after, scene.correction)) throw new Error("brief 没有 correction 原文")
    } else {
      const run = await runProject(store, deps)
      engineCalls++
      if (run.status !== "done") throw new Error(`离开前没跑完 ${runLabel(run)}`)
      const before = await store.read()
      const ids = Object.keys(before.nodes).sort()
      const doneBefore = doneCount(before)
      if (!goalInBrief(before, scene.goal)) throw new Error("离开前 brief 不含 goal")
      store = null as never
      const opened = await ensureProject(sessionId)
      if (opened.created) throw new Error("回来时 ensureProject 当成新建")
      const after = await opened.store.read()
      if (JSON.stringify(Object.keys(after.nodes).sort()) !== JSON.stringify(ids)) throw new Error("回来后节点 id 变了")
      if (doneCount(after) < doneBefore) throw new Error(`回来后 done ${doneCount(after)} < ${doneBefore}`)
      if (!goalInBrief(after, scene.goal)) throw new Error("回来后 brief 不含 goal 原文")
    }

    const dup = duplicateCharges(ledger)
    if (dup.length) throw new Error(`重复扣费 ${dup.join(";")}`)
  } finally {
    live.delete(sessionId)
  }
}

let engineCalls = 0

function assertScenes(list: Scene[]): void {
  if (list.length !== 120) throw new Error(`场景 ${list.length}，不是 120`)
  if (new Set(list.map((s) => s.id)).size !== 120) throw new Error("场景 id 重复")
  const layer = (p: string) => list.filter((s) => s.id.startsWith(p)).length
  if (layer("f-") !== 48 || layer("i-") !== 36 || layer("m-") !== 24 || layer("e-") !== 12) {
    throw new Error(`分层 f=${layer("f-")} i=${layer("i-")} m=${layer("m-")} e=${layer("e-")}`)
  }
  for (const seed of SEEDS) {
    if (!list.some((s) => s.goal.includes(seed))) throw new Error(`缺种子：${seed}`)
  }
  const topics = ["婚礼晚宴歌单", "月亮代表我的心", "晨时梳妆", "古风酒楼"]
  for (const s of list) {
    if (!s.goal || !s.correction || !s.shot3) throw new Error(`字段空：${s.id}`)
    if (!s.correction.includes("第 3 镜重拍")) throw new Error(`correction 缺重拍：${s.id}`)
    if (s.correction === s.shot3) throw new Error(`correction 与 shot3 相同：${s.id}`)
    if (!topics.some((t) => s.goal.includes(t))) throw new Error(`换题了：${s.id}`)
    if (!/(\d+\s*秒|\d+\s*分钟|小时|不要生成|不放|16:9|9:16|1:1|4:3|3:4|21:9)/.test(s.goal)) {
      throw new Error(`goal 没有可核对硬约束：${s.id}`)
    }
  }
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (stop) return
      const i = next++
      if (i >= items.length) return
      await fn(items[i])
    }
  })
  await Promise.all(workers)
}

let stop = false

test("甲层 120 脚本 × 5 故障 = 600 局，打到 runProject / recoverProject", async () => {
  assertScenes(scenes)
  clearExecutors()
  installFakes()
  const fails: { fault: Fault; id: string; message: string }[] = []
  let ok = 0
  const jobs = scenes.flatMap((scene) => FAULTS.map((fault) => ({ scene, fault })))
  expect(jobs.length).toBe(600)
  const t0 = Date.now()
  await pool(jobs, 8, async (job) => {
    if (stop) return
    try {
      await runScenario(job.scene, job.fault)
      ok++
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      fails.push({ fault: job.fault, id: job.scene.id, message })
      if (message.includes("GATE_IGNORES_0000")) stop = true
    }
  })
  const seconds = (Date.now() - t0) / 1000
  const by: Record<Fault, number> = { timeout: 0, bad_file: 0, gateway_restart: 0, user_changes_mind: 0, leave_and_return: 0 }
  for (const f of fails) by[f.fault]++
  console.log(JSON.stringify({ scenes: scenes.length, ok, fail: fails.length, by, engineCalls, seconds: Number(seconds.toFixed(2)), stopped: stop }))
  if (stop) {
    throw new Error(`现有 checkExportArtifacts 不把 4 字节 0000 当失败，停手不改闸。${fails.find((f) => f.message.includes("GATE_IGNORES_0000"))?.message ?? ""}`)
  }
  if (fails.length) {
    const sample = fails.slice(0, 12).map((f) => `${f.fault} ${f.id}: ${f.message}`).join("\n")
    throw new Error(`失败 ${fails.length}/600 ${JSON.stringify(by)}\n${sample}`)
  }
  expect(ok).toBe(600)
  expect(engineCalls).toBeGreaterThanOrEqual(600)
  expect(seconds).toBeLessThan(180)
}, 180_000)
