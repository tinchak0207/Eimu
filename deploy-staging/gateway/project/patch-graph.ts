// S2 补丁引擎的图工具：引用扫描、依赖边、成环检测、下游遍历、批次收尾检查。纯函数，无 IO。
// 完整合法性（端口类型/参数校验/pin 不变量）走 S3 validate.ts，不在这里重写；
// findGraphProblem 只查「补丁能直接破坏、且必须整批拒绝」的结构不变量（与 S3 的 error 同级）。
// 引用文法见设计文档 §3.3；本档只做 S2 需要的最小解析（存在性与依赖边），展开语义归 S4。
import { defaultSeed } from "./specs.ts"
import type { Json, NodeId, ProjectGraph, ProjectNode } from "./types.ts"

/** add_node 补 seed / reroll 的种子：与 S3 的 defaultSeed 同一实现（FNV-1a），不另造一份哈希。 */
export const fnvSeed = defaultSeed

export const NODE_ID_RE = /^[a-z][a-z0-9_]{0,47}(#[a-z0-9_]{1,32})?$/
export const INPUT_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/
export const PORT_RE = /^[a-z][a-z0-9_]*$/
/**
 * S4 派生输入键（refs.ts:14 REF_INPUT_PREFIX = "ref:"）：`ref:<节点id>[.<输出口>]`。
 * 该命名空间为派生边保留：显式输入口仍走 INPUT_NAME_RE，不得占用 `ref:` 前缀（否则会被下一次 expand 整体重算覆盖）。
 */
export const DERIVED_INPUT_KEY_RE = /^ref:[a-z][a-z0-9_]{0,47}(#[a-z0-9_]{1,32})?(\.[a-z][a-z0-9_]*)?$/
export const isInputKey = (name: string): boolean => INPUT_NAME_RE.test(name) || DERIVED_INPUT_KEY_RE.test(name)

const REF_RE = /\$\{([^}]*)\}/g

/** script/shotlist 的 params 是作者内容（可含字面 "${"），不是可执行 prompt，不扫引用。 */
function refScannable(node: Pick<ProjectNode, "type">): boolean {
  return node.type !== "script" && node.type !== "shotlist"
}

function collectStrings(value: Json, out: string[], depth = 0): void {
  if (depth > 12) return
  if (typeof value === "string") out.push(value)
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out, depth + 1)
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, out, depth + 1)
}

export type RefProblem = { ok: false; msg: string }
export interface ScannedRefs { ok: true; targets: NodeId[] }

/**
 * 扫描 params 里的 ${...}：
 * - `${row.x}`：仅 forEach 节点内合法；
 * - `${<as>.<node>[.port]}`：forEach 别名，目标节点 = 第二段；
 * - `${<node>[.port]}`：普通节点。
 * 返回目标节点 id 列表（不检查存在性，存在性由调用方比对 graph）。
 */
export function scanParamRefs(node: Pick<ProjectNode, "type" | "params" | "forEach">): ScannedRefs | RefProblem {
  if (!refScannable(node)) return { ok: true, targets: [] }
  const strings: string[] = []
  collectStrings(node.params as Json, strings)
  const targets: NodeId[] = []
  for (const s of strings) {
    REF_RE.lastIndex = 0
    for (let m = REF_RE.exec(s); m; m = REF_RE.exec(s)) {
      const body = m[1].trim()
      if (!body) return { ok: false, msg: "空引用 ${}" }
      const segs = body.split(".")
      const head = segs[0]
      if (head === "row") {
        if (!node.forEach) return { ok: false, msg: "${row.*} 仅 forEach 节点内可用" }
        continue
      }
      if (node.forEach && head === node.forEach.as) {
        if (!segs[1]) return { ok: false, msg: "别名引用缺少目标节点：" + head }
        targets.push(segs[1])
        continue
      }
      targets.push(head)
    }
  }
  return { ok: true, targets }
}

/** 节点的依赖集合：inputs.from ∪ 参数引用目标 ∪ forEach.over（图里存在的才算）。 */
export function nodeDeps(graph: Pick<ProjectGraph, "nodes">, node: ProjectNode): Set<NodeId> {
  const deps = new Set<NodeId>()
  for (const ref of Object.values(node.inputs)) if (graph.nodes[ref.from]) deps.add(ref.from)
  const scanned = scanParamRefs(node)
  if (scanned.ok) for (const t of scanned.targets) if (graph.nodes[t]) deps.add(t)
  if (node.forEach && graph.nodes[node.forEach.over]) deps.add(node.forEach.over)
  return deps
}

