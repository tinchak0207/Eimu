// S2 补丁值校验：takes/onFail/forEach/refs/targets/defaults/lock 字段/写入结果的形状。
// 与节点类型相关的签名参数校验归 S3（specs.ts/validate.ts），这里只管契约里写明的结构性规则。
import { LIMITS } from "./constants.ts"
import { ARTIFACT_ID_RE } from "./artifacts.ts"
import { isInputKey } from "./patch-graph.ts"
import type { Json, NodeId, NodeType, OnFail, ProjectDefaults, ProjectGraph, TakesSpec, Targets, FileRef, ForEach } from "./types.ts"

export const NODE_TYPES: readonly NodeType[] = [
  "reference", "script", "shotlist", "keyframe", "clip", "voice", "music", "timeline", "subtitle", "mix", "export", "qc", "render3d",
]
export const MAX_VALUE_BYTES = 1 << 20
export const MAX_NODES = 5000

export type V<T> = { ok: true; value: T } | { ok: false; code: "BAD_VALUE" | "BAD_REF" | "BAD_PATH"; msg: string }
const ok = <T,>(value: T): V<T> => ({ ok: true, value })
const bad = (msg: string, code: "BAD_VALUE" | "BAD_REF" | "BAD_PATH" = "BAD_VALUE"): V<never> => ({ ok: false, code, msg })

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** 值必须是可往返的 JSON（有限数字、无 undefined/函数/循环），且序列化 ≤1MB。 */
export function checkJson(value: unknown, what: string): V<Json> {
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > 24) return false
    if (v === null || typeof v === "string" || typeof v === "boolean") return true
    if (typeof v === "number") return Number.isFinite(v)
    if (Array.isArray(v)) return v.every((x) => walk(x, depth + 1))
    if (isPlainObject(v)) return Object.values(v).every((x) => walk(x, depth + 1))
    return false
  }
  if (!walk(value, 0)) return bad(`${what} 不是合法 JSON 值`)
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_VALUE_BYTES) return bad(`${what} 超过 ${MAX_VALUE_BYTES} 字节`)
  return ok(value as Json)
}

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]"
  if (isPlainObject(v)) return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}"
  return JSON.stringify(v) ?? "null"
}
export const jsonEqual = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)

export function checkIntent(v: unknown): V<string> {
  if (typeof v !== "string") return bad("intent 必须是字符串")
  if ([...v].length > LIMITS.INTENT_CHARS) return bad(`intent 超过 ${LIMITS.INTENT_CHARS} 字`)
  return ok(v)
}

export function checkTakes(v: unknown): V<TakesSpec | null> {
  if (v === null) return ok(null)
  if (!isPlainObject(v)) return bad("takes 必须是对象或 null")
  const { n, select, rubric, ...rest } = v as Record<string, unknown>
  if (Object.keys(rest).length) return bad("takes 含未知字段")
  if (!Number.isInteger(n) || (n as number) < 2 || (n as number) > LIMITS.TAKES_MAX) return bad(`takes.n 必须是 2..${LIMITS.TAKES_MAX} 的整数`)
  if (select !== "qc" && select !== "first" && select !== "user") return bad("takes.select 必须是 qc|first|user")
  if (rubric !== undefined && (typeof rubric !== "string" || !rubric)) return bad("takes.rubric 必须是非空字符串")
  const out: TakesSpec = { n: n as number, select }
  if (rubric !== undefined) out.rubric = rubric as string
  return ok(out)
}

export function checkOnFail(v: unknown): V<OnFail | null> {
  if (v === null) return ok(null)
  if (!isPlainObject(v)) return bad("onFail 必须是对象或 null")
  const a = v.action
  if (a === "fail" || a === "skip" || a === "ask_user") {
    if (Object.keys(v).length !== 1) return bad("onFail 含未知字段")
    return ok({ action: a })
  }
  if (a !== "regenerate") return bad("onFail.action 必须是 regenerate|fail|skip|ask_user")
  const { action: _a, max, on, then, ...rest } = v as Record<string, unknown>
  if (Object.keys(rest).length) return bad("onFail 含未知字段")
  if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > LIMITS.REGENERATE_MAX) return bad(`onFail.max 必须是 1..${LIMITS.REGENERATE_MAX} 的整数`)
  if (on !== undefined && on !== "error" && on !== "qc_fail" && on !== "any") return bad("onFail.on 必须是 error|qc_fail|any")
  if (then !== undefined && then !== "fail" && then !== "skip" && then !== "ask_user") return bad("onFail.then 必须是 fail|skip|ask_user")
  const out: OnFail = { action: "regenerate", max: max as number }
  // 上面两行已把取值域校验完；unknown 在 strictNullChecks=false 下不被控制流自动收窄，故显式断言。
  if (on !== undefined) out.on = on as "error" | "qc_fail" | "any"
  if (then !== undefined) out.then = then as "fail" | "skip" | "ask_user"
  return ok(out)
}

