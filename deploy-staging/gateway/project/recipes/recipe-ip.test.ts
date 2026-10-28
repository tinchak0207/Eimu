// S11c 自验：IP/策展族 3 个配方（novel_ip / art_curation / art_style）。
// 期望来自设计文档 §4.2 S11c 判准与 §6 映射原则，以及旧模板文件（现算 role / kind），不从配方实现镜像。
// 必过 6 条：build ≤20ms（放宽 50ms）/ validate 零 error / legacyRoleMap 100% / 旧可执行有对应且新可执行数≥旧 /
//             keyframe+qc+export 三类齐全 / 无「只有 intent 没有执行器」的节点。
import { describe, expect, test } from "bun:test"
import type { Json, NewNode, NodeType, PatchRequest, ProjectGraph, Recipe } from "../types"
import { PROJECT_SCHEMA_VERSION } from "../types"
import { NODE_SPECS } from "../specs"
import { validateGraph } from "../validate"
import { expandGraph } from "../expand"
import { applyPatch } from "../patch"
import type { WorkflowTemplate } from "../../workflow-templates/types"
import { novelIpTemplate } from "../../workflow-templates/novel_ip"
import { artCurationTemplate } from "../../workflow-templates/art_curation"
import { artStyleTemplate } from "../../workflow-templates/art_style"
import { novelIpRecipe } from "./novel_ip"
import { artCurationRecipe } from "./art_curation"
import { artStyleRecipe } from "./art_style"
import { RUBRICS } from "../rubrics"

const ISO = "2026-10-28T00:00:00.000Z"
const OLD_EXEC_KINDS = new Set(["image", "video", "audio", "film"])
const INTENT_MAX = 200

function emptyGraph(): ProjectGraph {
  return {
    schema: PROJECT_SCHEMA_VERSION, id: "p_s11c", sessionId: "p_s11c", version: 1, createdAt: ISO, updatedAt: ISO,
    brief: [], decisions: [], targets: null, defaults: {}, nodes: {}, order: [],
    budget: { capCoins: null, spentCoins: 0, savedCoins: 0 }, activeRun: null, seq: 0,
  }
}

/** 节点是否有执行器（authored 是模型/子代理写入，不算引擎可执行）。 */
const isExecutable = (type: NodeType): boolean => NODE_SPECS[type].executor !== "authored"

/** 旧模板 role → 新节点 id（实例 id 取模板本体）。 */
function mappedId(v: Recipe["legacyRoleMap"][string]): string | null {
  if (typeof v === "string") return v
  if ("intentOf" in v) return v.intentOf
  return null
}

/** params / inputs / forEach 声明的依赖（与 §3.3 文法一致；intent 不算依赖）。 */
function depsOf(n: NewNode): string[] {
  const deps = new Set<string>()
  for (const r of Object.values(n.inputs ?? {})) deps.add(r.from)
  if (n.forEach) deps.add(n.forEach.over)
  const visit = (v: Json | undefined): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\$\{([^{}]+)\}/g)) {
        const [head, ...segs] = m[1].split(".")
        if (head === "row") continue
        if (n.forEach && head === n.forEach.as) { if (segs[0]) deps.add(segs[0]); continue }
        deps.add(head)
      }
    } else if (Array.isArray(v)) v.forEach(visit)
    else if (v && typeof v === "object") Object.values(v).forEach(visit)
  }
  visit(n.params as Json | undefined)
  return [...deps]
}

/** build() 里的节点，或「模板#行 id」。行必须在 forEach 的 shotlist 里，展开后才有这个实例。 */
function declared(id: string, byId: Map<string, NewNode>): boolean {
  if (byId.has(id)) return true
  const hash = id.indexOf("#")
  if (hash <= 0) return false
  const tpl = byId.get(id.slice(0, hash))
  if (!tpl?.forEach) return false
  const rows = byId.get(tpl.forEach.over)?.params?.rows
  if (!Array.isArray(rows)) return false
  return rows.some((r) => !!r && typeof r === "object" && (r as { id?: unknown }).id === id.slice(hash + 1))
}

