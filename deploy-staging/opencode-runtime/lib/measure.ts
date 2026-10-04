// 台词量测（写作期）——纯计算、零外部呼叫、零 IO、零网路。
//
// 逐条照抄竞品 hypit 的实作；配方＝
//   packages/estimate/src/program.ts  ＋  packages/estimate/src/policy.ts
// 以下段落逐字移植（含注解）：
//   - PACE_RATE 表（program.ts:13-23）
//   - words / looksSpanish / detectSpeechEstimateLanguage（program.ts:25-45）
//   - normalizedEnglishWord / dictionarySyllables / heuristicEnglishSyllables / englishSyllables（:47-84）
//   - spanishVowelNuclei / spanishSyllables（:86-113）
//   - countSpeechEstimateUnits（:115-128）
//   - rounded（:167-171）与 estimateSpeechDuration 主公式（:173-188）
//   - policyFrom 的三条逐字讯息（policy.ts:22/24/43）与 assertSpeechEstimatePolicy 的验证条件（:136-149）
//
// 唯一外部前置（可缺席）：CMU 发音词典 `cmu-pronouncing-dictionary`。
// 缺席时英/西语音节退化为启发式，并在回传 note 与 code 对应栏位诚实标明。

import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"

export type SpeechEstimateLanguage = "auto" | "en" | "zh" | "ja" | "es"
export type ResolvedSpeechEstimateLanguage = "en" | "zh" | "ja" | "es"
export type SpeechEstimatePace = "slow" | "normal" | "fast"
export type SpeechEstimateRounding = "none" | "round" | "ceil"

/** 量测政策（policy 的落地形状；pace/rate 恰有其一）。 */
export interface MeasurePolicy {
  language: string
  pace?: string
  rate?: number
  rounding: string
  padding?: number
}

export interface MeasureResult {
  ok: boolean
  duration_sec?: number
  units?: number
  units_per_sec?: number
  language?: string
  policy?: MeasurePolicy
  note?: string
  code?: string
  reason?: string
}

export interface MeasureOptions {
  language?: string
  pace?: "slow" | "normal" | "fast"
  rate?: number
  rounding?: "none" | "round" | "ceil"
  padding?: number
  /** 验证讯息的主体名称（对应 hypit policyFrom 的 subject）；预设 "measure policy"。 */
  subject?: string
}

const DEFAULT_SUBJECT = "measure policy"

// ─────────────────────────────────────────── PACE_RATE（program.ts:13-23，逐字含注解）

const PACE_RATE: Readonly<
  Record<ResolvedSpeechEstimateLanguage, Readonly<Record<SpeechEstimatePace, number>>>
> = {
  // Authoring delivery densities, including ordinary pauses, not measured model
  // guarantees or pause-free articulation rates. See README for units and rationale.
  en: { slow: 4.2, normal: 4.6, fast: 5.6 },
  zh: { slow: 4.2, normal: 5.25, fast: 6.5625 },
  ja: { slow: 6, normal: 7.5, fast: 9.375 },
  es: { slow: 4.72, normal: 5.9, fast: 7.375 },
}

// ─────────────────────────────────────────── 分词与语言侦测（program.ts:25-45，逐字）

