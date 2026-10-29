// DSL端到端独立期望：同一镜头id/版本，改一镜只能改变该镜runner输入，未改镜头真实产物复用。
import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const sandbox = mkdtempSync(join(tmpdir(), "eimu-project-dsl-"))
process.env.WORKSPACE_DIR = join(sandbox, "workspace")
process.env.WORKSPACE_ROOT = join(sandbox, "runtime")
process.env.SESSIONS_DB_PATH = join(sandbox, "sessions.db")
process.env.LEDGER_PATH = join(sandbox, "ledger.jsonl")
process.env.HARNESS_INTERNAL_TOKEN = "dsl-test-token"
process.env.GATEWAY_URL = "http://gateway.test"
process.env.PLATFORM_API_BASE = "http://site.test/api/v1"
process.env.EIMU_TASK_JOURNAL_PATH = join(sandbox, "tool-journal.sqlite")
// 只替换鉴权外围；真实Next路由、编译器、反编译器、patch/store/run都参与。
mock.module("@/lib/biz-api-key-store", () => ({ authenticateBizApiKey: async () => ({ ok: true }) }))
mock.module("@/lib/pixai-proxy", () => ({ jsonWithTrace: (value: unknown, status: number) => Response.json(value, { status }), pixaiAuthError: () => ({ error: "unauthorized" }) }))
const { NextRequest } = await import("next/server")
const { POST } = await import("../../../src/app/api/v1/workflow/compile/route.ts")
const routes = await import("./routes.ts")
const { ensureProject, sharedProjectStore, projectDirFor } = await import("./store.ts")
const { reopenSessionsDbForTest } = await import("../job-store.ts")
reopenSessionsDbForTest()
const { resetCatalogCacheForTest } = await import("../pricing-gateway.ts")
resetCatalogCacheForTest()
const { registerExecutor } = await import("./executor-registry.ts")
const { runProject } = await import("./run.ts")
const writer = (await import("../../opencode-runtime/tools/workflow_write.ts")).default
const reader = (await import("../../opencode-runtime/tools/canvas_get_state.ts")).default
const nativeFetch = globalThis.fetch
const states = new Map<string, any>()
let compilerCalls = 0, canvasCalls = 0
let lastPatch: any
let mode: "project" | "legacy" = "project"
let stateSeq = 0
const restoreHost = routes.configureProjectRoutes({
  state: (id) => states.get(id), actor: () => ({ kind: "agent" }), owned: (_key, id) => states.get(id),
  deps: () => deps, authorized: async () => true, confirm: () => undefined,
})
const deps: any = { session: {}, ledger: { write: async () => {} }, submitGeneration: async () => { throw new Error("no paid upstream") }, execBridge: { call: async () => { throw new Error("no upstream") }, result: async () => ({ state: "unknown" }) } }
globalThis.fetch = (async (raw: any, init: any = {}) => {
  const url = new URL(typeof raw === "string" ? raw : raw.url)
  if (url.pathname === "/internal/session-key") return Response.json({ api_key: "test-fake-key" })
  if (url.pathname.startsWith("/internal/project/")) {
    const body = JSON.parse(init.body)
    if (url.pathname.endsWith("/patch")) lastPatch = body
    return routes.handleProjectInternal(new Request(url, init), url.pathname)
  }
  if (url.pathname === "/api/v1/workflow/compile") {
    compilerCalls++
    return POST(new NextRequest(url, init))
  }
  if (url.pathname === "/internal/canvas/snapshot") {
    canvasCalls++
    return Response.json({ ok: true, has_state: true, state: { nodes: [], connections: [], dsl: [] } })
  }
  throw new Error(`Unexpected external fetch ${url.pathname}`)
}) as typeof fetch
beforeEach(() => { compilerCalls = 0; canvasCalls = 0; lastPatch = undefined })
afterAll(() => { globalThis.fetch = nativeFetch; restoreHost(); rmSync(sandbox, { recursive: true, force: true }) })
const context = (sid: string) => ({ sessionID: sid, abort: new AbortController().signal }) as any
const output = (value: any) => JSON.parse(value.output)
function session(projectMode = true) {
  const sid = `dsl_${++stateSeq}`
  states.set(sid, { sessionId: sid, projectMode, seat: "creator_legacy", replayBuffer: [], eventCounter: 0, clients: new Set(), pendingConfirms: new Map(), resolvedConfirms: new Map() })
  return sid
}

