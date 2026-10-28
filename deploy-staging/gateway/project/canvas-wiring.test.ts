// S20 接线 3 验收：画布追平与交付卡的运行时接线。
// 真实 ProjectStore + 真实 events.jsonl + 真画布写穿（沙箱 SESSIONS_DB_PATH），只把「网关会话」换成最小假 state。
// 判准：首次 pump 有 canvas.node.created（写穿快照可见），第二次 frames=0（幂等）；
//       交付卡只对带 url 的 export 产物出，且第二次不重复。
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Output, ProjectGraph, ProjectNode } from "./types.ts"

// 沙箱：routes.ts 的依赖链（sessions-core / job-store / canvas-cascade-state）在模块载入时会读这些 env。
const ROOT = mkdtempSync(join(tmpdir(), "s20-canvas-"))
process.env.WORKSPACE_DIR = join(ROOT, "workspace")
process.env.SESSIONS_DB_PATH = join(ROOT, "sessions.db")
process.env.LEDGER_PATH = join(ROOT, "ledger.jsonl")
process.env.HARNESS_INTERNAL_TOKEN = "s20-test-token"
mkdirSync(process.env.WORKSPACE_DIR, { recursive: true })

const routes = await import("./routes.ts")
const { ensureProject } = await import("./store.ts")
const { emitDeliveryCards } = await import("./delivery.ts")
const { getCanvasState } = await import("../canvas-cascade-state.ts")

const ISO = "2026-10-28T00:00:00.000Z"

afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

/** 最小网关会话 state：只带 emitToSession / markDirty 会碰到的字段。 */
function makeState(sessionId: string): any {
  return {
    sessionId,
    replayBuffer: [] as unknown[],
    clients: new Set(),
    eventCounter: 0,
    pendingConfirms: new Map(),
    resolvedConfirms: new Map(),
    pendingQuestions: new Map(),
  }
}

const node = (id: string, type: ProjectNode["type"], over: Partial<ProjectNode> = {}): ProjectNode => ({
  id,
  type,
  intent: "",
  params: {},
  inputs: {},
  refs: [],
  pinned: null,
  status: "pending",
  signature: null,
  lastRun: null,
  outputs: [],
  rev: 1,
  ...over,
})

const output = (over: Partial<Output> & { artifactId: string; mime: string }): Output => ({
  port: "out",
  sha256: "a".repeat(64),
  path: `/tmp/${over.artifactId}`,
  bytes: 1,
  origin: "derived",
  ...over,
})

function mkGraph(nodes: ProjectNode[], seq = 0): ProjectGraph {
  const sid = "s20-cards"
  return {
    schema: 1,
    id: sid,
    sessionId: sid,
    version: 1,
    createdAt: ISO,
    updatedAt: ISO,
    brief: [],
    decisions: [],
    targets: null,
    defaults: {},
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    order: nodes.map((n) => n.id),
    budget: { capCoins: null, spentCoins: 0, savedCoins: 0 },
    activeRun: null,
    seq,
  }
}

describe("pumpCanvas：事件 → 画布（幂等）", () => {
  test("首次 pump 出 canvas.node.created 且写穿快照；第二次 frames=0", async () => {
    const sid = "s20_canvas_pump"
    const { store } = await ensureProject(sid)
    const added = await store.applyPatches(
      {
        ops: [
          { op: "add_node", node: { id: "script_1", type: "script", params: { text: "分镜" } } },
          { op: "add_node", node: { id: "keyframe_1", type: "keyframe", params: { prompt: "雨夜站台" } } },
        ] as never,
      },
      { kind: "agent" },
    )
    expect(added.receipt.ok).toBe(true)

    // 手工追加两条事件（模拟引擎状态流），seq 接在已提交图之后。
    const before = await store.read()
    await store.log.append(
      [
        { kind: "node_status", node: "keyframe_1", data: { from: "pending", to: "running" } },
        { kind: "node_status", node: "keyframe_1", data: { from: "running", to: "done" } },
      ],
      before.seq + 1,
      ISO,
    )

    const state = makeState(sid)
    routes.resetProjectStores()
    const first = await routes.pumpCanvas(store, state)
    expect(first.frames).toBeGreaterThan(0) // 首屏 syncGraph 的 created 也算
    expect(first.events).toBe(2)

    // 写穿：快照里真有这两颗画布节点（不是只发帧）。
    const snap = getCanvasState(sid)?.state as { nodes?: { metadata?: { project_node_id?: string } }[] } | undefined
    const projectNodeIds = (snap?.nodes ?? []).map((n) => n.metadata?.project_node_id).sort()
    expect(projectNodeIds).toEqual(["keyframe_1", "script_1"])

    const second = await routes.pumpCanvas(store, state)
    expect(second.frames).toBe(0)
    expect(second.events).toBe(0)
  })
})

describe("emitDeliveryCards：只对带 url 的 export 产物出卡", () => {
  test("3 节点图（export 有 url / export 无 url / 文本）→ 1 条 video.done；第二次 0 条", () => {
    const graph = mkGraph([
      node("export_1", "export", {
        status: "done",
        outputs: [output({ artifactId: "art_v", mime: "video/mp4", url: "https://cdn.test/film.mp4" })],
      }),
      node("export_2", "export", {
        status: "done",
        outputs: [output({ artifactId: "art_n", mime: "video/mp4" })],
      }),
      node("script_1", "script", {
        status: "done",
        outputs: [output({ artifactId: "art_t", mime: "text/plain", url: "https://cdn.test/script.txt" })],
      }),
    ])
    const frames: { name: string; data: Record<string, unknown> }[] = []
    const emit = (name: string, data: Record<string, unknown>) => frames.push({ name, data })
    const seen = new Set<string>()

    const first = emitDeliveryCards(makeState("s20-cards"), graph, emit, seen)
    expect(first.emitted).toBe(1)
    expect(frames.map((f) => f.name)).toEqual(["video.done"])
    expect(frames[0].data.task_id).toBe("export_1")

    const second = emitDeliveryCards(makeState("s20-cards"), graph, emit, seen)
    expect(second.emitted).toBe(0)
    expect(frames).toHaveLength(1)
  })
})
