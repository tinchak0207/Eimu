// 整卡守门·网关侧（2026-11-03，补 3dc273e25：update_node 栏位守门可被 delete_nodes 再
// add_node／revert_node 绕过）。人改过（metadata.human_edited 非空）或锁定（locked===true）
// 的卡，canvas_apply_ops 的删除/回退在下发前就拦，回 409 给 agent 一句人话——前端 reducer
// 另有同规则兜底（src/lib/canvas/human-edits.ts isHumanProtectedNode）。
// 零依赖纯函数：快照节点由呼叫端传入。

const OVERRIDE_KEY = "_override_human"

function isProtected(node: Record<string, unknown> | undefined): boolean {
  const md = (node?.metadata ?? {}) as Record<string, unknown>
  if (md.locked === true) return true
  const he = md.human_edited
  if (!he || typeof he !== "object" || Array.isArray(he)) return false
  return Object.entries(he as Record<string, unknown>).some(
    ([k, v]) => (k === "title" || k === "prompt" || k === "content") && typeof v === "number" && v > 0,
  )
}

function overrides(op: Record<string, unknown>, id: string): boolean {
  const raw = op[OVERRIDE_KEY]
  if (raw === true) return true
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []
  return list.includes(id)
}

/** 回传被拦的 {删除 id, 回退 id}；都空＝放行。 */
export function humanProtectedTargets(
  nodes: Record<string, unknown>[],
  ops: unknown[],
): { deletes: string[]; reverts: string[] } {
  const byId = new Map(nodes.map((n) => [String(n.id), n]))
  const deletes: string[] = []
  const reverts: string[] = []
  for (const raw of ops) {
    const op = (raw ?? {}) as Record<string, unknown>
    if (op.type === "delete_nodes" && Array.isArray(op.ids)) {
      for (const id of op.ids) {
        if (typeof id === "string" && isProtected(byId.get(id)) && !overrides(op, id)) deletes.push(id)
      }
    } else if (op.type === "revert_node" && typeof op.nodeId === "string") {
      if (isProtected(byId.get(op.nodeId)) && !overrides(op, op.nodeId)) reverts.push(op.nodeId)
    }
  }
  return { deletes, reverts }
}

export function humanProtectedBlockMessage(t: { deletes: string[]; reverts: string[] }): string {
  const parts: string[] = []
  if (t.deletes.length) parts.push(`删除 ${t.deletes.join("、")}`)
  if (t.reverts.length) parts.push(`回退 ${t.reverts.join("、")}`)
  return `【机器闸·human-edited】${parts.join("；")}：这些卡用户手改过或锁定了，整批未下发。删掉再新建、退回旧版都等于覆盖人的版本。要改内容请用 update_node（人改栏位会保留）；只有用户本轮明确要求删/退这张卡时，才在该 op 上带 ${OVERRIDE_KEY}: true（或点名 id 清单）重发，并在回覆里告诉用户。`
}
