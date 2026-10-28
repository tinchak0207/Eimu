// refs.ts 单元测试：期望值来自设计文档 §3.3 的文法与规则（手写），不镜像实现。
import { describe, expect, test } from "bun:test"
import { REF_INPUT_PREFIX, listRefs, mergeInputs, newSink, remapExplicitInputs, resolveIntent, resolveString, resolveValue, scanRefs, validateAlias } from "./refs"
import type { RefContext } from "./refs"
import type { ForEach } from "./types"

const FE: ForEach = { over: "shots", as: "shot" }
const templates: Record<string, ForEach | undefined> = { keyframe: FE, clip: FE, other_fe: { over: "scenes", as: "sc" }, shots: undefined, cast_sheet: undefined, self: FE }
const lookup = { has: (id: string) => id in templates || id === "keyframe#s1", forEachOf: (id: string) => templates[id] }
const row = { id: "s1", data: { id: "s1", action: "奔跑", sec: 5, ok: true, nested: { a: { b: "深" } }, list: ["x", "y"], obj: { k: 1 }, nil: null } }
const inst: RefContext = { selfId: "self", forEach: FE, lookup, row }
const tmpl: RefContext = { selfId: "self", forEach: FE, lookup }
const plain: RefContext = { selfId: "plain", lookup }

describe("scanRefs 文法", () => {
  test("五种合法写法", () => {
    const { refs, issues } = scanRefs("${row.x} ${shot.keyframe} ${cast_sheet} ${cast_sheet.out} ${row.a.b}")
    expect(issues).toEqual([])
    expect(refs.map((r) => [r.head, r.segs])).toEqual([["row", ["x"]], ["shot", ["keyframe"]], ["cast_sheet", []], ["cast_sheet", ["out"]], ["row", ["a", "b"]]])
  })
  test("非法语法全部报错，不当字面量", () => {
    for (const bad of ["${ row.x }", "${row.}", "${.x}", "${Row.x}", "${a-b}", "${row.x", "${}", "${a..b}"]) {
      expect(scanRefs(bad).issues.length).toBeGreaterThan(0)
    }
  })
  test("listRefs 递归取出对象/数组里的引用", () => {
    const l = listRefs({ a: ["${x.out}", { b: "前缀${y}后缀" }], c: 3 })
    expect(l.map((r) => r.raw)).toEqual(["${x.out}", "${y}"])
  })
})

describe("validateAlias", () => {
  test("合法 / row / 与节点重名 / 格式错", () => {
    expect(validateAlias("shot", ["a", "b"])).toBeNull()
    expect(validateAlias("row", [])).toMatch(/row/)
    expect(validateAlias("shot", ["shot"])).toMatch(/重名/)
    expect(validateAlias("Shot", [])).toMatch(/不合法/)
    expect(validateAlias("", [])).not.toBeNull()
    expect(validateAlias(undefined, [])).not.toBeNull()
  })
})

describe("resolveString 实例模式", () => {
  const go = (t: string, ctx = inst) => { const sink = newSink(); const v = resolveString(t, ctx, sink, "p"); return { v, sink } }
  test("row 字段嵌入句子", () => {
    expect(go("镜头 ${row.id}：${row.action}，${row.sec} 秒，${row.ok}").v).toBe("镜头 s1：奔跑，5 秒，true")
  })
  test("整串单个 row 引用保留 JSON 类型", () => {
    expect(go("${row.sec}").v).toBe(5)
    expect(go("${row.ok}").v).toBe(true)
    expect(go("${row.list}").v).toEqual(["x", "y"])
    expect(go("${row.nil}").v).toBeNull()
  })
  test("嵌套字段 ${row.a.b} 与数组下标", () => {
    expect(go("${row.nested.a.b}").v).toBe("深")
    expect(go("${row.list.1}").v).toBe("y")
  })
  test("别名引用 → 规范化成同一行实例，并产出 ref: 边", () => {
    const { v, sink } = go("参考 ${shot.keyframe}")
    expect(v).toBe("参考 ${keyframe#s1}")
    expect(sink.edges.get(REF_INPUT_PREFIX + "keyframe")).toEqual({ from: "keyframe#s1" })
    const r2 = go("${shot.keyframe.out}")
    expect(r2.v).toBe("${keyframe#s1.out}")
    expect(r2.sink.edges.get(REF_INPUT_PREFIX + "keyframe.out")).toEqual({ from: "keyframe#s1", port: "out" })
  })
  test("普通节点引用文本原样、产出边；带输出口", () => {
    const a = go("${cast_sheet}")
    expect(a.v).toBe("${cast_sheet}")
    expect(a.sink.edges.get("ref:cast_sheet")).toEqual({ from: "cast_sheet" })
    const b = go("${cast_sheet.out}")
    expect(b.sink.edges.get("ref:cast_sheet.out")).toEqual({ from: "cast_sheet", port: "out" })
  })
  test("同一镜头表上的 forEach 兄弟写成 ${keyframe} 等价于 ${shot.keyframe}", () => {
    const a = go("${keyframe}")
    expect(a.v).toBe("${keyframe#s1}")
    expect(a.sink.edges.get("ref:keyframe")).toEqual({ from: "keyframe#s1" })
  })
  test("替换结果不会被再次扫描（行数据里的 ${...} 是字面量，不产生边）", () => {
    const ctx: RefContext = { ...inst, row: { id: "s2", data: { id: "s2", t: "价格 ${cast_sheet}" } } }
    const { v, sink } = go("${row.t}", ctx)
    expect(v).toBe("价格 ${cast_sheet}")
    expect(sink.edges.size).toBe(0)
  })
  test("错误：缺字段 / 对象嵌句子 / null 嵌句子 / 自引用 / 找不到 / 异构 forEach / 多余段", () => {
    const bad = (t: string, ctx = inst) => go(t, ctx).sink.issues
    expect(bad("${row.nope}")[0].message).toMatch(/没有字段 "nope"/)
    expect(bad("甲${row.obj}乙")[0].code).toBe("BAD_VALUE")
    expect(bad("甲${row.nil}乙")[0].code).toBe("BAD_VALUE")
    expect(bad("${shot.self}")[0].message).toMatch(/自己/)
    expect(bad("${shot.ghost}")[0].dangling).toBe(true)
    expect(bad("${ghost}")[0].dangling).toBe(true)
    expect(bad("${shot.other_fe}")[0].message).toMatch(/同一镜头表|没有“同一行的实例”/)
    expect(bad("${cast_sheet.out.extra}")[0].message).toMatch(/最多再跟一个输出口/)
    expect(bad("${row}")[0].message).toMatch(/row 后面要跟字段/)
    expect(bad("${row.list.9}")[0].message).toMatch(/越界/)
  })
  test("出错时返回原文本不半替换", () => {
    expect(go("甲${row.id}乙${row.nope}").v).toBe("甲${row.id}乙${row.nope}")
  })
})

