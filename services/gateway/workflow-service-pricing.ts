import type { WorkflowGraph, WorkflowNode } from "./workflow-engine"

/** 沿上游config解析数值字段（用于秒数等参数）；报价不再以metadata价格作真源。 */
export function resolveNodeUnitPrice(node: WorkflowNode, graph: WorkflowGraph, field = "unit_price_coins"): number | null {
  const self = node.metadata[field]
  if (typeof self === "number" && self > 0) return self
  const connections = Array.isArray(graph?.connections) ? graph.connections : []
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const upstreamOf = (id: string) =>
    connections
      .filter((c) => c.to === id)
      .map((c) => nodes.find((n) => n.id === c.from))
      .filter((n): n is WorkflowNode => Boolean(n))
  let frontier = upstreamOf(node.id)
  for (let depth = 0; depth < 2 && frontier.length; depth++) {
    for (const up of frontier) {
      if (up.kind === "config") {
        const v = up.metadata[field]
        if (typeof v === "number" && v > 0) return v
      }
    }
    frontier = frontier.flatMap((up) => upstreamOf(up.id))
  }
  return null
}

/** 视频报价仅使用目录明确的币/秒字段；模板锚点与历史档位不是账本。 */
export function resolveVideoPerSecond(
  node: WorkflowNode,
  graph: WorkflowGraph,
  catalogLookup?: (tier: "720p" | "1080p" | "default") => number | null,
): number | null {
  const value = catalogLookup?.(videoQualityTier(node, graph))
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}


/**
 * R5-D2：影片档位探测——quality 栏位（节点自身或上游 config ≤2 层；index.ts 提交
 * 视频时原样透传 cfg.quality）含 "1080" → 1080P 档；含 "720" 或缺省 → 720P 档
 *（保守取低档）。resolution/definition 栏位同名同判。
 */
function videoQualityTier(node: WorkflowNode, graph: WorkflowGraph): "720p" | "1080p" | "default" {
  const scan = (meta: Record<string, unknown>): string | null => {
    for (const k of ["quality", "resolution", "definition"]) {
      const v = meta[k]
      if (typeof v === "string" && v) return v
      if (typeof v === "number") return String(v)
    }
    return null
  }
  const selfQ = scan(node.metadata)
  if (selfQ?.includes("1080")) return "1080p"
  if (selfQ?.includes("720")) return "720p"
  const connections = Array.isArray(graph?.connections) ? graph.connections : []
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const upstreamOf = (id: string) =>
    connections
      .filter((c) => c.to === id)
      .map((c) => nodes.find((n) => n.id === c.from))
      .filter((n): n is WorkflowNode => Boolean(n))
  let frontier = upstreamOf(node.id)
  for (let depth = 0; depth < 2 && frontier.length; depth++) {
    for (const up of frontier) {
      if (up.kind === "config") {
        const q = scan(up.metadata)
        if (q?.includes("1080")) return "1080p"
        if (q?.includes("720")) return "720p"
      }
    }
    frontier = frontier.flatMap((up) => upstreamOf(up.id))
  }
  return "default"
}
