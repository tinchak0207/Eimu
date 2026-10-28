// S2 补丁引擎判准测试（设计文档 §3.1/§3.4/§3.5，S0 契约夹具）。
// 期望值独立于实现：16 种 op 的语义来自 §3 契约；错误码来自 contract-fixtures.json 的 (graph, op) 对；
// pin 边界来自 §3.5 的 7 条规则；回执上限来自 LIMITS.PATCH_RECEIPT_BYTES。
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fixturesJson from "./contract-fixtures.json"
import { applyPatch } from "./patch.ts"
import { utf8Bytes } from "./receipt.ts"
import type { Actor, NodeType, Output, PatchErrorCode, PatchOp, PatchRequest, ProjectGraph, ProjectNode } from "./types.ts"
import type { PatchEngineOptions } from "./patch.ts"

const NOW = new Date("2026-10-28T00:00:00.000Z")
const now = () => NOW

// ───────────────────────────── 夹具：产物库、节点、图 ─────────────────────────────

class FakeArtifacts {
  readonly items = new Map<string, Output>()
  seed(o: Output): Output {
    this.items.set(o.artifactId, o)
    return o
  }
  async get(id: string): Promise<Output | null> {
    return this.items.get(id) ?? null
  }
  async putBytes(bytes: Uint8Array | string, hint: { port: string; origin: Output["origin"]; mime?: string }): Promise<Output> {
    const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf-8") : Buffer.from(bytes)
    const sha = createHash("sha256").update(buf).digest("hex")
    const o: Output = {
      port: hint.port,
      artifactId: "art_" + sha.slice(0, 16),
      sha256: sha,
      path: `/fake/${sha}`,
      mime: hint.mime ?? "application/octet-stream",
      bytes: buf.length,
      origin: hint.origin,
    }
    this.items.set(o.artifactId, o)
    return o
  }
}

const artifacts = new FakeArtifacts()
artifacts.seed({ port: "out", artifactId: "art_dddddddddddddddd", sha256: "d".repeat(64), path: "/fake/d", mime: "image/png", bytes: 10, origin: "user" })

let artSeq = 0
function out(port = "out", extra: Partial<Output> = {}): Output {
  artSeq++
  const n = artSeq
  return {
    port,
    artifactId: "art_" + String(n).padStart(16, "0"),
    sha256: String(n % 10).repeat(64),
    path: `/fake/${n}`,
    mime: "image/png",
    bytes: 100 + n,
    origin: "generated",
    ...extra,
  }
}

function node(id: string, type: NodeType, over: Partial<ProjectNode> = {}): ProjectNode {
  return { id, type, intent: "", params: {}, inputs: {}, refs: [], pinned: null, status: "done", signature: null, lastRun: null, outputs: [], rev: 1, ...over }
}

function graph(nodes: ProjectNode[], over: Partial<ProjectGraph> = {}): ProjectGraph {
  return {
    schema: 1,
    id: "sess_t",
    sessionId: "sess_t",
    version: 0,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    brief: [],
    decisions: [],
    targets: null,
    defaults: {},
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    order: nodes.map((n) => n.id),
    budget: { capCoins: null, spentCoins: 0, savedCoins: 0 },
    activeRun: null,
    seq: 0,
    ...over,
  }
}

const AGENT: Actor = { kind: "agent" }
const USER: Actor = { kind: "user" }

async function apply(g: ProjectGraph, ops: PatchOp[], actor: Actor = AGENT, extra: Partial<PatchEngineOptions> = {}) {
  const req: PatchRequest = { ops }
  return applyPatch(g, req, actor, { now, artifacts, ...extra })
}

const codeOf = (r: Awaited<ReturnType<typeof apply>>): PatchErrorCode | null => (r.receipt.ok ? null : (r.receipt.rejected[0]?.code ?? null))

test("set path=budget.capCoins 写入图级硬预算，不锁节点、不把已完成节点打成 stale", async () => {
  const g = graph([node("k1", "keyframe", { params: { prompt: "keep", model: "m" }, status: "done" })])
  const r = await apply(g, [{ op: "set", node: "k1", path: "budget.capCoins", value: 4 }])
  expect(r.receipt.ok).toBe(true)
  expect(r.graph.budget.capCoins).toBe(4)
  expect(r.graph.nodes.k1.status).toBe("done")
  expect(r.graph.nodes.k1.params.prompt).toBe("keep")
  expect(r.graph.nodes.k1.locked).toBeUndefined()
  const cleared = await apply(r.graph, [{ op: "set", node: "k1", path: "budget.capCoins", value: null }])
  expect(cleared.graph.budget.capCoins).toBeNull()
  const bad = await apply(g, [{ op: "set", node: "k1", path: "budget.capCoins", value: -1 }])
  expect(codeOf(bad)).toBe("BAD_VALUE")
  expect(bad.graph.budget.capCoins).toBeNull()
})

// ───────────────────────────── 1) 16 种 PatchOp 语义 ─────────────────────────────

