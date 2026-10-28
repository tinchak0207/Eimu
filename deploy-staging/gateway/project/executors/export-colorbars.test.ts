// E3：两条 lavfi 色条 + 一条正弦 + 字幕「第三镜」，走真 exportExecutor。不调用生成。
import "../__invariants__/fixtures/env"
import "../__invariants__/fixtures/fake-platform"
import { beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
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

function installFakes(): void {
  clearExecutors()
  registerExecutor({
    type: "clip",
    specVersion: 1,
    async estimate() { return 0 },
    async run(ctx: any) {
      const color = ctx.node.id === "shot_a" ? "red" : "blue"
      const file = join(scratch(ctx.sessionId), `${ctx.node.id}.mp4`)
      ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=160x120:d=1`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-t", "1", file])
      const out = await ctx.ingest({ path: file }, { port: "out", mime: "video/mp4", origin: "generated" })
      return { ok: true, outputs: [{ ...out, port: "out", durationSec: 1 }], costCoins: 0 }
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
  registerExecutor(exportExecutor)
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

    const xmlOut = (node.outputs as any[]).find((o) => o.port === "fcpxml")
    expect(xmlOut, JSON.stringify(mp4.meta)).toBeTruthy()
    const xml = readFileSync(xmlOut.path, "utf8")
    expect(xml).toContain('fcpxml version="1.10"')
    expect(xml).toContain("第三镜")
  }, 180_000)
})