/** 从 start 出发沿依赖边能否回到 start（成环）。 */
export function reachesSelf(graph: Pick<ProjectGraph, "nodes">, start: NodeId): boolean {
  const seen = new Set<NodeId>()
  const stack: NodeId[] = []
  const first = graph.nodes[start]
  if (!first) return false
  for (const d of nodeDeps(graph, first)) stack.push(d)
  while (stack.length) {
    const id = stack.pop() as NodeId
    if (id === start) return true
    if (seen.has(id)) continue
    seen.add(id)
    const n = graph.nodes[id]
    if (n) for (const d of nodeDeps(graph, n)) stack.push(d)
  }
  return false
}

/** 反向边：id → 直接下游。含 forEach 模板 → 实例（derivedFrom）。 */
export function buildChildren(graph: Pick<ProjectGraph, "nodes">): Map<NodeId, NodeId[]> {
  const children = new Map<NodeId, NodeId[]>()
  const add = (from: NodeId, to: NodeId): void => {
    const list = children.get(from)
    if (list) list.push(to)
    else children.set(from, [to])
  }
  for (const node of Object.values(graph.nodes)) {
    for (const d of nodeDeps(graph, node)) add(d, node.id)
    if (node.derivedFrom && graph.nodes[node.derivedFrom.template]) add(node.derivedFrom.template, node.id)
  }
  return children
}

export function idBase(id: NodeId): NodeId {
  const i = id.indexOf("#")
  return i < 0 ? id : id.slice(0, i)
}

export interface GraphProblem { node?: NodeId; msg: string }

/**
 * 批次收尾检查（设计文档 §3.4「最终图无效→整批 GRAPH_INVALID」）。
 * 只查补丁能直接破坏的结构不变量：
 *  - 悬空输入边、悬空 ${} 参数引用、forEach.over 悬空、实例缺模板；
 *  - 依赖成环（拓扑排序；不靠逐节点 reachesSelf，避免大图上 O(V·E)）。
 * orphaned 节点豁免：§3.5「上游被删的 pinned 节点保留产物，状态置 orphaned」是合法状态。
 * 端口类型/参数域等更深校验归 S3 validate.ts（S2 逐 op 已挡掉自己的坏值）。
 */
export function findGraphProblem(graph: Pick<ProjectGraph, "nodes">): GraphProblem | null {
  const nodes = graph.nodes
  const ids = Object.keys(nodes)
  for (const id of ids) {
    const n = nodes[id]
    if (!n || typeof n !== "object") return { node: id, msg: `节点 ${id} 不是对象` }
    const orphaned = n.status === "orphaned"
    for (const [name, ref] of Object.entries(n.inputs ?? {})) {
      if (!ref || typeof ref.from !== "string") return { node: id, msg: `输入 ${name} 不是 {from}` }
      if (!nodes[ref.from] && !orphaned) return { node: id, msg: `输入 ${name} 指向不存在的节点 ${ref.from}` }
    }
    const scanned = scanParamRefs(n)
    if (!scanned.ok) return { node: id, msg: (scanned as { msg: string }).msg }
    for (const t of scanned.targets) if (!nodes[t] && !orphaned) return { node: id, msg: `参数引用指向不存在的节点 ${t}` }
    if (n.forEach && !nodes[n.forEach.over]) return { node: id, msg: `forEach.over 指向不存在的节点 ${n.forEach.over}` }
    if (n.derivedFrom && !nodes[n.derivedFrom.template] && !orphaned) {
      return { node: id, msg: `实例 ${id} 的模板 ${n.derivedFrom.template} 不存在` }
    }
  }
  // 环：把「所有依赖都已消解」的节点逐个出队；还有剩 = 有环。
  const children = buildChildren(graph)
  const pending = new Map<NodeId, number>()
  const ready: NodeId[] = []
  for (const id of ids) {
    const deps = nodeDeps(graph, nodes[id])
    pending.set(id, deps.size)
    if (deps.size === 0) ready.push(id)
  }
  let done = 0
  while (ready.length) {
    const id = ready.pop() as NodeId
    done++
    for (const c of children.get(id) ?? []) {
      const left = pending.get(c)
      if (left === undefined) continue
      const next = left - 1
      pending.set(c, next)
      if (next === 0) ready.push(c)
    }
  }
  if (done < ids.length) {
    const stuck = [...pending.entries()].filter(([, left]) => left > 0).map(([id]) => id).sort()
    return { node: stuck[0], msg: `依赖成环：${stuck.slice(0, 5).join(", ")}${stuck.length > 5 ? `（共 ${stuck.length} 个节点在环上或环的下游）` : ""}` }
  }
  return null
}
