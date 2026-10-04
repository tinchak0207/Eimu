// 结构化影片 prompt：Shot JSON schema + 验证 + 按模型族编译。
//
// agent 填 JSON（metadata.shot 或 text 节点 content），gateway 编译成各模型最爱吃的
// prompt 字串（平台 /v1/videos/generations 只收 prompt ≤4000 字 + duration_seconds +
// size + model）。
//
// Schema（全部可选除 subject/action，一律英文键、内容中英皆可）：
//   subject        主体（必填）
//   action         按 beat 的动作描述（必填；动作用具体计数，不用模糊形容词）
//   appearance     外观/服装
//   environment    { time_of_day, lighting, elements[] }
//   camera         { shot_type, angle, movement, lens }
//   style          { look, mood, color_grading }
//   audio          { dialogue: [{ character, tone, line }], ambience, sfx[] }
//   output         { duration_seconds, aspect_ratio }
//   negative       忽略不编译——平台无 negative_prompt 栏位，否定句反而伤害生成
//
// 模型族编译策略（依 model 字串前缀分族）：
//   veo*     紧凑单行 JSON（Veo 3.1 官方 JSON prompting，只留非空字段，不加说明文字）
//   kling*   Cinematic 开头 + 主体句 + 「Beat 0-Ns: camera + action」时间轴模板
//            + `Dialogue (角色, 语气): "台词"` 对话行 + Audio 行
//   runway*  首行精确 camera token（Camera dolly in / Truck left / Boom up…），
//            主体动作句，尾部 shot_type/lens
//   luma*    摄影机运动自然语言短语打头（模型有 camera motion 词表）
//   其余     seedance / adobe / 未知模型：SLCT 有序散文
//            （Style → Shot type → Camera → 主体动作 → 环境 → 光 → 时长 hint）
//
// 通用规则：一镜一机位运动 + 一主体动作；各族 front-load（camera+subject 在前）；
// duration 编进 prompt 尾部 hint；输出守卫 ≤3800 字——超长先砍 style.color_grading
// → environment.elements → audio.sfx，再截断 action。
//
// 纯函数、零依赖、可单测。

export interface ShotJson {
  subject: string
  appearance?: string
  action: string
  environment?: { time_of_day?: string; lighting?: string; elements?: string[] }
  camera?: { shot_type?: string; angle?: string; movement?: string; lens?: string }
  style?: { look?: string; mood?: string; color_grading?: string }
  audio?: {
    dialogue?: { character: string; tone?: string; line: string }[]
    ambience?: string
    sfx?: string[]
  }
  output?: { duration_seconds?: number; aspect_ratio?: string }
  negative?: string[]
}

const MAX_PROMPT_LENGTH = 3800

/** 非空字串规整：去头尾空白；空/非字串回 undefined。 */
function nonEmpty(s: unknown): string | undefined {
  return typeof s === "string" && s.trim() ? s.trim() : undefined
}

/** 字串阵列规整：滤掉非字串与空白项。 */
function cleanList(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return list.filter((x): x is string => typeof x === "string" && !!x.trim())
}

/**
 * 从任意候选值解析 shot JSON：接受物件或 JSON 字串。
 * 不是 shot JSON（无法解析、缺 subject 或 action）回 null，不抛错。
 */
export function parseShotCandidate(raw: unknown): ShotJson | null {
  let obj: unknown = raw
  if (typeof raw === "string") {
    const text = raw.trim()
    if (!text.startsWith("{")) return null
    try {
      obj = JSON.parse(text)
    } catch {
      return null
    }
  }
  if (typeof obj !== "object" || obj === null) return null
  const o = obj as Record<string, unknown>
  if (!nonEmpty(o.subject) || !nonEmpty(o.action)) return null
  return obj as ShotJson
}

const SHOT_EXAMPLE = '{ "subject": "穿风衣的侦探", "action": "推开门走三步后回头看向镜头", "camera": { "movement": "dolly in" }, "style": { "look": "电影感" }, "output": { "duration_seconds": 15 } }'

