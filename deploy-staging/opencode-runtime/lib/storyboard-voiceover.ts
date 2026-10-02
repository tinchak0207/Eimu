// 分鏡逐鏡配音（harness 側 lib；2026-09-30）。
//
// 病歷 `tts-multiline-narration-p2-bug`：60s 片「旁白貫穿鏡 1-6」，agent 只送單段台詞生成
// 一條 25s 音軌 → 成片後 35s 無聲。**真根因不是 TTS**：逐行真 TTS 的生產者早就存在＝
// `tools/audio_first_timeline.ts`（逐行呼叫 gateway `/agent/v1/tts` → 下載 mp3 → ffprobe
// **實測**時長 → 累計 `offset_ms` 錨點 → 回報 `cost_coins`；上游不可用整批 fail 不編造）。
// 缺的是**兩跳**：① 台詞表不是從分鏡確定性推出來的（由 LLM 自由產 → 摺成一句）；
// ② 回傳從不寫回分鏡（`narrationAudioId`/`dialogueAudioId`/`audioAnchorId` 全庫無生產者）。
//
// 本檔＝那兩跳。形狀照本專案「禁造輪子」：**引擎逐行複製** `audio_first_timeline.ts`
// （TTS 呼叫／下載／ffprobe／offset 累加／誠實失敗語義**一行不動**），只換兩處白名單：
//   ① **輸入源**：從「tool 的 `script` 字串」→「從畫布快照的分鏡節點導出（每鏡每欄位恰好一行）」
//   ② **出口**：從「只回 timeline JSON」→「回 timeline ＋ 寫回分鏡節點音軌」
//
// 此檔不是 tool，不得 export tool 定義，故放 tools/ 之外（同 lib/canvas-flow.ts 慣例）。
//
// ── 上游工具（被複製的輪子）的真實契約，逐字讀完照抄，不猜 ──
//   · 每行回 `{index, role, text, offset_ms, audio_url, duration_ms, cost_coins?, error?,
//     duration_note?}`；`duration_ms` 由 ffprobe **實測**，單行探測失敗回 `null`（不冒充）；
//     `tts_unavailable` 整批 fail（不返半成品）。
//   · `max_lines`：**默認 20、硬上限 50**，超出**截斷**並回 `truncated`。⇒ 本層每一批都
//     **顯式帶** `maxLines = 該批實際行數`（見 `planBatches`），否則 21..50 行會被默認 20
//     靜默截斷＝後半段沒聲而工具回成功。>50 行本層**具名拒**，不代為截斷（截斷＝假成功）。
//   · `speed` 上游未支持語速控制、傳入不生效 ⇒ 本層**不在 `speed` 上做任何文章**。
//
// ── 為何用「本地平行 `source`」而不把鏡號塞進 `role`/`text` ──
//   `text` 是**送去合成**的內容（會真的被唸出來）；把鏡號塞進 `text` ＝ 配音真的把鏡號唸出來。
//   且上游只保證「回傳陣列與送入行序一一對應」，不保證把 role 逐字回傳。故鏡號只留在本地
//   `source`（與 timeline 同索引的平行陣列），回寫／比對一律 `timeline[i]` ↔ `source[i]`。
//   `role` 只填欄位名（`dialogue`/`narration`），與站點側 `storyboard-audio-bridge.ts` 同口徑。
//
// ── 不做的加工（附理由，避免下游誤以為漏做）──
//   · **不切分 `dialogue` 的 `[角色]：「…」` 標記**（`storyboard-contract.ts` 已裁定該格式
//     **無契約文件**，硬套＝自造轉換）→ text **逐字照送**。
//   · **不從 `dialogue` 猜旁白**（同檔裁定逐字）：旁白只有 `narration` 欄，沒有就沒有。
//   · **不自造音頻 URL 判準**：`usableAudioUrl` 逐字照抄站點側 `agent-output-cards.ts`
//     （harness 不能 import 站點模組，語義必須同口徑：`http(s)` + 副檔名白名單，或 `data:audio/`）；
//     `audioAnchorId` 的規則照 `storyboard-shots.bindShotAudioTrack`＝`dialogueAudioId || narrationAudioId`。