const CASES: { recipe: Recipe; tpl: WorkflowTemplate }[] = [
  { recipe: novelIpRecipe, tpl: novelIpTemplate },
  { recipe: artCurationRecipe, tpl: artCurationTemplate },
  { recipe: artStyleRecipe, tpl: artStyleTemplate },
]

for (const { recipe, tpl } of CASES) {
  describe(`配方 ${recipe.id}`, () => {
    const built = recipe.build({})
    const oldRoles = tpl.nodes.map((n) => n.role)
    const oldExec = tpl.nodes.filter((n) => OLD_EXEC_KINDS.has(n.kind))

    test("id 与旧模板一致，legacyRoleMap 覆盖全部 role 且取值合法", () => {
      expect(recipe.id).toBe(tpl.id)
      expect(Object.keys(recipe.legacyRoleMap).sort()).toEqual([...oldRoles].sort())
      for (const v of Object.values(recipe.legacyRoleMap)) {
        if (typeof v === "string") expect(v.length).toBeGreaterThan(0)
        else if ("intentOf" in v) expect(v.intentOf.length).toBeGreaterThan(0)
        else expect(v.dropped.length).toBeGreaterThan(0)
      }
    })

    test("旧可执行节点每个都映射到新可执行节点；新可执行数 ≥ 旧可执行数", () => {
      for (const old of oldExec) {
        const id = mappedId(recipe.legacyRoleMap[old.role])
        expect(id).not.toBeNull()
        const base = (id as string).split("#")[0]
        const node = built.nodes.find((n) => n.id === base)
        expect(node).toBeDefined()
        expect(isExecutable(node!.type)).toBe(true)
      }
      const newExec = built.nodes.filter((n) => isExecutable(n.type))
      expect(newExec.length).toBeGreaterThanOrEqual(oldExec.length)
    })

    test("图片族三类齐全：keyframe / qc / export", () => {
      const types = new Set(built.nodes.map((n) => n.type))
      for (const t of ["keyframe", "qc", "export"] as const) expect(types.has(t)).toBe(true)
    })

    test("无「只有 intent 没有执行器」的节点：类型有 spec、载荷非空、每个节点都通到出口", () => {
      for (const n of built.nodes) {
        expect(NODE_SPECS[n.type]).toBeDefined()
        expect(NODE_SPECS[n.type].executor.length).toBeGreaterThan(0)
        expect(Object.keys(n.params ?? {}).length).toBeGreaterThan(0)
        expect(Array.from(n.intent ?? "").length).toBeLessThanOrEqual(INTENT_MAX)
        if (n.type === "script") expect(String(n.params?.text ?? "").trim().length).toBeGreaterThan(0)
        if (n.type === "shotlist") expect((n.params?.rows as Json[] | undefined)?.length ?? 0).toBeGreaterThan(0)
        if (n.type === "keyframe") expect(String(n.params?.prompt ?? "").trim().length).toBeGreaterThan(0)
      }
      // 反向可达：每个节点都必须被某个出口（export/qc）直接或间接消费，杜绝纯装饰卡。
      const byId = new Map(built.nodes.map((n) => [n.id, n]))
      const deps = new Map<string, string[]>()
      for (const n of built.nodes) {
        const ds = depsOf(n)
        for (const d of ds) expect(declared(d, byId)).toBe(true) // 悬空引用在这里就该暴露
        deps.set(n.id, ds)
      }
      const seen = new Set<string>()
      const queue = built.nodes.filter((n) => n.type === "export" || n.type === "qc").map((n) => n.id)
      for (const q of queue) seen.add(q)
      while (queue.length) {
        const cur = queue.shift() as string
        for (const d of deps.get(cur) ?? []) if (!seen.has(d)) { seen.add(d); queue.push(d) }
      }
      for (const n of built.nodes) expect(seen.has(n.id)).toBe(true)
    })

    test("build 拼成工程图后 apply 全收、validateGraph 零 error、expand 无 issue", async () => {
      const req: PatchRequest = { ops: [{ op: "apply_recipe", recipe: recipe.id, params: {} }], atomic: true }
      const outcome = await applyPatch(emptyGraph(), req, { kind: "agent" }, {
        artifacts: {} as never,
        recipes: (id) => (id === recipe.id ? recipe : undefined),
      })
      expect(outcome.receipt.rejected).toEqual([])
      expect(outcome.receipt.ok).toBe(true)
      expect(outcome.committed).toBe(true)
      const v = validateGraph(outcome.graph)
      expect(v.errors).toEqual([])
      const ex = expandGraph(outcome.graph)
      expect(ex.issues).toEqual([])
      expect(ex.ok).toBe(true)
      // S21 起 applyPatch 内已做扇出落图（§3.3），再展开必须是幂等空操作。
      expect(ex.created).toEqual([])
      expect(Object.keys(ex.nodes).length).toBe(outcome.graph.order.length)
      // 扇出实例是真节点：每个 forEach 模板都要有实例，且展开后的可执行节点数 ≥ 旧可执行数（不许靠删节点达标）
      expect(Object.values(ex.instances).flat().length).toBeGreaterThan(0)
      const expandedExec = Object.values(ex.nodes).filter((n) => isExecutable(n.type)).length
      expect(expandedExec).toBeGreaterThanOrEqual(oldExec.length)
    })

    test("build() 上限：均值 ≤20ms，单次 ≤50ms", () => {
      for (let i = 0; i < 5; i++) recipe.build({}) // 预热
      const runs = 20
      const t0 = performance.now()
      let max = 0
      for (let i = 0; i < runs; i++) {
        const s = performance.now()
        recipe.build({})
        max = Math.max(max, performance.now() - s)
      }
      const avg = (performance.now() - t0) / runs
      expect(avg).toBeLessThanOrEqual(20)
      expect(max).toBeLessThanOrEqual(50)
    })
  })
}

