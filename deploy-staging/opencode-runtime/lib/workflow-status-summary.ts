// workflow_status 精简回执（H10）：全量回执 143–154KB 会被 opencode 截断器截成 ~291 字，
// agent 实际拿不到任何资讯。摘要模式只留决策必需栏位，90 节点约 25KB，低于截断线。
// 注意：放在 lib/ 而非 tools/——tools/ 下档案的具名 export 会被当成额外工具注册。

const CONTENT_MAX = 100
const TITLE_MAX = 40
const META_KEYS = ["model", "duration_seconds", "size", "count", "locked", "error", "reason"]

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s
}

function briefContent(c: unknown): unknown {
  if (c === undefined || c === null) return c
  if (typeof c === "string") return clip(c, CONTENT_MAX)
  if (typeof c === "number" || typeof c === "boolean") return c
  try {
    return clip(JSON.stringify(c), CONTENT_MAX)
  } catch {
    return "[unserializable]"
  }
}

function pickMeta(meta: any): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== "object") return undefined
  const out: Record<string, unknown> = {}
  for (const k of META_KEYS) {
    if (meta[k] !== undefined) out[k] = typeof meta[k] === "string" ? clip(meta[k], CONTENT_MAX) : meta[k]
  }
  return Object.keys(out).length ? out : undefined
}

export function summarizeNode(n: any): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: n?.id,
    role: n?.role,
    kind: n?.kind,
    status: n?.status,
  }
  if (typeof n?.title === "string") out.title = clip(n.title, TITLE_MAX)
  if (n?.costCoins !== undefined) out.costCoins = n.costCoins
  if (n?.content !== undefined && n?.content !== null) out.content = briefContent(n.content)
  const meta = pickMeta(n?.metadata)
  if (meta) out.metadata = meta
  return out
}

/**
 * 摘要：status 计数 + 逐节点精简行 + delivery/billing 原样；connections 只回数量。
 * nodeId 给定时回该节点完整资料（含 metadata、完整 content）与其上下游 id，供深挖单点。
 * 失败/error 节点永远保留完整 content（真因不能被截）。
 */
export function buildStatusReceipt(
  workflow: any,
  opts: { view?: "summary" | "full"; nodeId?: string; billing?: unknown } = {},
): Record<string, unknown> {
  const nodes: any[] = Array.isArray(workflow?.nodes) ? workflow.nodes : []
  const conns: any[] = Array.isArray(workflow?.connections) ? workflow.connections : []
  if (opts.view === "full") return { workflow, ...(opts.billing ? { billing: opts.billing } : {}) }
  if (opts.nodeId) {
    const node = nodes.find((n) => n?.id === opts.nodeId)
    if (!node) return { found: false, node_id: opts.nodeId, hint: "node not found；用不带 node_id 的 workflow_status 看节点清单" }
    return {
      workflow_id: workflow?.workflowId,
      status: workflow?.status,
      node,
      upstream: conns.filter((c) => c?.to === opts.nodeId).map((c) => c.from),
      downstream: conns.filter((c) => c?.from === opts.nodeId).map((c) => c.to),
    }
  }
  const counts: Record<string, number> = {}
  for (const n of nodes) counts[String(n?.status)] = (counts[String(n?.status)] ?? 0) + 1
  const rows = nodes.map((n) => {
    const row = summarizeNode(n)
    if (n?.status === "error" && n?.content !== undefined) row.content = n.content // 失败真因不截
    return row
  })
  return {
    view: "summary",
    workflow_id: workflow?.workflowId,
    template_id: workflow?.templateId,
    status: workflow?.status,
    node_count: nodes.length,
    status_counts: counts,
    nodes: rows,
    connection_count: conns.length,
    ...(workflow?.delivery ? { delivery: workflow.delivery } : {}),
    ...(opts.billing ? { billing: opts.billing } : {}),
    hint: "摘要视图：content/metadata 已截短、connections 省略。单节点完整资料用 node_id；全量用 view=full（回执很大会被截断，落盘档请用 read 工具按 offset/limit 读）。",
  }
}