import { spawn } from "node:child_process"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { randomBytes } from "node:crypto"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"
// 靜態 ffprobe（johnvansickle build）：URL 直讀會段錯誤，必須先下載到本地檔再探。
const FFPROBE = "/opt/agent-harness/bin/ffprobe"
const RUN_DIR = "/opt/agent-harness/workspace/.run"

// ─────────────────────────────────────────── 引擎（逐行複製 audio_first_timeline.ts）

export interface VoiceoverLine {
  role: string
  text: string
}

/** timeline 的一項（欄位名與上游逐字相同）。 */
export interface VoiceoverTimelineEntry {
  index: number
  role: string | null
  text: string
  offset_ms: number
  audio_url: string | null
  duration_ms: number | null
  cost_coins?: number
  error?: string
  duration_note?: string
}

export interface SynthesizeOptions {
  /** 逐行呼叫 gateway `/agent/v1/tts` 的 Bearer（＝呼叫端解析出的 sk-biz-*，本檔不碰解析）。 */
  key: string
  voice?: string
  speed?: number
  gapMs?: number
  /** 本批行數上限（**必須顯式帶＝本批實際行數**，否則默認 20 靜默截斷）。 */
  maxLines?: number
  signal?: AbortSignal
}

export type SynthesizeResult =
  | {
      ok: true
      timeline: VoiceoverTimelineEntry[]
      total_duration_ms: number
      total_cost_coins: number
      lines_requested: number
      lines_processed: number
      probed_count: number
      truncated: boolean
      speed_note: string | null
    }
  | {
      ok: false
      /** 誠實失敗碼（當前唯一＝`tts_unavailable`）。 */
      code: string
      hint: string
      timeline: VoiceoverTimelineEntry[]
      probed_count: number
    }

/** ffprobe 實測本地音頻檔時長（秒）。失敗回 null，不編造。（逐行複製自 audio_first_timeline.ts） */
function probeDurationSec(file: string, signal?: AbortSignal): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: number | null) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    const child = spawn(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], {
      env: { PATH: "/opt/agent-harness/bin:/usr/local/bin:/usr/bin:/bin", HOME: "/opt/agent-harness/workspace", LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (err += d))
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      done(null)
    }, 30_000)
    const onAbort = () => {
      child.kill("SIGKILL")
      done(null)
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true })
    child.on("error", () => {
      clearTimeout(timer)
      done(null)
    })
    child.on("close", () => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener("abort", onAbort)
      const sec = Number(out.trim())
      done(Number.isFinite(sec) && sec > 0 ? sec : null)
    })
  })
}

/**
 * 逐行真 TTS → ffprobe 實測 → 累計 offset 錨點。
 *
 * **引擎逐行複製 `tools/audio_first_timeline.ts` 的 execute 主體**，唯一差異：
 * 輸入從「tool `args.script` 解析出的 lines」變成「呼叫端已確定性導出的 lines」，
 * 以及回傳改成可再包一層的結構（tool 薄 wrapper / e2e 直調共用同一支）。
 * TTS 呼叫形狀、下載、ffprobe、offset 累加、`speed_note`、`tts_unavailable` 整批 fail
 * 語義全部逐字等價，一行不動。
 */
