// 独立期望：已审字节必须就是交付字节；旧镜头或目标变更不能沿用判决。
import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecContext, Output, ProjectGraph, ProjectNode } from "../types.ts"

const dir = mkdtempSync(join(tmpdir(), "final-candidate-"))
process.env.WORKSPACE_DIR = dir
process.env.KUNPENG_WORKSPACE = join(dir, "kunpeng")
process.env.PROJECT_PUBLIC_UPLOADS_DIR = join(dir, "public")
process.env.PROJECT_PUBLIC_BASE_URL = "https://delivery.example.test/uploads"
process.env.GATEWAY_DB_PATH = join(dir, "gateway.db")
mkdirSync(join(dir, "projects", "candidate_test", "tmp"), { recursive: true })
const { exportExecutor } = await import("./export.ts")
const { signedTestCriticVerdictOutput } = await import("./qc.fixture.ts")
const { effectiveGoalRevision, briefLedgerRevision } = await import("../digest.ts")
const { emitDeliveryCards } = await import("../delivery.ts")
const { deliverablesFromExport } = await import("../gates.ts")
const { RECIPES } = await import("../recipes/index.ts")
const { ensureProject } = await import("../store.ts")
const { upgradeLegacyVideoCandidate } = await import("../legacy-import.ts")
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function node(id: string, stage?: string): ProjectNode {
  return { id, type: "export", intent: "", params: { preset: "landscape_169", ...(stage ? { stage } : {}) }, inputs: {}, refs: [], pinned: null, status: "pending", signature: null, lastRun: null, outputs: [], rev: 1 }
}
function graph(nodes: ProjectNode[] = []): ProjectGraph {
  return { schema: 1, id: "candidate_test", sessionId: "candidate_test", version: 1, createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z", brief: [{ id: "b1", messageId: "user1", at: "2026-10-29T00:00:00Z", text: "做两秒静音动态影片" }], decisions: [], targets: { durationSec: 2, audio: "none", setBy: { kind: "user" }, at: "2026-10-29T00:00:00Z" }, defaults: {}, nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), order: nodes.map((n) => n.id), budget: { capCoins: null, spentCoins: 0, savedCoins: 0 }, activeRun: null, seq: 0 }
}
function output(file: string, mime: string, port = "out"): Output {
  const bytes = readFileSync(file)
  const sha = createHash("sha256").update(bytes).digest("hex")
  return { port, artifactId: `art_${sha.slice(0, 16)}`, path: file, mime, sha256: sha, bytes: bytes.length, origin: "derived" }
}
function context(g: ProjectGraph, n: ProjectNode, inputs: ExecContext["inputs"]): ExecContext {
  return { project: g, node: n, params: n.params, inputs, refs: [], signature: "sig", runId: "run", attempt: 0, take: 0, sessionId: g.sessionId, session: {}, signal: new AbortController().signal,
    ingest: async (src, hint) => output((src as { path: string }).path, hint?.mime ?? "application/octet-stream", hint?.port), ledger: { write: async () => {} },
    submitGeneration: async () => { throw new Error("不调用付费生成") }, execBridge: { call: async () => { throw new Error("不用bridge") }, result: async () => ({ state: "unknown" }) } }
}
function media(): Output {
  const file = join(dir, "projects", "candidate_test", "tmp", "final.mp4")
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-t", "2", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", file])
  return { ...output(file, "video/mp4"), durationSec: 2, meta: { stage: "candidate" } }
}
function publishContext(g: ProjectGraph, candidate: Output, reviewedSha = candidate.sha256): ExecContext {
  const rev = effectiveGoalRevision(g)
  candidate.meta = { ...candidate.meta, goalRevision: rev }
  const verdict = signedTestCriticVerdictOutput(dir, { parentSessionId: g.sessionId, artifactSha256: reviewedSha, goalRevision: rev, briefLedgerRevision: briefLedgerRevision(g), rubric: "film_final_critic" })
  const machineFile = join(dir, "machine.json")
  writeFileSync(machineFile, JSON.stringify({ mode: "machine", pass: true, artifactSha256: candidate.sha256, goalRevision: rev }))
  return context(g, node("export", "publish"), { candidate: [candidate], verdict: [verdict], machine: [output(machineFile, "application/json")] })
}

