/**
 * Music take 熵決策層 VPS staging 稿（多 take 偏好闸，2026-10-03 機械導出）。
 *
 * 鏡像自 src/lib/music-take-entropy.ts，勿直接手改本檔。
 * 該檔零依賴、零 import，故全文逐行照抄、無任何 import 路徑改寫。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music_take_entropy.ts
 * env：無（純函數，零依賴零副作用）。
 */

/**
 * music-take-entropy.ts —— 多 take 的熵決策層（純函數、零依賴）。
 *
 * 為什麼要有這層：FlowMusic 上游一次常回 2 個 clips（見 2026-10-03 安慰劑組實跑，
 * 兩個 take 同標題《隐秘的折痕》、時長 179.53s / 174.62s、歌詞相同）。若兩個 take
 * 幾乎一樣，拿它們去問使用者「你更喜歡哪個」是浪費互動——使用者分不出來，問卷只會
 * 得到雜訊。這層量化「這組 take 彼此有多不一樣」，低於閘門就不問，保守沿用主候選；
 * 過閘才把最相異的幾個 take 端去讓使用者挑。
 *
 * 多樣性分數（entropyBits）＝相異度分佈的香農熵 × 平均兩兩距離。為什麼要乘「平均
 * 兩兩距離」這個幅度校正項：純香農熵對整體尺度不變——只要任兩 take 有非零距離，
 * k=2 恆得 1 bit，無法區分「幾乎一樣」與「天差地遠」。分佈熵負責「差異是否分散在
 * 多個 take 上」，平均距離負責「差異本身有多大」；兩者相乘後，「幾乎一樣 → 分數趨近
 * 0」「兩兩最大相異 → 分數回到 log2(k)」這兩個極端都成立。所以 entropyBits 不是純
 * 香農熵（見欄位註解）。
 *
 * 兩條放行閘（asked 的條件，見 buildMusicPreferenceQuestion）：
 *   ① 逐軸實質差異：任一維度上存在任兩 take 的差異超過該軸門檻（見 isMaterialAxis
 *      Difference）。這條是為了「聽得出來、但 metadata 幾乎相同」的岔路口——例如
 *      2026-10-03 v1/v2 只有人聲演唱窗口 128s vs 113.9s 之差（相對差 11%），正規化
 *      熵只有 ~0.02，永遠過不了熵閘，但 14 秒的演唱差是巨大的聽感差異，恰恰最該問。
 *   ② 正規化熵過閘：整組的熵高於 minNormalizedEntropy（預設 0.25）。
 *
 * 設計邊界（本檔刻意只做決策，不做任何 I/O）：
 *   - 只吃回執真的有的欄位（url / candidate_index / duration_seconds / title /
 *     lyrics_echo / sound_prompt）以及由 VPS 側 video_transcribe 詞級 ASR 算出的
 *     聽感欄位（vocal_window_seconds / anchor_coverage / script_match_ratio）；
 *     本模組只吃數值，不自己做任何音頻分析。
 *   - 純函數：不讀檔、不 fetch、不讀 env、不 import 任何 repo 內模組。
 *   - 接線（工具層 / gateway / UI）是下一個階段，本檔一律不碰。
 *
 * 距離模型：每個 take 抽 8 個維度逐維算 [0,1] 距離，加權平均（Σ 權重 = 19）：
 *   - duration            權重 1（缺值本身是差異訊號：只有一邊有值 → 0.5）
 *   - hasLyrics           權重 1
 *   - title               權重 2
 *   - soundPrompt         權重 3（上游真的回吐的風格字串）
 *   - lyricsText          權重 2（字元 bigram Jaccard）
 *   - vocalWindowSeconds  權重 4（人聲收束時間；聽感最直接的岔路口）
 *   - anchorCoverage      權重 4（關鍵句被唱到的比例）
 *   - scriptMatchRatio    權重 2（ASR 與歌詞稿的詞級吻合率）
 */

