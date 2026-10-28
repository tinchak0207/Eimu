// ProjectGraph S3：图校验。纯函数、无 IO。
// 错误分两级：error=图结构非法（补丁引擎据此给整批 GRAPH_INVALID）；warning=能存但跑不了（缺必需参数、悬空的 orphaned 节点等）。
// 每条 issue 都带 fix（可直接照抄的修正示例）和 patchCode（对应契约 PatchErrorCode）。
import type { Json, NodeId, PatchErrorCode, ProjectDefaults, ProjectGraph, ProjectNode } from "./types"
import { PROJECT_SCHEMA_VERSION } from "./types"
import { LIMITS } from "./constants"
import {
  ARTIFACT_ID_RE, NODE_ID_RE, NODE_TYPES, checkMusicRights, checkParam, checkParams, materializeDefaults, missingRequired,
  pinInvariantViolations, portKindCompatible, portKindOf, resolvePort, specOf,
} from "./specs"
import type { PortKind } from "./specs"

export type ValidateCode =
  | "BAD_SCHEMA" | "BAD_ID" | "ID_MISMATCH" | "DUP_ID" | "UNKNOWN_TYPE" | "BAD_INTENT" | "BAD_PARAM" | "MISSING_PARAM" | "MUSIC_RIGHTS"
  | "BAD_INPUT" | "DANGLING_INPUT" | "DANGLING_REF" | "BAD_REF" | "BAD_PORT" | "PORT_TYPE" | "CYCLE"
  | "FOREACH_BAD_OVER" | "FOREACH_NESTED" | "FOREACH_BAD_ALIAS" | "ROW_OUTSIDE_FOREACH" | "BAD_INSTANCE"
  | "BAD_TAKES" | "BAD_ONFAIL" | "BAD_REFS" | "TOO_MANY_REFERENCES" | "PIN_INVARIANT" | "BAD_ORDER" | "UNFILLED_PLACEHOLDER"

export interface ValidationIssue {
  severity: "error" | "warning"
  code: ValidateCode
  patchCode: PatchErrorCode
  node?: NodeId
  path?: string
  message: string
  fix?: string
}
export interface ValidationResult { ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] }

const STATUSES = new Set(["pending", "queued", "running", "done", "failed", "blocked", "stale", "skipped", "orphaned"])
const ALIAS_RE = /^[a-z][a-z0-9_]{0,31}$/
const INPUT_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/
/** S4 派生输入键（refs.ts:14 REF_INPUT_PREFIX）：ref:<节点id>[.<输出口>]；来源与端口仍走下面的 DANGLING_INPUT/BAD_PORT 检查。 */
const DERIVED_INPUT_KEY_RE = /^ref:[a-z][a-z0-9_]{0,47}(#[a-z0-9_]{1,32})?(\.[a-z][a-z0-9_]*)?$/
const ROLE_RE = /^[a-z][a-z0-9_]{0,39}$/
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)
const chars = (s: string) => [...s].length
const op = (o: Record<string, unknown>) => JSON.stringify(o)

// ---------------------------------------------------------------- ${...} 扫描（只做语法与目标存在性；解析/展开归 S4 refs.ts）
export interface RefHit { raw: string; head: string; segs: string[]; path: string }
const REF_INNER_RE = /^[A-Za-z_][A-Za-z0-9_#]*(\.[A-Za-z0-9_#]+)*$/

export function scanRefs(v: Json, path: string, hits: RefHit[], errors: { path: string; message: string }[], depth = 0): void {
  if (depth > 8) return
  if (typeof v === "string") {
    let i = 0
    while ((i = v.indexOf("${", i)) >= 0) {
      const close = v.indexOf("}", i)
      if (close < 0) { errors.push({ path, message: `引用没有闭合的 "}"：…${v.slice(i, i + 24)}` }); return }
      const inner = v.slice(i + 2, close)
      if (!REF_INNER_RE.test(inner)) errors.push({ path, message: `引用 \${${inner}} 语法不对；应为 \${节点id} / \${节点id.端口} / \${row.字段} / \${别名.节点id}` })
      else { const [head, ...segs] = inner.split("."); hits.push({ raw: "${" + inner + "}", head, segs, path }) }
      i = close + 1
    }
  } else if (Array.isArray(v)) v.forEach((x, k) => scanRefs(x, `${path}[${k}]`, hits, errors, depth + 1))
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) scanRefs(x as Json, `${path}.${k}`, hits, errors, depth + 1)
}