describe("16 种 PatchOp 语义（§3 契约）", () => {
  test("add_node：建节点、进 order、默认值/seed 落进 params（§3.5 + S3 materializeDefaults）", async () => {
    const g = graph([node("r1", "reference", { params: { source: "upload", artifactId: "art_dddddddddddddddd" } })], { defaults: { imageModel: "m-img", style: "film" } })
    const r = await apply(g, [{ op: "add_node", node: { id: "k1", type: "keyframe", intent: "首帧", params: { prompt: "咖啡" } } }])
    expect(r.receipt.ok).toBe(true)
    expect(r.committed).toBe(true)
    const k1 = r.graph.nodes.k1
    expect(k1.intent).toBe("首帧")
    expect(k1.params.prompt).toBe("咖啡")
    expect(k1.params.model).toBe("m-img") // 工程 defaults 物化
    expect(k1.params.styleLock).toBe("film")
    expect(k1.params.size).toBe("1024x1024") // 硬默认
    expect(typeof k1.params.seed).toBe("number") // seeded 类型补 hash(nodeId)
    expect(r.graph.order).toContain("k1")
    expect(r.receipt.changed).toEqual([{ node: "k1", fields: ["add"] }])
  })

  test("set：intent / params.<k>，rev 自增", async () => {
    const g = graph([node("k1", "keyframe", { params: { prompt: "a", seed: 1 } })])
    const r = await apply(g, [
      { op: "set", node: "k1", path: "intent", value: "改说明" },
      { op: "set", node: "k1", path: "params.prompt", value: "b" },
    ])
    expect(r.receipt.ok).toBe(true)
    expect(r.graph.nodes.k1.intent).toBe("改说明")
    expect(r.graph.nodes.k1.params.prompt).toBe("b")
    expect(r.graph.nodes.k1.rev).toBe(3)
    expect(g.nodes.k1.rev).toBe(1) // 输入图不被修改
  })

  test("remove_node：删节点、出 order", async () => {
    const g = graph([node("k1", "keyframe"), node("k2", "keyframe")])
    const r = await apply(g, [{ op: "remove_node", node: "k1" }])
    expect(r.receipt.ok).toBe(true)
    expect(r.graph.nodes.k1).toBeUndefined()
    expect(r.graph.order).toEqual(["k2"])
  })

  test("connect：建边（带 port），rev 自增", async () => {
    const g = graph([node("r1", "reference", { outputs: [out()] }), node("k1", "keyframe")])
    const r = await apply(g, [{ op: "connect", to: "k1", input: "ref", from: "r1", port: "out" }])
    expect(r.receipt.ok).toBe(true)
    expect(r.graph.nodes.k1.inputs).toEqual({ ref: { from: "r1", port: "out" } })
    expect(r.graph.nodes.k1.rev).toBe(2)
  })

  test("disconnect：删边", async () => {
    const g = graph([node("r1", "reference"), node("k1", "keyframe", { inputs: { ref: { from: "r1" } } })])
    const r = await apply(g, [{ op: "disconnect", to: "k1", input: "ref" }])
    expect(r.receipt.ok).toBe(true)
    expect(r.graph.nodes.k1.inputs).toEqual({})
  })

  test("lock / unlock：字段级作者锁；锁只约束 agent（patchForExisting 语义）", async () => {
    const g = graph([node("k1", "keyframe", { params: { prompt: "a" } })])
    const locked = await apply(g, [{ op: "lock", node: "k1", fields: ["params.prompt"] }])
    expect(locked.receipt.ok).toBe(true)
    expect(locked.graph.nodes.k1.locked).toEqual({ by: "agent", fields: ["params.prompt"], at: NOW.toISOString() })

    const blocked = await apply(locked.graph, [{ op: "set", node: "k1", path: "params.prompt", value: "b" }])
    expect(codeOf(blocked)).toBe("LOCKED")
    expect(blocked.graph.nodes.k1.params.prompt).toBe("a")

    const human = await apply(locked.graph, [{ op: "set", node: "k1", path: "params.prompt", value: "b" }], USER)
    expect(human.receipt.ok).toBe(true)
    expect(human.graph.nodes.k1.params.prompt).toBe("b")

    const unlocked = await apply(locked.graph, [{ op: "unlock", node: "k1" }])
    expect(unlocked.receipt.ok).toBe(true)
    expect(unlocked.graph.nodes.k1.locked).toBeUndefined()
  })

  test("pin / unpin：冻结全部输出口；pin 后的状态回到 done", async () => {
    const o1 = out("out")
    const o2 = out("srt")
    const g = graph([node("s1", "subtitle", { status: "pending", outputs: [o1, o2] })])
    const pinned = await apply(g, [{ op: "pin", node: "s1", reason: "客户确认" }])
    expect(pinned.receipt.ok).toBe(true)
    expect(pinned.graph.nodes.s1.pinned?.by).toBe("agent")
    expect(pinned.graph.nodes.s1.pinned?.reason).toBe("客户确认")
    expect(pinned.graph.nodes.s1.pinned?.outputsSha).toEqual([o1.sha256, o2.sha256])
    expect(pinned.graph.nodes.s1.status).toBe("done")

    const unpinned = await apply(pinned.graph, [{ op: "unpin", node: "s1" }])
    expect(unpinned.receipt.ok).toBe(true)
    expect(unpinned.graph.nodes.s1.pinned).toBeNull()
  })

  test("replace_output：仅 user；自动 pin(origin:user)，旧 out 口被替换", async () => {
    const old = out("out")
    const keep = out("srt")
    const g = graph([node("k1", "keyframe", { outputs: [old, keep] })])
    const r = await apply(g, [{ op: "replace_output", node: "k1", artifactId: "art_dddddddddddddddd" }], USER)
    expect(r.receipt.ok).toBe(true)
    const n = r.graph.nodes.k1
    expect(n.outputs.map((o) => o.port)).toEqual(["out", "srt"])
    expect(n.outputs[0].artifactId).toBe("art_dddddddddddddddd")
    expect(n.outputs[0].origin).toBe("user")
    expect(n.outputs[1].sha256).toBe(keep.sha256)
    expect(n.pinned?.by).toBe("user")
    expect(n.pinned?.outputsSha).toEqual(n.outputs.map((o) => o.sha256))
    expect(n.lastRun?.via).toBe("pinned")
    expect(n.status).toBe("done")
    expect(r.events.some((e) => e.kind === "node_output")).toBe(true)
  })

  test("select_take：换被选中的候选（未 pinned）", async () => {
    const t0 = out("out", { take: 0 })
    const t1 = out("out", { take: 1 })
    const g = graph([node("k1", "keyframe", { takes: { n: 2, select: "user" }, takesPool: [t0, t1], outputs: [t0] })])
    const r = await apply(g, [{ op: "select_take", node: "k1", take: 1 }])
    expect(r.receipt.ok).toBe(true)
    expect(r.graph.nodes.k1.outputs.map((o) => o.sha256)).toEqual([t1.sha256])
    expect(r.graph.nodes.k1.status).toBe("done")
  })

  test("reroll：只改 params.seed（+1），rev 自增", async () => {
    const g = graph([node("k1", "keyframe", { params: { seed: 41 } })])
    const r = await apply(g, [{ op: "reroll", node: "k1" }])
    expect(r.receipt.ok).toBe(true)
    expect(r.graph.nodes.k1.params.seed).toBe(42)
    expect(r.graph.nodes.k1.rev).toBe(2)
  })

  test("write_result：script 落 params.text + 产物；shotlist 落 rows；qc verdict 只许 critic lane", async () => {
    const g = graph([
      node("s1", "script", { params: { text: "旧" } }),
      node("sl", "shotlist", { params: { kind: "shots", rows: [{ id: "a" }] } }),
      node("q1", "qc", { params: { mode: "critic" } }),
    ])
    const forged = await apply(g, [{ op: "write_result", node: "q1", value: { pass: true, score: 8.5, deficiencies: [] } }])
    expect(forged.receipt.ok).toBe(false)
    expect(forged.receipt.rejected[0]?.code).toBe("LANE_VIOLATION")
    expect(forged.graph.nodes.q1.outputs).toHaveLength(0)
    const r = await apply(g, [
      { op: "write_result", node: "s1", value: { text: "新剧本" } },
      { op: "write_result", node: "sl", value: { kind: "shots", rows: [{ id: "s1", action: "推镜" }] } },
    ])
    expect(r.receipt.ok).toBe(true)
    expect(r.graph.nodes.s1.params.text).toBe("新剧本")
    expect(r.graph.nodes.s1.outputs[0].sha256).toBe(createHash("sha256").update("新剧本").digest("hex"))
    expect(r.graph.nodes.sl.params.rows).toEqual([{ id: "s1", action: "推镜" }])
    const critic: Actor = { kind: "subagent", runId: "critic", lane: ["q1"] }
    const wrote = await apply(r.graph, [{ op: "write_result", node: "q1", value: { pass: true, score: 8.5, deficiencies: [] } }], critic)
    expect(wrote.receipt.ok).toBe(true)
    expect(wrote.graph.nodes.q1.outputs[0].mime).toBe("application/json")
    expect(r.graph.nodes.s1.status).toBe("done")
  })

  test("set_targets：记录 setBy=actor 与时间", async () => {
    const g = graph([])
    const r = await apply(g, [{ op: "set_targets", targets: { durationSec: 15, aspect: "16:9", audio: "both" } }])
    expect(r.receipt.ok).toBe(true)
    expect(r.graph.targets).toEqual({ durationSec: 15, aspect: "16:9", audio: "both", setBy: AGENT, at: NOW.toISOString() })
  })

  test("set_defaults：合并而非整份替换", async () => {
    const g = graph([], { defaults: { imageModel: "m1", style: "film" } })
    const r = await apply(g, [{ op: "set_defaults", defaults: { videoModel: "v1" } }])
    expect(r.receipt.ok).toBe(true)
    expect(r.graph.defaults).toEqual({ imageModel: "m1", style: "film", videoModel: "v1" })
  })

  test("apply_recipe：配方节点整批落图（任一失败整份丢弃），templateId 记录", async () => {
    const recipe = {
      id: "fake_recipe",
      title: "假配方",
      build: () => ({ nodes: [{ id: "kf_a", type: "keyframe" as NodeType, params: { prompt: "p" } }, { id: "cl_a", type: "clip" as NodeType, params: { prompt: "q", model: "v1" } }] }),
      legacyRoleMap: {},
    }
    const r = await apply(graph([]), [{ op: "apply_recipe", recipe: "fake_recipe", params: {} }], AGENT, { recipes: (id) => (id === "fake_recipe" ? (recipe as never) : undefined) })
    expect(r.receipt.ok).toBe(true)
    expect(Object.keys(r.graph.nodes).sort()).toEqual(["cl_a", "kf_a"])
    expect(r.graph.templateId).toBe("fake_recipe")
  })
})

