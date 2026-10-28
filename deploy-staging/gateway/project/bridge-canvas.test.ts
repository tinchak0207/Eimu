// ===== bridge-canvas.test.ts — S10a 画布桥：工程事件 → canvas.node.created/updated/connected =====
//
// 全部是行为断言（真跑桥 + 真写穿快照 + 真守卫），不钉源码字串：
//   - 跨端 id 等值：测试里 import src/lib/workflow-dsl/compile.ts 的 workflowNodeId 当 oracle，
//     对 100 组（projectId × nodeId）逐字比较（跨树 import 先例见 src/lib/agent-output-cards.test.ts）。
//   - 快照写穿用 canvas-cascade-state 的真 applyCanvasNode*／getCanvasState（沙箱 SESSIONS_DB_PATH，
//     与 template-guard.test.ts 同法：env 须在动态 import 之前设置）。
//   - 模板守卫不误拦：真 checkTemplateGuard + 真模板画布，证明工程节点落画布后是「既有图的一环」，
//     既不登记成模板空位，也不被当漂浮节点。
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Json, NodeType, ProjectEvent, ProjectEventKind, ProjectGraph, ProjectNode } from "./types.ts"

// 沙箱隔离：被测链（bridge-canvas → canvas-cascade-state → subagent-runs → job-store）载入后
// 按 SESSIONS_DB_PATH 开库，缺省落 /opt/agent-harness/state/sessions.db（dev 机不存在）。
const SANDBOX_DIR = mkdtempSync(join(tmpdir(), "bridge-canvas-"))
process.env.SESSIONS_DB_PATH = join(SANDBOX_DIR, "sessions.db")

const { ProjectCanvasBridge, canvasNodeTypeOf, canvasStatusOf, projectCanvasNodeId, projectWorkflowNs } = await import("./bridge-canvas.ts")
const { EventLog } = await import("./events.ts")
const { storeCanvasState, getCanvasState, listTemplateOpenSlots, listTemplateGenNodes, checkTemplateGuard } = await import(
  "../canvas-cascade-state.ts"
)
// 跨树 oracle：站点侧同一个 FNV1a 双 seed 函数（网关实现不得 import src，测试可以）。
const { workflowNodeId } = await import("../../../src/lib/workflow-dsl/compile.ts")
// 读面真值：decompile 必须能把桥接后的画布反推回工程命名空间的 DSL 步骤（forEach 实例除外）。
const { decompileWorkflow } = await import("../../../src/lib/workflow-dsl/decompile.ts")

afterAll(() => rmSync(SANDBOX_DIR, { recursive: true, force: true }))

const ISO = "2026-10-28T00:00:00.000Z"
const dev = (over: Partial<{ declared: boolean; reason: string; token: string }> = {}) => ({
  declared: false,
  reason: "",
  ...over,
})

function mkNode(over: Partial<ProjectNode> & { id: string; type: NodeType }): ProjectNode {
  return {
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
  } as ProjectNode
}

function mkGraph(nodes: ProjectNode[], opts: { id?: string; version?: number; order?: string[]; seq?: number } = {}): ProjectGraph {
  const id = opts.id ?? "b041c797-ae8c-4306-8f36-8cabf2fe47b3"
  return {
    schema: 1,
    id,
    sessionId: id,
    version: opts.version ?? 1,
    createdAt: ISO,
    updatedAt: ISO,
    brief: [],
    decisions: [],
    targets: null,
    defaults: {},
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    order: opts.order ?? nodes.map((n) => n.id),
    budget: { capCoins: null, spentCoins: 0, savedCoins: 0 },
    activeRun: null,
    seq: opts.seq ?? 0,
  }
}

function ev(kind: ProjectEventKind, node: string | undefined, data: Record<string, Json> = {}, seq = 1): ProjectEvent {
  return { seq, at: ISO, kind, ...(node ? { node } : {}), data }
}

interface CapturedFrame {
  name: string
  data: Record<string, any>
}

function mkBridge(sessionId: string): { bridge: InstanceType<typeof ProjectCanvasBridge>; frames: CapturedFrame[] } {
  const frames: CapturedFrame[] = []
  const bridge = new ProjectCanvasBridge({
    projectId: sessionId,
    sessionId,
    emit: (name: string, data: Record<string, unknown>) => frames.push({ name, data }),
  })
  return { bridge, frames }
}

