// expand.ts + takes.ts 测试。期望值来自设计文档 §3.3 与 S4 判准（手写），不镜像实现。
import { describe, expect, test } from "bun:test"
import { expandGraph, instanceId, instancesOf, readRows } from "./expand"
import { QC_SCORE_META_KEY, decideOnFail, effectiveSeed, groupByTake, selectTake, takeInRange, validateOnFail, validateTakes } from "./takes"
import type { Json, NodeType, Output, ProjectGraph, ProjectNode } from "./types"

const node = (id: string, type: NodeType, extra: Partial<ProjectNode> = {}): ProjectNode => ({
  id, type, intent: "", params: {}, inputs: {}, refs: [], pinned: null, status: "pending", signature: null, lastRun: null, outputs: [], rev: 1, ...extra,
})
const graphOf = (ns: ProjectNode[]): ProjectGraph => ({
  schema: 1, id: "p1", sessionId: "s1", version: 1, createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z",
  brief: [], decisions: [], targets: null, defaults: {}, nodes: Object.fromEntries(ns.map((n) => [n.id, n])), order: ns.map((n) => n.id),
  budget: { capCoins: null, spentCoins: 0, savedCoins: 0 }, activeRun: null, seq: 0,
})
const rows = (...ids: string[]): Json => ids.map((id) => ({ id, action: `动作_${id}`, sec: 5, nested: { a: { b: `深_${id}` } } }))
const shots = (ids: string[]) => node("shots", "shotlist", { params: { kind: "shots", rows: rows(...ids) } })
const out = (origin: Output["origin"]): Output => ({ port: "out", artifactId: "art_x", sha256: "a".repeat(64), path: "/x", mime: "image/png", bytes: 1, origin })
const basic = (ids: string[], extra: ProjectNode[] = []) => graphOf([
  node("cast_sheet", "keyframe"),
  shots(ids),
  node("keyframe", "keyframe", { forEach: { over: "shots", as: "shot" }, intent: "镜头 ${row.id}", params: { prompt: "${row.action} 参考 ${cast_sheet}", seconds: "${row.sec}", deep: "${row.nested.a.b}" } }),
  node("clip", "clip", { forEach: { over: "shots", as: "shot" }, params: { prompt: "${shot.keyframe}", frame: "${shot.keyframe.out}" } }),
  ...extra,
])

