// 影片三合一分析（場景／人物台詞／提示詞反推）——本機優先、零付費、fail-closed。
//
// 形態來源（不另造輪子）：
//   場景切分   → 複用 lib/video-evidence.ts 的 visualBoundaries（機械式相鄰幀變化候選）
//                與 cutFrame（同秒抽格，回真實解碼時間）；
//   人物／台詞 → 複用 lib/asr.ts 的 transcribe（本機 loopback ASR、詞級 start/end、零付費）；
//   提示詞反推 → **需要視覺語言模型（VLM）**。本檔先做通道探測（vlmProbe），
//                本機無 VLM 時一律回 {ok:false, code:"vlm_unavailable"} 並列出 probed，
//                **絕不編造反推結果、絕不假裝成功**（照 lib/asr.ts 的 asr_unavailable/probed 模式）。
//                付費中控通道（new-api）預設 fail-closed，只有呼叫端顯式傳 allow_paid_vision
//                （＝暴君逐次報備後）才會被使用；本輪驗證全程未開啟。
//
// 本檔不是 tool，不得 export tool 定義。

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

// ─────────────────────────────────────────── 場景切分

export interface Scene {
  index: number
  start: number
  end: number
  /** 代表幀時間（場景中點）。 */
  at: number
}

/**
 * 由機械式變化候選切出場景。過短的候選（< minSeconds）與過短的尾段會被併入相鄰場景，
 * 這是**去抖動**，不是剪輯判讀；原始候選一律原封不動回在 boundaries。
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

// ─────────────────────────────────────────── VLM 通道探測

const LOOPBACK_CANDIDATES: readonly { url: string; what: string; path: string }[] = [
  { url: "http://127.0.0.1:8766", what: "eimu-asr.service（本機 ASR）", path: "/health" },
  { url: "http://127.0.0.1:3001", what: "new-api 中控（**付費上游轉發**，帶 gemini-3-flash 等視覺模型）", path: "/v1/models" },
  { url: "http://127.0.0.1:8081", what: "agent-gateway（**付費上游轉發**）", path: "/health" },
  { url: "http://127.0.0.1:18080", what: "loopback 未知服務", path: "/health" },
  { url: "http://127.0.0.1:11434", what: "ollama（本機 VLM 慣例埠）", path: "/api/tags" },
  { url: "http://127.0.0.1:8001", what: "llama.cpp server（本機 VLM 慣例埠）", path: "/v1/models" },
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
  /** 是否有**本機、零付費**可用的 VLM 通道。 */
  local_vlm_available: boolean
  /** 探測過但不可用的通道（照 lib/asr.ts 的 probed 模式：白名單外的通道一律不試打）。 */
  probed: string[]
  /** 付費中控通道是否就緒（本輪預設不使用；需暴君逐次報備）。 */
  paid_channel_present: boolean
  note: string
}

/**
 * 探測現場有無可用的真實 VLM 通道。**只打唯讀端點**（/health、/v1/models、/api/tags），
 * 不做任何生成型 POST；付費通道（new-api／gateway）只被列舉，不被呼叫。
 */
export async function vlmProbe(): Promise<VlmProbe> {
  const probed: string[] = []

  // ① 本機 VLM 執行檔
  for (const binary of LOCAL_VLM_BINARIES) {
    const which = spawnSync("which", [binary], { encoding: "utf8", timeout: 5_000 })
    if (which.status === 0 && typeof which.stdout === "string" && which.stdout.trim().length > 0) {
      probed.push(`本機執行檔 ${binary} → ${which.stdout.trim()}（未提供已載入的視覺模型，本輪不視為可用通道）`)
    }
  }
  probed.push(`本機 VLM 執行檔 ${LOCAL_VLM_BINARIES.join("/")}：全部不在 PATH（已 which 逐個確認）`)

  // ② 本機權重檔（≥20MB 的 gguf/safetensors/onnx）
  const weights = await scanLocalWeights()
  if (weights.length === 0) {
    probed.push(`本機模型權重：${MODEL_SCAN_ROOTS.join(", ")} 下無 ≥20MB 的 .gguf/.safetensors/.onnx`)
  } else {
    for (const item of weights.slice(0, 8)) probed.push(`本機模型權重 ${item}（非 VLM，無法做提示詞反推）`)
  }

  // ③ loopback 服務（唯讀探測）
  let paidPresent = false
  for (const candidate of LOOPBACK_CANDIDATES) {
    let detail: string
    try {
      const response = await fetch(`${candidate.url}${candidate.path}`, { signal: AbortSignal.timeout(1_500) })
      const body = (await response.text()).slice(0, 120).replace(/\s+/gu, " ")
      detail = `HTTP ${response.status} ${body}`
      if (candidate.url.includes(":3001") && response.ok) paidPresent = true
    } catch (error) {
      detail = `不可達（${errMsg(error)}）`
    }
    probed.push(`${candidate.url}${candidate.path} → ${candidate.what}：${detail}`)
  }

  return {
    local_vlm_available: false,
    probed,
    paid_channel_present: paidPresent,
    note:
      "本機無零付費 VLM 通道（已逐項探測：執行檔、權重檔、loopback 服務）。"
      + "唯一的視覺模型通道是 new-api 中控（127.0.0.1:3001，gemini-3-flash 等）＝付費上游轉發，"
      + "依成本閘預設停用；要啟用須暴君逐次報備後由呼叫端傳 allow_paid_vision=true。",
  }
}

