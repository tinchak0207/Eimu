/**
 * music-take-entropy.ts —— 多 take 的熵决策层（纯函数、零依赖）。
 *
 * 为什么要有这层：FlowMusic 上游一次常回 2 个 clips（见 2026-10-03 安慰剂组实跑，
 * 两个 take 同标题《隐秘的折痕》、时长 179.53s / 174.62s、歌词相同）。若两个 take
 * 几乎一样，拿它们去问使用者「你更喜欢哪个」是浪费互动——使用者分不出来，问卷只会
 * 得到杂讯。这层量化「这组 take 彼此有多不一样」，低于闸门就不问，保守沿用主候选；
 * 过闸才把最相异的几个 take 端去让使用者挑。
 *
 * 多样性分数（entropyBits）＝相异度分布的香农熵 × 平均两两距离。为什么要乘「平均
 * 两两距离」这个幅度校正项：纯香农熵对整体尺度不变——只要任两 take 有非零距离，
 * k=2 恒得 1 bit，无法区分「几乎一样」与「天差地远」。分布熵负责「差异是否分散在
 * 多个 take 上」，平均距离负责「差异本身有多大」；两者相乘后，「几乎一样 → 分数趋近
 * 0」「两两最大相异 → 分数回到 log2(k)」这两个极端都成立。所以 entropyBits 不是纯
 * 香农熵（见栏位注解）。
 *
 * 两条放行闸（asked 的条件，见 buildMusicPreferenceQuestion）：
 *   ① 逐轴实质差异：任一维度上存在任两 take 的差异超过该轴门槛（见 isMaterialAxis
 *      Difference）。这条是为了「听得出来、但 metadata 几乎相同」的岔路口——例如
 *      2026-10-03 v1/v2 只有人声演唱窗口 128s vs 113.9s 之差（相对差 11%），正规化
 *      熵只有 ~0.02，永远过不了熵闸，但 14 秒的演唱差是巨大的听感差异，恰恰最该问。
 *   ② 正规化熵过闸：整组的熵高于 minNormalizedEntropy（预设 0.25）。
 *
 * 设计边界（本档刻意只做决策，不做任何 I/O）：
 *   - 只吃回执真的有的栏位（url / candidate_index / duration_seconds / title /
 *     lyrics_echo / sound_prompt）以及由 VPS 侧 video_transcribe 词级 ASR 算出的
 *     听感栏位（vocal_window_seconds / anchor_coverage / script_match_ratio）；
 *     本模组只吃数值，不自己做任何音频分析。
 *   - 纯函数：不读档、不 fetch、不读 env、不 import 任何 repo 内模组。
 *   - 接线（工具层 / gateway / UI）是下一个阶段，本档一律不碰。
 *
 * 距离模型：每个 take 抽 8 个维度逐维算 [0,1] 距离，加权平均（Σ 权重 = 19）：
 *   - duration            权重 1（缺值本身是差异讯号：只有一边有值 → 0.5）
 *   - hasLyrics           权重 1
 *   - title               权重 2
 *   - soundPrompt         权重 3（上游真的回吐的风格字串）
 *   - lyricsText          权重 2（字元 bigram Jaccard）
 *   - vocalWindowSeconds  权重 4（人声收束时间；听感最直接的岔路口）
 *   - anchorCoverage      权重 4（关键句被唱到的比例）
 *   - scriptMatchRatio    权重 2（ASR 与歌词稿的词级吻合率）
 */

/** 单一 take 的可量测特征（只准用回执真的有的栏位，禁止发明音频分析）。 */
export interface MusicTakeFeature {
  url: string
  candidateIndex: number
  durationSeconds?: number
  title?: string
  /** 上游 clips[].sound_prompt（可能没有；目前 music-flowmusic.ts 尚未解析，缺省 undefined）。 */
  soundPrompt?: string
  /** 工具回执的 lyrics_echo（无歌词为 null/undefined）。 */
  lyricsEcho?: string | null
  /**
   * 人声收束时间（秒）：由 VPS 侧 video_transcribe 词级 ASR 算出「最后一个唱词时间」。
   * 本模组只吃数值。2026-10-03 v1/v2 的真正差别（128s vs 113.9s）就在这里——metadata
   * 全同、纯熵几乎为 0，最该问的一对反而会被熵闸滤掉。
   */
  vocalWindowSeconds?: number
  /** 关键句（anchor）被唱到的比例（0..1），由 VPS 侧词级 ASR 对照歌词稿算出。 */
  anchorCoverage?: number
  /** ASR 与歌词稿的词级吻合率（0..1），由 VPS 侧词级 ASR 算出。 */
  scriptMatchRatio?: number
}

