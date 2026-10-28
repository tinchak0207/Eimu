// ===== project/expand.ts — forEach 扇出展开（设计文档 §3.3，S4；纯函数，不执行）=====
// 输入一张图，输出“展开后的图节点表”：
//   - 每个 forEach 模板 X 对 shots.params.rows（按 row.id 去重、保序）生成实例 `X#<row.id>`；
//   - 全部节点（模板/普通/实例）的 ${...} 引用被解析，规范化 inputs 边（ref: 前缀键整体重算）；
//   - row 被删：未 pinned 且没有人手产物的实例删除，否则置 orphaned 保留；
//   - 已存在的实例保留运行态（status/outputs/pinned/signature/...），只刷新定义字段；locked 的字段不覆盖。
// 约定：行表放在 shotlist 节点的 params.rows（§3.5：shotlist 的签名参数是 kind, rows[]）。
// 失败（issues 非空）时 nodes/order 原样返回，调用方按 GRAPH_INVALID 整批拒绝。
import { LIMITS } from "./constants"
import {
  type EdgeSink, type RefContext, type RefIssue, ROW_ID_RE, instanceIdOf, mergeInputs, newSink,
  remapExplicitInputs, resolveIntent, resolveValue, validateAlias,
} from "./refs"
import { validateOnFail, validateTakes } from "./takes"
import type { Json, NodeId, PatchErrorCode, ProjectGraph, ProjectNode } from "./types"

export { instanceIdOf as instanceId } from "./refs"

export interface ExpandIssue { code: PatchErrorCode; node?: NodeId; message: string }
export interface ExpandResult {
  ok: boolean
  nodes: Record<NodeId, ProjectNode>
  order: NodeId[]
  instances: Record<NodeId, NodeId[]>   // 模板 → 现存实例 id（row 顺序；含因悬空而 orphaned 的）
  created: NodeId[]; updated: NodeId[]; removed: NodeId[]; orphaned: NodeId[]; revived: NodeId[]
  warnings: string[]
  issues: ExpandIssue[]
}

export interface Row { id: string; data: { [k: string]: Json } }

/** 读镜头表的行：按 row.id 去重（保第一个）、保序。 */
export function readRows(shotlist: Readonly<ProjectNode>): { rows: Row[]; issues: ExpandIssue[]; warnings: string[] } {
  const issues: ExpandIssue[] = []
  const warnings: string[] = []
  const raw = shotlist.params?.rows
  if (raw === undefined || raw === null) return { rows: [], issues, warnings }
  if (!Array.isArray(raw)) {
    issues.push({ code: "BAD_VALUE", node: shotlist.id, message: `${shotlist.id}.params.rows 必须是数组，例如 [{"id":"s1","action":"..."}]。` })
    return { rows: [], issues, warnings }
  }
  const seen = new Set<string>()
  const rows: Row[] = []
  raw.forEach((r, i) => {
    const id = r && typeof r === "object" && !Array.isArray(r) ? (r as { [k: string]: Json }).id : undefined
    if (typeof id !== "string" || !ROW_ID_RE.test(id)) {
      issues.push({ code: "BAD_VALUE", node: shotlist.id, message: `${shotlist.id}.params.rows[${i}].id 必须是 1..32 位小写字母/数字/下划线（实例 id 由它生成），收到 ${JSON.stringify(id)}。例如 {"id":"s1",...}。` })
      return
    }
    if (seen.has(id)) { warnings.push(`${shotlist.id}.params.rows[${i}] 的 id "${id}" 重复，已忽略后者（保留第一个）。`); return }
    seen.add(id)
    rows.push({ id, data: r as { [k: string]: Json } })
  })
  return { rows, issues, warnings }
}

const sortKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) o[k] = sortKeys((v as Record<string, unknown>)[k])
    return o
  }
  return v
}
const stable = (v: unknown): string => JSON.stringify(sortKeys(v)) ?? "undefined"

/** 模板当前的现存实例（图序，不含 orphaned）。 */
export function instancesOf(graph: Readonly<ProjectGraph>, templateId: NodeId): NodeId[] {
  return graph.order.filter((id) => {
    const n = graph.nodes[id]
    return !!n && n.derivedFrom?.template === templateId && n.status !== "orphaned"
  })
}

/** 这条边的上游。模板（forEach 且没有 derivedFrom）已有实例时是这些实例，顺序跟 instancesOf（行序，不按 id 排）。
 *  还没有实例时仍是模板自己，空扇出不算没有上游。普通节点、实例、悬空 id 原样返回。 */
