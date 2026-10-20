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
//   beats          [{ at_seconds?, action, environment_change? }] 时间顺序的动作 beat
//   state_change   { from, to } 镜头起态 → 终态（显式状态变化）
//   environment_change  整镜的环境变化（非单 beat 的部分）
//   previz         { motion_ref?, keyframes?[] } 预演参考（不直接编译进 prompt）
//   environment    { time_of_day, lighting, elements[] }
//   camera         { shot_type, angle, movement, lens, start, end, trajectory, timing, parallax, keyframes:[{time_seconds,position}] }
//   style          { look, mood, color_grading }
//   audio          { dialogue: [{ character, tone, line }], ambience, sfx[], soundscape?, music? }
//   output         { duration_seconds, aspect_ratio }
//   negative       忽略不编译——平台无 negative_prompt 栏位，否定句反而伤害生成
//
// 影片镜头契约（2026-10-20 范式改革）：一个镜头必须有可观察的状态变化——
// 至少一个非空 beats[].action，或 state_change.from 与 state_change.to 都非空。
// 只写「一张静态画面 + 六槽描述」会被 validateMotionContract 拒收：模型只会做出慢推/微动。
//
// 编译策略：所有模型族先由 compileMotionTimeline 生成时间线（起态 → 逐 beat → 终态 →
// 环境变化 → 自然语言机位），再按模型族包一层语法：
//   minimax/h3  官方三栏（首行参考图对齐指令 + integrated_multimodal_description +
//               overall_soundscape + non_diegetic_music）
//   veo*        紧凑单行 JSON（action 字段即时间线，保留 camera/output）
//   kling*      Cinematic 开头 + 主体句 + 时间线（原 Beat 0-Ns 段落）+ Dialogue/Audio
//   runway* / luma* / 其余（seedance/adobe/未知）：时间线 + 模型语法尾（时长）
//
// 通用规则：不编造未提供的动作/位置；字段缺失就跳过。输出守卫 ≤3800 字，超长明确拒绝，
// 不截断动作或运动轨迹。
//
// 纯函数、零依赖、可单测。

export interface ShotCamera {
  shot_type?: string
  angle?: string
  movement?: string
  lens?: string
  start?: string
  end?: string
  trajectory?: string
  timing?: string
  parallax?: string
  keyframes?: { time_seconds: number; position: string }[]
}

/** 一个动作 beat：at_seconds 可选（无时点按出现顺序叙述），action 必填才计入契约。 */
export interface ShotBeat {
  at_seconds?: number
  action: string
  environment_change?: string
}

/** 镜头起态 → 终态；两端都非空才算满足镜头运动契约。 */
export interface ShotStateChange {
  from?: string
  to?: string
}

export interface ShotAudio {
  dialogue?: { character: string; tone?: string; line: string }[]
  ambience?: string
  sfx?: string[]
  soundscape?: string
  music?: string
}

const CAMERA_ALIASES: Record<string, keyof ShotCamera> = {
  cameraTrajectory: "trajectory", camera_trajectory: "trajectory",
  cameraStart: "start", camera_start: "start", startPosition: "start", start_position: "start",
  cameraEnd: "end", camera_end: "end", endPosition: "end", end_position: "end",
  cameraKeyframes: "keyframes", camera_keyframes: "keyframes",
}