describe("扇出展开", () => {
  test("实例 id、顺序、替换、typed 值、规范化 inputs 边", () => {
    const r = expandGraph(basic(["s1", "s2", "s3"]))
    expect(r.ok).toBe(true)
    expect(r.order).toEqual(["cast_sheet", "shots", "keyframe", "keyframe#s1", "keyframe#s2", "keyframe#s3", "clip", "clip#s1", "clip#s2", "clip#s3"])
    const k2 = r.nodes["keyframe#s2"]
    expect(k2.params).toEqual({ prompt: "动作_s2 参考 ${cast_sheet}", seconds: 5, deep: "深_s2" })
    expect(k2.intent).toBe("镜头 s2")
    expect(k2.inputs).toEqual({ "ref:cast_sheet": { from: "cast_sheet" } })
    expect(k2.derivedFrom).toEqual({ template: "keyframe", rowId: "s2" })
    expect(k2.forEach).toBeUndefined()
    expect(k2.status).toBe("pending")
    const c3 = r.nodes["clip#s3"]
    expect(c3.params).toEqual({ prompt: "${keyframe#s3}", frame: "${keyframe#s3.out}" })
    expect(c3.inputs).toEqual({ "ref:keyframe": { from: "keyframe#s3" }, "ref:keyframe.out": { from: "keyframe#s3", port: "out" } })
    // 模板自身保留 ${row.*}，且得到指向模板兄弟的边
    expect(r.nodes["clip"].params.prompt).toBe("${shot.keyframe}")
    expect(r.nodes["clip"].inputs["ref:keyframe"]).toEqual({ from: "keyframe" })
    expect(r.instances).toEqual({ keyframe: ["keyframe#s1", "keyframe#s2", "keyframe#s3"], clip: ["clip#s1", "clip#s2", "clip#s3"] })
    expect(r.created.length).toBe(6)
    expect(instanceId("keyframe", "s1")).toBe("keyframe#s1")
  })

  test("确定性：同输入同输出；对自己的输出再展开不变（幂等）", () => {
    const g = basic(["s1", "s2"])
    const a = expandGraph(g)
    const b = expandGraph(g)
    expect(JSON.stringify(b.nodes)).toBe(JSON.stringify(a.nodes))
    expect(b.order).toEqual(a.order)
    const again = expandGraph({ ...g, nodes: a.nodes, order: a.order })
    expect(again.ok).toBe(true)
    expect(again.created).toEqual([])
    expect(again.updated).toEqual([])
    expect(again.removed).toEqual([])
    expect(JSON.stringify(again.nodes)).toBe(JSON.stringify(a.nodes))
    expect(again.order).toEqual(a.order)
  })

  test("row.id 去重保序，重复给 warning", () => {
    const r = expandGraph(basic(["s2", "s1", "s2"]))
    expect(r.instances.keyframe).toEqual(["keyframe#s2", "keyframe#s1"])
    expect(r.warnings.join("")).toMatch(/重复/)
    expect(readRows(shots(["a", "a", "b"])).rows.map((x) => x.id)).toEqual(["a", "b"])
  })

  test("row.id 不合法 / rows 不是数组 → 报错，nodes 原样返回", () => {
    const g1 = graphOf([node("shots", "shotlist", { params: { rows: [{ id: "S 1" }] } }), node("k", "keyframe", { forEach: { over: "shots", as: "shot" } })])
    const r1 = expandGraph(g1)
    expect(r1.ok).toBe(false)
    expect(r1.issues[0].code).toBe("BAD_VALUE")
    expect(r1.nodes).toBe(g1.nodes)
    const g2 = graphOf([node("shots", "shotlist", { params: { rows: "oops" } }), node("k", "keyframe", { forEach: { over: "shots", as: "shot" } })])
    expect(expandGraph(g2).ok).toBe(false)
  })

  test("rows 为空 / 缺省 → 零实例，不报错", () => {
    const r = expandGraph(graphOf([node("shots", "shotlist"), node("k", "keyframe", { forEach: { over: "shots", as: "shot" } })]))
    expect(r.ok).toBe(true)
    expect(r.instances.k).toEqual([])
  })
})

describe("forEach 声明校验", () => {
  const withFe = (fe: { over: string; as: string }, more: ProjectNode[] = []) => graphOf([shots(["s1"]), node("k", "keyframe", { forEach: fe }), ...more])
  test("alias 为 row 被拒", () => {
    const r = expandGraph(withFe({ over: "shots", as: "row" }))
    expect(r.ok).toBe(false)
    expect(r.issues[0].message).toMatch(/"row"/)
  })
  test("alias 与节点 id 重名被拒", () => {
    expect(expandGraph(withFe({ over: "shots", as: "shots" })).ok).toBe(false)
    expect(expandGraph(withFe({ over: "shots", as: "cast" }, [node("cast", "keyframe")])).ok).toBe(false)
  })
  test("嵌套 forEach 被拒（over 指向另一个 forEach 节点）", () => {
    const g = graphOf([shots(["s1"]), node("shots2", "shotlist", { forEach: { over: "shots", as: "a" } }), node("k", "keyframe", { forEach: { over: "shots2", as: "b" } })])
    const r = expandGraph(g)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => /嵌套/.test(i.message))).toBe(true)
  })
  test("over 不存在 / 不是 shotlist 被拒", () => {
    expect(expandGraph(withFe({ over: "ghost", as: "shot" })).issues[0].code).toBe("BAD_REF")
    expect(expandGraph(withFe({ over: "cast", as: "shot" }, [node("cast", "script")])).issues[0].message).toMatch(/必须是 shotlist/)
  })
})

