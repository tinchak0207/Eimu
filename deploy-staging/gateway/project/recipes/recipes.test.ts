// S11z：配方总测试（设计文档 §6 / §8 I7 / §10 S11z）。
//
// 判准全部从「现场」现算，不手抄：
//   - 13 个模板 id：workflow-templates/index.ts 的 WORKFLOW_TEMPLATES；
//   - 旧 role 集合与旧可执行节点数：逐个旧模板文件的 nodes/kinds；
//   - 节点类型是否有执行器：project/executors/index.ts 的真实注册表。
// 配方组装走真实补丁路径（apply_recipe）+ S4 扇出展开；报价走 S6 admission 的 dry_run，
// 价目是本文件自起的 /v1/models 假目录，任何其它网络请求直接判失败（不碰真实上游）。
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NodeType, ProjectGraph } from "../types"

const SANDBOX = mkdtempSync(join(tmpdir(), "s11z-recipes-"))
const WORKSPACE = join(SANDBOX, "workspace")
process.env.WORKSPACE_DIR = WORKSPACE

const { WORKFLOW_TEMPLATES } = await import("../../workflow-templates/index.ts")
const recipes = await import("./index.ts")
const { RECIPES, getRecipe } = recipes
const { ProjectStore } = await import("../store.ts")
const { expandGraph } = await import("../expand.ts")
const { validateGraph } = await import("../validate.ts")
const { admit } = await import("../admission.ts")
const { clearExecutors, getExecutor, listExecutors } = await import("../executor-registry.ts")
const { defaultExecutors, installDefaultExecutors } = await import("../executors/index.ts")
const pricing = await import("../../pricing-gateway.ts")

// 13 个命名导出（与 RECIPES 必须是同一批对象）。
const NAMED_RECIPES = [
  recipes.singleImageRecipe,
  recipes.characterSheetRecipe,
  recipes.sceneSetupRecipe,
  recipes.singleVideoRecipe,
  recipes.featureFilmRecipe,
  recipes.novelFilmRecipe,
  recipes.novelIpRecipe,
  recipes.ecomLaunchRecipe,
  recipes.ecomModelRecipe,
  recipes.shortdramaVisualRecipe,
  recipes.shortdramaPosterRecipe,
  recipes.artCurationRecipe,
  recipes.artStyleRecipe,
]

const IMAGE_MODEL = "gpt-image-2.5-flare"
const VIDEO_MODEL = "vid-test"
const API_KEY = "sk-s11z-test-only"
/** 旧模板的可执行节点 = image/video/audio/film 四类（§6 节点数下限口径）。 */
const LEGACY_EXECUTABLE_KINDS = new Set(["image", "video", "audio", "film"])
/** 新图里真正提交生成的节点类型（render3d 不在内：v1 未实现）。 */
const GENERATION_TYPES = new Set<NodeType>(["reference", "keyframe", "clip", "voice", "music"])

// 测试价目：图片 0.5 币/张；视频 720p 0.3 币/秒，按「整条价」档位给出（与站点 billing 同形）。
const VIDEO_PRICES = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [String(i + 1), Math.round(0.3 * (i + 1) * 1e6) / 1e6]))
const CATALOG = {
  data: [
    { id: IMAGE_MODEL, x_coins_per_image: { standard: 0.5, hd: 1 } },
    {
      id: VIDEO_MODEL,
      x_coins_per_second: { "720p": 0.3 },
      x_capabilities: { defaultResolution: "720p", defaultAudio: false, audio: true },
      x_billing: {
        currency: "coins",
        unit: "per_video",
        prices: { "720p": VIDEO_PRICES },
        prices_with_audio: { "720p": Object.fromEntries(Object.entries(VIDEO_PRICES).map(([k, v]) => [k, v + 0.5])) },
      },
    },
  ],
}

const REAL_FETCH = globalThis.fetch
let installed: ReturnType<typeof installDefaultExecutors> | null = null
let foreignRequests = 0

beforeAll(async () => {
  clearExecutors()
  installed = installDefaultExecutors()
  // 假目录：/v1/models 返回测试价目；其它请求一律失败，证明报价链路没有真实上游。
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url?: string } | null)?.url
    if (typeof raw === "string") {
      try { if (new URL(raw).pathname === "/v1/models") return Response.json(CATALOG) } catch { /* 交给下面判失败 */ }
    }
    foreignRequests++
    throw new Error(`S11z 测试禁止真实网络请求：${String(raw)}`)
  }) as typeof fetch
  pricing.invalidateWorkflowPriceCatalog()
  expect(await pricing.catalogUnitCoins(IMAGE_MODEL, API_KEY)).toBe(0.5)
  expect(await pricing.catalogVideoPerSecondCoins(VIDEO_MODEL, API_KEY)).not.toBeNull()
})

afterAll(() => {
  globalThis.fetch = REAL_FETCH
  clearExecutors()
  rmSync(SANDBOX, { recursive: true, force: true })
})

let sessionSeq = 0
function freshStore(): InstanceType<typeof ProjectStore> {
  const sessionId = `s11z_${String(++sessionSeq).padStart(2, "0")}`
  return new ProjectStore(sessionId, join(WORKSPACE, "projects", sessionId), { recipes: (id) => getRecipe(id) })
}