/**
 * 距离轴名（逐轴实质差异判定的键；用 `as const` 收敛，禁止裸字串散落）。
 * 前五轴为 metadata，后三轴为听感轴（VPS 侧词级 ASR 喂入）。
 */
export const TAKE_AXIS_NAMES = [
  "duration",
  "hasLyrics",
  "title",
  "soundPrompt",
  "lyricsText",
  "vocalWindowSeconds",
  "anchorCoverage",
  "scriptMatchRatio",
] as const

/** 距离轴名型别（由 TAKE_AXIS_NAMES 推导，避免裸字串）。 */
export type TakeAxisName = (typeof TAKE_AXIS_NAMES)[number]

/** 一组候选 take 的熵评估结果。 */
export interface TakeSetEntropy {
  /**
   * 多样性分数（bits）：相异度分布的香农熵 × 平均两两距离。
   * 两两全同＝0；两两最大相异＝log2(k)。**不是纯香农熵**——纯香农熵对
   * 整体尺度不变（k=2 恒为 1 bit），无法区分「几乎一样」与「天差地远」。
   */
  entropyBits: number
  /** 同集合大小的理论上限 log2(k)。 */
  maxEntropyBits: number
  /** 正规化熵 = entropyBits / maxEntropyBits（k<2 时定义为 0）。 */
  normalizedEntropy: number
  /** 每对 take 的距离矩阵（debug／审计用；索引对齐输入阵列）。 */
  pairwiseDistances: number[][]
  /**
   * 达到「实质差异」门槛的轴名（集合层级：该轴上存在任两 take 达门槛；依
   * TAKE_AXIS_NAMES 顺序）。空阵列＝没有任何一轴构成实质差异。
   */
  materialAxes: TakeAxisName[]
  /** 所有轴中最高的距离值（未加权）。 */
  maxAxisDistance: number
  /** 人话理由，说明为何熵高或低（简体）。 */
  reason: string
}

