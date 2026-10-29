// S8b 验收测试：timeline / subtitle / mix / export 执行器 + assembleFilmNode 重构回归。
// 素材全部由本机 ffmpeg 现场生成（3 段短镜头 + 1 段音频），不依赖外部档案、不触网、不付费。
// 断言口径独立于实现：ffprobe 真解码、像素取样验证镜头顺序、sha256 用 node:crypto 独立重算。
import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecContext, Json, Output, ProjectGraph, ProjectNode } from "../types"

const WS = mkdtempSync(join(tmpdir(), "s8b-"))
const SID = "sess-s8b-test"
const HOME = join(WS, "home")
const PROJECT_DIR = join(WS, "projects", SID)
const MEDIA = join(PROJECT_DIR, "media")

// 沙箱：必须在动态 import（timeline.ts / mix.ts / constants 在模块载入时读 env）之前设置。
process.env.WORKSPACE_DIR = WS
process.env.KUNPENG_WORKSPACE = join(WS, "kunpeng")
process.env.HOME = HOME
process.env.TTS_PUBLIC_BASE = "https://example.test/agent/v1/audio"
mkdirSync(MEDIA, { recursive: true })
mkdirSync(HOME, { recursive: true })

const sha256 = (buf: Uint8Array | string) => createHash("sha256").update(buf).digest("hex")

function ffmpeg(args: string[]): string {
  return execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args], { timeout: 120_000 }).toString()
}
function ffprobeJson(file: string): { streams?: { codec_type?: string; width?: number; height?: number }[]; format?: { duration?: string } } {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-show_entries", "format=duration", "-of", "json", file], { timeout: 30_000 }).toString())
}
function ffprobeDuration(file: string): number {
  return Number(ffprobeJson(file).format?.duration ?? 0) || 0
}
/** 取 t 秒处一帧的 1x1 平均色（rgb raw）。 */
function samplePixel(file: string, t: number): [number, number, number] {
  const buf = execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
  return [buf[0], buf[1], buf[2]]
}
/** 数底部 20% 画面里的近白像素（字幕烧录痕迹）。 */
function whitePixelsBottomBand(file: string, t: number): number {
  const buf = execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "crop=iw:ih*0.2:0:ih*0.8", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { timeout: 60_000, maxBuffer: 128 * 1024 * 1024 })
  let n = 0
  for (let i = 0; i + 2 < buf.length; i += 3) if (buf[i] > 200 && buf[i + 1] > 200 && buf[i + 2] > 200) n += 1
  return n
}

const CLIP_SECS: Record<string, number> = { shot2: 1, shot10: 2, shot1: 3 }
const CLIP_COLORS: Record<string, string> = { shot2: "green", shot10: "blue", shot1: "red" }
const ORDER = ["shot2", "shot10", "shot1"] // 与字典序 shot1 < shot10 < shot2 相反

// 动态 import：env 已就位。
const { ArtifactStore } = await import("../artifacts")
const { timelineExecutor } = await import("./timeline")
const { subtitleExecutor } = await import("./subtitle")
const { mixExecutor } = await import("./mix")
const { exportExecutor } = await import("./export")
const { signedTestCriticVerdictOutput } = await import("./qc.fixture")
const { assembleFilmNode, assembleFromClips } = await import("../../workflow-gw-assemble")

const store = new ArtifactStore({ projectDir: PROJECT_DIR })

