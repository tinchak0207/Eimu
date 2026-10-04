// 成片字幕分屏切分（把一段台词切成「一屏一句」）— 2026-09-15。
//
// 设计来源 AID（aid-server，MIT，copyright 光子讯息(杭州)科技有限公司）：
//   compose/util/SubtitleScreenSplitter.java（`split` / `rebalanceShortScreens` / `splitByMarks`
//   / `appendPart` / `hasContent` / `splitEvenly`）。本档为 TS 重写（逐行移植，行为对齐）。
// 对齐 PRD 资产表：docs/symdiff-aid-swallow-prd.md §10「字幕分屏算法」。
//
// 产品口径（AID 原文注释）：常规台词保证每屏 7～12 字且尽量落在语义边界；整段不足 7 字原样保留；
// 13 字属无法同时满足上下限的边界情况，会均衡为 7 字 + 6 字两屏。
//
// 与 AID 的**两处显式差异**（本档选择，避免静默偏离）：
//   1. 句内停顿标点补入全角/半角冒号（`：:`）—— 本任务书指定集合为 `，,、：:`（AID 为 `，,、`）。
//   2. `rebalanceShortScreens` 的「合并上限」与「均分硬切上限」用**传入的生效上限 limit**
//      （AID 硬用 MAX_SCREEN_CHARS=12），使「每屏 ≤ maxChars」对 7～12 区间的入参严格成立。
//
// **已知取舍（fuzz 50k 例实测，非 bug）**：AID 的两条口径「每屏 ≤ maxChars」与
// 「非末屏 ≥ MIN(7)」在 combined ∈ (limit, MAX] 区间内**数学上不可同时满足**——例如
// limit=10、combined=11 字：AID 选择回单屏 11 字（守住下限，破配置上限到硬上限 12）；
// 本档选择 splitEvenly → 两屏 6+5（守住「≤ maxChars」，允许非末屏 <7）。
// 取舍依据：任务书把「每屏 ≤ maxChars」列为硬验收项，且字幕超宽对画面的伤害大于短屏。
//
// 输入 `maxChars` 的处理沿用 AID：≤0 取兜底值 10，最终夹在 [7, 12]；即单屏下限 7、上限 12。
// 空/纯空白输入回 `[]`。切分后拼接（去空白）恒等于原文（去空白）—— 不丢字、不变字元。

/** 单屏正文期望最少字数 */
export const SUBTITLE_MIN_SCREEN_CHARS = 7
/** 单屏正文硬性最多字数 */
export const SUBTITLE_MAX_SCREEN_CHARS = 12
/** 单屏最大字数兜底值（入参缺失或非法时使用） */
export const SUBTITLE_DEFAULT_MAX_CHARS = 10

/** 句末标点：一句台词的天然边界，切分后保留在句尾 */
const SENTENCE_END_MARKS = "。！？!?；;…"
/** 句内停顿标点：整句仍超屏时的次级切分点，保留在片段尾部 */
const CLAUSE_MARKS = "，,、：:"
/** 收尾符号：跟在标点后的右引号/右括号等，需与前一片段绑定，避免单符号独占一屏 */
const TRAILING_MARKS = "”』」’）)】]》>\"'"

/** 字数统计：按码点计数，代理对（如 emoji）算一个字（对齐 AID `charCount`）。 */
export function subtitleCharCount(text: string): number {
  return text ? Array.from(text).length : 0
}

/** 按码点切片（对齐 AID `offsetByCodePoints` 语义）。 */
function sliceByCodePoints(text: string, start: number, size: number): string {
  return Array.from(text).slice(start, start + size).join("")
}

/** 判断片段是否含正文字元（非切分标点、非收尾符号、非空白）。 */
function hasContent(part: string): boolean {
  for (const ch of Array.from(part)) {
    if (/\s/.test(ch) || SENTENCE_END_MARKS.includes(ch) || CLAUSE_MARKS.includes(ch) || TRAILING_MARKS.includes(ch)) continue
    return true
  }
  return false
}