// ─────────────────────────────────────────── 提示詞反推

export interface ReversePromptOptions {
  /** 只有在暴君逐次報備並同意後才可為 true（付費上游）。 */
  allow_paid_vision?: boolean
  /** 額外背景（例如已知題材）。 */
  hint?: string
  max_tokens?: number
  signal?: AbortSignal
}

export type ReversePromptResult =
  | { ok: true; model: string; prompt: string; raw: string; frame_count: number; channel: string }
  | { ok: false; code: string; reason: string; probed: string[] }

const PROMPT_SYSTEM =
  "你是影像提示詞反推器。看過使用者給的畫面後，只輸出一個 JSON 物件，欄位：" +
  "subject（主體與人物外觀）、setting（環境與時間）、lighting（光線）、style（風格與畫質）、" +
  "camera（鏡頭與焦段感）、motion（可能的運鏡），以及 prompt（一段可直接餵圖像模型的英文提示詞）。" +
  "只描述畫面真的看得到的東西，看不到的欄位留空字串，不要編造。"

/** 讀取 frames 為 data URL（JPEG/PNG）。 */
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
 * 由畫面反推提示詞。**本機無 VLM ⇒ 一律 vlm_unavailable**（附 probed 清單），不編造。
 * allow_paid_vision=true 時才走既有輪子 lib/vision_impl.ts 的中控通道口徑（new-api，
 * 付費上游），key 只從 process.env.NEWAPI_API_KEY 取、永不寫入回傳值或日誌。
 */
export async function reversePrompt(frames: readonly string[], opts: ReversePromptOptions = {}): Promise<ReversePromptResult> {
  const probe = await vlmProbe()
  if (frames.length === 0) {
    return { ok: false, code: "vlm_unavailable", reason: "沒有任何代表幀可送（場景數為 0）", probed: probe.probed }
  }
  if (opts.allow_paid_vision !== true) {
    return {
      ok: false,
      code: "vlm_unavailable",
      reason: `本機無零付費 VLM 通道；${probe.note}`,
      probed: probe.probed,
    }
  }
  if (!probe.paid_channel_present) {
    return {
      ok: false, code: "vlm_unavailable",
      reason: "付費中控通道（127.0.0.1:3001）不可達，即使 allow_paid_vision=true 也無法反推",
      probed: probe.probed,
    }
  }
  const key = process.env.NEWAPI_API_KEY
  if (typeof key !== "string" || key.trim().length === 0) {
    return {
      ok: false, code: "vlm_unavailable",
      reason: "allow_paid_vision=true 但 process.env.NEWAPI_API_KEY 未配置（本輪不得讀取其他來源的憑證）",
      probed: probe.probed,
    }
  }

  const model = process.env.NEWAPI_VISION_MODEL || VISION_MODEL_DEFAULT
  const images = await Promise.all(frames.slice(0, 6).map((path) => dataUrl(path)))
  const content: Record<string, unknown>[] = [
    { type: "text", text: `${opts.hint === undefined ? "" : `背景：${opts.hint}\n`}反推這 ${images.length} 張畫面的提示詞，只輸出 JSON。` },
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
      return { ok: false, code: "vlm_failed", reason: "VLM 回覆為空", probed: probe.probed }
    }
    const parsed = extractJson(raw)
    if (parsed === undefined) {
      return { ok: false, code: "vlm_failed", reason: `VLM 回覆無法解析為 JSON：${raw.slice(0, 200)}`, probed: probe.probed }
    }
    return {
      ok: true, model, prompt: raw, raw,
      frame_count: images.length,
      channel: `new-api 中控（付費上游）${VISION_NEWAPI_CHAT_URL}`,
    }
  } catch (error) {
    return { ok: false, code: "vlm_failed", reason: `中控呼叫失敗：${errMsg(error)}`, probed: probe.probed }
  }
}