export async function synthesizeTimeline(
  lines: readonly VoiceoverLine[],
  opts: SynthesizeOptions,
): Promise<SynthesizeResult> {
  const maxLines = opts.maxLines ?? 20
  const truncated = lines.length > maxLines
  const work = lines.slice(0, maxLines)
  const gapMs = opts.gapMs ?? 0

  const dir = `${RUN_DIR}/a4t-${Date.now()}-${randomBytes(4).toString("hex")}`
  await mkdir(dir, { recursive: true }).catch(() => {})

  const timeline: VoiceoverTimelineEntry[] = []
  let offsetMs = 0
  let totalCost = 0
  let anyUnavailable: { code: string; hint: string } | null = null
  let probedCount = 0

  try {
    for (let i = 0; i < work.length; i++) {
      const line = work[i]
      const entry: VoiceoverTimelineEntry = {
        index: i,
        role: line.role || null,
        text: line.text,
        offset_ms: offsetMs,
        audio_url: null,
        duration_ms: null,
      }
      // 1) 調 TTS（復用 tts_speak 上游調法）
      let ttsResp: Response
      try {
        ttsResp = await fetch(`${GATEWAY}/agent/v1/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.key}` },
          body: JSON.stringify({
            text: line.text,
            ...(opts.voice ? { voice: opts.voice } : {}),
            ...(opts.speed !== undefined ? { speed: opts.speed } : {}),
          }),
          signal: opts.signal,
        })
      } catch (e: any) {
        entry.audio_url = null
        entry.duration_ms = null
        entry.error = `network_error: ${e?.message ?? e}`
        timeline.push(entry)
        continue
      }
      const data = (await ttsResp.json().catch(() => ({}))) as {
        ok?: boolean
        url?: string
        chars?: number
        cost_coins?: number
        error?: { message?: string; code?: string }
      }
      if (!ttsResp.ok || !data?.ok || !data.url) {
        const code = data?.error?.code || `http_${ttsResp.status}`
        const hint = data?.error?.message || `TTS 請求失敗（HTTP ${ttsResp.status}）`
        if (code === "tts_unavailable") {
          anyUnavailable = { code, hint }
          // 上游整體不可用：後續行不再逐行撞牆，如實中斷
          entry.audio_url = null
          entry.duration_ms = null
          entry.error = code
          timeline.push(entry)
          break
        }
        entry.audio_url = null
        entry.duration_ms = null
        entry.error = `${code}: ${hint}`
        timeline.push(entry)
        continue
      }
      entry.audio_url = data.url
      entry.cost_coins = data.cost_coins ?? 0
      totalCost += data.cost_coins ?? 0

      // 2) 下載 mp3 到本地檔 → ffprobe 實測（URL 直探會段錯誤）
      let durationMs: number | null = null
      try {
        const audio = await fetch(data.url, { signal: opts.signal ?? AbortSignal.timeout(30_000) })
        if (audio.ok) {
          const buf = Buffer.from(await audio.arrayBuffer())
          if (buf.length > 0) {
            const f = `${dir}/line_${i}.mp3`
            await writeFile(f, buf)
            const sec = await probeDurationSec(f, opts.signal)
            if (sec !== null) {
              durationMs = Math.round(sec * 1000)
              probedCount++
            }
          }
        }
      } catch {
        /* durationMs 保持 null，誠實標注 */
      }
      entry.duration_ms = durationMs
      if (durationMs === null) entry.duration_note = "ffprobe 探測失敗，未編造時長"
      else offsetMs += durationMs + gapMs
      timeline.push(entry)
    }
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  // 上游整體不可用：誠實失敗，不返回半成品時間軸冒充成功
  if (anyUnavailable && probedCount === 0) {
    return { ok: false, code: anyUnavailable.code, hint: anyUnavailable.hint, timeline, probed_count: probedCount }
  }

  const totalDurationMs = offsetMs - (timeline.length ? gapMs : 0)// 末行不補尾間隔
  return {
    ok: true,
    timeline,
    total_duration_ms: Math.max(0, totalDurationMs),
    total_cost_coins: Math.round(totalCost * 1e6) / 1e6,
    lines_requested: lines.length,
    lines_processed: timeline.length,
    probed_count: probedCount,
    truncated,
    speed_note: opts.speed !== undefined ? "speed 已傳入但當前上游未支持語速控制，不生效" : null,
  }
}

// ─────────────────────────────────────────── 上限與門檻（站點側 storyboard-audio-bridge.ts 同值）

/** 上游工具硬上限（行）。超過＝具名拒，**不代為截斷**（截斷＝後半段沒聲且使用者看不出來）。 */
export const VOICEOVER_TOOL_MAX_LINES = 50
/** 上游工具默認 `max_lines`。不顯式覆蓋就會被截到 20 ⇒ 每批都必須顯式帶 `maxLines`。 */
export const VOICEOVER_TOOL_DEFAULT_MAX_LINES = 20
/** 逐鏡時長漂移門檻（秒）；理由見站點側同檔（0.5s 足以分開「整段沒合成」與「逐句正常抖動」）。 */
export const DURATION_DRIFT_THRESHOLD_SEC = 0.5

/** 每鏡輪詢兩欄位的固定順序（決定行序＝偏移序）。對白先於旁白，對齊錨優先序。 */
const AUDIO_FIELD_ORDER = ["dialogue", "narration"] as const

