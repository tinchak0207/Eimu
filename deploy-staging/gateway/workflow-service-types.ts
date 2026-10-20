import type { WorkflowGraph, WorkflowNode, WorkflowNodeResult } from "./workflow-engine"

export interface EmitFn {
  (state: unknown, name: string, data: unknown): void
}

export interface RunNodeFn {
  /**
   * 执行单一节点。upstream = 已完成的上游节点 id → content 映射。
   * graph = 整个节点流（供 submit 解析上游 text/config 拿 prompt/参考）。
   * node 本身 metadata 可能只有 config 的 model/size——prompt 常在上游。
   */
  (node: WorkflowNode, upstream: Map<string, string>, graph: WorkflowGraph, owner?: unknown): Promise<WorkflowNodeResult>
}

export interface WorkflowServiceOptions {
  emit: EmitFn
  runNode: RunNodeFn
  reviewBatch?: (wf: ActiveWorkflow, nodes: WorkflowNode[]) => Promise<void>
  /**
   * S5a（2026-08-27）：错误人话化挂点（index.ts 注入 humanMessageFor）。
   * 节点失败的 canvas.node.updated patch 在 errorDetails 原文之外补
   * human_message 中文短句；未注入则维持旧载荷。
   */
  humanize?: (message: string) => string
  /**
   * 状态变更通知（持久化挂点，对齐 canvas 快照的 markDirty 模式）：
   * start/addNode/connect/generate 的每次节点状态/结果变更后同步呼叫，
   * gateway 在这里把 workflow 快照镜像回 session（随防抖落盘）。
   * owner 是 start 时绑定的 session 物件（可能为 null——恢复路径会重新绑定）。
   */
  onDirty?: (wf: ActiveWorkflow) => void
  /**
   * S4（2026-08-27）：整图币耗估价挂点（gateway 注入，同步签名）。
   * 用于 canvas.plan 的 cost_hint。null = 估不出（不许编数）。未注入回 null。
   */
  estimateGraphCoins?: (graph: WorkflowGraph) => number | null
  /**
   * R8（2026-09-10 多镜展开修复）：可用视频模型动态选型挂点（gateway 注入）。
   * 大片模板 shotN_gen 不再写死 model=minimax-h3（该模型当前不可用），start 时
   * 由 gateway 查 /v1/model-status 选当前可用的视频模型回填。回 null/undefined =
   * 挂点不可用（探测故障），回退引擎默认（与旧行为一致，submit 前仍有 F2 failover
   * 兜底）。轮子 = index.ts 的 resolveActiveModel 同源（/v1/model-status 判活）。
   */
  pickDefaultVideoModel?: (owner?: unknown) => Promise<string | null>
  /**
   * 2026-09-24 协作确认闸（collaborate 档专属）：批次间挂点，语义与 R9 中途闸
   *（midBatchBudgetGate）同构——回非 null 字串＝暂停，该字串即回给呼叫端/用户的
   * 诚实原因；回 null＝照跑。gateway 注入的实作只认 interaction_mode === "collaborate"，
   * auto/preset 两档恒回 null（护城河：全自动零新增阻塞）。
   * 未注入（测试/旧呼叫端）＝恒 null，与旧行为逐位元一致。
   */
  awaitingApproval?: (wf: ActiveWorkflow) => Promise<string | null>
}

export interface ActiveWorkflow {
  workflowId: string
  templateId: string
  graph: WorkflowGraph
  status: "building" | "running" | "success" | "partial" | "failed" | "paused_insufficient_quota" | "paused_awaiting_approval" | "review_pending" | "review_partial" | "review_failed"
  nodeStatus: Record<string, "pending" | "running" | "success" | "error" | "skipped">
  nodeContent: Record<string, string>
  nodeCost: Record<string, number>
  owner: unknown // 建立时绑定的 session；emit 事件送回这个 session，后台执行不受 stateForWorkflow 影响
  // 流式搭建去重：plan 只发一次；节点/连线按 id/边去重，generate 再呼叫 emitGraph 只补增量。
  planEmitted: boolean
  emittedNodes: Set<string>
  emittedConnections: Set<string>
}