/** 偏好问题（要嘛问、要嘛不问）。 */
export interface MusicPreferenceQuestion {
  /** 要不要问（false 时 options 仍填充，供 fallback 自动选择）。 */
  asked: boolean
  /** 问题主文（简体，≤30 字）。 */
  question: string
  /** 分类标签（简体，≤15 字）。 */
  header: string
  /** 交给 question 工具用的选项（label ≤15 字、description 一句话、简体）。 */
  options: Array<{ label: string; description?: string }>
  /** label → take url 的内部对照，**不进 question 工具参数**，供定版标记与回执。 */
  optionTakeUrls: Record<string, string>
  /** 追加的两条退路 label（实作要保证 options 尾端就是这两个）。 */
  fallbackLabels: { none: string; trustModel: string }
  entropy: TakeSetEntropy
  /** 不问时，建议自动挑哪个 take（阵列索引，对齐输入）。 */
  suggestedIndex: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 维度权重常数（八维加权平均，Σ = 19）
// ─────────────────────────────────────────────────────────────────────────────

const WEIGHT_DURATION = 1
const WEIGHT_HAS_LYRICS = 1
const WEIGHT_TITLE = 2
/** soundPrompt 权重次高：它是上游真的回吐的风格字串，最能代表「听起来不同」。 */
const WEIGHT_SOUND_PROMPT = 3
const WEIGHT_LYRICS_TEXT = 2
/** 听感轴：人声演唱窗口与关键句覆盖是「metadata 相同但听感不同」的主要来源。 */
const WEIGHT_VOCAL_WINDOW = 4
const WEIGHT_ANCHOR_COVERAGE = 4
const WEIGHT_SCRIPT_MATCH = 2

/** 各轴权重表（与 TAKE_AXIS_NAMES 一对一）。 */
const AXIS_WEIGHTS: Record<TakeAxisName, number> = {
  duration: WEIGHT_DURATION,
  hasLyrics: WEIGHT_HAS_LYRICS,
  title: WEIGHT_TITLE,
  soundPrompt: WEIGHT_SOUND_PROMPT,
  lyricsText: WEIGHT_LYRICS_TEXT,
  vocalWindowSeconds: WEIGHT_VOCAL_WINDOW,
  anchorCoverage: WEIGHT_ANCHOR_COVERAGE,
  scriptMatchRatio: WEIGHT_SCRIPT_MATCH,
}

/** Σ 权重 = 1 + 1 + 2 + 3 + 2 + 4 + 4 + 2 = 19。 */
const TOTAL_WEIGHT = TAKE_AXIS_NAMES.reduce((acc, axis) => acc + AXIS_WEIGHTS[axis], 0)

/**
 * 逐轴「实质差异」门槛表。
 * 定义方式与距离函数对齐，但语义不同：距离用于加权平均，门槛用于判断「这轴是否构成
 * 一次值得问使用者的岔路口」。集合层级的实质差异＝该轴上「存在任两 take」达门槛。
 *
 * ── 各轴门槛与理由 ──────────────────────────────────────────────────────────
 * - duration：相对差 min(1, |a-b|/max(a,b)) > 0.05。5% 时长差已是明显的编曲差异。
 * - vocalWindowSeconds：相对差 > 0.05（同 duration 公式）。v1/v2 的 14.1/128 = 11%
 *   远超门槛；而 4.91/179.53 = 2.7% 的真实双 take 不触发。
 * - title：任何差异（距离 = 1）；一边缺的 0.5 不算实质（缺标题是资料杂讯，不是听感）。
 * - soundPrompt：token Jaccard 距离 > 0.2（风格词汇换血才算）。
 * - lyricsText：字元 bigram Jaccard 距离 > 0.1（歌词稿有大改才算）。
 * - hasLyrics：任何差异（有词／无词是结构性不同）。
 * - anchorCoverage：绝对差 > 0.1（关键句覆盖差 10 个百分点才算）。
 * - scriptMatchRatio：绝对差 > 0.1（词级吻合率差 10 个百分点才算）。
 */
const MATERIAL_DURATION_RELATIVE = 0.05
const MATERIAL_VOCAL_WINDOW_RELATIVE = 0.05
const MATERIAL_SOUND_PROMPT_JACCARD = 0.2
const MATERIAL_LYRICS_TEXT_BIGRAM_JACCARD = 0.1
const MATERIAL_ANCHOR_COVERAGE_ABSOLUTE = 0.1
const MATERIAL_SCRIPT_MATCH_ABSOLUTE = 0.1

/** 各轴给人看的中文名（简体）。 */
const AXIS_LABELS: Record<TakeAxisName, string> = {
  duration: "时长",
  hasLyrics: "有无歌词",
  title: "标题",
  soundPrompt: "风格提示",
  lyricsText: "歌词文本",
  vocalWindowSeconds: "人声演唱窗口",
  anchorCoverage: "关键句覆盖",
  scriptMatchRatio: "歌词吻合度",
}

/** 两条退路（固定，永远追加在 options 尾端）。 */
const FALLBACK_LABELS: { none: string; trustModel: string } = {
  none: "都不行，重写",
  trustModel: "你替我定",
}

/** take 选项的 label 池。 */
const TAKE_OPTION_LABELS = ["A", "B", "C", "D"] as const

/**
 * take 选项的名额上限：spec 的 maxOptions 硬上限 4 是「take 选项 + 两条退路」的
 * 总数，退路两条一定要在场，所以 take 选项最多 4 - 2 = 2 个（折算写死在这里）。
 */
const MAX_TAKE_OPTIONS = TAKE_OPTION_LABELS.length - 2 // = 2

/** 问题主文与分类标签（固定，简体）。 */
const QUESTION_TEXT = "这几版你更喜欢哪个？"
const QUESTION_HEADER = "选版本"

/** 熵闸门预设值：正规化熵低于此＝选项彼此太像＝不问。 */
const DEFAULT_MIN_NORMALIZED_ENTROPY = 0.25

/** 偏好饱和阈值：答案分布正规化熵低于此＝已饱和（再问也问不出资讯）。 */
const SATURATION_THRESHOLD = 0.5

/** 浮点比较用的极小值。 */
const EPSILON = 1e-12

// ─────────────────────────────────────────────────────────────────────────────
// 单维距离
// ─────────────────────────────────────────────────────────────────────────────

/** 是否为有限数值。 */
function isFiniteNumber(value?: number): boolean {
  return typeof value === "number" && Number.isFinite(value)
}

/** 字串是否「在场」（非 null/undefined 且 trim 后非空）。 */
function isPresent(value?: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * 相对差维：`min(1, |a-b| / max(a,b))`；都缺 0；一边缺 0.5（缺值本身是差异讯号）。
 * 用于 duration 与 vocalWindowSeconds。
 */
function relativeDistance(a?: number, b?: number): number {
  const hasA = isFiniteNumber(a)
  const hasB = isFiniteNumber(b)
  if (!hasA && !hasB) return 0
  if (!hasA || !hasB) return 0.5
  const denom = Math.max(a as number, b as number)
  if (denom <= 0) return 0
  return Math.min(1, Math.abs((a as number) - (b as number)) / denom)
}

/** duration 维（见 relativeDistance）。 */
function durationDistance(a?: number, b?: number): number {
  return relativeDistance(a, b)
}

/** vocalWindowSeconds 维（同 duration 公式）。 */
function vocalWindowDistance(a?: number, b?: number): number {
  return relativeDistance(a, b)
}

/**
 * [0,1] 值域维：绝对差 `|a-b|`；都缺 0；一边缺 0.5。
 * 用于 anchorCoverage 与 scriptMatchRatio（值域已保证 [0,1]，夹取仅为防御）。
 */
function unitDistance(a?: number, b?: number): number {
  const hasA = isFiniteNumber(a)
  const hasB = isFiniteNumber(b)
  if (!hasA && !hasB) return 0
  if (!hasA || !hasB) return 0.5
  return Math.min(1, Math.abs((a as number) - (b as number)))
}

/** hasLyrics 维：两边「有无歌词」不同 → 1，相同 → 0。 */
function hasLyrics(take: MusicTakeFeature): boolean {
  return isPresent(take.lyricsEcho)
}

/** hasLyrics 距离。 */
function hasLyricsDistance(a: MusicTakeFeature, b: MusicTakeFeature): number {
  return hasLyrics(a) === hasLyrics(b) ? 0 : 1
}

/** title 维：完全相同 → 0；都缺 → 0；一边缺 → 0.5；都有但不同 → 1。 */
function titleDistance(a?: string, b?: string): number {
  const hasA = isPresent(a)
  const hasB = isPresent(b)
  if (!hasA && !hasB) return 0
  if (!hasA || !hasB) return 0.5
  return (a as string).trim() === (b as string).trim() ? 0 : 1
}

/** 以空白／逗号切 token 并转小写（soundPrompt 用）。 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const raw of text.toLowerCase().split(/[\s,]+/)) {
    const token = raw.trim()
    if (token.length > 0) tokens.add(token)
  }
  return tokens
}

/** 字元 bigram 集合（lyricsText 用）。 */
function charBigrams(text: string): Set<string> {
  const grams = new Set<string>()
  for (let i = 0; i + 1 < text.length; i++) {
    grams.add(text.slice(i, i + 2))
  }
  return grams
}

/** 集合 Jaccard 距离 `1 - |A∩B| / |A∪B|`（两集合皆空 → 0）。 */
function jaccardDistance(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection += 1
  }
  const union = a.size + b.size - intersection
  if (union === 0) return 0
  return 1 - intersection / union
}

/** soundPrompt 维：转 token 集合后 Jaccard；都缺 0／一边缺 0.5。 */
function soundPromptDistance(a?: string, b?: string): number {
  const hasA = isPresent(a)
  const hasB = isPresent(b)
  if (!hasA && !hasB) return 0
  if (!hasA || !hasB) return 0.5
  return jaccardDistance(tokenize(a as string), tokenize(b as string))
}

/**
 * lyricsText 维：对 lyricsEcho 的字元 bigram 集合算 Jaccard。
 * 都缺 0／一边缺 0.5；两边都在场但都切不出 bigram（单字元）→ 比原字串相等。
 */
function lyricsTextDistance(a?: string | null, b?: string | null): number {
  const hasA = isPresent(a)
  const hasB = isPresent(b)
  if (!hasA && !hasB) return 0
  if (!hasA || !hasB) return 0.5
  const gramsA = charBigrams((a as string).trim())
  const gramsB = charBigrams((b as string).trim())
  if (gramsA.size === 0 && gramsB.size === 0) {
    return (a as string).trim() === (b as string).trim() ? 0 : 1
  }
  return jaccardDistance(gramsA, gramsB)
}

/** 取单一轴的距离（[0,1]）。 */
function axisDistance(axis: TakeAxisName, a: MusicTakeFeature, b: MusicTakeFeature): number {
  switch (axis) {
    case "duration":
      return durationDistance(a.durationSeconds, b.durationSeconds)
    case "hasLyrics":
      return hasLyricsDistance(a, b)
    case "title":
      return titleDistance(a.title, b.title)
    case "soundPrompt":
      return soundPromptDistance(a.soundPrompt, b.soundPrompt)
    case "lyricsText":
      return lyricsTextDistance(a.lyricsEcho, b.lyricsEcho)
    case "vocalWindowSeconds":
      return vocalWindowDistance(a.vocalWindowSeconds, b.vocalWindowSeconds)
    case "anchorCoverage":
      return unitDistance(a.anchorCoverage, b.anchorCoverage)
    case "scriptMatchRatio":
      return unitDistance(a.scriptMatchRatio, b.scriptMatchRatio)
  }
}

/**
 * 单一轴在「这一对 take」上是否构成实质差异（门槛见上方 MATERIAL_* 常数表）。
 * 注意与 axisDistance 的差异：门槛语义可能排除「一边缺值」的 0.5（见表中注解）。
 */
function isMaterialAxisDifference(
  axis: TakeAxisName,
  a: MusicTakeFeature,
  b: MusicTakeFeature,
): boolean {
  switch (axis) {
    case "duration": {
      if (!isFiniteNumber(a.durationSeconds) || !isFiniteNumber(b.durationSeconds)) return false
      return durationDistance(a.durationSeconds, b.durationSeconds) > MATERIAL_DURATION_RELATIVE
    }
    case "vocalWindowSeconds": {
      if (!isFiniteNumber(a.vocalWindowSeconds) || !isFiniteNumber(b.vocalWindowSeconds)) return false
      return vocalWindowDistance(a.vocalWindowSeconds, b.vocalWindowSeconds) > MATERIAL_VOCAL_WINDOW_RELATIVE
    }
    case "title":
      // 只有「两边都在场且不同」才算（距离 = 1）；一边缺的 0.5 不算实质。
      return titleDistance(a.title, b.title) === 1
    case "soundPrompt":
      return soundPromptDistance(a.soundPrompt, b.soundPrompt) > MATERIAL_SOUND_PROMPT_JACCARD
    case "lyricsText":
      return lyricsTextDistance(a.lyricsEcho, b.lyricsEcho) > MATERIAL_LYRICS_TEXT_BIGRAM_JACCARD
    case "hasLyrics":
      return hasLyrics(a) !== hasLyrics(b)
    case "anchorCoverage":
      return unitDistance(a.anchorCoverage, b.anchorCoverage) > MATERIAL_ANCHOR_COVERAGE_ABSOLUTE
    case "scriptMatchRatio":
      return unitDistance(a.scriptMatchRatio, b.scriptMatchRatio) > MATERIAL_SCRIPT_MATCH_ABSOLUTE
  }
}

/** 两个 take 的加权平均距离（八维，Σ 权重 = 19）。 */
function takeDistance(a: MusicTakeFeature, b: MusicTakeFeature): number {
  let weightedSum = 0
  for (const axis of TAKE_AXIS_NAMES) {
    weightedSum += axisDistance(axis, a, b) * AXIS_WEIGHTS[axis]
  }
  return TOTAL_WEIGHT === 0 ? 0 : weightedSum / TOTAL_WEIGHT
}

// ─────────────────────────────────────────────────────────────────────────────
// 集合熵
// ─────────────────────────────────────────────────────────────────────────────

/** 描述单一实质差异轴给人看（简体）。 */
function describeMaterialAxis(axis: TakeAxisName, distance: number): string {
  if (axis === "title") return "标题不同"
  if (axis === "hasLyrics") return "有无歌词不同"
  return `${AXIS_LABELS[axis]}差异 ${Math.round(distance * 100)}%`
}

/**
 * 依放行闸产生一句人话理由（简体）。
 *   ① 有实质差异轴 → 说明最强的那一轴。
 *   ② 无实质差异但熵过闸 → 差异明显。
 *   ③ 两者都不过 → 几乎一致。
 */
function describeEntropy(
  normalizedEntropy: number,
  materialAxisScores: Array<{ axis: TakeAxisName; distance: number }>,
): string {
  if (materialAxisScores.length > 0) {
    const primary = materialAxisScores.reduce((best, current) =>
      current.distance > best.distance ? current : best,
    )
    return `${describeMaterialAxis(primary.axis, primary.distance)}（实质差异），值得让你挑`
  }
  if (normalizedEntropy >= DEFAULT_MIN_NORMALIZED_ENTROPY) {
    return `各版本差异明显（归一化熵 ${normalizedEntropy.toFixed(3)}），值得让你挑`
  }
  return "各版本几乎一致，没有可比较的差异"
}

/** 单组 take 集合的熵评估。 */
export function evaluateTakeSetEntropy(features: MusicTakeFeature[]): TakeSetEntropy {
  const k = features.length

  const maxEntropyBits = k < 2 ? 0 : Math.log2(k)

  // k<2 无从比较：熵定义为 0，也没有可比较的轴。
  if (k < 2) {
    const pairwiseDistances: number[][] = features.map(() => [0])
    return {
      entropyBits: 0,
      maxEntropyBits,
      normalizedEntropy: 0,
      pairwiseDistances,
      materialAxes: [],
      maxAxisDistance: 0,
      reason: k === 0 ? "没有可用候选" : "只有一个候选，无从比较",
    }
  }

  // 逐轴距离矩阵（对角线 0）。同时用于加权距离、实质差异判定与 maxAxisDistance。
  const axisMatrices = {} as Record<TakeAxisName, number[][]>
  for (const axis of TAKE_AXIS_NAMES) {
    axisMatrices[axis] = features.map((a, i) =>
      features.map((b, j) => (i === j ? 0 : axisDistance(axis, a, b))),
    )
  }

  // 距离矩阵（八轴加权平均；对角线 0；索引对齐输入）。
  const pairwiseDistances: number[][] = features.map((_, i) =>
    features.map((__, j) => {
      if (i === j) return 0
      let weightedSum = 0
      for (const axis of TAKE_AXIS_NAMES) {
        weightedSum += axisMatrices[axis][i][j] * AXIS_WEIGHTS[axis]
      }
      return weightedSum / TOTAL_WEIGHT
    }),
  )

  // 逐轴扫描：轴上最大距离（进 maxAxisDistance）＋是否有任一对达实质门槛。
  let maxAxisDistance = 0
  const materialAxisScores: Array<{ axis: TakeAxisName; distance: number }> = []
  for (const axis of TAKE_AXIS_NAMES) {
    let axisMaxDistance = 0
    let material = false
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const distance = axisMatrices[axis][i][j]
        if (distance > axisMaxDistance) axisMaxDistance = distance
        if (!material && isMaterialAxisDifference(axis, features[i], features[j])) material = true
      }
    }
    if (axisMaxDistance > maxAxisDistance) maxAxisDistance = axisMaxDistance
    if (material) materialAxisScores.push({ axis, distance: axisMaxDistance })
  }
  const materialAxes = materialAxisScores.map((entry) => entry.axis)

  // 每个 take 的「相异度」 s_i = mean_{j≠i} d(i,j)。
  const distinctness = features.map((_, i) => {
    let sum = 0
    for (let j = 0; j < k; j++) {
      if (j !== i) sum += pairwiseDistances[i][j]
    }
    return sum / (k - 1)
  })

  // 相异度分布的香农熵（照 spec：w_i = s_i；Σw = 0 → 熵 0）。
  const sumWeights = distinctness.reduce((acc, value) => acc + value, 0)
  let distributionEntropy = 0
  if (sumWeights > EPSILON) {
    for (const weight of distinctness) {
      if (weight <= 0) continue
      const probability = weight / sumWeights
      distributionEntropy -= probability * Math.log2(probability)
    }
  }

  // 平均两两距离（幅度校正项）。
  let pairSum = 0
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      pairSum += pairwiseDistances[i][j]
    }
  }
  const meanDistance = pairSum / ((k * (k - 1)) / 2)

  // 为什么要乘 meanDistance（本档唯一偏离「纯香农熵」之处）：
  // 相异度分布熵对「整体尺度」不变——只要任两 take 有非零距离，k=2 恒得
  // H = 1 bit（两个 take 各 s=0.5），与「这两版几乎一样」互相矛盾。若只用分布熵，
  // 2026-10-03 真实双 take（时长差 4.91s、其余全同）会得到 normalizedEntropy = 1，
  // 永远问使用者。故乘上平均两两距离作幅度校正：
  //   entropyBits = 分布熵 × meanDistance
  // 这样「几乎一样 → 熵趋近 0、不问」「两两最大相异 → meanDistance = 1、
  // 熵回到 log2(k)」，normalizedEntropy = entropyBits / log2(k) 也保持不变。
  const entropyBits = distributionEntropy * meanDistance
  const normalizedEntropy = maxEntropyBits > 0 ? entropyBits / maxEntropyBits : 0

  return {
    entropyBits,
    maxEntropyBits,
    normalizedEntropy,
    pairwiseDistances,
    materialAxes,
    maxAxisDistance,
    reason: describeEntropy(normalizedEntropy, materialAxisScores),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 选项挑选：从 n 个候选挑 k 个「彼此最相异」
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 n 个候选中挑 k 个「彼此最相异」的子集，最大化集合熵。
 * n ≤ 12 用穷举；n > 12 用贪婪 max-min（先取距离最远的一对，再逐个取
 * 「到已选集合最小距离」最大者）。回传被选中的索引（依原阵列顺序升序）。
 */
export function selectEntropyOptions(features: MusicTakeFeature[], k: number): number[] {
  const n = features.length
  if (k <= 0 || n === 0) return []
  if (k >= n) return features.map((_, i) => i)

  // 子集分数 = 该子集的集合熵（entropyBits）。
  const scoreSubset = (indices: number[]): number =>
    evaluateTakeSetEntropy(indices.map((index) => features[index])).entropyBits

  // 决定性比较：分数高者胜；平手时取字典序较小者（输出稳定可审计）。
  const isBetter = (candidate: number[], incumbent: number[]): boolean => {
    const candidateScore = scoreSubset(candidate)
    const incumbentScore = scoreSubset(incumbent)
    if (Math.abs(candidateScore - incumbentScore) > 1e-12) {
      return candidateScore > incumbentScore
    }
    for (let i = 0; i < candidate.length; i++) {
      if (candidate[i] !== incumbent[i]) return candidate[i] < incumbent[i]
    }
    return false
  }

  if (n <= 12) {
    // 穷举所有大小 k 的组合。
    let best: number[] | null = null
    const combination: number[] = []
    const recurse = (start: number): void => {
      if (combination.length === k) {
        const candidate = [...combination]
        if (best === null || isBetter(candidate, best)) best = candidate
        return
      }
      for (let i = start; i < n; i++) {
        combination.push(i)
        recurse(i + 1)
        combination.pop()
      }
    }
    recurse(0)
    return best ?? []
  }

  // n > 12：贪婪 max-min。先取距离最远的一对（平手取字典序最小）。
  const distanceMatrix: number[][] = features.map((_, i) =>
    features.map((__, j) => (i === j ? 0 : takeDistance(features[i], features[j]))),
  )
  let farthestPair: [number, number] = [0, 1]
  let farthestDistance = -1
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (distanceMatrix[i][j] > farthestDistance + 1e-12) {
        farthestDistance = distanceMatrix[i][j]
        farthestPair = [i, j]
      }
    }
  }
  const selected = [farthestPair[0], farthestPair[1]]
  const selectedSet = new Set(selected)
  while (selected.length < k) {
    let bestIndex = -1
    let bestMinDistance = -1
    for (let i = 0; i < n; i++) {
      if (selectedSet.has(i)) continue
      let minDistance = Infinity
      for (const chosen of selected) {
        minDistance = Math.min(minDistance, distanceMatrix[i][chosen])
      }
      if (minDistance > bestMinDistance + 1e-12) {
        bestMinDistance = minDistance
        bestIndex = i
      }
    }
    if (bestIndex < 0) break
    selected.push(bestIndex)
    selectedSet.add(bestIndex)
  }
  return selected.sort((a, b) => a - b)
}

