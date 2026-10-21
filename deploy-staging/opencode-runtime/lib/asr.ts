// 词级时间轴（ASR）client——照 Hypit 的 transcribe 链形状落地。
//
// 契约（2026-09-28）：
//   ① 客户端只做两件事：抽出 **16 kHz mono PCM s16 WAV**（canonical 输入不重抽），
//      再把那个 staging 路径交给 **loopback 的本机 ASR 服务**（services/asr/，
//      protocol eimu.asr-service@1）。客户端不跑模型、不碰上游、零付费。
//   ② 服务回应把「秒」降一次到 16 kHz 样本边界，这里再换回秒输出；
//      缺时间保持缺（undefined），**不编造 tick**。
//   ③ `language` 不接受 auto/und：服务只收具体语言码。呼叫端给 `auto` 时，本档
//      先用启发式（假名 > max(汉字, ASCII/4) → ja；汉字 > ASCII/4 → zh；否则 en）
//      解析成具体语言并写进 warnings。这是对 Hypit 的合法扩充（它上层要求呼叫端
//      自己先把 auto 解析掉），在此明写。
//
// 失败一律 ok:false ＋ 诚实 code：
//   asr_unavailable / asr_failed / no_speech / too_long / invalid_language / not_16k_mono_wav
//   / no_audio（来源根本没有音轨——AI 生成片常见；ffprobe 实测，不是 ASR 故障。
//     与 video-analyze 层 probeMedia 的 no_audio 同名同义，跨层一致）
// `probed` 放「探测过但不可用」的通道。零付费铁律：任何付费 ASR 通道都不会被试打
// （见 repo AGENTS.md「付费上游呼叫硬闸」）。

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { downloadImage } from "./img-composite"

// ─────────────────────────────────────────── 契约型别

export interface TranscriptWord {
  text: string
  start_seconds?: number
  end_seconds?: number
  score?: number
}

export interface TranscriptPassage {
  text: string
  start_seconds?: number
  end_seconds?: number
  words: TranscriptWord[]
}

export interface TranscriptResult {
  ok: boolean
  format?: "eimu.transcript@1"
  source?: string
  language?: string
  audio_seconds?: number
  passages?: TranscriptPassage[]
  provider?: string
  model?: string
  word_count?: number
  probed?: string[]
  code?: string
  reason?: string
  warnings?: string[]
}

export interface TranscribeOptions {
  language: string
  max_seconds?: number
  signal?: AbortSignal
}

// ─────────────────────────────────────────── 常数（照抄 Hypit 的口径）

const BIN_DIR = "/opt/agent-harness/bin"
const FFMPEG = process.env.FFMPEG_PATH || (existsSync(join(BIN_DIR, "ffmpeg")) ? join(BIN_DIR, "ffmpeg") : "ffmpeg")
const FFPROBE = process.env.FFPROBE_PATH || (existsSync(join(BIN_DIR, "ffprobe")) ? join(BIN_DIR, "ffprobe") : "ffprobe")
const FFPROBE_TIMEOUT_MS = 20_000

/** Hypit `EVIDENCE_SAMPLE_RATE`. */
const EVIDENCE_SAMPLE_RATE = 16_000
const FFMPEG_TIMEOUT_MS = 300_000
const REQUEST_TIMEOUT_MS = 10 * 60_000
const HEALTH_TIMEOUT_MS = 2_000
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024
const TRANSCRIPT_FORMAT = "eimu.transcript@1" as const
const PROTOCOL = "eimu.asr-service@1"

const DEFAULT_SERVICE_URL = process.env.EIMU_ASR_URL || "http://127.0.0.1:8766"
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"]

const PREPARE_HINT =
  "本机 ASR 服务未就绪。先跑 services/asr/prepare.sh（建 venv＋下载模型），" +
  "再启动 services/asr/venv/bin/eimu-asr-service（预设 http://127.0.0.1:8766）。"

