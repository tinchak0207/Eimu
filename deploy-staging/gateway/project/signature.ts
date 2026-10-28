// ===== project/signature.ts — 签名、planRun、漂移（设计文档 §3.2，S1）=====
// 算法来自设计文档的描述性规范（类型+指纹+排序常量参数+祖先 DFS 序号展开，不含 node_id），独立重写；
// 不含任何 ComfyUI(GPL)/n8n(SUL) 源码。原则：宁可多重跑，不可错用旧产物——任何拿不准的地方一律 unstable。
import { createHash } from "node:crypto"
import { upstreamOf } from "./expand"
import type {
  FingerprintResolver, Json, NodeId, NodeSpecLite, NodeType, Output, ProjectGraph, ProjectNode, RunPlan, SignatureResult, Sha256,
} from "./types"

type Specs = Readonly<Record<NodeType, NodeSpecLite>>

// ---------- 规范化 JSON：键排序、无空白、-0→0；非有限数抛错（上层转 unstable）----------
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null"
  switch (typeof v) {
    case "boolean": return v ? "true" : "false"
    case "number":
      if (!Number.isFinite(v)) throw new Error("non-finite number in canonicalJson")
      return Object.is(v, -0) ? "0" : String(v)
    case "string": return JSON.stringify(v)
    case "object": {
      if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]"
      const o = v as Record<string, unknown>
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort()
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}"
    }
    default: throw new Error(`non-serializable ${typeof v} in canonicalJson`)
  }
}

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex")
const MAIN_PORT = "out"
const REF_RE = /\$\{([^}]*)\}/g

// ---------- 引用：params 字符串里的 ${nodeId[.port]}，head 是图中真实存在的节点才算依赖 ----------
interface Dep { id: NodeId; port: string }

// 把 params 里的 ${node.port} 替换成占位符 \0R<k>\0（k 为引用序号），并收集 (节点, 口)。
// 遍历按排序键，保证同构图得到同一引用序。row/别名等未解析引用保持字面（模板节点上的 ${row.x} 本就不进执行）。
function transformRefs(v: Json, graph: Readonly<ProjectGraph>, out: Dep[]): Json {
  if (typeof v === "string") {
    return v.replace(REF_RE, (whole, body: string) => {
      const segs = body.trim().split(".")
      if (!Object.prototype.hasOwnProperty.call(graph.nodes, segs[0])) return whole
      out.push({ id: segs[0], port: segs.slice(1).join(".") || MAIN_PORT })
      return `\u0000R${out.length - 1}\u0000`
    })
  }
  if (Array.isArray(v)) return v.map((x) => transformRefs(x, graph, out))
  if (v && typeof v === "object") {
    const r: Record<string, Json> = {}
    for (const k of Object.keys(v).sort()) r[k] = transformRefs((v as Record<string, Json>)[k], graph, out)
    return r
  }
  return v
}

// 节点的全部上游依赖（显式 inputs 按扇入展开 + params 引用），去重保序；planRun 与 DFS 共用。
export function nodeDependencies(graph: Readonly<ProjectGraph>, node: Readonly<ProjectNode>): NodeId[] {
  const ids: NodeId[] = []
  for (const name of Object.keys(node.inputs).sort()) {
    for (const id of upstreamOf(graph, node.inputs[name].from)) ids.push(id)
  }
  for (const k of Object.keys(node.params).sort()) {
    const deps: Dep[] = []
    transformRefs(node.params[k], graph, deps)
    for (const d of deps) ids.push(d.id)
  }
  return [...new Set(ids)]
}

// ---------- 上下文：一次计算（或一次 planRun）内共享的缓存 ----------
interface Ctx {
  graph: Readonly<ProjectGraph>; specs: Specs; fp: FingerprintResolver
  shaMemo: Map<string, Promise<Sha256>>
  staticMemo: Map<string, Promise<Static>>
}
class Unstable extends Error {}
const unstable = (reason: string) => new Unstable(reason)

interface Static {
  fixed?: string             // 叶子/终态：整个 immediate 字符串已定
  headItems?: string[]       // 非叶子：已规范化的静态项
  children: Dep[]            // 显式输入（按排序后的输入名）
  refChildren: Dep[]         // params 引用
}