/** Shared camera contract: reject unsupported data instead of silently losing motion. */
export function normalizeShotCamera(input: Record<string, unknown>, duration?: number): ShotCamera | undefined {
  const raw = input.camera !== undefined ? input.camera : input.cam
  if (input.camera !== undefined && input.cam !== undefined) throw new Error("camera 与 cam 不可同时提供")
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
    if (typeof raw !== "string" || !raw.trim()) throw new Error("camera/cam 必须是对象或非空运动描述")
  }
  const camera: Record<string, unknown> = typeof raw === "string" ? { movement: raw } : { ...(raw as Record<string, unknown> ?? {}) }
  for (const key of ["trajectory", "keyframes", "start", "end", "timing", "parallax"] as const) {
    if (input[key] !== undefined) {
      if (camera[key] !== undefined) throw new Error(`camera.${key} 与独立 ${key} 重复，请明确唯一值`)
      camera[key] = input[key]
    }
  }
  for (const [alias, key] of Object.entries(CAMERA_ALIASES)) {
    for (const source of [input, camera]) {
      if (source[alias] === undefined) continue
      if (camera[key] !== undefined) throw new Error(`${alias} 与 camera.${key} 重复，请明确唯一值`)
      camera[key] = source[alias]
    }
    delete camera[alias]
  }
  const fields = ["shot_type", "angle", "movement", "lens", "start", "end", "trajectory", "timing", "parallax", "keyframes"]
  for (const [key, value] of Object.entries(camera)) {
    if (!fields.includes(key)) throw new Error(`不支持 camera.${key}，请按已公布的运镜结构填写`)
    if (key !== "keyframes" && (typeof value !== "string" || !value.trim())) throw new Error(`camera.${key} 必须是非空字符串`)
  }
  if (camera.keyframes !== undefined) {
    if (!Array.isArray(camera.keyframes) || !camera.keyframes.length) throw new Error("camera.keyframes 必须是非空数组 [{time_seconds,position}]")
    let previous = -1
    for (const frame of camera.keyframes) {
      if (!frame || typeof frame !== "object" || Array.isArray(frame) || Object.keys(frame).some(k => !["time_seconds", "position"].includes(k))) throw new Error("camera.keyframes 每项只接受 time_seconds 与 position")
      const time = frame.time_seconds
      if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time <= previous || (duration !== undefined && time > duration) || typeof frame.position !== "string" || !frame.position.trim()) throw new Error("camera.keyframes 时间必须递增且位于镜头时长内，position 必须非空")
      previous = time
    }
  }
  return Object.keys(camera).length ? camera as ShotCamera : undefined
}

function cameraMotionText(camera?: ShotCamera): string {
  if (!camera) return ""
  const parts: string[] = []
  if (camera.movement) parts.push(`Camera movement: ${camera.movement}`)
  for (const key of ["start", "end", "trajectory", "timing", "parallax"] as const) {
    if (camera[key]) parts.push(`Camera ${key}: ${camera[key]}`)
  }
  for (const frame of camera.keyframes ?? []) parts.push(`At ${frame.time_seconds}s camera position: ${frame.position}`)
  const movement = camera.movement ?? ""
  if (/dolly|push in|pull out|truck|tracking|arc|推镜|拉镜|移镜|跟拍/i.test(movement)) {
    parts.push("The camera body moves continuously through the scene; perspective and foreground/background parallax evolve along the stated path, rather than enlarging a still image. Preserve continuity from the first frames through the whole shot.")
  } else if (/zoom|变焦/i.test(movement)) {
    parts.push("Optical zoom changes focal length with the camera body stationary; do not substitute a physical dolly move.")
  }
  return parts.join(". ")
}

