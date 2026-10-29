// ProjectGraph S3：NODE_SPECS（设计文档 §3.5 的落地）+ 参数校验 + pin 边界 + 默认值物化。
// 只依赖契约（types.ts / constants.ts）。纯函数、无 IO。
// 约定：参数规则里“严格”的地方都有独立来源（image_generate 的 zod 参数、handleTts 的 2000 字上限、EDITOR_ASPECTS、MASTER_PRESETS）；
// 语义由别的切片决定的地方（reference.source、shotlist.kind、render3d.engine 等）只做标识符形状校验，不枚举，避免与执行器/配方漂移。
import type { Json, NodeId, NodeSpecLite, NodeType, ProjectDefaults, ProjectNode } from "./types"
import { LIMITS } from "./constants"

// ---------------------------------------------------------------- 端口类型
export type PortKind = "file" | "text" | "json" | "image" | "video" | "audio" | "package"
export interface PortSpec { name: string; kind: PortKind }
const BINARY: ReadonlySet<PortKind> = new Set<PortKind>(["file", "image", "video", "audio", "package"])

/** 上游端口 kind 能否接进“接受 accepts”的输入口。file=未定媒体类型的二进制（reference 的产物），可进任何接受二进制的口；
 * 但“接受 file”的口只收 file（keyframe 接受 file ≠ 接受音频）。 */
export function portKindCompatible(out: PortKind, accepts: readonly PortKind[]): boolean {
  if (accepts.includes(out)) return true
  return out === "file" && accepts.some((k) => BINARY.has(k))
}

// ---------------------------------------------------------------- 参数规则
export type ParamRule = ParamRuleBody & {
  signed: boolean          // 进签名？（NodeSpecLite.signedParams 由它派生）
  required?: boolean       // 运行前必须有（物化默认值之后）；图校验阶段只给 warning
  example: Json            // 教学式错误里的修正示例值
  doc?: string
}
type ParamRuleBody =
  | { kind: "string"; max: number; min?: number; pattern?: RegExp; hint?: string }
  | { kind: "number"; min?: number; max?: number; integer?: boolean }
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "array"; max: number; item?: "string" | "object" }
  | { kind: "json" }       // 形状由别的切片/执行器定，只限制可序列化与体积

export type ExecutorKind = "materialize" | "authored" | "generation" | "speech" | "exec-bridge" | "deterministic"

export interface NodeSpec extends NodeSpecLite {
  title: string
  executor: ExecutorKind
  primaryPort: string
  outputs: PortSpec[]
  inputAccepts: readonly PortKind[]      // 空=不接受任何输入边
  params: Record<string, ParamRule>      // 本类型全部合法参数键（未知键一律拒绝，防止“改了没进签名”的静默 stale 漏洞）
  takesAllowed: boolean
  seeded: boolean                        // 缺省 seed 按 hash(nodeId) 赋值
  maxReferences?: (node: Pick<ProjectNode, "params">) => number   // refs + 图片类输入边 的上限（对齐 image_generate）
  pinNote: string                        // 人话：为什么可/不可 pin
}

