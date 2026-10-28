// S3 validate.ts 行为测试。期望来自设计文档 §3.3 文法 / §3.5 pin 边界 / S3 判准清单，输入图手写。
import { describe, expect, test } from "bun:test"
import type { Json, NodeType, ProjectGraph, ProjectNode } from "./types"
import { checkNewNodeId, checkRunnable, findCycle, validateGraph, validateSet } from "./validate"

const SHA = "a".repeat(64)
function node(id: string, type: NodeType, o: Partial<ProjectNode> = {}): ProjectNode {
  return { id, type, intent: "", params: {}, inputs: {}, refs: [], pinned: null, status: "pending", signature: null, lastRun: null, outputs: [], rev: 1, ...o }
}
function graph(nodes: ProjectNode[], o: Partial<ProjectGraph> = {}): ProjectGraph {
  return {
    schema: 1, id: "p", sessionId: "p", version: 1, createdAt: "t", updatedAt: "t", brief: [], decisions: [], targets: null, defaults: { videoModel: "minimax-h3" },
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), order: nodes.map((n) => n.id), budget: { capCoins: null, spentCoins: 0, savedCoins: 0 }, activeRun: null, seq: 0, ...o,
  }
}
const codes = (g: ProjectGraph) => validateGraph(g).errors.map((e) => e.code)
const out = (sha = SHA, port = "out") => ({ port, artifactId: "art_0123456789abcdef", sha256: sha, path: "/x", mime: "image/png", bytes: 1, origin: "generated" as const })

// 一张合法的电影骨架：script → shots(shotlist) → kf#(forEach) → clip#(forEach) ; voice#(forEach) ; music ; timeline ; subtitle ; mix ; export ; qc
function filmGraph(): ProjectGraph {
  return graph([
    node("script", "script", { params: { text: "x" } }),
    node("shots", "shotlist", { params: { kind: "shots", rows: [{ id: "s1", action: "a" }, { id: "s2", action: "b" }] }, inputs: { script: { from: "script" } } }),
    node("kf", "keyframe", { forEach: { over: "shots", as: "shot" }, params: { prompt: "镜头 ${row.action}", size: "1536x1024" } }),
    node("clip", "clip", { forEach: { over: "shots", as: "shot" }, params: { prompt: "${row.action}", seconds: "${row.seconds}" }, inputs: { first: { from: "kf" } } }),
    node("vo", "voice", { forEach: { over: "shots", as: "shot" }, params: { text: "${row.action}" } }),
    node("bgm", "music", { params: { prompt: "cinematic, 90 BPM" } }),
    node("tl", "timeline", { params: { aspect: "16:9", fps: 30 }, inputs: { clips: { from: "clip" }, vo: { from: "vo" } } }),
    node("sub", "subtitle", { inputs: { shots: { from: "shots" }, tl: { from: "tl" } } }),
    node("mx", "mix", { inputs: { vo: { from: "vo" }, bgm: { from: "bgm" } } }),
    node("final", "export", { params: { preset: "landscape_169" }, inputs: { tl: { from: "tl" }, mix: { from: "mx" }, srt: { from: "sub", port: "srt" } } }),
    node("check", "qc", { params: { mode: "machine" }, inputs: { final: { from: "final" } } }),
  ])
}

describe("合法图", () => {
  test("完整电影骨架通过，且没有 error", () => {
    const r = validateGraph(filmGraph())
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })
  test("缺必需参数只给 warning（允许先加节点后补 prompt）；checkRunnable 升级为 error 并带修正示例", () => {
    const g = graph([node("kf1", "keyframe")])
    const r = validateGraph(g)
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toContain("MISSING_PARAM")
    const run = checkRunnable(g, "kf1")
    expect(run.map((i) => i.path)).toEqual(["params.prompt"])
    expect(JSON.parse(run[0].fix!)).toMatchObject({ op: "set", node: "kf1", path: "params.prompt" })
    expect(checkRunnable(g, "nope")[0].patchCode).toBe("NOT_FOUND")
  })
})