function expectedIdentity(): Record<string, unknown> {
  return {
    protocol: PROTOCOL,
    serviceVersion: process.env.EIMU_ASR_EXPECTED_SERVICE_VERSION || "0.1.0",
    model: process.env.EIMU_ASR_MODEL || "small",
    device: process.env.EIMU_ASR_DEVICE || "cpu",
    compute: process.env.EIMU_ASR_COMPUTE || "int8",
    batchSize: Number(process.env.EIMU_ASR_BATCH_SIZE || "8"),
    fasterWhisperVersion: process.env.EIMU_ASR_EXPECTED_FASTER_WHISPER_VERSION || "1.2.1",
  }
}

// ─────────────────────────────────────────── 小工具

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Hypit `round`: 3 位小数。 */
function round(value: number): number {
  return Number(value.toFixed(3))
}

/** Hypit `WhisperX language` 验证：具体小写 2-3 字母语言码，不接受 auto/und。 */
function parseLanguage(value: unknown, subject = "language"): string {
  if (typeof value !== "string" || !/^[a-z]{2,3}$/u.test(value) || value === "und") {
    throw new Error(
      `${subject} must be an explicit lowercase two- or three-letter spoken language code, ` +
      `such as en, zh, or ko; auto and und are not explicit languages`,
    )
  }
  return value
}