function makeCtx(graph: Readonly<ProjectGraph>, specs: Specs, fp: FingerprintResolver): Ctx {
  return { graph, specs, fp, shaMemo: new Map(), staticMemo: new Map() }
}

function fileSha(ctx: Ctx, artifactId: string): Promise<Sha256> {
  let p = ctx.shaMemo.get(artifactId)
  if (!p) {
    p = Promise.resolve().then(() => ctx.fp.fileSha256(artifactId))
    ctx.shaMemo.set(artifactId, p)
  }
  return p
}
async function shasOf(ctx: Ctx, artifactIds: readonly string[]): Promise<string[]> {
  try { return await Promise.all(artifactIds.map((a) => fileSha(ctx, a))) }
  catch (e) { throw unstable(`fileSha256 failed: ${e instanceof Error ? e.message : String(e)}`) }
}

function getStatic(ctx: Ctx, id: NodeId, root: boolean): Promise<Static> {
  const key = (root ? "R|" : "A|") + id
  let p = ctx.staticMemo.get(key)
  if (!p) { p = buildStatic(ctx, id, root); ctx.staticMemo.set(key, p) }
  return p
}

async function buildStatic(ctx: Ctx, id: NodeId, root: boolean): Promise<Static> {
  const node = ctx.graph.nodes[id]
  if (!node) throw unstable(`dangling reference: ${id}`)
  const spec = ctx.specs[node.type]
  if (!spec) throw unstable(`no spec for type ${node.type}`)
  if (spec.volatile) throw unstable(`volatile node type ${node.type}`)

  // 非根的 pinned 节点：叶子，指纹=钉住时的产物 sha（其自身参数/上游不再影响下游）。
  // 根节点不看 pin：否则 signatureAtPin（钉住瞬间算出）与之后的当前签名永远对不上。
  if (node.pinned && !root) {
    return { fixed: canonicalJson(["pinned", node.type, node.pinned.outputsSha]), children: [], refChildren: [] }
  }

  // 指纹：reference=产物内容 sha；takes（非根）=被选中产物 sha；其余结构性 null。
  let fingerprint: Json = null
  if (node.type === "reference") {
    const ids = node.outputs.length ? node.outputs.map((o) => o.artifactId)
      : typeof node.params.artifactId === "string" ? [node.params.artifactId] : []
    if (ids.length) fingerprint = await shasOf(ctx, ids)
  } else if (node.takes && !root && node.outputs.length) {
    fingerprint = await shasOf(ctx, node.outputs.map((o) => o.artifactId))
  }

  // 参数引用占位符化后进静态项；真实引用目标交给 DFS 换成序号。
  const refDeps: Dep[] = []
  const signed: Json[] = []
  for (const k of [...spec.signedParams].sort()) {
    signed.push([k, transformRefs(node.params[k] ?? null, ctx.graph, refDeps)])
  }

  const refs: Json[] = []
  const sortedRefs = [...node.refs].sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : a.artifactId < b.artifactId ? -1 : 1))
  const refShas = await shasOf(ctx, sortedRefs.map((r) => r.artifactId))
  sortedRefs.forEach((r, i) => refs.push([r.role, refShas[i]]))

  const takes: Json = node.takes ? { n: node.takes.n, select: node.takes.select, rubric: node.takes.rubric ?? null } : null

  const leaf = node.type === "reference"
  const inputNames = leaf ? [] : Object.keys(node.inputs).sort()
  const expanded = inputNames.map((n) => {
    const port = node.inputs[n].port ?? MAIN_PORT
    return { name: n, port, ids: upstreamOf(ctx.graph, node.inputs[n].from) }
  })
  const children: Dep[] = []
  for (const e of expanded) for (const id of e.ids) children.push({ id, port: e.port })

  // 有显式上游输入的节点，签名必须含各输入口当前产物的内容 sha。
  // 不再看 fingerprintMode：那道闸会让结构签名看不见上游换图（force / 文件丢失）。
  // 结构签名只留给没有这些输入的叶子。上游还没有产物 → 该口记 null（产物一出现签名就变）；
  // 产物 id 在、文件读不到 → unstable，调用方必重跑。
  // 指着模板时，children 与这里都按同一行序走实例，不哈希模板自己的空 outputs。
  let contentIn: Json = null
  if (!leaf && expanded.length) {
    const arr: Json[] = []
    for (const e of expanded) {
      const artifactIds: string[] = []
      for (const id of e.ids) {
        const up = ctx.graph.nodes[id]
        if (!up) throw unstable(`dangling reference: ${id}`)
        for (const o of up.outputs) if (o.port === e.port) artifactIds.push(o.artifactId)
      }
      if (!artifactIds.length) arr.push([e.name, null])
      else arr.push([e.name, await shasOf(ctx, artifactIds)])
    }
    contentIn = arr
  }

  const headItems = [node.type, spec.specVersion, fingerprint, signed, refs, takes, contentIn, inputNames].map(canonicalJson)
  return { headItems, children, refChildren: leaf ? [] : refDeps }
}