export type ShotAudioField = "dialogue" | "narration"

// ─────────────────────────────────────────── 音頻可用性（逐字照抄站點側 usableAudioUrl）

const AUDIO_URL_EXTENSIONS = [".mp3", ".m4a", ".wav", ".aac", ".ogg", ".opus", ".flac", ".webm"] as const

/**
 * 音頻交付物判定（逐字複製站點側 `@/lib/agent-output-cards` 的 `usableAudioUrl`；
 * harness 無法 import 站點模組，語義必須同口徑，否則回寫會與站點側判準分叉）：
 *   - `data:audio/…` → 收；其他 `data:` → null
 *   - `http(s)://` 且**路徑**（先剝 `?query`/`#fragment`）落在音頻副檔名白名單 → 收
 *   - 其餘（`.png` 圖 URL、無副檔名裸 URL、本地路徑）→ null
 */
export function usableAudioUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  const clean = value.trim()
  if (!clean) return null
  if (clean.startsWith("data:")) return clean.startsWith("data:audio/") ? clean : null
  if (!clean.startsWith("http")) return null
  const path = clean.split("#")[0].split("?")[0].toLowerCase()
  return AUDIO_URL_EXTENSIONS.some((ext) => path.endsWith(ext)) ? clean : null
}

// ─────────────────────────────────────────── 資料形狀

/**
 * 分鏡（本層輸入投影；不綁 CanvasNode 形狀，另帶回寫需要的 `nodeId`）：
 *   · `nodeId`        ← `node.id`（回寫 `update_node` 的落點；harness 獨有，站點側不需要）
 *   · `shotNumber`    ← `node.metadata.storyboardShot.shotNumber`（鏡唯一鍵，契約保證非空）
 *   · `dialogue`      ← `node.metadata.storyboardShot.dialogue`（單一字串，逐字照送）
 *   · `narration`     ← `node.metadata.narration`（旁白文本；**不從 dialogue 猜**）
 *   · `durationSeconds` ← `metadata.durationSeconds` 或 `metadata.storyboardShot.durationSeconds`
 *                        （計畫秒數；兩處皆無＝誠實缺＝null，**不推算**）
 *   · 三個音軌鍵      ← 同名 metadata 鍵（回寫落點；錨＝`dialogueAudioId || narrationAudioId`）
 */
export interface StoryboardVoiceoverShot {
  nodeId: string
  shotNumber: string
  dialogue?: string
  narration?: string
  durationSeconds?: number | null
  dialogueAudioId?: string
  narrationAudioId?: string
  audioAnchorId?: string
}

/** 台詞表的本地平行陣列一項：第 i 行屬於哪一鏡的哪一欄位（鏡號不進 `role`/`text`）。 */
export interface VoiceoverSourceRef {
  shotNumber: string
  field: ShotAudioField
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined
}

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** 鏡號的自然序比較（`鏡2` < `鏡10`）；非數字時退回字串比較。確定性用。 */
function compareShotNumber(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
}

/**
 * 從 gateway 快照的 **raw `state`** 導出分鏡陣列。
 *
 * ⚠️ 呼叫端**必須傳 raw `state`，不准先過 `compactCanvasState`**——後者會把超長文本截斷
 * （`truncateText` 240→120），截斷＝台詞被腰斬，是本工具的命門。
 *
 * 判準＝`metadata.storyboardShot.shotNumber` 非空（與站點側 `isStoryboardShotNode` 同口徑）；
 * 缺 `node.id` 的項略過（沒有回寫落點，不臆造 id）。回傳按鏡號自然序排序＝**確定性行序**。
 */