/** 对 auto 的合法扩充：依假名/汉字/ASCII 比例判 ja/zh/en（Hypit 上层同款比例法）。 */
export function detectLanguageFromText(text: string): "ja" | "zh" | "en" {
  let kana = 0
  let han = 0
  let ascii = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x31f0 && code <= 0x31ff)) kana += 1
    else if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) han += 1
    else if (code < 0x80 && /[A-Za-z0-9]/u.test(character)) ascii += 1
  }
  if (kana > Math.max(han, ascii / 4)) return "ja"
  if (han > ascii / 4) return "zh"
  return "en"
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function run(exe: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { signal, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`${exe} 逾时 ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")))
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

// ─────────────────────────────────────────── canonical WAV 判定（照抄 Hypit video-cli）

type WavShape = {
  readonly sampleRate: number
  readonly channels: number
  readonly bits: number
  readonly codec: number
  readonly dataBytes: number
}

/** Read a RIFF WAV header; undefined when the bytes are not a WAV file. */
function wavShape(bytes: Uint8Array): WavShape | undefined {
  const fourCc = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (bytes.byteLength < 44 || fourCc(0) !== "RIFF" || fourCc(8) !== "WAVE") return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let format: Omit<WavShape, "dataBytes"> | undefined
  let dataBytes: number | undefined
  while (offset + 8 <= bytes.byteLength) {
    const name = fourCc(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (body + size > bytes.byteLength) return undefined
    if (name === "fmt " && size >= 16) {
      format = {
        codec: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      }
    } else if (name === "data") {
      dataBytes = size
    }
    offset = body + size + (size % 2)
  }
  return format === undefined || dataBytes === undefined ? undefined : { ...format, dataBytes }
}

function canonicalEvidence(shape: WavShape | undefined): shape is WavShape {
  return shape !== undefined && shape.codec === 1 && shape.channels === 1
    && shape.sampleRate === EVIDENCE_SAMPLE_RATE && shape.bits === 16
}

// ─────────────────────────────────────────── 服务回应 → passages（照抄 Hypit whisperx/transcript.ts）

type RawWord = { readonly text?: unknown; readonly word?: unknown; readonly start?: unknown; readonly end?: unknown; readonly score?: unknown }
type RawSegment = { readonly start?: unknown; readonly end?: unknown; readonly words?: unknown }

type SampleWord = {
  text: string
  startSample?: number
  endSampleExclusive?: number
  score?: number
}
type SamplePassage = {
  startSample?: number
  endSampleExclusive?: number
  words: SampleWord[]
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** Lower wire-level seconds once into exact 16 kHz evidence-sample boundaries. */
function sampleWindow(
  startSec: unknown,
  endSec: unknown,
  sampleFrames: number,
): { readonly startSample: number; readonly endSampleExclusive: number } | undefined {
  if (!finite(startSec) || !finite(endSec) || startSec < 0 || endSec < startSec) return undefined
  const startSample = Math.round(startSec * EVIDENCE_SAMPLE_RATE)
  const endSampleExclusive = Math.round(endSec * EVIDENCE_SAMPLE_RATE)
  if (!Number.isSafeInteger(startSample) || !Number.isSafeInteger(endSampleExclusive)
    || startSample > sampleFrames || endSampleExclusive > sampleFrames) return undefined
  return { startSample, endSampleExclusive }
}

function wireWords(value: unknown, sampleFrames: number): SampleWord[] {
  assert(Array.isArray(value), "ASR response has no Word array")
  const result: SampleWord[] = []
  for (const rawValue of value) {
    assert(rawValue !== null && typeof rawValue === "object" && !Array.isArray(rawValue), "ASR response Word is invalid")
    const raw = rawValue as RawWord
    const text = typeof raw.text === "string"
      ? raw.text.trim()
      : typeof raw.word === "string" ? raw.word.trim() : ""
    if (text.length === 0) continue
    const window = sampleWindow(raw.start, raw.end, sampleFrames)
    const score = finite(raw.score) && raw.score >= 0 && raw.score <= 1 ? raw.score : undefined
    result.push({ text, ...(window ?? {}), ...(score === undefined ? {} : { score }) })
  }
  return result
}

function interpretResponse(response: { language?: unknown; segments?: unknown; words?: unknown }, sampleFrames: number): SamplePassage[] {
  assert(Number.isSafeInteger(sampleFrames) && sampleFrames > 0, "ASR evidence sample count must be a positive integer")
  if (Array.isArray(response.segments)) {
    const passages = response.segments.map((rawValue): SamplePassage => {
      assert(rawValue !== null && typeof rawValue === "object" && !Array.isArray(rawValue), "ASR response Segment is invalid")
      const raw = rawValue as RawSegment
      return {
        ...(sampleWindow(raw.start, raw.end, sampleFrames) ?? {}),
        words: raw.words === undefined ? [] : wireWords(raw.words, sampleFrames),
      }
    })
    if (passages.some((passage) => passage.words.length > 0) || response.words === undefined) return passages
  }
  if (response.words !== undefined) {
    const aligned = wireWords(response.words, sampleFrames)
    const first = aligned.find((word) => word.startSample !== undefined)
    const last = [...aligned].reverse().find((word) => word.endSampleExclusive !== undefined)
    return [{
      ...(first?.startSample === undefined ? {} : { startSample: first.startSample }),
      ...(last?.endSampleExclusive === undefined ? {} : { endSampleExclusive: last.endSampleExclusive }),
      words: aligned,
    }]
  }
  throw new Error("ASR response has no Segment or Word array")
}

function secondsFromSample(sample: number | undefined): number | undefined {
  return sample === undefined ? undefined : round(sample / EVIDENCE_SAMPLE_RATE)
}

function passagesInSeconds(passages: SamplePassage[]): TranscriptPassage[] {
  return passages.map((passage) => {
    const words: TranscriptWord[] = passage.words.map((word) => {
      const start = secondsFromSample(word.startSample)
      const end = secondsFromSample(word.endSampleExclusive)
      return {
        text: word.text,
        ...(start === undefined ? {} : { start_seconds: start }),
        ...(end === undefined ? {} : { end_seconds: end }),
        ...(word.score === undefined ? {} : { score: word.score }),
      }
    })
    const start = secondsFromSample(passage.startSample)
    const end = secondsFromSample(passage.endSampleExclusive)
    return {
      text: words.map((word) => word.text).join(" "),
      ...(start === undefined ? {} : { start_seconds: start }),
      ...(end === undefined ? {} : { end_seconds: end }),
      words,
    }
  })
}

// ─────────────────────────────────────────── 本机服务呼叫

interface ServiceIdentity {
  provider: string
  model: string
}

function serviceBaseUrl(): URL {
  const url = new URL(DEFAULT_SERVICE_URL)
  assert(url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname),
    "local ASR client requires a loopback HTTP service")
  return url
}

async function readLimitedJson(response: Response, maxBytes: number, subject: string): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  assert(bytes.byteLength <= maxBytes, `${subject} exceeded the configured response limit`)
  const text = Buffer.from(bytes).toString("utf8")
  if (!response.ok) throw new Error(`${subject} failed with HTTP ${response.status}: ${text.slice(0, 500)}`)
  try {
    const value = JSON.parse(text) as unknown
    assert(value !== null && typeof value === "object" && !Array.isArray(value), `${subject} is invalid`)
    return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(subject)) throw error
    throw new Error(`${subject} returned invalid JSON`)
  }
}

/** Probe `/health` and assert the service identity before any result is accepted. */
async function verifyService(baseUrl: URL, probed: string[]): Promise<{ identity: ServiceIdentity } | { error: string }> {
  let health: Response
  try {
    health = await fetch(`${baseUrl.href.replace(/\/+$/u, "")}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
  } catch (error) {
    probed.push(`local ${baseUrl.origin}/health → ${errMsg(error)}`)
    return { error: `${PREPARE_HINT}（/health 不可达：${errMsg(error)}）` }
  }
  let value: Record<string, unknown>
  try {
    value = await readLimitedJson(health, 64 * 1024, "ASR health")
  } catch (error) {
    probed.push(`local ${baseUrl.origin}/health → ${errMsg(error)}`)
    return { error: `${PREPARE_HINT}（${errMsg(error)}）` }
  }
  const expected = expectedIdentity()
  const mismatch = Object.keys(expected).filter((key) => value[key] !== expected[key])
  if (mismatch.length > 0) {
    probed.push(`local ${baseUrl.origin} 身分不符：${mismatch.map((key) => `${key}=${JSON.stringify(value[key])}≠${JSON.stringify(expected[key])}`).join(", ")}`)
    return {
      error:
        "本机 ASR 服务身分与设定不符：must configure the same model, device, compute, batch size, " +
        "service version and faster-whisper version. A mismatch fails before transcription results are accepted." +
        `（不符栏位：${mismatch.join(", ")}）`,
    }
  }
  return { identity: { provider: `local:${baseUrl.origin}`, model: String(value.model) } }
}

