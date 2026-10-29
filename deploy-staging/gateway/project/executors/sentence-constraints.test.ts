import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FIXED_CAMERA_MAX_MEAN_DELTA, measureFixedCameraDelta, parseSentenceConstraints } from "./sentence-constraints"

describe("parseSentenceConstraints", () => {
  test("无字幕、固定镜头、时长、静音", () => {
    expect(parseSentenceConstraints("没有字幕，镜头固定，5秒，静音")).toEqual({
      noSubtitles: true, fixedCamera: true, durationSec: 5, mute: true,
    })
    expect(parseSentenceConstraints("无字幕").noSubtitles).toBe(true)
    expect(parseSentenceConstraints("不要字幕").noSubtitles).toBe(true)
    expect(parseSentenceConstraints("不加字幕").noSubtitles).toBe(true)
    expect(parseSentenceConstraints("无需字幕").noSubtitles).toBe(true)
    expect(parseSentenceConstraints("固定镜头").fixedCamera).toBe(true)
    expect(parseSentenceConstraints("机位固定").fixedCamera).toBe(true)
    expect(parseSentenceConstraints("镜头不动").fixedCamera).toBe(true)
    expect(parseSentenceConstraints("静止镜头").fixedCamera).toBe(true)
    expect(parseSentenceConstraints("无声").mute).toBe(true)
    expect(parseSentenceConstraints("不要声音").mute).toBe(true)
    expect(parseSentenceConstraints("没有声音").mute).toBe(true)
    expect(parseSentenceConstraints("停 1.5 秒").durationSec).toBe(1.5)
    expect(parseSentenceConstraints("一只手放下杯子")).toEqual({
      noSubtitles: false, fixedCamera: false, durationSec: null, mute: false,
    })
  })
})

function ffmpeg(args: string[], file: string): void {
  execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args, file], { timeout: 60_000 })
}

describe("镜头固定阈值（静止帧 vs 红蓝切换）", () => {
  test("色块差为 0，低于 8；红切蓝远高于 8", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixed-cal-"))
    const still = join(dir, "still.mp4")
    const cut = join(dir, "cut.mp4")
    ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=160x120:d=1:r=30", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"], still)
    ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=160x120:d=0.5:r=30", "-f", "lavfi", "-i", "color=c=blue:s=160x120:d=0.5:r=30", "-filter_complex", "[0][1]concat=n=2:v=1:a=0", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"], cut)
    const stillDelta = await measureFixedCameraDelta(still, 1)
    const cutDelta = await measureFixedCameraDelta(cut, 1)
    expect(stillDelta.ok, JSON.stringify(stillDelta)).toBe(true)
    expect(cutDelta.ok, JSON.stringify(cutDelta)).toBe(true)
    if (!stillDelta.ok || !cutDelta.ok) return
    expect(stillDelta.maxMeanDelta).toBeLessThan(FIXED_CAMERA_MAX_MEAN_DELTA)
    expect(cutDelta.maxMeanDelta).toBeGreaterThan(FIXED_CAMERA_MAX_MEAN_DELTA)
    expect(cutDelta.maxMeanDelta).toBeGreaterThan(stillDelta.maxMeanDelta + 50)
    rmSync(dir, { recursive: true, force: true })
  })
})

const WS = mkdtempSync(join(tmpdir(), "sentence-export-"))
process.env.WORKSPACE_DIR = WS
process.env.KUNPENG_WORKSPACE = join(WS, "kunpeng")
process.env.HOME = join(WS, "home")
process.env.PROJECT_PUBLIC_UPLOADS_DIR = join(WS, "uploads")
process.env.PROJECT_PUBLIC_BASE_URL = "https://example.test/uploads"

const { mkdirSync } = await import("node:fs")
mkdirSync(process.env.HOME, { recursive: true })
mkdirSync(process.env.PROJECT_PUBLIC_UPLOADS_DIR, { recursive: true })

const { ArtifactStore } = await import("../artifacts")
const { exportExecutor } = await import("./export")
const { signedTestCriticVerdictOutput } = await import("./qc.fixture")
const { evaluateSentenceConstraints } = await import("./sentence-constraints")

const SID = "sentence-export"
const MEDIA = join(WS, "projects", SID, "media")
mkdirSync(MEDIA, { recursive: true })
const store = new ArtifactStore({ projectDir: join(WS, "projects", SID) })

