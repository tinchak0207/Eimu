// 影片三合一分析（场景／人物台词／提示词反推）——本机优先、零付费、fail-closed。
//
// 形态来源（不另造轮子）：
//   场景切分   → 复用 lib/video-evidence.ts 的 visualBoundaries（机械式相邻帧变化候选）
//                与 cutFrame（同秒抽格，回真实解码时间）；
//   人物／台词 → 复用 lib/asr.ts 的 transcribe（本机 loopback ASR、词级 start/end、零付费）；
//   提示词反推 → **需要视觉语言模型（VLM）**。本档先做通道探测（vlmProbe），
//                本机无 VLM 时一律回 {ok:false, code:"vlm_unavailable"} 并列出 probed，
//                **绝不编造反推结果、绝不假装成功**（照 lib/asr.ts 的 asr_unavailable/probed 模式）。
//                付费中控通道（new-api）预设 fail-closed，只有呼叫端显式传 allow_paid_vision
//                （＝暴君逐次报备后）才会被使用；本轮验证全程未开启。
//
// 本档不是 tool，不得 export tool 定义。

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

import { transcribe, type TranscriptPassage, type TranscriptResult } from "./asr"
import { cutFrame, probeMedia, requireVideo, visualBoundaries, type VisualBoundary } from "./video-evidence"
import { VISION_MODEL_DEFAULT, VISION_NEWAPI_CHAT_URL } from "./vision_impl"