describe("引用错误与悬空", () => {
  const bad = (params: Record<string, Json>, extra: ProjectNode[] = []) =>
    expandGraph(graphOf([shots(["s1"]), node("k", "keyframe", { forEach: { over: "shots", as: "shot" }, params }), ...extra]))
  test("缺行字段、未知节点、语法错", () => {
    expect(bad({ p: "${row.nope}" }).ok).toBe(false)
    expect(bad({ p: "${ghost}" }).issues[0].code).toBe("BAD_REF")
    expect(bad({ p: "${ row.id }" }).ok).toBe(false)
  })
  test("普通节点使用 ${row.x} 被拒", () => {
    const r = expandGraph(graphOf([shots(["s1"]), node("n", "script", { params: { text: "${row.id}" } })]))
    expect(r.ok).toBe(false)
  })
  test("未 pinned 的悬空引用=BAD_REF；pinned 的悬空=orphaned 保留，不报错", () => {
    const g1 = graphOf([node("n", "keyframe", { params: { prompt: "${gone}" } })])
    expect(expandGraph(g1).ok).toBe(false)
    const pin = { by: "user" as const, at: "t", outputsSha: [], signatureAtPin: "sig" }
    const g2 = graphOf([node("n", "keyframe", { params: { prompt: "${gone}" }, pinned: pin, outputs: [out("generated")], status: "done" })])
    const r = expandGraph(g2)
    expect(r.ok).toBe(true)
    expect(r.nodes.n.status).toBe("orphaned")
    expect(r.nodes.n.outputs.length).toBe(1)
    expect(r.orphaned).toEqual(["n"])
  })
  test("显式 inputs：同镜头表兄弟模板映射到同行实例；普通节点指向模板=扇入保留", () => {
    const g = graphOf([
      shots(["s1", "s2"]),
      node("kf", "keyframe", { forEach: { over: "shots", as: "shot" } }),
      node("cl", "clip", { forEach: { over: "shots", as: "shot" }, inputs: { first_frame: { from: "kf", port: "out" } } }),
      node("tl", "timeline", { inputs: { clips: { from: "cl" } } }),
    ])
    const r = expandGraph(g)
    expect(r.ok).toBe(true)
    expect(r.nodes["cl#s2"].inputs).toEqual({ first_frame: { from: "kf#s2", port: "out" } })
    expect(r.nodes["cl"].inputs).toEqual({ first_frame: { from: "kf", port: "out" } })
    expect(r.nodes["tl"].inputs).toEqual({ clips: { from: "cl" } })
  })
  test("改掉引用文本后，旧的派生边不残留", () => {
    const g = basic(["s1"])
    const a = expandGraph(g)
    const edited = { ...a.nodes, "cast_sheet": a.nodes["cast_sheet"], keyframe: { ...a.nodes.keyframe, params: { prompt: "${row.action}" } } }
    const b = expandGraph({ ...g, nodes: edited, order: a.order })
    expect(b.ok).toBe(true)
    expect(b.nodes["keyframe#s1"].inputs).toEqual({})
    expect(b.nodes["keyframe"].inputs).toEqual({})
  })
})

