// I7（设计文档 §8 第七行）：模板可执行率 100%——13 个配方全部过 validate、每个节点类型有执行器、
// dry_run 无 unknownPrice。
//
// 独立期望来源：
//   * 13 个模板 id 与旧可执行节点数 = 设计文档 §6 的表 + §0.3 的 66 口径（本档逐字手写）；
//   * 旧 role 集合 = 旧模板文件本身（workflow-templates 是食谱输入，不是配方实现）；
//   * 电影族 11 类 / 图片族 3 类 = 设计文档 §6 的不可牺牲清单。
import "./fixtures/env"
import "./fixtures/fake-platform"
import { assertNoForeignRequests } from "./fixtures/env"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"

/** 本档的工程目录放在共享沙箱的子目录里：不覆写进程级 WORKSPACE_DIR（bun test 各档共享模组缓存）。 */
const PROJECTS_ROOT = join(process.env.WORKSPACE_DIR!, "s18-i7-projects")

const IMAGE_MODEL = "gpt-image-2.5-flare"
const VIDEO_MODEL = "vid-test"
const API_KEY = "sk-i7-test-only"

/** 设计文档 §6 表 + §0.3：13 个旧模板 id → 旧可执行节点数（image/video/audio/film），合计 66。 */
const OLD_EXECUTABLE: Record<string, number> = {
  single_image: 1,
  character_sheet: 4,
  scene_setup: 1,
  single_video: 2,
  feature_film: 7,
  novel_film: 6,
  novel_ip: 7,
  ecom_launch: 7,
  ecom_model: 7,
  shortdrama_visual: 6,
  shortdrama_poster: 5,
  art_curation: 6,
  art_style: 7,
}
const MOVIE_FAMILY = ["single_video", "feature_film", "novel_film", "shortdrama_visual"]
const IMAGE_FAMILY = ["single_image", "scene_setup", "character_sheet", "ecom_launch", "ecom_model", "shortdrama_poster", "novel_ip", "art_curation", "art_style"]
/** 电影族必含 11 类（§6）。 */
const MOVIE_TYPES = ["script", "shotlist", "keyframe", "clip", "voice", "music", "timeline", "subtitle", "mix", "export", "qc"]
/** 图片族必含 3 类（§6）。 */
const IMAGE_TYPES = ["keyframe", "qc", "export"]

const GENERATION_TYPES = new Set(["reference", "keyframe", "clip", "voice", "music"])

const { WORKFLOW_TEMPLATES } = await import("../../workflow-templates/index.ts")
const recipes = await import("../recipes/index.ts")
const { RECIPES, getRecipe } = recipes
const { ProjectStore } = await import("../store.ts")
const { expandGraph } = await import("../expand.ts")
const { validateGraph } = await import("../validate.ts")
const { admit } = await import("../admission.ts")
const { clearExecutors, getExecutor, listExecutors } = await import("../executor-registry.ts")
const { installDefaultExecutors } = await import("../executors/index.ts")
const pricing = await import("../../pricing-gateway.ts")

let installed: ReturnType<typeof installDefaultExecutors> | null = null

beforeAll(() => {
  clearExecutors()
  installed = installDefaultExecutors()
  pricing.invalidateWorkflowPriceCatalog()
})

afterAll(() => {
  clearExecutors()
  rmSync(PROJECTS_ROOT, { recursive: true, force: true })
})

let sessionSeq = 0
function freshStore(sessionId: string) {
  return new ProjectStore(sessionId, join(PROJECTS_ROOT, sessionId), { recipes: (id) => getRecipe(id) })
}

/** 展开后的可执行节点数：forEach 模板本体不执行，实例才执行（§6 节点数下限口径）。 */
function executableNodeCount(graph: any): number {
  let count = 0
  for (const node of Object.values<any>(graph.nodes)) {
    if (node.forEach !== undefined && !node.id.includes("#")) continue
    if (GENERATION_TYPES.has(node.type)) count++
  }
  return count
}

function typesOf(nodes: readonly { type: string }[]): Set<string> {
  return new Set(nodes.map((n) => n.type))
}

/** 检验器：家族必含类型少一个就报错（反例用）。 */
function assertFamilyTypes(recipeId: string, types: ReadonlySet<string>, required: readonly string[]): void {
  const missing = required.filter((t) => !types.has(t))
  if (missing.length) throw new Error(`配方 ${recipeId} 缺少不可牺牲的节点类型：${missing.join(", ")}`)
}

/** 检验器：旧 role 必须全部有去处。 */
function assertRolesCovered(recipeId: string, oldRoles: readonly string[], map: Record<string, unknown>): void {
  const missing = oldRoles.filter((r) => !Object.prototype.hasOwnProperty.call(map, r))
  if (missing.length) throw new Error(`配方 ${recipeId} 的 legacyRoleMap 漏了 role：${missing.join(", ")}`)
}