const makeCtx = (opts: {
  id: string
  type: ProjectNode["type"]
  params: Record<string, Json>
  inputs: Record<string, Output[]>
  edges?: Record<string, { from: string; port?: string }>
}): ExecContext => {
  const node: ProjectNode = {
    id: opts.id,
    type: opts.type,
    intent: "",
    params: opts.params,
    inputs: opts.edges ?? {},
    refs: [],
    pinned: null,
    status: "pending",
    signature: null,
    lastRun: null,
    outputs: [],
    rev: 1,
  }
  const project: ProjectGraph = {
    schema: 1,
    id: SID,
    sessionId: SID,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    brief: [],
    decisions: [],
    targets: null,
    defaults: {},
    nodes: { [node.id]: node },
    order: [node.id],
    budget: { capCoins: null, spentCoins: 0, savedCoins: 0 },
    activeRun: null,
    seq: 0,
  }
  return {
    project,
    node,
    signature: `sig_${opts.id}`,
    runId: "run_s8b",
    attempt: 1,
    take: 1,
    sessionId: SID,
    session: {} as never,
    params: opts.params,
    inputs: opts.type === "export" && !opts.inputs.verdict
      ? {
          ...opts.inputs,
          verdict: [signedTestCriticVerdictOutput(MEDIA, {
            parentSessionId: SID,
            artifactSha256: (Object.values(opts.inputs).flat().find((o) => /^(video|image)\//.test(o.mime)) ?? { sha256: "a".repeat(64) }).sha256,
            rubric: opts.params.preset === "image_pack" ? "image_default" : "film_frame_critic",
          })],
        }
      : opts.inputs,
    refs: [],
    signal: new AbortController().signal,
    ingest: (src, hint) => store.ingest(src, hint),
    ledger: { write: async () => {} },
    submitGeneration: async () => ({ ok: false, code: "bad_input", message: "S8b 测试不提交生成", retryable: false }),
    execBridge: {
      call: async () => ({ ok: false, code: "bridge_unavailable", message: "S8b 测试不调桥", retryable: false }),
      result: async () => ({ state: "unknown" }),
    },
  }
}

const ingestPath = (file: string, port: string, mime: string) => store.ingest({ path: file }, { port, mime, origin: "generated" })

let timelineOut: Output
let shotlistOut: Output
let mixOut: Output
const clipOutputs: Record<string, Output> = {}
let audioOut: Output

afterAll(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe("S8b 素材（真 ffmpeg）", () => {
  test("生成 3 段镜头（顺序与字典序相反）+ 1 段音频", async () => {
    for (const id of ["shot2", "shot10", "shot1"]) {
      const file = join(MEDIA, `${id}.mp4`)
      ffmpeg(["-f", "lavfi", "-i", `color=c=${CLIP_COLORS[id]}:s=320x240:r=24:d=${CLIP_SECS[id]}`, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-t", String(CLIP_SECS[id]), file])
      const dur = ffprobeDuration(file)
      expect(Math.abs(dur - CLIP_SECS[id])).toBeLessThan(0.2)
      clipOutputs[id] = await ingestPath(file, "out", "video/mp4")
      expect(clipOutputs[id].durationSec).toBeUndefined() // ingest 不算媒体时长；执行器自行 ffprobe
    }
    const audioFile = join(MEDIA, "voice.m4a")
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac", "-b:a", "128k", audioFile])
    audioOut = await ingestPath(audioFile, "out", "audio/mp4")
    expect(existsSync(audioOut.path)).toBe(true)
  })
})

describe("timeline 执行器", () => {
  test("套用 IR ops：产物=current.json 快照，顺序来自 params.order，sha256 内容寻址", async () => {
    // 输入插入序 = 字典序（shot1, shot10, shot2）；期望顺序来自 params.order。
    const ctx = makeCtx({
      id: "timeline", type: "timeline",
      params: { order: ORDER, transitions: [{ after: "shot10", type: "cut", duration: 0 }], aspect: "16:9", fps: 24, styleId: "default" },
      edges: { a: { from: "shot1" }, b: { from: "shot10" }, c: { from: "shot2" }, voice: { from: "voice" } },
      inputs: { a: [clipOutputs.shot1], b: [clipOutputs.shot10], c: [clipOutputs.shot2], voice: [audioOut] },
    })
    const res = await timelineExecutor.run(ctx)
    expect(res.ok).toBe(true)
    if (res.ok !== true) return
    const out = res.outputs[0]
    const bytes = readFileSync(out.path)
    timelineOut = out
    expect(out.port).toBe("out")
    expect(out.mime).toBe("application/json")
    expect(out.sha256).toBe(sha256(bytes))
    expect(out.artifactId).toBe("art_" + out.sha256.slice(0, 16))
    const snap = JSON.parse(bytes.toString("utf-8")) as { clips: { id: string; duration: number }[]; aspect: string; audioClips: unknown[] }
    expect(snap.clips.map((c) => c.id)).toEqual(ORDER)
    expect(snap.clips.map((c) => Math.round(c.duration))).toEqual([1, 2, 3])
    expect(snap.aspect).toBe("16:9")
    expect(snap.audioClips.length).toBe(1)
    expect(out.meta?.totalDurationSec).toBe(6)
  })
})

describe("subtitle 执行器", () => {
  test("shotlist 台词 + timeline 时间轴 → srt/ass；burnIn=false=外挂，true=待烧录", async () => {
    const rows = [
      { id: "shot2", dialog: "", text: "第二镜：雨落在伞面" },
      { id: "shot10", text: "第十镜：人物回头" },
      { id: "shot1", text: "第一镜：站台空无一人" },
    ]
    const shotPath = join(MEDIA, "shotlist.json")
    writeFileSync(shotPath, JSON.stringify({ kind: "shots", rows }), "utf-8")
    shotlistOut = await ingestPath(shotPath, "out", "application/json")

    const side = await subtitleExecutor.run(makeCtx({
      id: "subtitle", type: "subtitle",
      params: { style: "default", burnIn: false, lang: "zh-CN" },
      edges: { timeline: { from: "timeline" }, shotlist: { from: "shotlist" } },
      inputs: { timeline: [timelineOut], shotlist: [shotlistOut] },
    }))
    expect(side.ok).toBe(true)
    if (side.ok !== true) return
    const srt = side.outputs.find((o) => o.port === "srt")!
    const ass = side.outputs.find((o) => o.port === "ass")!
    const srtText = readFileSync(srt.path, "utf-8")
    expect(srtText).toContain("1\n00:00:00,000 --> 00:00:01,000\n第二镜：雨落在伞面")
    expect(srtText).toContain("2\n00:00:01,000 --> 00:00:03,000\n第十镜：人物回头")
    expect(srtText).toContain("3\n00:00:03,000 --> 00:00:06,000\n第一镜：站台空无一人")
    expect(readFileSync(ass.path, "utf-8")).toContain("Dialogue: 0,0:00:00.00,0:00:01.00")
    expect(srt.meta?.delivery).toBe("sidecar")
    expect(ass.meta?.burnIn).toBe(false)
    expect(srt.sha256).toBe(sha256(readFileSync(srt.path)))

    const burn = await subtitleExecutor.run(makeCtx({
      id: "subtitle_burn", type: "subtitle",
      params: { style: { fontSize: 40, fontName: "DejaVu Sans" }, burnIn: true, lang: "zh-CN" },
      edges: { timeline: { from: "timeline" }, shotlist: { from: "shotlist" } },
      inputs: { timeline: [timelineOut], shotlist: [shotlistOut] },
    }))
    expect(burn.ok).toBe(true)
    if (burn.ok !== true) return
    expect(burn.outputs[0].meta?.delivery).toBe("burn_in")
    expect(readFileSync(burn.outputs[1].path, "utf-8")).toContain("DejaVu Sans")
  })
})

describe("mix 执行器", () => {
  test("applyMix 轮子：时长/响度/产物入库", async () => {
    const res = await mixExecutor.run(makeCtx({
      id: "mix", type: "mix",
      params: { levels: { voice: 0, music: -18 }, ducking: true, targetLufs: -16 },
      edges: { timeline: { from: "timeline" }, voice: { from: "voice" } },
      inputs: { timeline: [timelineOut], voice: [audioOut] },
    }))
    if (res.ok !== true) console.error("MIX_FAIL", JSON.stringify(res))
    expect(res.ok).toBe(true)
    const out = res.outputs[0]
    mixOut = out
    expect(out.mime).toBe("audio/wav")
    const probe = ffprobeJson(out.path)
    expect((probe.streams ?? []).some((s) => s.codec_type === "audio")).toBe(true)
    expect(ffprobeDuration(out.path)).toBeGreaterThan(0.5)
    expect(typeof out.meta?.measuredLufs).toBe("number")
    expect(out.sha256).toBe(sha256(readFileSync(out.path)))
  })
})

describe("export 执行器", () => {
  test("MASTER_PRESETS 预设 → 可解码 mp4：视频流+音频流、时长=各段之和±0.5s、镜头顺序来自 order", async () => {
    const res = await exportExecutor.run(makeCtx({
      id: "export", type: "export",
      params: { preset: "landscape_169" },
      edges: { timeline: { from: "timeline" }, mix: { from: "mix" } },
      inputs: { timeline: [timelineOut], mix: [mixOut] },
    }))
    expect(res.ok).toBe(true)
    if (res.ok !== true) return
    const out = res.outputs[0]
    expect(out.mime).toBe("video/mp4")
    expect(out.sha256).toBe(sha256(readFileSync(out.path)))
    const probe = ffprobeJson(out.path)
    expect((probe.streams ?? []).some((s) => s.codec_type === "video")).toBe(true)
    expect((probe.streams ?? []).some((s) => s.codec_type === "audio")).toBe(true)
    const total = CLIP_SECS.shot2 + CLIP_SECS.shot10 + CLIP_SECS.shot1
    expect(Math.abs(ffprobeDuration(out.path) - total)).toBeLessThanOrEqual(0.5)
    // 画面顺序：order 首镜 shot2=绿（0..1s），末镜 shot1=红（3..6s）；字典序会先出红。
    const [r0, g0, b0] = samplePixel(out.path, 0.4)
    expect(g0).toBeGreaterThan(80)
    expect(g0).toBeGreaterThan(r0 + 40)
    expect(g0).toBeGreaterThan(b0 + 40)
    const [r1, g1] = samplePixel(out.path, 4)
    expect(r1).toBeGreaterThan(120)
    expect(r1).toBeGreaterThan(g1 + 60)
    expect(out.meta?.durationSec as number).toBeGreaterThan(5.5)
    expect(out.meta?.hasAudio).toBe(true)
  }, 180_000)

  test("字幕烧录由 subtitle.meta.burnIn 决定（真像素痕迹）", async () => {
    const subBurn = await subtitleExecutor.run(makeCtx({
      id: "subtitle_burn2", type: "subtitle",
      params: { style: "default", burnIn: true, lang: "zh-CN" },
      edges: { timeline: { from: "timeline" }, shotlist: { from: "shotlist" } },
      inputs: { timeline: [timelineOut], shotlist: [shotlistOut] },
    }))
    expect(subBurn.ok).toBe(true)
    if (subBurn.ok !== true) return
    const ass = subBurn.outputs.find((o) => o.port === "ass")!
    const res = await exportExecutor.run(makeCtx({
      id: "export_burn", type: "export",
      params: { preset: "landscape_169" },
      edges: { timeline: { from: "timeline" }, mix: { from: "mix" }, subtitle: { from: "subtitle_burn2" } },
      inputs: { timeline: [timelineOut], mix: [mixOut], subtitle: [ass] },
    }))
    expect(res.ok).toBe(true)
    if (res.ok !== true) return
    expect(res.outputs[0].meta?.subtitleBurnIn).toBe(true)
    // 对照组：同素材不烧字幕。
    const plain = await exportExecutor.run(makeCtx({
      id: "export_plain", type: "export",
      params: { preset: "landscape_169" },
      edges: { timeline: { from: "timeline" }, mix: { from: "mix" } },
      inputs: { timeline: [timelineOut], mix: [mixOut] },
    }))
    expect(plain.ok).toBe(true)
    if (plain.ok !== true) return
    expect(whitePixelsBottomBand(res.outputs[0].path, 0.5)).toBeGreaterThan(50)
    expect(whitePixelsBottomBand(plain.outputs[0].path, 0.5)).toBeLessThan(10)
  }, 180_000)

  test("image_pack 预设 → 包清单，每项 sha256 独立重算一致", async () => {
    const images: Output[] = []
    for (const [i, color] of ["red", "green", "blue"].entries()) {
      const file = join(MEDIA, `view${i}.png`)
      ffmpeg(["-f", "lavfi", "-i", `color=c=${color}:s=64x64:d=1`, "-frames:v", "1", file])
      images.push(await ingestPath(file, "out", "image/png"))
    }
    const res = await exportExecutor.run(makeCtx({
      id: "export_pack", type: "export",
      params: { preset: "image_pack" },
      edges: { image: { from: "keyframe" } },
      inputs: { image: images },
    }))
    expect(res.ok).toBe(true)
    if (res.ok !== true) return
    const out = res.outputs[0]
    expect(out.mime).toBe("application/json")
    const manifest = JSON.parse(readFileSync(out.path, "utf-8")) as { itemCount: number; items: { artifactId: string; sha256: string; bytes: number }[] }
    expect(manifest.itemCount).toBe(3)
    for (const item of manifest.items) {
      const src = images.find((o) => o.artifactId === item.artifactId)!
      expect(src).toBeDefined()
      const bytes = readFileSync(src.path)
      expect(item.sha256).toBe(sha256(bytes))
      expect(item.bytes).toBe(bytes.length)
    }
    expect(out.sha256).toBe(sha256(readFileSync(out.path)))
  })
})

describe("旧路径回归：assembleFilmNode", () => {
  test("无镜头输入 → 原错误文案不变", async () => {
    const r = await assembleFilmNode({ id: "film", kind: "film", metadata: {} }, new Map(), { nodes: [], connections: [] })
    expect(r.ok).toBe(false)
    expect(r.error).toBe("成片环没有已完成的镜头输入：请先完成各视频节点，再执行成片")
  })

  test("assembleFromClips：order 决定镜头顺序、混流+QC+标题烧录后产物可解码（旧组装主体）", async () => {
    const workDir = join(WS, "assemble-work")
    mkdirSync(workDir, { recursive: true })
    // 故意按字典序提供，order 反向指定（与 execute 侧同一期望）
    const clips = [
      { id: "shot1", path: clipOutputs.shot1.path, durationSec: 3, role: "s1_video", text: "" },
      { id: "shot10", path: clipOutputs.shot10.path, durationSec: 2, role: "s10_video", text: "" },
      { id: "shot2", path: clipOutputs.shot2.path, durationSec: 1, role: "s2_video", text: "" },
    ]
    const outPath = join(workDir, "film.mp4")
    const r = await assembleFromClips(clips, [{ path: audioOut.path, durationSec: 2 }], {
      workDir,
      outPath,
      order: ORDER,
      title: "S8b 回归片",
    })
    expect(r.ok).toBe(true)
    if (r.ok !== true) return
    expect(existsSync(outPath)).toBe(true)
    const probe = ffprobeJson(outPath)
    expect((probe.streams ?? []).some((s) => s.codec_type === "video")).toBe(true)
    expect((probe.streams ?? []).some((s) => s.codec_type === "audio")).toBe(true)
    expect(Math.abs(ffprobeDuration(outPath) - 6)).toBeLessThanOrEqual(0.5)
    // 顺序来自 order：首镜 shot2=绿
    const [r0, g0, b0] = samplePixel(outPath, 0.4)
    expect(g0).toBeGreaterThan(80)
    expect(g0).toBeGreaterThan(r0 + 40)
    expect(g0).toBeGreaterThan(b0 + 40)
    // 标题字幕（0..3s）烧进画面
    expect(r.subtitleCues.some((c) => c.id === "title" && c.text === "S8b 回归片")).toBe(true)
    // 标题占 0..min(3,max(1,首镜时长))=1s（旧口径），1s 后不再有标题字
    expect(whitePixelsBottomBand(outPath, 0.5)).toBeGreaterThan(20)
    expect(whitePixelsBottomBand(outPath, 1.5)).toBeLessThan(20)
  }, 180_000)
})