/** 展开后的可执行节点数：forEach 模板本体不执行，实例才执行（§6 节点数下限）。 */
function executableNodeCount(graph: ProjectGraph): number {
  let count = 0
  for (const node of Object.values(graph.nodes)) {
    if (node.forEach !== undefined && !node.id.includes("#")) continue
    if (GENERATION_TYPES.has(node.type)) count++
  }
  return count
}

/** 展开后的节点总数（同样排除 forEach 模板本体）。 */
function totalNodeCount(graph: ProjectGraph): number {
  let count = 0
  for (const node of Object.values(graph.nodes)) {
    if (node.forEach !== undefined && !node.id.includes("#")) continue
    count++
  }
  return count
}

test("RECIPES 恰好 13 个，id 集合与 WORKFLOW_TEMPLATES 现算集合相等", () => {
  const templateIds = WORKFLOW_TEMPLATES.map((t) => t.id)
  expect(templateIds.length).toBe(13)
  expect(Object.keys(RECIPES).length).toBe(13)
  expect(new Set(Object.keys(RECIPES))).toEqual(new Set(templateIds))
  for (const id of templateIds) expect(RECIPES[id]).toBeDefined()
})

test("13 个配方逐个 named export，且与 RECIPES 是同一对象", () => {
  expect(NAMED_RECIPES.length).toBe(13)
  for (const recipe of NAMED_RECIPES) {
    expect(recipe).toBeDefined()
    expect(RECIPES[recipe.id]).toBe(recipe)
  }
})

test("真实执行器总注册：配方用到的节点类型 100% 有执行器；render3d 未注册", () => {
  expect(installed).not.toBeNull()
  const executors = defaultExecutors()
  const used = new Set<NodeType>()
  for (const recipe of Object.values(RECIPES)) for (const node of recipe.build({}).nodes) used.add(node.type)

  expect(used.has("render3d")).toBe(false)
  expect(executors.render3d).toBeUndefined()
  expect(getExecutor("render3d")).toBeNull()
  expect(listExecutors().some((e) => e.type === "render3d")).toBe(false)

  for (const type of used) {
    const executor = getExecutor(type)
    expect(executor).not.toBeNull()
    expect(executor!.type).toBe(type)
  }
  const registered = new Set(listExecutors().map((e) => e.type))
  for (const type of used) expect(registered.has(type)).toBe(true)
  expect(installed!.registered.length).toBe(Object.keys(executors).length)
  expect(installed!.registered.length).toBe(12)
  expect(typeof installed!.scoreTake).toBe("function")
})

for (const template of WORKFLOW_TEMPLATES) {
  test(`配方 ${template.id}：组装→校验、角色全映射、节点数下限、dry_run 无 unknownPrice`, async () => {
    const recipe = RECIPES[template.id]
    expect(recipe).toBeDefined()

    // build({})：每个被配方使用的节点类型都必须有真实执行器（render3d 不出现）。
    const built = recipe.build({})
    for (const node of built.nodes) expect(defaultExecutors()[node.type]).toBeDefined()

    // legacyRoleMap 覆盖旧模板全部 role（role 集合从旧模板现算，不手抄）。
    const oldRoles = template.nodes.map((n) => n.role)
    expect(new Set(Object.keys(recipe.legacyRoleMap))).toEqual(new Set(oldRoles))

    // 真实补丁路径：apply_recipe；再给报价用测试模型默认值（生产由会话设置提供）。
    const store = freshStore()
    await store.ensure()
    const applied = await store.applyPatches({
      ops: [
        { op: "apply_recipe", recipe: recipe.id, params: {} },
        { op: "set_defaults", defaults: { imageModel: IMAGE_MODEL, videoModel: VIDEO_MODEL } },
      ],
    }, { kind: "agent" })
    expect(applied.committed).toBe(true)
    expect(applied.receipt.ok).toBe(true)
    expect(applied.receipt.rejected).toEqual([])

    // 扇出展开（S4）后整图校验：零 error（ref: 派生键由 S2/S3 放行，不剥键）。
    const graph = await store.read()
    const expanded = expandGraph(graph)
    expect(expanded.ok).toBe(true)
    expect(expanded.issues).toEqual([])
    const full: ProjectGraph = { ...graph, nodes: expanded.nodes, order: expanded.order }
    expect(validateGraph(full).errors).toEqual([])

    // 节点数下限：展开后的可执行节点数 ≥ 旧模板 image/video/audio/film 节点数。
    const oldExecutable = template.nodes.filter((n) => LEGACY_EXECUTABLE_KINDS.has(n.kind)).length
    expect(oldExecutable).toBeGreaterThan(0)
    expect(executableNodeCount(full)).toBeGreaterThanOrEqual(oldExecutable)
    expect(totalNodeCount(full)).toBeGreaterThanOrEqual(oldExecutable)

    // dry_run 报价：S6 admission，测试价目，零 unknownPrice、零真实上游。
    await store.update((g) => { g.nodes = expanded.nodes; g.order = expanded.order })
    const before = foreignRequests
    const verdict = await admit({ store, deps: { session: { apiKey: API_KEY } }, dry_run: true })
    expect(foreignRequests).toBe(before)
    expect(verdict.ok).toBe(true)
    expect(verdict.quote.unknownPrice).toEqual([])
    expect(verdict.quote.coins).not.toBeNull()
  })
}
