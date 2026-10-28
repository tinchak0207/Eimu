// ===== bridge-canvas.ts — S10a：工程事件 → 既有画布事件（canvas.node.created/updated/connected）=====
//
// 设计文档 §3.4「画布呈现（不新造图）」：工程图不另造前端渲染器，直接复用现有
// world2→world1 事件桥已在用的三帧形态（workflow-gw-service.ts:39-80 的 emit +
// applyCanvasNode* 写穿快照同构）。画布节点 id 用 compile.ts:81 同一个 FNV1a 双 seed
// 16hex 算法派生 `workflowNodeId("p_"+projectId前8位, nodeId)`；跨端等值由
// bridge-canvas.test.ts 逐字对 src/lib/workflow-dsl/compile.ts 锁定。
//
// 明确不走 canvas ops 通道：工程节点不是「模板新增节点」。若经 dispatchCanvasOps 提交
// add_node，canvas-cascade-state.ts:604 的 checkTemplateGuard 会把它当平行重复生成／
// 漂浮节点拦下（TEMPLATE_SLOT_OPEN）——本桥只发 canvas.node.* 帧并写穿快照，工程节点
// 在画布上落地即「既有图的一环」，放大后自然成为后续接线的锚点。
//
// 事件消费面：events.ts 的 EventLog（追加式 events.jsonl，seq=行号）。handleEvent 逐条
// 同步处理；pump 从游标追平。整图对账用 syncGraph（重启/首次接入）。
import { applyCanvasNodeConnected, applyCanvasNodeCreated, applyCanvasNodeUpdated } from "../canvas-cascade-state.ts"
import { computeSwimlanePositions } from "../workflow-service-swimlane.ts"
import type { EventLog } from "./events.ts"
import type { NodeId, NodeStatus, NodeType, ProjectEvent, ProjectGraph, ProjectNode } from "./types.ts"

// ─────────────────────────── 确定性画布节点 id（与 compile.ts 逐字同构）

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193
/** 黄金比例常数：第二轮杂凑的 seed 异扰，防两轮同串碰撞（compile.ts 同值）。 */
const SECOND_ROUND_SEED = 0x9e3779b9

