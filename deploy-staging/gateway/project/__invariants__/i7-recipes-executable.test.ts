// I7：13 个配方可执行，且旧门禁 / 锁 / 审计逐模板落到节点或 rubric。
// dry_run 无 unknownPrice。validate 无 error。每个用到的节点类型有执行器。
//
// 独立期望来源（写在本档，不从实现输出回抄）：
//   * 13 个模板 id、各模板旧可执行节点数下限 = 设计文档 §6 的表（OLD_EXECUTABLE）。
//     这组数字只当下限。禁止把「表自己加起来等于 66」当成断言。
//   * 保全清单 = R4 第 1 节对照表 + S6 第 4 条（本档手写的节点 id / rubric id）。
//   * 旧 role 集合 = 旧模板文件本身（workflow-templates 是食谱输入，不是配方实现）。
//   * 电影族 11 类 / 图片族 3 类 = 设计文档 §6 的不可牺牲清单。
import "./fixtures/env"
import "./fixtures/fake-platform"
import { assertNoForeignRequests } from "./fixtures/env"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

/** 本档的工程目录放在共享沙箱的子目录里：不覆写进程级 WORKSPACE_DIR（bun test 各档共享模组缓存）。 */
const PROJECTS_ROOT = join(process.env.WORKSPACE_DIR!, "s18-i7-projects")

const IMAGE_MODEL = "gpt-image-2.5-flare"
const VIDEO_MODEL = "vid-test"
const API_KEY = "sk-i7-test-only"

/** 设计文档 §6：13 个旧模板 id → 旧可执行节点数。各模板下限，不自加。 */
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
const { reopenSessionsDbForTest } = await import("../../job-store.ts")
reopenSessionsDbForTest()
const { expandGraph } = await import("../expand.ts")
const { validateGraph } = await import("../validate.ts")
const { RUBRICS } = await import("../rubrics.ts")
const { admit } = await import("../admission.ts")
const { clearExecutors, getExecutor, listExecutors } = await import("../executor-registry.ts")
const { installDefaultExecutors } = await import("../executors/index.ts")
const pricing = await import("../../pricing-gateway.ts")
pricing.resetCatalogCacheForTest()

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

interface LiveNode {
  id: string
  type: string
  intent: string
  params: Record<string, unknown>
  inputs?: Record<string, { from?: string }>
  onFail?: { action?: string; max?: number }
  takes?: { rubric?: string }
  forEach?: unknown
}

function asNode(node: unknown): LiveNode {
  const n = node as LiveNode
  return { ...n, params: n.params ?? {}, intent: n.intent ?? "" }
}

/** qc 的 rubric id 不在表里，或 critic 没带 rubric：这条门是空的，不得算可执行。 */
function rubricIdOf(node: LiveNode): string | undefined {
  const rid = node.params.rubric
  if (typeof rid === "string" && rid !== "") return rid
  const tr = node.takes?.rubric
  if (typeof tr === "string" && tr !== "") return tr
  return undefined
}

function criticUnwired(node: LiveNode): boolean {
  if (node.type !== "qc") return false
  const rid = rubricIdOf(node)
  const mode = node.params.mode
  if (typeof rid === "string" && !Object.prototype.hasOwnProperty.call(RUBRICS, rid)) return true
  if (mode === "critic" && rid === undefined) return true
  return false
}

/** 展开后的可执行节点数：forEach 模板本体不执行，实例才执行。未接线的 critic 不计入。 */
function executableNodeCount(graph: { nodes: Record<string, unknown> }): number {
  let count = 0
  for (const raw of Object.values(graph.nodes)) {
    const node = asNode(raw)
    if (node.forEach !== undefined && !node.id.includes("#")) continue
    if (criticUnwired(node)) continue
    if (GENERATION_TYPES.has(node.type)) count++
  }
  return count
}

function nodesOf(graph: { nodes: Record<string, unknown> }): LiveNode[] {
  return Object.values(graph.nodes).map(asNode)
}

function byId(nodes: readonly LiveNode[], id: string): LiveNode | undefined {
  return nodes.find((n) => n.id === id)
}