describe("S10a 画布桥·事件覆盖（created/updated/connected）", () => {
  test("patch：新节点 → created（含 workflow_ns/stepId/stepIndex + project_*）、入边 → connected，并写穿快照", () => {
    const S = "s10a-created"
    const { bridge, frames } = mkBridge(S)
    const script = mkNode({ id: "script_1", type: "script", params: { text: "分镜脚本正文" }, status: "done" })
    const kf = mkNode({
      id: "keyframe_1",
      type: "keyframe",
      params: { prompt: "雨夜霓虹街", model: "seedream-4", size: "1024x1024" },
      inputs: { image: { from: "script_1" } },
      status: "pending",
    })
    const g = mkGraph([script, kf], { id: S, version: 1 })
    const r = bridge.handleEvent(ev("patch", undefined, { version: 1, nodes: ["script_1", "keyframe_1"] }, 1), g)

    expect(r.frames).toBe(3)
    expect(r.cursor).toBe(1)
    expect(frames.map((f) => f.name)).toEqual(["canvas.node.created", "canvas.node.created", "canvas.node.connected"])

    const scriptCanvasId = projectCanvasNodeId(S, "script_1")
    const kfCanvasId = projectCanvasNodeId(S, "keyframe_1")
    const node = frames[0].data.node
    expect(node.id).toBe(scriptCanvasId)
    expect(node.type).toBe("text")
    expect(node.metadata.workflow_ns).toBe(projectWorkflowNs(S))
    expect(node.metadata.workflow_id).toBe(projectWorkflowNs(S))
    expect(node.metadata.stepId).toBe("script_1")
    expect(node.metadata.stepIndex).toBe(1)
    expect(node.metadata.project_node_id).toBe("script_1")
    expect(node.metadata.project_pinned).toBe(false)
    expect(node.metadata.project_stale).toBe(false)
    expect(node.metadata.project_reused).toBe(false)
    expect(node.metadata.status).toBe("done")
    expect(node.metadata.content).toBe("分镜脚本正文")

    const kfNode = frames[1].data.node
    expect(kfNode.type).toBe("image")
    expect(kfNode.metadata.kind).toBe("image")
    expect(kfNode.metadata.prompt).toBe("雨夜霓虹街")
    expect(kfNode.metadata.status).toBe("idle") // pending → idle

    const conn = frames[2].data.connection
    expect(conn.fromNodeId).toBe(scriptCanvasId)
    expect(conn.toNodeId).toBe(kfCanvasId)

    // 写穿：快照里真的有这两颗节点与这条连线（同一帧 data）。
    const snap = getCanvasState(S)!.state as { nodes: any[]; connections: any[] }
    expect(snap.nodes.map((n) => n.id).sort()).toEqual([scriptCanvasId, kfCanvasId].sort())
    expect(snap.nodes.find((n) => n.id === kfCanvasId).metadata.project_node_id).toBe("keyframe_1")
    expect(snap.connections).toHaveLength(1)
    expect(snap.connections[0].fromNodeId).toBe(scriptCanvasId)
  })

  test("已上画布的节点再变 → updated（metadata patch 浅合并，不重建卡）", () => {
    const S = "s10a-updated"
    const { bridge, frames } = mkBridge(S)
    const kf = mkNode({ id: "keyframe_1", type: "keyframe", params: { prompt: "初稿" }, status: "pending" })
    bridge.handleEvent(ev("patch", undefined, { nodes: ["keyframe_1"] }, 1), mkGraph([kf], { id: S, version: 1 }))
    frames.length = 0

    const running = { ...kf, status: "running" as const }
    const g2 = mkGraph([running], { id: S, version: 2 })
    const r = bridge.handleEvent(ev("node_status", "keyframe_1", { from: "pending", to: "running" }, 2), g2)
    expect(r.frames).toBe(1)
    expect(frames[0].name).toBe("canvas.node.updated")
    expect(frames[0].data.node_id).toBe(projectCanvasNodeId(S, "keyframe_1"))
    expect(frames[0].data.patch.status).toBe("loading")

    const snap = getCanvasState(S)!.state as { nodes: any[] }
    const snapNode = snap.nodes.find((n) => n.id === frames[0].data.node_id)
    expect(snapNode.metadata.status).toBe("loading")
    expect(snapNode.metadata.project_node_id).toBe("keyframe_1")
    expect(snapNode.metadata.prompt).toBe("初稿") // 旧 metadata 未被整份冲掉
  })

  test("status 映射全表：pending/queued/stale→idle、running→loading、done→done、failed/blocked→error", () => {
    expect(canvasStatusOf("pending")).toBe("idle")
    expect(canvasStatusOf("queued")).toBe("idle")
    expect(canvasStatusOf("stale")).toBe("idle")
    expect(canvasStatusOf("running")).toBe("loading")
    expect(canvasStatusOf("done")).toBe("done")
    expect(canvasStatusOf("failed")).toBe("error")
    expect(canvasStatusOf("blocked")).toBe("error")
    expect(canvasNodeTypeOf("keyframe")).toBe("image")
    expect(canvasNodeTypeOf("clip")).toBe("video")
    expect(canvasNodeTypeOf("voice")).toBe("audio")
  })

  test("复用/钉住/过期标记写进 metadata（node_reused / pinned / stale / pin_drift）", () => {
    const S = "s10a-marks"
    const { bridge, frames } = mkBridge(S)
    const pinned = {
      by: "user" as const,
      at: ISO,
      outputsSha: ["a".repeat(64)],
      signatureAtPin: "sig-1",
    }
    const clip = mkNode({
      id: "clip_1",
      type: "clip",
      status: "done",
      signature: "sig-1",
      pinned,
      lastRun: { runId: "run_1", at: ISO, via: "reused", signature: "sig-1", costCoins: 0, attempt: 1 },
    })
    const g1 = mkGraph([clip], { id: S, version: 1 })
    bridge.handleEvent(ev("node_reused", "clip_1", { run: "run_1" }, 1), g1)
    const first = frames[0].data.node.metadata
    expect(first.project_reused).toBe(true)
    expect(first.project_pinned).toBe(true)
    expect(first.project_stale).toBe(false)
    expect(first.status).toBe("done")

    // 签名漂移（pinned 且当前签名≠产物签名）→ pin_drift 事件置 stale 标记。
    const drifted = { ...clip, status: "stale" as const, signature: "sig-2" }
    const g2 = mkGraph([drifted], { id: S, version: 2 })
    frames.length = 0
    bridge.handleEvent(ev("pin_drift", "clip_1", {}, 2), g2)
    expect(frames[0].name).toBe("canvas.node.updated")
    expect(frames[0].data.patch.project_stale).toBe(true)
    expect(frames[0].data.patch.project_pinned).toBe(true)
    expect(frames[0].data.patch.status).toBe("idle") // stale → idle

    // 未 pinned、未复用、非 stale 的普通节点：三个标记都是 false（首次出现 → created 帧）。
    const fresh = mkNode({ id: "clip_2", type: "clip", status: "done" })
    const g3 = mkGraph([fresh], { id: S, version: 3 })
    frames.length = 0
    bridge.handleEvent(ev("node_output", "clip_2", { port: "out" }, 3), g3)
    expect(frames[0].name).toBe("canvas.node.created")
    const md = frames[0].data.node.metadata
    expect(md.project_pinned).toBe(false)
    expect(md.project_stale).toBe(false)
    expect(md.project_reused).toBe(false)
  })

  test("forEach 实例不带 workflow_ns／workflow_id（同衍生卡规则），模板节点带", () => {
    const S = "s10a-foreach"
    const { bridge, frames } = mkBridge(S)
    const tpl = mkNode({ id: "keyframe_1", type: "keyframe", forEach: { over: "shotlist_1", as: "shot" }, params: {} })
    const inst = mkNode({
      id: "keyframe_1#r1",
      type: "keyframe",
      derivedFrom: { template: "keyframe_1", rowId: "r1" },
      params: { prompt: "第 1 行" },
    })
    const shotlist = mkNode({ id: "shotlist_1", type: "shotlist", params: { text: "行表" } })
    const g = mkGraph([shotlist, tpl, inst], { id: S, version: 1 })
    bridge.handleEvent(ev("patch", undefined, { nodes: ["shotlist_1", "keyframe_1", "keyframe_1#r1"] }, 1), g)

    const created = frames.filter((f) => f.name === "canvas.node.created")
    expect(created).toHaveLength(3)
    const mdOf = (id: string) => created.find((f) => f.data.node.id === projectCanvasNodeId(S, id))!.data.node.metadata
    expect(mdOf("keyframe_1").workflow_ns).toBe(projectWorkflowNs(S))
    expect(mdOf("keyframe_1").stepId).toBe("keyframe_1")
    expect(mdOf("keyframe_1#r1").workflow_ns).toBeUndefined()
    expect(mdOf("keyframe_1#r1").workflow_id).toBeUndefined()
    expect(mdOf("keyframe_1#r1").project_node_id).toBe("keyframe_1#r1")
    expect(mdOf("keyframe_1#r1").stepId).toBe("keyframe_1#r1")

    // 读面继续可用：decompile 从桥接后的画布反推出工程命名空间下的主节点步骤，实例被跳过。
    // （空 connections 在快照里是 {}，既有写穿形状；decompile 只吃数组，测试侧归一化。）
    const snap = getCanvasState(S)!.state as { nodes: any[]; connections: any }
    const sources = decompileWorkflow({
      nodes: Array.isArray(snap.nodes) ? snap.nodes : [],
      connections: Array.isArray(snap.connections) ? snap.connections : [],
    })
    expect(sources).toHaveLength(1)
    expect(sources[0].workflow).toBe(projectWorkflowNs(S))
    expect(sources[0].steps.map((s) => s.id)).toEqual(["shotlist_1", "keyframe_1"])
  })
})