/**
 * 验证 shot JSON：缺 subject/action 给可操作错误（中文，指明缺哪个字段 + 一行示例）。
 * 接受物件或 JSON 字串（字串先解析）。
 */
export function validateShotJson(obj: unknown): { ok: true; shot: ShotJson } | { ok: false; error: string } {
  const shot = parseShotCandidate(obj)
  if (shot) {
    // INC-0830：output.duration_seconds 必填——缺了会落进平台 5 秒静默兜底，
    // 而 seedance 上游按条统一计费（5s/15s 同价），短出片=白烧额度（事故根因之二）。
    const d = shot.output?.duration_seconds
    if (typeof d !== "number" || !Number.isFinite(d) || d < 1) {
      return { ok: false, error: `缺少 output.duration_seconds（数字，单位秒，≥1）——不填会被按 5 秒短片生成。示例：${SHOT_EXAMPLE}` }
    }
    return { ok: true, shot }
  }
  if (typeof obj === "string") {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(obj.trim())
    } catch {
      // fallthrough 到统一错误
    }
    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, error: `shot 内容不是有效的 JSON 物件（字串必须是完整 JSON 且以 { 开头）。示例：${SHOT_EXAMPLE}` }
    }
    return validateShotJson(parsed)
  }
  if (typeof obj !== "object" || obj === null) {
    return { ok: false, error: `shot 必须是 JSON 物件。示例：${SHOT_EXAMPLE}` }
  }
  const o = obj as Record<string, unknown>
  const missing: string[] = []
  if (!nonEmpty(o.subject)) missing.push("subject（主体）")
  if (!nonEmpty(o.action)) missing.push("action（按 beat 的动作描述）")
  return { ok: false, error: `缺少必要字段：${missing.join("、")}。示例：${SHOT_EXAMPLE}` }
}

/** shot 的输出参数：duration clamp 1-60（取整）；aspect_ratio 原样（去空白）。 */
export function shotOutputParams(shot: ShotJson): { duration_seconds?: number; aspect_ratio?: string } {
  const out: { duration_seconds?: number; aspect_ratio?: string } = {}
  const d = shot.output?.duration_seconds
  if (typeof d === "number" && Number.isFinite(d)) {
    out.duration_seconds = Math.min(60, Math.max(1, Math.round(d)))
  }
  const ar = nonEmpty(shot.output?.aspect_ratio)
  if (ar) out.aspect_ratio = ar
  return out
}

// ── 共用片段 ──

function durationOf(shot: ShotJson): number | undefined {
  return shotOutputParams(shot).duration_seconds
}

function subjectPhrase(shot: ShotJson): string {
  const subject = nonEmpty(shot.subject) ?? ""
  const appearance = nonEmpty(shot.appearance)
  return appearance ? `${subject}, ${appearance}` : subject
}

function envPhrase(shot: ShotJson): string {
  const e = shot.environment
  if (!e) return ""
  return [nonEmpty(e.time_of_day), ...cleanList(e.elements)].filter(Boolean).join(", ")
}

// ── 各模型族编译器 ──

