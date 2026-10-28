// ===== project/refs.ts — 引用文法解析（设计文档 §3.3，S4）=====
// 只做解析与替换，不做运算、不做表达式求值。纯函数，无 IO。
//
//   ref  := "${" head ("." seg)* "}"
//   head := "row" | <as 别名> | <nodeId>
//
// 语义：
//   ${row.a.b}            行字段（仅 forEach 节点内）。整串恰好是一个 row 引用 → 保留 JSON 类型；嵌在句子里 → 只许标量。
//   ${shot.keyframe[.p]}  同行兄弟实例（shot=forEach.as）。实例模式下规范化成 ${keyframe#<rowid>[.p]}。
//   ${node[.port]}        普通节点输出。文本原样保留，由调度器在运行期取上游产物；这里只产出 inputs 边。
// 产出的 inputs 边一律用 REF_INPUT_PREFIX 开头的键，重算时整体丢弃重建 → 引用文本被改掉后旧边不会残留。
import type { ForEach, InputRef, Json, NodeId, PatchErrorCode } from "./types"

export const REF_INPUT_PREFIX = "ref:"
export const NODE_ID_RE = /^[a-z][a-z0-9_]{0,47}(#[a-z0-9_]{1,32})?$/
export const ALIAS_RE = /^[a-z][a-z0-9_]{0,47}$/
export const ROW_ID_RE = /^[a-z0-9_]{1,32}$/
const SEG_RE = /^[A-Za-z0-9_]+$/
const REF_RE = /\$\{([^{}]*)\}/g

export interface ParsedRef { raw: string; head: string; segs: string[]; start: number; end: number }
export interface RefIssue { code: Extract<PatchErrorCode, "BAD_REF" | "BAD_VALUE">; message: string; path?: string; dangling?: true /* 引用的节点不存在 */ }

/** 扫描文本里的全部 ${...}。语法不合法的一律报错（不静默当作字面量）。 */
export function scanRefs(text: string): { refs: ParsedRef[]; issues: RefIssue[] } {
  const refs: ParsedRef[] = []
  const issues: RefIssue[] = []
  REF_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = REF_RE.exec(text)) !== null) {
    const inner = m[1]
    const parts = inner.split(".")
    const head = parts[0]
    const segs = parts.slice(1)
    const bad =
      !NODE_ID_RE.test(head) ||
      segs.some((s) => !SEG_RE.test(s))
    if (bad) {
      issues.push({
        code: "BAD_REF",
        message: `引用 "${m[0]}" 语法不合法。合法写法：\${row.字段}、\${别名.节点名}、\${节点名}、\${节点名.输出口}；不允许空格、空段或大写开头的节点名。`,
      })
      continue
    }
    refs.push({ raw: m[0], head, segs, start: m.index, end: m.index + m[0].length })
  }
  REF_RE.lastIndex = 0
  if (text.replace(REF_RE, "").includes("${")) {
    issues.push({ code: "BAD_REF", message: `文本里有未闭合的 "\${"。引用必须写成完整的 \${...}。` })
  }
  REF_RE.lastIndex = 0
  return { refs, issues }
}

/** 递归收集值里全部 ${...}（S1 签名用：取出非 row 的节点引用）。语法错误的引用被忽略（校验归 expand）。 */
export function listRefs(value: Json): ParsedRef[] {
  const out: ParsedRef[] = []
  const walk = (v: Json) => {
    if (typeof v === "string") out.push(...scanRefs(v).refs)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === "object") Object.values(v).forEach(walk)
  }
  walk(value)
  return out
}

/** 别名必须：非 "row"、符合 ALIAS_RE、不与任何已有节点 id 重名。返回 null=合法，否则教学式错误。 */
export function validateAlias(as: unknown, nodeIds: Iterable<NodeId>): string | null {
  if (typeof as !== "string" || as === "") return `forEach.as 必须是非空字符串，例如 {"over":"shots","as":"shot"}。`
  if (as === "row") return `forEach.as 不能是 "row"（"row" 是行字段保留字，\${row.x} 取行字段）。改成别的名字，例如 "shot"。`
  if (!ALIAS_RE.test(as)) return `forEach.as "${as}" 不合法：小写字母开头，只含小写字母、数字、下划线，≤48 字符。例如 "shot"。`
  for (const id of nodeIds) {
    if (id === as) return `forEach.as "${as}" 与已有节点 id 重名，\${${as}.x} 会产生歧义。换一个别名，例如 "${as}_row"。`
  }
  return null
}

export interface RefLookup { has(id: NodeId): boolean; forEachOf(id: NodeId): ForEach | undefined }
export interface RefContext {
  selfId: NodeId                         // 模板（或普通节点）id；实例模式也传模板 id
  forEach?: ForEach                      // 自身的 forEach（实例模式必有）
  lookup: RefLookup
  row?: { id: string; data: Json }       // 有=实例模式（替换 row/别名引用）；无=模板/普通模式（只校验）
}
export interface EdgeSink { edges: Map<string, InputRef>; issues: RefIssue[] }
export const newSink = (): EdgeSink => ({ edges: new Map(), issues: [] })

