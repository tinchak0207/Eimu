// S11b 自验：图片/电商族配方（single_image / character_sheet / scene_setup / ecom_launch / ecom_model / shortdrama_poster）。
// 期望值来源：设计文档 §6（映射原则与族表）、S11b spec 判准、旧模板文件（role 现算，不手抄）与契约 types.ts。
// 断言：build 耗时、validateGraph 零 error、legacyRoleMap 全 role 覆盖、旧可执行全映射且新可执行数≥旧、三类齐全、无只有 intent 的节点。
import { describe, expect, test } from "bun:test"
import type { Json, NewNode, ProjectGraph, ProjectNode, Recipe, NodeType } from "../types"
import { PROJECT_SCHEMA_VERSION } from "../types"
import { validateGraph } from "../validate"
import { expandGraph } from "../expand"
import { NODE_SPECS, missingRequired } from "../specs"
import type { WorkflowTemplate } from "../../workflow-templates/types"

import { singleImageTemplate } from "../../workflow-templates/single_image"
import { characterSheetTemplate } from "../../workflow-templates/character_sheet"
import { sceneSetupTemplate } from "../../workflow-templates/scene_setup"
import { ecomLaunchTemplate } from "../../workflow-templates/ecom_launch"
import { ecomModelTemplate } from "../../workflow-templates/ecom_model"
import { shortdramaPosterTemplate } from "../../workflow-templates/shortdrama_poster"

import { singleImageRecipe } from "./single_image"
import { characterSheetRecipe } from "./character_sheet"
import { sceneSetupRecipe } from "./scene_setup"
import { ecomLaunchRecipe } from "./ecom_launch"
import { ecomModelRecipe } from "./ecom_model"
import { shortdramaPosterRecipe } from "./shortdrama_poster"

// 旧模板的可执行节点 kind（types.ts: text/config/image/video/audio/film）
const EXEC_KINDS = new Set(["image", "video", "audio", "film"])
// 新图里真正产出媒体/文本产物的节点类型（qc/export 是确定性包装，不计入"生成"数）
const GEN_TYPES = new Set<NodeType>(["keyframe", "clip", "voice", "music", "render3d"])

const PAIRS: { template: WorkflowTemplate; recipe: Recipe }[] = [
  { template: singleImageTemplate, recipe: singleImageRecipe },
  { template: characterSheetTemplate, recipe: characterSheetRecipe },
  { template: sceneSetupTemplate, recipe: sceneSetupRecipe },
  { template: ecomLaunchTemplate, recipe: ecomLaunchRecipe },
  { template: ecomModelTemplate, recipe: ecomModelRecipe },
  { template: shortdramaPosterTemplate, recipe: shortdramaPosterRecipe },
]

/** NewNode → ProjectNode（与 patch.ts opAddNode 的字段口径一致：pinned/status/signature/lastRun/outputs/rev 初始值）。 */
const nodeOf = (nn: NewNode): ProjectNode => {
  const n: ProjectNode = {
    id: nn.id, type: nn.type, intent: nn.intent ?? "", params: nn.params ?? {}, inputs: nn.inputs ?? {}, refs: nn.refs ?? [],
    pinned: null, status: "pending", signature: null, lastRun: null, outputs: [], rev: 1,
  }
  if (nn.forEach) n.forEach = nn.forEach
  if (nn.takes) n.takes = nn.takes
  if (nn.onFail) n.onFail = nn.onFail
  return n
}

const graphOf = (built: ReturnType<Recipe["build"]>): ProjectGraph => {
  const nodes: Record<string, ProjectNode> = {}
  const order: string[] = []
  for (const nn of built.nodes) { nodes[nn.id] = nodeOf(nn); order.push(nn.id) }
  return {
    schema: PROJECT_SCHEMA_VERSION, id: "p_recipe", sessionId: "s_recipe", version: 1,
    createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z",
    templateId: "", brief: [], decisions: [], targets: null, defaults: built.defaults ?? {}, nodes, order,
    budget: { capCoins: null, spentCoins: 0, savedCoins: 0 }, activeRun: null, seq: 0,
  }
}