export function readStoryboardShots(state: unknown): StoryboardVoiceoverShot[] {
  const s = asRecord(state)
  const nodes = s && Array.isArray(s.nodes) ? s.nodes : []
  const shots: StoryboardVoiceoverShot[] = []
  for (const raw of nodes) {
    const n = asRecord(raw)
    if (!n) continue
    const meta = asRecord(n.metadata) ?? {}
    const sb = asRecord(meta.storyboardShot)
    if (!sb) continue
    const shotNumber = nonEmptyString(sb.shotNumber)
    if (!shotNumber) continue
    const nodeId = nonEmptyString(n.id)
    if (!nodeId) continue
    const planned = finiteNumber(meta.durationSeconds) ?? finiteNumber(sb.durationSeconds)
    shots.push({
      nodeId,
      shotNumber: shotNumber.trim(),
      dialogue: typeof sb.dialogue === "string" ? sb.dialogue : undefined,
      narration: typeof meta.narration === "string" ? meta.narration : undefined,
      durationSeconds: planned,
      dialogueAudioId: nonEmptyString(meta.dialogueAudioId),
      narrationAudioId: nonEmptyString(meta.narrationAudioId),
      audioAnchorId: nonEmptyString(meta.audioAnchorId),
    })
  }
  shots.sort((a, b) => compareShotNumber(a.shotNumber, b.shotNumber))
  return shots
}

// ─────────────────────────────────────────── ① 分鏡 → 台詞表（純函式）

export interface VoiceoverLinePlan {
  lines: VoiceoverLine[]
  /** 與 `lines` **同索引**的溯源陣列（回寫／比對時逐行對回鏡號）。 */
  source: VoiceoverSourceRef[]
  refused?: { code: "too_many_lines"; note: string }
}

/**
 * 分鏡 → 逐行台詞表（**病歷本體的那一跳**）。
 *
 * 契約：
 *   · **每鏡每欄位恰好一行**：6 鏡各有旁白 → 6 行，**不摺成 1 行**（病灶本體）。
 *   · 空白／純空白的 `dialogue`/`narration` **不產生行**（不送空行燒錢）。
 *   · 行序＝分鏡陣列序 × 欄位序（`dialogue` → `narration`）；`source[i]` 與 `lines[i]` 同索引。
 *   · 行數 **> 50 → 具名拒**，`note` 寫明「硬上限 50，請縮集數或分批」，**不默默截斷**。
 *   · 無鏡號的項**略過**（不是鏡，不臆造鏡號）。text **逐字照送**（不切 `[角色]：「…」`）。
 *   · `role` 只填欄位名（`dialogue`/`narration`），**鏡號不進 `role`/`text`**（會被唸出來）。
 */
export function shotsToVoiceoverLines(shots: readonly StoryboardVoiceoverShot[]): VoiceoverLinePlan {
  const lines: VoiceoverLine[] = []
  const source: VoiceoverSourceRef[] = []
  for (const shot of shots) {
    const shotNumber = typeof shot?.shotNumber === "string" ? shot.shotNumber.trim() : ""
    if (!shotNumber) continue
    for (const field of AUDIO_FIELD_ORDER) {
      const raw = shot[field]
      const text = typeof raw === "string" ? raw.trim() : ""
      if (!text) continue
      lines.push({ role: field, text })
      source.push({ shotNumber, field })
    }
  }
  if (source.length > VOICEOVER_TOOL_MAX_LINES) {
    return {
      lines,
      source,
      refused: {
        code: "too_many_lines",
        note: `共 ${source.length} 行，超過 TTS 工具硬上限 ${VOICEOVER_TOOL_MAX_LINES}（工具默認 ${VOICEOVER_TOOL_DEFAULT_MAX_LINES}、超出即截斷）→ 具名拒，請縮集數或分批，本層不代為截斷。`,
      },
    }
  }
  return { lines, source }
}

// ─────────────────────────────────────────── ② 分批（每批顯式帶 maxLines）

export interface VoiceoverBatch {
  lines: VoiceoverLine[]
  /** **顯式**傳給上游的 `max_lines`＝本批實際行數（不帶就被默認 20 靜默截斷）。 */
  maxLines: number
  /** 本批第一行在全表中的索引（合併 timeline 時回填 `index` 用）。 */
  startIndex: number
}

/**
 * 把台詞表切批，**每一批顯式帶 `maxLines = 該批實際行數`**（`<= VOICEOVER_TOOL_DEFAULT_MAX_LINES`）。
 * 批內序接、批間序接，禁併發（上游逐行計價且無並發保證）。
 */
