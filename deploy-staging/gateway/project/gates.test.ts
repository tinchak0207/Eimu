// S17：工程模式交付前置检查（project/gates.ts）与运行时规则绑定（project/rules-map.ts ↔ AGENTS.md）。
//
// 样例全部用本机 ffmpeg 现生成（≤12 秒），不 mock 量测。期望值来源：
//   - 设计文档 §3.9 的阈值（时长 ±10%、无 targets 时配方上限 8–90 秒、targets.audio≠"none" 要音轨、
//     响度/黑帧/冻结帧/评分过阈值）；
//   - 生成素材本身的参数（-t 5 / -t 12、anoisesrc a=0.2≈-16 LUFS、a=0.5 明显超阈、全黑、静止画面）。
// sha256 期望用测试自己的 createHash(读文件) 算，不调用被测的 sha256File（避免同源断言）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { shouldBlockCompletionForWorkflowWrite } from "../canvas-write-gate.ts"
import { checkDeliveryForSession, DELIVERY_CONTRACTS, type ArtifactVerifyRecord } from "../delivery-gate.ts"
import { checkExportArtifacts, checkQcMedia, clampRecipeMaxDuration, deliverablesFromExport } from "./gates.ts"
import { extractRuleTags, RULES_MAP, UNMAPPED_RULES } from "./rules-map.ts"
import type { Json, Output, ProjectGraph, ProjectNode, Targets } from "./types.ts"

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0
const suite = hasFfmpeg ? describe : describe.skip

const DIR = mkdtempSync(join(tmpdir(), "gates-s17-"))
const MEDIA = join(DIR, "media")
const ISO = "2026-10-28T00:00:00Z"
const GOOD = join(MEDIA, "good.mp4")
const NOAUDIO = join(MEDIA, "noaudio.mp4")
const LONG = join(MEDIA, "long.mp4")
const BLACK = join(MEDIA, "black.mp4")
const LOUD = join(MEDIA, "loud.mp4")
const FREEZE = join(MEDIA, "freeze.mp4")
const IMAGE = join(MEDIA, "still.png")

const gen = (args: string[]) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { timeout: 60_000 })
const bytesOf = (file: string): number => {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}
/** 独立期望：测试自己算 sha256（不 import 被测实现）。 */
const shaOf = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex")

const outOf = (file: string, mime: string, sha?: string): Output => ({
  port: "out",
  artifactId: "art_0123456789abcdef",
  sha256: sha ?? "0".repeat(64),
  path: file,
  mime,
  bytes: bytesOf(file),
  origin: "generated",
})

const targetsOf = (durationSec: number | null, audio: Targets["audio"] = "voice"): Targets => ({
  ...(durationSec !== null ? { durationSec } : {}),
  audio,
  setBy: { kind: "user" },
  at: ISO,
})

const nodeOf = (id: string, type: ProjectNode["type"], outputs: Output[] = [], over: Partial<ProjectNode> = {}): ProjectNode => ({
  id,
  type,
  intent: "",
  params: {},
  inputs: {},
  refs: [],
  pinned: null,
  status: "done",
  signature: "sig",
  lastRun: null,
  outputs,
  rev: 1,
  ...over,
})

const graphOf = (nodes: ProjectNode[], targets: Targets | null = targetsOf(5)): ProjectGraph => ({
  schema: 1,
  id: "p1",
  sessionId: "s1",
  version: 1,
  createdAt: ISO,
  updatedAt: ISO,
  brief: [],
  decisions: [],
  targets,
  defaults: {},
  nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
  order: nodes.map((n) => n.id),
  budget: { capCoins: null, spentCoins: 0, savedCoins: 0 },
  activeRun: null,
  seq: 0,
})

const checksOf = (r: Awaited<ReturnType<typeof checkExportArtifacts>>) => Object.fromEntries(r.checks.map((c) => [c.id, c.ok]))