export function instanceIdOf(template: NodeId, rowId: string): NodeId { return `${template}#${rowId}` }

function addEdge(sink: EdgeSink, key: string, ref: InputRef, path: string) {
  const prev = sink.edges.get(key)
  if (prev && (prev.from !== ref.from || prev.port !== ref.port)) {
    sink.issues.push({ code: "BAD_REF", path, message: `输入 "${key}" 被指向两个不同的来源（${prev.from} 与 ${ref.from}）。` })
    return
  }
  sink.edges.set(key, ref)
}

type Resolved = { kind: "keep" } | { kind: "text"; text: string } | { kind: "value"; value: Json }

function walkRow(data: Json, segs: string[], raw: string, sink: EdgeSink, path: string): { ok: true; v: Json } | { ok: false } {
  let cur: Json = data
  for (const s of segs) {
    if (Array.isArray(cur)) {
      const idx = /^\d+$/.test(s) ? Number(s) : -1
      if (idx < 0 || idx >= cur.length) { sink.issues.push({ code: "BAD_REF", path, message: `${raw}：数组下标 "${s}" 越界（长度 ${cur.length}）。` }); return { ok: false } }
      cur = cur[idx]
    } else if (cur && typeof cur === "object") {
      if (!Object.prototype.hasOwnProperty.call(cur, s)) {
        sink.issues.push({ code: "BAD_REF", path, message: `${raw}：行里没有字段 "${s}"（现有字段：${Object.keys(cur).slice(0, 8).join(", ") || "无"}）。先用 write_result 把该字段写进镜头表的行，或改引用。` })
        return { ok: false }
      }
      cur = (cur as { [k: string]: Json })[s]
    } else {
      sink.issues.push({ code: "BAD_REF", path, message: `${raw}：到 "${s}" 之前的值已经不是对象，无法继续取字段。` })
      return { ok: false }
    }
  }
  return { ok: true, v: cur }
}

function sameOver(a: ForEach | undefined, b: ForEach | undefined): boolean { return !!a && !!b && a.over === b.over }

function resolveSibling(name: NodeId, port: string | undefined, ctx: RefContext, sink: EdgeSink, path: string): Resolved {
  const key = REF_INPUT_PREFIX + name + (port ? "." + port : "")
  if (ctx.row) {
    const from = instanceIdOf(name, ctx.row.id)
    addEdge(sink, key, port ? { from, port } : { from }, path)
    return { kind: "text", text: "${" + from + (port ? "." + port : "") + "}" }
  }
  addEdge(sink, key, port ? { from: name, port } : { from: name }, path)
  return { kind: "keep" }
}

function resolveRef(ref: ParsedRef, ctx: RefContext, sink: EdgeSink, path: string): Resolved | null {
  const { head, segs, raw } = ref
  const issue = (message: string, dangling?: true): null => { sink.issues.push({ code: "BAD_REF", path, message, ...(dangling ? { dangling } : {}) }); return null }
  if (head === "row") {
    if (!ctx.forEach) return issue(`${raw}：\${row.*} 只能用在 forEach 节点里。给该节点加 forEach:{"over":"<镜头表节点>","as":"shot"}，或改成具体值。`)
    if (segs.length === 0) return issue(`${raw}：row 后面要跟字段，例如 \${row.id}、\${row.action}。`)
    if (!ctx.row) return { kind: "keep" }
    const r = walkRow(ctx.row.data, segs, raw, sink, path)
    return r.ok ? { kind: "value", value: r.v } : null
  }
  if (ctx.forEach && head === ctx.forEach.as) {
    if (segs.length === 0 || segs.length > 2) return issue(`${raw}：别名引用写成 \${${head}.<兄弟节点>} 或 \${${head}.<兄弟节点>.<输出口>}，例如 \${${head}.keyframe}。`)
    const name = segs[0]
    const port = segs[1]
    if (name === ctx.selfId) return issue(`${raw}：节点不能引用自己。`)
    if (!ctx.lookup.has(name)) return issue(`${raw}：找不到兄弟节点 "${name}"。`, true)
    if (!sameOver(ctx.lookup.forEachOf(name), ctx.forEach)) return issue(`${raw}：节点 "${name}" 不是对同一镜头表（${ctx.forEach.over}）的 forEach 节点，没有“同一行的实例”。给它加 forEach:{"over":"${ctx.forEach.over}","as":"${head}"}，或改用 \${${name}}。`)
    return resolveSibling(name, port, ctx, sink, path)
  }
  // 普通节点引用
  if (segs.length > 1) return issue(`${raw}：节点引用最多再跟一个输出口，例如 \${${head}.out}；取行字段请用 \${row.a.b}。`)
  if (head === ctx.selfId) return issue(`${raw}：节点不能引用自己。`)
  if (!ctx.lookup.has(head)) {
    return issue(`${raw}：找不到节点 "${head}"。检查 id 拼写；若想引用同一行的兄弟实例，需在本节点设置 forEach.as 并写 \${<as>.<节点>}。`, true)
  }
  const port = segs[0]
  if (sameOver(ctx.lookup.forEachOf(head), ctx.forEach)) {
    // 同一镜头表上的两个 forEach 模板：${keyframe} ≡ ${shot.keyframe}
    return resolveSibling(head, port, ctx, sink, path)
  }
  addEdge(sink, REF_INPUT_PREFIX + head + (port ? "." + port : ""), port ? { from: head, port } : { from: head }, path)
  return { kind: "keep" }
}

