// 成片字幕分屏切分（把一段台詞切成「一屏一句」）— 2026-09-15。
//
// 設計來源 AID（aid-server，MIT，copyright 光子讯息(杭州)科技有限公司）：
//   compose/util/SubtitleScreenSplitter.java（`split` / `rebalanceShortScreens` / `splitByMarks`
//   / `appendPart` / `hasContent` / `splitEvenly`）。本檔為 TS 重寫（逐行移植，行為對齊）。
// 對齊 PRD 資產表：docs/symdiff-aid-swallow-prd.md §10「字幕分屏算法」。
//
// 產品口徑（AID 原文注釋）：常規台詞保證每屏 7～12 字且盡量落在語義邊界；整段不足 7 字原樣保留；
// 13 字屬無法同時滿足上下限的邊界情況，會均衡為 7 字 + 6 字兩屏。
//
// 與 AID 的**兩處顯式差異**（本檔選擇，避免靜默偏離）：
//   1. 句內停頓標點補入全角/半角冒號（`：:`）—— 本任務書指定集合為 `，,、：:`（AID 為 `，,、`）。
//   2. `rebalanceShortScreens` 的「合併上限」與「均分硬切上限」用**傳入的生效上限 limit**
//      （AID 硬用 MAX_SCREEN_CHARS=12），使「每屏 ≤ maxChars」對 7～12 區間的入參嚴格成立。
//
// **已知取捨（fuzz 50k 例實測，非 bug）**：AID 的兩條口徑「每屏 ≤ maxChars」與
// 「非末屏 ≥ MIN(7)」在 combined ∈ (limit, MAX] 區間內**數學上不可同時滿足**——例如
// limit=10、combined=11 字：AID 選擇回單屏 11 字（守住下限，破配置上限到硬上限 12）；
// 本檔選擇 splitEvenly → 兩屏 6+5（守住「≤ maxChars」，允許非末屏 <7）。
// 取捨依據：任務書把「每屏 ≤ maxChars」列為硬驗收項，且字幕超寬對畫面的傷害大於短屏。
//
// 輸入 `maxChars` 的處理沿用 AID：≤0 取兜底值 10，最終夾在 [7, 12]；即單屏下限 7、上限 12。
// 空/純空白輸入回 `[]`。切分後拼接（去空白）恆等於原文（去空白）—— 不丟字、不變字元。

/** 單屏正文期望最少字數 */
export const SUBTITLE_MIN_SCREEN_CHARS = 7
/** 單屏正文硬性最多字數 */
export const SUBTITLE_MAX_SCREEN_CHARS = 12
/** 單屏最大字數兜底值（入參缺失或非法時使用） */
export const SUBTITLE_DEFAULT_MAX_CHARS = 10

/** 句末標點：一句台詞的天然邊界，切分後保留在句尾 */
const SENTENCE_END_MARKS = "。！？!?；;…"
/** 句內停頓標點：整句仍超屏時的次級切分點，保留在片段尾部 */
const CLAUSE_MARKS = "，,、：:"
/** 收尾符號：跟在標點後的右引號/右括號等，需與前一片段綁定，避免單符號獨佔一屏 */
const TRAILING_MARKS = "”』」’）)】]》>\"'"

/** 字數統計：按碼點計數，代理對（如 emoji）算一個字（對齊 AID `charCount`）。 */
export function subtitleCharCount(text: string): number {
  return text ? Array.from(text).length : 0
}

/** 按碼點切片（對齊 AID `offsetByCodePoints` 語義）。 */
function sliceByCodePoints(text: string, start: number, size: number): string {
  return Array.from(text).slice(start, start + size).join("")
}

/** 判斷片段是否含正文字元（非切分標點、非收尾符號、非空白）。 */
function hasContent(part: string): boolean {
  for (const ch of Array.from(part)) {
    if (/\s/.test(ch) || SENTENCE_END_MARKS.includes(ch) || CLAUSE_MARKS.includes(ch) || TRAILING_MARKS.includes(ch)) continue
    return true
  }
  return false
}

/** 收集一個片段：純標點片段併入前一片段，避免出現沒有正文的字幕屏。 */
function appendPart(parts: string[], buffer: { text: string }): void {
  const part = buffer.text.trim()
  buffer.text = ""
  if (!part) return
  if (hasContent(part) || parts.length === 0) parts.push(part)
  else parts[parts.length - 1] = parts[parts.length - 1] + part
}

/** 判斷字元是否應跟隨在切分點之後（連續標點或收尾符號）。 */
function isBoundaryFollower(ch: string, marks: string): boolean {
  return marks.includes(ch) || TRAILING_MARKS.includes(ch)
}

/** 按指定標點集合切分：標點及其後續的連續標點、收尾符號一併歸入前一片段。 */
function splitByMarks(text: string, marks: string): string[] {
  const parts: string[] = []
  const buffer = { text: "" }
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i++) {
    buffer.text += chars[i]
    if (!marks.includes(chars[i])) continue
    // 連續標點與右引號/右括號併入當前片段，防止「！」「」」這類單符號獨佔一屏
    while (i + 1 < chars.length && isBoundaryFollower(chars[i + 1], marks)) buffer.text += chars[++i]
    appendPart(parts, buffer)
  }
  appendPart(parts, buffer)
  return parts
}

/** 無標點長句均分硬切：切成 ceil(字數/上限) 屏，各屏字數盡量相等，避免末屏只剩一兩個字。 */
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
 * 語義切分產生短屏時，按整行重新均衡，避免畫面上連續出現一兩個字的字幕。
 * 已滿足 7～12 字的語義分屏保持不變；短台詞不補字、不跨換行合併。
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
 * 台詞分屏切分：換行 → 句末標點 → 句內停頓標點 → 均分硬切。
 *
 * @param text     字幕文本（可含換行，代表多段台詞）
 * @param maxChars 單屏優先最大字數（≤0 用兜底值 10，最終夾在 7～12）
 * @returns 按播放順序排列的字幕片段；入參空白時回 `[]`
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