/** 單一 take 的可量測特徵（只准用回執真的有的欄位，禁止發明音頻分析）。 */
export interface MusicTakeFeature {
  url: string
  candidateIndex: number
  durationSeconds?: number
  title?: string
  /** 上游 clips[].sound_prompt（可能沒有；目前 music-flowmusic.ts 尚未解析，缺省 undefined）。 */
  soundPrompt?: string
  /** 工具回執的 lyrics_echo（無歌詞為 null/undefined）。 */
  lyricsEcho?: string | null
  /**
   * 人聲收束時間（秒）：由 VPS 側 video_transcribe 詞級 ASR 算出「最後一個唱詞時間」。
   * 本模組只吃數值。2026-10-03 v1/v2 的真正差別（128s vs 113.9s）就在這裡——metadata
   * 全同、純熵幾乎為 0，最該問的一對反而會被熵閘濾掉。
   */
  vocalWindowSeconds?: number
  /** 關鍵句（anchor）被唱到的比例（0..1），由 VPS 側詞級 ASR 對照歌詞稿算出。 */
  anchorCoverage?: number
  /** ASR 與歌詞稿的詞級吻合率（0..1），由 VPS 側詞級 ASR 算出。 */
  scriptMatchRatio?: number
}

/**
 * 距離軸名（逐軸實質差異判定的鍵；用 `as const` 收斂，禁止裸字串散落）。
 * 前五軸為 metadata，後三軸為聽感軸（VPS 側詞級 ASR 餵入）。
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

/** 距離軸名型別（由 TAKE_AXIS_NAMES 推導，避免裸字串）。 */
export type TakeAxisName = (typeof TAKE_AXIS_NAMES)[number]

/** 一組候選 take 的熵評估結果。 */
export interface TakeSetEntropy {
  /**
   * 多樣性分數（bits）：相異度分佈的香農熵 × 平均兩兩距離。
   * 兩兩全同＝0；兩兩最大相異＝log2(k)。**不是純香農熵**——純香農熵對
   * 整體尺度不變（k=2 恆為 1 bit），無法區分「幾乎一樣」與「天差地遠」。
   */
  entropyBits: number
  /** 同集合大小的理論上限 log2(k)。 */
  maxEntropyBits: number
  /** 正規化熵 = entropyBits / maxEntropyBits（k<2 時定義為 0）。 */
  normalizedEntropy: number
  /** 每對 take 的距離矩陣（debug／審計用；索引對齊輸入陣列）。 */
  pairwiseDistances: number[][]
  /**
   * 達到「實質差異」門檻的軸名（集合層級：該軸上存在任兩 take 達門檻；依
   * TAKE_AXIS_NAMES 順序）。空陣列＝沒有任何一軸構成實質差異。
   */
  materialAxes: TakeAxisName[]
  /** 所有軸中最高的距離值（未加權）。 */
  maxAxisDistance: number
  /** 人話理由，說明為何熵高或低（簡體）。 */
  reason: string
}