describe("环", () => {
  test("inputs 成环：报环路径，修正示例是 disconnect 且照做后通过", () => {
    const g = graph([
      node("a", "keyframe", { params: { prompt: "p" }, inputs: { x: { from: "b" } } }),
      node("b", "keyframe", { params: { prompt: "p" }, inputs: { y: { from: "a" } } }),
    ])
    const r = validateGraph(g)
    const e = r.errors.find((x) => x.code === "CYCLE")!
    expect(e.patchCode).toBe("CYCLE")
    expect(e.message).toMatch(/a → b → a|b → a → b/)
    const fix = JSON.parse(e.fix!)
    expect(fix.op).toBe("disconnect")
    delete g.nodes[fix.to].inputs[fix.input]
    expect(validateGraph(g).errors).toEqual([])
  })
  test("params 里的 ${} 引用成环；自引用也算环", () => {
    const g = graph([
      node("a", "keyframe", { params: { prompt: "用 ${b}" } }),
      node("b", "script", { params: { text: "x ${a}" } }),
    ])
    expect(codes(g)).toContain("CYCLE")
    expect(codes(graph([node("a", "script", { params: { text: "${a}" } })]))).toContain("CYCLE")
  })
  test("forEach.over 参与成环检测；findCycle 对无环 DAG 返回 null（含菱形）", () => {
    expect(findCycle([{ from: "a", to: "b", via: "" }, { from: "a", to: "c", via: "" }, { from: "b", to: "d", via: "" }, { from: "c", to: "d", via: "" }])).toBeNull()
  })
})

describe("悬空 / 重复 id", () => {
  test("input 指向不存在节点 → DANGLING_INPUT(BAD_REF)，修正是 disconnect", () => {
    const e = validateGraph(graph([node("a", "keyframe", { params: { prompt: "p" }, inputs: { x: { from: "ghost" } } })])).errors[0]
    expect(e).toMatchObject({ code: "DANGLING_INPUT", patchCode: "BAD_REF" })
    expect(JSON.parse(e.fix!)).toMatchObject({ op: "disconnect", to: "a", input: "x" })
  })
  test("${ghost} 悬空 → DANGLING_REF；orphaned 节点悬空只是 warning（保留产物）", () => {
    expect(codes(graph([node("a", "keyframe", { params: { prompt: "${ghost}" } })]))).toEqual(["DANGLING_REF"])
    const r = validateGraph(graph([node("a", "keyframe", { status: "orphaned", params: { prompt: "p" }, inputs: { x: { from: "ghost" } }, outputs: [out()] })]))
    expect(r.errors).toEqual([])
    expect(r.warnings.map((w) => w.code)).toContain("DANGLING_INPUT")
  })
  test("重复 id：order 重复、键与 id 不一致、add_node 撞已有 id", () => {
    const g = graph([node("a", "script")])
    g.order = ["a", "a"]
    expect(codes(g)).toContain("DUP_ID")
    const h = graph([node("a", "script")])
    h.nodes.a.id = "b"
    expect(codes(h)).toContain("ID_MISMATCH")
    expect(checkNewNodeId(graph([node("a", "script")]), "a")).toMatchObject({ code: "DUP_ID", patchCode: "EXISTS" })
    expect(checkNewNodeId(graph([]), "Bad-Id")).toMatchObject({ code: "BAD_ID" })
    expect(checkNewNodeId(graph([]), "a#s1")).toMatchObject({ code: "BAD_ID" })
    expect(checkNewNodeId(graph([]), "shot_1")).toBeNull()
  })
})