// ─────────────────────────────────────────────────────────────────────────────
// 偏好饱和
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 使用者偏好是否已经饱和（答案分布太确定 → 再问也问不出资讯）。
 * 回传 true＝已饱和（不该再问）。count 总和 < 3 一律回 false。
 * 定义：答案分布正规化熵 < 0.5 视为饱和。
 *
 * 正规化分母采 `log2(相异标签数)`（＝该标签数下的最大熵，标准正规化），
 * **不可用 log2(样本总数)**：样本越多分母越大，任何分布都会被判饱和。反例：
 * `[{A:50},{B:50}]`（k=2 的最大不确定）→ H = 1.0 bit、log2(100) = 6.64 →
 * 1.0/6.64 = 0.15 < 0.2，判「已饱和」，完全反了。改用 log2(2) = 1 后得
 * 1.0/1 = 1.0，正确判为未饱和。
 *
 * 相异标签数 ≤ 1 且 total ≥ 3 → 回 true（单一答案被反覆选中，必然饱和）。
 * 两条既有断言在新分母下仍成立：9:1 → 0.469 < 0.5 → true；
 * 3:2:2 → 1.557/1.585 ≈ 0.982 → false。
 */
export function isPreferenceSaturated(history: { label: string; count: number }[]): boolean {
  const samples = history.filter((entry) => Number.isFinite(entry.count) && entry.count > 0)
  const total = samples.reduce((acc, entry) => acc + entry.count, 0)
  if (total < 3) return false

  const distinctLabels = new Set(samples.map((entry) => entry.label)).size
  // 相异标签数 ≤ 1：分布完全确定，直接饱和。
  if (distinctLabels <= 1) return true

  let entropy = 0
  for (const entry of samples) {
    const probability = entry.count / total
    entropy -= probability * Math.log2(probability)
  }
  const denominator = Math.log2(distinctLabels)
  if (denominator <= 0) return true
  return entropy / denominator < SATURATION_THRESHOLD
}