/** forEach 模板声明的实例 id（模板 id + 行 id，设计文档 §3.3）；实例是真节点。 */
const instanceIds = (built: ReturnType<Recipe["build"]>): string[] => {
  const byId = new Map(built.nodes.map((n) => [n.id, n]))
  const out: string[] = []
  for (const n of built.nodes) {
    if (!n.forEach) continue
    const over = byId.get(n.forEach.over)
    const rows = Array.isArray(over?.params?.rows) ? (over!.params.rows as Json[]) : []
    for (const r of rows) if (r && typeof r === "object" && !Array.isArray(r) && typeof (r as { id?: unknown }).id === "string") out.push(`${n.id}#${(r as { id: string }).id}`)
  }
  return out
}

/** legacyRoleMap 目标 → 图中节点（实例 id 解析到其 forEach 模板；模板与实例 type/executor 相同）。 */
const targetOf = (g: ProjectGraph, allIds: Set<string>, to: string): ProjectNode | undefined => {
  if (g.nodes[to]) return g.nodes[to]
  if (!allIds.has(to)) return undefined
  const tpl = to.split("#")[0]
  return g.nodes[tpl]
}

/** 整图校验（模板层与展开后的实例层）：S3 校验器接受 S4 派生的 `ref:` 输入键，故不再剥键。 */

describe("校验 oracle 负向对照（证明上面的零 error 不是空转）", () => {
  test("未知参数键在模板层报 BAD_PARAM；坏行值在展开后的实例层报 BAD_PARAM", () => {
    const g = graphOf(ecomLaunchRecipe.build({}))
    g.nodes.keyframe.params.__bogus = 1
    expect(validateGraph(g).errors.some((e) => e.code === "BAD_PARAM")).toBe(true)

    const g2 = graphOf(ecomLaunchRecipe.build({}))
    const tpl = Object.values(g2.nodes).find((n) => n.forEach)!
    const items = g2.nodes[tpl.forEach!.over]
    ;(items.params.rows as { [k: string]: Json }[])[0].size = "16:9" // keyframe.size 要像素尺寸，比例应被拒
    const ex = expandGraph(g2)
    expect(ex.ok).toBe(true)
    const res = validateGraph({ ...g2, nodes: ex.nodes, order: ex.order })
    expect(res.errors.some((e) => e.code === "BAD_PARAM")).toBe(true)
  })
})