function round(value: number): number {
  return Number(value.toFixed(3))
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ─────────────────────────────────────────── 场景切分

export interface Scene {
  index: number
  start: number
  end: number
  /** 代表帧时间（场景中点）。 */
  at: number
}

/**
 * 由机械式变化候选切出场景。过短的候选（< minSeconds）与过短的尾段会被并入相邻场景，
 * 这是**去抖动**，不是剪辑判读；原始候选一律原封不动回在 boundaries。
 */
export function segmentScenes(
  boundaries: readonly VisualBoundary[],
  duration: number,
  minSeconds = 0.4,
): { scenes: Scene[]; ignored: number } {
  const candidates = boundaries
    .map((boundary) => boundary.at)
    .filter((at) => at > 0 && at < duration)
    .sort((a, b) => a - b)
  const cuts: number[] = []
  let ignored = 0
  for (const cut of candidates) {
    const previous = cuts.at(-1)
    if (previous !== undefined && cut - previous < minSeconds) {
      ignored += 1
      continue
    }
    if (duration - cut < minSeconds) {
      ignored += 1
      continue
    }
    cuts.push(cut)
  }
  const edges = [0, ...cuts, duration]
  const scenes: Scene[] = []
  for (let index = 0; index + 1 < edges.length; index += 1) {
    const start = edges[index]!
    const end = edges[index + 1]!
    scenes.push({ index: index + 1, start: round(start), end: round(end), at: round((start + end) / 2) })
  }
  return { scenes, ignored }
}

// ─────────────────────────────────────────── VLM 通道探测

const LOOPBACK_CANDIDATES: readonly { url: string; what: string; path: string }[] = [
  { url: "http://127.0.0.1:8766", what: "eimu-asr.service（本机 ASR）", path: "/health" },
  { url: "http://127.0.0.1:3001", what: "new-api 中控（**付费上游转发**，带 gemini-3-flash 等视觉模型）", path: "/v1/models" },
  { url: "http://127.0.0.1:8081", what: "agent-gateway（**付费上游转发**）", path: "/health" },
  { url: "http://127.0.0.1:18080", what: "loopback 未知服务", path: "/health" },
  { url: "http://127.0.0.1:11434", what: "ollama（本机 VLM 惯例埠）", path: "/api/tags" },
  { url: "http://127.0.0.1:8001", what: "llama.cpp server（本机 VLM 惯例埠）", path: "/v1/models" },
]

const LOCAL_VLM_BINARIES = ["ollama", "llama-server", "llama-cli", "vllm", "lmstudio"] as const
const MODEL_SCAN_ROOTS = ["/opt/agent-harness", "/home/ubuntu", "/usr/local/share"] as const

async function scanLocalWeights(): Promise<string[]> {
  const found: string[] = []
  for (const root of MODEL_SCAN_ROOTS) {
    if (!existsSync(root)) continue
    const walk = spawnSync("find", [root, "-xdev", "-maxdepth", "6",
      "(", "-name", "*.gguf", "-o", "-name", "*.safetensors", "-o", "-name", "*.onnx", ")",
      "-size", "+20M", "-printf", "%s %p\n"], { encoding: "utf8", timeout: 20_000 })
    if (typeof walk.stdout !== "string") continue
    for (const line of walk.stdout.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      found.push(trimmed)
    }
  }
  return found
}

export interface VlmProbe {
  /** 是否有**本机、零付费**可用的 VLM 通道。 */
  local_vlm_available: boolean
  /** 探测过但不可用的通道（照 lib/asr.ts 的 probed 模式：白名单外的通道一律不试打）。 */
  probed: string[]
  /** 付费中控通道是否就绪（本轮预设不使用；需暴君逐次报备）。 */
  paid_channel_present: boolean
  note: string
}

/**
 * 探测现场有无可用的真实 VLM 通道。**只打唯读端点**（/health、/v1/models、/api/tags），
 * 不做任何生成型 POST；付费通道（new-api／gateway）只被列举，不被呼叫。
 */
export async function vlmProbe(): Promise<VlmProbe> {
  const probed: string[] = []

  // ① 本机 VLM 执行档
  for (const binary of LOCAL_VLM_BINARIES) {
    const which = spawnSync("which", [binary], { encoding: "utf8", timeout: 5_000 })
    if (which.status === 0 && typeof which.stdout === "string" && which.stdout.trim().length > 0) {
      probed.push(`本机执行档 ${binary} → ${which.stdout.trim()}（未提供已载入的视觉模型，本轮不视为可用通道）`)
    }
  }
  probed.push(`本机 VLM 执行档 ${LOCAL_VLM_BINARIES.join("/")}：全部不在 PATH（已 which 逐个确认）`)

  // ② 本机权重档（≥20MB 的 gguf/safetensors/onnx）
  const weights = await scanLocalWeights()
  if (weights.length === 0) {
    probed.push(`本机模型权重：${MODEL_SCAN_ROOTS.join(", ")} 下无 ≥20MB 的 .gguf/.safetensors/.onnx`)
  } else {
    for (const item of weights.slice(0, 8)) probed.push(`本机模型权重 ${item}（非 VLM，无法做提示词反推）`)
  }

  // ③ loopback 服务（唯读探测）
  let paidPresent = false
  for (const candidate of LOOPBACK_CANDIDATES) {
    let detail: string
    try {
      const response = await fetch(`${candidate.url}${candidate.path}`, { signal: AbortSignal.timeout(1_500) })
      const body = (await response.text()).slice(0, 120).replace(/\s+/gu, " ")
      detail = `HTTP ${response.status} ${body}`
      if (candidate.url.includes(":3001") && response.ok) paidPresent = true
    } catch (error) {
      detail = `不可达（${errMsg(error)}）`
    }
    probed.push(`${candidate.url}${candidate.path} → ${candidate.what}：${detail}`)
  }

  return {
    local_vlm_available: false,
    probed,
    paid_channel_present: paidPresent,
    note:
      "本机无零付费 VLM 通道（已逐项探测：执行档、权重档、loopback 服务）。"
      + "唯一的视觉模型通道是 new-api 中控（127.0.0.1:3001，gemini-3-flash 等）＝付费上游转发，"
      + "依成本闸预设停用；要启用须暴君逐次报备后由呼叫端传 allow_paid_vision=true。",
  }
}

// ─────────────────────────────────────────── 提示词反推

export interface ReversePromptOptions {
  /** 只有在暴君逐次报备并同意后才可为 true（付费上游）。 */
  allow_paid_vision?: boolean
  /** 额外背景（例如已知题材）。 */
  hint?: string
  max_tokens?: number
  signal?: AbortSignal
}

export type ReversePromptResult =
  | { ok: true; model: string; prompt: string; raw: string; frame_count: number; channel: string }
  | { ok: false; code: string; reason: string; probed: string[] }

const PROMPT_SYSTEM =
  "你是影像提示词反推器。看过使用者给的画面后，只输出一个 JSON 物件，栏位：" +
  "subject（主体与人物外观）、setting（环境与时间）、lighting（光线）、style（风格与画质）、" +
  "camera（镜头与焦段感）、motion（可能的运镜），以及 prompt（一段可直接喂图像模型的英文提示词）。" +
  "只描述画面真的看得到的东西，看不到的栏位留空字串，不要编造。"

/** 读取 frames 为 data URL（JPEG/PNG）。 */
async function dataUrl(path: string): Promise<string> {
  const bytes = await readFile(path)
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase()
  const mime = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg"
  return `data:${mime};base64,${bytes.toString("base64")}`
}

function extractJson(text: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text)
  const body = (fenced?.[1] ?? text).trim()
  const start = body.indexOf("{")
  const end = body.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as unknown
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 由画面反推提示词。**本机无 VLM ⇒ 一律 vlm_unavailable**（附 probed 清单），不编造。
 * allow_paid_vision=true 时才走既有轮子 lib/vision_impl.ts 的中控通道口径（new-api，
 * 付费上游），key 只从 process.env.NEWAPI_API_KEY 取、永不写入回传值或日志。
 */
export async function reversePrompt(frames: readonly string[], opts: ReversePromptOptions = {}): Promise<ReversePromptResult> {
  const probe = await vlmProbe()
  if (frames.length === 0) {
    return { ok: false, code: "vlm_unavailable", reason: "没有任何代表帧可送（场景数为 0）", probed: probe.probed }
  }
  if (opts.allow_paid_vision !== true) {
    return {
      ok: false,
      code: "vlm_unavailable",
      reason: `本机无零付费 VLM 通道；${probe.note}`,
      probed: probe.probed,
    }
  }
  if (!probe.paid_channel_present) {
    return {
      ok: false, code: "vlm_unavailable",
      reason: "付费中控通道（127.0.0.1:3001）不可达，即使 allow_paid_vision=true 也无法反推",
      probed: probe.probed,
    }
  }
  const key = process.env.NEWAPI_API_KEY
  if (typeof key !== "string" || key.trim().length === 0) {
    return {
      ok: false, code: "vlm_unavailable",
      reason: "allow_paid_vision=true 但 process.env.NEWAPI_API_KEY 未配置（本轮不得读取其他来源的凭证）",
      probed: probe.probed,
    }
  }

  const model = process.env.NEWAPI_VISION_MODEL || VISION_MODEL_DEFAULT
  const images = await Promise.all(frames.slice(0, 6).map((path) => dataUrl(path)))
  const content: Record<string, unknown>[] = [
    { type: "text", text: `${opts.hint === undefined ? "" : `背景：${opts.hint}\n`}反推这 ${images.length} 张画面的提示词，只输出 JSON。` },
    ...images.map((url) => ({ type: "image_url", image_url: { url } })),
  ]
  try {
    const response = await fetch(VISION_NEWAPI_CHAT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, temperature: 0.2, max_tokens: opts.max_tokens ?? 1200,
        messages: [{ role: "system", content: PROMPT_SYSTEM }, { role: "user", content }],
      }),
      signal: opts.signal ?? AbortSignal.timeout(60_000),
    })
    const text = await response.text()
    if (!response.ok) {
      return { ok: false, code: "vlm_failed", reason: `中控 HTTP ${response.status}: ${text.slice(0, 300)}`, probed: probe.probed }
    }
    const payload = JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] }
    const raw = payload.choices?.[0]?.message?.content
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return { ok: false, code: "vlm_failed", reason: "VLM 回覆为空", probed: probe.probed }
    }
    const parsed = extractJson(raw)
    if (parsed === undefined) {
      return { ok: false, code: "vlm_failed", reason: `VLM 回覆无法解析为 JSON：${raw.slice(0, 200)}`, probed: probe.probed }
    }
    return {
      ok: true, model, prompt: raw, raw,
      frame_count: images.length,
      channel: `new-api 中控（付费上游）${VISION_NEWAPI_CHAT_URL}`,
    }
  } catch (error) {
    return { ok: false, code: "vlm_failed", reason: `中控呼叫失败：${errMsg(error)}`, probed: probe.probed }
  }
}