const GEN_TYPES = new Set(["keyframe", "reference"])
const AUTHORED_TYPES = new Set(["script", "shotlist"])

async function baked(recipe: Recipe) {
  const outcome = await applyPatch(emptyGraph(), { ops: [{ op: "apply_recipe", recipe: recipe.id, params: {} }], atomic: true }, { kind: "agent" }, {
    artifacts: {} as never,
    recipes: (id) => (id === recipe.id ? recipe : undefined),
  })
  expect(outcome.receipt.rejected).toEqual([])
  expect(outcome.committed).toBe(true)
  return outcome.graph
}

function linked(graph: ProjectGraph, id: string, from: string): boolean {
  const node = graph.nodes[id]
  return !!node && Object.values(node.inputs).some((r) => r.from === from)
}

/** 展开后、去掉 forEach 模板本体：生成节点之间的输入边（含 ref:）。 */
function genEdges(graph: ProjectGraph): number {
  let n = 0
  for (const node of Object.values(graph.nodes)) {
    if (node.forEach && !node.id.includes("#")) continue
    if (!GEN_TYPES.has(node.type)) continue
    for (const ref of Object.values(node.inputs)) {
      const up = graph.nodes[ref.from]
      if (up && GEN_TYPES.has(up.type)) n++
    }
  }
  return n
}

function authoredRatio(graph: ProjectGraph): number {
  const exec = Object.values(graph.nodes).filter((n) => !(n.forEach && !n.id.includes("#")))
  return exec.filter((n) => AUTHORED_TYPES.has(n.type)).length / exec.length
}

function ruleOf(rubricId: string, itemId: string): string {
  return RUBRICS[rubricId]?.items?.find((item) => item.id === itemId)?.rule ?? ""
}