function fnv1a32(seed: number, input: string): number {
  let hash = seed >>> 0
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

function toHex8(value: number): string {
  return value.toString(16).padStart(8, "0")
}

/** 工程命名空间：p_ + projectId 前 8 位（sessionId 即 projectId，v1 一会话一工程）。 */
export function projectWorkflowNs(projectId: string): string {
  return `p_${String(projectId).slice(0, 8)}`
}

/** 工程节点 → 画布节点 id：与 compile.ts workflowNodeId 同一个 FNV1a 双 seed 16hex。 */
export function projectCanvasNodeId(projectId: string, nodeId: NodeId): string {
  const key = `${projectWorkflowNs(projectId)}/${nodeId}`
  const h1 = fnv1a32(FNV_OFFSET_BASIS, key)
  const h2 = fnv1a32(FNV_OFFSET_BASIS ^ SECOND_ROUND_SEED, key)
  return `wf-${toHex8(h1)}${toHex8(h2)}`
}

// ─────────────────────────── 型别／状态映射

/** 工程 NodeType → 画布节点型别（值域＝src/lib/canvas/types.ts CanvasNodeType，网关不 import src）。 */
const CANVAS_NODE_TYPE_BY_PROJECT: Readonly<Record<NodeType, string>> = {
  reference: "image",
  script: "text",
  shotlist: "text",
  keyframe: "image",
  clip: "video",
  voice: "audio",
  music: "audio",
  timeline: "config",
  subtitle: "text",
  mix: "config",
  export: "config",
  qc: "config",
  render3d: "director",
}

export function canvasNodeTypeOf(type: NodeType): string {
  return CANVAS_NODE_TYPE_BY_PROJECT[type] ?? "config"
}

export type CanvasNodeStatus = "idle" | "loading" | "done" | "error"

/** 工程节点状态 → 画布状态（设计文档 §3.4 明文：pending/queued/stale→idle，running→loading，done→done，failed/blocked→error）。 */
export function canvasStatusOf(status: NodeStatus): CanvasNodeStatus {
  switch (status) {
    case "running":
      return "loading"
    case "done":
      return "done"
    case "failed":
    case "blocked":
      return "error"
    case "pending":
    case "queued":
    case "stale":
      return "idle"
    default:
      // skipped / orphaned：既没在跑也没有可用的新产物，按 idle 呈现（不虚构状态）。
      return "idle"
  }
}

/** forEach 实例 = 引擎展开的真节点（id 带 #row.id 或 derivedFrom 指向模板）。实例不带 workflow_ns（同衍生卡规则）。 */
export function isForEachInstance(node: Pick<ProjectNode, "id" | "derivedFrom">): boolean {
  return node.id.includes("#") || node.derivedFrom !== undefined
}

// ─────────────────────────── 帧形状（与 workflow-gw-service / events-translate-canvas 同构）

export type CanvasBridgeEventName = "canvas.node.created" | "canvas.node.updated" | "canvas.node.connected"
export type CanvasBridgeEmit = (name: CanvasBridgeEventName, data: Record<string, unknown>) => void

/** 写穿快照面（默认＝canvas-cascade-state 的 applyCanvasNode*；可注入供测试/替代写面）。 */
export interface CanvasBridgeWriteThrough {
  created(sessionId: string, payload: unknown): void
  updated(sessionId: string, payload: unknown): void
  connected(sessionId: string, payload: unknown): void
}

export const DEFAULT_CANVAS_WRITE_THROUGH: CanvasBridgeWriteThrough = {
  created: applyCanvasNodeCreated,
  updated: applyCanvasNodeUpdated,
  connected: applyCanvasNodeConnected,
}

export interface CanvasBridgeOptions {
  /** 工程 id（v1 = sessionId）。 */
  projectId: string
  /** 画布快照归属的 gateway sessionId（通常与 projectId 相同）。 */
  sessionId: string
  emit: CanvasBridgeEmit
  writeThrough?: CanvasBridgeWriteThrough
}

export interface CanvasBridgeResult {
  /** 本次处理发出的 canvas.* 帧数（created/updated/connected 合计）。 */
  frames: number
  /** 已处理的最大事件 seq。 */
  cursor: number
}

interface CanvasBridgeFrame {
  name: CanvasBridgeEventName
  data: Record<string, unknown>
}

interface LayoutCache {
  version: number
  positions: Map<string, { x: number; y: number }>
  orderIndex: Map<string, number>
}

const NODE_WIDTH = 300
const NODE_HEIGHT = 220

// ─────────────────────────── metadata

interface MetadataFlags {
  /** pin_drift 事件：pinned 且签名漂移（画布上按 stale 标记）。 */
  drift?: boolean
  /** node_reused 事件：本轮复用旧产物（免跑）。 */
  reused?: boolean
}

/**
 * 工程节点 → 画布 metadata：
 *  - workflow_ns/stepId/stepIndex（主节点）让现有 decompile 读面继续可用；forEach 实例刻意不带 workflow_ns。
 *  - project_node_id/project_sig/project_pinned/project_stale/project_reused（S10b 白名单新键）。
 *  - status 为映射后的画布状态；content/prompt/model/size 供现有画布卡片渲染（可读面，不进工程图）。
 */
function projectNodeMetadata(
  node: Readonly<ProjectNode>,
  ns: string,
  stepIndex: number | null,
  flags: MetadataFlags,
): Record<string, unknown> {
  const params = (node.params ?? {}) as Record<string, unknown>
  const md: Record<string, unknown> = { status: canvasStatusOf(node.status) }
  if (node.type === "keyframe") md.kind = "image"
  else if (node.type === "clip") md.kind = "video"
  if (typeof params.prompt === "string") md.prompt = params.prompt
  if (typeof params.model === "string") md.model = params.model
  if (typeof params.size === "string") md.size = params.size
  if (typeof params.count === "number") md.count = params.count
  // content：文本类节点的正文，否则落第一件产物的公网地址（现有画布卡片靠它出图/出片）。
  const text = typeof params.text === "string" ? params.text : ""
  const url = node.outputs?.[0]?.url ?? ""
  md.content = text || url
  md.stepId = node.id
  if (!isForEachInstance(node)) {
    md.workflow_id = ns
    md.workflow_ns = ns
    if (stepIndex !== null) md.stepIndex = stepIndex
  }
  md.project_node_id = node.id
  md.project_sig = node.signature ?? ""
  md.project_pinned = node.pinned !== null && node.pinned !== undefined
  md.project_stale = node.status === "stale" || flags.drift === true
  md.project_reused = node.lastRun?.via === "reused" || flags.reused === true
  return md
}

function titleOfNode(node: Readonly<ProjectNode>): string {
  const intent = typeof node.intent === "string" ? node.intent.trim() : ""
  return intent ? intent.slice(0, 80) : node.id
}

// ─────────────────────────── 桥本体

export class ProjectCanvasBridge {
  readonly projectId: string
  readonly sessionId: string
  /** 工程命名空间（画布 metadata.workflow_ns 与 id 派生的同一串）。 */
  readonly namespace: string

  private readonly emit: CanvasBridgeEmit
  private readonly writeThrough: CanvasBridgeWriteThrough
  /** 已发过 created 的画布节点 id（进程内；重启后由 syncGraph / 首条事件重新建）。 */
  private readonly created = new Set<string>()
  /** 已发过 connected 的边（`from>to`）。 */
  private readonly connected = new Set<string>()
  private layout: LayoutCache | null = null
  private lastSeq = 0

  constructor(opts: CanvasBridgeOptions) {
    this.projectId = opts.projectId
    this.sessionId = opts.sessionId
    this.namespace = projectWorkflowNs(opts.projectId)
    this.emit = opts.emit
    this.writeThrough = opts.writeThrough ?? DEFAULT_CANVAS_WRITE_THROUGH
  }

  /** 已处理的最大事件 seq（pump 的续跑游标）。 */
  get cursor(): number {
    return this.lastSeq
  }

  canvasNodeId(nodeId: NodeId): string {
    return projectCanvasNodeId(this.projectId, nodeId)
  }

  /**
   * 处理一条工程事件：受影响的节点逐个出 created（首见）或 updated（已上画布），
   * patch 类事件顺带补齐这些节点的入边（connected）。同步、幂等（重放安全）。
   */
  handleEvent(event: ProjectEvent, graph: Readonly<ProjectGraph>): CanvasBridgeResult {
    const out: CanvasBridgeFrame[] = []
    const flags: MetadataFlags =
      event.kind === "pin_drift" ? { drift: true } : event.kind === "node_reused" ? { reused: true } : {}
    const affected = this.affectedNodes(event, graph)
    for (const id of affected) {
      const node = graph.nodes[id]
      if (!node) continue // 节点已删：契约没有删除事件，静默跳过（画布保留旧卡，由 S10b 人手收敛）
      this.frameNode(node, graph, flags, out)
    }
    if (event.kind === "patch") this.syncEdges(affected, graph, out)
    this.lastSeq = Math.max(this.lastSeq, typeof event.seq === "number" ? event.seq : this.lastSeq)
    this.deliver(out)
    return { frames: out.length, cursor: this.lastSeq }
  }

  /**
   * 整图对账（首次接入／网关重启）：把图上还没有 created 的节点补齐、缺的边补齐。
   * 幂等；已发过的节点不再重发（避免覆盖用户拖过的位置）。
   */
  syncGraph(graph: Readonly<ProjectGraph>): CanvasBridgeResult {
    const out: CanvasBridgeFrame[] = []
    const ids = this.allNodeIds(graph)
    for (const id of ids) {
      const node = graph.nodes[id]
      if (!node) continue
      if (this.created.has(this.canvasNodeId(id))) continue
      this.frameNode(node, graph, {}, out)
    }
    this.syncEdges(ids, graph, out)
    this.lastSeq = Math.max(this.lastSeq, typeof graph.seq === "number" ? graph.seq : this.lastSeq)
    this.deliver(out)
    return { frames: out.length, cursor: this.lastSeq }
  }

  /**
   * 从 EventLog 追平：读 seq > since 的事件，用同一份最新图逐条处理（画布要的是
   * 每节点的最新真相，逐条重放旧图会导致状态回退）。返回处理条数与新游标。
   */
  async pump(
    log: EventLog,
    loadGraph: () => Promise<Readonly<ProjectGraph>> | Readonly<ProjectGraph>,
    opts: { since?: number } = {},
  ): Promise<{ cursor: number; events: number; frames: number }> {
    const since = typeof opts.since === "number" ? opts.since : this.lastSeq
    const events = await log.read(since)
    if (events.length === 0) return { cursor: this.lastSeq, events: 0, frames: 0 }
    const graph = await loadGraph()
    let frames = 0
    for (const event of events) frames += this.handleEvent(event, graph).frames
    return { cursor: this.lastSeq, events: events.length, frames }
  }

  // ── 内部

  private allNodeIds(graph: Readonly<ProjectGraph>): NodeId[] {
    const ids: NodeId[] = []
    const seen = new Set<string>()
    for (const id of graph.order ?? []) {
      if (!graph.nodes[id] || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
    for (const id of Object.keys(graph.nodes ?? {})) {
      if (seen.has(id) || !graph.nodes[id]) continue
      seen.add(id)
      ids.push(id)
    }
    return ids
  }

  /** 事件影响的节点集：事件自带 node ＋ patch 的 changed 清单 ＋ run_* 的目标清单。 */
  private affectedNodes(event: ProjectEvent, graph: Readonly<ProjectGraph>): NodeId[] {
    const ids = new Set<NodeId>()
    if (typeof event.node === "string" && event.node) ids.add(event.node)
    const data = (event.data ?? {}) as Record<string, unknown>
    const pushArray = (value: unknown): void => {
      if (!Array.isArray(value)) return
      for (const item of value) if (typeof item === "string" && item) ids.add(item)
    }
    if (event.kind === "patch") {
      pushArray(data.nodes)
      // changed 只带前 20 个；溢出时把还没上画布的节点一并补建，避免漏卡。
      if (typeof data.more === "number" && data.more > 0) {
        for (const id of this.allNodeIds(graph)) {
          if (!this.created.has(this.canvasNodeId(id))) ids.add(id)
        }
      }
    }
    if (event.kind === "run_started" || event.kind === "run_finished") {
      pushArray(data.targets)
      pushArray(data.reuse)
      pushArray(data.pinned)
      pushArray(data.nodes)
    }
    return [...ids]
  }

  private layoutFor(graph: Readonly<ProjectGraph>): LayoutCache {
    const version = typeof graph.version === "number" ? graph.version : -1
    if (this.layout && this.layout.version === version) return this.layout
    const ids = this.allNodeIds(graph)
    const canvasIdOf = new Map<string, string>()
    const projectIdOf = new Map<string, string>()
    for (const id of ids) {
      const canvasId = this.canvasNodeId(id)
      canvasIdOf.set(id, canvasId)
      projectIdOf.set(canvasId, id)
    }
    const swimNodes = ids.map((id) => ({ id: canvasIdOf.get(id)!, role: id }))
    const swimEdges: { from: string; to: string }[] = []
    for (const id of ids) {
      const node = graph.nodes[id]
      const to = canvasIdOf.get(id)!
      for (const ref of Object.values(node.inputs ?? {})) {
        const from = canvasIdOf.get(ref.from)
        if (from && from !== to) swimEdges.push({ from, to })
      }
    }
    const positions = computeSwimlanePositions(swimNodes, swimEdges)
    const orderIndex = new Map<string, number>()
    ids.forEach((id, i) => orderIndex.set(id, i + 1))
    this.layout = { version, positions, orderIndex }
    return this.layout
  }

  /** 单节点出帧：首见 → created（全量节点卡）；已上画布 → updated（metadata 浅合并 patch）。 */
  private frameNode(node: Readonly<ProjectNode>, graph: Readonly<ProjectGraph>, flags: MetadataFlags, out: CanvasBridgeFrame[]): void {
    const canvasId = this.canvasNodeId(node.id)
    const layout = this.layoutFor(graph)
    const metadata = projectNodeMetadata(node, this.namespace, layout.orderIndex.get(node.id) ?? null, flags)
    if (!this.created.has(canvasId)) {
      this.created.add(canvasId)
      out.push({
        name: "canvas.node.created",
        data: {
          unit_id: this.projectId,
          node: {
            id: canvasId,
            type: canvasNodeTypeOf(node.type),
            title: titleOfNode(node),
            position: layout.positions.get(canvasId) ?? { x: 0, y: 0 },
            width: NODE_WIDTH,
            height: NODE_HEIGHT,
            moved: true,
            metadata,
          },
        },
      })
      return
    }
    out.push({
      name: "canvas.node.updated",
      data: { unit_id: this.projectId, node_id: canvasId, patch: metadata },
    })
  }

  /** 补这些节点的入边（to ∈ ids）。端点未上画布时先补建源节点，避免前端收到指向未知节点的边。 */
  private syncEdges(ids: NodeId[], graph: Readonly<ProjectGraph>, out: CanvasBridgeFrame[]): void {
    for (const id of ids) {
      const node = graph.nodes[id]
      if (!node) continue
      const toId = this.canvasNodeId(id)
      for (const ref of Object.values(node.inputs ?? {})) {
        const fromNode = graph.nodes[ref.from]
        if (!fromNode) continue
        const fromId = this.canvasNodeId(ref.from)
        if (fromId === toId) continue // 自环不是合法工程图，防御性跳过
        const key = `${fromId}>${toId}`
        if (this.connected.has(key)) continue
        if (!this.created.has(fromId)) this.frameNode(fromNode, graph, {}, out)
        this.connected.add(key)
        out.push({
          name: "canvas.node.connected",
          data: { unit_id: this.projectId, connection: { id: `pc-${fromId}-${toId}`, fromNodeId: fromId, toNodeId: toId } },
        })
      }
    }
  }

  /** 发帧 ＋ 写穿快照（与 workflow-gw-service.ts:39-80 同一钩子形态：帧发出即落快照）。 */
  private deliver(frames: CanvasBridgeFrame[]): void {
    for (const frame of frames) {
      try {
        this.emit(frame.name, frame.data)
        if (frame.name === "canvas.node.created") this.writeThrough.created(this.sessionId, frame.data)
        else if (frame.name === "canvas.node.updated") this.writeThrough.updated(this.sessionId, frame.data)
        else this.writeThrough.connected(this.sessionId, frame.data)
      } catch (e) {
        // 画布写穿/推送失败不得打断工程引擎（与既有 emit 钩子的容错一致）。
        console.error(`[gateway] project canvas bridge: ${frame.name} failed:`, e)
      }
    }
  }
}