function hasNodeId(nodes: readonly LiveNode[], id: string): boolean {
  return nodes.some((n) => n.id === id || n.id.startsWith(`${id}#`))
}

function froms(node: LiveNode | undefined): string[] {
  if (!node?.inputs) return []
  return Object.values(node.inputs).flatMap((i) => (typeof i?.from === "string" && i.from !== "" ? [i.from] : []))
}

function pointsAt(from: string, id: string): boolean {
  return from === id || from.startsWith(`${id}#`)
}

function before(order: readonly string[], earlier: string, later: string): boolean {
  const a = order.indexOf(earlier)
  const b = order.indexOf(later)
  return a >= 0 && b >= 0 && a < b
}

function qcRubricIds(nodes: readonly LiveNode[]): string[] {
  const ids: string[] = []
  for (const n of nodes) {
    if (n.type !== "qc") continue
    if (n.forEach !== undefined && !n.id.includes("#")) continue
    const rid = rubricIdOf(n)
    if (rid) ids.push(rid)
  }
  return ids
}

function rubricItemIds(rubricIds: readonly string[]): Set<string> {
  const ids = new Set<string>()
  for (const rid of rubricIds) {
    for (const item of RUBRICS[rid]?.items ?? []) ids.add(item.id)
  }
  return ids
}

/** 70 / 85 必须是独立数字，避免 170 这类串误匹配。 */
function hasBareNumber(text: string, n: number): boolean {
  return new RegExp(`(?<![0-9])${n}(?![0-9])`).test(text)
}

function rubricText(id: string): string {
  const r = RUBRICS[id]
  if (!r) return ""
  const items = r.items ?? []
  return [r.id, r.title, String(r.minScore), ...items.map((i) => `${i.id}\n${i.rule}`)].join("\n")
}

/** 文件头注释或展开后关键帧 intent。配方声明的 unsupported，不跑 3D。 */
function declaresRender3dUnsupported(recipeId: string, nodes: readonly LiveNode[]): boolean {
  const src = readFileSync(join(import.meta.dir, "..", "recipes", `${recipeId}.ts`), "utf8")
  const header = src.split("\n").slice(0, 12).join("\n")
  const headerOk = header.includes("render3d") && header.includes("unsupported")
  const intentOk = nodes.some((n) => n.type === "keyframe" && n.intent.includes("render3d") && n.intent.includes("unsupported"))
  return headerOk || intentOk
}

function requireRubric(recipeId: string, rubricId: string, nodes: readonly LiveNode[], gaps: string[]): void {
  if (!Object.prototype.hasOwnProperty.call(RUBRICS, rubricId)) gaps.push(`${recipeId}: rubrics 缺 ${rubricId}`)
  if (!qcRubricIds(nodes).includes(rubricId)) gaps.push(`${recipeId}: 展开图的 qc 没有引用 rubric ${rubricId}`)
}

function unwiredCriticGaps(recipeId: string, nodes: readonly LiveNode[]): string[] {
  const gaps: string[] = []
  for (const n of nodes) {
    if (n.type !== "qc") continue
    if (n.forEach !== undefined && !n.id.includes("#")) continue
    if (!criticUnwired(n)) continue
    const rid = rubricIdOf(n)
    gaps.push(`${recipeId}: qc ${n.id} 的 rubric「${rid ?? "(空)"}」不在 rubrics 表，不得算可执行`)
  }
  return gaps
}

/** 下游关键帧的 inputs.from 指到 sourceId（精确 id 或 sourceId#实例）。 */
function downstreamKeyframeCites(nodes: readonly LiveNode[], sourceId: string, pred?: (n: LiveNode) => boolean): boolean {
  return nodes.some((n) => {
    if (n.type !== "keyframe") return false
    if (n.id === sourceId || n.id.startsWith(`${sourceId}#`)) return false
    if (pred && !pred(n)) return false
    return froms(n).some((f) => pointsAt(f, sourceId))
  })
}

function isGarmentOrPersona(n: LiveNode): boolean {
  const role = typeof n.params.role === "string" ? n.params.role : ""
  return n.id === "garment_asset" || n.id.startsWith("garment_asset#") || n.id.startsWith("model_card") || role === "garment_asset" || role === "model_card"
}