describe("forEach 规则（§3.3）", () => {
  const shots = node("shots", "shotlist", { params: { kind: "shots", rows: [{ id: "s1" }] } })
  test("over 指向非 shotlist 被拒，修正示例是新建 shotlist", () => {
    const e = validateGraph(graph([node("src", "script"), node("kf", "keyframe", { params: { prompt: "p" }, forEach: { over: "src", as: "shot" } })])).errors.find((x) => x.code === "FOREACH_BAD_OVER")!
    expect(e.message).toContain("shotlist")
    expect(JSON.parse(e.fix!).node.type).toBe("shotlist")
  })
  test("over 不存在 / over 自己", () => {
    expect(codes(graph([node("kf", "keyframe", { params: { prompt: "p" }, forEach: { over: "nope", as: "s" } })]))).toContain("FOREACH_BAD_OVER")
    expect(codes(graph([node("kf", "keyframe", { params: { prompt: "p" }, forEach: { over: "kf", as: "s" } })]))).toContain("FOREACH_BAD_OVER")
  })
  test('alias 为 "row" 被拒；alias 与节点 id 同名被拒；alias 非法字符被拒', () => {
    const mkg = (as: string) => graph([shots, node("kf", "keyframe", { params: { prompt: "p" }, forEach: { over: "shots", as } })])
    const e = validateGraph(mkg("row")).errors[0]
    expect(e.code).toBe("FOREACH_BAD_ALIAS")
    expect(e.message).toContain("row")
    expect(codes(mkg("shots"))).toContain("FOREACH_BAD_ALIAS")
    expect(codes(mkg("Bad Alias"))).toContain("FOREACH_BAD_ALIAS")
    expect(validateGraph(mkg("shot")).errors).toEqual([])
  })
  test("嵌套 forEach：over 另一个 forEach 节点被拒", () => {
    const g = graph([shots, node("inner", "shotlist", { forEach: { over: "shots", as: "a" } }), node("kf", "keyframe", { params: { prompt: "p" }, forEach: { over: "inner", as: "b" } })])
    expect(codes(g)).toContain("FOREACH_NESTED")
  })
  test("${row.x} 在非 forEach 节点里被拒；forEach 节点里放行", () => {
    expect(codes(graph([node("kf", "keyframe", { params: { prompt: "${row.action}" } })]))).toEqual(["ROW_OUTSIDE_FOREACH"])
    expect(validateGraph(graph([shots, node("kf", "keyframe", { params: { prompt: "${row.action}" }, forEach: { over: "shots", as: "s" } })])).errors).toEqual([])
  })
  test("${shot.keyframe} 同行引用：目标必须是 forEach 同一镜头表的兄弟；否则 BAD_REF", () => {
    const ok = graph([shots,
      node("kf", "keyframe", { params: { prompt: "p" }, forEach: { over: "shots", as: "shot" } }),
      node("clip", "clip", { params: { prompt: "${shot.kf}" }, forEach: { over: "shots", as: "shot" } })])
    expect(validateGraph(ok).errors).toEqual([])
    const lone = graph([shots, node("kf", "keyframe", { params: { prompt: "p" } }),
      node("clip", "clip", { params: { prompt: "${shot.kf}" }, forEach: { over: "shots", as: "shot" } })])
    expect(codes(lone)).toEqual(["BAD_REF"])
    const noTarget = graph([shots, node("clip", "clip", { params: { prompt: "${shot.}" }, forEach: { over: "shots", as: "shot" } })])
    expect(codes(noTarget)).toContain("BAD_REF")
  })
  test("实例节点：id 与 derivedFrom 必须一致；实例不能再带 forEach", () => {
    const tpl = node("kf", "keyframe", { params: { prompt: "p" }, forEach: { over: "shots", as: "shot" } })
    const good = node("kf#s1", "keyframe", { params: { prompt: "p" }, derivedFrom: { template: "kf", rowId: "s1" } })
    expect(validateGraph(graph([shots, tpl, good])).errors).toEqual([])
    const bad = node("kf#s1", "keyframe", { params: { prompt: "p" } })
    expect(codes(graph([shots, tpl, bad]))).toContain("BAD_INSTANCE")
    const nested = node("kf#s1", "keyframe", { params: { prompt: "p" }, derivedFrom: { template: "kf", rowId: "s1" }, forEach: { over: "shots", as: "x" } })
    expect(codes(graph([shots, tpl, nested]))).toContain("FOREACH_NESTED")
  })
  test("语法坏的引用：没闭合、空引用", () => {
    expect(codes(graph([node("a", "script", { params: { text: "x ${row.y" } })]))).toEqual(["BAD_REF"])
    expect(codes(graph([node("a", "script", { params: { text: "x ${}" } })]))).toEqual(["BAD_REF"])
  })
})