/** veo：紧凑单行 JSON，只留非空字段，前面不加任何说明文字。 */
function compileVeo(shot: ShotJson): string {
  const compact: Record<string, unknown> = {}
  compact.subject = nonEmpty(shot.subject) ?? ""
  const appearance = nonEmpty(shot.appearance)
  if (appearance) compact.appearance = appearance
  compact.action = nonEmpty(shot.action) ?? ""
  const env: Record<string, unknown> = {}
  const timeOfDay = nonEmpty(shot.environment?.time_of_day)
  if (timeOfDay) env.time_of_day = timeOfDay
  const elements = cleanList(shot.environment?.elements)
  if (elements.length) env.elements = elements
  const lighting = nonEmpty(shot.environment?.lighting)
  if (lighting) env.lighting = lighting
  if (Object.keys(env).length) compact.environment = env
  const camera: Record<string, unknown> = {}
  for (const key of ["shot_type", "angle", "movement", "lens"] as const) {
    const value = nonEmpty(shot.camera?.[key])
    if (value) camera[key] = value
  }
  if (Object.keys(camera).length) compact.camera = camera
  const style: Record<string, unknown> = {}
  for (const key of ["look", "mood", "color_grading"] as const) {
    const value = nonEmpty(shot.style?.[key])
    if (value) style[key] = value
  }
  if (Object.keys(style).length) compact.style = style
  const audio: Record<string, unknown> = {}
  const dialogue = (Array.isArray(shot.audio?.dialogue) ? shot.audio!.dialogue! : [])
    .map((d) => ({ character: nonEmpty(d?.character), tone: nonEmpty(d?.tone), line: nonEmpty(d?.line) }))
    .filter((d) => d.character && d.line)
  if (dialogue.length) audio.dialogue = dialogue
  const ambience = nonEmpty(shot.audio?.ambience)
  if (ambience) audio.ambience = ambience
  const sfx = cleanList(shot.audio?.sfx)
  if (sfx.length) audio.sfx = sfx
  if (Object.keys(audio).length) compact.audio = audio
  const output: Record<string, unknown> = {}
  const params = shotOutputParams(shot)
  if (params.duration_seconds !== undefined) output.duration_seconds = params.duration_seconds
  if (params.aspect_ratio) output.aspect_ratio = params.aspect_ratio
  if (Object.keys(output).length) compact.output = output
  return JSON.stringify(compact)
}

/** kling：Cinematic 开头 + 主体句 + Beat 时间轴 + Dialogue 行 + Audio 行。 */
function compileKling(shot: ShotJson): string {
  const lines: string[] = []
  const ar = shotOutputParams(shot).aspect_ratio ?? "16:9"
  const look = nonEmpty(shot.style?.look)
  lines.push(look ? `Cinematic ${ar}, ${look}` : `Cinematic ${ar}`)
  const subject = subjectPhrase(shot)
  if (subject) lines.push(subject)
  const duration = durationOf(shot) ?? 5
  const camera = [nonEmpty(shot.camera?.shot_type), nonEmpty(shot.camera?.angle), nonEmpty(shot.camera?.movement)].filter(Boolean).join(" ")
  const action = nonEmpty(shot.action) ?? ""
  lines.push(camera ? `Beat 0-${duration}s: ${camera} + ${action}` : `Beat 0-${duration}s: ${action}`)
  for (const d of Array.isArray(shot.audio?.dialogue) ? shot.audio!.dialogue! : []) {
    const character = nonEmpty(d?.character)
    const line = nonEmpty(d?.line)
    if (!character || !line) continue
    const tone = nonEmpty(d?.tone)
    lines.push(`Dialogue (${tone ? `${character}, ${tone}` : character}): "${line}"`)
  }
  const ambience = nonEmpty(shot.audio?.ambience)
  if (ambience) lines.push(`Audio: ${ambience}`)
  return lines.filter(Boolean).join("\n")
}

/** runway：首行精确 camera token，主体动作句，尾部 shot_type/lens + 时长 hint。 */
function compileRunway(shot: ShotJson): string {
  const lines: string[] = []
  const movement = nonEmpty(shot.camera?.movement)
  if (movement) lines.push(`Camera ${movement}`)
  const actionSentence = `${subjectPhrase(shot)} ${nonEmpty(shot.action) ?? ""}`.trim()
  if (actionSentence) lines.push(`${actionSentence}.`)
  const tail = [nonEmpty(shot.camera?.shot_type), nonEmpty(shot.camera?.lens)].filter(Boolean).join(", ")
  const duration = durationOf(shot)
  const hint = duration !== undefined ? `${duration}s` : ""
  const lastLine = [tail, hint].filter(Boolean).join(". ")
  if (lastLine) lines.push(lastLine)
  return lines.join("\n")
}

