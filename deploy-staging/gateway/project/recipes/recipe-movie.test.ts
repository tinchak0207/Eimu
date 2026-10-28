// S11a 自验：电影族 4 个配方的 role 覆盖、可执行节点数、11 类节点、build 性能、validate/expand 合法。
// 期望值来源：设计文档 §6（族表与节点数下限）、§4.2 S11a 判准、§3.5（NODE_SPECS 执行器）；
// 旧 role 清单从旧模板文件现算（不手抄）。
import { describe, expect, test } from "bun:test"
import { NODE_SPECS } from "../specs"
import type { Json, NodeId, NodeType, ProjectGraph, ProjectNode, Recipe } from "../types"
import { PROJECT_SCHEMA_VERSION } from "../types"
import { validateGraph } from "../validate"
import { expandGraph } from "../expand"
import type { WorkflowTemplate } from "../../workflow-templates/types"
import { singleVideoTemplate } from "../../workflow-templates/single_video"
import { featureFilmTemplate } from "../../workflow-templates/feature_film"
import { novelFilmTemplate } from "../../workflow-templates/novel_film"
import { shortdramaVisualTemplate } from "../../workflow-templates/shortdrama_visual"
import { singleVideoRecipe } from "./single_video"
import { featureFilmRecipe } from "./feature_film"
import { novelFilmRecipe } from "./novel_film"
import { shortdramaVisualRecipe } from "./shortdrama_visual"

const AT = "2026-10-28T00:00:00.000Z"
const OLD_EXEC_KINDS = ["image", "video", "audio", "film"] as const
// 新可执行节点＝有生成/确定性执行器（authored 的 script/shotlist 不算“执行”）
const NEW_EXEC_TYPES: NodeType[] = ["keyframe", "clip", "voice", "music", "timeline", "subtitle", "mix", "export", "qc"]
const FILM_TYPES: NodeType[] = ["script", "shotlist", "keyframe", "clip", "voice", "music", "timeline", "subtitle", "mix", "export", "qc"]
// §6 族表给的旧可执行数（独立来源：设计文档，不是本实现）
const DOC_OLD_EXEC: Record<string, number> = { feature_film: 7, novel_film: 6, shortdrama_visual: 6 }

const FAMILY: { recipe: Recipe; template: WorkflowTemplate }[] = [
  { recipe: singleVideoRecipe, template: singleVideoTemplate },
  { recipe: featureFilmRecipe, template: featureFilmTemplate },
  { recipe: novelFilmRecipe, template: novelFilmTemplate },
  { recipe: shortdramaVisualRecipe, template: shortdramaVisualTemplate },
]

function toGraph(recipe: Recipe, params: Record<string, Json> = {}): ProjectGraph {
  const built = recipe.build(params)
  const nodes: Record<NodeId, ProjectNode> = {}
  const order: NodeId[] = []
  for (const n of built.nodes) {
    if (nodes[n.id]) throw new Error(`${recipe.id}: 重复节点 id ${n.id}`)
    const node: ProjectNode = {
      id: n.id, type: n.type, intent: n.intent ?? "", params: n.params ?? {}, inputs: n.inputs ?? {}, refs: n.refs ?? [],
      pinned: null, status: "pending", signature: null, lastRun: null, outputs: [], rev: 1,
    }
    if (n.forEach) node.forEach = n.forEach
    if (n.takes) node.takes = n.takes
    if (n.onFail) node.onFail = n.onFail
    nodes[n.id] = node
    order.push(n.id)
  }
  return {
    schema: PROJECT_SCHEMA_VERSION, id: recipe.id, sessionId: recipe.id, version: 1, createdAt: AT, updatedAt: AT,
    templateId: recipe.id, brief: [], decisions: [],
    targets: built.targets ? { ...built.targets, setBy: { kind: "user" }, at: AT } : null,
    defaults: built.defaults ?? {}, nodes, order,
    budget: { capCoins: null, spentCoins: 0, savedCoins: 0 }, activeRun: null, seq: 0,
  }
}

const oldRoles = (t: WorkflowTemplate): string[] => t.nodes.map((n) => n.role)
const oldExec = (t: WorkflowTemplate) => t.nodes.filter((n) => (OLD_EXEC_KINDS as readonly string[]).includes(n.kind))
const newExec = (g: ProjectGraph) => Object.values(g.nodes).filter((n) => NEW_EXEC_TYPES.includes(n.type))
const destId = (dest: Recipe["legacyRoleMap"][string]): NodeId | null =>
  typeof dest === "string" ? dest : dest && "intentOf" in dest ? dest.intentOf : null

