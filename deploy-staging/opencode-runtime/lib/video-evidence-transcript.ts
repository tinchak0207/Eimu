import { readFile } from "node:fs/promises"
import { assert } from "./video-evidence-process"

// ---------------------------------------------------------------------------
// transcript（transcript.ts）：每词必须有 text；缺时间的词保持缺，不编造。

/** 我方格式名（栏位名照 hypit：passages[].words[].{text,start_seconds,end_seconds}）。 */
export const TRANSCRIPT_FORMAT = "eimu.transcript@1"

export type TranscriptWord = {
  readonly text: string
  readonly start?: number
  readonly end?: number
}

export type FrameWords = {
  readonly active: TranscriptWord[]
  readonly context: TranscriptWord[]
}

/** 验证一份已解析的 transcript 物件（inline JSON 与档案共用同一套验证）。 */
export function parseTranscript(rawIn: unknown, label: string): TranscriptWord[] {
  const raw = rawIn as { format?: unknown; passages?: unknown }
  assert(raw?.format === TRANSCRIPT_FORMAT, `${label}: expected ${TRANSCRIPT_FORMAT}`)
  assert(Array.isArray(raw.passages), `${label}: expected ${TRANSCRIPT_FORMAT}`)
  return (raw.passages as { words?: unknown }[]).flatMap((passage) => {
    assert(passage !== null && Array.isArray(passage.words), `${label}: each passage needs words`)
    return (passage.words as Record<string, unknown>[]).map((word) => {
      assert(word !== null && typeof word.text === "string", `${label}: each word needs text`)
      const start = word.start_seconds
      const end = word.end_seconds
      assert(start === undefined || (typeof start === "number" && Number.isFinite(start) && start >= 0), `${label}: invalid word start`)
      assert(end === undefined || (typeof end === "number" && Number.isFinite(end) && end >= 0), `${label}: invalid word end`)
      assert(start === undefined || end === undefined || (end as number) >= (start as number), `${label}: word end precedes start`)
      return { text: word.text as string, ...(start === undefined ? {} : { start: start as number }), ...(end === undefined ? {} : { end: end as number }) }
    })
  })
}

export async function readTranscript(path: string): Promise<TranscriptWord[]> {
  return parseTranscript(JSON.parse(await readFile(path, "utf8")) as unknown, path)
}

export function wordsAt(words: readonly TranscriptWord[], at: number): FrameWords {
  const active = words.filter((word) => word.start !== undefined && word.end !== undefined && word.start <= at && at < word.end)
  let anchor = active.length > 0 ? words.indexOf(active[0]!) : -1
  if (anchor < 0) {
    let distance = Infinity
    for (const [index, word] of words.entries()) {
      const time = word.start ?? word.end
      if (time !== undefined && Math.abs(time - at) < distance) { anchor = index; distance = Math.abs(time - at) }
    }
  }
  const last = active.length > 0 ? words.indexOf(active.at(-1)!) : anchor
  return { active, context: anchor < 0 ? [] : words.slice(Math.max(0, anchor - 3), last + 4) }
}

function searchable(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "")
}

/** 找出整段连续的转写词；标点与大小写不影响比对。 */
export function phraseRanges(words: readonly TranscriptWord[], text: string): { start: number; end: number }[] {
  const query = searchable(text)
  assert(query.length > 0, "--around needs a word or phrase")
  const matches: { start: number; end: number }[] = []
  for (let first = 0; first < words.length; first += 1) {
    if (searchable(words[first]!.text).length === 0) continue
    let joined = ""
    for (let last = first; last < words.length && joined.length < query.length; last += 1) {
      joined += searchable(words[last]!.text)
      if (joined !== query) continue
      const start = words[first]!.start
      const end = words[last]!.end
      assert(start !== undefined && end !== undefined, `The phrase ${JSON.stringify(text)} has missing boundary times; inspect its passage and choose --start/--end`)
      matches.push({ start, end })
    }
  }
  return matches
}