// ---------------------------------------------------------------- takes / onFail / forEach / refs 值校验（也给 set 补丁用）
function checkTakes(v: unknown, type: string, nodeId: string): { message: string; fix: string } | null {
  const spec = specOf(type)
  const fix = op({ op: "set", node: nodeId, path: "takes", value: { n: 2, select: "qc", rubric: "film_default" } })
  if (!isObj(v)) return { message: "takes 必须是对象 {n, select, rubric?}", fix }
  if (spec && !spec.takesAllowed) return { message: `${type} 节点不支持 takes（只有 keyframe/clip/voice/music/render3d 能并发出多个候选）`, fix: op({ op: "set", node: nodeId, path: "takes", value: null }) }
  if (typeof v.n !== "number" || !Number.isInteger(v.n) || v.n < 2 || v.n > LIMITS.TAKES_MAX) return { message: `takes.n 必须是 2..${LIMITS.TAKES_MAX} 的整数（收到 ${JSON.stringify(v.n)}）；只要 1 个就不要 takes`, fix }
  if (v.select !== "qc" && v.select !== "first" && v.select !== "user") return { message: `takes.select 只能是 qc / first / user（收到 ${JSON.stringify(v.select)}）`, fix }
  if (v.rubric !== undefined && (typeof v.rubric !== "string" || v.rubric.length === 0 || v.rubric.length > 64)) return { message: "takes.rubric 必须是 1..64 字的字符串", fix }
  return null
}
function checkOnFail(v: unknown, nodeId: string): { message: string; fix: string } | null {
  const fix = op({ op: "set", node: nodeId, path: "onFail", value: { action: "regenerate", max: 2, on: "any", then: "ask_user" } })
  if (!isObj(v)) return { message: 'onFail 必须是对象，如 {"action":"skip"}', fix }
  const a = v.action
  if (a === "fail" || a === "skip" || a === "ask_user") return null
  if (a !== "regenerate") return { message: `onFail.action 只能是 regenerate / fail / skip / ask_user（收到 ${JSON.stringify(a)}）`, fix }
  if (typeof v.max !== "number" || !Number.isInteger(v.max) || v.max < 1 || v.max > LIMITS.REGENERATE_MAX) return { message: `onFail.max 必须是 1..${LIMITS.REGENERATE_MAX} 的整数（收到 ${JSON.stringify(v.max)}）`, fix }
  if (v.on !== undefined && v.on !== "error" && v.on !== "qc_fail" && v.on !== "any") return { message: "onFail.on 只能是 error / qc_fail / any", fix }
  if (v.then !== undefined && v.then !== "fail" && v.then !== "skip" && v.then !== "ask_user") return { message: "onFail.then 只能是 fail / skip / ask_user", fix }
  return null
}
function checkForEachShape(v: unknown, nodeId: string): { message: string; fix: string } | null {
  const fix = op({ op: "set", node: nodeId, path: "forEach", value: { over: "shots", as: "shot" } })
  if (!isObj(v) || typeof v.over !== "string" || typeof v.as !== "string") return { message: "forEach 必须是 {over: 镜头表节点id, as: 别名}", fix }
  if (v.as === "row") return { message: '别名 as 不能是 "row"（row 是保留字，代表当前行；${row.字段} 取当前行字段）', fix }
  if (!ALIAS_RE.test(v.as)) return { message: `别名 as 必须匹配 ${ALIAS_RE.source}（收到 ${JSON.stringify(v.as)}）`, fix }
  return null
}
function checkRefsShape(v: unknown, nodeId: string): { message: string; fix: string } | null {
  const fix = op({ op: "set", node: nodeId, path: "refs", value: [{ artifactId: "art_0123456789abcdef", role: "style_1" }] })
  if (!Array.isArray(v)) return { message: "refs 必须是数组 [{artifactId, role}]", fix }
  const roles = new Set<string>()
  for (const r of v) {
    if (!isObj(r) || typeof r.artifactId !== "string" || !ARTIFACT_ID_RE.test(r.artifactId)) return { message: `refs[].artifactId 必须是 "art_"+16 位小写 hex（收到 ${JSON.stringify((r as { artifactId?: unknown })?.artifactId)}）`, fix }
    if (typeof r.role !== "string" || !ROLE_RE.test(r.role)) return { message: `refs[].role 必须匹配 ${ROLE_RE.source}`, fix }
    if (roles.has(r.role)) return { message: `refs 的 role 必须唯一（签名按 role 排序）：${r.role} 重复；改成 ${r.role}_1、${r.role}_2`, fix }
    roles.add(r.role)
  }
  return null
}

