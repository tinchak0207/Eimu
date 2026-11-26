// canvas_get_state 摘要回执（H10 残余）：342 节点/1213 连线全量回执会被 opencode 截断器截掉。
// 预设摘要：节点计数 + 按类型/状态汇总 + 逐节点精简行 + 连线只回数量；node_id 取单点；view=full 取全量。
// 失败/错误资讯（metadata 内 error/fail/reason/status 类键）永远完整保留，不被截短。
// 放在 lib/ 而非 tools/（tools/ 下具名 export 会被注册成工具）。纯函式，不依赖 canvas-flow。

import { compactCanvasState } from "./canvas-flow"

const TITLE_MAX = 16
const VAL_MAX = 32
const ERR_MAX = 2000
const ERR_KEY = /error|fail|reason|status|message/i
const KEEP_KEYS = ["model", "content"]

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function val(v: unknown, n: number): unknown {
  if (typeof v === "string") return clip(v, n)
  if (v === null || typeof v === "number" || typeof v === "boolean") return v
  try {
    return clip(JSON.stringify(v), n)
  } catch {
    return "[unserializable]"
  }
}

function nodeStatus(n: any): string | undefined {
  const m = n?.metadata
  const s = m?.status ?? n?.status
  return typeof s === "string" && s ? s : undefined
}

function isFailed(n: any): boolean {
  const m = n?.metadata
  if (!m || typeof m !== "object") return false
  for (const [k, v] of Object.entries(m)) {
    if (/error|fail/i.test(k) && v) return true
  }
  return /error|fail/i.test(nodeStatus(n) ?? "")
}

export function summarizeCanvasNode(n: any): Record<string, unknown> {
  const m = n?.metadata && typeof n.metadata === "object" && !Array.isArray(n.metadata) ? n.metadata : {}
  const meta: Record<string, unknown> = {}
  for (const k of KEEP_KEYS) if (m[k] !== undefined) meta[k] = val(m[k], VAL_MAX)
  for (const [k, v] of Object.entries(m)) if (k !== "status" && ERR_KEY.test(k) && v !== undefined) meta[k] = val(v, ERR_MAX) // 失败真因不截
  const row: Record<string, unknown> = { id: n?.id, type: n?.type }
  const st = nodeStatus(n)
  if (st) {
    row.status = st
  }
  if (m.kind !== undefined && m.kind !== n?.type) meta.kind = val(m.kind, VAL_MAX)
  if (typeof n?.title === "string" && n.title) row.title = clip(n.title, TITLE_MAX)
  if (Object.keys(meta).length) row.metadata = meta
  return row
}

export function buildCanvasReceipt(
  state: unknown,
  opts: { view?: "summary" | "full"; nodeId?: string } = {},
): Record<string, unknown> {
  const s = (state ?? {}) as Record<string, any>
  const nodes: any[] = Array.isArray(s.nodes) ? s.nodes : []
  const conns: any[] = Array.isArray(s.connections) ? s.connections : []
  const selected = Array.isArray(s.selectedNodeIds) ? s.selectedNodeIds : Array.isArray(s.selected_node_ids) ? s.selected_node_ids : []
  if (opts.view === "full") return { state: compactCanvasState(state) }
  if (opts.nodeId) {
    const node = nodes.find((n) => n?.id === opts.nodeId)
    if (!node) return { found: false, node_id: opts.nodeId, hint: "node not found；用不带 node_id 的 canvas_get_state 看节点清单" }
    const compact = compactCanvasState({ nodes: [node] }).nodes[0]
    const versionsEntry = (Array.isArray(s.node_versions) ? s.node_versions : []).find(
      (e: any) => e?.node_id === opts.nodeId,
    )
    return {
      node: compact,
      upstream: conns.filter((c) => c?.to === opts.nodeId || c?.target === opts.nodeId).map((c) => c.from ?? c.source),
      downstream: conns.filter((c) => c?.from === opts.nodeId || c?.source === opts.nodeId).map((c) => c.to ?? c.target),
      // 版本史（人机共笔回滚面，2026-10-03）：单点查询时附上该节点的版本清单，agent 可直接
      // 指定 version 走 workflow_rollback；不带 metadata（回退由画布端还原，agent 不必抄）。
      ...(versionsEntry ? { versions: versionsEntry.versions } : {}),
    }
  }
  const byType: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  const failed: unknown[] = []
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const n of nodes) {
    const p = n?.position
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y)
      x1 = Math.max(x1, p.x + (Number.isFinite(n.width) ? n.width : 340)); y1 = Math.max(y1, p.y + (Number.isFinite(n.height) ? n.height : 200))
    }
    byType[String(n?.type)] = (byType[String(n?.type)] ?? 0) + 1
    const st = nodeStatus(n)
    if (st) byStatus[st] = (byStatus[st] ?? 0) + 1
    if (isFailed(n)) failed.push(n?.id)
  }
  return {
    view: "summary",
    node_count: nodes.length,
    connection_count: conns.length,
    by_type: byType,
    by_status: byStatus,
    ...(failed.length ? { failed_node_ids: failed } : {}),
    selected_node_ids: selected,
    viewport: s.viewport ?? null,
    ...(Number.isFinite(x0) ? { bounds: { min_x: Math.round(x0), min_y: Math.round(y0), max_x: Math.round(x1), max_y: Math.round(y1) } } : {}),
    // 人机共笔读面（2026-10-03）：dsl＝agent 读回的可逆声明（原样，是改图的唯一输入）；
    // workflow_versions＝节点版本索引（回退面）。两者缺席＝画布上还没有可编译的产线/版本。
    ...(Array.isArray(s.dsl) ? { dsl: s.dsl } : {}),
    ...(Array.isArray(s.node_versions) ? { workflow_versions: s.node_versions } : {}),
    // 读面信号（2026-10-09）：dsl_omitted＝骨架因快照预算被省（reason/sources/steps），不代表没有产线；原样透传。
    ...(s.dsl_omitted !== undefined ? { dsl_omitted: s.dsl_omitted } : {}),
    nodes: nodes.map(summarizeCanvasNode),
    hint: "摘要视图：连线只回数量、content/metadata 已截短（失败资讯完整）。单点完整资料（含位置/尺寸/版本史）+上下游用 node_id；bounds 为全部节点包围盒，摆放新节点用；全量用 view=full（很大会被截断，落盘档请用 read 按 offset/limit 读）。dsl＝当前产线的可逆声明（**已覆盖存量画布上的产线节点，含未带产线身份键的提示词节点与生成配置节点**）：要改产线就读它、改它、用 workflow_write 编译回图（不要手拼 ops）；每步 `meta._origin_node_id` 由读面自动填好、原样带回，不要自己发明；**改提示词要改「生成步」（kind=image/video 的那一步）的 prompt**（生成面板与重跑读的是生成节点自身的 metadata.prompt；画布把提示词存两份时，只改提示词步不改变生成输入）；**铺新产线＝有意动作**：交回会新建节点的 source 时，若 `source.workflow` 不在当前画布 `dsl` 的 ns 里（画布快照没有产线信息、或它来自别的画布／会话记忆，都算不在），工具先回 `confirm_new_line` 要你确认——确认前画布不动。确为有意（用户要铺这条线／你在规划另一张画布）就带 `confirm_new_line: true` 重交同一份 source；若它只是记忆或别的画布的 source 就不要交回。**回执里的新建/更新颗数（`created_node_ids`）必须如实转述，不得声称「无新建」。** workflow_versions 供 workflow_rollback 回退。若带 `dsl_omitted`（骨架因快照预算被省；**不代表没有产线**），先看节点清单再决定改法。",
  }
}