const ID_RE = /^[a-z][a-z0-9_]{0,31}$/
export const NODE_ID_RE = /^[a-z][a-z0-9_]{0,47}(#[a-z0-9_]{1,32})?$/
export const ROW_ID_RE = /^[a-z0-9_]{1,32}$/
export const ARTIFACT_ID_RE = /^art_[0-9a-f]{16}$/
export const SHA256_RE = /^[0-9a-f]{64}$/

// 对齐 deploy-staging/opencode-runtime/tools/image_generate.ts：MAX_REFERENCE_IMAGES=5；minimax-h3 视频 9 张。
export const MAX_REFERENCE_IMAGES = 5
export const MINIMAX_H3_MAX_REFERENCES = 9
// 对齐 gateway/editor/aspect.ts EDITOR_ASPECTS、master.ts MASTER_PRESETS（specs.test.ts 与源文件对表）
export const ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const
export const EXPORT_PRESETS = ["portrait_916", "landscape_169", "cinema_239", "image_pack"] as const
export const VIDEO_RESOLUTIONS = ["480p", "540p", "720p", "1080p", "2k", "4k"] as const
export const MUSIC_RIGHTS = ["own", "licensed", "public_domain"] as const

const S = (max: number, example: Json, o: Partial<Extract<ParamRuleBody, { kind: "string" }>> & { signed?: boolean; required?: boolean; doc?: string } = {}): ParamRule => {
  const { signed = true, required, doc, ...rest } = o
  return { kind: "string", max, signed, required, example, doc, ...rest }
}
const N = (example: number, o: { min?: number; max?: number; integer?: boolean; signed?: boolean; required?: boolean; doc?: string } = {}): ParamRule => {
  const { signed = true, required, doc, ...rest } = o
  return { kind: "number", signed, required, example, doc, ...rest }
}
const E = (values: readonly string[], o: { signed?: boolean; required?: boolean; doc?: string } = {}): ParamRule => ({
  kind: "enum", values, signed: o.signed ?? true, required: o.required, example: values[0], doc: o.doc,
})
const B = (o: { signed?: boolean; doc?: string } = {}): ParamRule => ({ kind: "boolean", signed: o.signed ?? true, example: true, doc: o.doc })
const A = (max: number, example: Json, o: { item?: "string" | "object"; signed?: boolean; required?: boolean } = {}): ParamRule => ({
  kind: "array", max, item: o.item, signed: o.signed ?? true, required: o.required, example,
})
const J = (example: Json, o: { signed?: boolean; required?: boolean } = {}): ParamRule => ({ kind: "json", signed: o.signed ?? true, required: o.required, example })

const TITLE: ParamRule = S(80, "镜头 1 关键帧", { signed: false, doc: "画布显示名；不进签名" })
const MODEL = /^\S+$/

const seedRule = N(42, { min: 0, max: 2147483647, integer: true, doc: "缺省按 hash(nodeId) 赋值；reroll 只改它" })
const styleLockRule = S(8000, "统一赛璐珞风格，低饱和", { doc: "对应 image_generate.style_lock；逐字前缀到 prompt" })
const modelRule = (example: string): ParamRule => S(120, example, { min: 1, pattern: MODEL, hint: "不含空白的模型名" })

// ---------------------------------------------------------------- NODE_SPECS（§3.5 表）
const SPEC_VERSION = 1
function mk(spec: Omit<NodeSpec, "signedParams" | "specVersion" | "fingerprintMode"> & { fingerprintMode?: NodeSpec["fingerprintMode"]; specVersion?: number }): NodeSpec {
  const signedParams = Object.keys(spec.params).filter((k) => spec.params[k].signed)
  return { specVersion: SPEC_VERSION, fingerprintMode: "structural", ...spec, signedParams }
}
const out = (kind: PortKind): PortSpec[] => [{ name: "out", kind }]

export const NODE_SPECS: Readonly<Record<NodeType, NodeSpec>> = {
  reference: mk({
    type: "reference", title: "参考素材", executor: "materialize", primaryPort: "out", outputs: out("file"),
    inputAccepts: [], takesAllowed: false, seeded: false, pinnable: true, fingerprintMode: "content",
    pinNote: "素材本身就是定稿，可钉",
    params: {
      title: TITLE,
      source: S(32, "upload", { pattern: ID_RE, hint: "来源标识符（如 upload / library）", required: true }),
      artifactId: S(20, "art_0123456789abcdef", { pattern: ARTIFACT_ID_RE, hint: '"art_" + 16 位小写 hex', required: true }),
    },
  }),
  script: mk({
    type: "script", title: "剧本", executor: "authored", primaryPort: "out", outputs: out("text"),
    inputAccepts: ["text", "json"], takesAllowed: false, seeded: false, pinnable: true,
    pinNote: "剧本定稿后可钉",
    params: { title: TITLE, text: S(200_000, "第一场 夜，雨中的站台……", { signed: true }) },
  }),
  shotlist: mk({
    type: "shotlist", title: "镜头表/行表", executor: "authored", primaryPort: "out", outputs: out("json"),
    inputAccepts: ["text", "json"], takesAllowed: false, seeded: false, pinnable: true,
    pinNote: "镜头表定稿后可钉",
    params: {
      title: TITLE,
      kind: S(32, "shots", { pattern: ID_RE, hint: "行表种类标识符（shots / views / items / variants …）" }),
      rows: A(500, [{ id: "s1", action: "男主走进站台" }], { item: "object" }),
    },
  }),
  keyframe: mk({
    type: "keyframe", title: "图片生成", executor: "generation", primaryPort: "out", outputs: out("image"),
    inputAccepts: ["image", "file", "text", "json"], takesAllowed: true, seeded: true, pinnable: true,
    maxReferences: () => MAX_REFERENCE_IMAGES, pinNote: "选定的图可钉",
    params: {
      title: TITLE,
      prompt: S(16_000, "雨夜站台，男主背影，电影感", { min: 1, required: true }),
      model: modelRule("gpt-image-2.5-flare"),
      size: S(16, "1024x1536", { pattern: /^\d{3,5}x\d{3,5}$/, hint: '像素尺寸 "宽x高"，如 "1024x1536"（图片不接受 16:9 这类比例）' }),
      seed: seedRule,
      role: S(32, "keyframe", { pattern: ID_RE, hint: "用途标识符（reference / keyframe / poster / detail_page …）" }),
      toolSubmission: J({}), // 原工具预处理合同；全部字段进签名，同一runner提交
      n: N(1, { min: 1, max: 4, integer: true }),
      quality: E(["standard", "hd"]),
      styleLock: styleLockRule,
    },
  }),
  clip: mk({
    type: "clip", title: "视频生成", executor: "generation", primaryPort: "out", outputs: out("video"),
    inputAccepts: ["image", "file", "text", "json"], takesAllowed: true, seeded: true, pinnable: true,
    maxReferences: (n) => (n.params?.model === "minimax-h3" ? MINIMAX_H3_MAX_REFERENCES : MAX_REFERENCE_IMAGES),
    pinNote: "选定的片段可钉",
    params: {
      title: TITLE,
      toolSubmission: J({}),
      prompt: S(16_000, "镜头缓推，雨滴落在伞面，人物回头", { min: 1, required: true }),
      model: modelRule("minimax-h3"),
      size: S(16, "16:9", { pattern: /^(\d{1,2}:\d{1,2}|\d{3,5}x\d{3,5})$/, hint: '画面比例（"16:9"）或像素（"1920x1080"）' }),
      seconds: N(5, { min: 5, max: 60, doc: "对应 image_generate.duration_seconds（平台硬规则：≥5 秒）" }),
      n: N(1, { min: 1, max: 4, integer: true }), // videos/generations真实batch合同
      resolution: E(VIDEO_RESOLUTIONS),
      seed: seedRule,
      generateAudio: B(),
      styleLock: styleLockRule,
    },
  }),
  voice: mk({
    type: "voice", title: "配音", executor: "speech", primaryPort: "out", outputs: out("audio"),
    inputAccepts: ["text", "json"], takesAllowed: true, seeded: false, pinnable: true,
    pinNote: "定稿配音可钉",
    params: {
      title: TITLE,
      text: S(2000, "他终于回来了。", { min: 1, required: true, doc: "handleTts 上限 2000 字" }),
      voice: S(64, "zh_female_1", { pattern: /^\S+$/, hint: "不含空白的音色名" }),
      speed: N(1, { min: 0.25, max: 4 }),
    },
  }),
  music: mk({
    type: "music", title: "音乐", executor: "exec-bridge", primaryPort: "out", outputs: out("audio"),
    inputAccepts: ["text", "json", "audio", "file"], takesAllowed: true, seeded: false, pinnable: true,
    pinNote: "定稿音乐可钉（1 币/次，钉住省钱）",
    params: {
      title: TITLE,
      prompt: S(3000, "cinematic orchestral, 90 BPM, key of D minor, heroic", { min: 1, required: true, doc: "music_gen prompt 硬上限 3000（FlowMusic2API 带歌词分支）" }),
      lyrics: S(6000, "[Verse]\n……"),
      // 时长唯一控制 = durationHint（映射 music_gen 的 duration_hint=full|clip30）。
      // 曾有的 seconds/model 上游不认：改它们只改签名、不改变产物，等于让用户为不存在的控制付 1 币。
      durationHint: E(["full", "clip30"], { doc: "music_gen 实际接受的时长控制（同 duration_hint）" }),
      sourceAudioSha: S(64, "0".repeat(64), { pattern: SHA256_RE, hint: "64 位小写 hex（参考音频内容 sha256）" }),
      rights: E(MUSIC_RIGHTS, { signed: false, doc: "J5 参数闸：带 sourceAudioSha 必须声明版权状态；不进签名" }),
    },
  }),
  timeline: mk({
    type: "timeline", title: "时间线", executor: "deterministic", primaryPort: "out", outputs: out("json"),
    inputAccepts: ["video", "image", "audio", "json", "text", "file"], takesAllowed: false, seeded: false, pinnable: true,
    pinNote: "人手剪辑后可钉住保护",
    params: {
      title: TITLE,
      order: A(500, ["shot1", "shot2"], { item: "string" }),
      transitions: J([{ after: "shot1", type: "cut", duration: 0 }]),
      aspect: E(ASPECTS),
      fps: N(30, { min: 1, max: 120, integer: true }),
      styleId: S(64, "default", { pattern: /^\S+$/ }),
    },
  }),
  subtitle: mk({
    type: "subtitle", title: "字幕", executor: "deterministic", primaryPort: "srt",
    outputs: [{ name: "srt", kind: "file" }, { name: "ass", kind: "file" }],
    inputAccepts: ["json", "text"], takesAllowed: false, seeded: false, pinnable: true,
    pinNote: "定稿字幕可钉",
    params: {
      title: TITLE,
      style: J("default"),
      burnIn: B(),
      lang: S(16, "zh-CN", { pattern: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, hint: "BCP-47 语言码，如 zh-CN" }),
    },
  }),
  mix: mk({
    type: "mix", title: "混音", executor: "deterministic", primaryPort: "out", outputs: out("audio"),
    inputAccepts: ["audio", "json", "file"], takesAllowed: false, seeded: false, pinnable: true,
    pinNote: "定稿混音可钉",
    params: {
      title: TITLE,
      levels: J({ voice: 0, music: -18 }),
      ducking: J(true),
      targetLufs: N(-16, { min: -40, max: -5 }),
    },
  }),
  export: mk({
    type: "export", title: "导出", executor: "deterministic", primaryPort: "out", outputs: [...out("video"), { name: "jianying", kind: "package" }, { name: "fcpxml", kind: "package" }],
    inputAccepts: ["video", "audio", "image", "json", "text", "file", "package"], takesAllowed: false, seeded: false, pinnable: false,
    pinNote: "唯一交付出口，交付前必须能重新检查，不可钉",
    specVersion: 2,
    params: { title: TITLE, preset: E(EXPORT_PRESETS, { required: true }), stage: E(["candidate", "publish"]), goalRevision: S(64, "0".repeat(64), { pattern: /^[0-9a-f]{64}$/ }) },
  }),
  qc: mk({
    type: "qc", title: "质检", executor: "deterministic", primaryPort: "out", outputs: out("json"),
    inputAccepts: ["video", "audio", "image", "json", "text", "file", "package"], takesAllowed: false, seeded: false, pinnable: false,
    pinNote: "质检结论必须随产物重算，不可钉",
    params: {
      title: TITLE,
      mode: E(["machine", "critic"], { required: true }),
      rubric: S(64, "film_default", { pattern: /^\S+$/ }),
      thresholds: J({ durationTolerance: 0.1 }),
      briefLedgerRevision: S(64, "0".repeat(64), { pattern: /^[0-9a-f]{64}$/ }),
    },
  }),
  render3d: mk({
    type: "render3d", title: "Blender 渲染", executor: "exec-bridge", primaryPort: "out", outputs: out("file"),
    inputAccepts: ["file", "text", "json"], takesAllowed: true, seeded: false, pinnable: true,
    pinNote: "定稿渲染可钉",
    params: {
      title: TITLE,
      script: S(200_000, "import bpy …", { min: 1, required: true }),
      engine: S(32, "cycles", { pattern: ID_RE, hint: "渲染引擎标识符" }),
      params: J({}),
    },
  }),
}

export const NODE_TYPES = Object.keys(NODE_SPECS) as NodeType[]
/** 给 S1（signature.ts）的轻量视图。 */
export const NODE_SPECS_LITE: Readonly<Record<NodeType, NodeSpecLite>> = Object.fromEntries(
  NODE_TYPES.map((t) => {
    const s = NODE_SPECS[t]
    const lite: NodeSpecLite = { type: s.type, specVersion: s.specVersion, signedParams: [...s.signedParams], pinnable: s.pinnable, fingerprintMode: s.fingerprintMode }
    if (s.volatile) lite.volatile = true
    return [t, lite]
  }),
) as Record<NodeType, NodeSpecLite>

export function specOf(type: string): NodeSpec | null {
  return Object.prototype.hasOwnProperty.call(NODE_SPECS, type) ? NODE_SPECS[type as NodeType] : null
}

/** 端口名解析：缺省或 "out" → 主口；不存在 → null。 */
export function resolvePort(spec: NodeSpec, port?: string): string | null {
  if (port === undefined || port === "out") return spec.primaryPort
  return spec.outputs.some((o) => o.name === port) ? port : null
}
/** 端口 kind；export 的主口随 preset 变：image_pack=package，其余=video。 */
export function portKindOf(node: Pick<ProjectNode, "type" | "params">, port?: string): PortKind | null {
  const spec = specOf(node.type)
  if (!spec) return null
  const p = resolvePort(spec, port)
  if (p === null) return null
  if (node.type === "export" && node.params?.preset === "image_pack") return "package"
  return spec.outputs.find((o) => o.name === p)!.kind
}

// ---------------------------------------------------------------- 引用字符串
export const REF_WHOLE_RE = /^\$\{[^${}]+\}$/
export const hasRef = (s: string) => s.includes("${")
const chars = (s: string) => [...s].length

// ---------------------------------------------------------------- 参数校验（教学式错误）
export interface ParamIssue { key: string; message: string; fix: string }

const fixOf = (nodeId: string, key: string, value: Json): string => JSON.stringify({ op: "set", node: nodeId, path: `params.${key}`, value })
const showVal = (v: unknown): string => {
  const s = JSON.stringify(v)
  return s === undefined ? String(v) : s.length > 60 ? s.slice(0, 57) + "..." : s
}

/** 校验单个参数值。字符串里的 ${...} 引用：string 规则只校验长度；number/boolean/enum 允许整串就是一个引用（扇出展开后会再校验一次实例）。 */
export function checkParam(type: string, key: string, value: Json, nodeId: NodeId = "<node_id>"): ParamIssue | null {
  const spec = specOf(type)
  if (!spec) return { key, message: `未知节点类型 ${type}`, fix: `可用类型：${NODE_TYPES.join(", ")}` }
  const rule = spec.params[key]
  if (!rule) {
    const hint = Object.keys(spec.params).filter((k) => k !== "title").join(", ")
    return { key, message: `${type} 节点没有参数 ${key}。可用参数：${hint}`, fix: `删掉 ${key}，或改用上面列出的参数名` }
  }
  const bad = (why: string): ParamIssue => ({ key, message: `${type}.${key} ${why}（收到 ${showVal(value)}）`, fix: fixOf(nodeId, key, rule.example) })
  const wholeRef = typeof value === "string" && REF_WHOLE_RE.test(value)
  switch (rule.kind) {
    case "string": {
      if (typeof value !== "string") return bad("必须是字符串")
      const n = chars(value)
      if (rule.min !== undefined && n < rule.min) return bad(`不能为空（至少 ${rule.min} 字）`)
      if (n > rule.max) return bad(`最多 ${rule.max} 字，实际 ${n} 字`)
      if (rule.pattern && !hasRef(value) && !rule.pattern.test(value)) return bad(`格式不对：${rule.hint ?? rule.pattern.source}`)
      return null
    }
    case "number": {
      if (wholeRef) return null
      if (typeof value !== "number" || !Number.isFinite(value)) return bad("必须是数字")
      if (rule.integer && !Number.isInteger(value)) return bad("必须是整数")
      if (rule.min !== undefined && value < rule.min) return bad(`不能小于 ${rule.min}`)
      if (rule.max !== undefined && value > rule.max) return bad(`不能大于 ${rule.max}`)
      return null
    }
    case "boolean":
      if (wholeRef || typeof value === "boolean") return null
      return bad("必须是 true 或 false")
    case "enum":
      if (wholeRef) return null
      if (typeof value !== "string" || !rule.values.includes(value)) return bad(`只能取 ${rule.values.join(" / ")}`)
      return null
    case "array": {
      if (!Array.isArray(value)) return bad("必须是数组")
      if (value.length > rule.max) return bad(`最多 ${rule.max} 项，实际 ${value.length} 项`)
      if (rule.item === "string" && value.some((v) => typeof v !== "string" || v.length === 0 || v.length > 80)) return bad("每项必须是 1..80 字的字符串")
      if (rule.item === "object" && value.some((v) => v === null || typeof v !== "object" || Array.isArray(v))) return bad("每项必须是对象")
      if (type === "shotlist" && key === "rows") return checkRows(value, nodeId, bad)
      return null
    }
    case "json": {
      const bytes = jsonBytes(value)
      if (bytes < 0) return bad("必须是可序列化的 JSON")
      if (bytes > LIMITS.INPUT_CAP_BYTES) return bad(`序列化后不能超过 ${LIMITS.INPUT_CAP_BYTES} 字节`)
      return null
    }
  }
}

function checkRows(rows: Json[], nodeId: string, bad: (why: string) => ParamIssue): ParamIssue | null {
  const seen = new Set<string>()
  for (let i = 0; i < rows.length; i++) {
    const id = (rows[i] as { [k: string]: Json }).id
    if (typeof id !== "string" || !ROW_ID_RE.test(id)) return bad(`第 ${i} 行的 id 必须是 1..32 位 [a-z0-9_]（扇出实例 id = 节点id#行id）`)
    if (seen.has(id)) return bad(`行 id 重复：${id}（forEach 实例 id 由它决定，必须唯一）`)
    seen.add(id)
  }
  return null
}
function jsonBytes(v: Json): number {
  try { const s = JSON.stringify(v); return s === undefined ? -1 : new TextEncoder().encode(s).length } catch { return -1 }
}

/** J5 参数闸：版权/乐理里“能由参数强制”的部分。乐理术语核对无法用代码强制（见回报）。 */
const COVER_MARKERS = /翻唱|翻录|cover of|covering|same melody|identical melody|原曲旋律|复刻.{0,12}旋律|旋律.{0,6}(一致|相同|照搬)|in the exact style of/i
export function checkMusicRights(params: Record<string, Json>, nodeId: NodeId = "<node_id>"): ParamIssue | null {
  if (params.sourceAudioSha !== undefined && params.rights === undefined) {
    return {
      key: "rights",
      message: "music 带 sourceAudioSha（参考音频）必须声明版权状态 rights：own（自有）/ licensed（已授权）/ public_domain（公版）。不得以在版歌曲旋律为参考交付",
      fix: fixOf(nodeId, "rights", "own"),
    }
  }
  for (const k of ["prompt", "lyrics"] as const) {
    const v = params[k]
    if (typeof v === "string" && COVER_MARKERS.test(v)) {
      return {
        key: k,
        message: `music.${k} 含有复刻/翻唱既有歌曲旋律的措辞。不交付在版歌曲旋律；请只描述风格、情绪、配器、BPM、调性`,
        fix: fixOf(nodeId, k, "cinematic orchestral, 90 BPM, key of D minor, mood: heroic"),
      }
    }
  }
  return null
}

/** 整个 params 对象校验：未知键、每个值、music 参数闸。 */
export function checkParams(type: string, params: Record<string, Json>, nodeId: NodeId = "<node_id>"): ParamIssue[] {
  const issues: ParamIssue[] = []
  for (const [k, v] of Object.entries(params ?? {})) {
    const i = checkParam(type, k, v, nodeId)
    if (i) issues.push(i)
  }
  if (type === "music" && params) {
    const g = checkMusicRights(params, nodeId)
    if (g) issues.push(g)
  }
  return issues
}

// ---------------------------------------------------------------- 默认值
/** FNV-1a 32 位，截到 31 位非负整数。同 nodeId 永远同 seed。 */
export function defaultSeed(nodeId: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < nodeId.length; i++) {
    h ^= nodeId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h & 0x7fffffff
}

/** 硬默认（来源：image_generate.ts 的 execute 默认值）。clip 不给默认 model：必须来自 defaults.videoModel 或显式设置。 */
const HARD_DEFAULTS: Partial<Record<NodeType, Record<string, Json>>> = {
  keyframe: { model: "gpt-image-2.5-flare", size: "1024x1024", n: 1, quality: "standard" },
  clip: { size: "16:9", seconds: 15 },
  voice: { speed: 1 },
}

/**
 * 物化默认值：返回新 params，只补缺失键。优先级 显式参数 > 工程 defaults > 硬默认；seeded 类型补 hash(nodeId) seed。
 * 必须在 add_node 时调用（让默认值落进 params 从而进签名）；否则工程 defaults 变化会让旧产物被错误复用。
 */
export function materializeDefaults(type: NodeType, nodeId: NodeId, params: Record<string, Json> = {}, defaults: ProjectDefaults = {}): Record<string, Json> {
  const spec = NODE_SPECS[type]
  const out: Record<string, Json> = { ...params }
  const fill = (k: string, v: Json | undefined) => { if (out[k] === undefined && v !== undefined && spec.params[k]) out[k] = v }
  if (type === "keyframe") { fill("model", defaults.imageModel); fill("size", defaults.imageSize); fill("styleLock", defaults.style) }
  if (type === "clip") { fill("model", defaults.videoModel); fill("styleLock", defaults.style) }
  if (type === "voice") fill("voice", defaults.voice)
  for (const [k, v] of Object.entries(HARD_DEFAULTS[type] ?? {})) fill(k, v)
  if (spec.seeded && out.seed === undefined) out.seed = defaultSeed(nodeId)
  return out
}

/** 物化后仍缺的必需参数（运行前检查；图校验阶段只当 warning，允许“先加节点后补 prompt”）。 */
export function missingRequired(node: Pick<ProjectNode, "type" | "id" | "params">, defaults: ProjectDefaults = {}): string[] {
  const spec = specOf(node.type)
  if (!spec) return []
  const eff = materializeDefaults(node.type, node.id, node.params ?? {}, defaults)
  const miss: string[] = []
  for (const [k, r] of Object.entries(spec.params)) {
    if (!r.required) continue
    const v = eff[k]
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) miss.push(k)
  }
  if (node.type === "clip" && eff.model === undefined && !miss.includes("model")) miss.push("model")
  return miss
}