// ───────────────────────────── 2) PatchErrorCode 每个至少一例（S0 夹具真跑） ─────────────────────────────

interface Fixtures {
  graphs: Record<string, ProjectGraph>
  errorCases: { code: PatchErrorCode; graph: string; actor: Actor; request: Partial<PatchRequest>; op: PatchOp; note: string }[]
}
const fixtures = fixturesJson as unknown as Fixtures

describe("PatchErrorCode：contract-fixtures.json 的 (graph, op) 逐一真跑", () => {
  for (const c of fixtures.errorCases) {
    test(`${c.code}：${c.note}`, async () => {
      const g = fixtures.graphs[c.graph]
      const r = await applyPatch(g, { ...c.request, ops: [c.op] }, c.actor, { now, artifacts })
      expect(codeOf(r)).toBe(c.code)
      expect(r.receipt.version).toBe(g.version) // 整批拒绝/坏 op 丢弃都不 bump version
      expect(r.committed).toBe(false)
    })
  }

  test("PINNED_FORBIDS：pinned 节点非用户不得删除；reroll/select_take/write_result/换 take 同拒", async () => {
    const g = fixtures.graphs.pinned
    const fixture = fixtures.errorCases.find((c) => c.code === "PINNED_FORBIDS")!
    expect(fixture.op).toEqual({ op: "remove_node", node: "k1" }) // 夹具是真实触发路径，不是「set on pinned」
    const rm = await applyPatch(g, { ops: [fixture.op] }, { kind: "agent" }, { now, artifacts })
    expect(codeOf(rm)).toBe("PINNED_FORBIDS")
    expect(rm.graph.nodes.k1).toBeDefined() // 未删
    expect(rm.graph.nodes.k1.pinned?.outputsSha).toEqual(g.nodes.k1.pinned!.outputsSha)

    const rr = await applyPatch(g, { ops: [{ op: "reroll", node: "k1" }] }, { kind: "agent" }, { now, artifacts })
    expect(codeOf(rr)).toBe("PINNED_FORBIDS")
    const st = await applyPatch(g, { ops: [{ op: "select_take", node: "k1", take: 1 }] }, { kind: "agent" }, { now, artifacts })
    expect(codeOf(st)).toBe("PINNED_FORBIDS")
    const swapped = await applyPatch(g, { ops: [{ op: "pin", node: "k1", take: 1 }] }, { kind: "agent" }, { now, artifacts })
    expect(codeOf(swapped)).toBe("PINNED_FORBIDS")

    const scriptPinned = graph([node("s1", "script", { params: { text: "x" }, pinned: { by: "agent", at: NOW.toISOString(), outputsSha: [], signatureAtPin: "" } })])
    const wr = await apply(scriptPinned, [{ op: "write_result", node: "s1", value: { text: "y" } }])
    expect(codeOf(wr)).toBe("PINNED_FORBIDS")
  })

  test("set on pinned 允许并进 drift（§3.1：pin 是产物锁不是作者锁）", async () => {
    const g = fixtures.graphs.pinned
    const r = await applyPatch(g, { ops: [{ op: "set", node: "k1", path: "params.prompt", value: "改" }] }, { kind: "agent" }, { now, artifacts })
    expect(r.receipt.ok).toBe(true)
    expect(r.receipt.drift).toContain("k1")
    expect(r.graph.nodes.k1.status).toBe("done") // 不重算、不改状态
    expect(r.graph.nodes.k1.pinned?.outputsSha).toEqual(g.nodes.k1.pinned!.outputsSha)
  })

  test("错误码全集：17 个 PatchErrorCode 都被夹具或显式用例覆盖", () => {
    const codes = new Set<PatchErrorCode>(["NOT_FOUND", "EXISTS", "BAD_PATH", "BAD_VALUE", "BAD_REF", "CYCLE", "LOCKED", "PINNED_FORBIDS", "NOT_PINNABLE", "NOT_AUTHORED", "LANE_VIOLATION", "ACTOR_FORBIDDEN", "REV_CONFLICT", "VERSION_CONFLICT", "GRAPH_INVALID", "UNKNOWN_RECIPE", "RUN_ACTIVE_CONFLICT"])
    expect(new Set(fixtures.errorCases.map((c) => c.code))).toEqual(codes)
  })
})