/** 收集一个片段：纯标点片段并入前一片段，避免出现没有正文的字幕屏。 */
function appendPart(parts: string[], buffer: { text: string }): void {
  const part = buffer.text.trim()
  buffer.text = ""
  if (!part) return
  if (hasContent(part) || parts.length === 0) parts.push(part)
  else parts[parts.length - 1] = parts[parts.length - 1] + part
}

/** 判断字元是否应跟随在切分点之后（连续标点或收尾符号）。 */
function isBoundaryFollower(ch: string, marks: string): boolean {
  return marks.includes(ch) || TRAILING_MARKS.includes(ch)
}

/** 按指定标点集合切分：标点及其后续的连续标点、收尾符号一并归入前一片段。 */
function splitByMarks(text: string, marks: string): string[] {
  const parts: string[] = []
  const buffer = { text: "" }
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i++) {
    buffer.text += chars[i]
    if (!marks.includes(chars[i])) continue
    // 连续标点与右引号/右括号并入当前片段，防止「！」「」」这类单符号独占一屏
    while (i + 1 < chars.length && isBoundaryFollower(chars[i + 1], marks)) buffer.text += chars[++i]
    appendPart(parts, buffer)
  }
  appendPart(parts, buffer)
  return parts
}

/** 无标点长句均分硬切：切成 ceil(字数/上限) 屏，各屏字数尽量相等，避免末屏只剩一两个字。 */
function splitEvenly(text: string, limit: number): string[] {
  const total = subtitleCharCount(text)
  if (total === 0) return []
  const screens = Math.ceil(total / limit)
  const base = Math.floor(total / screens)
  const extra = total % screens
  const result: string[] = []
  let cursor = 0
  for (let i = 0; i < screens; i++) {
    const size = base + (i < extra ? 1 : 0)
    result.push(sliceByCodePoints(text, cursor, size))
    cursor += size
  }
  return result
}

/**
 * 语义切分产生短屏时，按整行重新均衡，避免画面上连续出现一两个字的字幕。
 * 已满足 7～12 字的语义分屏保持不变；短台词不补字、不跨换行合并。
 */
function rebalanceShortScreens(screens: string[], limit: number): string[] {
  if (screens.length === 0) return screens
  const alreadyBalanced = screens.every((s) => {
    const n = subtitleCharCount(s)
    return n >= SUBTITLE_MIN_SCREEN_CHARS && n <= SUBTITLE_MAX_SCREEN_CHARS
  })
  if (alreadyBalanced) return screens
  const combined = screens.join("")
  if (subtitleCharCount(combined) <= limit) return [combined]
  return splitEvenly(combined, limit)
}

/**
 * 台词分屏切分：换行 → 句末标点 → 句内停顿标点 → 均分硬切。
 *
 * @param text     字幕文本（可含换行，代表多段台词）
 * @param maxChars 单屏优先最大字数（≤0 用兜底值 10，最终夹在 7～12）
 * @returns 按播放顺序排列的字幕片段；入参空白时回 `[]`
 */
export function splitSubtitleForScreens(text: string, maxChars: number = SUBTITLE_DEFAULT_MAX_CHARS): string[] {
  const screens: string[] = []
  if (!text || !text.trim()) return screens
  const configuredLimit = maxChars > 0 ? maxChars : SUBTITLE_DEFAULT_MAX_CHARS
  const limit = Math.max(SUBTITLE_MIN_SCREEN_CHARS, Math.min(configuredLimit, SUBTITLE_MAX_SCREEN_CHARS))
  for (const rawLine of text.split(/\r\n|[\n\r\u2028\u2029]/)) {
    const line = rawLine.trim()
    if (!line) continue
    const lineScreens: string[] = []
    for (const sentence of splitByMarks(line, SENTENCE_END_MARKS)) {
      if (subtitleCharCount(sentence) <= limit) {
        lineScreens.push(sentence)
        continue
      }
      for (const clause of splitByMarks(sentence, CLAUSE_MARKS)) {
        if (subtitleCharCount(clause) <= limit) {
          lineScreens.push(clause)
          continue
        }
        lineScreens.push(...splitEvenly(clause, limit))
      }
    }
    screens.push(...rebalanceShortScreens(lineScreens, limit))
  }
  return screens
}