function preservationGaps(recipeId: string, graph: { nodes: Record<string, unknown>; order: readonly string[] }): string[] {
  const nodes = nodesOf(graph)
  const gaps = unwiredCriticGaps(recipeId, nodes)
  const order = graph.order

  if (recipeId === "feature_film" || recipeId === "novel_film") {
    for (const id of ["style_anchor", "sketch", "candidate", "qc", "qc_look", "export"]) {
      if (!hasNodeId(nodes, id)) gaps.push(`${recipeId}: 缺节点 ${id}`)
    }
    if (!before(order, "qc", "export")) gaps.push(`${recipeId}: qc 不在 export 之前`)
    if (!before(order, "qc_look", "export")) gaps.push(`${recipeId}: qc_look 不在 export 之前`)
    const look = byId(nodes, "qc_look")
    // 批准的审片对象是完整最终candidate，失败必须交作者定向改素材，禁同素材自审循环。
    if (look?.params.rubric !== "film_final_critic") gaps.push(`${recipeId}: qc_look 的 rubric 不是 film_final_critic`)
    if (!Object.prototype.hasOwnProperty.call(RUBRICS, "film_final_critic")) gaps.push(`${recipeId}: rubrics 缺 film_final_critic`)
    for (const id of ["qc", "qc_look"]) {
      const n = byId(nodes, id)
      if (n?.onFail) gaps.push(`${recipeId}: ${id} 仍有本节点自动重审，缺陷应交作者返工`)
      if (!froms(n).includes("candidate")) gaps.push(`${recipeId}: ${id} 没有检查最终candidate`)
    }
    if (!before(order, "candidate", "qc") || !before(order, "candidate", "qc_look")) gaps.push(`${recipeId}: 审片发生在candidate前`)
    if (!declaresRender3dUnsupported(recipeId, nodes)) gaps.push(`${recipeId}: 文件头或关键帧 intent 没有 render3d unsupported`)
  }

  if (recipeId === "ecom_launch") {
    if (!hasNodeId(nodes, "product_card")) gaps.push("ecom_launch: 缺节点 product_card")
    if (!downstreamKeyframeCites(nodes, "product_card")) gaps.push("ecom_launch: 没有下游关键帧的 inputs 来自 product_card")
    requireRubric(recipeId, "ecom_launch", nodes, gaps)
  }

  if (recipeId === "ecom_model") {
    const locks = nodes.filter(isGarmentOrPersona).map((n) => n.id)
    const cited = nodes.some((n) => n.type === "keyframe" && !locks.includes(n.id) && froms(n).some((f) => locks.some((id) => f === id || f.startsWith(`${id}#`))))
    if (!cited) gaps.push("ecom_model: 服装锁或人设卡没有下游关键帧 ref")
    requireRubric(recipeId, "ecom_model", nodes, gaps)
  }

  if (recipeId === "shortdrama_poster") {
    if (!hasNodeId(nodes, "key_art")) gaps.push("shortdrama_poster: 缺节点 key_art")
    if (!downstreamKeyframeCites(nodes, "key_art")) gaps.push("shortdrama_poster: key_art 没有被下游关键帧引用")
    requireRubric(recipeId, "shortdrama_poster", nodes, gaps)
  }

  if (recipeId === "character_sheet") {
    if (!hasNodeId(nodes, "view_front")) gaps.push("character_sheet: 缺节点 view_front")
    const cited = nodes.some((n) => (n.id.endsWith("#side") || n.id.endsWith("#back")) && froms(n).some((f) => pointsAt(f, "view_front")))
    if (!cited) gaps.push("character_sheet: view_front 没有被侧面或背面引用")
    requireRubric(recipeId, "character_sheet", nodes, gaps)
  }

  if (recipeId === "novel_ip") {
    for (const id of ["moodboard", "style_anchor", "cover"]) {
      if (!hasNodeId(nodes, id)) gaps.push(`novel_ip: 缺节点 ${id}`)
    }
    const anchor = byId(nodes, "style_anchor")
    if (!froms(anchor).some((f) => pointsAt(f, "moodboard"))) gaps.push("novel_ip: style_anchor 的 inputs 不是来自 moodboard")
    const cover = byId(nodes, "cover")
    const coverFrom = froms(cover)
    if (coverFrom.length === 0) gaps.push("novel_ip: cover 的 inputs 是空的")
    const coverHitsKeyframe = coverFrom.some((f) => nodes.some((n) => n.id === f && n.type === "keyframe"))
    if (cover && coverFrom.length > 0 && !coverHitsKeyframe) gaps.push("novel_ip: cover 的 inputs 不是上游关键帧")
    const items = rubricItemIds(qcRubricIds(nodes))
    for (const id of ["mood_blind", "style_retest", "shuffle_recognize", "zero_drift"]) {
      if (!items.has(id)) gaps.push(`novel_ip: rubric 缺 ${id}`)
    }
  }

  if (recipeId === "art_style") {
    const cited = nodes.some((n) => {
      const hit = n.id === "copy_compare" || n.id.startsWith("copy_compare#") || n.id === "origin_set" || n.id.startsWith("origin_set#")
      return hit && froms(n).some((f) => pointsAt(f, "dna_card"))
    })
    if (!hasNodeId(nodes, "dna_card")) gaps.push("art_style: 缺节点 dna_card")
    if (!cited) gaps.push("art_style: dna_card 没有被 copy_compare 或 origin_set 引用")
    requireRubric(recipeId, "style_dna_consistency", nodes, gaps)
    const text = rubricText("style_dna_consistency")
    if (!hasBareNumber(text, 70) || !hasBareNumber(text, 85)) gaps.push("art_style: style_dna_consistency 未同时含 70 与 85")
  }

  if (recipeId === "art_curation") {
    if (!hasNodeId(nodes, "style_anchor")) gaps.push("art_curation: 缺节点 style_anchor")
    const cited = nodes.some((n) => {
      const hit = n.id === "batch_render" || n.id.startsWith("batch_render#")
        || n.id === "exhibition_visual" || n.id.startsWith("exhibition_visual#")
        || n.id === "delivery_pack" || n.id.startsWith("delivery_pack#")
      return hit && froms(n).some((f) => pointsAt(f, "style_anchor"))
    })
    if (!cited) gaps.push("art_curation: style_anchor 没有被 batch_render 或其后的展陈节点引用")
  }

  if (recipeId === "single_image" || recipeId === "scene_setup") {
    for (const id of ["keyframe", "qc", "export"]) {
      if (!hasNodeId(nodes, id)) gaps.push(`${recipeId}: 缺节点 ${id}`)
    }
    if (!before(order, "qc", "export")) gaps.push(`${recipeId}: qc 不在 export 之前`)
    // 只有一张图。不要求第二条生成边。
  }

  return gaps
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

  test("逐模板保全：旧门禁、锁、审计落到节点或 rubric；未接线的 critic 不算可执行", async () => {
    expect(Object.keys(RECIPES).sort()).toEqual(Object.keys(OLD_EXECUTABLE).sort())
    for (const template of WORKFLOW_TEMPLATES) {
      const recipe = RECIPES[template.id]
      const store = freshStore(`s18_i7_keep_${template.id}_${++sessionSeq}`)
      await store.ensure()
      const applied = await store.applyPatches(
        { ops: [{ op: "apply_recipe", recipe: recipe.id, params: {} }] as never },
        { kind: "agent" },
      )
      expect(applied.receipt.ok).toBe(true)
      const graph = await store.read()
      const expanded = expandGraph(graph as never)
      expect(expanded.ok).toBe(true)
      expect(expanded.issues).toEqual([])
      const full = { ...graph, nodes: expanded.nodes, order: expanded.order }
      expect(validateGraph(full as never).errors).toEqual([])
      const gaps = preservationGaps(template.id, full as { nodes: Record<string, unknown>; order: readonly string[] })
      expect(gaps).toEqual([])
      const old = OLD_EXECUTABLE[template.id]
      expect(executableNodeCount(full)).toBeGreaterThanOrEqual(old)
    }
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