describe("I7 模板可执行率", () => {
  test("13 个配方全部组装→校验；每个用到的节点类型都有执行器", async () => {
    expect(WORKFLOW_TEMPLATES.length).toBe(13)
    expect(Object.keys(RECIPES).length).toBe(13)
    expect(new Set(Object.keys(RECIPES))).toEqual(new Set(Object.keys(OLD_EXECUTABLE)))
    expect(Object.values(OLD_EXECUTABLE).reduce((a, b) => a + b, 0)).toBe(66)

    for (const template of WORKFLOW_TEMPLATES) {
      const recipe = RECIPES[template.id]
      expect(recipe).toBeDefined()
      const store = freshStore(`s18_i7_${template.id}_${++sessionSeq}`)
      await store.ensure()
      const applied = await store.applyPatches(
        {
          ops: [
            { op: "apply_recipe", recipe: recipe.id, params: {} },
            { op: "set_defaults", defaults: { imageModel: IMAGE_MODEL, videoModel: VIDEO_MODEL } },
          ] as never,
        },
        { kind: "agent" },
      )
      expect(applied.receipt.ok).toBe(true)
      expect(applied.receipt.rejected).toEqual([])

      const graph = await store.read()
      const expanded = expandGraph(graph as never)
      expect(expanded.ok).toBe(true)
      expect(expanded.issues).toEqual([])
      const full = { ...graph, nodes: expanded.nodes, order: expanded.order } as never
      expect(validateGraph(full).errors).toEqual([])

      // 每个配方用到的节点类型（展开后）都必须有注册执行器。
      const types = typesOf(Object.values<any>((full as any).nodes).filter((n: any) => !(n.forEach && !n.id.includes("#"))))
      for (const type of types) {
        expect(getExecutor(type as never)).not.toBeNull()
        expect(listExecutors().some((e) => e.type === type)).toBe(true)
      }
      expect(types.has("render3d")).toBe(false) // v1 不被任何配方使用，也不注册
    }
    expect(installed!.registered.length).toBe(12)
  }, 60_000)

  test("不可牺牲内容：旧 role 全映射、电影族 11 类、图片族 3 类、节点数 ≥ 旧可执行数", async () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const recipe = RECIPES[template.id]
      const built = recipe.build({})
      const oldRoles = template.nodes.map((n: any) => n.role)
      assertRolesCovered(recipe.id, oldRoles, recipe.legacyRoleMap as never)
      expect(new Set(Object.keys(recipe.legacyRoleMap))).toEqual(new Set(oldRoles))
      // 每个 role 的去处三选一：NodeId / {intentOf} / {dropped:理由}
      for (const dest of Object.values<any>(recipe.legacyRoleMap)) {
        const ok = typeof dest === "string" || (dest && typeof dest === "object" && ("intentOf" in dest || "dropped" in dest))
        expect(ok).toBe(true)
      }

      const store = freshStore(`s18_i7_built_${template.id}_${++sessionSeq}`)
      await store.ensure()
      await store.applyPatches({ ops: [{ op: "apply_recipe", recipe: recipe.id, params: {} }] as never }, { kind: "agent" })
      const graph = await store.read()
      const expanded = expandGraph(graph as never)
      expect(expanded.ok).toBe(true)
      const full = { ...graph, nodes: expanded.nodes, order: expanded.order } as never
      const types = typesOf(Object.values<any>((full as any).nodes).filter((n: any) => !(n.forEach && !n.id.includes("#"))))

      if (MOVIE_FAMILY.includes(template.id)) assertFamilyTypes(recipe.id, types, MOVIE_TYPES)
      if (IMAGE_FAMILY.includes(template.id)) assertFamilyTypes(recipe.id, types, IMAGE_TYPES)

      // 节点数下限：展开后可执行数 ≥ 设计文档写死的旧可执行数。
      const old = OLD_EXECUTABLE[template.id]
      expect(old).toBeGreaterThan(0)
      expect(executableNodeCount(full)).toBeGreaterThanOrEqual(old)
      expect(built.nodes.length).toBeGreaterThan(0)
    }
    expect(MOVIE_FAMILY.length + IMAGE_FAMILY.length).toBe(13)
  }, 60_000)

  test("dry_run：13 个配方报价均无 unknownPrice（测试价目，零真实上游）", async () => {
    pricing.invalidateWorkflowPriceCatalog()
    for (const template of WORKFLOW_TEMPLATES) {
      const recipe = RECIPES[template.id]
      const store = freshStore(`s18_i7_quote_${template.id}_${++sessionSeq}`)
      await store.ensure()
      await store.applyPatches(
        {
          ops: [
            { op: "apply_recipe", recipe: recipe.id, params: {} },
            { op: "set_defaults", defaults: { imageModel: IMAGE_MODEL, videoModel: VIDEO_MODEL } },
          ] as never,
        },
        { kind: "agent" },
      )
      const graph = await store.read()
      const expanded = expandGraph(graph as never)
      expect(expanded.ok).toBe(true)
      await store.update((g: any) => { g.nodes = expanded.nodes; g.order = expanded.order })

      const verdict = await admit({ store, deps: { session: { apiKey: API_KEY } }, dry_run: true } as never)
      expect(verdict.ok).toBe(true)
      if (verdict.ok !== true) throw new Error(`recipe ${template.id}: ${verdict.reason}`)
      expect(verdict.quote.unknownPrice).toEqual([])
      expect(verdict.quote.coins).not.toBeNull()
      expect(verdict.quote.run).toBeGreaterThan(0)
    }
    assertNoForeignRequests()
  }, 60_000)

  test("反例：抽掉 mix / 漏一个旧 role，检验器必须报错", () => {
    const types = new Set(MOVIE_TYPES.filter((t) => t !== "mix"))
    expect(() => assertFamilyTypes("fake_movie", types, MOVIE_TYPES)).toThrow(/缺少不可牺牲的节点类型：mix/)
    expect(() => assertFamilyTypes("fake_movie", new Set(MOVIE_TYPES), MOVIE_TYPES)).not.toThrow()
    expect(() => assertRolesCovered("fake", ["a", "b"], { a: "n1" })).toThrow(/漏了 role：b/)
  })
})