/** 偏好問題（要嘛問、要嘛不問）。 */
export interface MusicPreferenceQuestion {
  /** 要不要問（false 時 options 仍填充，供 fallback 自動選擇）。 */
  asked: boolean
  /** 問題主文（簡體，≤30 字）。 */
  question: string
  /** 分類標籤（簡體，≤15 字）。 */
  header: string
  /** 交給 question 工具用的選項（label ≤15 字、description 一句話、簡體）。 */
  options: Array<{ label: string; description?: string }>
  /** label → take url 的內部對照，**不進 question 工具參數**，供定版標記與回執。 */
  optionTakeUrls: Record<string, string>
  /** 追加的兩條退路 label（實作要保證 options 尾端就是這兩個）。 */
  fallbackLabels: { none: string; trustModel: string }
  entropy: TakeSetEntropy
  /** 不問時，建議自動挑哪個 take（陣列索引，對齊輸入）。 */
  suggestedIndex: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 維度權重常數（八維加權平均，Σ = 19）
// ─────────────────────────────────────────────────────────────────────────────

const WEIGHT_DURATION = 1
const WEIGHT_HAS_LYRICS = 1
const WEIGHT_TITLE = 2
/** soundPrompt 權重次高：它是上游真的回吐的風格字串，最能代表「聽起來不同」。 */
const WEIGHT_SOUND_PROMPT = 3
const WEIGHT_LYRICS_TEXT = 2
/** 聽感軸：人聲演唱窗口與關鍵句覆蓋是「metadata 相同但聽感不同」的主要來源。 */
const WEIGHT_VOCAL_WINDOW = 4
const WEIGHT_ANCHOR_COVERAGE = 4
const WEIGHT_SCRIPT_MATCH = 2

/** 各軸權重表（與 TAKE_AXIS_NAMES 一對一）。 */
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

/** Σ 權重 = 1 + 1 + 2 + 3 + 2 + 4 + 4 + 2 = 19。 */
const TOTAL_WEIGHT = TAKE_AXIS_NAMES.reduce((acc, axis) => acc + AXIS_WEIGHTS[axis], 0)

/**
 * 逐軸「實質差異」門檻表。
 * 定義方式與距離函數對齊，但語義不同：距離用於加權平均，門檻用於判斷「這軸是否構成
 * 一次值得問使用者的岔路口」。集合層級的實質差異＝該軸上「存在任兩 take」達門檻。
 *
 * ── 各軸門檻與理由 ──────────────────────────────────────────────────────────
 * - duration：相對差 min(1, |a-b|/max(a,b)) > 0.05。5% 時長差已是明顯的編曲差異。
 * - vocalWindowSeconds：相對差 > 0.05（同 duration 公式）。v1/v2 的 14.1/128 = 11%
 *   遠超門檻；而 4.91/179.53 = 2.7% 的真實雙 take 不觸發。
 * - title：任何差異（距離 = 1）；一邊缺的 0.5 不算實質（缺標題是資料雜訊，不是聽感）。
 * - soundPrompt：token Jaccard 距離 > 0.2（風格詞彙換血才算）。
 * - lyricsText：字元 bigram Jaccard 距離 > 0.1（歌詞稿有大改才算）。
 * - hasLyrics：任何差異（有詞／無詞是結構性不同）。
 * - anchorCoverage：絕對差 > 0.1（關鍵句覆蓋差 10 個百分點才算）。
 * - scriptMatchRatio：絕對差 > 0.1（詞級吻合率差 10 個百分點才算）。
 */
const MATERIAL_DURATION_RELATIVE = 0.05
const MATERIAL_VOCAL_WINDOW_RELATIVE = 0.05
const MATERIAL_SOUND_PROMPT_JACCARD = 0.2
const MATERIAL_LYRICS_TEXT_BIGRAM_JACCARD = 0.1
const MATERIAL_ANCHOR_COVERAGE_ABSOLUTE = 0.1
const MATERIAL_SCRIPT_MATCH_ABSOLUTE = 0.1

/** 各軸給人看的中文名（簡體）。 */
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

/** 兩條退路（固定，永遠追加在 options 尾端）。 */
const FALLBACK_LABELS: { none: string; trustModel: string } = {
  none: "都不行，重写",
  trustModel: "你替我定",
}

/** take 選項的 label 池。 */
const TAKE_OPTION_LABELS = ["A", "B", "C", "D"] as const

/**
 * take 選項的名額上限：spec 的 maxOptions 硬上限 4 是「take 選項 + 兩條退路」的
 * 總數，退路兩條一定要在場，所以 take 選項最多 4 - 2 = 2 個（折算寫死在這裡）。
 */
const MAX_TAKE_OPTIONS = TAKE_OPTION_LABELS.length - 2 // = 2

/** 問題主文與分類標籤（固定，簡體）。 */
const QUESTION_TEXT = "这几版你更喜欢哪个？"
const QUESTION_HEADER = "选版本"

/** 熵閘門預設值：正規化熵低於此＝選項彼此太像＝不問。 */
const DEFAULT_MIN_NORMALIZED_ENTROPY = 0.25

/** 偏好飽和閾值：答案分佈正規化熵低於此＝已飽和（再問也問不出資訊）。 */
const SATURATION_THRESHOLD = 0.5

/** 浮點比較用的極小值。 */
const EPSILON = 1e-12

// ─────────────────────────────────────────────────────────────────────────────
// 單維距離
// ─────────────────────────────────────────────────────────────────────────────

/** 是否為有限數值。 */
function isFiniteNumber(value?: number): boolean {
  return typeof value === "number" && Number.isFinite(value)
}

/** 字串是否「在場」（非 null/undefined 且 trim 後非空）。 */
function isPresent(value?: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * 相對差維：`min(1, |a-b| / max(a,b))`；都缺 0；一邊缺 0.5（缺值本身是差異訊號）。
 * 用於 duration 與 vocalWindowSeconds。
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

/** duration 維（見 relativeDistance）。 */
function durationDistance(a?: number, b?: number): number {
  return relativeDistance(a, b)
}

/** vocalWindowSeconds 維（同 duration 公式）。 */
function vocalWindowDistance(a?: number, b?: number): number {
  return relativeDistance(a, b)
}

/**
 * [0,1] 值域維：絕對差 `|a-b|`；都缺 0；一邊缺 0.5。
 * 用於 anchorCoverage 與 scriptMatchRatio（值域已保證 [0,1]，夾取僅為防禦）。
 */
function unitDistance(a?: number, b?: number): number {
  const hasA = isFiniteNumber(a)
  const hasB = isFiniteNumber(b)
  if (!hasA && !hasB) return 0
  if (!hasA || !hasB) return 0.5
  return Math.min(1, Math.abs((a as number) - (b as number)))
}

/** hasLyrics 維：兩邊「有無歌詞」不同 → 1，相同 → 0。 */
function hasLyrics(take: MusicTakeFeature): boolean {
  return isPresent(take.lyricsEcho)
}

/** hasLyrics 距離。 */
function hasLyricsDistance(a: MusicTakeFeature, b: MusicTakeFeature): number {
  return hasLyrics(a) === hasLyrics(b) ? 0 : 1
}

/** title 維：完全相同 → 0；都缺 → 0；一邊缺 → 0.5；都有但不同 → 1。 */
function titleDistance(a?: string, b?: string): number {
  const hasA = isPresent(a)
  const hasB = isPresent(b)
  if (!hasA && !hasB) return 0
  if (!hasA || !hasB) return 0.5
  return (a as string).trim() === (b as string).trim() ? 0 : 1
}

/** 以空白／逗號切 token 並轉小寫（soundPrompt 用）。 */
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

/** 集合 Jaccard 距離 `1 - |A∩B| / |A∪B|`（兩集合皆空 → 0）。 */
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

/** soundPrompt 維：轉 token 集合後 Jaccard；都缺 0／一邊缺 0.5。 */
function soundPromptDistance(a?: string, b?: string): number {
  const hasA = isPresent(a)
  const hasB = isPresent(b)
  if (!hasA && !hasB) return 0
  if (!hasA || !hasB) return 0.5
  return jaccardDistance(tokenize(a as string), tokenize(b as string))
}

/**
 * lyricsText 維：對 lyricsEcho 的字元 bigram 集合算 Jaccard。
 * 都缺 0／一邊缺 0.5；兩邊都在場但都切不出 bigram（單字元）→ 比原字串相等。
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

/** 取單一軸的距離（[0,1]）。 */
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
 * 單一軸在「這一對 take」上是否構成實質差異（門檻見上方 MATERIAL_* 常數表）。
 * 注意與 axisDistance 的差異：門檻語義可能排除「一邊缺值」的 0.5（見表中註解）。
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
      // 只有「兩邊都在場且不同」才算（距離 = 1）；一邊缺的 0.5 不算實質。
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

/** 兩個 take 的加權平均距離（八維，Σ 權重 = 19）。 */
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

/** 描述單一實質差異軸給人看（簡體）。 */
function describeMaterialAxis(axis: TakeAxisName, distance: number): string {
  if (axis === "title") return "标题不同"
  if (axis === "hasLyrics") return "有无歌词不同"
  return `${AXIS_LABELS[axis]}差异 ${Math.round(distance * 100)}%`
}

/**
 * 依放行閘產生一句人話理由（簡體）。
 *   ① 有實質差異軸 → 說明最強的那一軸。
 *   ② 無實質差異但熵過閘 → 差異明顯。
 *   ③ 兩者都不過 → 幾乎一致。
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

/** 單組 take 集合的熵評估。 */
export function evaluateTakeSetEntropy(features: MusicTakeFeature[]): TakeSetEntropy {
  const k = features.length

  const maxEntropyBits = k < 2 ? 0 : Math.log2(k)

  // k<2 無從比較：熵定義為 0，也沒有可比較的軸。
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

  // 逐軸距離矩陣（對角線 0）。同時用於加權距離、實質差異判定與 maxAxisDistance。
  const axisMatrices = {} as Record<TakeAxisName, number[][]>
  for (const axis of TAKE_AXIS_NAMES) {
    axisMatrices[axis] = features.map((a, i) =>
      features.map((b, j) => (i === j ? 0 : axisDistance(axis, a, b))),
    )
  }

  // 距離矩陣（八軸加權平均；對角線 0；索引對齊輸入）。
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

  // 逐軸掃描：軸上最大距離（進 maxAxisDistance）＋是否有任一對達實質門檻。
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

  // 每個 take 的「相異度」 s_i = mean_{j≠i} d(i,j)。
  const distinctness = features.map((_, i) => {
    let sum = 0
    for (let j = 0; j < k; j++) {
      if (j !== i) sum += pairwiseDistances[i][j]
    }
    return sum / (k - 1)
  })

  // 相異度分佈的香農熵（照 spec：w_i = s_i；Σw = 0 → 熵 0）。
  const sumWeights = distinctness.reduce((acc, value) => acc + value, 0)
  let distributionEntropy = 0
  if (sumWeights > EPSILON) {
    for (const weight of distinctness) {
      if (weight <= 0) continue
      const probability = weight / sumWeights
      distributionEntropy -= probability * Math.log2(probability)
    }
  }

  // 平均兩兩距離（幅度校正項）。
  let pairSum = 0
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      pairSum += pairwiseDistances[i][j]
    }
  }
  const meanDistance = pairSum / ((k * (k - 1)) / 2)