describe("S11a 配方：build 性能", () => {
  for (const { recipe } of FAMILY) {
    test(`${recipe.id} build() 对默认参数平均 ≤20ms（单次 ≤50ms 防抖）`, () => {
      recipe.build({})
      const runs = 20
      let sum = 0
      let max = 0
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now()
        recipe.build({})
        const dt = performance.now() - t0
        sum += dt
        if (dt > max) max = dt
      }
      expect(sum / runs).toBeLessThan(20)
      expect(max).toBeLessThan(50)
    })
  }
})

describe("S11a 配方：图合法性", () => {
  for (const { recipe } of FAMILY) {
    test(`${recipe.id} build() → 合法 ProjectGraph（validateGraph 零 error）且可展开`, () => {
      const g = toGraph(recipe)
      const r = validateGraph(g)
      expect(r.errors).toEqual([])
      expect(r.ok).toBe(true)
      const ex = expandGraph(g)
      expect(ex.issues).toEqual([])
      expect(ex.ok).toBe(true)
      expect((ex.instances.keyframe ?? []).length).toBe(g.nodes.shots.params.rows.length)
      expect((ex.instances.clip ?? []).length).toBe((ex.instances.voice ?? []).length)
    })
  }
  test("build(params) 把调用方参数落进图与 targets（非死参数）", () => {
    for (const { recipe } of FAMILY) {
      const g = toGraph(recipe, { script: "用户剧本原文", aspect: "9:16" })
      expect(g.nodes.script.params.text).toBe("用户剧本原文")
      expect(g.targets?.aspect).toBe("9:16")
      expect(g.nodes.export.params.preset).toBe("portrait_916")
      expect(g.nodes.keyframe.params.size).toBe("1024x1792")
    }
  })
})

describe("S11a 配方：legacyRoleMap 覆盖旧模板全部 role", () => {
  for (const { recipe, template } of FAMILY) {
    test(`${recipe.id}：role 清单现算，100% 有去处且无多余键`, () => {
      const roles = oldRoles(template)
      expect(new Set(roles).size).toBe(roles.length)
      expect(Object.keys(recipe.legacyRoleMap).sort()).toEqual([...roles].sort())
      const g = toGraph(recipe)
      for (const [role, dest] of Object.entries(recipe.legacyRoleMap)) {
        if (typeof dest === "string") {
          expect(g.nodes[dest]).toBeDefined()
        } else if ("intentOf" in dest) {
          expect(g.nodes[dest.intentOf]).toBeDefined()
        } else {
          expect(dest.dropped.length).toBeGreaterThan(0)
        }
        if (role.length === 0) throw new Error("空 role")
      }
    })
  }
})

describe("S11a 配方：旧可执行节点 → 新可执行节点", () => {
  for (const { recipe, template } of FAMILY) {
    test(`${recipe.id}：旧可执行数不缩水，每个旧可执行 role 有可执行去处`, () => {
      const g = toGraph(recipe)
      const olds = oldExec(template)
      const news = newExec(g)
      expect(olds.length).toBeGreaterThan(0)
      expect(news.length).toBeGreaterThanOrEqual(olds.length)
      if (DOC_OLD_EXEC[template.id] !== undefined) expect(olds.length).toBe(DOC_OLD_EXEC[template.id])
      for (const node of olds) {
        const dest = recipe.legacyRoleMap[node.role]
        const id = destId(dest)
        expect(dest && typeof dest === "object" && "dropped" in dest).toBe(false)
        expect(id).not.toBeNull()
        expect(NEW_EXEC_TYPES).toContain(g.nodes[id as NodeId].type)
      }
    })
  }
})

describe("S11a 配方：11 类节点与执行器", () => {
  for (const { recipe } of FAMILY) {
    test(`${recipe.id} 含 {script, shotlist, keyframe, clip, voice, music, timeline, subtitle, mix, export, qc}`, () => {
      const g = toGraph(recipe)
      const types = new Set(Object.values(g.nodes).map((n) => n.type))
      const missing = FILM_TYPES.filter((t) => !types.has(t))
      expect(missing).toEqual([])
    })
    test(`${recipe.id} 不含“只有 intent 没有执行器”的节点`, () => {
      const g = toGraph(recipe)
      for (const n of Object.values(g.nodes)) {
        const spec = NODE_SPECS[n.type]
        expect(spec).toBeDefined()
        expect(["materialize", "authored", "generation", "speech", "exec-bridge", "deterministic"]).toContain(spec.executor)
        expect(n.intent.length).toBeLessThanOrEqual(200)
      }
    })
  }
})
