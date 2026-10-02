// workflow_update_node 精簡回執（H12）：舊回執 ~930 字（整個 node + 14 個 affected id）純噪音。
// 成功只回 ok/node_id/status/affected_count/前 3 個 id/實際生效欄位/resolved_model；失敗路徑不經此函式、原樣回報。

export const AFFECTED_PREVIEW = 3

export function buildUpdateReceipt(input: {
  data: { node?: any; affected_node_ids?: unknown; status?: unknown }
  nodeId: string
  patch: Record<string, unknown>
  resolvedModel: string | null
}): Record<string, unknown> {
  const { data, nodeId, patch, resolvedModel } = input
  const affected = Array.isArray(data.affected_node_ids) ? (data.affected_node_ids as unknown[]).map(String) : []
  // 回顯「實際生效值」讓 agent 能核對 patch 是否落地（取自回傳 node.metadata，不取 patch 本身）。
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