// ---------------------------------------------------------------- pin 边界（schema 显式规则；S2 强制、S18 测试）
export type PinRuleId = "type_not_pinnable" | "template_node" | "scratch" | "bad_status" | "no_outputs" | "takes_needs_take" | "freeze_all_ports"
export interface PinRule { id: PinRuleId; text: string }
export const PIN_RULES: readonly PinRule[] = [
  { id: "type_not_pinnable", text: "不可 pin 的类型：export、qc（交付出口与质检必须随产物重算）" },
  { id: "template_node", text: "forEach 模板节点本体不可 pin（实例是真节点，pin 实例）" },
  { id: "scratch", text: "scratch 草稿节点不可 pin（到期销毁）" },
  { id: "bad_status", text: "status 为 failed / blocked 的节点不可 pin" },
  { id: "no_outputs", text: "没有产物的节点不可 pin（pin 冻结的是产物）" },
  { id: "takes_needs_take", text: "takes 节点 pin 必须指定 take，且必须是当前被选中的那个（先 select_take）；非 takes 节点不接受 take" },
  { id: "freeze_all_ports", text: "pin 冻结该节点全部输出口，outputsSha 必须覆盖所有产物，不允许只钉一部分" },
]
export const UNPINNABLE_TYPES: readonly NodeType[] = NODE_TYPES.filter((t) => !NODE_SPECS[t].pinnable)