export interface ShotJson {
  subject: string
  appearance?: string
  action: string
  beats?: ShotBeat[]
  state_change?: ShotStateChange
  environment_change?: string
  previz?: { motion_ref?: string; keyframes?: string[] }
  environment?: { time_of_day?: string; lighting?: string; elements?: string[] }
  camera?: ShotCamera
  style?: { look?: string; mood?: string; color_grading?: string }
  audio?: ShotAudio
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
    try {
      const camera = normalizeShotCamera(shot as unknown as Record<string, unknown>, d)
      const canonical = { ...shot } as unknown as Record<string, unknown>
      for (const key of ["cam", "trajectory", "keyframes", "start", "end", "timing", "parallax", ...Object.keys(CAMERA_ALIASES)]) delete canonical[key]
      return { ok: true, shot: { ...canonical, camera } as unknown as ShotJson }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
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

/**
 * 影片镜头运动契约（硬闸）：镜头必须有可观察的状态变化。
 * 满足任一即可：≥1 个非空 beats[].action；或 state_change.from 与 state_change.to 都非空。
 * 静态六槽（style/shot/camera/subject action/environment/时长）不算影片镜头。
 */
export function validateMotionContract(shot: ShotJson): { ok: true } | { ok: false; error: string } {
  const beats = Array.isArray(shot.beats) ? shot.beats : []
  const hasBeat = beats.some((beat) => Boolean(nonEmpty(beat?.action)))
  const from = nonEmpty(shot.state_change?.from)
  const to = nonEmpty(shot.state_change?.to)
  if (hasBeat || (from && to)) return { ok: true }
  return {
    ok: false,
    error: "影片镜头缺少状态变化：请提供 beats:[{at_seconds?,action,environment_change?}] 或 state_change:{from,to}。只写一张静态画面＋六槽描述不算影片镜头，模型只会做出慢推/微动。",
  }
}

/**
 * 散文 prompt 的动作兜底：当调用方没有 beats/state_change、也不是结构化 shot JSON 时，
 * 平台侧仍必须拿到一条物理变化合同，否则 H3 会把「slow camera push in」当成整条片子的内容。
 * 与站点 src/lib/invisible-prompt-director.ts 的 MOTION_CONTRACT 同义，保持两份一致。
 */
export const VIDEO_MOTION_FALLBACK =
  "Continuous physical action drives the shot: the subject's position, pose, and silhouette change measurably from the first frame to the last, with at least one change in the environment or staging along the way. The camera move follows that change instead of replacing it."

/** prompt 已自带状态变化语义时不再追加兜底（与站点规则层同一组标记）。 */
export function hasMotionContract(text: string): boolean {
  return /(state change|action beat|visibly changed|measurably|by the final frame)/i.test(text)
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

// ── 时间线编译器共用片段 ──

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

/** 去掉句尾标点，统一由编译器补英文句点。 */
function stripEndPunctuation(text: string): string {
  return text.replace(/[\s。．.！!？?；;，,]+$/u, "")
}

/** 按中英文句末标点切句；保护小数（3.5）不被切开。 */
function splitSentences(text: string): string[] {
  const body = text.trim()
  if (!body) return []
  const out: string[] = []
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    const isCjk = "。！？；".includes(ch)
    const isAscii = "!?;".includes(ch) || (ch === "." && !(/\d/.test(body[i - 1] ?? "") && /\d/.test(body[i + 1] ?? "")))
    if (!isCjk && !isAscii) continue
    let end = i + 1
    while (end < body.length && /[\s"'”’）)]/.test(body[end])) end++
    const sentence = stripEndPunctuation(body.slice(start, end).trim())
    if (sentence) out.push(sentence)
    start = end
    i = end - 1
  }
  const tail = stripEndPunctuation(body.slice(start).trim())
  if (tail) out.push(tail)
  return out
}

/** beat 时点 → mm:ss.SSS（例：1.2 → 00:01.200）。 */
function formatBeatTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000))
  const mins = Math.floor(totalMs / 60000)
  const secs = Math.floor((totalMs % 60000) / 1000)
  const ms = totalMs % 1000
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`
}

function capitalize(text: string): string {
  return /^[a-z]/.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

/** 机位 → 自然句（不用 "Camera movement: ..." 标签式拼盘）。 */
function cameraTimelineSentence(camera?: ShotCamera): string {
  if (!camera) return ""
  const movement = nonEmpty(camera.movement)
  const trajectory = nonEmpty(camera.trajectory)
  const start = nonEmpty(camera.start)
  const end = nonEmpty(camera.end)
  const timing = nonEmpty(camera.timing)
  const parallax = nonEmpty(camera.parallax)
  const keyframes = (Array.isArray(camera.keyframes) ? camera.keyframes : [])
    .filter((frame) => typeof frame?.position === "string" && frame.position.trim())

  const clauses: string[] = []
  if (movement) {
    clauses.push(/^(static|fixed|locked|静止|固定)/i.test(movement) ? `The camera holds ${movement}` : `The camera moves in a ${movement}`)
  } else if (trajectory || start || end || keyframes.length) {
    clauses.push("The camera moves")
  }
  if (trajectory) clauses.push(stripEndPunctuation(trajectory))
  if (start) clauses.push(`starting ${stripEndPunctuation(start)}`)
  if (end) clauses.push(`ending ${stripEndPunctuation(end)}`)
  if (timing) clauses.push(stripEndPunctuation(timing))
  if (parallax) clauses.push(stripEndPunctuation(parallax))

  const parts: string[] = []
  if (clauses.length) {
    const [head, ...rest] = clauses
    parts.push(`${capitalize(head)}${rest.length ? `, ${rest.join(", ")}` : ""}.`)
  }
  for (const frame of keyframes) {
    const at = typeof frame.time_seconds === "number" && Number.isFinite(frame.time_seconds) ? frame.time_seconds : 0
    parts.push(`At ${formatBeatTime(at)}, the camera is at ${stripEndPunctuation(frame.position)}.`)
  }
  return parts.join(" ")
}

/**
 * 镜头时间线：风格/景别/主体锚点 → 起态 → 逐 beat（带时点）→ 终态 → 环境变化 → 机位。
 * 只叙述已提供的字段；缺失就跳过，不补假细节。
 */
export function compileMotionTimeline(shot: ShotJson): string {
  const segs: string[] = []

  // 1) 风格 / 景别 / 主体锚点
  const styleParts = [nonEmpty(shot.style?.look), nonEmpty(shot.style?.mood), nonEmpty(shot.style?.color_grading)].filter(Boolean)
  const framing = [nonEmpty(shot.camera?.shot_type), nonEmpty(shot.camera?.angle)].filter(Boolean).join(" ")
  const subject = subjectPhrase(shot)
  const anchor: string[] = []
  if (styleParts.length) anchor.push(styleParts.join(", "))
  if (framing) anchor.push(framing)
  if (subject) anchor.push(subject)
  if (anchor.length) segs.push(`${capitalize(anchor.join(", "))}.`)

  // 静态环境底子（与 environment_change 不同：这是整镜的既有场景）
  const setting: string[] = []
  const timeOfDay = nonEmpty(shot.environment?.time_of_day)
  if (timeOfDay) setting.push(timeOfDay)
  const elements = cleanList(shot.environment?.elements)
  if (elements.length) setting.push(elements.join(", "))
  const lighting = nonEmpty(shot.environment?.lighting)
  if (lighting) setting.push(lighting)
  if (setting.length) segs.push(`The scene is ${setting.join("; ")}.`)

  // 2) 起态：state_change.from 优先；否则用 action 的第一句
  const actionSentences = splitSentences(nonEmpty(shot.action) ?? "")
  const from = nonEmpty(shot.state_change?.from)
  let usedFirstAction = false
  if (from) {
    segs.push(`The shot begins with ${stripEndPunctuation(from)}.`)
  } else if (actionSentences.length) {
    segs.push(`The shot begins with ${actionSentences[0]}.`)
    usedFirstAction = true
  }

  // 3) 逐 beat（时间顺序；无时点用 Then 顺接）
  const beats = (Array.isArray(shot.beats) ? shot.beats : [])
    .map((beat) => ({
      at: typeof beat?.at_seconds === "number" && Number.isFinite(beat.at_seconds) ? Math.max(0, beat.at_seconds) : undefined,
      action: nonEmpty(beat?.action),
      environment: nonEmpty(beat?.environment_change),
    }))
    .filter((beat): beat is { at: number | undefined; action: string; environment: string | undefined } => Boolean(beat.action))
  for (const beat of beats) {
    const action = stripEndPunctuation(beat.action)
    const head = beat.at !== undefined ? `At ${formatBeatTime(beat.at)}, ${action}` : `Then, ${action}`
    segs.push(`${head}${beat.environment ? `, ${stripEndPunctuation(beat.environment)}` : ""}.`)
  }
  // 没有 beats 时，把 action 剩余句子按顺序补进时间线，避免动作信息丢失。
  if (!beats.length && actionSentences.length) {
    for (const sentence of usedFirstAction ? actionSentences.slice(1) : actionSentences) segs.push(`${sentence}.`)
  }

  // 4) 终态
  const to = nonEmpty(shot.state_change?.to)
  if (to) segs.push(`By the end of the shot, ${stripEndPunctuation(to)}.`)

  // 5) 环境变化
  const environmentChange = nonEmpty(shot.environment_change)
  if (environmentChange) segs.push(`The environment changes: ${stripEndPunctuation(environmentChange)}.`)

  // 6) 机位（自然句）
  const camera = cameraTimelineSentence(shot.camera)
  if (camera) segs.push(camera)

  return segs.join(" ")
}

// ── 各模型族编译器 ──

/** veo：紧凑单行 JSON，action 字段放时间线，保留 camera/output。 */
function compileVeo(shot: ShotJson, timeline: string): string {
  const compact: Record<string, unknown> = {}
  compact.subject = nonEmpty(shot.subject) ?? ""
  const appearance = nonEmpty(shot.appearance)
  if (appearance) compact.appearance = appearance
  compact.action = timeline
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
  for (const key of ["start", "end", "trajectory", "timing", "parallax", "keyframes"] as const) {
    if (shot.camera?.[key] !== undefined) camera[key] = shot.camera[key]
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
  const soundscape = nonEmpty(shot.audio?.soundscape)
  if (soundscape) audio.soundscape = soundscape
  const music = nonEmpty(shot.audio?.music)
  if (music) audio.music = music
  if (Object.keys(audio).length) compact.audio = audio
  const output: Record<string, unknown> = {}
  const params = shotOutputParams(shot)
  if (params.duration_seconds !== undefined) output.duration_seconds = params.duration_seconds
  if (params.aspect_ratio) output.aspect_ratio = params.aspect_ratio
  if (Object.keys(output).length) compact.output = output
  return JSON.stringify(compact)
}

/** kling：Cinematic 开头 + 主体句 + 时间线（取代原 Beat 0-Ns 静态拼接）+ Dialogue/Audio。 */
function compileKling(shot: ShotJson, timeline: string): string {
  const lines: string[] = []
  const ar = shotOutputParams(shot).aspect_ratio ?? "16:9"
  const look = nonEmpty(shot.style?.look)
  lines.push(look ? `Cinematic ${ar}, ${look}` : `Cinematic ${ar}`)
  const subject = subjectPhrase(shot)
  if (subject) lines.push(subject)
  if (timeline) lines.push(timeline)
  for (const d of Array.isArray(shot.audio?.dialogue) ? shot.audio!.dialogue! : []) {
    const character = nonEmpty(d?.character)
    const line = nonEmpty(d?.line)
    if (!character || !line) continue
    const tone = nonEmpty(d?.tone)
    lines.push(`Dialogue (${tone ? `${character}, ${tone}` : character}): "${line}"`)
  }
  const soundscape = nonEmpty(shot.audio?.soundscape)
  const ambience = nonEmpty(shot.audio?.ambience)
  const audioText = soundscape ?? [ambience, ...cleanList(shot.audio?.sfx)].filter(Boolean).join(" ")
  if (audioText) lines.push(`Audio: ${audioText}`)
  const music = nonEmpty(shot.audio?.music)
  if (music) lines.push(`Music: ${music}`)
  return lines.filter(Boolean).join("\n")
}

/** runway：时间线 + 模型语法尾（lens + 时长）。 */
function compileRunway(shot: ShotJson, timeline: string): string {
  const lines: string[] = []
  if (timeline) lines.push(timeline)
  const tail = [nonEmpty(shot.camera?.lens), nonEmpty(shot.camera?.shot_type)].filter(Boolean).join(", ")
  const duration = durationOf(shot)
  const hint = [tail, duration !== undefined ? `${duration}s` : ""].filter(Boolean).join(". ")
  if (hint) lines.push(hint)
  return lines.join("\n")
}

/** luma：自然语言时间线 + 时长。 */
function compileLuma(shot: ShotJson, timeline: string): string {
  const duration = durationOf(shot)
  return [timeline, duration !== undefined ? `${duration}s` : ""].filter(Boolean).join("\n")
}

/** seedance / adobe / 未知模型：时间线 + 时长尾。 */
function compileDefault(shot: ShotJson, timeline: string): string {
  const duration = durationOf(shot)
  return [timeline, duration !== undefined ? `${duration}s` : ""].filter(Boolean).join("\n")
}

/**
 * minimax/h3 官方三栏：首行参考图对齐指令（0 张不写）+ integrated_multimodal_description
 * + overall_soundscape + non_diegetic_music。
 */
function compileMinimax(shot: ShotJson, timeline: string, referenceImages: number): string {
  const lines: string[] = []
  const duration = durationOf(shot)
  if (referenceImages >= 2) {
    const endSize = duration !== undefined ? (Number.isInteger(duration) ? `${duration}.00` : duration.toFixed(2)) : "5.00"
    lines.push(`How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the ${endSize}-second mark of the target video.`)
    lines.push("")
  } else if (referenceImages === 1) {
    lines.push("For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.")
    lines.push("")
  }
  lines.push(`integrated_multimodal_description: [Shot 1] ${timeline}`)
  const soundscape = nonEmpty(shot.audio?.soundscape)
    ?? [nonEmpty(shot.audio?.ambience), ...cleanList(shot.audio?.sfx)].filter(Boolean).join(" ")
  lines.push(`overall_soundscape: ${soundscape || "Natural ambience and physical action sounds consistent with the scene."}`)
  lines.push(`non_diegetic_music: ${nonEmpty(shot.audio?.music) ?? "N/A"}`)
  return lines.join("\n")
}

/**
 * Compile using the existing model-family formats; never truncate motion or user action.
 * options.referenceImages：参考图数量（minimax 首行对齐指令用；0/缺省不写首行）。
 */
export function compileShotPrompt(shot: ShotJson, model: string, options?: { referenceImages?: number }): string {
  const normalized = { ...shot, camera: normalizeShotCamera(shot as unknown as Record<string, unknown>, shot.output?.duration_seconds) }
  const timeline = compileMotionTimeline(normalized)
  const beats = Array.isArray(normalized.beats) ? normalized.beats : []
  // 只有 camera 的旧兜底调用（给既有散文 prompt 追加运镜）：只回运镜自然句，不套模型族外壳。
  const cameraOnly = !nonEmpty(normalized.subject) && !nonEmpty(normalized.action)
    && !beats.some((beat) => Boolean(nonEmpty(beat?.action)))
    && !nonEmpty(normalized.state_change?.from) && !nonEmpty(normalized.state_change?.to)
  const referenceImages = Math.max(0, Math.floor(options?.referenceImages ?? 0))
  const m = String(model ?? "").toLowerCase()
  let out: string
  if (cameraOnly) out = timeline
  else if (m.startsWith("minimax")) out = compileMinimax(normalized, timeline, referenceImages)
  else if (m.startsWith("veo")) out = compileVeo(normalized, timeline)
  else if (m.startsWith("kling")) out = compileKling(normalized, timeline)
  else if (m.startsWith("runway")) out = compileRunway(normalized, timeline)
  else if (m.startsWith("luma")) out = compileLuma(normalized, timeline)
  else out = compileDefault(normalized, timeline)
  if (out.length > MAX_PROMPT_LENGTH) throw new Error(`编译后的镜头提示词共 ${out.length} 字，超过 ${MAX_PROMPT_LENGTH}；未截断、未提交，请缩短非必要描述`)
  return out
}