describe("S10a 画布桥·跨端节点 id 等值", () => {
  test("100 组（projectId × nodeId）与 src/lib/workflow-dsl/compile.ts workflowNodeId 逐字相等", () => {
    const projectIds = [
      "b041c797-ae8c-4306-8f36-8cabf2fe47b3",
      "0f2e7d1a-1111-2222-3333-444455556666",
      "FFFFFFFF-0000-0000-0000-000000000000",
      "9c1b4e6f-aaaa-bbbb-cccc-ddddeeeeffff",
      "shortid",
      "会话-中文-id-0001",
      "p_already_prefixed",
      "e2ec36dcc-0000-0000-0000-000000000000",
      "12345678",
      "a",
    ]
    const nodeIds = [
      "script_1",
      "shotlist_1",
      "keyframe_1",
      "keyframe_1#r1",
      "clip_2",
      "voice_1",
      "music_1",
      "timeline_1",
      "export_1",
      "a",
    ]
    let compared = 0
    for (const projectId of projectIds) {
      for (const nodeId of nodeIds) {
        const got = projectCanvasNodeId(projectId, nodeId)
        const want = workflowNodeId(`p_${projectId.slice(0, 8)}`, nodeId)
        expect(got).toBe(want)
        expect(got).toMatch(/^wf-[0-9a-f]{16}$/)
        compared++
      }
    }
    expect(compared).toBe(100)
    // 确定性：同输入永远同 id
    expect(projectCanvasNodeId(projectIds[0], "keyframe_1")).toBe(projectCanvasNodeId(projectIds[0], "keyframe_1"))
    // 换工程（前 8 位不同）→ id 不同
    expect(projectCanvasNodeId("aaaaaaaa-0000", "keyframe_1")).not.toBe(projectCanvasNodeId("bbbbbbbb-0000", "keyframe_1"))
  })
})