/** 解析一个字符串。返回替换后的值（整串恰好是一个 row 引用时保留 JSON 类型）。 */
export function resolveString(text: string, ctx: RefContext, sink: EdgeSink, path: string): Json {
  if (!text.includes("${")) return text
  const { refs, issues } = scanRefs(text)
  sink.issues.push(...issues.map((i) => ({ ...i, path })))
  if (refs.length === 0) return text
  const parts: Json[] = []
  let cursor = 0
  let failed = false
  for (const r of refs) {
    parts.push(text.slice(cursor, r.start))
    const res = resolveRef(r, ctx, sink, path)
    if (!res) { failed = true; parts.push(r.raw) }
    else if (res.kind === "keep") parts.push(r.raw)
    else if (res.kind === "text") parts.push(res.text)
    else parts.push(res.value)
    cursor = r.end
  }
  parts.push(text.slice(cursor))
  if (failed) return text
  const first = refs[0]
  if (refs.length === 1 && first.start === 0 && first.end === text.length) return parts[1] // 整串=单个引用：保留类型
  let out = ""
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (typeof p === "string") out += p
    else if (p === null) { sink.issues.push({ code: "BAD_VALUE", path, message: `${refs[(i - 1) / 2].raw} 的值是 null，不能嵌进句子。` }); return text }
    else if (typeof p === "object") {
      sink.issues.push({ code: "BAD_VALUE", path, message: `${refs[(i - 1) / 2].raw} 的值是对象/数组，不能嵌进句子。把整个参数写成 "\${...}"（整串只含这一个引用）以保留结构，或引用它的标量字段。` })
      return text
    } else out += String(p)
  }
  return out
}

/** 递归解析 JSON 值里的全部字符串（对象键不动）。 */
export function resolveValue(value: Json, ctx: RefContext, sink: EdgeSink, path: string): Json {
  if (typeof value === "string") return resolveString(value, ctx, sink, path)
  if (Array.isArray(value)) return value.map((v, i) => resolveValue(v, ctx, sink, `${path}[${i}]`))
  if (value && typeof value === "object") {
    const out: { [k: string]: Json } = {}
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, ctx, sink, `${path}.${k}`)
    return out
  }
  return value
}

/** intent 只替换 row 引用（人话说明，不产生边、不校验节点引用）；别的 ${...} 原样保留。超 200 字截断。 */
export function resolveIntent(text: string, ctx: RefContext, sink: EdgeSink, cap: number): string {
  if (!ctx.row) return text
  const { refs } = scanRefs(text)
  let out = ""
  let cursor = 0
  for (const r of refs) {
    out += text.slice(cursor, r.start)
    cursor = r.end
    if (r.head !== "row" || r.segs.length === 0) { out += r.raw; continue }
    const w = walkRow(ctx.row.data, r.segs, r.raw, sink, "intent")
    if (!w.ok) { out += r.raw; continue }
    out += w.v !== null && typeof w.v === "object" ? r.raw : String(w.v ?? "")
  }
  out += text.slice(cursor)
  return Array.from(out).slice(0, cap).join("")
}

/** 显式 inputs：丢弃上次派生的 ref: 键；同镜头表的 forEach 兄弟模板在实例模式下映射到同一行实例。 */
export function remapExplicitInputs(inputs: Readonly<Record<string, InputRef>>, ctx: RefContext): Record<string, InputRef> {
  const out: Record<string, InputRef> = {}
  for (const [k, v] of Object.entries(inputs)) {
    if (k.startsWith(REF_INPUT_PREFIX)) continue
    if (ctx.row && ctx.forEach && v.from !== ctx.selfId && sameOver(ctx.lookup.forEachOf(v.from), ctx.forEach)) {
      out[k] = v.port ? { from: instanceIdOf(v.from, ctx.row.id), port: v.port } : { from: instanceIdOf(v.from, ctx.row.id) }
    } else out[k] = { ...v }
  }
  return out
}

/** 显式（已 remap）∪ 派生。派生键以 ref: 开头，不会与显式键冲突。 */
export function mergeInputs(explicit: Record<string, InputRef>, derived: ReadonlyMap<string, InputRef>): Record<string, InputRef> {
  const out = { ...explicit }
  for (const k of [...derived.keys()].sort()) out[k] = { ...derived.get(k)! }
  return out
}
