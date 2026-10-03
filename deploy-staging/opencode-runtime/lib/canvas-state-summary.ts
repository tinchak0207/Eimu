// canvas_get_state 摘要回執（H10 殘餘）：342 節點/1213 連線全量回執會被 opencode 截斷器截掉。
// 預設摘要：節點計數 + 按類型/狀態彙總 + 逐節點精簡行 + 連線只回數量；node_id 取單點；view=full 取全量。
// 失敗/錯誤資訊（metadata 內 error/fail/reason/status 類鍵）永遠完整保留，不被截短。
// 放在 lib/ 而非 tools/（tools/ 下具名 export 會被註冊成工具）。純函式，不依賴 canvas-flow。

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
  for (const [k, v] of Object.entries(m)) if (k !== "status" && ERR_KEY.test(k) && v !== undefined) meta[k] = val(v, ERR_MAX) // 失敗真因不截
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
    if (!node) return { found: false, node_id: opts.nodeId, hint: "node not found；用不帶 node_id 的 canvas_get_state 看節點清單" }
    const compact = compactCanvasState({ nodes: [node] }).nodes[0]
    const versionsEntry = (Array.isArray(s.node_versions) ? s.node_versions : []).find(
      (e: any) => e?.node_id === opts.nodeId,
    )
    return {
      node: compact,
      upstream: conns.filter((c) => c?.to === opts.nodeId || c?.target === opts.nodeId).map((c) => c.from ?? c.source),
      downstream: conns.filter((c) => c?.from === opts.nodeId || c?.source === opts.nodeId).map((c) => c.to ?? c.target),
      // 版本史（人機共筆回滾面，2026-10-03）：單點查詢時附上該節點的版本清單，agent 可直接
      // 指定 version 走 workflow_rollback；不帶 metadata（回退由畫布端還原，agent 不必抄）。
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
    // 人機共筆讀面（2026-10-03）：dsl＝agent 讀回的可逆聲明（原樣，是改圖的唯一輸入）；
    // workflow_versions＝節點版本索引（回退面）。兩者缺席＝畫布上還沒有可編譯的產線/版本。
    ...(Array.isArray(s.dsl) ? { dsl: s.dsl } : {}),
    ...(Array.isArray(s.node_versions) ? { workflow_versions: s.node_versions } : {}),
    nodes: nodes.map(summarizeCanvasNode),
    hint: "摘要視圖：連線只回數量、content/metadata 已截短（失敗資訊完整）。單點完整資料（含位置/尺寸/版本史）+上下游用 node_id；bounds 為全部節點包圍盒，擺放新節點用；全量用 view=full（很大會被截斷，落盤檔請用 read 按 offset/limit 讀）。dsl＝當前產線的可逆聲明：要改產線就讀它、改它、用 workflow_write 編譯回圖（不要手拼 ops）；workflow_versions 供 workflow_rollback 回退。",
  }
}