// ---------------------------------------------------------------- 单个 set 补丁（S2 可直接用）
/** 校验 set 补丁的 path+value。返回 null=通过。BAD_PATH：path 不在允许集合；BAD_VALUE：值不合法。 */
export function validateSet(node: Pick<ProjectNode, "id" | "type" | "params">, path: string, value: Json): ValidationIssue | null {
  const mkIssue = (patchCode: PatchErrorCode, code: ValidateCode, message: string, fix?: string): ValidationIssue =>
    ({ severity: "error", code, patchCode, node: node.id, path, message, fix })
  if (path === "intent") {
    if (typeof value !== "string") return mkIssue("BAD_VALUE", "BAD_INTENT", "intent 必须是字符串")
    if (chars(value) > LIMITS.INTENT_CHARS) return mkIssue("BAD_VALUE", "BAD_INTENT", `intent 最多 ${LIMITS.INTENT_CHARS} 字，实际 ${chars(value)} 字；它只是人话说明，不被执行`)
    return null
  }
  if (path.startsWith("params.")) {
    const k = path.slice(7)
    const i = checkParam(node.type, k, value, node.id)
    if (i) return mkIssue(specOf(node.type)?.params[k] ? "BAD_VALUE" : "BAD_PATH", "BAD_PARAM", i.message, i.fix)
    if (node.type === "music") {
      const g = checkMusicRights({ ...(node.params ?? {}), [k]: value }, node.id)
      if (g) return mkIssue("BAD_VALUE", "MUSIC_RIGHTS", g.message, g.fix)
    }
    return null
  }
  if (path === "takes") { if (value === null) return null; const e = checkTakes(value, node.type, node.id); return e ? mkIssue("BAD_VALUE", "BAD_TAKES", e.message, e.fix) : null }
  if (path === "onFail") { if (value === null) return null; const e = checkOnFail(value, node.id); return e ? mkIssue("BAD_VALUE", "BAD_ONFAIL", e.message, e.fix) : null }
  if (path === "forEach") { if (value === null) return null; const e = checkForEachShape(value, node.id); return e ? mkIssue("BAD_VALUE", "FOREACH_BAD_ALIAS", e.message, e.fix) : null }
  if (path === "refs") { const e = checkRefsShape(value, node.id); return e ? mkIssue("BAD_VALUE", "BAD_REFS", e.message, e.fix) : null }
  return mkIssue("BAD_PATH", "BAD_PARAM", `set 的 path 只能是 intent / params.<键> / takes / onFail / forEach / refs（收到 ${JSON.stringify(path)}）`, op({ op: "set", node: node.id, path: "intent", value: "…" }))
}

