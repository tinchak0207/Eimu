// signature.ts 行为测试（S1）。期望值来自设计文档 §3.2 第 4 条的性质，手写图、手算关系；不看也不抄 ComfyUI/n8n 源码。
import { describe, expect, test } from "bun:test"
import { canonicalJson, computeDrift, computeSignature, planRun, findReusable } from "./signature"
import type { CacheLookup } from "./signature"
import type { FingerprintResolver, Json, NodeSpecLite, NodeType, Output, ProjectGraph, ProjectNode } from "./types"

const T0 = "2026-10-28T00:00:00.000Z"
const sp = (type: NodeType, signedParams: string[], extra: Partial<NodeSpecLite> = {}): NodeSpecLite =>
  ({ type, specVersion: 1, signedParams, pinnable: true, fingerprintMode: "structural", ...extra })
const SPECS = {
  reference: sp("reference", ["source", "artifactId"]),
  script: sp("script", ["text"]),
  shotlist: sp("shotlist", ["kind", "rows"]),
  keyframe: sp("keyframe", ["prompt", "model", "seed", "role"]),
  clip: sp("clip", ["prompt", "model", "seconds", "seed"]),
  voice: sp("voice", ["text"]),
  music: sp("music", ["prompt"]),
  timeline: sp("timeline", ["order"], { fingerprintMode: "content" }),
  subtitle: sp("subtitle", ["style"]),
  mix: sp("mix", ["levels"]),
  export: sp("export", ["preset"], { pinnable: false }),
  qc: sp("qc", ["mode"], { pinnable: false }),
  render3d: sp("render3d", ["script"], { volatile: true }),
} as Record<NodeType, NodeSpecLite>

function node(id: string, type: NodeType, o: Partial<ProjectNode> = {}): ProjectNode {
  return {
    id, type, intent: "", params: {}, inputs: {}, refs: [], pinned: null, status: "pending", signature: null,
    lastRun: null, outputs: [], rev: 1, ...o,
  }
}
function graph(nodes: ProjectNode[]): ProjectGraph {
  return {
    schema: 1, id: "p", sessionId: "p", version: 1, createdAt: T0, updatedAt: T0, brief: [], decisions: [], targets: null, defaults: {},
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), order: nodes.map((n) => n.id), budget: { capCoins: null, spentCoins: 0, savedCoins: 0 },
    activeRun: null, seq: 0,
  }
}
const out = (artifactId: string, sha: string, port = "out"): Output =>
  ({ port, artifactId, sha256: sha, path: `/x/${artifactId}`, mime: "image/png", bytes: 1, origin: "generated" })

// 内存里的“文件系统”：artifactId→sha；缺失即抛
function fpOf(files: Record<string, string>): FingerprintResolver & { files: Record<string, string>; calls: number } {
  const r = { files, calls: 0, async fileSha256(id: string) { r.calls++; if (!(id in r.files)) throw new Error("ENOENT " + id); return r.files[id] } }
  return r
}
const sig = async (g: ProjectGraph, id: string, fp = fpOf({})) => {
  const r = await computeSignature(g, id, fp, SPECS)
  if (!r.ok) throw new Error("unstable: " + r.reason)
  return r.signature
}

// 链：script → shotlist → keyframe(k) → clip；另有无关分支 voice
function chain(ids = { s: "script", l: "shots", k: "kf", c: "clip", v: "voice" }, over: { seed?: number; scriptText?: string } = {}) {
  return graph([
    node(ids.s, "script", { params: { text: over.scriptText ?? "一只猫去海边" } }),
    node(ids.l, "shotlist", { params: { kind: "shots", rows: [{ id: "a" }] }, inputs: { script: { from: ids.s } } }),
    node(ids.k, "keyframe", { params: { prompt: "海边的猫", model: "m1", seed: over.seed ?? 7, role: "kf" }, inputs: { shots: { from: ids.l } } }),
    node(ids.c, "clip", { params: { prompt: "猫奔跑", model: "v1", seconds: 5, seed: 1 }, inputs: { first: { from: ids.k } } }),
    node(ids.v, "voice", { params: { text: "旁白" } }),
  ])
}