// ─────────────────────────────────────────────────────────────────────────────
// 问题建构
// ─────────────────────────────────────────────────────────────────────────────

/** 依 take 的可量测事实组 description（简体；只放事实，禁评分/主观形容词）。 */
function takeDescription(take: MusicTakeFeature): string {
  const title = isPresent(take.title) ? (take.title as string).trim() : "未命名"
  const duration = isFiniteNumber(take.durationSeconds) ? `${take.durationSeconds}s` : "时长未知"
  const lyrics = hasLyrics(take) ? "有词" : "无词"
  return `${title}，${duration}，${lyrics}`
}

/** 把 [0,1] 夹在范围内。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 为一组 take 建构偏好问题。
 * @param takes 候选 take（≥1）
 * @param opts.maxOptions 最多几个选项（预设 2，硬上限 4；退路两条另计但共用同一上限，见下）
 * @param opts.minNormalizedEntropy 熵闸（预设 0.25）：正规化熵低于此＝选项彼此太像＝不问
 * @param opts.preferenceHistory 该使用者过往在此维度的选择分布（可选；见下方熵增益）
 */
export function buildMusicPreferenceQuestion(
  takes: MusicTakeFeature[],
  opts?: {
    maxOptions?: number
    minNormalizedEntropy?: number
    preferenceHistory?: { label: string; count: number }[]
  },
): MusicPreferenceQuestion {
  const maxOptions = clamp(Math.floor(opts?.maxOptions ?? 2), 1, 4)
  // 折算：总名额（take 选项 + 两条退路）≤ 4 ⇒ take 选项 ≤ MAX_TAKE_OPTIONS（= 2）。
  const takeOptionCount = Math.min(maxOptions, takes.length, MAX_TAKE_OPTIONS)

  // 挑「彼此最相异」的 take 选项；单一/空集合照原样处理。
  const selectedIndices =
    takes.length === 0
      ? []
      : selectEntropyOptions(takes, Math.min(takeOptionCount, takes.length))
  const selectedTakes = selectedIndices.map((index) => takes[index])

  // 熵只对被选中的那 k 个算。
  const entropyBase =
    selectedTakes.length > 0 ? evaluateTakeSetEntropy(selectedTakes) : evaluateTakeSetEntropy([])

  const minNormalizedEntropy = clamp(
    opts?.minNormalizedEntropy ?? DEFAULT_MIN_NORMALIZED_ENTROPY,
    0,
    1,
  )
  const saturated = isPreferenceSaturated(opts?.preferenceHistory ?? [])

  const enoughTakes = takes.length >= 2
  // 两条放行闸：逐轴实质差异 OR 正规化熵过闸。
  const asked =
    enoughTakes &&
    !saturated &&
    (entropyBase.materialAxes.length > 0 || entropyBase.normalizedEntropy >= minNormalizedEntropy)

  // 最终理由：饱和 > 候选不足 > 两闸都不过 > 正常（entropyBase.reason 已如实说明走哪条闸）。
  let reason = entropyBase.reason
  if (saturated) {
    reason = "你的偏好已稳定，直接套用，不再打扰"
  } else if (!enoughTakes) {
    reason = entropyBase.reason
  } else if (!asked) {
    // 走到这里必然：无实质差异轴且熵未过闸。
    reason = "各版本几乎一致，没有可比较的差异"
  }
  const entropy: TakeSetEntropy = { ...entropyBase, reason }

  // take 选项（label A/B/... 对应被选中的 take，依原顺序）。
  const options: Array<{ label: string; description?: string }> = []
  const optionTakeUrls: Record<string, string> = {}
  selectedIndices.forEach((takeIndex, position) => {
    const label = TAKE_OPTION_LABELS[position]
    options.push({ label, description: takeDescription(takes[takeIndex]) })
    optionTakeUrls[label] = takes[takeIndex].url
  })

  // 尾端必定追加两条退路（顺序固定：none → trustModel）。
  options.push({ label: FALLBACK_LABELS.none, description: "都不满意，重新生成一批" })
  options.push({ label: FALLBACK_LABELS.trustModel, description: "由模型直接选一版" })

  // 不问时采「保守保留现状」：沿用主候选（索引 0）。
  const suggestedIndex = asked ? selectedIndices[0] : 0

  return {
    asked,
    question: QUESTION_TEXT,
    header: QUESTION_HEADER,
    options,
    optionTakeUrls,
    fallbackLabels: { ...FALLBACK_LABELS },
    entropy,
    suggestedIndex,
  }
}