describe("S6 IP 链与可判定条目", () => {
  test("novel_ip：情绪板到衍生的生成边，以及四条及格线", async () => {
    expect(novelIpRecipe.build({}).nodes).toHaveLength(14)
    const g = await baked(novelIpRecipe)
    expect(linked(g, "style_anchor", "moodboard")).toBe(true)
    expect(linked(g, "char_view#front", "style_anchor")).toBe(true)
    expect(linked(g, "scene_frame#s1", "char_view")).toBe(true)
    expect(linked(g, "scene_frame#s3", "char_view")).toBe(true)
    expect(linked(g, "cover", "scene_frame")).toBe(true)
    expect(linked(g, "aspect_frame#a34", "cover")).toBe(true)
    expect(linked(g, "aspect_frame#a169", "cover")).toBe(true)
    expect(linked(g, "derivative_item#avatar", "cover")).toBe(true)
    expect(linked(g, "derivative_item#avatar", "aspect_frame")).toBe(true)
    expect(linked(g, "derivative_item#emoji", "aspect_frame")).toBe(true)
    expect(genEdges(g)).toBe(52)
    expect(authoredRatio(g)).toBeLessThanOrEqual(0.2)
    expect(g.nodes.check.onFail).toEqual({ action: "regenerate", max: 2 })
    expect(g.nodes.check.params.rubric).toBe("ip_pack_visual")
    expect(g.nodes.check.params.thresholds).toMatchObject({
      items: ["mood_blind", "style_retest", "shuffle_recognize", "zero_drift", "cover_title", "archive"],
    })
    expect(ruleOf("ip_pack_visual", "mood_blind")).toContain("盲猜 3 次")
    expect(ruleOf("ip_pack_visual", "mood_blind")).toContain("9 格至少 7 格")
    expect(ruleOf("ip_pack_visual", "style_retest")).toContain("复测 2 次")
    expect(ruleOf("ip_pack_visual", "style_retest")).toContain("色相偏移 0°")
    expect(ruleOf("ip_pack_visual", "shuffle_recognize")).toContain("9/9")
    expect(ruleOf("ip_pack_visual", "zero_drift")).toContain("不一致的张数是 0")
  })

  test("art_curation：风格锚到成组到展陈", async () => {
    expect(artCurationRecipe.build({}).nodes).toHaveLength(11)
    const g = await baked(artCurationRecipe)
    expect(linked(g, "batch_render#c1", "style_anchor")).toBe(true)
    expect(linked(g, "batch_render#c1", "composition#c1")).toBe(true)
    expect(linked(g, "batch_render#c5", "composition#c5")).toBe(true)
    expect(linked(g, "exhibition_visual", "batch_render")).toBe(true)
    expect(linked(g, "delivery_pack#print_a2", "exhibition_visual")).toBe(true)
    expect(genEdges(g)).toBe(43)
    expect(authoredRatio(g)).toBeLessThanOrEqual(0.2)
    expect(g.nodes.check.onFail).toEqual({ action: "regenerate", max: 2 })
    expect(g.nodes.check.params.thresholds).toMatchObject({
      items: ["color_temp", "light_direction", "stroke", "whitespace", "no_outlier"],
    })
  })

  test("art_style：dna_card 接到临摹、矩阵和原创，分数线写在原条目里", async () => {
    expect(artStyleRecipe.build({}).nodes).toHaveLength(13)
    const g = await baked(artStyleRecipe)
    expect(linked(g, "copy_compare#brush", "dna_card")).toBe(true)
    expect(linked(g, "copy_compare#synth_b", "dna_card")).toBe(true)
    expect(linked(g, "variant_matrix#m11", "dna_card")).toBe(true)
    expect(linked(g, "variant_matrix#m33", "dna_card")).toBe(true)
    expect(linked(g, "origin_set#o1", "dna_card")).toBe(true)
    expect(linked(g, "origin_set#o6", "dna_card")).toBe(true)
    expect(genEdges(g)).toBe(47)
    expect(authoredRatio(g)).toBeLessThanOrEqual(0.2)
    expect(g.nodes.check.onFail).toEqual({ action: "regenerate", max: 2 })
    expect(g.nodes.check.params.rubric).toBe("style_dna_consistency")
    expect(g.nodes.check.params.thresholds).toMatchObject({
      items: ["restore_70", "high_weight_85", "grid_7_of_9", "palette_steps", "composition_unique", "theme_not_copy"],
    })
    expect(ruleOf("style_dna_consistency", "restore_70")).toContain("≥ 70%")
    expect(ruleOf("style_dna_consistency", "restore_70")).toContain("中间 3 张的中位数")
    expect(ruleOf("style_dna_consistency", "high_weight_85")).toContain("≥ 85%")
    expect(ruleOf("style_dna_consistency", "high_weight_85")).toContain("3 处")
    expect(ruleOf("style_dna_consistency", "grid_7_of_9")).toContain("9 格至少 7 格")
  })
})