describe("row 删除 / 恢复", () => {
  test("未 pinned 实例删除；pinned、用户产物实例 → orphaned 保留；其余保持", () => {
    const g = basic(["s1", "s2", "s3", "s4"])
    const a = expandGraph(g)
    const pin = { by: "user" as const, at: "t", outputsSha: [], signatureAtPin: "x" }
    const nodes = {
      ...a.nodes,
      "keyframe#s2": { ...a.nodes["keyframe#s2"], status: "done" as const, outputs: [out("generated")] },
      "keyframe#s3": { ...a.nodes["keyframe#s3"], status: "done" as const, outputs: [out("generated")], pinned: pin },
      "keyframe#s4": { ...a.nodes["keyframe#s4"], status: "done" as const, outputs: [out("user")] },
    }
    const shotsNow = { ...nodes.shots, params: { kind: "shots", rows: rows("s1") } }
    const r = expandGraph({ ...g, nodes: { ...nodes, shots: shotsNow }, order: a.order })
    expect(r.ok).toBe(true)
    expect(r.removed.sort()).toEqual(["clip#s2", "clip#s3", "clip#s4", "keyframe#s2"])
    expect(r.nodes["keyframe#s2"]).toBeUndefined()
    expect(r.nodes["keyframe#s3"].status).toBe("orphaned")
    expect(r.nodes["keyframe#s4"].status).toBe("orphaned")
    expect(r.nodes["keyframe#s3"].outputs.length).toBe(1)
    expect(r.orphaned.sort()).toEqual(["keyframe#s3", "keyframe#s4"])
    expect(r.instances.keyframe).toEqual(["keyframe#s1"])
    // orphaned 紧跟在该模板的现存实例之后
    expect(r.order.slice(r.order.indexOf("keyframe"), r.order.indexOf("keyframe") + 4)).toEqual(["keyframe", "keyframe#s1", "keyframe#s3", "keyframe#s4"])
    expect(instancesOf({ ...g, nodes: r.nodes, order: r.order }, "keyframe")).toEqual(["keyframe#s1"])
  })

  test("row 回来：orphaned 实例复活，状态按产物/钉住推断，产物保留", () => {
    const g = basic(["s1", "s2"])
    const a = expandGraph(g)
    const pin = { by: "user" as const, at: "t", outputsSha: [], signatureAtPin: "x" }
    const orph = { ...a.nodes["keyframe#s2"], status: "orphaned" as const, outputs: [out("generated")], pinned: pin }
    const r = expandGraph({ ...g, nodes: { ...a.nodes, "keyframe#s2": orph }, order: a.order })
    expect(r.revived).toEqual(["keyframe#s2"])
    expect(r.nodes["keyframe#s2"].status).toBe("done")
    expect(r.nodes["keyframe#s2"].outputs.length).toBe(1)
    const orph2 = { ...orph, pinned: null }
    const r2 = expandGraph({ ...g, nodes: { ...a.nodes, "keyframe#s2": orph2 }, order: a.order })
    expect(r2.nodes["keyframe#s2"].status).toBe("stale")
  })

  test("模板被删：未 pinned 实例随之删除", () => {
    const g = basic(["s1"])
    const a = expandGraph(g)
    const { clip: _drop, ...rest } = a.nodes
    const r = expandGraph({ ...g, nodes: rest, order: a.order.filter((i) => i !== "clip") })
    expect(r.ok).toBe(true)
    expect(r.removed).toEqual(["clip#s1"])
    expect(r.nodes["clip#s1"]).toBeUndefined()
  })
})