describe("最终候选与发布保持同一字节", () => {
  test("现有合成器先形成完整候选和可编辑包，不要旧素材判决也不公开交付", async () => {
    const g = graph()
    const n = node("candidate", "candidate")
    const res = await exportExecutor.run(context(g, n, { clips: [media()] }))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.outputs[0].mime).toBe("video/mp4")
    expect(res.outputs[0].meta?.stage).toBe("candidate")
    expect(res.outputs[0].meta?.goalRevision).toBe(effectiveGoalRevision(g))
    expect(res.outputs[0].url).toContain("https://delivery.example.test/") // 给真实感知入口，不作为最终交付。
    n.status = "done"
    n.outputs = res.outputs
    expect(deliverablesFromExport(graph([n]))).toEqual([])
    expect(res.outputs.map((o) => o.port)).toContain("jianying")
    expect(res.outputs.map((o) => o.port)).toContain("fcpxml")
  }, 30_000)
  test("旧片段判决不能放新成片；合法同候选静音片可原字节交付", async () => {
    const g = graph()
    const candidate = media()
    const wrong = await exportExecutor.run(publishContext(g, candidate, "b".repeat(64)))
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.message).toContain("候选文件")
    const accepted = await exportExecutor.run(publishContext(g, candidate))
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return
    expect(accepted.outputs[0].sha256).toBe(candidate.sha256)
    expect(createHash("sha256").update(readFileSync(accepted.outputs[0].path)).digest("hex")).toBe(candidate.sha256)
    expect(accepted.outputs[0].url).toContain("https://delivery.example.test/")
  })
  test("文件被改或目标版本被改，旧判决不能发布", async () => {
    const candidate = media()
    const g = graph()
    const ctx = publishContext(g, candidate)
    g.brief.push({ id: "b2", messageId: "user2", at: "2026-10-29T00:01:00Z", text: "改成四秒" })
    expect((await exportExecutor.run(ctx)).ok).toBe(false)
    const changed = publishContext(graph(), media())
    writeFileSync(changed.inputs.candidate[0].path, "changed bytes")
    expect((await exportExecutor.run(changed)).ok).toBe(false)
  })
  test("60秒静音的首句已被后续2秒有声要求修订，技术执行服从当前targets", async () => {
    const g = graph()
    g.brief[0].text = "做60秒静音片"
    g.brief.push({ id: "b2", messageId: "user2", at: "2026-10-29T00:01:00Z", text: "改为2秒有声音" })
    g.targets!.audio = "music"
    const tone = join(dir, "projects", "candidate_test", "tmp", "tone.wav")
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", tone])
    const res = await exportExecutor.run(context(g, node("candidate", "candidate"), { clips: [media()], audio: [output(tone, "audio/wav")] }))
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.outputs[0].meta?.hasAudio).toBe(true)
      expect(res.outputs[0].durationSec).toBeLessThan(3)
    }
  }, 30_000)
  test("候选节点与候选meta均不产生最终交付卡", () => {
    const n = node("candidate", "candidate")
    n.status = "done"
    n.outputs = [{ ...media(), url: "https://example.test/candidate.mp4" }]
    const g = graph([n])
    expect(deliverablesFromExport(g)).toEqual([])
    const emitted: string[] = []
    expect(emitDeliveryCards(undefined, g, (name) => emitted.push(name), new Set()).emitted).toBe(0)
    expect(emitted).toEqual([])
    delete n.params.stage
    expect(deliverablesFromExport(g)).toEqual([])
  })
  test("四个电影配方审完整candidate；其余图片族仍保留image_pack", () => {
    for (const id of ["single_video", "feature_film", "novel_film", "shortdrama_visual"]) {
      const built = RECIPES[id].build({})
      const byId = Object.fromEntries(built.nodes.map((n) => [n.id, n]))
      expect(byId.candidate.params?.stage).toBe("candidate")
      expect(byId.export.params?.stage).toBe("publish")
      expect(byId.qc.inputs?.final.from).toBe("candidate")
      expect(byId.qc_look.inputs?.final.from).toBe("candidate")
      expect(byId.qc_look.params?.rubric).toBe("film_final_critic")
      expect(byId.qc_look.onFail).toBeUndefined()
    }
    for (const id of ["single_image", "character_sheet", "scene_setup", "ecom_launch", "ecom_model", "shortdrama_poster", "art_curation", "art_style", "novel_ip"]) {
      expect(RECIPES[id].build({}).nodes.filter((n) => n.type === "export").every((n) => n.params?.preset === "image_pack")).toBe(true)
    }
  })
  test("四配方通过实际store.apply_recipe入口，无悬空candidate引用", async () => {
    for (const id of ["single_video", "feature_film", "novel_film", "shortdrama_visual"]) {
      const { store } = await ensureProject(`actual_apply_${id}`, { recipes: (recipeId) => RECIPES[recipeId] })
      const applied = await store.applyPatches({ ops: [{ op: "apply_recipe", recipe: id, params: {} }] }, { kind: "agent" })
      expect(applied.receipt.rejected).toEqual([])
      const actual = await store.read()
      expect(actual.nodes.qc.inputs.final.from).toBe("candidate")
      expect(actual.order.indexOf("candidate")).toBeLessThan(actual.order.indexOf("qc"))
    }
  })
  test("已知旧图原位升级幂等；制作资产/锁/targets不被覆盖", async () => {
    const built = RECIPES.single_video.build({})
    const nodes = built.nodes.filter((n) => n.id !== "candidate").map((n) => ({ ...node(n.id), ...n, params: n.params ?? {}, inputs: n.inputs ?? {} })) as ProjectNode[]
    const g = graph(nodes)
    g.templateId = "single_video"
    delete g.nodes.export.params.stage
    g.nodes.export.inputs = { clips: { from: "clip" }, timeline: { from: "timeline" }, machine: { from: "qc" }, verdict: { from: "qc_look" } }
    g.nodes.clip.locked = { by: "user", fields: ["params.prompt"], at: g.createdAt }
    const { store } = await ensureProject("legacy_candidate_test")
    await store.update((saved) => Object.assign(saved, g))
    const before = structuredClone(g.nodes.clip)
    expect((await upgradeLegacyVideoCandidate(store)).upgraded).toBe(true)
    const after = await store.read()
    expect(after.nodes.clip).toEqual(before)
    expect(after.targets).toEqual(g.targets)
    expect(after.nodes.export.params.stage).toBe("publish")
    expect(after.nodes.qc_look.inputs.final.from).toBe("candidate")
    expect((await upgradeLegacyVideoCandidate(store)).upgraded).toBe(false)
    await store.update((saved) => {
      saved.nodes.candidate.status = "done"
      saved.nodes.candidate.signature = "keep-candidate"
      saved.brief.push({ id: "status", messageId: "status", at: "2026-10-29T00:02:00Z", text: "现在进度怎么样" })
    })
    await upgradeLegacyVideoCandidate(store)
    const statusUpdate = await store.read()
    expect(statusUpdate.nodes.candidate.status).toBe("done")
    expect(statusUpdate.nodes.candidate.signature).toBe("keep-candidate")
    expect(statusUpdate.nodes.qc_look.status).toBe("stale") // 只核对新增原话，不重渲媒体。
  })
})
