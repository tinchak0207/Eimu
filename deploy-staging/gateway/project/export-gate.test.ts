// S20 接线 1 验收：export 节点自带交付闸（§3.9）——只查产物，坏片必须变成节点失败。
// 素材与断言全部独立于实现：真 ffmpeg 生成 1 秒无声 mp4，sha256 用 node:crypto 独立重算；
// 时长偏差取 targets.durationSec 的 ±10% 口径（gates.ts 的 GATE_DURATION_TOLERANCE）。
import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecContext, Json, Output, ProjectGraph, ProjectNode, Targets } from "./types"

const WS = mkdtempSync(join(tmpdir(), "s20-gate-"))
const SID = "s20-export-gate"
const PROJECT_DIR = join(WS, "projects", SID)
const MEDIA = join(PROJECT_DIR, "media")
const UPLOADS = join(WS, "public", "uploads")

// 沙箱：必须在动态 import（timeline.ts 在模块载入时读 WORKSPACE_DIR）之前设置。
process.env.WORKSPACE_DIR = WS
process.env.KUNPENG_WORKSPACE = join(WS, "kunpeng")
process.env.HOME = join(WS, "home")
process.env.PROJECT_PUBLIC_UPLOADS_DIR = UPLOADS
process.env.PROJECT_PUBLIC_BASE_URL = "https://example.test/image-data/files/uploads"
mkdirSync(MEDIA, { recursive: true })
mkdirSync(join(WS, "home"), { recursive: true })

const { ArtifactStore } = await import("./artifacts")
const { exportExecutor } = await import("./executors/export")

const store = new ArtifactStore({ projectDir: PROJECT_DIR })
const sha256 = (buf: Uint8Array) => createHash("sha256").update(buf).digest("hex")

const ISO = "2026-10-28T00:00:00.000Z"
const USER = { kind: "user" as const }

function targetsOf(over: Partial<Targets>): Targets {
  return { setBy: USER, at: ISO, audio: "none", ...over }
}

function makeCtx(targets: Targets | null, inputs: Record<string, Output[]>, nodeId = "export_1"): ExecContext {
  const node: ProjectNode = {
    id: nodeId,
    type: "export",
    intent: "",
    params: { preset: "cinema_239" },
    inputs: { in: { from: "clip_1" } },
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
    createdAt: ISO,
    updatedAt: ISO,
    brief: [],
    decisions: [],
    targets,
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
    signature: `sig_${nodeId}`,
    runId: "run_s20",
    attempt: 1,
    take: 1,
    sessionId: SID,
    session: {} as never,
    params: { preset: "cinema_239" } as Record<string, Json>,
    inputs,
    refs: [],
    signal: new AbortController().signal,
    ingest: (src, hint) => store.ingest(src, hint),
    ledger: { write: async () => {} },
    submitGeneration: async () => ({ ok: false, code: "bad_input", message: "S20 测试不提交生成", retryable: false }),
    execBridge: {
      call: async () => ({ ok: false, code: "bridge_unavailable", message: "S20 测试不调桥", retryable: false }),
      result: async () => ({ state: "unknown" }),
    },
  }
}

let clipOut: Output

afterAll(() => rmSync(WS, { recursive: true, force: true }))

describe("S20 export 交付闸（真 ffmpeg）", () => {
  test("准备：1 秒无声 mp4（testsrc2 有运动，避免被结尾冻结修剪）", async () => {
    const file = join(MEDIA, "clip.mp4")
    execFileSync(
      "ffmpeg",
      ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=24:d=1", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-t", "1", file],
      { timeout: 120_000 },
    )
    const probe = JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], { timeout: 30_000 }).toString(),
    ) as { format?: { duration?: string } }
    expect(Number(probe.format?.duration ?? 0)).toBeGreaterThan(0.8)
    clipOut = await store.ingest({ path: file }, { port: "out", mime: "video/mp4", origin: "generated" })
    expect(clipOut.sha256).toBe(sha256(readFileSync(clipOut.path)))
  })

  test("targets.durationSec=10（偏差 90%）→ ok:false / qc_failed，deficiencies 含「时长」", async () => {
    const res = await exportExecutor.run(makeCtx(targetsOf({ durationSec: 10 }), { in: [clipOut] }))
    expect(res.ok).toBe(false)
    if (res.ok !== false) return
    expect(res.code).toBe("qc_failed")
    expect(res.retryable).toBe(false)
    expect(res.message.startsWith("交付检查未过：")).toBe(true)
    expect(res.message).toContain("时长")
  }, 180_000)

  test("targets.durationSec=1（匹配）→ ok:true，输出 sha256 独立重算一致、url 已发布", async () => {
    const res = await exportExecutor.run(makeCtx(targetsOf({ durationSec: 1 }), { in: [clipOut] }))
    if (res.ok !== true) console.error("GATE_MATCH_FAIL", JSON.stringify(res))
    expect(res.ok).toBe(true)
    if (res.ok !== true) return
    const out = res.outputs[0]
    expect(out.mime).toBe("video/mp4")
    expect(out.sha256).toBe(sha256(readFileSync(out.path)))
    expect(out.meta?.publishError).toBeUndefined()
    expect(out.url).toBe(
      `https://example.test/image-data/files/uploads/project-s20-expo-${out.artifactId}.mp4`,
    )
  }, 180_000)

  test("targets 缺省 → ok:true（只查非零且 ≤ 配方上限），输出有 sha256", async () => {
    const res = await exportExecutor.run(makeCtx(null, { in: [clipOut] }, "export_2"))
    expect(res.ok).toBe(true)
    if (res.ok !== true) return
    expect(res.outputs[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(res.outputs[0].sha256).toBe(sha256(readFileSync(res.outputs[0].path)))
  }, 180_000)
})
