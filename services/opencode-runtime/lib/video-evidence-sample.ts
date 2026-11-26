import { assert } from "./video-evidence-process"
import { intervalSamples, tileFrameCount, tileSampleTimes } from "./video-evidence-tiles"
import { phraseRanges, type TranscriptWord } from "./video-evidence-transcript"

// ---------------------------------------------------------------------------
// 区间/取样选择（sampleRange / sampleTimes，照它）

export const SAMPLE_OPTIONS = ["--start", "--end", "--at", "--every", "--transcript", "--around", "--occurrence", "--padding"] as const

/** 已解析的取样请求（tool 层把 args 正规化成这个形状；语义与 hypit CLI 选项一一对应）。 */
export interface SampleRequest {
  readonly start?: number
  readonly end?: number
  readonly at?: readonly number[]
  readonly every?: number
  readonly frames?: number
  readonly around?: string
  readonly occurrence?: number
  readonly padding?: number
  readonly words?: readonly TranscriptWord[]
}

export function sampleRange(request: SampleRequest, duration: number): { start: number; end: number } {
  const { around } = request
  if (around !== undefined) {
    const words = request.words
    assert(words !== undefined, "--around requires --transcript")
    assert(request.start === undefined && request.end === undefined, "choose --around or --start/--end")
    const matches = phraseRanges(words, around)
    assert(matches.length > 0, `No timed phrase matches ${JSON.stringify(around)}`)
    assert(matches.length === 1 || request.occurrence !== undefined,
      `The phrase occurs ${matches.length} times: ${matches.map((match, index) => `${index + 1}: ${match.start}–${match.end}s`).join(", ")}. Choose --occurrence <n> or --start/--end.`)
    const occurrence = request.occurrence ?? 1
    assert(Number.isSafeInteger(occurrence) && occurrence >= 1, `--occurrence must be a whole number of at least 1, got ${occurrence}`)
    const match = matches[occurrence - 1]
    assert(match !== undefined, `--occurrence ${occurrence} is beyond the ${matches.length} matches`)
    const padding = request.padding ?? 0.3
    assert(Number.isFinite(padding) && padding >= 0, `--padding must be a non-negative number of seconds, got ${padding}`)
    const start = Math.max(0, round(match.start - padding))
    const end = Math.min(duration, round(match.end + padding))
    assert(end > start, "the phrase lies outside the input media; use its matching transcript")
    return { start, end }
  }
  assert(request.occurrence === undefined && request.padding === undefined, "--occurrence and --padding apply to --around")
  const start = request.start ?? 0
  const end = request.end ?? duration
  assert(Number.isFinite(start) && start >= 0, `--start must be a non-negative number of seconds, got ${request.start}`)
  assert(Number.isFinite(end) && end >= 0, `--end must be a non-negative number of seconds, got ${request.end}`)
  assert(end > start && end <= duration, `range must satisfy 0 <= start < end <= ${duration} s`)
  return { start, end }
}

export function sampleTimes(request: SampleRequest, duration: number, requireEvery = false): number[] {
  const at = request.at
  if (at !== undefined) {
    for (const key of ["start", "end", "every", "frames", "around", "occurrence", "padding"] as const) {
      assert(request[key] === undefined, `--at cannot be combined with --${key}`)
    }
    const times = [...at]
    assert(times.length >= 1 && times.every((time) => Number.isFinite(time)), `--at must list non-negative seconds`)
    assert(times.every((time) => time >= 0), `--at must list non-negative seconds`)
    assert(times.every((time) => time < duration), `a frame time must be before the end of the file (${duration} s)`)
    assert(times.every((time, index) => index === 0 || time > times[index - 1]!), "sample times must be strictly increasing")
    return times
  }
  const { start, end } = sampleRange(request, duration)
  const every = request.every
  assert(every === undefined || request.frames === undefined, "choose --every or --frames")
  assert(!requireEvery || every !== undefined, "frames requires --at <s,s,…> or --every <seconds>")
  if (every !== undefined) assert(Number.isFinite(every) && every >= 0.001, "--every must be at least 0.001 seconds")
  const times = every === undefined
    ? tileSampleTimes(start, end, request.frames ?? tileFrameCount(end - start))
    : intervalSamples(start, end, every)
  assert(times.length > 0 && times.every((time) => time < duration), "the range needs sample times before the media ends")
  assert(times.every((time, index) => index === 0 || time > times[index - 1]!), "sample times must be distinct to the nearest millisecond")
  return times
}