export function planBatches(
  lines: readonly VoiceoverLine[],
  batchSize: number = VOICEOVER_TOOL_DEFAULT_MAX_LINES,
): VoiceoverBatch[] {
  const size = Math.max(1, Math.min(VOICEOVER_TOOL_MAX_LINES, Math.floor(batchSize) || VOICEOVER_TOOL_DEFAULT_MAX_LINES))
  const batches: VoiceoverBatch[] = []
  for (let start = 0; start < lines.length; start += size) {
    const chunk = lines.slice(start, start + size)
    batches.push({ lines: chunk, maxLines: chunk.length, startIndex: start })
  }
  return batches
}

// ─────────────────────────────────────────── ③ timeline → 回寫分鏡（整批或全不寫）

export type VoiceoverApplyRefusalCode =
  | "length_mismatch"
  | "missing_audio_url"
  | "unusable_audio_url"
  | "unknown_shot"
  | "invalid_source"

export interface VoiceoverApplyResult {
  /** 回寫後的新陣列（拒絕時＝輸入的**等值新物件**，分鏡原樣、呼叫端拿不到突變舊參考）。 */
  shots: StoryboardVoiceoverShot[]
  applied: boolean
  refused?: { code: VoiceoverApplyRefusalCode; note: string }
  /** 已寫回但**時長未實測**（`duration_ms` 非有限數）的鏡號（回報用，不阻擋寫入）。 */
  unmeasuredDurations: string[]
}

/** 讀出既有兩軌的**可用**音檔（判準＝`usableAudioUrl`，不另立第二套）。 */
function readAudioTracks(shot: StoryboardVoiceoverShot): { dialogueAudioId?: string; narrationAudioId?: string } {
  const dialogueAudioId = usableAudioUrl(shot.dialogueAudioId)
  const narrationAudioId = usableAudioUrl(shot.narrationAudioId)
  return {
    ...(dialogueAudioId ? { dialogueAudioId } : {}),
    ...(narrationAudioId ? { narrationAudioId } : {}),
  }
}

/** 兩軌 → patch，並依規則重算錨（對白軌優先；兩軌皆空＝不寫 `audioAnchorId` 空殼鍵）。 */
function audioPatchWithAnchor(tracks: { dialogueAudioId?: string; narrationAudioId?: string }): Partial<StoryboardVoiceoverShot> {
  const anchor = tracks.dialogueAudioId || tracks.narrationAudioId
  return { ...tracks, ...(anchor ? { audioAnchorId: anchor } : {}) }
}

/**
 * 把 TTS timeline 依 `source` 回寫到分鏡音軌。
 *
 * 落點（鍵名逐字照用）：`field === "dialogue"` → `dialogueAudioId`；`"narration"` → `narrationAudioId`；
 * `audioAnchorId` 由規則 `dialogueAudioId || narrationAudioId` 重算（既有另一軌不動）。
 *
 * **多重失敗閘（任一即整批拒寫，回 `{applied:false, refused}`，分鏡原樣）**：
 *   `timeline.length !== source.length`（含上游截斷）／`source[i].field` 非兩值／
 *   `source[i].shotNumber` 不在輸入分鏡內／`timeline[i].audio_url` **空**（missing）或
 *   不是**可用音頻**（unusable）。**不准部分寫入**——部分寫入＝分鏡半數有聲、使用者以為完成。
 *
 * `duration_ms` 為 `null`（單行 ffprobe 失敗，上游誠實語義）**不阻擋寫入**（URL 仍有效），
 * 但該鏡號被收進 `unmeasuredDurations` 回報，避免「已綁定」被誤讀成「時長已驗」。
 */