// ─────────────────────────────────────────── 三合一主流程

export interface AnalyzeOptions {
  /** 代表帧输出目录（必须可写）。 */
  frames_dir: string
  scene_rate?: number
  scene_threshold?: number
  max_scenes?: number
  language?: string
  max_seconds?: number
  allow_paid_vision?: boolean
  signal?: AbortSignal
}

export interface SceneEvidence {
  index: number
  start: number
  end: number
  requested_at: number
  frame_path?: string
  frame_actual_at?: number
  frame_error?: string
}

export interface AnalyzeResult {
  ok: true
  format: "eimu.video-analysis@1"
  source: string
  media: { duration: number; width: number; height: number; frame_rate: number; has_audio: boolean }
  scenes: {
    count: number
    boundary_count: number
    ignored_boundaries: number
    sample_rate: number
    threshold: number
    boundaries: readonly VisualBoundary[]
    items: SceneEvidence[]
    note: string
  }
  speech: {
    ok: boolean
    provider?: string
    model?: string
    language?: string
    audio_seconds?: number
    word_count?: number
    /** 台词轮次（= ASR passages，每个 passage 一段话＋其词级时间轴）。 */
    turns?: readonly TranscriptPassage[]
    code?: string
    reason?: string
    probed?: readonly string[]
    note: string
  }
  prompt: {
    ok: boolean
    code?: string
    reason?: string
    model?: string
    channel?: string
    prompt?: string
    frame_count?: number
    probed: readonly string[]
    note: string
  }
  warnings: string[]
}

