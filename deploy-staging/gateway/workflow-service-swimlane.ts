// ── 泳道座标（2026-09-21 分层重排）─────────────────────────────────────────
// 旧版「每主节点独占一行、衍生卡向右排」会让主链长距离跳线（feature_film 的
// script→shot1 跨 10 行、char_view1→shot1_gen 跨 8 行）纵贯切穿整列卡片。
// 新版改 DAG 分层：主链按最长路径深度分栏（栏间距＝一跳），栏内 barycenter
// 排序压交叉；每个工序的衍生卡（工具/配方/门禁）垂直挂在该工序正下方，
// 行内串联线走干净垂直脊柱。所有主链连线＝相邻栏位短跳线，零长距离贯穿。
const SWIM_CARD_W = 300 // 与前端 CARD_W 同值
const SWIM_MAIN_H = 220 // 主节点高
const SWIM_GAP_X = 80 // 栏间距（一跳连线的呼吸空间）
const SWIM_DERIVED_H = 150 // 衍生卡高
const SWIM_DERIVED_GAP = 24 // 衍生卡间距
const SWIM_BLOCK_GAP_Y = 60 // 同栏相邻工序块的间距

const isDerivedRole = (role: string) => /__tool_\d+$/.test(role) || /__note_\d+$/.test(role) || /__gate$/.test(role)

// 导出供 E2E 断言用（2026-09-20 Route A 验收；09-21 签名加 connections 参数）。
export function computeSwimlanePositions(
  nodes: { id: string; role: string }[],
  connections: { from: string; to: string }[] = [],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const conns = (Array.isArray(connections) ? connections : []).filter(
    (c) => byId.has(c.from) && byId.has(c.to),
  )

  const mains = nodes.filter((n) => !isDerivedRole(n.role))

  // 衍生卡按 role 前缀归到父工序（nodes 阵列序＝tools→notes→gate 的铺卡序）
  const derivedByParent = new Map<string, { id: string }[]>()
  const mainByRole = new Map(mains.map((n) => [n.role, n]))
  for (const n of nodes) {
    if (!isDerivedRole(n.role)) continue
    const parentRole = n.role.slice(0, n.role.lastIndexOf("__"))
    if (!mainByRole.has(parentRole)) continue
    const list = derivedByParent.get(parentRole) ?? []
    list.push(n)
    derivedByParent.set(parentRole, list)
  }

  // 最长路径分层（只看主链连线；衍生卡不在 depth 表里，自动被排除）
  const depth = new Map<string, number>()
  for (const n of mains) depth.set(n.id, 0)
  for (let iter = 0; iter < mains.length; iter++) {
    let changed = false
    for (const c of conns) {
      const fd = depth.get(c.from)
      if (fd === undefined) continue
      const nd = fd + 1
      if (nd > (depth.get(c.to) ?? 0)) {
        depth.set(c.to, nd)
        changed = true
      }
    }
    if (!changed) break
  }

  const maxDepth = Math.max(0, ...mains.map((n) => depth.get(n.id) ?? 0))
  const columns: { id: string; role: string }[][] = Array.from({ length: maxDepth + 1 }, () => [])
  for (const n of mains) columns[depth.get(n.id) ?? 0].push(n)

  // barycenter：向左栏看齐排序，压低跨栏连线交叉（无上游者保持原序）
  const upstreamOf = new Map<string, string[]>()
  for (const c of conns) {
    if (depth.has(c.from) && depth.has(c.to)) {
      upstreamOf.set(c.to, [...(upstreamOf.get(c.to) ?? []), c.from])
    }
  }
  for (let d = 1; d < columns.length; d++) {
    const refIndex = new Map(columns[d - 1].map((n, i) => [n.id, i]))
    const scored = columns[d].map((n, i) => {
      const ups = (upstreamOf.get(n.id) ?? [])
        .map((id) => refIndex.get(id))
        .filter((v): v is number => v !== undefined)
      return { n, i, bary: ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : i }
    })
    scored.sort((a, b) => a.bary - b.bary || a.i - b.i)
    columns[d] = scored.map((s) => s.n)
  }

  // 座标：栏 x 按深度推进；栏内工序块（主节点＋下方衍生脊柱）垂直堆叠
  const blockH = (role: string) => {
    const derived = derivedByParent.get(role) ?? []
    return derived.length
      ? SWIM_MAIN_H + SWIM_DERIVED_GAP + derived.length * (SWIM_DERIVED_H + SWIM_DERIVED_GAP)
      : SWIM_MAIN_H
  }
  for (let d = 0; d < columns.length; d++) {
    let y = 0
    for (const n of columns[d]) {
      positions.set(n.id, { x: d * (SWIM_CARD_W + SWIM_GAP_X), y })
      let cy = y + SWIM_MAIN_H + SWIM_DERIVED_GAP
      for (const dc of derivedByParent.get(n.role) ?? []) {
        positions.set(dc.id, { x: d * (SWIM_CARD_W + SWIM_GAP_X), y: cy })
        cy += SWIM_DERIVED_H + SWIM_DERIVED_GAP
      }
      y += blockH(n.role) + SWIM_BLOCK_GAP_Y
    }
  }
  return positions
}