// ───────────────────────────── 3) pin 边界 7 条规则（§3.5） ─────────────────────────────

describe("pin 边界（§3.5 每条规则一例）", () => {
  const withOutput = (id: string, type: NodeType, over: Partial<ProjectNode> = {}) => node(id, type, { outputs: [out()], ...over })

  test("type_not_pinnable：export 不可 pin", async () => {
    const r = await apply(graph([withOutput("ex", "export")]), [{ op: "pin", node: "ex" }])
    expect(codeOf(r)).toBe("NOT_PINNABLE")
  })

  test("type_not_pinnable：qc 不可 pin", async () => {
    const r = await apply(graph([withOutput("q1", "qc")]), [{ op: "pin", node: "q1" }])
    expect(codeOf(r)).toBe("NOT_PINNABLE")
  })

  test("template_node：forEach 模板节点本体不可 pin（钉实例）", async () => {
    const shots = node("shots", "shotlist", { params: { kind: "shots", rows: [{ id: "a" }] } })
    const tpl = withOutput("kf", "keyframe", { forEach: { over: "shots", as: "shot" } })
    const r = await apply(graph([shots, tpl]), [{ op: "pin", node: "kf" }])
    expect(codeOf(r)).toBe("NOT_PINNABLE")
  })

  test("scratch：草稿节点不可 pin", async () => {
    const r = await apply(graph([withOutput("k1", "keyframe", { scratch: { expiresAt: NOW.toISOString() } })]), [{ op: "pin", node: "k1" }])
    expect(codeOf(r)).toBe("NOT_PINNABLE")
  })

  test("bad_status：failed / blocked 不可 pin", async () => {
    const failed = await apply(graph([withOutput("k1", "keyframe", { status: "failed" })]), [{ op: "pin", node: "k1" }])
    expect(codeOf(failed)).toBe("NOT_PINNABLE")
    const blocked = await apply(graph([withOutput("k1", "keyframe", { status: "blocked" })]), [{ op: "pin", node: "k1" }])
    expect(codeOf(blocked)).toBe("NOT_PINNABLE")
  })

  test("no_outputs：没有产物不可 pin", async () => {
    const r = await apply(graph([node("k1", "keyframe", { outputs: [] })]), [{ op: "pin", node: "k1" }])
    expect(codeOf(r)).toBe("NOT_PINNABLE")
  })

  test("takes_needs_take：必须指定 take，且必须是当前选中的那个（先 select_take）", async () => {
    const t0 = out("out", { take: 0 })
    const t1 = out("out", { take: 1 })
    const g = graph([node("k1", "keyframe", { takes: { n: 2, select: "user" }, takesPool: [t0, t1], outputs: [t0] })])
    expect(codeOf(await apply(g, [{ op: "pin", node: "k1" }]))).toBe("BAD_VALUE")
    expect(codeOf(await apply(g, [{ op: "pin", node: "k1", take: 1 }]))).toBe("BAD_VALUE") // 未 select_take
    const selected = await apply(g, [{ op: "select_take", node: "k1", take: 1 }, { op: "pin", node: "k1", take: 1 }])
    expect(selected.receipt.ok).toBe(true)
    expect(selected.graph.nodes.k1.pinned?.take).toBe(1)
    expect(selected.graph.nodes.k1.pinned?.outputsSha).toEqual([t1.sha256])
    // 非 takes 节点不接受 take
    const plain = await apply(graph([withOutput("k2", "keyframe")]), [{ op: "pin", node: "k2", take: 1 }])
    expect(codeOf(plain)).toBe("BAD_VALUE")
  })

  test("freeze_all_ports：pin 冻结全部输出口，不允许只钉一部分", async () => {
    const o1 = out("out")
    const o2 = out("srt")
    const o3 = out("ass")
    const r = await apply(graph([node("s1", "subtitle", { outputs: [o1, o2, o3] })]), [{ op: "pin", node: "s1" }])
    expect(r.receipt.ok).toBe(true)
    expect(r.graph.nodes.s1.pinned?.outputsSha).toEqual([o1.sha256, o2.sha256, o3.sha256])
  })

  test("user 的 pin 只有 user/engine 能 unpin（agent 不能动）", async () => {
    const g = graph([node("k1", "keyframe", { outputs: [out()], pinned: { by: "user", at: NOW.toISOString(), outputsSha: [], signatureAtPin: "" } })])
    expect(codeOf(await apply(g, [{ op: "unpin", node: "k1" }]))).toBe("ACTOR_FORBIDDEN")
    expect((await apply(g, [{ op: "unpin", node: "k1" }], USER)).receipt.ok).toBe(true)
  })
})