/** forEach：over 必须是存在的 shotlist 且自身不是 forEach 节点；as 不能是 "row"。 */
export function checkForEach(graph: Pick<ProjectGraph, "nodes">, selfId: NodeId, selfType: NodeType, v: unknown): V<ForEach | null> {
  if (v === null) return ok(null)
  if (!isPlainObject(v)) return bad("forEach 必须是对象或 null")
  const { over, as, ...rest } = v as Record<string, unknown>
  if (Object.keys(rest).length) return bad("forEach 含未知字段")
  if (typeof over !== "string" || typeof as !== "string") return bad("forEach 需要 over/as 两个字符串")
  if (as === "row" || !/^[a-z][a-z0-9_]{0,31}$/.test(as)) return bad("forEach.as 必须是小写标识符且不能是 row")
  if (selfType === "shotlist") return bad("shotlist 节点不能有 forEach（v1 单层扇出）")
  const target = graph.nodes[over]
  if (!target) return bad(`forEach.over=${over} 不存在`, "BAD_REF")
  if (target.type !== "shotlist") return bad("forEach.over 必须指向 shotlist 节点")
  if (target.forEach) return bad("不允许 forEach over 另一个 forEach 节点")
  if (over === selfId) return bad("forEach.over 不能是自身", "BAD_REF")
  return ok({ over, as })
}

export function checkRefs(v: unknown): V<FileRef[]> {
  if (!Array.isArray(v)) return bad("refs 必须是数组")
  const out: FileRef[] = []
  for (const r of v) {
    if (!isPlainObject(r) || typeof r.artifactId !== "string" || !ARTIFACT_ID_RE.test(r.artifactId)) return bad("refs[].artifactId 必须形如 art_<16 位 hex>")
    if (typeof r.role !== "string" || !r.role || r.role.length > 48) return bad("refs[].role 必须是 1..48 字符的字符串")
    if (Object.keys(r).length !== 2) return bad("refs[] 含未知字段")
    out.push({ artifactId: r.artifactId, role: r.role })
  }
  return ok(out)
}

export function checkInputs(graph: Pick<ProjectGraph, "nodes">, v: unknown): V<Record<string, { from: NodeId; port?: string }>> {
  if (!isPlainObject(v)) return bad("inputs 必须是对象")
  const out: Record<string, { from: NodeId; port?: string }> = {}
  for (const [name, ref] of Object.entries(v)) {
    if (!isInputKey(name)) return bad(`输入口名 ${name} 非法（显式口 a-z0-9_，或派生口 ref:<节点id>[.<端口>]）`)
    if (!isPlainObject(ref) || typeof ref.from !== "string") return bad(`inputs.${name} 需要 {from}`)
    const port = ref.port
    if (port !== undefined && (typeof port !== "string" || !/^[a-z][a-z0-9_]*$/.test(port))) return bad(`inputs.${name}.port 非法`)
    if (!graph.nodes[ref.from]) return bad(`inputs.${name} 指向不存在的 ${ref.from}`, "BAD_REF")
    out[name] = port === undefined ? { from: ref.from } : { from: ref.from, port: port as string }
  }
  return ok(out)
}

const LOCK_FIELD_RE = /^(intent|params|inputs|takes|onFail|forEach|refs|outputs|params\.[A-Za-z_][A-Za-z0-9_]*|inputs\.[a-z][a-z0-9_]*)$/
export function checkLockFields(v: unknown): V<string[] | "*"> {
  if (v === "*") return ok("*")
  if (!Array.isArray(v) || v.length === 0) return bad('lock.fields 必须是 "*" 或非空字符串数组', "BAD_PATH")
  for (const f of v) if (typeof f !== "string" || !LOCK_FIELD_RE.test(f)) return bad(`lock 字段 ${String(f)} 非法`, "BAD_PATH")
  return ok([...new Set(v as string[])])
}

