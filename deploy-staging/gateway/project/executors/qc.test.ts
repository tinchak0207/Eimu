// S8c：qc 执行器测试。样例全部用本机 ffmpeg 现生成（≤10 秒），不 mock 量测。
// 期望分数来自 rubrics.ts 的 film_default 权重手算：100 起扣，单条硬缺陷 45–50 分，及格线 60。
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ArtifactStore } from "../artifacts"
import { selectTake } from "../takes"
import type { ExecContext, Json, Output, ProjectGraph, ProjectNode, Targets } from "../types"
import { applyCriticVerdict, inspectMedia, qcExecutor, scoreTakeOutput } from "./qc"

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0
const suite = hasFfmpeg ? describe : describe.skip

const DIR = mkdtempSync(join(tmpdir(), "qc-s8c-"))
const MEDIA = join(DIR, "media")
const store = new ArtifactStore({ projectDir: DIR, allowedPathRoots: [DIR] })
const ISO = "2026-10-28T00:00:00Z"
const GOOD = join(MEDIA, "good.mp4")
const NOAUDIO = join(MEDIA, "noaudio.mp4")
const SHORT = join(MEDIA, "short.mp4")
const BLACK = join(MEDIA, "black.mp4")
const LOUD = join(MEDIA, "loud.mp4")
const AUDIO_GOOD = join(MEDIA, "good.mp3")
const AUDIO_SHORT = join(MEDIA, "short.mp3")
const IMAGE_GOOD = join(MEDIA, "good.png")

const gen = (args: string[]) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { timeout: 60_000 })

