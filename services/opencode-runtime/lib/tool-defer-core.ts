// tool-defer-core（2026-11-24）：工具定义静态折叠 ＋ base64 入参拦截。由 plugin/tool-defer.ts 接线。
//
// 实测基线（生产 opencode.db 近 7 天）：每次模型调用 ~70k prompt token，其中工具 schema 6–7.5 万字符
// （creator 56 支／orchestrator 44 支）；image_generate 有 33 次把 data:...;base64 写进参数（最长 5.6 万字符，
// 全是输出 token）。
//
// 机制（opencode 1.18.14 源码）：
// - `tool.definition` 每步对每支工具触发（tool/registry.ts:313），可替换送给模型的 description 与 jsonSchema；
//   执行时仍按工具原始 zod schema 解码校验（tool/tool.ts decode），所以折叠不改变参数合法性。
// - 钩子拿不到 sessionID ⇒ 只做「静态」折叠：同一支工具每步送出的定义逐字不变，不破坏前缀缓存
//   （Manus：动态增删工具会让缓存全失效，别做）。
// - 低频工具：描述折成一句、schema 只留结构（去掉各层 description/examples/title）。
//   首次调用若参数缺必填或含未知键 ⇒ 不执行、不扣费，回传完整说明让模型重调；参数合法则直接放行。
//
// 常驻（不折叠）的名单来自生产各 agent 近 14–30 天真实调用频次；内建工具一律不碰。

export const TOOL_DEFER_ENABLED = process.env.TOOL_DEFER !== "0"
export const BASE64_GUARD_ENABLED = process.env.BASE64_ARG_GUARD !== "0"
/** 参数里单段 base64 超过这个长度就拦（小图标级别的内联放行）。 */
export const BASE64_ARG_MAX_CHARS = Math.max(256, Number(process.env.BASE64_ARG_MAX_CHARS) || 4096)

const BUILTIN = new Set([
  "bash", "read", "glob", "grep", "edit", "write", "task", "webfetch", "todowrite", "todoread", "skill",
  "question", "invalid", "apply_patch", "websearch", "codesearch", "lsp", "batch", "list", "patch", "multiedit", "execute",
])

const CORE = new Set(
  [
    "subagent_status", "subagent_dispatch", "subagent_message", "subagent_stop",
    "read_image", "quote_bundle", "image_generate", "image_get_result", "image_quote", "image_result_download",
    "artifact_publish", "artifact_verify", "ue_editor", "canvas_get_state", "schedule_wakeup",
    "video_transcribe", "video_fetch", "video_evidence", "video_result_fetch", "video_quote",
    "run_py", "model3d_generate", "workflow_write", "workflow_history", "workflow_status", "search_web",
    // 记忆要当场记、当面说（2026-11-24 用户裁定），不能被折叠成「首次调用先挡一次」
    "memory_note", "user_memory_recall", "memory_forget", "chat_history_search",
    ...(process.env.TOOL_DEFER_CORE_EXTRA ?? "").split(/[\s,]+/).filter(Boolean),
  ],
)

export const DEFER_NOTE = "【参数说明已折叠：参数不全时首次调用只返回完整说明，不执行、不扣费，照说明重调即可】"

export function isDeferred(toolID: string): boolean {
  return TOOL_DEFER_ENABLED && !BUILTIN.has(toolID) && !CORE.has(toolID)
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

const SCHEMA_DOC_KEYS = new Set(["description", "examples", "title", "$schema", "$comment"])
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "definitions", "$defs"])

/** 只去掉 schema 关键字层的说明文字；properties 下的键是参数名，原样保留（参数可能就叫 description/title）。 */
export function skeletonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(skeletonSchema)
  if (!isObj(node)) return node
  const out: Json = {}
  for (const [k, v] of Object.entries(node)) {
    if (SCHEMA_DOC_KEYS.has(k)) continue
    if (SCHEMA_MAP_KEYS.has(k) && isObj(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, skeletonSchema(sub)]))
    } else if (k === "enum" || k === "const" || k === "default" || k === "required") {
      out[k] = v
    } else {
      out[k] = skeletonSchema(v)
    }
  }
  return out
}