function words(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+(?:['’\-‐‑–][\p{L}\p{N}]+)*/gu) ?? []
}

function looksSpanish(text: string): boolean {
  if (/[ñáéíóúü¿¡]/iu.test(text)) return true
  const tokens = words(text).map((word) => word.toLowerCase())
  if (tokens.length === 0) return false
  const hits = tokens.filter((word) =>
    /^(?:que|de|la|el|los|las|un|una|para|por|con|sin|pero|porque|como|más|muy|este|esta|eso|soy|eres|es|son|estoy|está|tengo|quiero|puedo|ahora|cuando|todo|nada|aquí|así)$/u.test(
      word,
    ),
  ).length
  return hits >= Math.max(2, Math.ceil(tokens.length * 0.18))
}

export function detectSpeechEstimateLanguage(text: string): ResolvedSpeechEstimateLanguage {
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length
  const kana = (text.match(/[\u3040-\u30ff]/gu) ?? []).length
  const ascii = (text.match(/[A-Za-z]/gu) ?? []).length
  if (kana > Math.max(han, ascii / 4)) return "ja"
  if (han > ascii / 4) return "zh"
  if (looksSpanish(text)) return "es"
  return "en"
}

// ─────────────────────────────────────────── CMU 发音词典（可选；缺席退化为启发式）

const CMU_PACKAGE = "cmu-pronouncing-dictionary"

/** 解析候选根：先 tools 自己的 node_modules，再 ~/.opencode，再裸 require（相对链／NODE_PATH）。 */
const CMU_ROOTS = [
  "/opt/agent-harness/workspace/.opencode/node_modules",
  "/home/ubuntu/.opencode/node_modules",
  "/home/ubuntu/.opencode/dict/node_modules",
  join(process.cwd(), "node_modules"),
  ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(":").filter(Boolean) : []),
]

interface CmuLoad {
  dictionary: Record<string, string> | null
  source: string
}

/** 词典载入（init 时一次）。取 module 上的 `dictionary`（hypit 用法）或其 default／模组本体。 */
function readCmuDictionary(): CmuLoad {
  const requireFrom = createRequire(import.meta.url)
  const pick = (mod: unknown): Record<string, string> | null => {
    if (!mod || typeof mod !== "object") return null
    const m = mod as Record<string, unknown>
    for (const candidate of [m.dictionary, m.default, mod]) {
      if (candidate && typeof candidate === "object") return candidate as Record<string, string>
    }
    return null
  }
  for (const root of CMU_ROOTS) {
    try {
      const pkgDir = join(root, CMU_PACKAGE)
      const pkgJson = join(pkgDir, "package.json")
      if (!existsSync(pkgJson)) continue
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { main?: string; module?: string }
      const entry = pkg.module ?? pkg.main ?? "index.js"
      const dict = pick(requireFrom(join(pkgDir, entry)))
      if (dict) return { dictionary: dict, source: pkgDir }
    } catch {
      /* 换下一个候选根 */
    }
  }
  try {
    const dict = pick(requireFrom(CMU_PACKAGE))
    if (dict) return { dictionary: dict, source: CMU_PACKAGE }
  } catch {
    /* 词典缺席：走启发式 */
  }
  return { dictionary: null, source: "" }
}

const CMU = readCmuDictionary()
const HAS_CMU = CMU.dictionary !== null

/** 词典实际来源（除错／回报用；缺席为空字串）。 */
export const cmuDictionarySource = CMU.source

// ─────────────────────────────────────────── 英文音节（program.ts:47-84，逐字）

function normalizedEnglishWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/’/gu, "'")
    .replace(/[‐‑–]/gu, "-")
    .replace(/[^a-z'-]/gu, "")
}

function dictionarySyllables(word: string): number | undefined {
  if (CMU.dictionary === null) return undefined
  const pronunciation = CMU.dictionary[word]
  if (pronunciation === undefined) return undefined
  const syllables = pronunciation.split(" ").filter((phoneme) => /\d$/u.test(phoneme)).length
  return syllables > 0 ? syllables : undefined
}

function heuristicEnglishSyllables(word: string): number {
  const normalized = word.replace(/[^a-z]/gu, "")
  if (!normalized) return 0
  if (normalized.length <= 3) return 1
  const stripped = normalized.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/u, "").replace(/^y/u, "")
  return Math.max(1, stripped.match(/[aeiouy]{1,2}/gu)?.length ?? 1)
}

export function englishSyllables(word: string): number {
  const normalized = normalizedEnglishWord(word)
  if (!normalized) return 0
  const direct = dictionarySyllables(normalized)
  if (direct !== undefined) return direct
  if (normalized.includes("-")) {
    return normalized
      .split("-")
      .filter(Boolean)
      .reduce((sum, part) => sum + (dictionarySyllables(part) ?? heuristicEnglishSyllables(part)), 0)
  }
  return heuristicEnglishSyllables(normalized)
}

// ─────────────────────────────────────────── 西语音节（program.ts:86-113，逐字）

