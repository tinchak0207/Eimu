// workflow_update_node 精简回执（H12）：旧回执 ~930 字（整个 node + 14 个 affected id）纯噪音。
// 成功只回 ok/node_id/status/affected_count/前 3 个 id/实际生效栏位/resolved_model；失败路径不经此函式、原样回报。

export const AFFECTED_PREVIEW = 3

export function buildUpdateReceipt(input: {
  data: { node?: any; affected_node_ids?: unknown; status?: unknown }
  nodeId: string
  patch: Record<string, unknown>
  resolvedModel: string | null
}): Record<string, unknown> {
  const { data, nodeId, patch, resolvedModel } = input
  const affected = Array.isArray(data.affected_node_ids) ? (data.affected_node_ids as unknown[]).map(String) : []
  // 回显「实际生效值」让 agent 能核对 patch 是否落地（取自回传 node.metadata，不取 patch 本身）。
  const meta = data.node?.metadata && typeof data.node.metadata === "object" ? data.node.metadata : {}
  const applied: Record<string, unknown> = {}
  for (const k of Object.keys(patch ?? {})) {
    if (k === "content") continue
    if (meta[k] !== undefined) applied[k] = typeof meta[k] === "string" && meta[k].length > 120 ? `${meta[k].slice(0, 120)}…` : meta[k]
  }
  const out: Record<string, unknown> = {
    node_id: data.node?.id ?? nodeId,
    status: data.status,
    affected_count: affected.length,
    ...(affected.length ? { affected_preview: affected.slice(0, AFFECTED_PREVIEW) } : {}),
    ...(Object.keys(applied).length ? { applied } : {}),
    resolved_model: resolvedModel,
  }
  return out
}