export function shortDescription(desc: string): string {
  const d = (desc ?? "").trim()
  const m = /[。！？\n]|\.\s/.exec(d)
  const first = (m ? d.slice(0, m.index + 1) : d).trim()
  return (first.length > 100 ? first.slice(0, 100) + "…" : first) + DEFER_NOTE
}

type Original = { description: string; jsonSchema: Json }
const store = globalThis as { __eimuToolDefer?: Map<string, Original> }
const originals = (store.__eimuToolDefer ??= new Map())

/** tool.definition 钩子本体：就地改 output。返回 true 表示已折叠。 */
export function foldDefinition(toolID: string, output: { description?: string; jsonSchema?: unknown }): boolean {
  if (!isDeferred(toolID) || !isObj(output.jsonSchema) || typeof output.description !== "string") return false
  if (output.description.endsWith(DEFER_NOTE)) return false
  originals.set(toolID, { description: output.description, jsonSchema: output.jsonSchema })
  output.description = shortDescription(output.description)
  output.jsonSchema = skeletonSchema(output.jsonSchema)
  return true
}

/** 粗验：必填键齐、且（schema 禁额外键时）没有未知键。只用于决定「放行」还是「先给完整说明」。 */
export function argsLookValid(args: unknown, schema: Json): boolean {
  if (!isObj(args)) return false
  const props = isObj(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === "string") : []
  if (required.some((k) => args[k] === undefined)) return false
  if (schema.additionalProperties === false && Object.keys(args).some((k) => !(k in props))) return false
  return true
}

const loaded = new Map<string, Set<string>>()
function loadedSet(sessionID: string): Set<string> {
  let s = loaded.get(sessionID)
  if (!s) {
    s = new Set()
    loaded.set(sessionID, s)
    if (loaded.size > 500) loaded.delete(loaded.keys().next().value as string)
  }
  return s
}

/** 折叠工具首次调用：参数看起来合法 → 放行（null）；否则回传要抛给模型的完整说明。 */
export function deferredCallGate(toolID: string, sessionID: string, args: unknown): string | null {
  const orig = originals.get(toolID)
  if (!orig || !isDeferred(toolID)) return null
  const seen = loadedSet(sessionID)
  if (seen.has(toolID)) return null
  seen.add(toolID)
  if (argsLookValid(args, orig.jsonSchema)) return null
  return (
    `【${toolID} 首次调用：本次未执行、未扣费。完整说明如下，请按参数 schema 重新调用】\n` +
    `${orig.description}\n参数 JSON Schema：\n${JSON.stringify(orig.jsonSchema)}`
  )
}

const BASE64_RE = /data:[a-z]+\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)/gi

/** 参数里有超长 base64 内联数据 → 回传拦截说明；否则 null。 */
export function base64ArgGate(toolID: string, args: unknown): string | null {
  if (!BASE64_GUARD_ENABLED || args === undefined) return null
  let text: string
  try {
    text = JSON.stringify(args)
  } catch {
    return null
  }
  if (!text || text.length < BASE64_ARG_MAX_CHARS) return null
  let longest = 0
  for (const m of text.matchAll(BASE64_RE)) longest = Math.max(longest, m[1].length)
  if (longest < BASE64_ARG_MAX_CHARS) return null
  return (
    `【${toolID} 参数被拦截：本次未执行、未扣费】参数里有 ${longest} 字符的 base64 内联数据。` +
    `不要把文件内容写进参数（会逐字消耗输出 token、又慢又贵）：改传工作区内的文件绝对路径（如 uploads/<session>/ 下的附件）或 http(s) URL 后重新调用。`
  )
}