describe("resolveString 模板/普通模式", () => {
  test("模板模式：row 引用保留，别名边指向模板兄弟", () => {
    const sink = newSink()
    expect(resolveString("${row.action} ${shot.keyframe}", tmpl, sink, "p")).toBe("${row.action} ${shot.keyframe}")
    expect(sink.edges.get("ref:keyframe")).toEqual({ from: "keyframe" })
    expect(sink.issues).toEqual([])
  })
  test("普通节点里的 ${row.x} 和别名都是错误", () => {
    const s1 = newSink(); resolveString("${row.x}", plain, s1, "p")
    expect(s1.issues[0].message).toMatch(/只能用在 forEach 节点/)
    const s2 = newSink(); resolveString("${shot.keyframe}", plain, s2, "p")
    expect(s2.issues.length).toBe(1)
  })
  test("普通节点引用 forEach 模板=扇入，边保留在模板上", () => {
    const sink = newSink()
    resolveString("${clip}", plain, sink, "p")
    expect(sink.edges.get("ref:clip")).toEqual({ from: "clip" })
  })
  test("两个引用指向同一 key 的不同端口不冲突；同 key 不同来源冲突", () => {
    const sink = newSink()
    resolveString("${cast_sheet} ${cast_sheet.out}", plain, sink, "p")
    expect([...sink.edges.keys()].sort()).toEqual(["ref:cast_sheet", "ref:cast_sheet.out"])
    expect(sink.issues).toEqual([])
  })
})

describe("resolveValue / resolveIntent / inputs", () => {
  test("递归替换对象与数组里的字符串，对象键不动", () => {
    const sink = newSink()
    const v = resolveValue({ "${row.id}": "k", a: ["${row.id}", { b: "x${row.id}" }], n: 1 }, inst, sink, "params")
    expect(v).toEqual({ "${row.id}": "k", a: ["s1", { b: "xs1" }], n: 1 })
  })
  test("intent 只替换 row 引用，别的原样，超 200 字截断", () => {
    const sink = newSink()
    expect(resolveIntent("镜头${row.id} 见${shot.keyframe}", inst, sink, 200)).toBe("镜头s1 见${shot.keyframe}")
    expect(Array.from(resolveIntent("字".repeat(300), inst, sink, 200)).length).toBe(200)
    expect(resolveIntent("${row.id}", plain, sink, 200)).toBe("${row.id}")
  })
  test("remapExplicitInputs：丢弃旧 ref: 键；同镜头表兄弟模板映射到同行实例；其余不动", () => {
    const out = remapExplicitInputs({ "ref:stale": { from: "x" }, frame: { from: "keyframe", port: "out" }, cast: { from: "cast_sheet" }, other: { from: "other_fe" } }, inst)
    expect(out).toEqual({ frame: { from: "keyframe#s1", port: "out" }, cast: { from: "cast_sheet" }, other: { from: "other_fe" } })
    expect(remapExplicitInputs({ frame: { from: "keyframe" } }, tmpl)).toEqual({ frame: { from: "keyframe" } })
  })
  test("mergeInputs：显式 ∪ 派生", () => {
    expect(mergeInputs({ a: { from: "x" } }, new Map([["ref:y", { from: "y" }]]))).toEqual({ a: { from: "x" }, "ref:y": { from: "y" } })
  })
})
