// S20b 验收：image_pack 的每一件产物都真正交付（manifest + 逐件公网 URL + 逐张交付卡）。
// 期望值独立于实现：sha256 现场重算、卡片数 = 「done 的 export 节点里有 url 的 image/* 产物数」。
// 不 mock exportExecutor 本体；publish 走真文件复制（临时 uploads 目录）。
import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecContext, Json, Output, ProjectGraph, ProjectNode } from "../types"

const WS = mkdtempSync(join(tmpdir(), "s20b-image-pack-"))
const SID = "s20b-image-pack"
const PROJECT_DIR = join(WS, "projects", SID)
const ARTIFACTS = join(PROJECT_DIR, "artifacts")
const MEDIA = join(PROJECT_DIR, "media")
const UPLOADS = join(WS, "public", "uploads")
const BASE = "https://example.test/image-data/files/uploads"

// 沙箱：必须在动态 import（timeline.ts 在模块载入时读 WORKSPACE_DIR）之前设置。
process.env.WORKSPACE_DIR = WS
process.env.KUNPENG_WORKSPACE = join(WS, "kunpeng")
process.env.HOME = join(WS, "home")
process.env.PROJECT_PUBLIC_UPLOADS_DIR = UPLOADS
process.env.PROJECT_PUBLIC_BASE_URL = BASE
mkdirSync(ARTIFACTS, { recursive: true })
mkdirSync(MEDIA, { recursive: true })
mkdirSync(join(WS, "home"), { recursive: true })

const { exportExecutor } = await import("./export")
const { signedTestCriticVerdictOutput } = await import("./qc.fixture")
const { emitDeliveryCards } = await import("../delivery")

afterAll(() => rmSync(WS, { recursive: true, force: true }))

// 两张真 1x1 PNG（字节不同），不联网。
const PNG_A = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
)
const PNG_B = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
)
const PNG_A_PATH = join(MEDIA, "a.png")
const PNG_B_PATH = join(MEDIA, "b.png")
writeFileSync(PNG_A_PATH, PNG_A)
writeFileSync(PNG_B_PATH, PNG_B)

const sha256 = (buf: Uint8Array) => createHash("sha256").update(buf).digest("hex")
const extOf = (mime: string) => (mime === "application/json" ? ".json" : mime === "image/png" ? ".png" : ".bin")

/** 假 ingest：复制进临时 artifact 目录，按内容算 sha256（与 artifact-store 同一算法）。 */
async function ingestTest(
  src: { path: string } | { url: string },
  hint: { port: string; mime?: string; origin: Output["origin"] },
): Promise<Output> {
  if (!("path" in src)) throw new Error("测试 ingest 只支持本地 path")
  const buf = readFileSync(src.path)
  const sha = sha256(buf)
  const artifactId = `art_${sha.slice(0, 16)}`
  const mime = hint.mime ?? "application/octet-stream"
  const dest = join(ARTIFACTS, `${artifactId}${extOf(mime)}`)
  writeFileSync(dest, buf)
  return { port: hint.port, artifactId, sha256: sha, path: dest, mime, bytes: buf.length, origin: hint.origin }
}

const INPUT_A: Output = {
  port: "out",
  artifactId: `art_${sha256(PNG_A).slice(0, 16)}`,
  sha256: sha256(PNG_A),
  path: PNG_A_PATH,
  mime: "image/png",
  bytes: PNG_A.length,
  origin: "generated",
}
const INPUT_B: Output = {
  port: "out",
  artifactId: `art_${sha256(PNG_B).slice(0, 16)}`,
  sha256: sha256(PNG_B),
  path: PNG_B_PATH,
  mime: "image/png",
  bytes: PNG_B.length,
  origin: "generated",
}

const ISO = "2026-10-28T00:00:00.000Z"

function makeCtx(nodeId: string, inputs: Record<string, Output[]>): ExecContext {
  const node: ProjectNode = {
    id: nodeId,
    type: "export",
    intent: "",
    params: { preset: "image_pack" },
    inputs: { in: { from: "keyframe_1" } },
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
    signature: `sig_${nodeId}`,
    runId: "run_s20b",
    attempt: 1,
    take: 1,
    sessionId: SID,
    session: {} as never,
    params: { preset: "image_pack" } as Record<string, Json>,
    inputs: inputs.verdict ? inputs : {
      ...inputs,
      verdict: [signedTestCriticVerdictOutput(MEDIA, {
        parentSessionId: SID,
        artifactSha256: (Object.values(inputs).flat().find((o) => o.mime.startsWith("image/")) ?? INPUT_A).sha256,
        rubric: "image_default",
      })],
    },
    refs: [],
    signal: new AbortController().signal,
    ingest: (src, hint) => ingestTest(src, hint),
    ledger: { write: async () => {} },
    submitGeneration: async () => ({ ok: false, code: "bad_input", message: "S20b 测试不提交生成", retryable: false }),
    execBridge: {
      call: async () => ({ ok: false, code: "bridge_unavailable", message: "S20b 测试不调桥", retryable: false }),
      result: async () => ({ state: "unknown" }),
    },
  }
}