// ---------- computeSignature ----------
async function signatureIn(ctx: Ctx, rootId: NodeId): Promise<string> {
  const ordinal = new Map<NodeId, number>()
  const slots: string[] = []
  const ord = (d: Dep): string => {
    const o = ordinal.get(d.id)
    if (o === undefined) throw unstable(`internal: unvisited ancestor ${d.id}`)
    return canonicalJson([o, d.port])
  }
  async function visit(id: NodeId, root: boolean): Promise<void> {
    const my = ordinal.size
    ordinal.set(id, my)
    slots.push("")
    const st = await getStatic(ctx, id, root)
    if (st.fixed !== undefined) { slots[my] = st.fixed; return }
    for (const c of [...st.children, ...st.refChildren]) {
      if (!ordinal.has(c.id)) await visit(c.id, false)
    }
    slots[my] = `[${st.headItems!.join(",")},[${st.children.map(ord).join(",")}],[${st.refChildren.map(ord).join(",")}]]`
  }
  await visit(rootId, true)
  return sha256Hex("[" + slots.join(",") + "]")
}

async function signatureResult(ctx: Ctx, nodeId: NodeId): Promise<SignatureResult> {
  try { return { ok: true, signature: await signatureIn(ctx, nodeId) } }
  catch (e) {
    // 任何异常（含 Unstable、非规范值、resolver 内部错误）都当“已变”：必重跑
    return { ok: false, unstable: true, reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function computeSignature(
  graph: Readonly<ProjectGraph>, nodeId: NodeId, fp: FingerprintResolver, specs: Specs,
): Promise<SignatureResult> {
  return signatureResult(makeCtx(graph, specs, fp), nodeId)
}

// ---------- 复用判定：产物文件必须还在且 sha 复核 ----------
export interface CacheLookup {
  lookup(signature: string, fp: FingerprintResolver): Promise<{ outputs: Output[]; costCoins: number } | null>
}

async function outputsIntact(ctx: Ctx, outs: readonly Output[]): Promise<boolean> {
  if (!outs.length) return false
  try {
    const shas = await Promise.all(outs.map((o) => fileSha(ctx, o.artifactId)))
    return outs.every((o, i) => shas[i] === o.sha256)
  } catch { return false }
}

// 先看节点自己的上次产物（签名相同且 done），再查缓存索引。返回可复用的产物，没有则 null。
export async function findReusable(
  graph: Readonly<ProjectGraph>, nodeId: NodeId, signature: string, fp: FingerprintResolver, cache?: CacheLookup,
): Promise<Output[] | null> {
  return reusableIn(makeCtx(graph, {} as Specs, fp), nodeId, signature, cache)
}
async function reusableIn(ctx: Ctx, nodeId: NodeId, signature: string, cache?: CacheLookup): Promise<Output[] | null> {
  const node = ctx.graph.nodes[nodeId]
  // stale：产物是启动时签名产的。只允许「查询签名 === lastRun 记下的产出签名」时复用自身产物。
  // 当前签名对不上就直接拒绝，连缓存也不查——缓存键一旦被误写成事后签名，旧图会以新参数被复用。
  if (node?.status === "stale") {
    if (node.lastRun?.signature === signature && await outputsIntact(ctx, node.outputs)) return node.outputs as Output[]
    return null
  }
  if (node && node.status === "done" && node.lastRun?.signature === signature && await outputsIntact(ctx, node.outputs)) {
    return node.outputs as Output[]
  }
  if (cache) {
    const hit = await cache.lookup(signature, ctx.fp)
    if (hit && await outputsIntact(ctx, hit.outputs)) return hit.outputs
  }
  return null
}

// ---------- planRun ----------
type State = "toRun" | "reuse" | "pinned" | "blocked" | "unknown"
const isTemplate = (n: Readonly<ProjectNode>) => !!n.forEach && !n.id.includes("#")

// targets 缺省=整张图（排除 forEach 模板本体与 scratch 草稿）；指向模板的 target 展开为其实例。
// cache 为可选第 6 参（契约签名的兼容扩展）：不传则只认节点自己的上次产物。
export async function planRun(
  graph: Readonly<ProjectGraph>, targets: NodeId[] | undefined, mode: "incremental" | "force", fp: FingerprintResolver, specs: Specs,
  cache?: CacheLookup,
): Promise<RunPlan> {
  const ctx = makeCtx(graph, specs, fp)
  const all = Object.keys(graph.nodes)
  const targetIds: NodeId[] = []
  for (const t of targets ?? all.filter((id) => !graph.nodes[id].scratch)) {
    const n = graph.nodes[t]
    if (!n) continue
    if (isTemplate(n)) { for (const id of all) if (id.startsWith(t + "#")) targetIds.push(id) } else targetIds.push(t)
  }
  const targetSet = new Set(targetIds)

  // 上游闭包的拓扑序；pinned 节点是叶子，不再向上展开
  const order: NodeId[] = []
  const seen = new Set<NodeId>()
  const visit = (id: NodeId): void => {
    if (seen.has(id)) return
    seen.add(id)
    const n = graph.nodes[id]
    if (!n) return
    if (!n.pinned) for (const d of nodeDependencies(graph, n)) visit(d)
    order.push(id)
  }
  targetIds.forEach(visit)

  const state = new Map<NodeId, State>()
  const forced = new Set<NodeId>()
  const plan: RunPlan = { toRun: [], reuse: [], pinned: [], blocked: [], unknown: [] }
  const put = (id: NodeId, s: State) => { state.set(id, s); plan[s].push(id) }

  for (const id of order) {
    const node = graph.nodes[id]
    if (isTemplate(node)) continue
    // orphaned：row 已删、产物保留不再参与扇出（§3.3/§3.1），不进任何计划桶。
    if (node.status === "orphaned") continue
    if (node.pinned) { put(id, "pinned"); continue }
    const spec = specs[node.type]
    const deps = nodeDependencies(graph, node)
    const depStates = deps.map((d) => (graph.nodes[d] ? state.get(d) : "blocked"))
    if (!spec || depStates.some((s) => s === "blocked")) { put(id, "blocked"); continue }
    // 上游内容尚未产出：content 模式节点签名依赖它；任何节点的祖先签名若依赖未知内容，也算未知
    const upstreamDirty = depStates.some((s) => s === "toRun" || s === "unknown")
    if (depStates.some((s) => s === "unknown") || (spec.fingerprintMode === "content" && upstreamDirty)) {
      put(id, "unknown"); continue
    }
    const isForced = (mode === "force" && targetSet.has(id)) || deps.some((d) => forced.has(d))
    if (isForced) { forced.add(id); put(id, "toRun"); continue }
    const sig = await signatureResult(ctx, id)
    if (!sig.ok) { put(id, "toRun"); continue }
    put(id, (await reusableIn(ctx, id, sig.signature, cache)) ? "reuse" : "toRun")
  }
  return plan
}

// ---------- pinned 漂移：当前（忽略 pin 的）签名 ≠ 钉住时签名；算不出签名的不报（算不出≠漂移）----------
export async function computeDrift(graph: Readonly<ProjectGraph>, fp: FingerprintResolver, specs: Specs): Promise<NodeId[]> {
  const ctx = makeCtx(graph, specs, fp)
  const out: NodeId[] = []
  for (const id of Object.keys(graph.nodes)) {
    const n = graph.nodes[id]
    if (!n.pinned) continue
    const r = await signatureResult(ctx, id)
    if (r.ok && r.signature !== n.pinned.signatureAtPin) out.push(id)
  }
  return out
}