interface ServiceCall {
  ok: boolean
  status: number
  code?: string
  message?: string
  payload?: Record<string, unknown>
  networkError?: string
}

async function callService(
  baseUrl: URL,
  stagedPath: string,
  language: string | null,
  signal: AbortSignal | undefined,
): Promise<ServiceCall> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(`${baseUrl.href.replace(/\/+$/u, "")}/transcribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(language === null ? { audio_path: stagedPath } : { audio_path: stagedPath, language }),
      signal: combined,
    })
  } catch (error) {
    return { ok: false, status: 0, networkError: errMsg(error) }
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    return { ok: false, status: response.status, code: "asr_failed", message: "ASR response exceeded the configured limit" }
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>
  } catch {
    return { ok: false, status: response.status, code: "asr_failed", message: "ASR service returned invalid JSON" }
  }
  if (!response.ok) {
    const error = parsed.error
    const detail = error && typeof error === "object" ? (error as Record<string, unknown>) : {}
    return {
      ok: false,
      status: response.status,
      code: typeof detail.code === "string" ? detail.code : `http_${response.status}`,
      message: typeof detail.message === "string" ? detail.message : `HTTP ${response.status}`,
    }
  }
  return { ok: true, status: response.status, payload: parsed }
}

function mapServiceError(status: number, code: string | undefined, message: string): { code: string; reason: string } {
  if (status === 503 && code === "RESOURCE_NOT_PREPARED") return { code: "asr_unavailable", reason: `${message}｜${PREPARE_HINT}` }
  if (status === 503 && code === "BUSY") return { code: "asr_failed", reason: `服务忙线（503 BUSY）：${message}` }
  if (message.includes("16 kHz mono PCM s16 WAV")) return { code: "not_16k_mono_wav", reason: message }
  if (status === 503) return { code: "asr_unavailable", reason: `${message}｜${PREPARE_HINT}` }
  return { code: "asr_failed", reason: `${code ?? `http_${status}`}: ${message}` }
}

// ─────────────────────────────────────────── 主流程

async function materialize(src: string, workdir: string, signal?: AbortSignal): Promise<Uint8Array> {
  if (/^https?:\/\//iu.test(src)) {
    // 既有轮子：lib/img-composite.ts 的 downloadImage（单一 25MB 上限、60s 逾时）。
    const buffer = await downloadImage(src, signal)
    await writeFile(join(workdir, "source"), buffer)
    return new Uint8Array(buffer)
  }
  if (!src.startsWith("/")) throw new Error("src 必须是绝对路径或 http(s) URL")
  if (!existsSync(src)) throw new Error(`来源档案不存在: ${src}`)
  return new Uint8Array(await readFile(src))
}

/**
 * 来源有没有音轨（ffprobe 实测）。回 null＝探不了（ffprobe 缺席／逾时／读不了档）；
 * 探不了时不改既有行为（照旧抽音，失败再回 asr_failed），不把不确定当成「没有」。
 *
 * 为什么需要：AI 生成片常整片无音轨，ffmpeg 抽音会以退出码 234 回「Invalid argument」，
 * 旧行为把这串原始讯息当 asr_failed 往上丢——呼叫端看到的是故障语言，事实是「本片没有语音」。
 */
async function hasAudioTrack(input: string, signal?: AbortSignal): Promise<boolean | null> {
  try {
    const probe = await run(FFPROBE, [
      "-hide_banner", "-v", "error", "-select_streams", "a",
      "-show_entries", "stream=index", "-of", "csv=p=0", input,
    ], FFPROBE_TIMEOUT_MS, signal)
    if (probe.code !== 0) return null
    return probe.stdout.trim().length > 0
  } catch {
    return null
  }
}

export async function transcribe(src: string, opts: TranscribeOptions): Promise<TranscriptResult> {
  const warnings: string[] = []
  const probed: string[] = []
  const requested = opts.language

  if (typeof src !== "string" || src.length === 0) {
    return { ok: false, code: "asr_failed", reason: "src 必须是本机绝对路径或 http(s) URL", probed, warnings }
  }
  if (requested !== "auto") {
    try {
      parseLanguage(requested)
    } catch (error) {
      return { ok: false, code: "invalid_language", reason: errMsg(error), probed, warnings }
    }
  }

  let workdir: string | null = null
  try {
    let baseUrl: URL
    try {
      baseUrl = serviceBaseUrl()
    } catch (error) {
      return { ok: false, code: "asr_unavailable", reason: `${errMsg(error)}｜${PREPARE_HINT}`, probed, warnings }
    }

    workdir = await mkdtemp(join(tmpdir(), "eimu-transcribe-"))

    // ① 取来源 bytes（URL 走既有轮子）。
    let sourceBytes: Uint8Array
    try {
      sourceBytes = await materialize(src, workdir, opts.signal)
    } catch (error) {
      return { ok: false, source: src, code: "asr_failed", reason: errMsg(error), probed, warnings }
    }

    // ② canonical 输入不重抽；否则逐字照 Hypit 的 ffmpeg 口径抽 16k mono PCM s16。
    const shape = wavShape(sourceBytes)
    let evidenceBytes: Uint8Array
    if (canonicalEvidence(shape)) {
      evidenceBytes = sourceBytes
    } else {
      const target = join(workdir, "speech.wav")
      // 抽音前先探音轨：没有音轨＝本片没有可转写的语音（具名），不是 ASR 故障。
      const input = existsSync(src) && !/^https?:\/\//iu.test(src) ? src : join(workdir, "source")
      if ((await hasAudioTrack(input, opts.signal)) === false) {
        return {
          ok: false, source: src, code: "no_audio",
          reason: "来源没有任何音轨（AI 生成片常见）：本片没有可转写的语音，不是 ASR 故障。"
            + "（ffprobe 实测无 audio stream；未呼叫本机 ASR、未跑 ffmpeg 抽音）",
          probed, warnings,
        }
      }
      let ffmpeg: RunResult
      try {
        ffmpeg = await run(FFMPEG, [
          "-hide_banner", "-loglevel", "error", "-y", "-i", input,
          "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(EVIDENCE_SAMPLE_RATE), "-c:a", "pcm_s16le", "-bitexact", target,
        ], FFMPEG_TIMEOUT_MS, opts.signal)
      } catch (error) {
        return { ok: false, source: src, code: "asr_failed", reason: `ffmpeg 执行失败: ${errMsg(error)}`, probed, warnings }
      }
      if (ffmpeg.code !== 0 || !existsSync(target)) {
        return {
          ok: false, source: src, code: "asr_failed",
          reason: `ffmpeg 抽音失败（退出码 ${ffmpeg.code}）: ${(ffmpeg.stderr.trim().split("\n").pop() ?? "").slice(0, 300)}`,
          probed, warnings,
        }
      }
      evidenceBytes = new Uint8Array(await readFile(target))
      const extracted = wavShape(evidenceBytes)
      if (!canonicalEvidence(extracted)) {
        return { ok: false, source: src, code: "not_16k_mono_wav", reason: "ffmpeg did not produce 16 kHz mono PCM audio", probed, warnings }
      }
    }
    const shapeOfEvidence = wavShape(evidenceBytes)
    const sampleFrames = shapeOfEvidence === undefined ? 0 : shapeOfEvidence.dataBytes / 2
    if (sampleFrames <= 0) {
      return { ok: false, source: src, code: "not_16k_mono_wav", reason: "音讯没有样本框（sample frames ≤ 0）", probed, warnings }
    }
    const audioSeconds = round(sampleFrames / EVIDENCE_SAMPLE_RATE)
    if (typeof opts.max_seconds === "number" && Number.isFinite(opts.max_seconds) && audioSeconds > opts.max_seconds) {
      return {
        ok: false, source: src, language: requested === "auto" ? undefined : requested, audio_seconds: audioSeconds,
        code: "too_long", reason: `音讯长度 ${audioSeconds}s 超过 max_seconds=${opts.max_seconds}s，已拒绝（未截断）`, probed, warnings,
      }
    }

    // ③ 落地进 staging（服务只读它 INPUT_ROOTS 内的档案）。
    const staged = join(workdir, "audio.wav")
    await writeFile(staged, evidenceBytes)

    // ④ 先验服务身分，再送请求。
    const verified = await verifyService(baseUrl, probed)
    if ("error" in verified) {
      return { ok: false, source: src, language: requested === "auto" ? undefined : requested, audio_seconds: audioSeconds, code: "asr_unavailable", reason: verified.error, probed, warnings }
    }

    let language: string
    let call: ServiceCall
    if (requested === "auto") {
      const probe = await callService(baseUrl, staged, null, opts.signal)
      if (!probe.ok) {
        if (probe.networkError) {
          probed.push(`local ${baseUrl.origin}/transcribe → ${probe.networkError}`)
          return { ok: false, source: src, audio_seconds: audioSeconds, code: "asr_unavailable", reason: `${PREPARE_HINT}（/transcribe 不可达：${probe.networkError}）`, probed, warnings }
        }
        const mapped = mapServiceError(probe.status, probe.code, probe.message ?? "")
        return { ok: false, source: src, audio_seconds: audioSeconds, code: mapped.code, reason: mapped.reason, probed, warnings }
      }
      const detected = typeof probe.payload?.language === "string" ? probe.payload.language : undefined
      const text = ((probe.payload?.segments as Array<Record<string, unknown>> | undefined) ?? [])
        .flatMap((segment) => ((segment.words as Array<Record<string, unknown>> | undefined) ?? []))
        .map((word) => String(word.text ?? "")).join(" ")
      const resolved = detectLanguageFromText(text)
      warnings.push(`auto 已解析为 ${resolved}（启发式：假名 > max(汉字, ASCII/4) → ja；汉字 > ASCII/4 → zh；否则 en）；服务自检语言=${detected ?? "?"}`)
      if (resolved === detected) {
        language = resolved
        call = probe
      } else {
        language = resolved
        call = await callService(baseUrl, staged, resolved, opts.signal)
      }
    } else {
      language = requested
      call = await callService(baseUrl, staged, requested, opts.signal)
    }

    if (!call.ok) {
      if (call.networkError) {
        probed.push(`local ${baseUrl.origin}/transcribe → ${call.networkError}`)
        return { ok: false, source: src, language, audio_seconds: audioSeconds, code: "asr_unavailable", reason: `${PREPARE_HINT}（/transcribe 不可达：${call.networkError}）`, probed, warnings }
      }
      const mapped = mapServiceError(call.status, call.code, call.message ?? "")
      return { ok: false, source: src, language, audio_seconds: audioSeconds, code: mapped.code, reason: mapped.reason, probed, warnings }
    }

    // ⑤ 服务回应 → 秒级 passages（缺时间保持缺）。
    let passages: TranscriptPassage[]
    try {
      passages = passagesInSeconds(interpretResponse((call.payload ?? {}) as { language?: unknown; segments?: unknown; words?: unknown }, sampleFrames))
    } catch (error) {
      return { ok: false, source: src, language, audio_seconds: audioSeconds, code: "asr_failed", reason: errMsg(error), probed, warnings }
    }
    const wordCount = passages.reduce((total, passage) => total + passage.words.length, 0)
    const serviceLanguage = typeof call.payload?.language === "string" ? call.payload.language : language
    if (wordCount === 0) {
      return {
        ok: false, format: TRANSCRIPT_FORMAT, source: src, language: serviceLanguage, audio_seconds: audioSeconds,
        passages, provider: verified.identity.provider, model: verified.identity.model, word_count: 0,
        code: "no_speech", reason: `音讯 ${audioSeconds}s 未辨识出任何词（可能无人声或为纯音乐）`, probed, warnings,
      }
    }

    return {
      ok: true,
      format: TRANSCRIPT_FORMAT,
      source: src,
      language: serviceLanguage,
      audio_seconds: audioSeconds,
      passages,
      provider: verified.identity.provider,
      model: verified.identity.model,
      word_count: wordCount,
      ...(probed.length === 0 ? {} : { probed }),
      ...(warnings.length === 0 ? {} : { warnings }),
    }
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") {
      return { ok: false, source: src, code: "asr_failed", reason: "已中止（AbortSignal）", probed, warnings }
    }
    return { ok: false, source: src, code: "asr_failed", reason: errMsg(error), probed, warnings }
  } finally {
    if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Write the seconds-based `eimu.transcript@1` file. Refuses an existing destination. */
export async function writeTranscriptFile(result: TranscriptResult, target: string): Promise<void> {
  assert(result.ok && result.format === TRANSCRIPT_FORMAT && Array.isArray(result.passages),
    "writeTranscriptFile 需要一个成功的 eimu.transcript@1 结果")
  const file = {
    format: TRANSCRIPT_FORMAT,
    source: result.source,
    language: result.language,
    audio_seconds: result.audio_seconds,
    passages: result.passages,
  }
  await mkdir(dirname(target), { recursive: true })
  try {
    await writeFile(target, `${JSON.stringify(file, null, 2)}\n`, { flag: "wx" })
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "EEXIST") {
      throw new Error(`Destination ${target} already exists`)
    }
    throw error
  }
}