/** luma：摄影机运动自然语言短语打头，接主体/动作/环境/光线。 */
function compileLuma(shot: ShotJson): string {
  const movement = nonEmpty(shot.camera?.movement)
  const subject = subjectPhrase(shot)
  const segs: string[] = []
  if (movement && subject) segs.push(`${movement} on ${subject}`)
  else if (movement) segs.push(movement)
  else if (subject) segs.push(subject)
  const action = nonEmpty(shot.action)
  if (action) segs.push(action)
  const env = envPhrase(shot)
  if (env) segs.push(env)
  const lighting = nonEmpty(shot.environment?.lighting)
  if (lighting) segs.push(lighting)
  const duration = durationOf(shot)
  if (duration !== undefined) segs.push(`${duration}s`)
  if (!segs.length) return ""
  const text = segs.join(". ") + "."
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** seedance / adobe / 未知模型：SLCT 有序散文。 */
function compileDefault(shot: ShotJson): string {
  const segs: string[] = []
  const styleHead = [nonEmpty(shot.style?.look), nonEmpty(shot.style?.mood)].filter(Boolean).join(", ")
  if (styleHead) segs.push(styleHead)
  const framing = [nonEmpty(shot.camera?.shot_type), nonEmpty(shot.camera?.angle)].filter(Boolean).join(" ")
  if (framing) segs.push(framing)
  const movement = nonEmpty(shot.camera?.movement)
  if (movement) segs.push(movement)
  const actionSentence = `${subjectPhrase(shot)} ${nonEmpty(shot.action) ?? ""}`.trim()
  if (actionSentence) segs.push(actionSentence)
  const env = envPhrase(shot)
  if (env) segs.push(env)
  const lighting = [nonEmpty(shot.environment?.lighting), nonEmpty(shot.style?.color_grading)].filter(Boolean).join(", ")
  if (lighting) segs.push(lighting)
  const duration = durationOf(shot)
  if (duration !== undefined) segs.push(`${duration}s`)
  if (!segs.length) return ""
  return segs.join(". ") + "."
}

// ── 长度守卫 ──

interface CompileDrops {
  grading: boolean
  elements: boolean
  sfx: boolean
}

function dropFields(shot: ShotJson, drops: CompileDrops): ShotJson {
  const s: ShotJson = { ...shot }
  if (drops.grading && nonEmpty(s.style?.color_grading)) s.style = { ...s.style, color_grading: undefined }
  if (drops.elements && cleanList(s.environment?.elements).length) s.environment = { ...s.environment, elements: undefined }
  if (drops.sfx && cleanList(s.audio?.sfx).length) s.audio = { ...s.audio, sfx: undefined }
  return s
}

/**
 * 编译 shot JSON 成指定模型的 prompt 字串。
 * 长度守卫 ≤3800 字：先依序砍 color_grading → elements → sfx，仍超长再截断 action。
 */
export function compileShotPrompt(shot: ShotJson, model: string): string {
  const build = (s: ShotJson): string => {
    const m = String(model ?? "").toLowerCase()
    if (m.startsWith("veo")) return compileVeo(s)
    if (m.startsWith("kling")) return compileKling(s)
    if (m.startsWith("runway")) return compileRunway(s)
    if (m.startsWith("luma")) return compileLuma(s)
    return compileDefault(s)
  }
  let out = build(shot)
  let drops: CompileDrops = { grading: false, elements: false, sfx: false }
  if (out.length > MAX_PROMPT_LENGTH) {
    const stages: CompileDrops[] = [
      { grading: true, elements: false, sfx: false },
      { grading: true, elements: true, sfx: false },
      { grading: true, elements: true, sfx: true },
    ]
    for (const stage of stages) {
      drops = stage
      out = build(dropFields(shot, stage))
      if (out.length <= MAX_PROMPT_LENGTH) return out
    }
  }
  if (out.length > MAX_PROMPT_LENGTH) {
    const action = typeof shot.action === "string" ? shot.action : ""
    const overhead = out.length - action.length
    if (action.length > 0 && overhead < MAX_PROMPT_LENGTH) {
      out = build(dropFields({ ...shot, action: action.slice(0, MAX_PROMPT_LENGTH - overhead) }, drops))
    }
    if (out.length > MAX_PROMPT_LENGTH) out = out.slice(0, MAX_PROMPT_LENGTH)
  }
  return out
}