/** 新节点 id 检查：形状 + 是否已存在。 */
export function checkNewNodeId(graph: Pick<ProjectGraph, "nodes">, id: string): ValidationIssue | null {
  if (typeof id !== "string" || !NODE_ID_RE.test(id) || id.includes("#")) {
    return { severity: "error", code: "BAD_ID", patchCode: "BAD_VALUE", node: String(id), message: `节点 id ${JSON.stringify(id)} 不合法：用小写字母开头，只含 a-z 0-9 _，最长 48 位（# 只给 forEach 扇出实例，系统生成）`, fix: op({ op: "add_node", node: { id: "shot_1", type: "keyframe" } }) }
  }
  if (Object.prototype.hasOwnProperty.call(graph.nodes, id)) {
    return { severity: "error", code: "DUP_ID", patchCode: "EXISTS", node: id, message: `节点 ${id} 已存在；要改它用 set，要换个新的就换 id`, fix: op({ op: "set", node: id, path: "intent", value: "…" }) }
  }
  return null
}

// ---------------------------------------------------------------- 整图校验
interface Edge { from: NodeId; to: NodeId; via: string }

export function validateGraph(graph: Readonly<ProjectGraph>): ValidationResult {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const err = (code: ValidateCode, patchCode: PatchErrorCode, node: string | undefined, message: string, fix?: string, path?: string) =>
    errors.push({ severity: "error", code, patchCode, node, path, message, fix })
  const warn = (code: ValidateCode, patchCode: PatchErrorCode, node: string | undefined, message: string, fix?: string, path?: string) =>
    warnings.push({ severity: "warning", code, patchCode, node, path, message, fix })

  if (!graph || typeof graph !== "object" || !isObj(graph.nodes)) {
    err("BAD_SCHEMA", "GRAPH_INVALID", undefined, "工程图缺少 nodes 对象")
    return { ok: false, errors, warnings }
  }
  if (graph.schema !== PROJECT_SCHEMA_VERSION) err("BAD_SCHEMA", "GRAPH_INVALID", undefined, `schema 版本应为 ${PROJECT_SCHEMA_VERSION}，收到 ${JSON.stringify(graph.schema)}`)

  const nodes = graph.nodes
  const has = (id: string) => Object.prototype.hasOwnProperty.call(nodes, id)

  // order：无重复、无悬空
  if (Array.isArray(graph.order)) {
    const seen = new Set<string>()
    for (const id of graph.order) {
      if (seen.has(id)) err("DUP_ID", "GRAPH_INVALID", id, `order 里 ${id} 重复出现`)
      seen.add(id)
      if (!has(id)) err("BAD_ORDER", "GRAPH_INVALID", id, `order 里的 ${id} 不在 nodes 中`)
    }
  }

  const edges: Edge[] = []
  const wellFormed = new Set<string>()

  for (const [key, n] of Object.entries(nodes)) {
    if (!n || typeof n !== "object") { err("BAD_SCHEMA", "GRAPH_INVALID", key, "节点不是对象"); continue }
    if (n.id !== key) err("ID_MISMATCH", "GRAPH_INVALID", key, `nodes 的键 ${key} 与节点自带 id ${JSON.stringify(n.id)} 不一致`)
    if (!NODE_ID_RE.test(key)) err("BAD_ID", "GRAPH_INVALID", key, `节点 id ${key} 不匹配 ${NODE_ID_RE.source}`)
    const spec = specOf(n.type)
    if (!spec) { err("UNKNOWN_TYPE", "BAD_VALUE", key, `未知节点类型 ${JSON.stringify(n.type)}`, `可用类型：${NODE_TYPES.join(", ")}`); continue }
    if (!isObj(n.params) || !isObj(n.inputs) || !Array.isArray(n.refs) || !Array.isArray(n.outputs) || !STATUSES.has(n.status)) {
      err("BAD_SCHEMA", "GRAPH_INVALID", key, "节点结构不完整：params/inputs 必须是对象，refs/outputs 必须是数组，status 必须是合法状态")
      continue
    }
    wellFormed.add(key)

    if (typeof n.intent !== "string") err("BAD_INTENT", "BAD_VALUE", key, "intent 必须是字符串", undefined, "intent")
    else if (chars(n.intent) > LIMITS.INTENT_CHARS) err("BAD_INTENT", "BAD_VALUE", key, `intent 最多 ${LIMITS.INTENT_CHARS} 字，实际 ${chars(n.intent)} 字`, op({ op: "set", node: key, path: "intent", value: "…" }), "intent")

    // 参数
    for (const i of checkParams(n.type, n.params as Record<string, Json>, key)) {
      err(i.key === "rights" || (n.type === "music" && (i.key === "prompt" || i.key === "lyrics") && /版权|在版|复刻|翻唱|旋律/.test(i.message)) ? "MUSIC_RIGHTS" : "BAD_PARAM",
        spec.params[i.key] ? "BAD_VALUE" : "BAD_PATH", key, i.message, i.fix, `params.${i.key}`)
    }
    const miss = missingRequired(n, graph.defaults ?? {})
    if (miss.length > 0 && n.status !== "orphaned" && !n.forEach?.over) {
      warn("MISSING_PARAM", "BAD_VALUE", key, `${n.type} 节点缺少必需参数：${miss.join(", ")}（补齐前不能运行）`, op({ op: "set", node: key, path: `params.${miss[0]}`, value: spec.params[miss[0]]?.example ?? null }))
    } else if (miss.length > 0) {
      warn("MISSING_PARAM", "BAD_VALUE", key, `${n.type} 节点缺少必需参数：${miss.join(", ")}（扇出模板里可由 \${row.*} 提供，实例化后会再校验）`)
    }

    // takes / onFail / refs
    if (n.takes) { const e = checkTakes(n.takes, n.type, key); if (e) err("BAD_TAKES", "BAD_VALUE", key, e.message, e.fix, "takes") }
    if (isObj(n.takes) && n.takes.select === "qc" && !n.takes.rubric) warn("BAD_TAKES", "BAD_VALUE", key, "takes.select=qc 但没给 rubric，将按 qc 节点默认 rubric 评分", undefined, "takes")
    if (n.onFail) { const e = checkOnFail(n.onFail, key); if (e) err("BAD_ONFAIL", "BAD_VALUE", key, e.message, e.fix, "onFail") }
    { const e = checkRefsShape(n.refs, key); if (e) err("BAD_REFS", "BAD_VALUE", key, e.message, e.fix, "refs") }

    // pin 不变量
    for (const v of pinInvariantViolations(n)) err("PIN_INVARIANT", "GRAPH_INVALID", key, `${key}：${v.message}`, op({ op: "unpin", node: key }))

    // 实例节点
    if (key.includes("#")) {
      const [tpl, row] = key.split("#")
      if (!n.derivedFrom || n.derivedFrom.template !== tpl || n.derivedFrom.rowId !== row) {
        err("BAD_INSTANCE", "GRAPH_INVALID", key, `实例 ${key} 的 derivedFrom 必须是 {template:"${tpl}", rowId:"${row}"}`)
      } else if (!has(tpl) && n.status !== "orphaned") {
        err("BAD_INSTANCE", "GRAPH_INVALID", key, `实例 ${key} 的模板 ${tpl} 不存在；人手产物实例应置 status=orphaned 保留`)
      }
      if (n.forEach) err("FOREACH_NESTED", "BAD_VALUE", key, `实例 ${key} 不能再带 forEach（v1 只支持单层扇出）`)
    }

    // forEach 形状
    if (n.forEach) {
      const e = checkForEachShape(n.forEach, key)
      if (e) err("FOREACH_BAD_ALIAS", "BAD_VALUE", key, e.message, e.fix, "forEach")
      else {
        const over = n.forEach.over
        if (over === key) err("FOREACH_BAD_OVER", "BAD_VALUE", key, `${key} 不能 forEach 自己`, undefined, "forEach")
        else if (!has(over)) err("FOREACH_BAD_OVER", "BAD_REF", key, `forEach.over 指向不存在的节点 ${over}；先 add_node 一个 shotlist`, op({ op: "add_node", node: { id: over, type: "shotlist", params: { kind: "shots", rows: [{ id: "s1" }] } } }), "forEach")
        else {
          const o = nodes[over]
          if (o.type !== "shotlist") err("FOREACH_BAD_OVER", "BAD_VALUE", key, `forEach.over 必须指向 shotlist 节点，${over} 是 ${o.type}。把要扇出的行放进一个 shotlist 的 rows`, op({ op: "add_node", node: { id: "shots", type: "shotlist", params: { kind: "shots", rows: [{ id: "s1" }] } } }), "forEach")
          else if (o.forEach) err("FOREACH_NESTED", "BAD_VALUE", key, `forEach.over 指向的 ${over} 自己也是 forEach 节点；v1 不允许嵌套扇出，请改用一个平铺的 shotlist（每行一个 id）`, undefined, "forEach")
          edges.push({ from: over, to: key, via: "forEach.over" })
        }
        if (has(n.forEach.as)) err("FOREACH_BAD_ALIAS", "BAD_VALUE", key, `别名 ${n.forEach.as} 与已有节点 id 同名，\${${n.forEach.as}.…} 会有歧义；换个别名`, op({ op: "set", node: key, path: "forEach", value: { over: n.forEach.over, as: n.forEach.as + "_row" } }), "forEach")
      }
    }

    // inputs 边
    let imageInputs = 0
    for (const [name, ref] of Object.entries(n.inputs)) {
      const path = `inputs.${name}`
      if (!INPUT_NAME_RE.test(name) && !DERIVED_INPUT_KEY_RE.test(name)) { err("BAD_INPUT", "BAD_VALUE", key, `输入口名 ${JSON.stringify(name)} 不合法（显式口：小写字母开头，a-z0-9_，≤32 位；派生口：ref:<节点id>[.<端口>]）`, undefined, path); continue }
      if (!ref || typeof ref.from !== "string") { err("BAD_INPUT", "BAD_VALUE", key, `inputs.${name} 必须是 {from, port?}`, op({ op: "connect", to: key, input: name, from: "<上游节点id>" }), path); continue }
      if (spec.inputAccepts.length === 0) { err("PORT_TYPE", "BAD_VALUE", key, `${n.type} 节点不接受输入边（它是素材源）`, op({ op: "disconnect", to: key, input: name }), path); continue }
      if (!has(ref.from)) {
        if (n.status === "orphaned") warn("DANGLING_INPUT", "BAD_REF", key, `已钉住/人手产物节点的上游 ${ref.from} 已被删除，保留产物`, undefined, path)
        else err("DANGLING_INPUT", "BAD_REF", key, `输入 ${name} 指向不存在的节点 ${ref.from}`, op({ op: "disconnect", to: key, input: name }), path)
        continue
      }
      const up = nodes[ref.from]
      const upSpec = specOf(up.type)
      if (!upSpec) continue
      if (resolvePort(upSpec, ref.port) === null) {
        err("BAD_PORT", "BAD_REF", key, `${ref.from} 是 ${up.type} 节点，没有输出口 ${JSON.stringify(ref.port)}。可用：${upSpec.outputs.map((o) => o.name).join(", ")}`, op({ op: "connect", to: key, input: name, from: ref.from, port: upSpec.primaryPort }), path)
        continue
      }
      edges.push({ from: ref.from, to: key, via: `inputs.${name}` })   // 类型不兼容也要记边，否则会漏报环
      const kind = portKindOf(up, ref.port) as PortKind
      if (!portKindCompatible(kind, spec.inputAccepts)) {
        err("PORT_TYPE", "BAD_VALUE", key, `${ref.from}（${up.type}）输出的是 ${kind}，${n.type} 节点只接受 ${spec.inputAccepts.join("/")}`, op({ op: "disconnect", to: key, input: name }), path)
        continue
      }
      if (kind === "image" || kind === "file") imageInputs++
    }

    // 参考图数量（对齐 image_generate：图片 ≤5，minimax-h3 视频 ≤9）
    if (spec.maxReferences) {
      const max = spec.maxReferences(n)
      const total = n.refs.length + imageInputs
      if (total > max) err("TOO_MANY_REFERENCES", "BAD_VALUE", key, `${n.type} 节点最多 ${max} 张参考图（refs ${n.refs.length} + 图片输入 ${imageInputs}），超出 ${total - max} 张。上游 image_generate 同样会拒绝`, op({ op: "set", node: key, path: "refs", value: n.refs.slice(0, Math.max(0, max - imageInputs)) as unknown as Json }), "refs")
    }
  }

  // params 里的 ${...} 引用
  for (const key of wellFormed) {
    const n = nodes[key]
    const spec = specOf(n.type)!
    const hits: RefHit[] = []
    const bad: { path: string; message: string }[] = []
    scanRefs(n.params as Json, "params", hits, bad)
    for (const b of bad) err("BAD_REF", "BAD_REF", key, b.message, undefined, b.path)
    for (const h of hits) {
      const at = h.path
      if (h.head === "row") {
        if (!n.forEach) err("ROW_OUTSIDE_FOREACH", "BAD_REF", key, `${h.raw} 只能出现在 forEach 节点里（当前节点没有 forEach）。先给它设 forEach，或改成引用具体节点`, op({ op: "set", node: key, path: "forEach", value: { over: "shots", as: "shot" } }), at)
        else if (h.segs.length === 0) err("BAD_REF", "BAD_REF", key, '${row} 需要指定字段，如 ${row.action}', undefined, at)
        continue
      }
      let target: string
      let portSeg: string | undefined
      if (n.forEach && h.head === n.forEach.as) {
        target = h.segs[0]
        portSeg = h.segs[1]
        if (!target) { err("BAD_REF", "BAD_REF", key, `${h.raw} 缺少兄弟节点 id，应写成 \${${h.head}.<节点id>}`, undefined, at); continue }
        if (!has(target)) { err("DANGLING_REF", "BAD_REF", key, `${h.raw} 指向不存在的节点 ${target}`, undefined, at); continue }
        const t = nodes[target]
        if (!t.forEach || t.forEach.over !== n.forEach.over) { err("BAD_REF", "BAD_REF", key, `${h.raw}：${target} 不是对 ${n.forEach.over} 的同行兄弟（它没有 forEach 同一个镜头表）。同行引用只能指向同样 forEach ${n.forEach.over} 的节点`, undefined, at); continue }
      } else {
        target = h.head
        portSeg = h.segs[0]
        if (!has(target)) {
          err("DANGLING_REF", "BAD_REF", key, `${h.raw} 指向不存在的节点 ${target}。如果 ${target} 是 forEach 别名，需要先在本节点设置 forEach.as=${target}`, undefined, at)
          continue
        }
      }
      const t = nodes[target]
      const tSpec = specOf(t.type)
      if (!tSpec) continue
      if (portSeg !== undefined && resolvePort(tSpec, portSeg) === null) {
        err("BAD_PORT", "BAD_REF", key, `${h.raw}：${target} 是 ${t.type} 节点，没有输出口 ${portSeg}。可用：${tSpec.outputs.map((o) => o.name).join(", ")}`, undefined, at)
        continue
      }
      edges.push({ from: target, to: key, via: `params 引用 ${h.raw}` })
      const kind = portKindOf(t, portSeg)
      if (kind && !portKindCompatible(kind, spec.inputAccepts)) {
        err("PORT_TYPE", "BAD_VALUE", key, `${h.raw}：${target} 输出 ${kind}，${n.type} 节点只接受 ${spec.inputAccepts.join("/") || "无"}`, undefined, at)
      }
    }
  }

  // 环
  const cyc = findCycle(edges)
  if (cyc) {
    const names = cyc.map((e) => e.from)
    const path = [...names, names[0]].join(" → ")
    const last = cyc[cyc.length - 1]
    const m = /^inputs\.(.+)$/.exec(last.via)
    err("CYCLE", "CYCLE", last.to, `依赖成环：${path}。工程图必须无环（下游不能反过来被上游依赖）`,
      m ? op({ op: "disconnect", to: last.to, input: m[1] }) : `删掉 ${last.to} 里的 ${last.via.replace(/^params 引用 /, "")}，或去掉 ${last.to} 的 ${last.via}`)
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** 寻找一个环，返回环上的边序列（首尾相接）；无环返回 null。迭代式 DFS，不会爆栈。 */
export function findCycle(edges: readonly Edge[]): Edge[] | null {
  const adj = new Map<string, Edge[]>()
  for (const e of edges) { const a = adj.get(e.from); if (a) a.push(e); else adj.set(e.from, [e]) }
  const color = new Map<string, 0 | 1 | 2>() // 1=在栈中，2=完成
  for (const start of adj.keys()) {
    if (color.get(start)) continue
    const stack: { id: string; i: number }[] = [{ id: start, i: 0 }]
    const pathEdges: Edge[] = []
    color.set(start, 1)
    while (stack.length) {
      const top = stack[stack.length - 1]
      const out = adj.get(top.id) ?? []
      if (top.i >= out.length) { color.set(top.id, 2); stack.pop(); pathEdges.pop(); continue }
      const e = out[top.i++]
      const c = color.get(e.to)
      if (c === 1) {
        const idx = stack.findIndex((s) => s.id === e.to)
        return [...pathEdges.slice(idx), e]
      }
      if (!c) { color.set(e.to, 1); stack.push({ id: e.to, i: 0 }); pathEdges.push(e) }
    }
  }
  return null
}

/**
 * 配方默认未填句。script 正文里的「（待写」、镜头行里的「主体动作与可见状态变化」。
 * 只拦会送进付费上游的字段；句子留在配方里，这里不删。
 */
const UNFILLED_MARKERS = ["（待写", "主体动作与可见状态变化"] as const
const PAID_PROMPT_FIELDS: Partial<Record<string, readonly string[]>> = {
  keyframe: ["prompt", "styleLock"],
  clip: ["prompt", "styleLock"],
  voice: ["text"],
  music: ["prompt", "lyrics"],
}

function unfilledPlaceholderIssues(n: ProjectNode, defaults: ProjectDefaults): ValidationIssue[] {
  const fields = PAID_PROMPT_FIELDS[n.type]
  if (!fields) return []
  // 付费提交走 materializeDefaults：缺 styleLock 时用 defaults.style。扫物化结果，显式 params 仍优先（只补缺失键）。
  const params = materializeDefaults(n.type, n.id, n.params ?? {}, defaults)
  const spec = specOf(n.type)
  const issues: ValidationIssue[] = []
  for (const k of fields) {
    const v = params[k]
    if (typeof v !== "string" || v.length === 0) continue
    const marker = UNFILLED_MARKERS.find((m) => v.includes(m))
    if (!marker) continue
    issues.push({
      severity: "error", code: "UNFILLED_PLACEHOLDER", patchCode: "BAD_VALUE", node: n.id, path: `params.${k}`,
      message: `${n.type} 节点 ${n.id} 的 params.${k} 仍是未填占位（含「${marker}」），不能进入付费生成`,
      fix: op({ op: "set", node: n.id, path: `params.${k}`, value: spec?.params[k]?.example ?? null }),
    })
  }
  return issues
}

/** 某节点运行前的就绪检查：把“缺必需参数”升级成 error，并拒绝付费字段里的未填占位。给 S6 admission 用。 */
export function checkRunnable(graph: Readonly<ProjectGraph>, nodeId: NodeId): ValidationIssue[] {
  const n = graph.nodes[nodeId]
  if (!n) return [{ severity: "error", code: "DANGLING_REF", patchCode: "NOT_FOUND", node: nodeId, message: `节点 ${nodeId} 不存在` }]
  const spec = specOf(n.type)
  if (!spec) return [{ severity: "error", code: "UNKNOWN_TYPE", patchCode: "BAD_VALUE", node: nodeId, message: `未知节点类型 ${n.type}` }]
  const missing = missingRequired(n, graph.defaults ?? {}).map((k): ValidationIssue => ({
    severity: "error", code: "MISSING_PARAM", patchCode: "BAD_VALUE", node: nodeId, path: `params.${k}`,
    message: `${n.type} 节点 ${nodeId} 缺少必需参数 ${k}，不能运行`, fix: op({ op: "set", node: nodeId, path: `params.${k}`, value: spec.params[k]?.example ?? null }),
  }))
  return [...missing, ...unfilledPlaceholderIssues(n, graph.defaults ?? {})]
}