describe("canonicalJson", () => {
  test("键排序、无空白、-0 归零；非有限数抛错", () => {
    expect(canonicalJson({ b: 1, a: [2, null, { d: "x", c: true }] })).toBe('{"a":[2,null,{"c":true,"d":"x"}],"b":1}')
    expect(canonicalJson(-0)).toBe("0")
    expect(() => canonicalJson(NaN)).toThrow()
  })
})

describe("§3.2 第 4 条四个性质", () => {
  test("① 同构图换 node_id → 同签名", async () => {
    const a = chain()
    const b = chain({ s: "zz_a", l: "zz_b", k: "zz_c", c: "zz_d", v: "zz_e" })
    expect(await sig(a, "clip")).toBe(await sig(b, "zz_d"))
  })
  test("② 改祖先一个 signed 参数 → 下游全变、无关分支不变", async () => {
    const a = chain(), b = chain(undefined, { scriptText: "一只狗去山里" })
    for (const id of ["script", "shots", "kf", "clip"]) expect(await sig(a, id)).not.toBe(await sig(b, id))
    expect(await sig(a, "voice")).toBe(await sig(b, "voice"))
  })
  test("③ 换 seed → 只该节点及下游变，上游不变", async () => {
    const a = chain(), b = chain(undefined, { seed: 8 })
    expect(await sig(a, "script")).toBe(await sig(b, "script"))
    expect(await sig(a, "shots")).toBe(await sig(b, "shots"))
    expect(await sig(a, "kf")).not.toBe(await sig(b, "kf"))
    expect(await sig(a, "clip")).not.toBe(await sig(b, "clip"))
  })
  test("④ intent/title/params 中未签名项改动 → 签名不变", async () => {
    const a = chain(), b = chain()
    b.nodes.kf.intent = "换个说法"
    b.nodes.kf.params.title = "标题" // 不在 signedParams
    b.nodes.kf.rev = 99
    b.nodes.kf.locked = { by: "user", fields: "*", at: T0 }
    expect(await sig(a, "clip")).toBe(await sig(b, "clip"))
  })
})

describe("结构细节", () => {
  test("拓扑不同（菱形 vs 两条独立链）签名不同：祖先序号展开不会把共享祖先当成两个", async () => {
    const shared = graph([
      node("r", "script", { params: { text: "x" } }),
      node("a", "keyframe", { params: { prompt: "p" }, inputs: { i: { from: "r" } } }),
      node("b", "keyframe", { params: { prompt: "p" }, inputs: { i: { from: "r" } } }),
      node("t", "timeline", { params: { order: [] }, inputs: { a: { from: "a" }, b: { from: "b" } } }),
    ])
    const split = graph([
      node("r1", "script", { params: { text: "x" } }),
      node("r2", "script", { params: { text: "x" } }),
      node("a", "keyframe", { params: { prompt: "p" }, inputs: { i: { from: "r1" } } }),
      node("b", "keyframe", { params: { prompt: "p" }, inputs: { i: { from: "r2" } } }),
      node("t", "timeline", { params: { order: [] }, inputs: { a: { from: "a" }, b: { from: "b" } } }),
    ])
    // timeline 是 content 模式，需上游有产物才算得出：给各上游挂产物
    const fp = fpOf({ A1: "s1", B1: "s2" })
    for (const g of [shared, split]) { g.nodes.a.outputs = [out("A1", "s1")]; g.nodes.b.outputs = [out("B1", "s2")] }
    expect(await sig(shared, "t", fp)).not.toBe(await sig(split, "t", fp))
  })
  test("params 里的 ${node.port} 引用：被引用节点变 → 签名变；写不写 .out 等价", async () => {
    const mk = (text: string, ref: string) => graph([
      node("cast", "script", { params: { text } }),
      node("kf", "keyframe", { params: { prompt: `画 ${ref} 的样子` } }),
    ])
    expect(await sig(mk("A", "${cast}"), "kf")).toBe(await sig(mk("A", "${cast.out}"), "kf"))
    expect(await sig(mk("A", "${cast}"), "kf")).not.toBe(await sig(mk("B", "${cast}"), "kf"))
  })
  test("引用的是未解析别名（不是图中节点）→ 保持字面，不当依赖", async () => {
    const g = graph([node("kf", "keyframe", { params: { prompt: "${row.action}" } })])
    expect((await computeSignature(g, "kf", fpOf({}), SPECS)).ok).toBe(true)
  })
  test("悬空输入 → unstable（宁可重跑）", async () => {
    const g = graph([node("kf", "keyframe", { params: { prompt: "p" }, inputs: { i: { from: "ghost" } } })])
    const r = await computeSignature(g, "kf", fpOf({}), SPECS)
    expect(r.ok).toBe(false)
  })
  test("takes 参数进签名（n 变 → 变）", async () => {
    const a = chain(), b = chain()
    b.nodes.kf.takes = { n: 2, select: "first" }
    expect(await sig(a, "kf")).not.toBe(await sig(b, "kf"))
  })
})