/** 字段是否被 lock 覆盖：精确相等，或锁的是其父（params 覆盖 params.x）。 */
export function lockCovers(lock: "*" | string[], field: string): boolean {
  if (lock === "*") return true
  return lock.some((f) => f === field || field.startsWith(f + "."))
}

export function checkTargets(v: unknown): V<Omit<Targets, "setBy" | "at">> {
  if (!isPlainObject(v)) return bad("targets 必须是对象")
  const out: Omit<Targets, "setBy" | "at"> = {}
  for (const [k, val] of Object.entries(v)) {
    if (k === "durationSec") {
      if (typeof val !== "number" || !(val > 0) || val > 3600) return bad("targets.durationSec 必须是 (0,3600] 的数字")
      out.durationSec = val
    } else if (k === "aspect") {
      if (typeof val !== "string" || !/^\d{1,3}:\d{1,3}$/.test(val)) return bad("targets.aspect 必须形如 16:9")
      out.aspect = val
    } else if (k === "shots") {
      if (!Number.isInteger(val) || (val as number) < 1 || (val as number) > 200) return bad("targets.shots 必须是 1..200 的整数")
      out.shots = val as number
    } else if (k === "subtitles") {
      if (typeof val !== "boolean") return bad("targets.subtitles 必须是布尔")
      out.subtitles = val
    } else if (k === "audio") {
      if (val !== "voice" && val !== "music" && val !== "both" && val !== "none") return bad("targets.audio 必须是 voice|music|both|none")
      out.audio = val
    } else return bad(`targets 含未知字段 ${k}`)
  }
  return ok(out)
}

export function checkDefaults(v: unknown): V<ProjectDefaults> {
  if (!isPlainObject(v)) return bad("defaults 必须是对象")
  const out: ProjectDefaults = {}
  for (const [k, val] of Object.entries(v)) {
    if (!["videoModel", "imageModel", "imageSize", "voice", "style"].includes(k)) return bad(`defaults 含未知字段 ${k}`)
    if (typeof val !== "string" || !val || val.length > 200) return bad(`defaults.${k} 必须是 1..200 字符的字符串`)
    ;(out as Record<string, string>)[k] = val
  }
  return ok(out)
}

/** write_result 的值 → 规范化内容。script→{text}；shotlist→{kind?,rows}；qc(critic)→{score,pass,deficiencies}。 */
export function checkWriteValue(type: NodeType, v: unknown): V<Record<string, Json>> {
  if (type === "script") {
    const text = typeof v === "string" ? v : isPlainObject(v) && typeof v.text === "string" && Object.keys(v).length === 1 ? v.text : null
    if (text === null) return bad("script 的结果必须是字符串或 {text}")
    return ok({ text })
  }
  if (type === "shotlist") {
    const rows = Array.isArray(v) ? v : isPlainObject(v) ? v.rows : null
    const kind = isPlainObject(v) && v.kind !== undefined ? v.kind : undefined
    if (!Array.isArray(rows)) return bad("shotlist 的结果必须是 rows 数组或 {kind?, rows}")
    if (kind !== undefined && typeof kind !== "string") return bad("shotlist.kind 必须是字符串")
    const seen = new Set<string>()
    for (const r of rows) {
      if (!isPlainObject(r) || typeof r.id !== "string" || !/^[a-z0-9_]{1,32}$/.test(r.id)) return bad("shotlist 每行需要 id（[a-z0-9_]{1,32}）")
      if (seen.has(r.id)) return bad(`shotlist 行 id 重复：${r.id}`)
      seen.add(r.id)
    }
    const j = checkJson(rows, "rows")
    if (!j.ok) return bad((j as { msg: string }).msg) // checkJson 的失败码只有 BAD_VALUE（strictNullChecks=false 不自动收窄）
    const out: Record<string, Json> = { rows: rows as Json }
    if (kind !== undefined) out.kind = kind as string
    return ok(out)
  }
  if (type === "qc") {
    if (!isPlainObject(v) || typeof v.pass !== "boolean" || typeof v.score !== "number" || !Number.isFinite(v.score)) return bad("qc 的结果必须含 pass:boolean 与 score:number")
    const def = v.deficiencies
    if (def !== undefined && !(Array.isArray(def) && def.every((d) => typeof d === "string"))) return bad("qc.deficiencies 必须是字符串数组")
    const out: Record<string, Json> = { score: v.score, pass: v.pass }
    if (def !== undefined) out.deficiencies = def as string[]
    return ok(out)
  }
  return bad("不支持写入结果的节点类型")
}