// ───────────────────────────── 4) replace_output 非 user 被拒 ─────────────────────────────

describe("replace_output 仅 user", () => {
  const g = () => graph([node("k1", "keyframe", { outputs: [out()] })])
  test("agent / subagent / engine 都被 ACTOR_FORBIDDEN 拒绝，且图不变", async () => {
    const ops: PatchOp[] = [{ op: "replace_output", node: "k1", artifactId: "art_dddddddddddddddd" }]
    for (const actor of [AGENT, { kind: "subagent", runId: "sub1", lane: ["k1"] } as Actor, { kind: "engine" } as Actor]) {
      const r = await apply(g(), ops, actor)
      expect(codeOf(r)).toBe("ACTOR_FORBIDDEN")
      expect(r.graph.nodes.k1.outputs[0].artifactId).not.toBe("art_dddddddddddddddd")
      expect(r.committed).toBe(false)
    }
  })
})

// ───────────────────────────── 5) actor / lane / ifRev ─────────────────────────────

describe("actor 与并发口径", () => {
  test("subagent：lane 内可写、lane 外 LANE_VIOLATION；非白名单 op ACTOR_FORBIDDEN", async () => {
    const g = graph([node("s1", "script", { params: { text: "x" } }), node("s2", "script", { params: { text: "y" } })])
    const lane = { kind: "subagent", runId: "sub1", lane: ["s1"] } as Actor
    const okr = await apply(g, [{ op: "write_result", node: "s1", value: { text: "lane 内" } }], lane)
    expect(okr.receipt.ok).toBe(true)
    expect(codeOf(await apply(g, [{ op: "write_result", node: "s2", value: { text: "越界" } }], lane))).toBe("LANE_VIOLATION")
    expect(codeOf(await apply(g, [{ op: "lock", node: "s1", fields: ["intent"] }], lane))).toBe("ACTOR_FORBIDDEN")
  })

  test("set.ifRev 不匹配 → 该 op REV_CONFLICT，别的 op 照常应用（非原子批）", async () => {
    const g = graph([node("k1", "keyframe", { params: { prompt: "a" } }), node("k2", "keyframe", { params: { prompt: "b" } })])
    const r = await apply(g, [
      { op: "set", node: "k1", path: "params.prompt", value: "A", ifRev: 99 },
      { op: "set", node: "k2", path: "params.prompt", value: "B", ifRev: 1 },
    ])
    expect(r.receipt.applied).toBe(1)
    expect(r.receipt.rejected[0]).toMatchObject({ i: 0, code: "REV_CONFLICT", node: "k1" })
    expect(r.graph.nodes.k1.params.prompt).toBe("a")
    expect(r.graph.nodes.k2.params.prompt).toBe("B")
  })

  test("baseVersion 不匹配 → 整批 VERSION_CONFLICT（atomic 语义对版本闸恒定）", async () => {
    const g = graph([node("k1", "keyframe", { params: { prompt: "a" } })], { version: 7 })
    const r = await applyPatch(g, { ops: [{ op: "set", node: "k1", path: "params.prompt", value: "b" }], baseVersion: 6 }, AGENT, { now, artifacts })
    expect(codeOf(r)).toBe("VERSION_CONFLICT")
    expect(r.receipt.version).toBe(7)
    expect(r.committed).toBe(false)
    expect(r.graph.nodes.k1.params.prompt).toBe("a")
  })

  test("atomic=true：坏 op 让整批拒绝且不留半截", async () => {
    const g = graph([node("k1", "keyframe", { params: { prompt: "a" } })])
    const r = await applyPatch(g, { atomic: true, ops: [{ op: "set", node: "k1", path: "params.prompt", value: "b" }, { op: "set", node: "nope", path: "intent", value: "x" }] }, AGENT, { now, artifacts })
    expect(codeOf(r)).toBe("NOT_FOUND")
    expect(r.receipt.applied).toBe(0)
    expect(r.graph.nodes.k1.params.prompt).toBe("a")
  })
})