describe("S10a 画布桥·不引发模板守卫误拦", () => {
  test("工程节点落画布后是「既有图的一环」：不登记为模板空位、不被当漂浮节点、可作接线锚点", () => {
    const S = "s10a-tpl-guard"
    // 真模板画布：一个空位（tpl-x-gen image，content 空）＋上游 text。
    storeCanvasState(S, {
      nodes: [
        { id: "tpl-x-prompt", type: "text", title: "画面描述", metadata: { content: "cat" } },
        { id: "tpl-x-gen", type: "image", title: "成图", metadata: {} },
      ],
      connections: [{ id: "c0", fromNodeId: "tpl-x-prompt", toNodeId: "tpl-x-gen" }],
    })
    expect(listTemplateOpenSlots(S).map((s) => s.id)).toEqual(["tpl-x-gen"])

    const kf = mkNode({ id: "keyframe_1", type: "keyframe", params: { prompt: "猫" } })
    const g = mkGraph([kf], { id: S, version: 1 })
    const canvasId = projectCanvasNodeId(S, "keyframe_1")

    // 陷阱（证明为什么不能走 ops 通道）：同一颗 keyframe 若以 add_node 提交，守卫判「平行重复生成」。
    const trapOps = [
      { type: "add_node", node: { id: canvasId, type: "image", metadata: { project_node_id: "keyframe_1" } } },
      { type: "connect_nodes", connections: [{ fromNodeId: "tpl-x-prompt", toNodeId: canvasId }] },
    ]
    expect(checkTemplateGuard(S, trapOps, dev())).not.toBeNull()

    // 桥接路径：不发 ops，直接 created 帧 + 写穿快照。
    const { bridge, frames } = mkBridge(S)
    const r = bridge.handleEvent(ev("patch", undefined, { nodes: ["keyframe_1"], version: 1 }, 1), g)
    expect(r.frames).toBe(1)
    expect(frames.every((f) => f.name.startsWith("canvas.node."))).toBe(true) // 无 canvas.ops
    expect(frames.some((f) => "ops" in f.data)).toBe(false)

    const snap = getCanvasState(S)!.state as { nodes: any[] }
    expect(snap.nodes.some((n) => n.id === canvasId)).toBe(true)

    // 工程节点：既不是模板生成卡（不进空位清单），也没有把模板空位挤掉。
    expect(listTemplateGenNodes(S).some((s) => s.id === canvasId)).toBe(false)
    expect(listTemplateOpenSlots(S).map((s) => s.id)).toEqual(["tpl-x-gen"])

    // 以工程节点为既有锚点的合法接线加法照常放行（工程节点是图的一环，不是漂浮节点）。
    const okOps = [
      { type: "add_node", node: { id: "n-extra", type: "video", metadata: { role: "额外镜头" } } },
      { type: "connect_nodes", connections: [{ fromNodeId: canvasId, toNodeId: "n-extra" }] },
    ]
    expect(checkTemplateGuard(S, okOps, dev())).toBeNull()
  })
})