function graphWith(exportNodeId: string, outputs: Output[]): ProjectGraph {
  const node: ProjectNode = {
    id: exportNodeId,
    type: "export",
    intent: "",
    params: { preset: "image_pack" },
    inputs: {},
    refs: [],
    pinned: null,
    status: "done",
    signature: null,
    lastRun: null,
    outputs,
    rev: 1,
  }
  return {
    schema: 1,
    id: SID,
    sessionId: SID,
    version: 2,
    createdAt: ISO,
    updatedAt: ISO,
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
}

interface Emitted { name: string; data: Record<string, unknown> }

describe("image_pack 真正交付：逐件公网 URL", () => {
  test("2 张图 → manifest + 2 个 image 输出，全部有 url，sha256 与文件实算一致", async () => {
    const res = await exportExecutor.run(makeCtx("export_pack", { in: [INPUT_A, INPUT_B] }))
    if (res.ok !== true) console.error("IMAGE_PACK_RUN_FAIL", JSON.stringify(res))
    expect(res.ok).toBe(true)
    if (res.ok !== true) return

    expect(res.outputs).toHaveLength(3) // 1 manifest + 2 图
    const [manifestOut, imgA, imgB] = res.outputs

    // manifest：现有字段/meta 不变，只多了 url。
    expect(manifestOut.mime).toBe("application/json")
    expect(manifestOut.port).toBe("out")
    expect(manifestOut.meta).toEqual({ preset: "image_pack", itemCount: 2, totalBytes: PNG_A.length + PNG_B.length, kind: "image_pack" })
    expect(typeof manifestOut.url).toBe("string")
    expect(manifestOut.url!.startsWith(BASE)).toBe(true)

    // 逐件：顺序与 manifestItems 一致，sha256 独立重算。
    expect(imgA.mime).toBe("image/png")
    expect(imgA.sha256).toBe(sha256(readFileSync(imgA.path)))
    expect(imgA.sha256).toBe(sha256(PNG_A))
    expect(imgA.bytes).toBe(PNG_A.length)
    expect(imgA.origin).toBe("derived")
    expect(imgA.meta?.publishError).toBeUndefined()
    expect(imgA.url).toBe(`${BASE}/project-${SID.slice(0, 8).replace(/[^A-Za-z0-9_-]/g, "")}-${imgA.artifactId}.png`)

    expect(imgB.sha256).toBe(sha256(readFileSync(imgB.path)))
    expect(imgB.sha256).toBe(sha256(PNG_B))
    expect(imgB.bytes).toBe(PNG_B.length)
    expect(imgB.meta?.publishError).toBeUndefined()
    expect(imgB.url).toBe(`${BASE}/project-${SID.slice(0, 8).replace(/[^A-Za-z0-9_-]/g, "")}-${imgB.artifactId}.png`)

    // 公网文件真的落盘且内容一致（交付不是只登记 URL）。
    expect(readFileSync(join(UPLOADS, imgA.url!.slice(BASE.length + 1))).equals(PNG_A)).toBe(true)
    expect(readFileSync(join(UPLOADS, imgB.url!.slice(BASE.length + 1))).equals(PNG_B)).toBe(true)
  })

  test("交付卡：恰好 2 条 image.done、0 条 video.done；第二次调用 0 条", async () => {
    const res = await exportExecutor.run(makeCtx("export_cards", { in: [INPUT_A, INPUT_B] }))
    expect(res.ok).toBe(true)
    if (res.ok !== true) return

    const graph = graphWith("export_cards", res.outputs)
    const events: Emitted[] = []
    const emit = (name: string, data: Record<string, unknown>) => events.push({ name, data })
    const seen = new Set<string>()

    const first = emitDeliveryCards(undefined, graph, emit, seen)
    expect(first.emitted).toBe(2)
    expect(events.filter((e) => e.name === "image.done")).toHaveLength(2)
    expect(events.filter((e) => e.name === "video.done")).toHaveLength(0)
    expect(events.map((e) => e.data.url)).toEqual([res.outputs[1].url, res.outputs[2].url])
    expect(events.map((e) => e.data.media_kind)).toEqual(["image", "image"])
    expect(events.map((e) => e.data.task_id)).toEqual(["export_cards", "export_cards"])

    const second = emitDeliveryCards(undefined, graph, emit, seen)
    expect(second.emitted).toBe(0)
    expect(events).toHaveLength(2)
  })

  test("负例：uploads 目录不可建（父路径是普通文件）→ ok:true，图输出无 url 有 publishError，0 条卡", async () => {
    const blocker = join(WS, "blocker")
    writeFileSync(blocker, "not a directory")
    const prev = process.env.PROJECT_PUBLIC_UPLOADS_DIR
    process.env.PROJECT_PUBLIC_UPLOADS_DIR = join(blocker, "uploads")
    try {
      const res = await exportExecutor.run(makeCtx("export_blocked", { in: [INPUT_A, INPUT_B] }))
      // 发布失败不阻断交付：节点仍然成功，产物仍在。
      expect(res.ok).toBe(true)
      if (res.ok !== true) return
      expect(res.outputs).toHaveLength(3)
      for (const out of res.outputs) expect(out.url).toBeUndefined()
      for (const img of [res.outputs[1], res.outputs[2]]) {
        expect(img.mime).toBe("image/png")
        expect(img.sha256).toBe(sha256(readFileSync(img.path)))
        const reason = img.meta?.publishError
        expect(typeof reason).toBe("string")
        expect((reason as string).length).toBeGreaterThan(0)
        expect((reason as string).length).toBeLessThanOrEqual(200)
      }

      const graph = graphWith("export_blocked", res.outputs)
      const events: Emitted[] = []
      const r = emitDeliveryCards(undefined, graph, (name, data) => events.push({ name, data }), new Set<string>())
      expect(r.emitted).toBe(0)
      expect(events).toHaveLength(0)
    } finally {
      process.env.PROJECT_PUBLIC_UPLOADS_DIR = prev
    }
  })
})