export type PinCheck =
  | { ok: true; outputsSha: string[]; take?: number }
  | { ok: false; code: "NOT_PINNABLE"; rule: PinRuleId; message: string }

/** pin 前置检查。通过则给出应写入 PinState.outputsSha 的全部输出口指纹。 */
export function checkPinnable(node: Pick<ProjectNode, "id" | "type" | "status" | "outputs" | "takes" | "forEach" | "scratch">, opts: { take?: number } = {}): PinCheck {
  const no = (rule: PinRuleId, message: string): PinCheck => ({ ok: false, code: "NOT_PINNABLE", rule, message: `${node.id} 不能 pin：${message}` })
  const spec = specOf(node.type)
  if (!spec || !spec.pinnable) return no("type_not_pinnable", `${node.type} 节点不可钉住（${spec?.pinNote ?? "未知类型"}）。要保护内容请 lock 它的参数，或改 pin 它的上游产物`)
  if (node.forEach) return no("template_node", `它是 forEach 模板节点本体；请 pin 具体实例（${node.id}#<行id>）`)
  if (node.scratch) return no("scratch", "它是 scratch 草稿节点，到期销毁；先转正式节点再 pin")
  if (node.status === "failed" || node.status === "blocked") return no("bad_status", `状态是 ${node.status}；先 project_run 让它成功`)
  if (!node.outputs || node.outputs.length === 0) return no("no_outputs", "还没有产物；先 project_run 或写入结果")
  if (node.takes) {
    if (opts.take === undefined) return no("takes_needs_take", `它是 takes 节点，必须指定 take，例：{"op":"pin","node":"${node.id}","take":1}`)
    const selected = node.outputs[0]?.take
    if (selected !== opts.take) return no("takes_needs_take", `take ${opts.take} 不是当前选中的候选（当前选中 ${selected ?? "无"}）；先 select_take 再 pin`)
  } else if (opts.take !== undefined) {
    return no("takes_needs_take", "它不是 takes 节点，不接受 take 参数")
  }
  const outputsSha = node.outputs.map((o) => o.sha256)
  if (outputsSha.some((s) => typeof s !== "string" || !SHA256_RE.test(s))) return no("freeze_all_ports", "有输出口缺少合法 sha256，无法完整冻结所有输出口")
  return { ok: true, outputsSha, ...(opts.take !== undefined ? { take: opts.take } : {}) }
}