function makeCtx(opts: { brief?: string; inputs: Record<string, import("../types").Output[]>; nodes?: import("../types").ProjectNode[] }) {
  const node: import("../types").ProjectNode = {
    id: "export_sentence",
    type: "export",
    intent: "",
    params: { preset: "cinema_239" },
    inputs: {},
    refs: [],
    pinned: null,
    status: "pending",
    signature: null,
    lastRun: null,
    outputs: [],
    rev: 1,
  }
  const nodes: Record<string, import("../types").ProjectNode> = { [node.id]: node }
  for (const extra of opts.nodes ?? []) nodes[extra.id] = extra
  const media = Object.values(opts.inputs).flat().find((o) => /^(video|image)\//.test(o.mime))
  const inputs = media
    ? { ...opts.inputs, verdict: [signedTestCriticVerdictOutput(MEDIA, { parentSessionId: SID, artifactSha256: media.sha256, rubric: "film_frame_critic" })] }
    : opts.inputs
  const project: import("../types").ProjectGraph = {
    schema: 1,
    id: SID,
    sessionId: SID,
    version: 1,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
    brief: opts.brief ? [{ id: "b1", at: "2026-10-29T00:00:00.000Z", messageId: "m1", text: opts.brief }] : [],
    decisions: [],
    targets: null,
    defaults: {},
    nodes,
    order: Object.keys(nodes),
    budget: { capCoins: null, spentCoins: 0, savedCoins: 0 },
    activeRun: null,
    seq: 0,
  }
  return {
    project,
    node,
    signature: "sig_sentence",
    runId: "run_sentence",
    attempt: 1,
    take: 1,
    sessionId: SID,
    session: {} as never,
    params: { preset: "cinema_239" },
    inputs,
    refs: [],
    signal: new AbortController().signal,
    ingest: (src: { path: string } | { url: string }, hint: { port: string; mime?: string; origin: "generated" | "user" | "derived" }) => store.ingest(src, hint),
    ledger: { write: async () => {} },
    submitGeneration: async () => ({ ok: false as const, code: "bad_input" as const, message: "不提交生成", retryable: false }),
    execBridge: {
      call: async () => ({ ok: false as const, code: "bridge_unavailable" as const, message: "不调桥", retryable: false }),
      result: async () => ({ state: "unknown" as const }),
    },
  }
}

describe("原话约束与候选执行边界", () => {
  test("无字幕要求仍有独立可验证反例；候选不是最终交付，语义由critic核对全部修订", async () => {
    const file = join(MEDIA, "plain.mp4")
    ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=160x120:d=1:r=24", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-t", "1"], file)
    const clip = await store.ingest({ path: file }, { port: "out", mime: "video/mp4", origin: "generated" })
    const srt = join(MEDIA, "cap.srt")
    writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\n字\n", "utf8")
    const sub = await store.ingest({ path: srt }, { port: "srt", mime: "text/plain", origin: "generated" })
    const res = await exportExecutor.run(makeCtx({ brief: "这镜没有字幕", inputs: { v: [clip], cap: [{ ...sub, port: "srt" }] } }))
    expect(res.ok).toBe(true)
    if (res.ok !== true) return
    expect(res.outputs[0].meta?.stage).toBe("candidate")
    const violation = await evaluateSentenceConstraints({ text: "这镜没有字幕", videoPath: res.outputs[0].path, durationSec: res.outputs[0].durationSec ?? 1, subtitleBurnIn: false, subtitleFiles: [{ path: srt, port: "srt" }] })
    expect(violation).toContain("没有字幕")
  }, 180_000)

  test("当前结构目标静音：候选音轨被剥掉；不靠首句regex替代目标版本", async () => {
    const file = join(MEDIA, "with-audio.mp4")
    ffmpeg(["-f", "lavfi", "-i", "color=c=green:s=160x120:d=1:r=24", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "1"], file)
    const before = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", file]).toString()) as { streams?: { codec_type?: string }[] }
    expect((before.streams ?? []).some((s) => s.codec_type === "audio")).toBe(true)
    const clip = await store.ingest({ path: file }, { port: "out", mime: "video/mp4", origin: "generated" })
    const ctx = makeCtx({ brief: "请静音", inputs: { v: [clip] } })
    ctx.project.targets = { audio: "none", setBy: { kind: "agent" }, at: ctx.project.createdAt }
    const res = await exportExecutor.run(ctx)
    expect(res.ok, JSON.stringify(res)).toBe(true)
    if (res.ok !== true) return
    expect(res.outputs[0].meta?.hasAudio).toBe(false)
    const after = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", res.outputs[0].path]).toString()) as { streams?: { codec_type?: string }[] }
    expect((after.streams ?? []).some((s) => s.codec_type === "audio")).toBe(false)
  }, 180_000)

  test("时长偏离超过 10% 失败", async () => {
    const msg = await evaluateSentenceConstraints({
      text: "只要 5 秒",
      videoPath: join(MEDIA, "missing.mp4"),
      durationSec: 1,
      subtitleBurnIn: false,
      subtitleFiles: [],
      timelineSubtitles: [],
    })
    expect(msg).toContain("5")
    expect(msg).toContain("10%")
  })
})