describe("reference / 指纹 / unstable", () => {
  const refChain = () => graph([
    node("ref", "reference", { params: { source: "upload", artifactId: "art_1" }, outputs: [out("art_1", "sha_old")] }),
    node("kf", "keyframe", { params: { prompt: "p" }, inputs: { r: { from: "ref" } } }),
  ])
  test("reference 内容 sha 变 → 下游变（同 artifactId 文件被换也能发现）", async () => {
    const g = refChain()
    const s1 = await sig(g, "kf", fpOf({ art_1: "sha_old" }))
    const s2 = await sig(g, "kf", fpOf({ art_1: "sha_new" }))
    expect(s1).not.toBe(s2)
  })
  test("⑥ fileSha256 抛错 → 该节点及下游 unstable → planRun 归 toRun", async () => {
    const g = refChain()
    const fp = fpOf({}) // art_1 读不到
    expect((await computeSignature(g, "ref", fp, SPECS)).ok).toBe(false)
    expect((await computeSignature(g, "kf", fp, SPECS)).ok).toBe(false)
    const plan = await planRun(g, ["kf"], "incremental", fp, SPECS)
    expect(plan.toRun.sort()).toEqual(["kf", "ref"])
    expect(plan.reuse).toEqual([])
  })
  test("volatile 类型节点永不命中，且让下游 unstable", async () => {
    const g = graph([node("r3", "render3d", { params: { script: "s" } }), node("kf", "keyframe", { params: { prompt: "p" }, inputs: { i: { from: "r3" } } })])
    expect((await computeSignature(g, "r3", fpOf({}), SPECS)).ok).toBe(false)
    expect((await computeSignature(g, "kf", fpOf({}), SPECS)).ok).toBe(false)
  })
  test("refs（外部常量素材）按内容 sha 进签名", async () => {
    const g = graph([node("kf", "keyframe", { params: { prompt: "p" }, refs: [{ artifactId: "art_9", role: "style" }] })])
    const s1 = await sig(g, "kf", fpOf({ art_9: "aa" }))
    const s2 = await sig(g, "kf", fpOf({ art_9: "bb" }))
    expect(s1).not.toBe(s2)
  })
})

