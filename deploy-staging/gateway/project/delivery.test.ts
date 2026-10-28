// S20 接线 3 验收：交付卡只从 export 产物出（§3.9），文本节点永不产卡。
// 期望值独立于实现：卡片数来自「done 的 export 节点 + 有公网 url 的影音产物」，不是实现内部集合。
import { describe, expect, test } from "bun:test"
import { emitDeliveryCards } from "./delivery.ts"
import { deliverablesFromExport } from "./gates.ts"
import type { NodeType, Output, ProjectGraph, ProjectNode } from "./types.ts"

const ISO = "2026-10-28T00:00:00.000Z"
const SID = "s20-delivery"

function mkNode(over: Partial<ProjectNode> & { id: string; type: NodeType }): ProjectNode {
  return {
    intent: "",
    params: {},
    inputs: {},
    refs: [],
    pinned: null,
    status: "done",
    signature: null,
    lastRun: null,
    outputs: [],
    rev: 1,
    ...over,
  } as ProjectNode
}

function mkOutput(over: Partial<Output> & { artifactId: string; mime: string }): Output {
  return {
    port: "out",
    sha256: "a".repeat(64),
    path: `/tmp/${over.artifactId}`,
    bytes: 10,
    origin: "derived",
    ...over,
  }
}

function mkGraph(nodes: ProjectNode[]): ProjectGraph {
  return {
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
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    order: nodes.map((n) => n.id),
    budget: { capCoins: null, spentCoins: 0, savedCoins: 0 },
    activeRun: null,
    seq: 0,
  }
}

interface Emitted { name: string; data: Record<string, unknown> }

function collector(): { emit: (name: string, data: Record<string, unknown>) => void; events: Emitted[] } {
  const events: Emitted[] = []
  return { events, emit: (name, data) => events.push({ name, data }) }
}

describe("emitDeliveryCards：只认 export 产物 + 有 url", () => {
  test("一个带 url 的 export + 一个无 url 的 export + 一个文本节点 → 恰好 1 条 video.done", () => {
    const videoDone = mkNode({
      id: "export_1",
      type: "export",
      outputs: [mkOutput({ artifactId: "art_video", mime: "video/mp4", url: "https://cdn.test/a.mp4" })],
    })
    const noUrl = mkNode({
      id: "export_2",
      type: "export",
      outputs: [mkOutput({ artifactId: "art_nourl", mime: "video/mp4" })],
    })
    // 文本节点里就算有 url 也不是交付：结构上它不在 export 遍历集合里。
    const script = mkNode({
      id: "script_1",
      type: "script",
      outputs: [mkOutput({ artifactId: "art_text", mime: "text/plain", url: "https://cdn.test/note.txt" })],
    })
    const graph = mkGraph([videoDone, noUrl, script])

    // 唯一判定源：deliverablesFromExport 排除非 export 节点。
    const deliverables = deliverablesFromExport(graph)
    expect(deliverables.map((d) => d.nodeId)).toEqual(["export_1", "export_2"])

    const { emit, events } = collector()
    const seen = new Set<string>()
    const first = emitDeliveryCards(undefined, graph, emit, seen)
    expect(first.emitted).toBe(1)
    expect(events.map((e) => e.name)).toEqual(["video.done"])
    expect(events[0].data).toEqual({
      url: "https://cdn.test/a.mp4",
      cost_coins: 0,
      task_id: "export_1",
      media_kind: "film",
    })

    // 第二次调用：同 (nodeId, sha256) 不重复发。
    const second = emitDeliveryCards(undefined, graph, emit, seen)
    expect(second.emitted).toBe(0)
    expect(events).toHaveLength(1)
  })

  test("image/* 产物 → image.done；不同 sha256 同一节点各出一条卡", () => {
    const images = mkNode({
      id: "export_pack",
      type: "export",
      outputs: [
        mkOutput({ artifactId: "art_img1", mime: "image/png", sha256: "1".repeat(64), url: "https://cdn.test/1.png" }),
        mkOutput({ artifactId: "art_img2", mime: "image/jpeg", sha256: "2".repeat(64), url: "https://cdn.test/2.jpg" }),
      ],
    })
    const graph = mkGraph([images])
    const { emit, events } = collector()
    const seen = new Set<string>()
    const r = emitDeliveryCards(undefined, graph, emit, seen)
    expect(r.emitted).toBe(2)
    expect(events.map((e) => e.name)).toEqual(["image.done", "image.done"])
    expect(events.map((e) => (e.data as { media_kind: string }).media_kind)).toEqual(["image", "image"])
    expect(events.map((e) => (e.data as { task_id: string }).task_id)).toEqual(["export_pack", "export_pack"])
  })

  test("非 done / 草稿 export 不出卡；json manifest 跳过", () => {
    const failed = mkNode({
      id: "export_failed",
      type: "export",
      status: "failed",
      outputs: [mkOutput({ artifactId: "art_f", mime: "video/mp4", url: "https://cdn.test/f.mp4" })],
    })
    const scratch = mkNode({
      id: "export_scratch",
      type: "export",
      scratch: { expiresAt: ISO },
      outputs: [mkOutput({ artifactId: "art_s", mime: "video/mp4", url: "https://cdn.test/s.mp4" })],
    })
    const manifest = mkNode({
      id: "export_pack",
      type: "export",
      outputs: [mkOutput({ artifactId: "art_manifest", mime: "application/json", url: "https://cdn.test/pack.json" })],
    })
    const graph = mkGraph([failed, scratch, manifest])
    const { emit, events } = collector()
    const r = emitDeliveryCards(undefined, graph, emit, new Set<string>())
    expect(r.emitted).toBe(0)
    expect(r.skipped).toBe(1) // manifest 有 url 但不是影音
    expect(events).toHaveLength(0)
  })
})