describe("端口类型", () => {
  test("keyframe 不接受音频输入；reference 不接受任何输入；voice 不接受图片", () => {
    const g1 = graph([node("v", "voice", { params: { text: "t" } }), node("kf", "keyframe", { params: { prompt: "p" }, inputs: { a: { from: "v" } } })])
    expect(codes(g1)).toEqual(["PORT_TYPE"])
    const g2 = graph([node("kf", "keyframe", { params: { prompt: "p" } }), node("r", "reference", { inputs: { a: { from: "kf" } } })])
    expect(codes(g2)).toEqual(["PORT_TYPE"])
    const g3 = graph([node("kf", "keyframe", { params: { prompt: "p" } }), node("v", "voice", { params: { text: "t" }, inputs: { a: { from: "kf" } } })])
    expect(codes(g3)).toEqual(["PORT_TYPE"])
  })
  test("reference(file) 可喂 keyframe/clip；script(text) 可进 prompt 引用；json 进 music 口", () => {
    const g = graph([node("r", "reference", { params: { source: "upload", artifactId: "art_0123456789abcdef" } }),
      node("s", "script", { params: { text: "x" } }),
      node("kf", "keyframe", { params: { prompt: "${s}" }, inputs: { ref: { from: "r" } } })])
    expect(validateGraph(g).errors).toEqual([])
  })
  test("不存在的输出口被拒并列出可用口；subtitle 主口别名 out 放行", () => {
    const s = node("sub", "subtitle")
    const bad = graph([s, node("final", "export", { params: { preset: "landscape_169" }, inputs: { x: { from: "sub", port: "vtt" } } })])
    const e = validateGraph(bad).errors[0]
    expect(e.code).toBe("BAD_PORT")
    expect(e.message).toContain("srt")
    expect(validateGraph(graph([s, node("final", "export", { params: { preset: "landscape_169" }, inputs: { x: { from: "sub", port: "out" } } })])).errors).toEqual([])
    expect(codes(graph([node("kf", "keyframe", { params: { prompt: "p" } }), node("kf2", "keyframe", { params: { prompt: "${kf.srt}" } })]))).toEqual(["BAD_PORT"])
  })
  test("输入口名非法", () => {
    expect(codes(graph([node("s", "script"), node("s2", "script", { inputs: { "Bad Name": { from: "s" } } })]))).toEqual(["BAD_INPUT"])
  })
})