describe("已有实例的运行态与 lock", () => {
  test("定义刷新、运行态保留、rev+1；改 row 数据后实例参数跟随", () => {
    const g = basic(["s1"])
    const a = expandGraph(g)
    const done = { ...a.nodes["keyframe#s1"], status: "done" as const, signature: "sig1", outputs: [out("generated")], rev: 7 }
    const shotsNow = { ...a.nodes.shots, params: { kind: "shots", rows: [{ id: "s1", action: "改后", sec: 8, nested: { a: { b: "x" } } }] } }
    const r = expandGraph({ ...g, nodes: { ...a.nodes, shots: shotsNow, "keyframe#s1": done }, order: a.order })
    const n = r.nodes["keyframe#s1"]
    expect(n.params.prompt).toBe("改后 参考 ${cast_sheet}")
    expect(n.params.seconds).toBe(8)
    expect(n.status).toBe("done")
    expect(n.signature).toBe("sig1")
    expect(n.outputs.length).toBe(1)
    expect(n.rev).toBe(8)
    expect(r.updated).toContain("keyframe#s1")
  })
  test("locked 的字段不被覆盖；locked '*' 整体不动", () => {
    const g = basic(["s1"])
    const a = expandGraph(g)
    const shotsNow = { ...a.nodes.shots, params: { kind: "shots", rows: [{ id: "s1", action: "改后", sec: 8, nested: { a: { b: "x" } } }] } }
    const lockedK = { ...a.nodes["keyframe#s1"], locked: { by: "user" as const, fields: ["params.prompt"], at: "t" } }
    const r = expandGraph({ ...g, nodes: { ...a.nodes, shots: shotsNow, "keyframe#s1": lockedK }, order: a.order })
    expect(r.nodes["keyframe#s1"].params.prompt).toBe("动作_s1 参考 ${cast_sheet}")
    expect(r.nodes["keyframe#s1"].params.seconds).toBe(8)
    const lockedAll = { ...a.nodes["keyframe#s1"], locked: { by: "user" as const, fields: "*" as const, at: "t" } }
    const r2 = expandGraph({ ...g, nodes: { ...a.nodes, shots: shotsNow, "keyframe#s1": lockedAll }, order: a.order })
    expect(r2.nodes["keyframe#s1"].params).toEqual(a.nodes["keyframe#s1"].params)
  })
  test("实例继承模板的 takes/onFail，且非法的 takes/onFail 被拒", () => {
    const g = graphOf([shots(["s1"]), node("k", "keyframe", { forEach: { over: "shots", as: "shot" }, takes: { n: 3, select: "qc", rubric: "r" }, onFail: { action: "regenerate", max: 2 } })])
    const r = expandGraph(g)
    expect(r.nodes["k#s1"].takes).toEqual({ n: 3, select: "qc", rubric: "r" })
    expect(r.nodes["k#s1"].onFail).toEqual({ action: "regenerate", max: 2 })
    const badG = graphOf([node("k", "keyframe", { takes: { n: 5, select: "qc" } }), node("j", "keyframe", { onFail: { action: "regenerate", max: 3 } })])
    const br = expandGraph(badG)
    expect(br.issues.map((i) => i.node).sort()).toEqual(["j", "k"])
  })
})

describe("性能", () => {
  test("50 行扇出（3 个模板）≤50ms", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `s${i + 1}`)
    const g = graphOf([
      node("cast_sheet", "keyframe"), shots(ids),
      node("keyframe", "keyframe", { forEach: { over: "shots", as: "shot" }, params: { prompt: "${row.action} ${cast_sheet}", seconds: "${row.sec}" } }),
      node("clip", "clip", { forEach: { over: "shots", as: "shot" }, params: { prompt: "${shot.keyframe}" } }),
      node("voice", "voice", { forEach: { over: "shots", as: "shot" }, params: { text: "${row.action}" } }),
    ])
    expandGraph(g) // 预热
    const t0 = performance.now()
    const r = expandGraph(g)
    const dt = performance.now() - t0
    expect(r.created.length).toBe(150)
    expect(dt).toBeLessThan(50)
  })
})