export function upstreamOf(graph: Readonly<ProjectGraph>, id: NodeId): NodeId[] {
  const n = graph.nodes[id]
  if (!n || !n.forEach || n.derivedFrom) return [id]
  const inst = instancesOf(graph, id)
  return inst.length ? inst : [id]
}

const hasHumanOutput = (n: ProjectNode) => n.pinned !== null || n.outputs.some((o) => o.origin === "user") || (n.takesPool ?? []).some((o) => o.origin === "user")

function lockedKeep(existing: ProjectNode, def: Definition): Definition {
  const lk = existing.locked
  if (!lk) return def
  if (lk.fields === "*") {
    return { type: existing.type, intent: existing.intent, params: existing.params, inputs: existing.inputs, refs: existing.refs, takes: existing.takes, onFail: existing.onFail }
  }
  const out = { ...def, params: { ...def.params } }
  for (const f of lk.fields) {
    if (f === "intent") out.intent = existing.intent
    else if (f === "takes") out.takes = existing.takes
    else if (f === "onFail") out.onFail = existing.onFail
    else if (f === "refs") out.refs = existing.refs
    else if (f === "inputs") out.inputs = existing.inputs
    else if (f.startsWith("params.")) {
      const k = f.slice(7)
      if (Object.prototype.hasOwnProperty.call(existing.params, k)) out.params[k] = existing.params[k]
      else delete out.params[k]
    }
  }
  return out
}

/** 模板想改、锁保住的字段。回执要写明，不能静默。 */
function lockedDriftWarnings(existing: ProjectNode, template: Definition): string[] {
  const lk = existing.locked
  if (!lk) return []
  const who = lk.by === "user" ? "用户" : "锁"
  const out: string[] = []
  const fields = lk.fields === "*"
    ? ["intent", ...Object.keys(template.params).map((k) => `params.${k}`)]
    : lk.fields
  for (const f of fields) {
    if (f === "intent") {
      if (template.intent !== existing.intent) out.push(`${existing.id}.intent 已被${who}保住，模板值未覆盖`)
    } else if (f.startsWith("params.")) {
      const k = f.slice("params.".length)
      if (stable(template.params[k]) !== stable(existing.params[k])) out.push(`${existing.id}.${f} 已被${who}保住，模板值未覆盖`)
    }
  }
  return out
}

interface Definition {
  type: ProjectNode["type"]; intent: string; params: Record<string, Json>; inputs: ProjectNode["inputs"]
  refs: ProjectNode["refs"]; takes?: ProjectNode["takes"]; onFail?: ProjectNode["onFail"]
}
const defKey = (d: Definition) => stable({ t: d.type, i: d.intent, p: d.params, in: d.inputs, r: d.refs, tk: d.takes, of: d.onFail })