// ───────────────────────────── 6) drift / stale 传播 ─────────────────────────────

describe("回执 stale/drift 传播", () => {
  function chain() {
    const r = node("a", "reference", { params: { source: "upload", artifactId: "art_dddddddddddddddd" }, outputs: [out()] })
    const b = node("b", "keyframe", { params: { prompt: "b", model: "m", seed: 1 }, inputs: { ref: { from: "a" } }, outputs: [out()] })
    const c = node("c", "clip", { params: { prompt: "c", model: "v", seed: 2 }, inputs: { src: { from: "b" } }, outputs: [out()] })
    const e = node("e", "export", { params: { preset: "landscape_169" }, inputs: { video: { from: "c" } }, outputs: [out()] })
    const d = node("d", "keyframe", {
      params: { prompt: "d", model: "m", seed: 3 },
      inputs: { ref: { from: "b" } },
      outputs: [out()],
      pinned: { by: "user", at: NOW.toISOString(), outputsSha: [], signatureAtPin: "sig_d" },
    })
    return graph([r, b, c, e, d])
  }

  test("改上游 → 下游全标 stale；pinned 节点进 drift、状态与产物不动、且不再下传", async () => {
    const g = chain()
    const dOutputs = structuredClone(g.nodes.d.outputs)
    const r = await apply(g, [{ op: "set", node: "b", path: "params.prompt", value: "改过的提示词" }])
    expect(r.receipt.ok).toBe(true)
    expect(r.receipt.stale).toEqual(["b", "c", "e"]) // d 是 pinned：止步
    expect(r.receipt.drift).toEqual(["d"])
    expect(r.graph.nodes.d.status).toBe("done")
    expect(r.graph.nodes.d.outputs).toEqual(dOutputs)
    expect(r.graph.nodes.c.status).toBe("stale")
    expect(r.graph.nodes.e.status).toBe("stale")
  })

  test("改 pinned 节点自身的签名参数：只进 drift，不标 stale、不下传", async () => {
    const g = chain()
    const r = await apply(g, [{ op: "set", node: "d", path: "params.prompt", value: "新" }])
    expect(r.receipt.ok).toBe(true)
    expect(r.receipt.drift).toEqual(["d"])
    expect(r.receipt.stale).toEqual([])
    expect(r.graph.nodes.d.status).toBe("done")
  })

  test("intent 不进签名：改 intent 不触发 stale；改签名参数才触发", async () => {
    const g = chain()
    const intent = await apply(g, [{ op: "set", node: "b", path: "intent", value: "换个说法" }])
    expect(intent.receipt.stale).toEqual([])
    expect(intent.receipt.drift).toEqual([])
    const prompt = await apply(g, [{ op: "set", node: "b", path: "params.prompt", value: "换提示词" }], AGENT, { isSignedParam: (type, key) => key === "prompt" })
    expect(prompt.receipt.stale).toEqual(["b", "c", "e"])
  })
})

// ───────────────────────────── 7) 回执上限：256 op 极端批 ─────────────────────────────

describe("回执序列化上限（LIMITS.PATCH_RECEIPT_BYTES=1024）", () => {
  test("256 op 批次，rejected 全是长消息：截断到 ≤1024B 且 more 计数正确", async () => {
    const nodes = Array.from({ length: 120 }, (_, i) => node(`n${i}`, "keyframe", { params: { prompt: `p${i}` } }))
    const g = graph(nodes)
    const longId = "z".repeat(400) // NOT_FOUND 的消息长度 ≈ id 长度（真实引擎文案，不特制）
    const ops: PatchOp[] = []
    for (let i = 0; i < 200; i++) ops.push({ op: "set", node: `${longId}${i}`, path: "intent", value: "x" })
    for (let i = 0; i < 56; i++) ops.push({ op: "set", node: `n${i}`, path: "intent", value: `改了 ${i}` })
    expect(ops.length).toBe(256)

    const r = await apply(g, ops)
    expect(r.receipt.applied).toBe(56)
    // rejected 的 node 字段也占字节（这里 400 字 id）：按固定优先级先丢 changed，再缩 msg，最后才丢 rejected 条数。
    expect(r.receipt.rejected.length).toBeGreaterThanOrEqual(1)
    expect(r.receipt.rejected.length).toBeLessThanOrEqual(5)
    const bytes = utf8Bytes(r.receipt)
    expect(bytes).toBeLessThanOrEqual(1024)
    expect(r.receipt.more?.rejected).toBe(200 - r.receipt.rejected.length)
    expect(r.receipt.more?.changed).toBe(56 - r.receipt.changed.length)
    expect(r.receipt.changed.length).toBeLessThanOrEqual(12)
    expect(r.receipt.rejected.every((x) => [...x.msg].length <= 120)).toBe(true)
  })

  test("普通满量回执（5 rejected + 12 changed + 12 stale + 8 drift + 3 warnings）也 ≤1024B", async () => {
    const nodes: ProjectNode[] = [node("root", "reference", { params: { source: "upload" }, outputs: [out()] })]
    for (let i = 0; i < 40; i++) nodes.push(node(`c${i}`, "keyframe", { params: { prompt: "p", seed: i }, inputs: { ref: { from: "root" } }, outputs: [out()], ...(i % 5 === 0 ? { pinned: { by: "user" as const, at: NOW.toISOString(), outputsSha: [], signatureAtPin: "s" } } : {}) }))
    const g = graph(nodes)
    const ops: PatchOp[] = [
      ...Array.from({ length: 6 }, (_, i): PatchOp => ({ op: "set", node: `c${i}`, path: "params.prompt", value: "x".repeat(300) })),
      ...Array.from({ length: 6 }, (_, i): PatchOp => ({ op: "set", node: `bad${i}`, path: "intent", value: "y".repeat(300) })),
    ]
    const r = await apply(g, ops)
    expect(utf8Bytes(r.receipt)).toBeLessThanOrEqual(1024)
    expect(r.receipt.rejected.length).toBeLessThanOrEqual(5)
    expect(r.receipt.stale.length).toBeLessThanOrEqual(12)
  })
})