  // 為什麼要乘 meanDistance（本檔唯一偏離「純香農熵」之處）：
  // 相異度分佈熵對「整體尺度」不變——只要任兩 take 有非零距離，k=2 恆得
  // H = 1 bit（兩個 take 各 s=0.5），與「這兩版幾乎一樣」互相矛盾。若只用分佈熵，
  // 2026-10-03 真實雙 take（時長差 4.91s、其餘全同）會得到 normalizedEntropy = 1，
  // 永遠問使用者。故乘上平均兩兩距離作幅度校正：
  //   entropyBits = 分佈熵 × meanDistance
  // 這樣「幾乎一樣 → 熵趨近 0、不問」「兩兩最大相異 → meanDistance = 1、
  // 熵回到 log2(k)」，normalizedEntropy = entropyBits / log2(k) 也保持不變。
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
// 選項挑選：從 n 個候選挑 k 個「彼此最相異」
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 從 n 個候選中挑 k 個「彼此最相異」的子集，最大化集合熵。
 * n ≤ 12 用窮舉；n > 12 用貪婪 max-min（先取距離最遠的一對，再逐個取
 * 「到已選集合最小距離」最大者）。回傳被選中的索引（依原陣列順序昇序）。
 */
export function selectEntropyOptions(features: MusicTakeFeature[], k: number): number[] {
  const n = features.length
  if (k <= 0 || n === 0) return []
  if (k >= n) return features.map((_, i) => i)

  // 子集分數 = 該子集的集合熵（entropyBits）。
  const scoreSubset = (indices: number[]): number =>
    evaluateTakeSetEntropy(indices.map((index) => features[index])).entropyBits

  // 決定性比較：分數高者勝；平手時取字典序較小者（輸出穩定可審計）。
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
    // 窮舉所有大小 k 的組合。
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

  // n > 12：貪婪 max-min。先取距離最遠的一對（平手取字典序最小）。
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
// 偏好飽和
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 使用者偏好是否已經飽和（答案分佈太確定 → 再問也問不出資訊）。
 * 回傳 true＝已飽和（不該再問）。count 總和 < 3 一律回 false。
 * 定義：答案分佈正規化熵 < 0.5 視為飽和。
 *
 * 正規化分母採 `log2(相異標籤數)`（＝該標籤數下的最大熵，標準正規化），
 * **不可用 log2(樣本總數)**：樣本越多分母越大，任何分佈都會被判飽和。反例：
 * `[{A:50},{B:50}]`（k=2 的最大不確定）→ H = 1.0 bit、log2(100) = 6.64 →
 * 1.0/6.64 = 0.15 < 0.2，判「已飽和」，完全反了。改用 log2(2) = 1 後得
 * 1.0/1 = 1.0，正確判為未飽和。
 *
 * 相異標籤數 ≤ 1 且 total ≥ 3 → 回 true（單一答案被反覆選中，必然飽和）。
 * 兩條既有斷言在新分母下仍成立：9:1 → 0.469 < 0.5 → true；
 * 3:2:2 → 1.557/1.585 ≈ 0.982 → false。
 */
export function isPreferenceSaturated(history: { label: string; count: number }[]): boolean {
  const samples = history.filter((entry) => Number.isFinite(entry.count) && entry.count > 0)
  const total = samples.reduce((acc, entry) => acc + entry.count, 0)
  if (total < 3) return false

  const distinctLabels = new Set(samples.map((entry) => entry.label)).size
  // 相異標籤數 ≤ 1：分佈完全確定，直接飽和。
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
// 問題建構
// ─────────────────────────────────────────────────────────────────────────────

/** 依 take 的可量測事實組 description（簡體；只放事實，禁評分/主觀形容詞）。 */
function takeDescription(take: MusicTakeFeature): string {
  const title = isPresent(take.title) ? (take.title as string).trim() : "未命名"
  const duration = isFiniteNumber(take.durationSeconds) ? `${take.durationSeconds}s` : "时长未知"
  const lyrics = hasLyrics(take) ? "有词" : "无词"
  return `${title}，${duration}，${lyrics}`
}

/** 把 [0,1] 夾在範圍內。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 為一組 take 建構偏好問題。
 * @param takes 候選 take（≥1）
 * @param opts.maxOptions 最多幾個選項（預設 2，硬上限 4；退路兩條另計但共用同一上限，見下）
 * @param opts.minNormalizedEntropy 熵閘（預設 0.25）：正規化熵低於此＝選項彼此太像＝不問
 * @param opts.preferenceHistory 該使用者過往在此維度的選擇分佈（可選；見下方熵增益）
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
  // 折算：總名額（take 選項 + 兩條退路）≤ 4 ⇒ take 選項 ≤ MAX_TAKE_OPTIONS（= 2）。
  const takeOptionCount = Math.min(maxOptions, takes.length, MAX_TAKE_OPTIONS)

  // 挑「彼此最相異」的 take 選項；單一/空集合照原樣處理。
  const selectedIndices =
    takes.length === 0
      ? []
      : selectEntropyOptions(takes, Math.min(takeOptionCount, takes.length))
  const selectedTakes = selectedIndices.map((index) => takes[index])

  // 熵只對被選中的那 k 個算。
  const entropyBase =
    selectedTakes.length > 0 ? evaluateTakeSetEntropy(selectedTakes) : evaluateTakeSetEntropy([])

  const minNormalizedEntropy = clamp(
    opts?.minNormalizedEntropy ?? DEFAULT_MIN_NORMALIZED_ENTROPY,
    0,
    1,
  )
  const saturated = isPreferenceSaturated(opts?.preferenceHistory ?? [])

  const enoughTakes = takes.length >= 2
  // 兩條放行閘：逐軸實質差異 OR 正規化熵過閘。
  const asked =
    enoughTakes &&
    !saturated &&
    (entropyBase.materialAxes.length > 0 || entropyBase.normalizedEntropy >= minNormalizedEntropy)

  // 最終理由：飽和 > 候選不足 > 兩閘都不過 > 正常（entropyBase.reason 已如實說明走哪條閘）。
  let reason = entropyBase.reason
  if (saturated) {
    reason = "你的偏好已稳定，直接套用，不再打扰"
  } else if (!enoughTakes) {
    reason = entropyBase.reason
  } else if (!asked) {
    // 走到這裡必然：無實質差異軸且熵未過閘。
    reason = "各版本几乎一致，没有可比较的差异"
  }
  const entropy: TakeSetEntropy = { ...entropyBase, reason }

  // take 選項（label A/B/... 對應被選中的 take，依原順序）。
  const options: Array<{ label: string; description?: string }> = []
  const optionTakeUrls: Record<string, string> = {}
  selectedIndices.forEach((takeIndex, position) => {
    const label = TAKE_OPTION_LABELS[position]
    options.push({ label, description: takeDescription(takes[takeIndex]) })
    optionTakeUrls[label] = takes[takeIndex].url
  })

  // 尾端必定追加兩條退路（順序固定：none → trustModel）。
  options.push({ label: FALLBACK_LABELS.none, description: "都不满意，重新生成一批" })
  options.push({ label: FALLBACK_LABELS.trustModel, description: "由模型直接选一版" })

  // 不問時採「保守保留現狀」：沿用主候選（索引 0）。
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