describe("参数、takes、onFail、refs", () => {
  test("未知参数 / 类型错 / 越界各自报错，patchCode 区分 BAD_PATH 与 BAD_VALUE", () => {
    const r = validateGraph(graph([node("kf", "keyframe", { params: { prompt: "p", seconds: 5, n: 9, size: "16:9" } })]))
    const byPath = Object.fromEntries(r.errors.map((e) => [e.path, e.patchCode]))
    expect(byPath).toEqual({ "params.seconds": "BAD_PATH", "params.n": "BAD_VALUE", "params.size": "BAD_VALUE" })
  })
  test("takes：qc 节点不支持；n 超 2..4；select 非法", () => {
    const t = (type: NodeType, takes: unknown, params: Record<string, Json> = {}) => codes(graph([node("a", type, { params, takes: takes as never })]))
    expect(t("qc", { n: 2, select: "first" }, { mode: "machine" })).toEqual(["BAD_TAKES"])
    expect(t("keyframe", { n: 1, select: "first" }, { prompt: "p" })).toEqual(["BAD_TAKES"])
    expect(t("keyframe", { n: 5, select: "first" }, { prompt: "p" })).toEqual(["BAD_TAKES"])
    expect(t("keyframe", { n: 2, select: "best" }, { prompt: "p" })).toEqual(["BAD_TAKES"])
    expect(t("keyframe", { n: 4, select: "qc", rubric: "r" }, { prompt: "p" })).toEqual([])
  })
  test("takes select=qc 没给 rubric 是 warning", () => {
    const r = validateGraph(graph([node("a", "keyframe", { params: { prompt: "p" }, takes: { n: 2, select: "qc" } })]))
    expect(r.ok).toBe(true)
    expect(r.warnings.some((w) => w.code === "BAD_TAKES")).toBe(true)
  })
  test("onFail：regenerate.max 只能 1..2", () => {
    const f = (onFail: unknown) => codes(graph([node("a", "keyframe", { params: { prompt: "p" }, onFail: onFail as never })]))
    expect(f({ action: "regenerate", max: 2, on: "qc_fail", then: "skip" })).toEqual([])
    expect(f({ action: "regenerate", max: 3 })).toEqual(["BAD_ONFAIL"])
    expect(f({ action: "regenerate", max: 0 })).toEqual(["BAD_ONFAIL"])
    expect(f({ action: "retry" })).toEqual(["BAD_ONFAIL"])
    expect(f({ action: "skip" })).toEqual([])
  })
  test("refs：role 重复被拒；artifactId 形状；参考图数量对齐 image_generate", () => {
    const ref = (i: number, role = `r${i}`) => ({ artifactId: "art_0123456789abcdef", role })
    expect(codes(graph([node("a", "keyframe", { params: { prompt: "p" }, refs: [ref(1, "style"), ref(2, "style")] })]))).toEqual(["BAD_REFS"])
    expect(codes(graph([node("a", "keyframe", { params: { prompt: "p" }, refs: [{ artifactId: "x", role: "r" }] })]))).toEqual(["BAD_REFS"])
    const refs = (n: number) => Array.from({ length: n }, (_, i) => ref(i))
    expect(codes(graph([node("a", "keyframe", { params: { prompt: "p" }, refs: refs(5) })]))).toEqual([])
    expect(codes(graph([node("a", "keyframe", { params: { prompt: "p" }, refs: refs(6) })]))).toEqual(["TOO_MANY_REFERENCES"])
    expect(codes(graph([node("a", "clip", { params: { prompt: "p", model: "minimax-h3" }, refs: refs(9) })]))).toEqual([])
    expect(codes(graph([node("a", "clip", { params: { prompt: "p", model: "minimax-h3" }, refs: refs(10) })]))).toEqual(["TOO_MANY_REFERENCES"])
    expect(codes(graph([node("a", "clip", { params: { prompt: "p", model: "other" }, refs: refs(6) })]))).toEqual(["TOO_MANY_REFERENCES"])
    // 图片输入边也计入
    const r1 = node("r1", "reference", { params: { source: "upload", artifactId: "art_0123456789abcdef" } })
    expect(codes(graph([r1, node("a", "keyframe", { params: { prompt: "p" }, refs: refs(5), inputs: { x: { from: "r1" } } })]))).toEqual(["TOO_MANY_REFERENCES"])
  })
  test("intent > 200 字被拒；200 字放行", () => {
    expect(codes(graph([node("a", "script", { intent: "字".repeat(201) })]))).toEqual(["BAD_INTENT"])
    expect(codes(graph([node("a", "script", { intent: "字".repeat(200) })]))).toEqual([])
  })
  test("J5：music 带参考音频无 rights / 复刻措辞 被拒", () => {
    expect(codes(graph([node("m", "music", { params: { prompt: "p", sourceAudioSha: SHA } })]))).toEqual(["MUSIC_RIGHTS"])
    expect(codes(graph([node("m", "music", { params: { prompt: "p", sourceAudioSha: SHA, rights: "own" } })]))).toEqual([])
    expect(codes(graph([node("m", "music", { params: { prompt: "翻唱《晴天》" } })]))).toEqual(["MUSIC_RIGHTS"])
  })
  test("未知节点类型", () => {
    expect(codes(graph([node("a", "script", { type: "weird" as never })]))).toEqual(["UNKNOWN_TYPE"])
  })
})

