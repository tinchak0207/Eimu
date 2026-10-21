import type { WorkflowGraph, WorkflowNode } from "./workflow-engine"

/**
 * 同层并行分批（2026-08-27）：把 topo order 按「依赖深度」切层——层 L 的节点只依赖层 < L
 * 的节点，同层节点互不依赖 → 可并行；批间严格串行（下游等上游）。order 为 topo 序，前驱必已分层。
 */
export function splitIntoBatches(order: string[], graph: WorkflowGraph): string[][] {
  const layerOf = new Map<string, number>()
  const batches: string[][] = []
  for (const nodeId of order) {
    let layer = 0
    for (const c of graph.connections) {
      if (c.to !== nodeId) continue
      const fromLayer = layerOf.get(c.from)
      if (fromLayer !== undefined && fromLayer + 1 > layer) layer = fromLayer + 1
    }
    layerOf.set(nodeId, layer)
    ;(batches[layer] ??= []).push(nodeId)
  }
  return batches
}

/** 余额解析（与 gateway fetchBalance/extractBalance 同构：balance_coins/balance/coins/credit，递归 data）。 */
export function extractBalanceLocal(data: unknown): number | null {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>
    for (const k of ["balance_coins", "balance", "coins", "credit"]) {
      if (typeof obj[k] === "number") return obj[k]
    }
    if (obj.data && typeof obj.data === "object") return extractBalanceLocal(obj.data)
  }
  return null
}

/** 节点的结构化 shot JSON（metadata.shot），给 index.ts 的 submitWorkflowNode 编译 prompt 用。没有则 null。 */
export function resolveNodeShot(node: { kind: string; metadata: Record<string, unknown> }): unknown {
  return node.metadata.shot !== undefined ? node.metadata.shot : null
}

/**
 * R5-D2：image 节点模型名解析——自身 metadata.model → 直接上游 config 的 model
 *（引擎对缺 model 的 image 节点用 pixai-tsubaki2，index.ts submitWorkflowNode
 * 文档行为）；取不到回 null（= 走引擎 pixai 预设）。
 */
function resolveImageModelName(node: WorkflowNode, graph: WorkflowGraph): string | null {
  if (typeof node.metadata.model === "string" && node.metadata.model) return node.metadata.model
  const connections = Array.isArray(graph?.connections) ? graph.connections : []
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  for (const c of connections) {
    if (c.to !== node.id) continue
    const up = nodes.find((n) => n.id === c.from)
    if (up && up.kind === "config" && typeof up.metadata.model === "string" && up.metadata.model) return up.metadata.model
  }
  return null
}