function spanishVowelNuclei(run: string): number {
  let nuclei = 0
  let pending = ""
  const flush = () => {
    if (!pending) return
    nuclei += Math.max(1, pending.match(/[aeoáéó]/gu)?.length ?? 0)
    pending = ""
  }
  for (const character of run) {
    if (character === "í" || character === "ú") {
      flush()
      nuclei += 1
    } else {
      pending += character
    }
  }
  flush()
  return nuclei
}

export function spanishSyllables(word: string): number {
  let normalized = word
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^a-záéíóúüñ]/gu, "")
  if (!normalized) return 0
  if (normalized === "y") normalized = "i"
  else normalized = normalized.replace(/y$/u, "i")
  const runs = normalized.match(/[aeiouáéíóúü]+/gu) ?? []
  return Math.max(1, runs.reduce((sum, run) => sum + spanishVowelNuclei(run), 0))
}

// ─────────────────────────────────────────── 单位计数（program.ts:115-128，逐字）

export function countSpeechEstimateUnits(text: string, language: string): number {
  if (language === "zh" || language === "ja") {
    const characters = /[\p{Script=Han}\u3040-\u30ff]/gu
    const cjk = (text.match(characters) ?? []).length
    const latin = words(text.replace(characters, " ")).filter((word) => /[A-Za-z]/u.test(word))
    return cjk + latin.reduce((sum, word) => sum + englishSyllables(word), 0)
  }
  if (language === "es") return words(text).reduce((sum, word) => sum + spanishSyllables(word), 0)
  return words(text).reduce((sum, word) => sum + englishSyllables(word), 0)
}

// ─────────────────────────────────────────── 取整（program.ts:167-171，逐字）

function rounded(value: number, mode: SpeechEstimateRounding): number {
  if (mode === "ceil") return Math.ceil(value)
  if (mode === "round") return Math.round(value)
  return value
}

function buildNote(args: {
  units: number
  rate: number
  padding: number
  rounding: string
  raw: number
  durationSec: number
}): string {
  const dictLine = HAS_CMU
    ? `音节判定：英/西语音节先查 CMU 发音词典（命中为词典值，未命中为启发式估算）；词典来源 ${cmuDictionarySource}`
    : "音节判定：CMU 发音词典缺席，英/西语音节一律走启发式估算（非词典值）；如需词典值请安装 cmu-pronouncing-dictionary"
  return [
    `${args.units} units ÷ ${args.rate} per sec` +
      (args.padding ? ` + ${args.padding}s padding` : "") +
      ` = ${args.raw}s → rounding=${args.rounding} → ${args.durationSec}s`,
    dictLine,
    "中/日：逐字（Han＋假名，即 Script=Han 与 U+3040-U+30FF 码点），夹杂英文按逐词音节加计",
    "PACE_RATE 为作者交付密度（含一般停顿），非模型保证值、非无停顿咬字速率（hypit README：Neither table is a calibration of a particular video or voice model）",
    "预设照抄 hypit 表（zh normal 5.25 字/秒）；要对齐我方短剧散文口径（4.5 字/秒，src/lib/workflow-pages/shortdrama-visual-assets.ts:29）请传 rate: 4.5",
  ].join("｜")
}

// ─────────────────────────────────────────── 主函式
// 对应 hypit estimateSpeechDuration（program.ts:173-188）＋ policyFrom（policy.ts:16-53）。
// 所有验证失败一律回 ok:false ＋ 诚实 code/reason，不静默回 0、不臆造速率。