describe("takes / onFail 数据处理", () => {
  test("takes 校验：n∈2..4、select 枚举、rubric 类型", () => {
    expect(validateTakes(undefined)).toEqual([])
    expect(validateTakes({ n: 2, select: "first" })).toEqual([])
    expect(validateTakes({ n: 4, select: "user" })).toEqual([])
    expect(validateTakes({ n: 1, select: "qc" }).length).toBe(1)
    expect(validateTakes({ n: 5, select: "qc" }).length).toBe(1)
    expect(validateTakes({ n: 2.5, select: "qc" }).length).toBe(1)
    expect(validateTakes({ n: 3, select: "best" }).length).toBe(1)
    expect(validateTakes({ n: 3, select: "qc", rubric: "" }).length).toBe(1)
    expect(validateTakes("x").length).toBe(1)
  })
  test("onFail 校验：regenerate.max∈1..2、枚举", () => {
    expect(validateOnFail({ action: "regenerate", max: 1 })).toEqual([])
    expect(validateOnFail({ action: "regenerate", max: 2, on: "qc_fail", then: "ask_user" })).toEqual([])
    expect(validateOnFail({ action: "skip" })).toEqual([])
    expect(validateOnFail({ action: "regenerate", max: 0 }).length).toBe(1)
    expect(validateOnFail({ action: "regenerate", max: 3 }).length).toBe(1)
    expect(validateOnFail({ action: "regenerate" }).length).toBe(1)
    expect(validateOnFail({ action: "regenerate", max: 1, on: "x", then: "y" }).length).toBe(2)
    expect(validateOnFail({ action: "retry" }).length).toBe(1)
  })
  test("decideOnFail：未配置=fail；重试用尽按 then；on 不匹配按 then", () => {
    expect(decideOnFail(undefined, "error", 0)).toEqual({ do: "fail" })
    expect(decideOnFail({ action: "skip" }, "error", 0)).toEqual({ do: "skip" })
    const rg = { action: "regenerate" as const, max: 2, then: "skip" as const }
    expect(decideOnFail(rg, "error", 0)).toEqual({ do: "regenerate", retryNo: 1 })
    expect(decideOnFail(rg, "qc_fail", 1)).toEqual({ do: "regenerate", retryNo: 2 })
    expect(decideOnFail(rg, "error", 2)).toEqual({ do: "skip" })
    expect(decideOnFail({ action: "regenerate", max: 2, on: "qc_fail" }, "error", 0)).toEqual({ do: "fail" })
    expect(decideOnFail({ action: "regenerate", max: 1, on: "error", then: "ask_user" }, "error", 1)).toEqual({ do: "ask_user" })
    expect(decideOnFail({ action: "regenerate", max: 2, then: "skip" }, { kind: "error", retryable: false }, 0)).toEqual({ do: "fail" })
    expect(decideOnFail({ action: "regenerate", max: 2 }, { kind: "error", retryable: true }, 0)).toEqual({ do: "regenerate", retryNo: 1 })
    expect(decideOnFail({ action: "ask_user" }, { kind: "error", retryable: false }, 0)).toEqual({ do: "ask_user" })
  })
  test("effectiveSeed：take0 时重试 +1；takes×重试网格内互不相同", () => {
    expect(effectiveSeed(100, 0)).toBe(100)
    expect(effectiveSeed(100, 1)).toBe(101)
    expect(effectiveSeed(100, 2)).toBe(102)
    const seen = new Set<number>()
    for (let t = 0; t < 4; t++) for (let r = 0; r <= 2; r++) seen.add(effectiveSeed(100, r, t))
    expect(seen.size).toBe(12)
  })
  test("takeInRange", () => {
    expect(takeInRange({ n: 3, select: "qc" }, 0)).toBe(true)
    expect(takeInRange({ n: 3, select: "qc" }, 2)).toBe(true)
    expect(takeInRange({ n: 3, select: "qc" }, 3)).toBe(false)
    expect(takeInRange({ n: 3, select: "qc" }, -1)).toBe(false)
    expect(takeInRange(undefined, 0)).toBe(true)
    expect(takeInRange(undefined, 1)).toBe(false)
  })
  test("selectTake：qc 取最高分、同分取小序号、无分不参选；first 取最先到达；user 等人", () => {
    const o = (take: number, score?: number): Output => ({ ...out("generated"), take, ...(score === undefined ? {} : { meta: { [QC_SCORE_META_KEY]: score } }) })
    const pool = [o(2, 7), o(0, 7), o(1, 9), o(3)]
    const sel = selectTake({ n: 4, select: "qc" }, pool)
    expect(sel.kind === "selected" && sel.take).toBe(1)
    const tie = selectTake({ n: 3, select: "qc" }, [o(2, 8), o(0, 8)])
    expect(tie.kind === "selected" && tie.take).toBe(0)
    expect(selectTake({ n: 2, select: "qc" }, [o(0), o(1)]).kind).toBe("none")
    expect(selectTake({ n: 2, select: "qc" }, []).kind).toBe("none")
    const first = selectTake({ n: 3, select: "first" }, [o(2), o(0)])
    expect(first.kind === "selected" && first.take).toBe(2)
    expect(selectTake({ n: 3, select: "user" }, [o(0)]).kind).toBe("pending_user")
    expect([...groupByTake([o(1), o(1), o(0)]).keys()]).toEqual([1, 0])
  })
})