suite("S17 工程模式交付前置检查", () => {
  beforeAll(() => {
    mkdirSync(MEDIA, { recursive: true })
    // 好样例：5s 动态画面 + 可测响度（噪声 a=0.2 实测约 -16 LUFS）
    gen(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=5", "-f", "lavfi", "-i", "anoisesrc=a=0.2:d=5:r=48000",
      "-t", "5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", GOOD])
    // 坏：无音轨
    gen(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=5", "-t", "5",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", NOAUDIO])
    // 坏：12s（对 5s 目标偏差 140%）
    gen(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=12", "-f", "lavfi", "-i", "anoisesrc=a=0.2:d=12:r=48000",
      "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", LONG])
    // 坏：全黑
    gen(["-f", "lavfi", "-i", "color=black:s=320x180:r=24:d=5", "-f", "lavfi", "-i", "anoisesrc=a=0.2:d=5:r=48000",
      "-t", "5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", BLACK])
    // 坏：响度明显超阈（a=0.5，约 -8 LUFS）
    gen(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=5", "-f", "lavfi", "-i", "anoisesrc=a=0.5:d=5:r=48000",
      "-t", "5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", LOUD])
    // 坏：静止画面（纯色 5s）
    gen(["-f", "lavfi", "-i", "color=blue:s=320x180:r=24:d=5", "-f", "lavfi", "-i", "anoisesrc=a=0.2:d=5:r=48000",
      "-t", "5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", FREEZE])
    gen(["-f", "lavfi", "-i", "testsrc2=s=320x180", "-frames:v", "1", IMAGE])
  }, 120_000)

  afterAll(() => rmSync(DIR, { recursive: true, force: true }))

  test("export 前置检查：好片全过", async () => {
    const r = await checkExportArtifacts([outOf(GOOD, "video/mp4", shaOf(GOOD))], { targets: targetsOf(5) })
    expect(r.ok).toBe(true)
    expect(r.deficiencies).toEqual([])
    const c = checksOf(r)
    expect(c.file_exists).toBe(true)
    expect(c.sha256).toBe(true)
    expect(c.decodable).toBe(true)
    expect(c.duration).toBe(true)
    expect(c.audio).toBe(true)
  })

  test("export 前置检查：文件不存在 / sha256 不符 各自拒绝", async () => {
    const missing = await checkExportArtifacts([outOf(join(MEDIA, "nope.mp4"), "video/mp4", "a".repeat(64))], {
      targets: targetsOf(5),
    })
    expect(missing.ok).toBe(false)
    expect(checksOf(missing).file_exists).toBe(false)
    expect(missing.deficiencies.some((d) => d.startsWith("文件不存在"))).toBe(true)

    const badSha = await checkExportArtifacts([outOf(GOOD, "video/mp4", "0".repeat(64))], { targets: targetsOf(5) })
    expect(badSha.ok).toBe(false)
    expect(checksOf(badSha).sha256).toBe(false)
    expect(checksOf(badSha).decodable).toBe(true)
    expect(badSha.deficiencies.some((d) => d.startsWith("sha256 不符"))).toBe(true)
  })

  test("export 前置检查：缺音轨按 targets.audio 判（voice 拒、none 过）", async () => {
    const required = await checkExportArtifacts([outOf(NOAUDIO, "video/mp4", shaOf(NOAUDIO))], { targets: targetsOf(5, "voice") })
    expect(required.ok).toBe(false)
    expect(checksOf(required).audio).toBe(false)

    const none = await checkExportArtifacts([outOf(NOAUDIO, "video/mp4", shaOf(NOAUDIO))], { targets: targetsOf(5, "none") })
    expect(none.ok).toBe(true)
    expect("audio" in checksOf(none)).toBe(false)
  })

  test("export 前置检查：时长偏差 >10% 拒绝；无 targets 时非零且 ≤ 配方上限（8–90）", async () => {
    const off = await checkExportArtifacts([outOf(LONG, "video/mp4", shaOf(LONG))], { targets: targetsOf(5) })
    expect(off.ok).toBe(false)
    expect(checksOf(off).duration).toBe(false)
    expect(off.deficiencies.some((d) => d.includes("容差 10%"))).toBe(true)

    const within = await checkExportArtifacts([outOf(GOOD, "video/mp4", shaOf(GOOD))], { targets: targetsOf(5) })
    expect(checksOf(within).duration).toBe(true)

    // 无 targets：12s 相对缺省上限 90s 合法；相对 8s 上限超长。
    const noTargets = await checkExportArtifacts([outOf(LONG, "video/mp4", shaOf(LONG))], {})
    expect(checksOf(noTargets).duration).toBe(true)
    const capped = await checkExportArtifacts([outOf(LONG, "video/mp4", shaOf(LONG))], { maxDurationSec: 8 })
    expect(checksOf(capped).duration).toBe(false)
    expect(capped.deficiencies.some((d) => d.includes("超过配方上限 8s"))).toBe(true)

    // 钳位：低于 8 抬到 8、高于 90 压到 90、缺省 90。
    expect(clampRecipeMaxDuration(4)).toBe(8)
    expect(clampRecipeMaxDuration(500)).toBe(90)
    expect(clampRecipeMaxDuration(undefined)).toBe(90)
  })

  test("export 前置检查：空产物 = 没有交付", async () => {
    const r = await checkExportArtifacts([], { targets: targetsOf(5) })
    expect(r.ok).toBe(false)
    expect(r.deficiencies.some((d) => d.includes("export 没有产物"))).toBe(true)
  })

  test("qc 前置检查：好片全过（响度/黑帧/冻结/分数）", async () => {
    const project = graphOf([nodeOf("qc1", "qc")], targetsOf(5))
    const r = await checkQcMedia(outOf(GOOD, "video/mp4", shaOf(GOOD)), { project })
    expect(r.ok).toBe(true)
    const c = checksOf(r)
    expect(c.loudness).toBe(true)
    expect(c.black).toBe(true)
    expect(c.freeze).toBe(true)
    expect(c.qc_score).toBe(true)
  })

  test("qc 前置检查：全黑 / 冻结 / 响度超阈 / 分数不足 各自拒绝", async () => {
    const project = graphOf([nodeOf("qc1", "qc")], targetsOf(5))

    const black = await checkQcMedia(outOf(BLACK, "video/mp4", shaOf(BLACK)), { project })
    expect(black.ok).toBe(false)
    expect(checksOf(black).black).toBe(false)
    expect(checksOf(black).qc_score).toBe(false)

    const freeze = await checkQcMedia(outOf(FREEZE, "video/mp4", shaOf(FREEZE)), { project })
    expect(freeze.ok).toBe(false)
    expect(checksOf(freeze).freeze).toBe(false)
    expect(checksOf(freeze).black).toBe(true)

    const loud = await checkQcMedia(outOf(LOUD, "video/mp4", shaOf(LOUD)), { project })
    expect(loud.ok).toBe(false)
    expect(checksOf(loud).loudness).toBe(false)

    // 唯一缺陷＝时长偏差（5s 片对 6s 目标，16.7%>10%）→ 扣 45 分＝55 < 及格线 60。
    const lowScore = await checkQcMedia(outOf(GOOD, "video/mp4", shaOf(GOOD)), { project: graphOf([nodeOf("qc1", "qc")], targetsOf(6)) })
    expect(lowScore.ok).toBe(false)
    expect(checksOf(lowScore).black).toBe(true)
    expect(checksOf(lowScore).freeze).toBe(true)
    expect(checksOf(lowScore).loudness).toBe(true)
    expect(checksOf(lowScore).qc_score).toBe(false)
    expect(lowScore.deficiencies.some((d) => d.includes("qc 分数"))).toBe(true)
  })

  test("只有模型文本已完成、没有 export 产物 → 无交付卡", async () => {
    const textNode = nodeOf("script1", "script", [outOf(join(MEDIA, "verdict.json"), "application/json")], {
      params: { text: "已完成，成片见上一条" } as Record<string, Json>,
      intent: "已完成",
      status: "done",
    })
    const g = graphOf([textNode])
    expect(deliverablesFromExport(g)).toEqual([])

    const noOutputs = graphOf([nodeOf("export1", "export", [])])
    expect(deliverablesFromExport(noOutputs)).toEqual([])

    const delivered = graphOf([nodeOf("export1", "export", [outOf(GOOD, "video/mp4", shaOf(GOOD))])])
    const list = deliverablesFromExport(delivered)
    expect(list.length).toBe(1)
    expect(list[0].nodeId).toBe("export1")
    expect(list[0].output.path).toBe(GOOD)
  })

  test("工程模式：文本闸与字段名检查不接线（旧席位行为不变）", () => {
    const base = { avProductionIntent: true, workflowWriteSucceeded: false, nudgeSent: false, hasLastPromptBody: true }
    expect(shouldBlockCompletionForWorkflowWrite({ ...base, projectMode: true })).toBe(false)
    expect(shouldBlockCompletionForWorkflowWrite({ ...base, projectMode: false })).toBe(true)
    expect(shouldBlockCompletionForWorkflowWrite(base)).toBe(true)

    const text = "已完成，音频在 AUDIO_URL。"
    const projectVerdict = checkDeliveryForSession({ projectMode: true, seat: "creator" }, "music", text, DELIVERY_CONTRACTS)
    expect(projectVerdict.ok).toBe(true)
    expect(projectVerdict.missing).toEqual([])

    const legacyVerdict = checkDeliveryForSession({ projectMode: false, seat: "creator_legacy" }, "music", text, DELIVERY_CONTRACTS)
    expect(legacyVerdict.ok).toBe(false)
    expect(legacyVerdict.missing.length).toBeGreaterThan(0)

    // 工程模式只停「字段名」检查；产物证据仍然判（那不是措辞闸）。
    const blocked: ArtifactVerifyRecord[] = [{ name: "final.mp4", url: null, local_available: false, verify_status: "blocked" }]
    const withBlocked = checkDeliveryForSession({ projectMode: true, seat: "creator" }, "music", text, DELIVERY_CONTRACTS, blocked)
    expect(withBlocked.ok).toBe(false)
    expect(withBlocked.missing.some((m) => m.startsWith("artifact:final.mp4"))).toBe(true)
  })

  test("规则绑定：AGENTS.md 每条规则带 [R-nn]，与 rules-map 双向精确相等", () => {
    const runtimeDir = join(import.meta.dir, "..", "..", "opencode-runtime")
    const full = readFileSync(join(runtimeDir, "AGENTS.md"), "utf-8")
    expect(full.split("\n").length).toBeLessThanOrEqual(200)
    // 「# 做事方法」之后是手艺层（研究、评审、返工、并行、说话）：没有代码强制点，不进规则绑定。
    // 规则层只放有强制点的硬规则；两层分开，硬规则不再挤掉做事方法。
    const md = full.split(/^# 做事方法\s*$/m)[0]
    expect(full.includes("\n# 做事方法")).toBe(true)
    const lines = md.split("\n")
    expect(lines.filter((l) => l.trim().length > 0).every((l) => l.trim().startsWith("#") || /\[R-\d{2}\]/.test(l))).toBe(true)

    const ruleLines = lines.filter((l) => l.trim().startsWith("- "))
    for (const line of ruleLines) {
      const tags = extractRuleTags(line)
      expect(tags.length).toBe(1) // 一条规则一个标签，且标签在规则行内
    }
    const fileTags = [...new Set(ruleLines.flatMap((l) => extractRuleTags(l)))].sort()
    const mapTags = Object.keys(RULES_MAP).sort()
    // 双向：AGENTS.md 有 → 表里有；表里有 → AGENTS.md 有（多与少都算失败）。
    expect(fileTags.filter((t) => !mapTags.includes(t))).toEqual([])
    expect(mapTags.filter((t) => !fileTags.includes(t))).toEqual([])

    for (const [tag, m] of Object.entries(RULES_MAP)) {
      expect(tag).toMatch(/^R-\d{2}$/)
      expect(m.enforce.trim().length).toBeGreaterThan(0)
      expect(m.enforce).toContain(":")
      expect(m.test.trim().length).toBeGreaterThan(0)
    }
    expect(UNMAPPED_RULES.length).toBe(0)

    // 测试名必须指向现场存在的测试文件：新写的两条闸测试在本档，其余在各自档。
    const gatewayDir = join(import.meta.dir, "..")
    const testFiles = new Set<string>()
    const collect = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (e.name === "node_modules") continue
          collect(join(dir, e.name))
        } else if (e.name.endsWith(".test.ts")) testFiles.add(join(dir, e.name))
      }
    }
    collect(gatewayDir)
    const allTestText = [...testFiles].map((f) => readFileSync(f, "utf-8")).join("\n")
    for (const [tag, m] of Object.entries(RULES_MAP)) {
      const present = allTestText.includes(m.test)
      expect({ tag, present }).toEqual({ tag, present: true })
    }
  })
})