/** 已 pin 的节点是否仍满足 pin 不变量（validate.ts 用）。返回违反的规则，空=合规。 */
export function pinInvariantViolations(node: Pick<ProjectNode, "id" | "type" | "pinned" | "outputs" | "forEach" | "scratch">): { rule: PinRuleId; message: string }[] {
  if (!node.pinned) return []
  const v: { rule: PinRuleId; message: string }[] = []
  const spec = specOf(node.type)
  if (!spec || !spec.pinnable) v.push({ rule: "type_not_pinnable", message: `${node.type} 节点不可处于 pinned 状态` })
  if (node.forEach) v.push({ rule: "template_node", message: "forEach 模板节点本体不可处于 pinned 状态" })
  if (node.scratch) v.push({ rule: "scratch", message: "scratch 节点不可处于 pinned 状态" })
  if (!node.outputs || node.outputs.length === 0) v.push({ rule: "no_outputs", message: "pinned 节点必须有产物" })
  else {
    const have = node.outputs.map((o) => o.sha256).sort().join(",")
    const pinned = [...(node.pinned.outputsSha ?? [])].sort().join(",")
    if (have !== pinned) v.push({ rule: "freeze_all_ports", message: "pinned.outputsSha 必须恰好覆盖该节点全部输出口的 sha256" })
  }
  return v
}
