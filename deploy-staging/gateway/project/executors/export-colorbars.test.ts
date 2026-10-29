// E3：两条 lavfi 色条 + 一条正弦 + 字幕「第三镜」，走真 exportExecutor。不调用生成。
import "../__invariants__/fixtures/env"
import "../__invariants__/fixtures/fake-platform"
import { beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

process.env.PROJECT_PUBLIC_UPLOADS_DIR = join(process.env.WORKSPACE_DIR!, "public-uploads")
process.env.PROJECT_PUBLIC_BASE_URL = "http://127.0.0.1/uploads"
process.env.KUNPENG_WORKSPACE = join(process.env.WORKSPACE_DIR!, "kunpeng")
mkdirSync(process.env.PROJECT_PUBLIC_UPLOADS_DIR, { recursive: true })
mkdirSync(process.env.KUNPENG_WORKSPACE, { recursive: true })

const { registerExecutor, clearExecutors } = await import("../executor-registry.ts")
const { ensureProject } = await import("../store.ts")
const { runProject } = await import("../run.ts")
const { exportExecutor } = await import("./export.ts")
const { signedTestCriticVerdictOutput } = await import("./qc.fixture.ts")
const { effectiveGoalRevision, briefLedgerRevision } = await import("../digest.ts")
const { qcExecutor, setQcCriticDispatchForTest } = await import("./qc.ts")
const routes = await import("../routes.ts")

const SHOTS = ["shot_a", "shot_b"] as const

function requireBin(name: string): void {
  const found = spawnSync("which", [name], { encoding: "utf8" })
  if (found.status !== 0 || !found.stdout.trim()) throw new Error(`本机没有 ${name}，拒绝造假成片`)
}

function ffmpeg(args: string[]): void {
  const ran = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 20_000 })
  if (ran.status !== 0) {
    throw new Error(`ffmpeg 退出 ${String(ran.status)}：${ran.stderr || ran.stdout || ran.error?.message || ""}`)
  }
}

function scratch(sessionId: string): string {
  const dir = join(process.env.WORKSPACE_DIR!, "projects", sessionId, "tmp")
  mkdirSync(dir, { recursive: true })
  return dir
}

function rawNode(id: string, type: string, params: Record<string, unknown>, inputs: Record<string, { from: string }>) {
  return {
    id, type, intent: "", params, inputs, refs: [], pinned: null,
    status: "pending", signature: null, lastRun: null, outputs: [], rev: 1,
  }
}