export function measureScript(text: string, opts: MeasureOptions = {}): MeasureResult {
  const subject = opts.subject ?? DEFAULT_SUBJECT
  // 逐字照抄 hypit policyFrom：属性整包进来，未知键必须被看见（否则 unknown 检查形同虚设）。
  // `subject` 是本档内部栏位，不属 policy 属性。
  const properties: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(opts)) {
    if (name === "subject" || value === undefined) continue
    properties[name] = value
  }

  const reject = (code: string, reason: string, policy?: MeasurePolicy, unitsPerSec?: number): MeasureResult => ({
    ok: false,
    policy,
    note: reason,
    code,
    reason,
    ...(unitsPerSec !== undefined ? { units_per_sec: unitsPerSec } : {}),
  })

  // policyFrom（policy.ts:20-24）：unknown property → requires language, rounding（逐字讯息）
  const allowed = new Set(["language", "pace", "rate", "rounding", "padding"])
  const unknown = Object.keys(properties).filter((name) => !allowed.has(name))
  if (unknown.length > 0) {
    return reject("measure_invalid_policy", `${subject} contains unknown property ${unknown[0]}`)
  }
  const missing = ["language", "rounding"].filter((name) => properties[name] === undefined)
  if (missing.length > 0) {
    return reject("measure_invalid_policy", `${subject} requires ${missing.join(", ")}`)
  }

  const languageRaw = properties.language
  const roundingRaw = properties.rounding
  if (typeof languageRaw !== "string" || languageRaw.trim().length === 0) {
    return reject("measure_invalid_policy", `${subject}.language must be a non-empty string`)
  }
  if (typeof roundingRaw !== "string" || roundingRaw.trim().length === 0) {
    return reject("measure_invalid_policy", `${subject}.rounding must be a non-empty string`)
  }
  const language = languageRaw.trim()
  const rounding = roundingRaw.trim()

  // policyFrom（policy.ts:40-44）：pace 与 rate 恰有其一（逐字讯息）
  const hasPace = properties.pace !== undefined
  const hasRate = properties.rate !== undefined
  if (hasPace === hasRate) {
    return reject("measure_invalid_policy", `${subject} requires exactly one of pace or rate`)
  }

  // assertSpeechEstimatePolicy（program.ts:136-149）的值域条件
  if (!["auto", "en", "zh", "ja", "es"].includes(language)) {
    return reject("measure_invalid_policy", `${subject}.language must be one of auto, en, zh, ja, es`)
  }
  if (hasPace && !["slow", "normal", "fast"].includes(String(properties.pace))) {
    return reject("measure_invalid_policy", `${subject}.pace must be one of slow, normal, fast`)
  }
  if (
    hasRate &&
    (typeof properties.rate !== "number" || !Number.isFinite(properties.rate) || properties.rate <= 0)
  ) {
    return reject("measure_invalid_policy", `${subject}.rate must be a positive finite number`)
  }
  if (!["none", "round", "ceil"].includes(rounding)) {
    return reject("measure_invalid_policy", `${subject}.rounding must be one of none, round, ceil`)
  }
  if (
    properties.padding !== undefined &&
    (typeof properties.padding !== "number" || !Number.isFinite(properties.padding) || properties.padding < 0)
  ) {
    return reject("measure_invalid_policy", `${subject}.padding must be a finite number >= 0`)
  }

  const policy: MeasurePolicy = {
    language,
    rounding,
    ...(hasPace ? { pace: String(properties.pace) } : {}),
    ...(hasRate ? { rate: properties.rate as number } : {}),
    ...(properties.padding !== undefined ? { padding: properties.padding as number } : {}),
  }

  // assertSpeechText（program.ts:159-165，逐字讯息）
  const value = typeof text === "string" ? text : ""
  if (value.trim().length === 0) {
    return reject("measure_empty_text", "Speech Text is invalid", policy)
  }

  const resolved: ResolvedSpeechEstimateLanguage =
    language === "auto"
      ? detectSpeechEstimateLanguage(value)
      : (language as ResolvedSpeechEstimateLanguage)

  // countSpeechEstimateUnits ＋ 主公式（program.ts:180-184，逐字讯息）
  const units = countSpeechEstimateUnits(value, resolved)
  if (units < 1) {
    return reject("measure_no_units", "Speech Text contains no countable speech units", policy)
  }

  const rate = policy.rate ?? PACE_RATE[resolved][policy.pace as SpeechEstimatePace]
  const raw = units / rate + (policy.padding ?? 0)
  const durationSec = rounded(raw, rounding as SpeechEstimateRounding)
  if (durationSec === 0) {
    return reject(
      "measure_rounds_to_zero",
      "Speech estimate rounds to zero seconds; use rounding none or ceil.",
      policy,
      rate,
    )
  }

  return {
    ok: true,
    duration_sec: durationSec,
    units,
    units_per_sec: rate,
    language: resolved,
    policy,
    note: buildNote({
      units,
      rate,
      padding: policy.padding ?? 0,
      rounding,
      raw,
      durationSec,
    }),
  }
}