// ───────────────────────────── 8) 跨切片：S4 派生输入键（ref:）在 S3 校验器里的口径 ─────────────────────────────

describe("跨切片：expand（S4）派生的 ref: 输入键通过 validate（S3）", () => {
  const NODE = (id: string, type: NodeType, over: Partial<ProjectNode> = {}): ProjectNode =>
    node(id, type, { intent: "", params: {}, ...over })

  function expanded(): ProjectGraph {
    const ref = NODE("r1", "reference", {
      params: { source: "upload", artifactId: "art_aaaaaaaaaaaaaaaa" },
      outputs: [{ port: "out", artifactId: "art_aaaaaaaaaaaaaaaa", sha256: "a".repeat(64), path: "/f/a", mime: "image/png", bytes: 1, origin: "generated" }],
    })
    const shots = NODE("shots", "shotlist", { params: { kind: "shots", rows: [{ id: "a", action: "推镜" }] } })
    const tpl = NODE("kf", "keyframe", {
      params: { prompt: "${row.action} 参考 ${r1}", model: "m-img", size: "1024x1024", seed: 1, role: "keyframe", n: 1 },
      inputs: { ref_image: { from: "r1", port: "out" } }, // 显式键与派生键共存
      forEach: { over: "shots", as: "shot" },
    })
    return graph([ref, shots, tpl])
  }

  test("展开后的整图（显式 ref_image + 派生 ref:r1）零 error", async () => {
    const { expandGraph } = await import("./expand.ts")
    const { validateGraph } = await import("./validate.ts")
    const g = expanded()
    const ex = expandGraph(g)
    expect(ex.ok).toBe(true)
    const nodes = ex.nodes
    expect(Object.keys(nodes.kf.inputs).sort()).toEqual(["ref:r1", "ref_image"])
    expect(Object.keys(nodes["kf#a"].inputs).sort()).toEqual(["ref:r1", "ref_image"])
    const v = validateGraph({ ...g, nodes, order: ex.order })
    expect(v.errors).toEqual([])
  })

  test("非法派生名仍拒：ref: 后为空 / 大写 / 空格 / 空端口 / 数字开头", async () => {
    const { validateGraph } = await import("./validate.ts")
    for (const name of ["ref:", "ref:R1", "ref:a b", "ref:r1.", "ref:r1.out port", "ref:1bad"]) {
      const v = validateGraph(graph([NODE("r1", "reference"), NODE("k1", "keyframe", { inputs: { [name]: { from: "r1" } } })]))
      expect(v.errors.some((e) => e.code === "BAD_INPUT"), name).toBe(true)
    }
    // 派生键仍要校验 from 存在与端口合法
    const dangling = validateGraph(graph([NODE("k1", "keyframe", { inputs: { "ref:nope": { from: "nope" } } })]))
    expect(dangling.errors.some((e) => e.code === "DANGLING_INPUT")).toBe(true)
    const badPort = validateGraph(graph([NODE("r1", "reference"), NODE("k1", "keyframe", { inputs: { "ref:r1.nope": { from: "r1", port: "nope" } } })]))
    expect(badPort.errors.some((e) => e.code === "BAD_PORT")).toBe(true)
  })

  test("S2 checkInputs 同口径：显式键与派生键共存通过；非法派生名 reject", async () => {
    const g = graph([NODE("r1", "reference", { outputs: [out()] })])
    // S21 起补丁路径会真展开（§3.3）：ref: 是派生键、每次整体重算，因此夹具要带真实的 ${r1} 引用，
    // 由展开器重新生成 ref:r1；显式键 ref_image 原样保留。
    const okr = await apply(g, [{ op: "add_node", node: { id: "k1", type: "keyframe", params: { prompt: "${r1}" }, inputs: { ref_image: { from: "r1" }, "ref:r1": { from: "r1" } } as never } }])
    expect(okr.receipt.ok).toBe(true)
    expect(Object.keys(okr.graph.nodes.k1.inputs).sort()).toEqual(["ref:r1", "ref_image"])
    for (const name of ["ref:", "ref:R1", "ref:a b"]) {
      const r = await apply(g, [{ op: "add_node", node: { id: "k2", type: "keyframe", inputs: { [name]: { from: "r1" } } as never } }])
      expect(codeOf(r), name).toBe("BAD_VALUE")
    }
  })
})