export function applyTimelineToShots(
  shots: readonly StoryboardVoiceoverShot[],
  timeline: readonly VoiceoverTimelineEntry[],
  source: readonly VoiceoverSourceRef[],
): VoiceoverApplyResult {
  const copy = shots.map((shot) => ({ ...shot }))
  const refuse = (code: VoiceoverApplyRefusalCode, note: string): VoiceoverApplyResult => ({
    shots: copy,
    applied: false,
    refused: { code, note },
    unmeasuredDurations: [],
  })

  if (timeline.length !== source.length) {
    return refuse(
      "length_mismatch",
      `timeline ${timeline.length} 行、source ${source.length} 行（含上游截斷）→ 整批拒寫，不部分寫入。`,
    )
  }

  const indexByShotNumber = new Map<string, number>()
  copy.forEach((shot, index) => {
    const shotNumber = typeof shot.shotNumber === "string" ? shot.shotNumber.trim() : ""
    if (shotNumber) indexByShotNumber.set(shotNumber, index)
  })

  // 先全量驗證（純檢查，**不動 copy**）——全部合規才落盤，杜絕部分寫入。
  // patch **不在這裡算**：同一鏡的對白＋旁白兩行必須**序接**地以「上一行寫入後的狀態」為基底
  // 重算錨（先算好再合併會讓後一行的錨蓋掉前一行的對白優先序）。
  const planned: { index: number; role: ShotAudioField; url: string; shotNumber: string; measured: boolean }[] = []
  const unmeasuredDurations: string[] = []
  for (let i = 0; i < timeline.length; i++) {
    const ref = source[i]
    const field = ref?.field
    if (field !== "dialogue" && field !== "narration") {
      return refuse("invalid_source", `source[${i}].field 不是 dialogue/narration → 整批拒寫。`)
    }
    const shotNumber = typeof ref?.shotNumber === "string" ? ref.shotNumber.trim() : ""
    const index = indexByShotNumber.get(shotNumber)
    if (index === undefined) {
      return refuse("unknown_shot", `source[${i}] 的鏡號「${shotNumber || "(空)"}」不在輸入分鏡內 → 整批拒寫。`)
    }
    const rawUrl = timeline[i]?.audio_url
    const url = usableAudioUrl(rawUrl)
    if (!url) {
      return refuse(
        rawUrl ? "unusable_audio_url" : "missing_audio_url",
        `timeline[${i}]（鏡 ${shotNumber}）${rawUrl ? "的 audio_url 不是可用音頻" : "缺 audio_url"} → 整批拒寫。`,
      )
    }
    const measured = typeof timeline[i]?.duration_ms === "number" && Number.isFinite(timeline[i]!.duration_ms)
    if (!measured) unmeasuredDurations.push(shotNumber)
    planned.push({ index, role: field as ShotAudioField, url, shotNumber, measured })
  }

  // 驗證全過才落盤；逐行以「當前 copy 狀態」重算錨，故同鏡兩行序接後錨仍為 `dialogueAudioId || narrationAudioId`。
  for (const row of planned) {
    const target = copy[row.index]
    const tracks = readAudioTracks(target as StoryboardVoiceoverShot)
    const next = row.role === "dialogue" ? { ...tracks, dialogueAudioId: row.url } : { ...tracks, narrationAudioId: row.url }
    copy[row.index] = { ...target, ...(audioPatchWithAnchor(next) as StoryboardVoiceoverShot) }
  }
  return { shots: copy, applied: true, unmeasuredDurations }
}

// ─────────────────────────────────────────── ④ 逐鏡時長漂移（只回報不修正）

export interface VoiceoverDurationDrift {
  shotNumber: string
  /** 分鏡計畫秒數；缺席／非有限數＝`null`（無從比對，不編造）。 */
  plannedSec: number | null
  /** 本批實測配音秒數（該鏡各行 `duration_ms` 之和）；無法實測＝`null`；本批無行＝`0`。 */
  actualSec: number | null
  /** `actualSec - plannedSec`（兩者皆非 null 才給值）。 */
  deltaSec: number | null
  /** `|deltaSec| > DURATION_DRIFT_THRESHOLD_SEC`（無法比對時恆 `false`）。 */
  overThreshold: boolean
  note?: string
}

/** 秒值收斂到毫秒精度（避免浮點尾數噪音）。 */
function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * 逐鏡比「實測配音時長」與「分鏡計畫秒數（`durationSeconds`）」。**只回報不修正**。
 *
 * 語義（照抄站點側，勿改）：
 *   · 某鏡實際秒數＝本批 `source` 中屬於該鏡的所有行 `duration_ms` **之和** ÷ 1000
 *     （同一鏡的對白＋旁白視為**序接**、不假設重疊；本層明示假設，非上游保證）。
 *   · 該鏡在本批**沒有行** → `actualSec = 0`（＝本批完全沒有它的配音，正是 P2 病灶的長相）。
 *   · 該鏡**有行但任一行 `duration_ms` 未實測** → `actualSec = null`（不冒充）。
 *   · `plannedSec` 缺席／非有限數 → `null`。
 *   · 回傳**輸入分鏡的每一鏡**（順序照輸入）。
 */