test("实际Next反编译→workflow_write→同图patch→run：只改第二镜，第一镜复用，旧版本整批拒绝", async () => {
  const sid = session()
  const { store } = await ensureProject(sid)
  await store.applyPatches({ ops: [
    { op: "add_node", node: { id: "shot_a", type: "keyframe", params: { prompt: "untouched first shot", model: "test-model" } } },
    { op: "add_node", node: { id: "shot_b", type: "keyframe", params: { prompt: "second shot before", model: "test-model" } } },
  ] }, { kind: "agent" })
  const calls: string[] = []
  registerExecutor({ type: "keyframe", specVersion: 1, estimate: async () => 0, run: async (ctx: any) => {
    calls.push(`${ctx.node.id}:${ctx.params.prompt}`)
    const dir = join(store.paths.dir, "tmp"); mkdirSync(dir, { recursive: true })
    const file = join(dir, `${ctx.node.id}-${calls.length}.png`); writeFileSync(file, ctx.params.prompt)
    return { ok: true, outputs: [await ctx.ingest({ path: file }, { port: "out", mime: "image/png", origin: "generated" })], costCoins: 0 }
  } })
  await runProject(store, deps)
  const firstSha = (await store.read()).nodes.shot_a.outputs[0].sha256
  const read = output(await reader.execute({}, context(sid)))
  expect(read.target).toBe("project")
  expect(read.dsl[0].steps.map((step: any) => step.id)).toEqual(["shot_a", "shot_b"])
  const source = read.dsl[0]
  source.steps[1].params.prompt = "second shot after"
  const written = output(await writer.execute({ source }, context(sid)))
  expect(written.ok).toBe(true)
  expect(lastPatch.baseVersion).toBe(read.project_version)
  expect(canvasCalls).toBe(0)
  const rerun = await runProject(store, deps, { targets: ["shot_b"] })
  expect(rerun.status).toBe("done")
  expect(calls).toEqual(["shot_a:untouched first shot", "shot_b:second shot before", "shot_b:second shot after"])
  expect((await store.read()).nodes.shot_a.outputs[0].sha256).toBe(firstSha)
  source.steps[1].params.prompt = "stale overwrite"
  const conflict = output(await writer.execute({ source }, context(sid)))
  expect(conflict.ok).toBe(false)
  expect((await store.read()).nodes.shot_b.params.prompt).toBe("second shot after")
  expect(compilerCalls).toBeGreaterThan(2) // actual route exercised on read and writes
})

test("dry_run在未建工程时不造工程；实际写入再创建，工具/gate义务不能静默消失", async () => {
  const sid = session()
  const source = { workflow: "mv", steps: [{ id: "music", kind: "audio", tool: "music_gen", params: { prompt: "original ambient" } }] }
  expect(output(await writer.execute({ source, dry_run: true }, context(sid)))).toMatchObject({ ok: true, target: "project", dry_run: true })
  expect((await import("node:fs")).existsSync(join(projectDirFor(sid), "project.json"))).toBe(false)
  expect(output(await writer.execute({ source }, context(sid)))).toMatchObject({ ok: true, target: "project" })
  expect((await sharedProjectStore(sid).read()).nodes.music.type).toBe("music")
  const gated = output(await writer.execute({ source: { workflow: "mv", steps: [{ id: "gated", kind: "image", gate: true }] } }, context(sid)))
  expect(gated.ok).toBe(false)
  expect(JSON.stringify(gated)).toContain("gate")
  expect((await sharedProjectStore(sid).read()).nodes.gated).toBeUndefined()
})

test("明确非工程仍走旧画布；unknown不伪装成空工程", async () => {
  const sid = session(false)
  const read = output(await reader.execute({}, context(sid)))
  expect(read.ok).toBe(true)
  expect(canvasCalls).toBe(1)
  expect(compilerCalls).toBe(0)
})

test("v1文字说明卡不冒充已完成研究或剧本；实际作者责任保留", async () => {
  const sid = session()
  const source = { workflow: "mv", steps: [{ id: "research_plan", kind: "text", title: "请研究参考作品，剧本待作者写入" }] }
  const written = output(await writer.execute({ source }, context(sid)))
  expect(written.ok).toBe(true)
  const store = sharedProjectStore(sid)
  const { scriptExecutor } = await import("./executors/authored.ts")
  registerExecutor(scriptExecutor)
  const result = await runProject(store, deps)
  expect(result.status).toBe("partial")
  expect(result.awaitingAuthor).toEqual(["research_plan"])
  const graph = await store.read()
  expect(graph.nodes.research_plan.params.text).toBeUndefined()
  expect(graph.nodes.research_plan.outputs).toEqual([])
  expect(graph.nodes.research_plan.status).toBe("pending")
  expect(graph.continuation!.tasks[0]).toMatchObject({ kind: "author", owner: "orchestrator", nodes: ["research_plan"] })
  const missingResearch = output(await writer.execute({ source: { workflow: "mv", steps: [{ id: "real_research", kind: "text", tool: "search_web", title: "实际研究义务" }] } }, context(sid)))
  expect(missingResearch.ok).toBe(false)
  expect(JSON.stringify(missingResearch)).toContain("search_web")
  expect((await store.read()).nodes.real_research).toBeUndefined()
})