const bytesOf = (file: string): number => {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

const outOf = (file: string, mime: string, take = 0): Output => ({
  port: "out",
  artifactId: "art_0123456789abcdef",
  sha256: "a".repeat(64),
  path: file,
  mime,
  bytes: bytesOf(file),
  origin: "generated",
  take,
})

const qcNode = (params: Record<string, Json> = { mode: "machine", rubric: "film_default" }, id = "qc1"): ProjectNode => ({
  id, type: "qc", intent: "", params, inputs: {}, refs: [], pinned: null, status: "pending",
  signature: null, lastRun: null, outputs: [], rev: 1,
})

const targetsOf = (durationSec: number | null, audio: Targets["audio"] = "voice"): Targets => ({
  ...(durationSec !== null ? { durationSec } : {}), audio, setBy: { kind: "user" }, at: ISO,
})

const graphOf = (nodes: ProjectNode[], targets: Targets | null = targetsOf(5)): ProjectGraph => ({
  schema: 1, id: "p1", sessionId: "s1", version: 1, createdAt: ISO, updatedAt: ISO,
  brief: [], decisions: [], targets, defaults: {},
  nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
  order: nodes.map((n) => n.id),
  budget: { capCoins: null, spentCoins: 0, savedCoins: 0 }, activeRun: null, seq: 0,
})

function ctxFor(file: string, mime: string, o: { params?: Record<string, Json>; targets?: Targets | null; take?: number } = {}): ExecContext {
  const params = o.params ?? { mode: "machine", rubric: "film_default" }
  const node = qcNode(params)
  const project = graphOf([node], o.targets === undefined ? targetsOf(5) : o.targets)
  const media = outOf(file, mime, o.take ?? 0)
  return {
    project,
    node,
    signature: "sig_qc",
    runId: "run_qc",
    attempt: 1,
    take: o.take ?? 0,
    sessionId: "s1",
    session: {},
    params: node.params,
    inputs: { media: [media] },
    refs: [],
    signal: new AbortController().signal,
    ingest: (src, hint) => store.ingest(src, hint),
    ledger: { write: async () => {} },
    submitGeneration: (async () => {
      throw new Error("qc 不应调用生成")
    }) as unknown as ExecContext["submitGeneration"],
    execBridge: {
      call: async () => {
        throw new Error("qc 不应调用 exec-bridge")
      },
      result: async () => ({ state: "unknown" as const }),
    } as ExecContext["execBridge"],
  }
}

interface MachineVerdict {
  mode: string
  rubric: string
  score: number
  pass: boolean
  deficiencies: string[]
  metrics: { kind: string; hasAudio: boolean; durationSec: number | null; lufs: number | null; truePeakDb: number | null }
}

suite("S8c qc 执行器", () => {
  beforeAll(() => {
    mkdirSync(MEDIA, { recursive: true })
    // 好样例：5s 动态画面 + 可测响度（噪声 a=0.2 实测约 -16 LUFS，真峰值约 -8 dBFS）
    gen(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=5", "-f", "lavfi", "-i", "anoisesrc=a=0.2:d=5:r=48000",
      "-t", "5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", GOOD])
    // 坏：无音轨
    gen(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=5", "-t", "5",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", NOAUDIO])
    // 坏：2s 对 5s 目标（偏差 60%）
    gen(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=2", "-f", "lavfi", "-i", "anoisesrc=a=0.2:d=2:r=48000",
      "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", SHORT])
    // 坏：全黑（黑帧同时会触发冻结检测）
    gen(["-f", "lavfi", "-i", "color=black:s=320x180:r=24:d=5", "-f", "lavfi", "-i", "anoisesrc=a=0.2:d=5:r=48000",
      "-t", "5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", BLACK])
    // 坏：响度超阈（约 -8 LUFS、真峰值约 0 dBFS）
    gen(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=5", "-f", "lavfi", "-i", "anoisesrc=a=0.5:d=5:r=48000",
      "-t", "5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", LOUD])
    // 纯音频代理：好（5s，约 -16 LUFS）与坏（2s 对 5s 目标）
    gen(["-f", "lavfi", "-i", "anoisesrc=a=0.2:d=5:r=48000", "-c:a", "libmp3lame", "-b:a", "192k", AUDIO_GOOD])
    gen(["-f", "lavfi", "-i", "anoisesrc=a=0.2:d=2:r=48000", "-c:a", "libmp3lame", "-b:a", "192k", AUDIO_SHORT])
    gen(["-f", "lavfi", "-i", "testsrc2=s=320x180", "-frames:v", "1", IMAGE_GOOD])
  }, 120_000)

  afterAll(() => rmSync(DIR, { recursive: true, force: true }))

  test("好样例（有音轨/时长对/非全黑/响度在阈）判过，且单文件 ≤30s", async () => {
    const t0 = Date.now()
    const r = await qcExecutor.run(ctxFor(GOOD, "video/mp4"))
    const elapsed = Date.now() - t0
    expect(r.ok).toBe(true)
    expect(elapsed).toBeLessThan(30_000)
    if (!r.ok) return
    const out = r.outputs[0]
    expect(out.meta?.qcScore).toBe(100)
    expect(out.mime).toBe("application/json")
    expect(out.artifactId).toMatch(/^art_[0-9a-f]{16}$/)
    const v = JSON.parse(readFileSync(out.path, "utf-8")) as MachineVerdict
    expect(v.pass).toBe(true)
    expect(v.deficiencies).toEqual([])
    expect(v.metrics.hasAudio).toBe(true)
    expect(Math.abs((v.metrics.lufs as number) - -16)).toBeLessThanOrEqual(1.5)
    expect(Math.abs((v.metrics.durationSec as number) - 5)).toBeLessThan(0.1)
  }, 60_000)

  test("坏样例：无音轨 → 判不过，deficiency 命中「无音轨」", async () => {
    const r = await qcExecutor.run(ctxFor(NOAUDIO, "video/mp4"))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe("qc_failed")
    expect(r.message).toContain("无音轨")
    expect(r.message).toContain("55/60") // 100 - noAudio(45) = 55
    const ins = await inspectMedia(outOf(NOAUDIO, "video/mp4"), { project: graphOf([qcNode()], targetsOf(5)) })
    expect(ins.score).toBe(55)
    expect(ins.deficiencies).toHaveLength(1)
    expect(ins.deficiencies[0]).toContain("无音轨")
  }, 60_000)

  test("坏样例：时长偏差 >10% → 判不过，deficiency 命中「时长」", async () => {
    const r = await qcExecutor.run(ctxFor(SHORT, "video/mp4"))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe("qc_failed")
    expect(r.message).toMatch(/时长 2\.00s 偏离目标 5s 达 60%/)
    expect(r.message).toContain("55/60") // 100 - duration(45) = 55
    const ins = await inspectMedia(outOf(SHORT, "video/mp4"), { project: graphOf([qcNode()], targetsOf(5)) })
    expect(ins.score).toBe(55)
    expect(ins.deficiencies).toHaveLength(1)
    expect(ins.deficiencies[0]).toContain("时长")
  }, 60_000)

  test("坏样例：全黑 → 判不过，deficiency 命中「全黑」", async () => {
    const r = await qcExecutor.run(ctxFor(BLACK, "video/mp4"))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe("qc_failed")
    expect(r.message).toContain("全黑")
    expect(r.message).toContain("冻结")
    expect(r.message).toContain("5/60") // 100 - black(50) - freeze(45) = 5
    const ins = await inspectMedia(outOf(BLACK, "video/mp4"), { project: graphOf([qcNode()], targetsOf(5)) })
    expect(ins.score).toBe(5)
    expect(ins.deficiencies.some((d) => d.includes("全黑"))).toBe(true)
    expect(ins.deficiencies.some((d) => d.includes("冻结"))).toBe(true)
  }, 60_000)

  test("坏样例：响度超阈 → 判不过，deficiency 命中「响度」", async () => {
    const r = await qcExecutor.run(ctxFor(LOUD, "video/mp4"))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe("qc_failed")
    expect(r.message).toContain("响度")
    expect(r.message).toContain("真峰值")
    expect(r.message).toContain("10/60") // 100 - loudness(45) - truePeak(45) = 10
    const ins = await inspectMedia(outOf(LOUD, "video/mp4"), { project: graphOf([qcNode()], targetsOf(5)) })
    expect(ins.score).toBe(10)
    expect(ins.deficiencies.some((d) => d.includes("响度"))).toBe(true)
    expect(ins.deficiencies.some((d) => d.includes("真峰值"))).toBe(true)
  }, 60_000)

  test("纯音频交付走可量测代理：mp3 好样例判过、时长不对判不过", async () => {
    const good = await qcExecutor.run(ctxFor(AUDIO_GOOD, "audio/mpeg"))
    expect(good.ok).toBe(true)
    if (good.ok) {
      const v = JSON.parse(readFileSync(good.outputs[0].path, "utf-8")) as MachineVerdict
      expect(v.metrics.kind).toBe("audio")
      expect(v.score).toBe(100)
      expect(good.outputs[0].meta?.qcScore).toBe(100)
    }
    const bad = await qcExecutor.run(ctxFor(AUDIO_SHORT, "audio/mpeg"))
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.code).toBe("qc_failed")
      expect(bad.message).toContain("时长")
    }
  }, 60_000)

  test("图片仍走 ffprobe + analyzeFilm：好图判过（不套时长/音轨要求）", async () => {
    const r = await qcExecutor.run(ctxFor(IMAGE_GOOD, "image/png"))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const v = JSON.parse(readFileSync(r.outputs[0].path, "utf-8")) as MachineVerdict
    expect(v.metrics.kind).toBe("image")
    expect(v.score).toBe(100)
  }, 60_000)

  test("文件不存在 → 判不过，deficiency 指向文件", async () => {
    const r = await qcExecutor.run(ctxFor(join(MEDIA, "missing.mp4"), "video/mp4"))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe("qc_failed")
    expect(r.message).toContain("文件不存在")
  }, 60_000)

  test("takes 选优：评分写入 meta.qcScore，select:\"qc\" 取最高分", async () => {
    const project = graphOf([qcNode()], targetsOf(5))
    const loud = await scoreTakeOutput(outOf(LOUD, "video/mp4", 0), { project })
    const good = await scoreTakeOutput(outOf(GOOD, "video/mp4", 1), { project })
    expect(loud.meta?.qcScore).toBe(10) // 100 - 45(响度) - 45(真峰值)
    expect(good.meta?.qcScore).toBe(100)
    const sel = selectTake({ n: 2, select: "qc" }, [loud, good])
    expect(sel.kind).toBe("selected")
    if (sel.kind === "selected") {
      expect(sel.take).toBe(1)
      expect(sel.score).toBe(100)
      expect(sel.outputs[0].path).toBe(GOOD)
    }
  }, 60_000)

  test("critic 回执 {score,pass,deficiencies} 经 write_result 落盘", async () => {
    const node = qcNode({ mode: "critic", rubric: "film_default" }, "qc_critic")
    const g = graphOf([node])
    const w = await applyCriticVerdict(g, "qc_critic", { score: 78, pass: true, deficiencies: [] }, { artifacts: store, runId: "run_critic" })
    expect(w.ok).toBe(true)
    if (!w.ok) return
    expect(w.graph.version).toBe(g.version + 1)
    const n = w.graph.nodes.qc_critic!
    expect(n.status).toBe("done")
    expect(n.outputs).toHaveLength(1)
    expect(n.outputs[0].mime).toBe("application/json")
    expect(JSON.parse(readFileSync(n.outputs[0].path, "utf-8"))).toEqual({ score: 78, pass: true, deficiencies: [] })
    expect(w.output.sha256).toBe(n.outputs[0].sha256)
    expect(w.verdict).toEqual({ score: 78, pass: true, deficiencies: [] })
  }, 60_000)

  test("critic 回执不合法 → 不落盘（节点与版本不变）", async () => {
    const g = graphOf([qcNode({ mode: "critic" }, "qc_critic")])
    const w = await applyCriticVerdict(g, "qc_critic", { score: "78", pass: true }, { artifacts: store })
    expect(w.ok).toBe(false)
    if (w.ok) return
    expect(w.message).toMatch(/score/)
    expect(w.graph.version).toBe(g.version)
    expect(w.graph.nodes.qc_critic!.outputs).toHaveLength(0)
  }, 60_000)

  test("critic 模式执行器不派发子代理：返回明确的接线错误", async () => {
    const r = await qcExecutor.run(ctxFor(GOOD, "video/mp4", { params: { mode: "critic" } }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe("bad_input")
    expect(r.message).toMatch(/write_result/)
  }, 60_000)
})