describe("pinned", () => {
  // 钉住 keyframe；其上游 script 之后被改
  function pinnedGraph(scriptText: string) {
    const g = chain(undefined, { scriptText })
    g.nodes.kf.outputs = [out("kf_art", "kf_sha")]
    g.nodes.kf.status = "done"
    return g
  }
  test("⑤ pinned 节点上游变 → 其下游签名不变、planRun 不重算上游；computeDrift 报该节点", async () => {
    const base = pinnedGraph("原剧本")
    const fp = fpOf({ kf_art: "kf_sha" })
    const sigAtPin = await sig(base, "kf", fp)
    const edited = pinnedGraph("改过的剧本")
    edited.nodes.kf.pinned = { by: "user", at: T0, outputsSha: ["kf_sha"], signatureAtPin: sigAtPin }
    const pinnedOrig = pinnedGraph("原剧本")
    pinnedOrig.nodes.kf.pinned = { by: "user", at: T0, outputsSha: ["kf_sha"], signatureAtPin: sigAtPin }
    // 下游 clip 的签名不受 pinned 上游变化影响
    expect(await sig(edited, "clip", fp)).toBe(await sig(pinnedOrig, "clip", fp))
    // planRun 对 clip：script/shots 在 pinned 之上，不进闭包
    const plan = await planRun(edited, ["clip"], "incremental", fp, SPECS)
    expect(plan.pinned).toEqual(["kf"])
    expect(plan.toRun).toEqual(["clip"])
    expect([...plan.toRun, ...plan.reuse]).not.toContain("script")
    // 漂移：原图不漂，改过上游的漂
    expect(await computeDrift(pinnedOrig, fp, SPECS)).toEqual([])
    expect(await computeDrift(edited, fp, SPECS)).toEqual(["kf"])
  })
  test("force 对 pinned target 不生效（仍是 pinned）", async () => {
    const g = pinnedGraph("x")
    g.nodes.kf.pinned = { by: "user", at: T0, outputsSha: ["kf_sha"], signatureAtPin: "whatever" }
    const plan = await planRun(g, ["kf"], "force", fpOf({}), SPECS)
    expect(plan.pinned).toEqual(["kf"])
    expect(plan.toRun).toEqual([])
  })
})