describe("用户手改不被模板回滚，锁不能被删行绕过", () => {
  async function seed() {
    return apply(graph([]), [
      { op: "add_node", node: { id: "sl", type: "shotlist", params: { kind: "shots", rows: [{ id: "s1", action: "跑" }, { id: "s2", action: "跳" }] } } },
      { op: "add_node", node: { id: "kf", type: "keyframe", params: { prompt: "猫 ${row.action}", model: "m" }, forEach: { over: "sl", as: "s" } } },
      { op: "add_node", node: { id: "solo", type: "keyframe", params: { prompt: "原始", model: "m" } } },
    ])
  }

  test("user set 实例 prompt 后加一行仍是用户值，回执带 warning；agent 直接改被拒，未锁节点仍可改", async () => {
    const seeded = await seed()
    expect(seeded.receipt.ok).toBe(true)
    const userSet = await apply(seeded.graph, [{ op: "set", node: "kf#s1", path: "params.prompt", value: "用户精修的 prompt" }], USER)
    expect(userSet.receipt.ok).toBe(true)
    expect(userSet.receipt.applied).toBe(1)
    expect(userSet.graph.nodes["kf#s1"].params.prompt).toBe("用户精修的 prompt")
    expect(userSet.graph.nodes["kf#s1"].locked?.by).toBe("user")
    expect(userSet.graph.nodes["kf#s1"].locked?.fields).toContain("params.prompt")
    expect(userSet.receipt.warnings.some((w) => w.includes("kf#s1.params.prompt"))).toBe(true)

    const more = await apply(userSet.graph, [{ op: "set", node: "sl", path: "params.rows", value: [{ id: "s1", action: "跑" }, { id: "s2", action: "跳" }, { id: "s3", action: "走" }] }])
    expect(more.receipt.ok).toBe(true)
    expect(more.graph.nodes["kf#s1"].params.prompt).toBe("用户精修的 prompt")
    expect(more.graph.nodes["kf#s3"]).toBeDefined()

    const overwrite = await apply(userSet.graph, [{ op: "set", node: "kf#s1", path: "params.prompt", value: "agent 覆盖" }])
    expect(codeOf(overwrite)).toBe("LOCKED")
    expect(overwrite.graph.nodes["kf#s1"].params.prompt).toBe("用户精修的 prompt")

    const indirect = await apply(userSet.graph, [{ op: "set", node: "sl", path: "params.rows", value: [{ id: "s1", action: "飞" }, { id: "s2", action: "跳" }] }])
    expect(codeOf(indirect)).toBe("LOCKED")
    expect(indirect.graph.nodes["kf#s1"].params.prompt).toBe("用户精修的 prompt")

    const agentSolo = await apply(seeded.graph, [{ op: "set", node: "solo", path: "params.prompt", value: "agent 自己改" }])
    expect(agentSolo.receipt.ok).toBe(true)
    expect(agentSolo.graph.nodes.solo.params.prompt).toBe("agent 自己改")
  })

  test("agent 删 locked 或 pinned 实例对应行被拒；用户删行允许", async () => {
    const seeded = await seed()
    const locked = await apply(seeded.graph, [{ op: "lock", node: "kf#s2", fields: "*" }], USER)
    expect(locked.graph.nodes["kf#s2"].locked?.by).toBe("user")
    const del = await apply(locked.graph, [{ op: "set", node: "sl", path: "params.rows", value: [{ id: "s1", action: "跑" }] }])
    expect(codeOf(del)).toBe("LOCKED")
    expect(del.graph.nodes["kf#s2"]).toBeDefined()
    expect(del.graph.nodes["kf#s2"].params.prompt).toBe(locked.graph.nodes["kf#s2"].params.prompt)

    seeded.graph.nodes["kf#s2"].outputs = [out()]
    seeded.graph.nodes["kf#s2"].status = "done"
    const pinned = await apply(seeded.graph, [{ op: "pin", node: "kf#s2" }], USER)
    expect(pinned.receipt.ok).toBe(true)
    const delPin = await apply(pinned.graph, [{ op: "set", node: "sl", path: "params.rows", value: [{ id: "s1", action: "跑" }] }])
    expect(codeOf(delPin)).toBe("LOCKED")
    expect(delPin.graph.nodes["kf#s2"]).toBeDefined()

    const userDel = await apply(locked.graph, [{ op: "set", node: "sl", path: "params.rows", value: [{ id: "s1", action: "跑" }] }], USER)
    expect(userDel.receipt.ok).toBe(true)
    expect(userDel.graph.nodes["kf#s2"]).toBeUndefined()
  })
})

describe("patch 阶段拒绝未知键、类型不符、不存在的端口", () => {
  test("四条坏 op 全部拒绝，回执带 field 与期望，且 ≤1KB；合法 set 仍通过", async () => {
    const seeded = await apply(graph([]), [
      { op: "add_node", node: { id: "v1", type: "voice", params: { text: "hi" } } },
      { op: "add_node", node: { id: "k1", type: "keyframe", params: { prompt: "p", model: "m" } } },
      { op: "add_node", node: { id: "c1", type: "clip", params: { prompt: "p", model: "m", seconds: 5 }, inputs: { first: { from: "k1" } } } },
    ])
    expect(seeded.receipt.ok).toBe(true)
    const bad = await apply(seeded.graph, [
      { op: "set", node: "k1", path: "params.model", value: 123 as never },
      { op: "set", node: "k1", path: "params.no_such_param", value: "x" },
      { op: "connect", to: "k1", input: "frame", from: "v1", port: "zzz" },
      { op: "set", node: "c1", path: "params.seconds", value: "abc" },
    ])
    expect(bad.receipt.applied).toBe(0)
    expect(bad.receipt.rejected).toHaveLength(4)
    const msgs = bad.receipt.rejected.map((r) => r.msg).join("\n")
    expect(msgs).toContain("field=params.model")
    expect(msgs).toContain("必须是字符串")
    expect(msgs).toContain("field=params.no_such_param")
    expect(msgs).toContain("field=inputs.frame.port")
    expect(msgs).toContain("期望端口")
    expect(msgs).toContain("field=params.seconds")
    expect(msgs).toContain("必须是数字")
    expect(utf8Bytes(JSON.stringify(bad.receipt))).toBeLessThanOrEqual(1024)
    expect(bad.graph.nodes.k1.params.model).toBe("m")
    expect(bad.graph.nodes.c1.params.seconds).toBe(5)

    const ok = await apply(seeded.graph, [{ op: "set", node: "k1", path: "params.prompt", value: "仍然合法" }])
    expect(ok.receipt.ok).toBe(true)
    expect(ok.graph.nodes.k1.params.prompt).toBe("仍然合法")
  })
})