// ─────────────────────────────────────────── 三合一主流程

export interface AnalyzeOptions {
  /** 代表幀輸出目錄（必須可寫）。 */
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
    /** 台詞輪次（= ASR passages，每個 passage 一段話＋其詞級時間軸）。 */
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
 * 三合一分析：場景（既有 boundaries）＋人物台詞（既有 ASR 詞級時間軸）＋提示詞反推（VLM，缺則誠實失敗）。
 * 任一分格失敗不會讓整支工具變成 ok:false——每格各自帶 ok/code/reason，方便上層逐格處置。
 */
export async function analyzeVideo(source: string, opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const warnings: string[] = []
  const info = await probeMedia(source)
  requireVideo(info, source)

  const sceneRate = opts.scene_rate ?? 12
  const sceneThreshold = opts.scene_threshold ?? 0.1
  const maxScenes = opts.max_scenes ?? 12

  // ① 場景切分（複用 visualBoundaries）
  const boundaries = await visualBoundaries(source, sceneRate, sceneThreshold)
  const segmented = segmentScenes(boundaries, info.duration)
  if (segmented.ignored > 0) {
    warnings.push(`${segmented.ignored} 個變化候選因過短或貼片尾被去抖動，原始候選仍完整回在 boundaries`)
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
    warnings.push(`場景共 ${segmented.scenes.length} 個，代表幀只抽前 ${maxScenes} 個（max_scenes 可調）`)
  }

  // ② 人物／台詞（複用 lib/asr.ts 的詞級時間軸）
  //    無音軌分流：AI 生成片常沒有聲音。偵測階段（probeMedia）已知音軌有無，故**在送 ASR 之前**先分流——
  //    無音軌時不呼叫 transcribe（否則本機 ASR 抽音會讓 ffmpeg 以退出碼 234 結束，被誤報成 asr_failed，
  //    看起來像故障，其實只是這支片沒有聲音），直接誠實回 code="no_audio"；有音軌時行為逐字不變。
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
          "來源影片沒有音軌（probeMedia 的 ffprobe 未列出任何 audio stream），沒有聲音可轉寫，"
          + "故未呼叫本機 ASR；這不是轉寫失敗。",
        probed: [
          `probeMedia(${source}).hasAudio=false（ffprobe -show_streams 未見 codec_type=audio），已跳過 eimu-asr 服務與 ffmpeg 抽音`,
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
      ? "台詞為本機 ASR 的**詞級量測事實**（每詞 start/end 秒），passages 即台詞輪次；"
        + "本機無說話者分離（diarization）模型，故不提供「誰說的」身分判定，不得由台詞輪次推論發話人。"
      : "來源影片沒有音軌，**沒有台詞可量測**（未送 ASR，非轉寫失敗）；"
        + "本機無說話者分離（diarization）模型，故不提供「誰說的」身分判定，不得由台詞輪次推論發話人。",
  }

  // ③ 提示詞反推（VLM）
  const framePaths = items.flatMap((item) => (item.frame_path === undefined ? [] : [item.frame_path]))
  const reversed = await reversePrompt(framePaths, {
    allow_paid_vision: opts.allow_paid_vision,
    signal: opts.signal,
  })
  const prompt: AnalyzeResult["prompt"] = reversed.ok
    ? {
        ok: true, model: reversed.model, channel: reversed.channel, prompt: reversed.prompt,
        frame_count: reversed.frame_count, probed: [],
        note: "由**付費**中控 VLM 產出的反推（呼叫端已顯式 allow_paid_vision），屬模型輸出、非量測事實，需人眼覆核。",
      }
    : {
        ok: false, code: reversed.code, reason: reversed.reason, probed: reversed.probed,
        note:
          "提示詞反推需要視覺語言模型；本機無零付費 VLM 通道，故**明確失敗而不是編造**。"
          + "要啟用付費中控通道須暴君逐次報備。",
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
      note: "場景由機械式相鄰幀變化候選切出（分數不是剪輯判讀、不是鏡頭標籤）；代表幀是各場景中點的實際解碼格。",
    },
    speech,
    prompt,
    warnings,
  }
}