describe("planRun 复用与 force", () => {
  // 把整条链“跑完”：每个节点 done、lastRun.signature=当前签名、产物文件在
  async function completed() {
    const g = chain()
    const files: Record<string, string> = {}
    for (const id of ["script", "shots", "kf", "clip", "voice"]) {
      const n = g.nodes[id]
      files[`art_${id}`] = `sha_${id}`
      n.outputs = [out(`art_${id}`, `sha_${id}`)]
      n.status = "done"
      n.lastRun = { runId: "r", at: T0, via: "executed", signature: await sig(g, id), costCoins: 1, attempt: 1 }
    }
    return { g, fp: fpOf(files), files }
  }
  test("全部已完成 → 全 reuse（命中不入队：toRun 为空）", async () => {
    const { g, fp } = await completed()
    const plan = await planRun(g, undefined, "incremental", fp, SPECS)
    expect(plan.toRun).toEqual([])
    expect(plan.reuse.sort()).toEqual(["clip", "kf", "script", "shots", "voice"])
  })
  test("改 kf 的 seed → 只 kf 及下游 clip 重跑，其余复用", async () => {
    const { g, fp } = await completed()
    g.nodes.kf.params.seed = 99
    const plan = await planRun(g, undefined, "incremental", fp, SPECS)
    expect(plan.toRun.sort()).toEqual(["clip", "kf"])
    expect(plan.reuse.sort()).toEqual(["script", "shots", "voice"])
  })
  test("⑦ 产物文件被删 → 不复用", async () => {
    const { g, fp, files } = await completed()
    delete files.art_voice
    const plan = await planRun(g, undefined, "incremental", fp, SPECS)
    expect(plan.toRun).toEqual(["voice"])
  })
  test("产物文件内容变了（sha 对不上）→ 不复用", async () => {
    const { g, fp, files } = await completed()
    files.art_script = "tampered"
    const plan = await planRun(g, ["script"], "incremental", fp, SPECS)
    expect(plan.toRun).toEqual(["script"])
  })
  test("⑨ force：targets 强制 toRun，非 target 的上游仍复用", async () => {
    const { g, fp } = await completed()
    const plan = await planRun(g, ["kf"], "force", fp, SPECS)
    expect(plan.toRun).toEqual(["kf"])
    expect(plan.reuse.sort()).toEqual(["script", "shots"])
  })
  test("force：被强制节点的闭包内下游随之重跑", async () => {
    const { g, fp } = await completed()
    const plan = await planRun(g, ["kf", "clip"], "force", fp, SPECS)
    expect(plan.toRun.sort()).toEqual(["clip", "kf"])
  })
  test("status 非 done（failed）即使签名相同也不复用", async () => {
    const { g, fp } = await completed()
    g.nodes.voice.status = "failed"
    const plan = await planRun(g, ["voice"], "incremental", fp, SPECS)
    expect(plan.toRun).toEqual(["voice"])
  })
  test("缓存索引命中（节点自身已无产物）→ reuse", async () => {
    const g = chain()
    const fp = fpOf({ cached_art: "cached_sha" })
    const s = await sig(g, "voice")
    const cache: CacheLookup = { lookup: async (k) => (k === s ? { outputs: [out("cached_art", "cached_sha")], costCoins: 2 } : null) }
    const plan = await planRun(g, ["voice"], "incremental", fp, SPECS, cache)
    expect(plan.reuse).toEqual(["voice"])
    expect(await findReusable(g, "voice", s, fp, cache)).not.toBeNull()
    // 缓存里的产物文件没了 → 不复用
    const fp2 = fpOf({})
    expect((await planRun(g, ["voice"], "incremental", fp2, SPECS, cache)).toRun).toEqual(["voice"])
  })
  test("content 模式节点：上游要跑 → unknown（并向下传播）；上游已就绪 → 正常判定", async () => {
    const g = graph([
      node("kf", "keyframe", { params: { prompt: "p" } }),
      node("tl", "timeline", { params: { order: ["kf"] }, inputs: { a: { from: "kf" } } }),
      node("ex", "export", { params: { preset: "landscape_169" }, inputs: { v: { from: "tl" } } }),
    ])
    const plan = await planRun(g, ["ex"], "incremental", fpOf({}), SPECS)
    expect(plan.toRun).toEqual(["kf"])
    expect(plan.unknown.sort()).toEqual(["ex", "tl"])
  })
  test("依赖悬空 → blocked，并向下传播", async () => {
    const g = graph([
      node("kf", "keyframe", { params: { prompt: "p" }, inputs: { i: { from: "ghost" } } }),
      node("clip", "clip", { params: { prompt: "c" }, inputs: { f: { from: "kf" } } }),
    ])
    const plan = await planRun(g, ["clip"], "incremental", fpOf({}), SPECS)
    expect(plan.blocked.sort()).toEqual(["clip", "kf"])
  })
  test("forEach 模板本体不进计划；指向模板的 target 展开为实例", async () => {
    const g = graph([
      node("shots", "shotlist", { params: { kind: "shots", rows: [] } }),
      node("kf", "keyframe", { params: { prompt: "${row.action}" }, forEach: { over: "shots", as: "shot" } }),
      node("kf#a", "keyframe", { params: { prompt: "跑" }, derivedFrom: { template: "kf", rowId: "a" } }),
      node("kf#b", "keyframe", { params: { prompt: "跳" }, derivedFrom: { template: "kf", rowId: "b" } }),
    ])
    const plan = await planRun(g, ["kf"], "incremental", fpOf({}), SPECS)
    expect(plan.toRun.sort()).toEqual(["kf#a", "kf#b"])
  })
})

describe("上限：200 节点图 planRun", () => {
  test("200 节点（20 条 10 级深链，带菱形交叉）≤500ms", async () => {
    const nodes: ProjectNode[] = []
    for (let c = 0; c < 20; c++) {
      for (let d = 0; d < 10; d++) {
        const inputs: ProjectNode["inputs"] = {}
        if (d > 0) inputs.prev = { from: `n${c}_${d - 1}` }
        if (d > 1) inputs.skip = { from: `n${c}_${d - 2}` }
        if (c > 0 && d === 5) inputs.cross = { from: `n${c - 1}_4` }
        nodes.push(node(`n${c}_${d}`, "keyframe", { params: { prompt: `p${c}_${d}`, seed: d }, inputs }))
      }
    }
    const g = graph(nodes)
    expect(nodes.length).toBe(200)
    const t = performance.now()
    const plan = await planRun(g, undefined, "incremental", fpOf({}), SPECS)
    const ms = performance.now() - t
    expect(plan.toRun.length).toBe(200)
    expect(ms).toBeLessThan(500)
  })
})