describe("S11b 图片/电商族配方", () => {
  for (const { template, recipe } of PAIRS) {
    describe(recipe.id, () => {
      const build = () => recipe.build({})
      const roles = template.nodes.map((n) => n.role)
      const execRoles = template.nodes.filter((n) => EXEC_KINDS.has(n.kind)).map((n) => n.role)

      test("build 对默认参数 ≤50ms（目标 20ms）", () => {
        build() // 预热
        let max = 0
        let sum = 0
        for (let i = 0; i < 30; i++) {
          const t0 = performance.now()
          build()
          const dt = performance.now() - t0
          max = Math.max(max, dt)
          sum += dt
        }
        console.log(`[${recipe.id}] build: avg ${(sum / 30).toFixed(2)}ms / max ${max.toFixed(2)}ms`)
        expect(max).toBeLessThan(50)
      })

      test("build 出的图 validateGraph 零 error（模板层 + 展开后实例层）", () => {
        const g = graphOf(build())
        const res = validateGraph(g)
        if (res.errors.length) console.log(`[${recipe.id}] errors`, res.errors)
        expect(res.errors).toEqual([])
        // 展开（解析 ${row.*} / 兄弟引用）：行缺字段、别名冲突、嵌套 forEach 都会在这里暴露
        const ex = expandGraph(g)
        if (!ex.ok) console.log(`[${recipe.id}] expand issues`, ex.issues)
        expect(ex.ok).toBe(true)
        const res2 = validateGraph(ex.nodes && ex.order ? { ...g, nodes: ex.nodes, order: ex.order } : g)
        if (res2.errors.length) console.log(`[${recipe.id}] instance errors`, res2.errors)
        expect(res2.errors).toEqual([])
        // 缺必需参数的节点在这条判准下等于"跑不了"，只允许 warning 不算通过
        expect(res.warnings.filter((w) => w.code === "MISSING_PARAM")).toEqual([])
      })

      test("legacyRoleMap 100% 覆盖旧模板全部 role（role 从旧模板文件现算）", () => {
        expect(roles.length).toBeGreaterThan(0)
        expect(Object.keys(recipe.legacyRoleMap).sort()).toEqual([...roles].sort())
        const g = graphOf(build())
        const allIds = new Set([...g.order, ...instanceIds(build())])
        for (const [role, to] of Object.entries(recipe.legacyRoleMap)) {
          if (typeof to === "string") {
            expect(targetOf(g, allIds, to), `${role} → ${to}`).toBeDefined()
          } else if ("intentOf" in to) {
            expect(targetOf(g, allIds, to.intentOf), `${role} → intentOf ${to.intentOf}`).toBeDefined()
          } else {
            expect(typeof to.dropped).toBe("string")
            expect(to.dropped.length).toBeGreaterThan(0)
          }
        }
      })

      test("旧可执行节点每个至少对应一个新可执行节点；新可执行数 ≥ 旧可执行数", () => {
        const built = build()
        const g = graphOf(built)
        const allIds = new Set([...g.order, ...instanceIds(built)])
        expect(execRoles.length).toBeGreaterThan(0)
        for (const role of execRoles) {
          const to = recipe.legacyRoleMap[role]
          expect(typeof to, `${role} 必须映射到具体节点（不得 dropped/intentOf）`).toBe("string")
          const target = targetOf(g, allIds, to as string)
          expect(target, `${role} → ${String(to)}`).toBeDefined()
          expect(GEN_TYPES.has(target!.type), `${role} → ${target!.type} 不是产出型节点`).toBe(true)
        }
        const ex = expandGraph(g)
        expect(ex.ok).toBe(true)
        const newExec = Object.values(ex.nodes).filter((n) => GEN_TYPES.has(n.type) && !n.forEach).length
        const oldExec = execRoles.length
        console.log(`[${recipe.id}] roles ${roles.length} | exec old ${oldExec} → new ${newExec} | rows ${instanceIds(built).length}`)
        expect(newExec).toBeGreaterThanOrEqual(oldExec)
      })

      test("含 keyframe / qc / export 三类，且没有只有 intent 没有执行器的节点", () => {
        const built = build()
        const types = new Set(built.nodes.map((n) => n.type))
        for (const t of ["keyframe", "qc", "export"] as const) expect(types.has(t), `缺 ${t}`).toBe(true)
        const g = graphOf(built)
        for (const nn of built.nodes) {
          const spec = NODE_SPECS[nn.type]
          expect(spec, `${nn.id} 类型 ${nn.type} 未注册`).toBeDefined()
          expect(typeof spec.executor).toBe("string")
          expect(spec.executor.length).toBeGreaterThan(0) // 每个节点都有执行器，不是纯说明卡
          expect((nn.intent ?? "").length, `${nn.id} 缺 intent`).toBeGreaterThan(0)
          expect(Object.keys(nn.params ?? {}).length, `${nn.id} 无参数`).toBeGreaterThan(0)
          // 物化后仍缺必需参数 = 跑不了的"说明节点"
          expect(missingRequired(nodeOf(nn), g.defaults), `${nn.id} 缺必需参数`).toEqual([])
        }
        // 行表本身必须真的有行，否则扇出为空、新执行数靠空集合达标
        for (const nn of built.nodes) {
          if (!nn.forEach) continue
          const over = g.nodes[nn.forEach.over]
          const rows = over?.params?.rows
          expect(Array.isArray(rows)).toBe(true)
          expect((rows as Json[]).length).toBeGreaterThan(0)
        }
      })
    })
  }
})