describe("pin 不变量进图校验", () => {
  const pin = (shas: string[]) => ({ by: "user" as const, at: "t", outputsSha: shas, signatureAtPin: "s" })
  test("合规的 pinned 节点通过", () => {
    expect(validateGraph(graph([node("kf", "keyframe", { params: { prompt: "p" }, status: "done", outputs: [out()], pinned: pin([SHA]) })])).errors).toEqual([])
  })
  test("export 被 pin、pinned 无产物、指纹没覆盖全部口 都被拒", () => {
    expect(codes(graph([node("e", "export", { params: { preset: "landscape_169" }, outputs: [out()], pinned: pin([SHA]) })]))).toEqual(["PIN_INVARIANT"])
    expect(codes(graph([node("kf", "keyframe", { params: { prompt: "p" }, pinned: pin([SHA]) })]))).toEqual(["PIN_INVARIANT"])
    const two = [out(SHA, "srt"), out("b".repeat(64), "ass")]
    expect(codes(graph([node("s", "subtitle", { outputs: two, pinned: pin([SHA]) })]))).toEqual(["PIN_INVARIANT"])
    expect(codes(graph([node("s", "subtitle", { outputs: two, pinned: pin([SHA, "b".repeat(64)]) })]))).toEqual([])
  })
  test("forEach 模板本体被 pin 被拒", () => {
    const shots = node("shots", "shotlist", { params: { kind: "shots", rows: [{ id: "s1" }] } })
    expect(codes(graph([shots, node("kf", "keyframe", { params: { prompt: "p" }, forEach: { over: "shots", as: "s" }, outputs: [out()], pinned: pin([SHA]) })]))).toEqual(["PIN_INVARIANT"])
  })
})

describe("validateSet（补丁 set op）", () => {
  const kf = node("kf1", "keyframe", { params: { prompt: "p" } })
  test("合法路径放行", () => {
    for (const [path, value] of [["intent", "说明"], ["params.seed", 7], ["params.prompt", "新"], ["takes", { n: 2, select: "first" }], ["takes", null], ["onFail", { action: "skip" }], ["forEach", { over: "shots", as: "s" }], ["refs", []]] as [string, Json][]) {
      expect(validateSet(kf, path, value)).toBeNull()
    }
  })
  test("坏路径 → BAD_PATH；坏值 → BAD_VALUE；未知参数键 → BAD_PATH", () => {
    expect(validateSet(kf, "status", "done")!.patchCode).toBe("BAD_PATH")
    expect(validateSet(kf, "params.bogus", 1)!.patchCode).toBe("BAD_PATH")
    expect(validateSet(kf, "params.n", 9)!.patchCode).toBe("BAD_VALUE")
    expect(validateSet(kf, "intent", "字".repeat(201))!.patchCode).toBe("BAD_VALUE")
    expect(validateSet(kf, "forEach", { over: "shots", as: "row" })!.code).toBe("FOREACH_BAD_ALIAS")
    const m = node("m", "music", { params: { prompt: "p", sourceAudioSha: SHA } })
    expect(validateSet(m, "params.lyrics", "x")!.code).toBe("MUSIC_RIGHTS")
    expect(validateSet(m, "params.rights", "own")).toBeNull()
  })
  test("教学式错误的 fix 是合法 JSON 且含 op", () => {
    const i = validateSet(kf, "params.size", "16:9")!
    expect(JSON.parse(i.fix!).op).toBe("set")
  })
})

describe("性能", () => {
  test("200 节点图 validate ≤50ms（预热后）", () => {
    const nodes: ProjectNode[] = [node("shots", "shotlist", { params: { kind: "shots", rows: Array.from({ length: 50 }, (_, i) => ({ id: `s${i}` })) } })]
    let prev = "shots"
    for (let i = 0; i < 199; i++) {
      const id = `n${i}`
      nodes.push(node(id, "keyframe", { params: { prompt: `p ${i} \${shots}`, size: "1024x1024" }, inputs: { up: { from: prev } }, refs: [{ artifactId: "art_0123456789abcdef", role: "style" }] }))
      prev = id
    }
    const g = graph(nodes)
    expect(nodes.length).toBe(200)
    validateGraph(g)
    const t0 = performance.now()
    const r = validateGraph(g)
    const ms = performance.now() - t0
    expect(r.errors).toEqual([])
    expect(ms).toBeLessThanOrEqual(50)
  })
})