export function expandGraph(graph: Readonly<ProjectGraph>): ExpandResult {
  const issues: ExpandIssue[] = []
  const warnings: string[] = []
  const nodes = graph.nodes
  const allIds = [...graph.order.filter((id) => nodes[id]), ...Object.keys(nodes).filter((id) => !graph.order.includes(id))]
  const templates = allIds.filter((id) => nodes[id].forEach && !nodes[id].derivedFrom)
  const templateSet = new Set(templates)

  // ---- 1. forEach 声明校验 + 取行 ----
  const rowsOf = new Map<NodeId, Row[]>()
  for (const t of templates) {
    const fe = nodes[t].forEach!
    const aliasErr = validateAlias(fe.as, allIds)
    if (aliasErr) { issues.push({ code: "BAD_VALUE", node: t, message: `${t}: ${aliasErr}` }); continue }
    const over = typeof fe.over === "string" ? nodes[fe.over] : undefined
    if (!over) { issues.push({ code: "BAD_REF", node: t, message: `${t}: forEach.over "${String(fe.over)}" 不存在。over 必须是一个 shotlist 节点的 id。` }); continue }
    if (over.type !== "shotlist") { issues.push({ code: "BAD_REF", node: t, message: `${t}: forEach.over "${over.id}" 是 ${over.type}，必须是 shotlist。把行放进 shotlist 的 params.rows。` }); continue }
    if (over.forEach || over.derivedFrom) { issues.push({ code: "BAD_REF", node: t, message: `${t}: 不允许嵌套 forEach（"${over.id}" 自己也是 forEach 节点）。v1 只支持单层扇出：把两层行合并成一个镜头表。` }); continue }
    const r = readRows(over)
    issues.push(...r.issues)
    warnings.push(...r.warnings)
    if (r.issues.length === 0) rowsOf.set(t, r.rows)
  }

  // ---- 2. 现有实例分类：活 / 孤儿 / 删除 ----
  const liveKey = (t: NodeId, rowId: string) => `${t}\u0000${rowId}`
  const wanted = new Set<string>()
  for (const [t, rows] of rowsOf) for (const r of rows) wanted.add(liveKey(t, r.id))
  const existingByKey = new Map<string, ProjectNode>()
  const removed: NodeId[] = []
  const orphaned: NodeId[] = []
  const deadKept = new Map<NodeId, ProjectNode>()
  for (const id of allIds) {
    const n = nodes[id]
    if (!n.derivedFrom) continue
    const key = liveKey(n.derivedFrom.template, n.derivedFrom.rowId)
    if (wanted.has(key) && id === instanceIdOf(n.derivedFrom.template, n.derivedFrom.rowId)) { existingByKey.set(key, n); continue }
    if (hasHumanOutput(n)) {
      deadKept.set(id, n.status === "orphaned" ? n : { ...n, status: "orphaned" })
      if (n.status !== "orphaned") orphaned.push(id)
    } else removed.push(id)
  }

  // ---- 3. 已知节点集（引用能指向谁）----
  const known = new Set<NodeId>()
  const removedSet = new Set(removed)
  for (const id of allIds) if (!removedSet.has(id)) known.add(id)
  for (const [t, rows] of rowsOf) for (const r of rows) known.add(instanceIdOf(t, r.id))
  const lookup = { has: (id: NodeId) => known.has(id), forEachOf: (id: NodeId) => (templateSet.has(id) ? nodes[id].forEach : undefined) }

  const out: Record<NodeId, ProjectNode> = {}
  const created: NodeId[] = []
  const updated: NodeId[] = []
  const revived: NodeId[] = []
  const liveIds = new Map<NodeId, NodeId[]>()

  const push = (node: NodeId, sink: EdgeSink, prefix = "") => {
    for (const i of sink.issues) issues.push({ code: i.code, node, message: `${prefix}${node}${i.path ? "." + i.path : ""}: ${i.message}` })
  }
  const pinnedDangling = (n: ProjectNode, sink: EdgeSink): boolean =>
    n.pinned !== null && sink.issues.length > 0 && sink.issues.every((i: RefIssue) => i.dangling)

  // ---- 4. 非实例节点：校验 takes/onFail，解析引用，规范化 inputs ----
  for (const id of allIds) {
    const n = nodes[id]
    if (n.derivedFrom) continue
    for (const m of [...validateTakes(n.takes), ...validateOnFail(n.onFail)]) issues.push({ code: "BAD_VALUE", node: id, message: `${id}: ${m}` })
    const ctx: RefContext = { selfId: id, forEach: n.forEach, lookup }
    const sink = newSink()
    resolveValue(n.params, ctx, sink, "params")
    if (pinnedDangling(n, sink)) {
      out[id] = n.status === "orphaned" ? n : { ...n, status: "orphaned" }
      if (n.status !== "orphaned") orphaned.push(id)
      warnings.push(`${id} 已钉住，但它引用的上游不存在：保留产物，状态置 orphaned。`)
      continue
    }
    push(id, sink)
    const inputs = mergeInputs(remapExplicitInputs(n.inputs, ctx), sink.edges)
    out[id] = stable(inputs) === stable(n.inputs) ? n : { ...n, inputs }
  }

  // ---- 5. 实例 ----
  for (const t of templates) {
    const rows = rowsOf.get(t)
    if (!rows) continue
    const tpl = nodes[t]
    const fe = tpl.forEach!
    const ids: NodeId[] = []
    for (const r of rows) {
      const iid = instanceIdOf(t, r.id)
      const clash = nodes[iid]
      if (clash && !(clash.derivedFrom?.template === t && clash.derivedFrom.rowId === r.id)) {
        issues.push({ code: "EXISTS", node: iid, message: `${iid}: 该 id 已被一个不是 ${t} 的实例的节点占用。` })
        continue
      }
      const ctx: RefContext = { selfId: t, forEach: fe, lookup, row: { id: r.id, data: r.data } }
      const sink = newSink()
      const params = resolveValue(tpl.params, ctx, sink, "params") as Record<string, Json>
      const intent = resolveIntent(tpl.intent, ctx, sink, LIMITS.INTENT_CHARS)
      const inputs = mergeInputs(remapExplicitInputs(tpl.inputs, ctx), sink.edges)
      const existing = existingByKey.get(liveKey(t, r.id))
      if (existing && pinnedDangling(existing, sink)) {
        out[iid] = existing.status === "orphaned" ? existing : { ...existing, status: "orphaned" }
        if (existing.status !== "orphaned") orphaned.push(iid)
        warnings.push(`${iid} 已钉住，但它引用的上游不存在：保留产物，状态置 orphaned。`)
        ids.push(iid)
        continue
      }
      push(iid, sink)
      let def: Definition = {
        type: tpl.type, intent, params, inputs,
        refs: structuredClone(tpl.refs ?? []),
        ...(tpl.takes ? { takes: structuredClone(tpl.takes) } : {}),
        ...(tpl.onFail ? { onFail: structuredClone(tpl.onFail) } : {}),
      }
      if (!existing) {
        out[iid] = {
          id: iid, type: def.type, intent: def.intent, params: def.params, inputs: def.inputs, refs: def.refs,
          ...(def.takes ? { takes: def.takes } : {}), ...(def.onFail ? { onFail: def.onFail } : {}),
          pinned: null, status: "pending", signature: null, lastRun: null, outputs: [], rev: 1,
          derivedFrom: { template: t, rowId: r.id },
          ...(tpl.scratch ? { scratch: structuredClone(tpl.scratch) } : {}),
        }
        created.push(iid)
      } else {
        warnings.push(...lockedDriftWarnings(existing, def))
        def = lockedKeep(existing, def)
        const changed = defKey(def) !== defKey(existing as unknown as Definition)
        const wasOrphan = existing.status === "orphaned"
        const next: ProjectNode = { ...existing, ...def, rev: changed ? existing.rev + 1 : existing.rev }
        if (!def.takes) delete next.takes
        if (!def.onFail) delete next.onFail
        if (wasOrphan) {
          next.status = next.outputs.length === 0 ? "pending" : next.pinned ? "done" : "stale"
          revived.push(iid)
        }
        if (changed || wasOrphan) { out[iid] = next; if (changed) updated.push(iid) } else out[iid] = existing
      }
      ids.push(iid)
    }
    liveIds.set(t, ids)
  }

  if (issues.length > 0) {
    return { ok: false, nodes: graph.nodes, order: graph.order, instances: {}, created: [], updated: [], removed: [], orphaned: [], revived: [], warnings, issues }
  }

  // ---- 6. 孤儿实例并入结果 ----
  for (const [id, n] of deadKept) out[id] = n

  // ---- 7. 顺序：模板后紧跟现存实例（row 序），其后是它的孤儿；无主孤儿排最后 ----
  const order: NodeId[] = []
  const placed = new Set<NodeId>()
  const orphansOf = new Map<NodeId, NodeId[]>()
  for (const id of allIds) {
    const n = out[id]
    if (n?.derivedFrom && !placed.has(id) && !(liveIds.get(n.derivedFrom.template) ?? []).includes(id)) {
      const arr = orphansOf.get(n.derivedFrom.template) ?? []
      arr.push(id)
      orphansOf.set(n.derivedFrom.template, arr)
    }
  }
  for (const id of allIds) {
    if (nodes[id].derivedFrom) continue
    order.push(id); placed.add(id)
    for (const iid of liveIds.get(id) ?? []) if (out[iid]) { order.push(iid); placed.add(iid) }
    for (const iid of orphansOf.get(id) ?? []) { order.push(iid); placed.add(iid) }
  }
  for (const id of allIds) if (out[id] && !placed.has(id)) { order.push(id); placed.add(id) }
  for (const iid of [...liveIds.values()].flat()) if (out[iid] && !placed.has(iid)) { order.push(iid); placed.add(iid) } // 新实例（模板不在 allIds 的情形不会出现，保险）

  const instances: Record<NodeId, NodeId[]> = {}
  for (const [t, ids] of liveIds) instances[t] = ids.filter((i) => out[i])
  return { ok: true, nodes: out, order, instances, created, updated, removed, orphaned, revived, warnings, issues }
}