function installFakes(options?: { clips: string[]; realCritic: boolean }): void {
  clearExecutors()
  registerExecutor({
    type: "clip",
    specVersion: 1,
    async estimate() { return 0 },
    async run(ctx: any) {
      options?.clips.push(ctx.node.id)
      const color = ctx.node.id === "shot_a" ? "red" : ctx.params.prompt === "第二镜改绿" ? "green" : "blue"
      const file = join(scratch(ctx.sessionId), `${ctx.node.id}.mp4`)
      ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=160x120:d=1`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-t", "1", file])
      const out = await ctx.ingest({ path: file }, { port: "out", mime: "video/mp4", origin: "generated" })
      return { ok: true, outputs: [{ ...out, port: "out", durationSec: 1 }], costCoins: options ? 0.2 : 0 }
    },
  } as never)
  registerExecutor({
    type: "mix",
    specVersion: 1,
    async estimate() { return 0 },
    async run(ctx: any) {
      const file = join(scratch(ctx.sessionId), "sine.wav")
      ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-t", "1", "-c:a", "pcm_s16le", file])
      const out = await ctx.ingest({ path: file }, { port: "out", mime: "audio/wav", origin: "generated" })
      return { ok: true, outputs: [{ ...out, port: "out", durationSec: 1 }], costCoins: 0 }
    },
  } as never)
  registerExecutor({
    type: "subtitle",
    specVersion: 1,
    async estimate() { return 0 },
    async run(ctx: any) {
      const file = join(scratch(ctx.sessionId), "caption.srt")
      writeFileSync(file, "1\n00:00:00,000 --> 00:00:02,000\n第三镜\n", "utf8")
      const out = await ctx.ingest({ path: file }, { port: "srt", mime: "text/plain", origin: "generated" })
      return { ok: true, outputs: [{ ...out, port: "srt" }], costCoins: 0 }
    },
  } as never)
  registerExecutor({
    type: "export",
    specVersion: exportExecutor.specVersion,
    estimate: (node, project, session) => exportExecutor.estimate(node, project, session),
    run: (ctx) => exportExecutor.run(ctx),
  })
  // 本例只验真实合成/可编辑工程；独立感知另测。夹具判决也必须绑定实际候选。
  registerExecutor({
    type: "qc", specVersion: 1, async estimate() { return 0 },
    async run(ctx) {
      if (options?.realCritic && ctx.params.mode === "critic") return qcExecutor.run(ctx)
      const candidate = Object.values(ctx.inputs).flat().find((o) => o.mime.startsWith("video/"))!
      const goalRevision = effectiveGoalRevision(ctx.project)
      if (ctx.params.mode === "critic") {
        const verdict = signedTestCriticVerdictOutput(scratch(ctx.sessionId), { parentSessionId: ctx.sessionId, artifactSha256: candidate.sha256, goalRevision, briefLedgerRevision: briefLedgerRevision(ctx.project), rubric: "film_final_critic" })
        return { ok: true, costCoins: 0, outputs: [await ctx.ingest({ path: verdict.path }, { port: "out", mime: "application/json", origin: "derived" })] }
      }
      const file = join(scratch(ctx.sessionId), "machine.json")
      writeFileSync(file, JSON.stringify({ mode: "machine", pass: true, artifactSha256: candidate.sha256, goalRevision }))
      return { ok: true, costCoins: 0, outputs: [await ctx.ingest({ path: file }, { port: "out", mime: "application/json", origin: "derived" })] }
    },
  })
}

beforeEach(() => {
  installFakes()
})

function makeDeps(sessionId: string) {
  const ledger: any[] = []
  const deps = {
    session: { sessionId, apiKey: "sk-e3-colorbars-test-only", opencodeSessionId: `oc-${sessionId}` },
    ledger: { write: async (e: any) => { ledger.push(e) } },
    submitGeneration: async () => ({ ok: false, code: "bad_input" as const, message: "unused", retryable: false }),
    execBridge: {
      call: async () => ({ ok: false, code: "bridge_unavailable" as const, message: "unused", retryable: false }),
      result: async () => ({ state: "unknown" as const }),
    },
  }
  return deps
}

describe("E3 色条成片", () => {
  test("最终审片缺陷经父席位交给第二镜，首镜不重做，复审发布同一候选字节", async () => {
    const clips: string[] = []
    installFakes({ clips, realCritic: true })
    const sessionId = "e3_qc_directed_rework"
    const { store } = await ensureProject(sessionId)
    await store.update((g: any) => {
      g.brief = [{ id: "b1", messageId: "user-shot-2", at: new Date().toISOString(), text: "第一镜红色保持不动，第二镜必须绿色，交付可修改的两镜影片。" }]
      g.targets = { durationSec: 2, audio: "none", setBy: { kind: "user" }, at: new Date().toISOString() }
      const nodes = [rawNode("shot_a", "clip", { prompt: "第一镜红", model: "local", seconds: 5 }, {}), rawNode("shot_b", "clip", { prompt: "第二镜蓝", model: "local", seconds: 5 }, {}), rawNode("export", "export", { preset: "landscape_169" }, { v1: { from: "shot_a" }, v2: { from: "shot_b" } })]
      for (const node of nodes) { g.nodes[node.id] = node; g.order.push(node.id) }
    })
    let reviews = 0
    setQcCriticDispatchForTest(async (req) => {
      reviews++
      const artifact = req.prompt.match(/artifact: (\S+)/)?.[1] ?? ""
      const sha = req.prompt.match(/sha256: (\S+)/)?.[1] ?? ""
      const items = [...req.prompt.matchAll(/^item ([A-Za-z0-9_]+):/gm)].map((m, index) => ({ id: m[1], pass: reviews > 1 || index > 0, evidence: reviews > 1 ? sha : "第二镜仍为蓝色，违反用户指定的绿色", nodeId: "shot_b", timecode: "00:01-00:02", sourceRequirement: "user-shot-2" }))
      // 明确的critic感知回执夹具；这条回归不冒充真实视觉模型审片。
      const frameBoard = `/tmp/critic-fixture-${reviews}.png`
      const receipt = (tool: string, callID: string, input: unknown, output: unknown) => ({ type: "tool", callID, tool, state: { status: "completed", input, output: JSON.stringify(output) } })
      const parts = [
        receipt("video_evidence", `probe-${reviews}`, { source: artifact, action: "probe" }, { ok: true, action: "probe", hasVideo: true, duration: 2, frameRate: 25 }),
        receipt("video_evidence", `frames-${reviews}`, { source: artifact, action: "tile" }, { ok: true, action: "tile", path: frameBoard, frames: [0, 0.04, 0.5, 1, 1.5, 1.9].map((at) => ({ at })) }),
        receipt("read_image", `review-${reviews}`, { image_path: frameBoard }, { ok: true, attached: true, bytes: 32, mime: "image/png" }),
      ]
      return { ok: true, subagent_id: `critic:rework-${reviews}`, session_id: "critic-rework-child", agent: "critic_p", messages: [{ info: { role: "assistant" }, parts }], verdict: { score: 90, items, evidence: [sha] } }
    })
    const notes: any[] = []
    const state: any = { sessionId, opencodeSessionId: `oc-${sessionId}`, projectMode: true, eventCounter: 0, replayBuffer: [], clients: new Set() }
    const restore = routes.configureProjectRoutes({ state: (id) => id === sessionId ? state : undefined, wakeContinuation: async (_state, note) => { notes.push(note); return "delivered" } })
    try {
      const deps = makeDeps(sessionId)
      await runProject(store, deps)
      const failed = await store.read()
      expect(failed.nodes.export.status).not.toBe("done")
      const task = failed.continuation?.tasks.find((t) => t.kind === "qc_rework")
      expect(task?.reason).toContain("quality_rework")
      expect(task?.reason).toContain("shot_b")
      expect(task?.reason).toContain("user-shot-2")
      const originalSha = failed.nodes.shot_a.outputs[0].sha256
      const candidateSha = failed.nodes.candidate.outputs[0].sha256
      expect(failed.budget.spentCoins).toBeCloseTo(0.4)
      await routes.drainProjectContinuations(sessionId)
      await routes.drainProjectContinuations(sessionId)
      expect(notes.filter((n) => n.kind === "qc_rework")).toHaveLength(1)
      expect(notes[0].text).toContain("00:01-00:02")
      const patch = await store.applyPatches({ baseVersion: (await store.read()).version, ops: [{ op: "set", node: "shot_b", path: "params.prompt", value: "第二镜改绿" }] }, { kind: "agent" })
      expect(patch.receipt.ok).toBe(true)
      await runProject(store, deps)
      const final = await store.read()
      expect(final.nodes.export.status, JSON.stringify(final.nodes.export.error)).toBe("done")
      expect(clips).toEqual(["shot_a", "shot_b", "shot_b"])
      expect(final.nodes.shot_a.outputs[0].sha256).toBe(originalSha)
      expect(final.budget.spentCoins).toBeCloseTo(0.6)
      expect(final.nodes.candidate.outputs[0].sha256).not.toBe(candidateSha)
      expect(final.nodes.export.outputs[0].sha256).toBe(final.nodes.candidate.outputs[0].sha256)
      expect(reviews).toBe(2)
    } finally { await routes.drainProjectContinuations(sessionId); restore(); setQcCriticDispatchForTest(null) }
  }, 180_000)

  test("两条色条、一条正弦、字幕第三镜：mp4 可解码，剪映 zip 与 FCPXML 都在", async () => {
    requireBin("ffmpeg")
    requireBin("ffprobe")
    requireBin("/usr/bin/unzip")
    const sessionId = "e3_colorbars"
    const { store } = await ensureProject(sessionId)
    await store.update((g: any) => {
      const nodes = [
        rawNode("shot_a", "clip", { prompt: "色条红", model: "local", seconds: 5 }, {}),
        rawNode("shot_b", "clip", { prompt: "色条蓝", model: "local", seconds: 5 }, {}),
        rawNode("tone", "mix", {}, {}),
        rawNode("caption", "subtitle", { burnIn: false }, {}),
        rawNode("export", "export", { preset: "landscape_169" }, {
          v1: { from: "shot_a" },
          v2: { from: "shot_b" },
          mix: { from: "tone" },
          cap: { from: "caption" },
        }),
      ]
      for (const node of nodes) {
        g.nodes[node.id] = node
        g.order.push(node.id)
      }
    })

    const run = await runProject(store, makeDeps(sessionId))
    const graph = await store.read()
    const node = graph.nodes.export
    const brief = {
      run: run.status,
      reason: run.reason,
      failed: run.failed,
      blocked: run.blocked,
      node: node?.status,
      error: node?.error,
      ports: (node?.outputs ?? []).map((o: any) => ({ port: o.port, mime: o.mime, meta: o.meta })),
    }
    expect(node?.status, JSON.stringify(brief)).toBe("done")

    const mp4 = (node.outputs as any[]).find((o) => o.port === "out" && String(o.mime).includes("mp4"))
    expect(mp4, JSON.stringify(brief)).toBeTruthy()
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4.path], { encoding: "utf8", timeout: 20_000 })
    expect(probe.status, probe.stderr || probe.stdout).toBe(0)
    const durationSec = Number.parseFloat(String(probe.stdout).trim())
    expect(durationSec, `ffprobe duration=${probe.stdout}`).toBeGreaterThanOrEqual(1.5)
    expect(durationSec).toBeLessThanOrEqual(3)

    const zip = (node.outputs as any[]).find((o) => o.port === "jianying")
    expect(zip, JSON.stringify(mp4.meta)).toBeTruthy()
    const unpacked = spawnSync("/usr/bin/unzip", ["-p", zip.path, "draft_content.json"], { encoding: "utf8", timeout: 20_000, maxBuffer: 32 * 1024 * 1024 })
    expect(unpacked.status, unpacked.stderr || unpacked.stdout).toBe(0)
    const draft = JSON.parse(unpacked.stdout) as { tracks?: { type?: string; segments?: { id?: string }[] }[] }
    const shotIds = (draft.tracks ?? []).filter((t) => t.type === "video").flatMap((t) => (t.segments ?? []).map((s) => s.id))
    expect(shotIds).toEqual([...SHOTS])

    const metaUnpacked = spawnSync("/usr/bin/unzip", ["-p", zip.path, "draft_meta_info.json"], { encoding: "utf8", timeout: 20_000, maxBuffer: 32 * 1024 * 1024 })
    expect(metaUnpacked.status, metaUnpacked.stderr || metaUnpacked.stdout).toBe(0)
    const meta = JSON.parse(metaUnpacked.stdout) as { draft_id?: string; tm_duration?: number }
    expect(typeof meta.draft_id).toBe("string")
    expect((meta.draft_id ?? "").length).toBeGreaterThan(8)
    expect(typeof meta.tm_duration).toBe("number")

    const xmlOut = (node.outputs as any[]).find((o) => o.port === "fcpxml")
    expect(xmlOut, JSON.stringify(mp4.meta)).toBeTruthy()
    expect(xmlOut.mime).toBe("application/zip")
    const xmlPacked = spawnSync("/usr/bin/unzip", ["-p", xmlOut.path, "export.fcpxml"], { encoding: "utf8", timeout: 20_000, maxBuffer: 32 * 1024 * 1024 })
    expect(xmlPacked.status, xmlPacked.stderr || xmlPacked.stdout).toBe(0)
    const xml = xmlPacked.stdout
    expect(xml).toContain('fcpxml version="1.10"')
    expect(xml).toContain("第三镜")
    expect(xml).not.toContain("file://")
    expect(xml).toContain("media/")
  }, 180_000)
})