describe("S10a 画布桥·事件消费与性能", () => {
  test("pump：从 EventLog 追平，cursor 前进，第二次无新事件", async () => {
    const S = "s10a-pump"
    const log = new EventLog(join(SANDBOX_DIR, "events.jsonl"))
    const kf = mkNode({ id: "keyframe_1", type: "keyframe", params: { prompt: "p" } })
    const g = mkGraph([kf], { id: S, version: 1, seq: 3 })
    await log.append(
      [
        { kind: "patch", data: { version: 1, nodes: ["keyframe_1"] } },
        { kind: "node_status", node: "keyframe_1", data: { from: "pending", to: "running" } },
        { kind: "node_reused", node: "keyframe_1", data: {} },
      ],
      1,
      ISO,
    )
    const { bridge, frames } = mkBridge(S)
    const first = await bridge.pump(log, () => g)
    expect(first.events).toBe(3)
    expect(first.cursor).toBe(3)
    expect(first.frames).toBeGreaterThanOrEqual(3)
    expect(frames[0].name).toBe("canvas.node.created")
    expect(frames.filter((f) => f.name === "canvas.node.updated")).toHaveLength(2)

    const again = await bridge.pump(log, () => g)
    expect(again.events).toBe(0)
    expect(again.frames).toBe(0)
  })

  test("单事件处理 ≤5ms（12 节点图，200 条 node_status 平均耗时）", () => {
    const S = "s10a-perf"
    const { bridge } = mkBridge(S)
    const nodes: ProjectNode[] = []
    for (let i = 0; i < 12; i++) {
      nodes.push(
        mkNode({
          id: `keyframe_${i}`,
          type: "keyframe",
          params: { prompt: `p${i}`, model: "m", size: "1024x1024" },
          ...(i > 0 ? { inputs: { image: { from: `keyframe_${i - 1}` } } } : {}),
        }),
      )
    }
    const g = mkGraph(nodes, { id: S, version: 1 })
    bridge.handleEvent(ev("patch", undefined, { nodes: nodes.map((n) => n.id) }, 1), g) // 预热：建卡＋算座标

    const started = performance.now()
    const ROUNDS = 200
    for (let i = 0; i < ROUNDS; i++) {
      const node = nodes[i % nodes.length]
      node.status = i % 2 === 0 ? "running" : "done"
      bridge.handleEvent(ev("node_status", node.id, { to: node.status }, 2 + i), g)
    }
    const avgMs = (performance.now() - started) / ROUNDS
    expect(avgMs).toBeLessThan(5)
  })
})