export function audioDurationDrift(
  shots: readonly StoryboardVoiceoverShot[],
  timeline: readonly VoiceoverTimelineEntry[],
  source: readonly VoiceoverSourceRef[],
): VoiceoverDurationDrift[] {
  const buckets = new Map<string, { totalMs: number; lines: number; unmeasured: boolean }>()
  const pairCount = Math.min(timeline.length, source.length)
  for (let i = 0; i < pairCount; i++) {
    const ref = source[i]
    const shotNumber = typeof ref?.shotNumber === "string" ? ref.shotNumber.trim() : ""
    if (!shotNumber) continue
    const bucket = buckets.get(shotNumber) ?? { totalMs: 0, lines: 0, unmeasured: false }
    bucket.lines += 1
    const duration = timeline[i]?.duration_ms
    if (typeof duration === "number" && Number.isFinite(duration)) bucket.totalMs += duration
    else bucket.unmeasured = true
    buckets.set(shotNumber, bucket)
  }

  return shots.map((shot) => {
    const shotNumber = typeof shot.shotNumber === "string" ? shot.shotNumber.trim() : ""
    const rawPlanned = shot.durationSeconds
    const plannedSec = typeof rawPlanned === "number" && Number.isFinite(rawPlanned) ? rawPlanned : null
    const bucket = shotNumber ? buckets.get(shotNumber) : undefined

    let actualSec: number | null
    let note: string | undefined
    if (!bucket || bucket.lines === 0) {
      actualSec = 0
      note = "本批 timeline 無此鏡的配音行（可能無聲；準確性只到本批輸入）"
    } else if (bucket.unmeasured) {
      actualSec = null
      note = "此鏡有 duration_ms 未實測的行，無法比對時長"
    } else {
      actualSec = bucket.totalMs / 1000
    }
    if (plannedSec === null) {
      note = note ? `${note}；且分鏡無 durationSeconds 計畫值可比` : "分鏡無 durationSeconds 計畫值可比"
    }

    const deltaSec = plannedSec !== null && actualSec !== null ? roundSec(actualSec - plannedSec) : null
    const overThreshold = deltaSec !== null && Math.abs(deltaSec) > DURATION_DRIFT_THRESHOLD_SEC
    return {
      shotNumber,
      plannedSec,
      actualSec: actualSec === null ? null : roundSec(actualSec),
      deltaSec,
      overThreshold,
      ...(note ? { note } : {}),
    }
  })
}

// ─────────────────────────────────────────── ⑤ 回寫 ops（pad 只含三個鍵）

/** 回寫允許出現的**唯一**三個 metadata 鍵（其餘鍵一律不進 patch）。 */
export const VOICEOVER_PATCH_KEYS = ["dialogueAudioId", "narrationAudioId", "audioAnchorId"] as const

/**
 * 產生 `update_node` ops（`{type:"update_node", id, patch}`）。
 *
 * `patch` **只含三個鍵**：`dialogueAudioId`/`narrationAudioId`/`audioAnchorId`（值非空者才帶）。
 * 只對「音軌真的變了」的節點下發（避免無意義寫入觸發前端失效/重渲染）。
 */
export function buildVoiceoverOps(
  shots: readonly StoryboardVoiceoverShot[],
  applied: readonly StoryboardVoiceoverShot[],
): Record<string, unknown>[] {
  const ops: Record<string, unknown>[] = []
  const pairCount = Math.min(shots.length, applied.length)
  for (let i = 0; i < pairCount; i++) {
    const before = shots[i]
    const after = applied[i]
    if (!after?.nodeId) continue
    const patch: Record<string, string> = {}
    for (const key of VOICEOVER_PATCH_KEYS) {
      const value = after[key]
      if (typeof value === "string" && value) patch[key] = value
    }
    if (!Object.keys(patch).length) continue
    const changed = VOICEOVER_PATCH_KEYS.some((key) => (before?.[key] ?? "") !== (after[key] ?? ""))
    if (!changed) continue
    ops.push({ type: "update_node", id: after.nodeId, patch })
  }
  return ops
}