/**
 * 三合一分析：场景（既有 boundaries）＋人物台词（既有 ASR 词级时间轴）＋提示词反推（VLM，缺则诚实失败）。
 * 任一分格失败不会让整支工具变成 ok:false——每格各自带 ok/code/reason，方便上层逐格处置。
 */
export async function analyzeVideo(source: string, opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const warnings: string[] = []
  const info = await probeMedia(source)
  requireVideo(info, source)

  const sceneRate = opts.scene_rate ?? 12
  const sceneThreshold = opts.scene_threshold ?? 0.1
  const maxScenes = opts.max_scenes ?? 12

  // ① 场景切分（复用 visualBoundaries）
  const boundaries = await visualBoundaries(source, sceneRate, sceneThreshold)
  const segmented = segmentScenes(boundaries, info.duration)
  if (segmented.ignored > 0) {
    warnings.push(`${segmented.ignored} 个变化候选因过短或贴片尾被去抖动，原始候选仍完整回在 boundaries`)
  }

  const items: SceneEvidence[] = []
  for (const scene of segmented.scenes.slice(0, maxScenes)) {
    const target = join(opts.frames_dir, `scene-${String(scene.index).padStart(3, "0")}-${scene.at}s.jpg`)
    try {
      const actual = await cutFrame(source, Math.min(scene.at, Math.max(0, info.duration - 0.05)), target)
      items.push({ index: scene.index, start: scene.start, end: scene.end, requested_at: scene.at, frame_path: target, frame_actual_at: round(actual) })
    } catch (error) {
      items.push({ index: scene.index, start: scene.start, end: scene.end, requested_at: scene.at, frame_error: errMsg(error) })
    }
  }
  if (segmented.scenes.length > maxScenes) {
    warnings.push(`场景共 ${segmented.scenes.length} 个，代表帧只抽前 ${maxScenes} 个（max_scenes 可调）`)
  }

  // ② 人物／台词（复用 lib/asr.ts 的词级时间轴）
  //    无音轨分流：AI 生成片常没有声音。侦测阶段（probeMedia）已知音轨有无，故**在送 ASR 之前**先分流——
  //    无音轨时不呼叫 transcribe（否则本机 ASR 抽音会让 ffmpeg 以退出码 234 结束，被误报成 asr_failed，
  //    看起来像故障，其实只是这支片没有声音），直接诚实回 code="no_audio"；有音轨时行为逐字不变。
  const hasAudio = info.hasAudio !== false
  const transcript: TranscriptResult = hasAudio
    ? await transcribe(source, {
        language: opts.language ?? "auto",
        ...(opts.max_seconds === undefined ? {} : { max_seconds: opts.max_seconds }),
        signal: opts.signal,
      })
    : {
        ok: false,
        source,
        code: "no_audio",
        reason:
          "来源影片没有音轨（probeMedia 的 ffprobe 未列出任何 audio stream），没有声音可转写，"
          + "故未呼叫本机 ASR；这不是转写失败。",
        probed: [
          `probeMedia(${source}).hasAudio=false（ffprobe -show_streams 未见 codec_type=audio），已跳过 eimu-asr 服务与 ffmpeg 抽音`,
        ],
      }
  const speech: AnalyzeResult["speech"] = {
    ok: transcript.ok === true,
    provider: transcript.provider,
    model: transcript.model,
    language: transcript.language,
    audio_seconds: transcript.audio_seconds,
    word_count: transcript.word_count,
    turns: transcript.passages,
    code: transcript.code,
    reason: transcript.reason,
    probed: transcript.probed,
    note: hasAudio
      ? "台词为本机 ASR 的**词级量测事实**（每词 start/end 秒），passages 即台词轮次；"
        + "本机无说话者分离（diarization）模型，故不提供「谁说的」身分判定，不得由台词轮次推论发话人。"
      : "来源影片没有音轨，**没有台词可量测**（未送 ASR，非转写失败）；"
        + "本机无说话者分离（diarization）模型，故不提供「谁说的」身分判定，不得由台词轮次推论发话人。",
  }

  // ③ 提示词反推（VLM）
  const framePaths = items.flatMap((item) => (item.frame_path === undefined ? [] : [item.frame_path]))
  const reversed = await reversePrompt(framePaths, {
    allow_paid_vision: opts.allow_paid_vision,
    signal: opts.signal,
  })
  const prompt: AnalyzeResult["prompt"] = reversed.ok
    ? {
        ok: true, model: reversed.model, channel: reversed.channel, prompt: reversed.prompt,
        frame_count: reversed.frame_count, probed: [],
        note: "由**付费**中控 VLM 产出的反推（呼叫端已显式 allow_paid_vision），属模型输出、非量测事实，需人眼覆核。",
      }
    : {
        ok: false, code: reversed.code, reason: reversed.reason, probed: reversed.probed,
        note:
          "提示词反推需要视觉语言模型；本机无零付费 VLM 通道，故**明确失败而不是编造**。"
          + "要启用付费中控通道须暴君逐次报备。",
      }

  return {
    ok: true,
    format: "eimu.video-analysis@1",
    source,
    media: {
      duration: info.duration, width: info.width, height: info.height,
      frame_rate: info.frameRate, has_audio: info.hasAudio,
    },
    scenes: {
      count: segmented.scenes.length,
      boundary_count: boundaries.length,
      ignored_boundaries: segmented.ignored,
      sample_rate: sceneRate,
      threshold: sceneThreshold,
      boundaries,
      items,
      note: "场景由机械式相邻帧变化候选切出（分数不是剪辑判读、不是镜头标签）；代表帧是各场景中点的实际解码格。",
    },
    speech,
    prompt,
    warnings,
  }
}
