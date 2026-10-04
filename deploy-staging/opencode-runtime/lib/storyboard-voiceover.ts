// 分镜逐镜配音（harness 侧 lib；2026-09-30）。
//
// 病历 `tts-multiline-narration-p2-bug`：60s 片「旁白贯穿镜 1-6」，agent 只送单段台词生成
// 一条 25s 音轨 → 成片后 35s 无声。**真根因不是 TTS**：逐行真 TTS 的生产者早就存在＝
// `tools/audio_first_timeline.ts`（逐行呼叫 gateway `/agent/v1/tts` → 下载 mp3 → ffprobe
// **实测**时长 → 累计 `offset_ms` 锚点 → 回报 `cost_coins`；上游不可用整批 fail 不编造）。
// 缺的是**两跳**：① 台词表不是从分镜确定性推出来的（由 LLM 自由产 → 折成一句）；
// ② 回传从不写回分镜（`narrationAudioId`/`dialogueAudioId`/`audioAnchorId` 全库无生产者）。
//
// 本档＝那两跳。形状照本专案「禁造轮子」：**引擎逐行复制** `audio_first_timeline.ts`
// （TTS 呼叫／下载／ffprobe／offset 累加／诚实失败语义**一行不动**），只换两处白名单：
//   ① **输入源**：从「tool 的 `script` 字串」→「从画布快照的分镜节点导出（每镜每栏位恰好一行）」
//   ② **出口**：从「只回 timeline JSON」→「回 timeline ＋ 写回分镜节点音轨」
//
// 此档不是 tool，不得 export tool 定义，故放 tools/ 之外（同 lib/canvas-flow.ts 惯例）。
//
// ── 上游工具（被复制的轮子）的真实契约，逐字读完照抄，不猜 ──
//   · 每行回 `{index, role, text, offset_ms, audio_url, duration_ms, cost_coins?, error?,
//     duration_note?}`；`duration_ms` 由 ffprobe **实测**，单行探测失败回 `null`（不冒充）；
//     `tts_unavailable` 整批 fail（不返半成品）。
//   · `max_lines`：**默认 20、硬上限 50**，超出**截断**并回 `truncated`。⇒ 本层每一批都
//     **显式带** `maxLines = 该批实际行数`（见 `planBatches`），否则 21..50 行会被默认 20
//     静默截断＝后半段没声而工具回成功。>50 行本层**具名拒**，不代为截断（截断＝假成功）。
//   · `speed` 上游未支持语速控制、传入不生效 ⇒ 本层**不在 `speed` 上做任何文章**。
//
// ── 为何用「本地平行 `source`」而不把镜号塞进 `role`/`text` ──
//   `text` 是**送去合成**的内容（会真的被念出来）；把镜号塞进 `text` ＝ 配音真的把镜号念出来。
//   且上游只保证「回传阵列与送入行序一一对应」，不保证把 role 逐字回传。故镜号只留在本地
//   `source`（与 timeline 同索引的平行阵列），回写／比对一律 `timeline[i]` ↔ `source[i]`。
//   `role` 只填栏位名（`dialogue`/`narration`），与站点侧 `storyboard-audio-bridge.ts` 同口径。
//
// ── 不做的加工（附理由，避免下游误以为漏做）──
//   · **不切分 `dialogue` 的 `[角色]：「…」` 标记**（`storyboard-contract.ts` 已裁定该格式
//     **无契约文件**，硬套＝自造转换）→ text **逐字照送**。
//   · **不从 `dialogue` 猜旁白**（同档裁定逐字）：旁白只有 `narration` 栏，没有就没有。
//   · **不自造音频 URL 判准**：`usableAudioUrl` 逐字照抄站点侧 `agent-output-cards.ts`
//     （harness 不能 import 站点模组，语义必须同口径：`http(s)` + 副档名白名单，或 `data:audio/`）；
//     `audioAnchorId` 的规则照 `storyboard-shots.bindShotAudioTrack`＝`dialogueAudioId || narrationAudioId`。

import { spawn } from "node:child_process"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { randomBytes } from "node:crypto"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"
// 静态 ffprobe（johnvansickle build）：URL 直读会段错误，必须先下载到本地档再探。
const FFPROBE = "/opt/agent-harness/bin/ffprobe"
const RUN_DIR = "/opt/agent-harness/workspace/.run"

// ─────────────────────────────────────────── 引擎（逐行复制 audio_first_timeline.ts）

export interface VoiceoverLine {
  role: string
  text: string
}

/** timeline 的一项（栏位名与上游逐字相同）。 */
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
  /** 逐行呼叫 gateway `/agent/v1/tts` 的 Bearer（＝呼叫端解析出的 sk-biz-*，本档不碰解析）。 */
  key: string
  voice?: string
  speed?: number
  gapMs?: number
  /** 本批行数上限（**必须显式带＝本批实际行数**，否则默认 20 静默截断）。 */
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
      /** 诚实失败码（当前唯一＝`tts_unavailable`）。 */
      code: string
      hint: string
      timeline: VoiceoverTimelineEntry[]
      probed_count: number
    }

/** ffprobe 实测本地音频档时长（秒）。失败回 null，不编造。（逐行复制自 audio_first_timeline.ts） */
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
 * 逐行真 TTS → ffprobe 实测 → 累计 offset 锚点。
 *
 * **引擎逐行复制 `tools/audio_first_timeline.ts` 的 execute 主体**，唯一差异：
 * 输入从「tool `args.script` 解析出的 lines」变成「呼叫端已确定性导出的 lines」，
 * 以及回传改成可再包一层的结构（tool 薄 wrapper / e2e 直调共用同一支）。
 * TTS 呼叫形状、下载、ffprobe、offset 累加、`speed_note`、`tts_unavailable` 整批 fail
 * 语义全部逐字等价，一行不动。
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
      // 1) 调 TTS（复用 tts_speak 上游调法）
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
        const hint = data?.error?.message || `TTS 请求失败（HTTP ${ttsResp.status}）`
        if (code === "tts_unavailable") {
          anyUnavailable = { code, hint }
          // 上游整体不可用：后续行不再逐行撞墙，如实中断
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

      // 2) 下载 mp3 到本地档 → ffprobe 实测（URL 直探会段错误）
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
        /* durationMs 保持 null，诚实标注 */
      }
      entry.duration_ms = durationMs
      if (durationMs === null) entry.duration_note = "ffprobe 探测失败，未编造时长"
      else offsetMs += durationMs + gapMs
      timeline.push(entry)
    }
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  // 上游整体不可用：诚实失败，不返回半成品时间轴冒充成功
  if (anyUnavailable && probedCount === 0) {
    return { ok: false, code: anyUnavailable.code, hint: anyUnavailable.hint, timeline, probed_count: probedCount }
  }

  const totalDurationMs = offsetMs - (timeline.length ? gapMs : 0)// 末行不补尾间隔
  return {
    ok: true,
    timeline,
    total_duration_ms: Math.max(0, totalDurationMs),
    total_cost_coins: Math.round(totalCost * 1e6) / 1e6,
    lines_requested: lines.length,
    lines_processed: timeline.length,
    probed_count: probedCount,
    truncated,
    speed_note: opts.speed !== undefined ? "speed 已传入但当前上游未支持语速控制，不生效" : null,
  }
}

// ─────────────────────────────────────────── 上限与门槛（站点侧 storyboard-audio-bridge.ts 同值）

/** 上游工具硬上限（行）。超过＝具名拒，**不代为截断**（截断＝后半段没声且使用者看不出来）。 */
export const VOICEOVER_TOOL_MAX_LINES = 50
/** 上游工具默认 `max_lines`。不显式覆盖就会被截到 20 ⇒ 每批都必须显式带 `maxLines`。 */
export const VOICEOVER_TOOL_DEFAULT_MAX_LINES = 20
/** 逐镜时长漂移门槛（秒）；理由见站点侧同档（0.5s 足以分开「整段没合成」与「逐句正常抖动」）。 */
export const DURATION_DRIFT_THRESHOLD_SEC = 0.5

/** 每镜轮询两栏位的固定顺序（决定行序＝偏移序）。对白先于旁白，对齐锚优先序。 */
const AUDIO_FIELD_ORDER = ["dialogue", "narration"] as const

export type ShotAudioField = "dialogue" | "narration"

// ─────────────────────────────────────────── 音频可用性（逐字照抄站点侧 usableAudioUrl）

const AUDIO_URL_EXTENSIONS = [".mp3", ".m4a", ".wav", ".aac", ".ogg", ".opus", ".flac", ".webm"] as const

/**
 * 音频交付物判定（逐字复制站点侧 `@/lib/agent-output-cards` 的 `usableAudioUrl`；
 * harness 无法 import 站点模组，语义必须同口径，否则回写会与站点侧判准分叉）：
 *   - `data:audio/…` → 收；其他 `data:` → null
 *   - `http(s)://` 且**路径**（先剥 `?query`/`#fragment`）落在音频副档名白名单 → 收
 *   - 其余（`.png` 图 URL、无副档名裸 URL、本地路径）→ null
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

// ─────────────────────────────────────────── 资料形状

/**
 * 分镜（本层输入投影；不绑 CanvasNode 形状，另带回写需要的 `nodeId`）：
 *   · `nodeId`        ← `node.id`（回写 `update_node` 的落点；harness 独有，站点侧不需要）
 *   · `shotNumber`    ← `node.metadata.storyboardShot.shotNumber`（镜唯一键，契约保证非空）
 *   · `dialogue`      ← `node.metadata.storyboardShot.dialogue`（单一字串，逐字照送）
 *   · `narration`     ← `node.metadata.narration`（旁白文本；**不从 dialogue 猜**）
 *   · `durationSeconds` ← `metadata.durationSeconds` 或 `metadata.storyboardShot.durationSeconds`
 *                        （计画秒数；两处皆无＝诚实缺＝null，**不推算**）
 *   · 三个音轨键      ← 同名 metadata 键（回写落点；锚＝`dialogueAudioId || narrationAudioId`）
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

/** 台词表的本地平行阵列一项：第 i 行属于哪一镜的哪一栏位（镜号不进 `role`/`text`）。 */
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

/** 镜号的自然序比较（`镜2` < `镜10`）；非数字时退回字串比较。确定性用。 */
function compareShotNumber(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
}

/**
 * 从 gateway 快照的 **raw `state`** 导出分镜阵列。
 *
 * ⚠️ 呼叫端**必须传 raw `state`，不准先过 `compactCanvasState`**——后者会把超长文本截断
 * （`truncateText` 240→120），截断＝台词被腰斩，是本工具的命门。
 *
 * 判准＝`metadata.storyboardShot.shotNumber` 非空（与站点侧 `isStoryboardShotNode` 同口径）；
 * 缺 `node.id` 的项略过（没有回写落点，不臆造 id）。回传按镜号自然序排序＝**确定性行序**。
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

// ─────────────────────────────────────────── ① 分镜 → 台词表（纯函式）

export interface VoiceoverLinePlan {
  lines: VoiceoverLine[]
  /** 与 `lines` **同索引**的溯源阵列（回写／比对时逐行对回镜号）。 */
  source: VoiceoverSourceRef[]
  refused?: { code: "too_many_lines"; note: string }
}

/**
 * 分镜 → 逐行台词表（**病历本体的那一跳**）。
 *
 * 契约：
 *   · **每镜每栏位恰好一行**：6 镜各有旁白 → 6 行，**不折成 1 行**（病灶本体）。
 *   · 空白／纯空白的 `dialogue`/`narration` **不产生行**（不送空行烧钱）。
 *   · 行序＝分镜阵列序 × 栏位序（`dialogue` → `narration`）；`source[i]` 与 `lines[i]` 同索引。
 *   · 行数 **> 50 → 具名拒**，`note` 写明「硬上限 50，请缩集数或分批」，**不默默截断**。
 *   · 无镜号的项**略过**（不是镜，不臆造镜号）。text **逐字照送**（不切 `[角色]：「…」`）。
 *   · `role` 只填栏位名（`dialogue`/`narration`），**镜号不进 `role`/`text`**（会被念出来）。
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
        note: `共 ${source.length} 行，超过 TTS 工具硬上限 ${VOICEOVER_TOOL_MAX_LINES}（工具默认 ${VOICEOVER_TOOL_DEFAULT_MAX_LINES}、超出即截断）→ 具名拒，请缩集数或分批，本层不代为截断。`,
      },
    }
  }
  return { lines, source }
}

// ─────────────────────────────────────────── ② 分批（每批显式带 maxLines）

export interface VoiceoverBatch {
  lines: VoiceoverLine[]
  /** **显式**传给上游的 `max_lines`＝本批实际行数（不带就被默认 20 静默截断）。 */
  maxLines: number
  /** 本批第一行在全表中的索引（合并 timeline 时回填 `index` 用）。 */
  startIndex: number
}

/**
 * 把台词表切批，**每一批显式带 `maxLines = 该批实际行数`**（`<= VOICEOVER_TOOL_DEFAULT_MAX_LINES`）。
 * 批内序接、批间序接，禁并发（上游逐行计价且无并发保证）。
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

// ─────────────────────────────────────────── ③ timeline → 回写分镜（整批或全不写）

export type VoiceoverApplyRefusalCode =
  | "length_mismatch"
  | "missing_audio_url"
  | "unusable_audio_url"
  | "unknown_shot"
  | "invalid_source"

export interface VoiceoverApplyResult {
  /** 回写后的新阵列（拒绝时＝输入的**等值新物件**，分镜原样、呼叫端拿不到突变旧参考）。 */
  shots: StoryboardVoiceoverShot[]
  applied: boolean
  refused?: { code: VoiceoverApplyRefusalCode; note: string }
  /** 已写回但**时长未实测**（`duration_ms` 非有限数）的镜号（回报用，不阻挡写入）。 */
  unmeasuredDurations: string[]
}

/** 读出既有两轨的**可用**音档（判准＝`usableAudioUrl`，不另立第二套）。 */
function readAudioTracks(shot: StoryboardVoiceoverShot): { dialogueAudioId?: string; narrationAudioId?: string } {
  const dialogueAudioId = usableAudioUrl(shot.dialogueAudioId)
  const narrationAudioId = usableAudioUrl(shot.narrationAudioId)
  return {
    ...(dialogueAudioId ? { dialogueAudioId } : {}),
    ...(narrationAudioId ? { narrationAudioId } : {}),
  }
}

/** 两轨 → patch，并依规则重算锚（对白轨优先；两轨皆空＝不写 `audioAnchorId` 空壳键）。 */
function audioPatchWithAnchor(tracks: { dialogueAudioId?: string; narrationAudioId?: string }): Partial<StoryboardVoiceoverShot> {
  const anchor = tracks.dialogueAudioId || tracks.narrationAudioId
  return { ...tracks, ...(anchor ? { audioAnchorId: anchor } : {}) }
}

/**
 * 把 TTS timeline 依 `source` 回写到分镜音轨。
 *
 * 落点（键名逐字照用）：`field === "dialogue"` → `dialogueAudioId`；`"narration"` → `narrationAudioId`；
 * `audioAnchorId` 由规则 `dialogueAudioId || narrationAudioId` 重算（既有另一轨不动）。
 *
 * **多重失败闸（任一即整批拒写，回 `{applied:false, refused}`，分镜原样）**：
 *   `timeline.length !== source.length`（含上游截断）／`source[i].field` 非两值／
 *   `source[i].shotNumber` 不在输入分镜内／`timeline[i].audio_url` **空**（missing）或
 *   不是**可用音频**（unusable）。**不准部分写入**——部分写入＝分镜半数有声、使用者以为完成。
 *
 * `duration_ms` 为 `null`（单行 ffprobe 失败，上游诚实语义）**不阻挡写入**（URL 仍有效），
 * 但该镜号被收进 `unmeasuredDurations` 回报，避免「已绑定」被误读成「时长已验」。
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
      `timeline ${timeline.length} 行、source ${source.length} 行（含上游截断）→ 整批拒写，不部分写入。`,
    )
  }

  const indexByShotNumber = new Map<string, number>()
  copy.forEach((shot, index) => {
    const shotNumber = typeof shot.shotNumber === "string" ? shot.shotNumber.trim() : ""
    if (shotNumber) indexByShotNumber.set(shotNumber, index)
  })

  // 先全量验证（纯检查，**不动 copy**）——全部合规才落盘，杜绝部分写入。
  // patch **不在这里算**：同一镜的对白＋旁白两行必须**序接**地以「上一行写入后的状态」为基底
  // 重算锚（先算好再合并会让后一行的锚盖掉前一行的对白优先序）。
  const planned: { index: number; role: ShotAudioField; url: string; shotNumber: string; measured: boolean }[] = []
  const unmeasuredDurations: string[] = []
  for (let i = 0; i < timeline.length; i++) {
    const ref = source[i]
    const field = ref?.field
    if (field !== "dialogue" && field !== "narration") {
      return refuse("invalid_source", `source[${i}].field 不是 dialogue/narration → 整批拒写。`)
    }
    const shotNumber = typeof ref?.shotNumber === "string" ? ref.shotNumber.trim() : ""
    const index = indexByShotNumber.get(shotNumber)
    if (index === undefined) {
      return refuse("unknown_shot", `source[${i}] 的镜号「${shotNumber || "(空)"}」不在输入分镜内 → 整批拒写。`)
    }
    const rawUrl = timeline[i]?.audio_url
    const url = usableAudioUrl(rawUrl)
    if (!url) {
      return refuse(
        rawUrl ? "unusable_audio_url" : "missing_audio_url",
        `timeline[${i}]（镜 ${shotNumber}）${rawUrl ? "的 audio_url 不是可用音频" : "缺 audio_url"} → 整批拒写。`,
      )
    }
    const measured = typeof timeline[i]?.duration_ms === "number" && Number.isFinite(timeline[i]!.duration_ms)
    if (!measured) unmeasuredDurations.push(shotNumber)
    planned.push({ index, role: field as ShotAudioField, url, shotNumber, measured })
  }

  // 验证全过才落盘；逐行以「当前 copy 状态」重算锚，故同镜两行序接后锚仍为 `dialogueAudioId || narrationAudioId`。
  for (const row of planned) {
    const target = copy[row.index]
    const tracks = readAudioTracks(target as StoryboardVoiceoverShot)
    const next = row.role === "dialogue" ? { ...tracks, dialogueAudioId: row.url } : { ...tracks, narrationAudioId: row.url }
    copy[row.index] = { ...target, ...(audioPatchWithAnchor(next) as StoryboardVoiceoverShot) }
  }
  return { shots: copy, applied: true, unmeasuredDurations }
}

// ─────────────────────────────────────────── ④ 逐镜时长漂移（只回报不修正）

export interface VoiceoverDurationDrift {
  shotNumber: string
  /** 分镜计画秒数；缺席／非有限数＝`null`（无从比对，不编造）。 */
  plannedSec: number | null
  /** 本批实测配音秒数（该镜各行 `duration_ms` 之和）；无法实测＝`null`；本批无行＝`0`。 */
  actualSec: number | null
  /** `actualSec - plannedSec`（两者皆非 null 才给值）。 */
  deltaSec: number | null
  /** `|deltaSec| > DURATION_DRIFT_THRESHOLD_SEC`（无法比对时恒 `false`）。 */
  overThreshold: boolean
  note?: string
}

/** 秒值收敛到毫秒精度（避免浮点尾数噪音）。 */
function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * 逐镜比「实测配音时长」与「分镜计画秒数（`durationSeconds`）」。**只回报不修正**。
 *
 * 语义（照抄站点侧，勿改）：
 *   · 某镜实际秒数＝本批 `source` 中属于该镜的所有行 `duration_ms` **之和** ÷ 1000
 *     （同一镜的对白＋旁白视为**序接**、不假设重叠；本层明示假设，非上游保证）。
 *   · 该镜在本批**没有行** → `actualSec = 0`（＝本批完全没有它的配音，正是 P2 病灶的长相）。
 *   · 该镜**有行但任一行 `duration_ms` 未实测** → `actualSec = null`（不冒充）。
 *   · `plannedSec` 缺席／非有限数 → `null`。
 *   · 回传**输入分镜的每一镜**（顺序照输入）。
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
      note = "本批 timeline 无此镜的配音行（可能无声；准确性只到本批输入）"
    } else if (bucket.unmeasured) {
      actualSec = null
      note = "此镜有 duration_ms 未实测的行，无法比对时长"
    } else {
      actualSec = bucket.totalMs / 1000
    }
    if (plannedSec === null) {
      note = note ? `${note}；且分镜无 durationSeconds 计画值可比` : "分镜无 durationSeconds 计画值可比"
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

// ─────────────────────────────────────────── ⑤ 回写 ops（pad 只含三个键）

/** 回写允许出现的**唯一**三个 metadata 键（其余键一律不进 patch）。 */
export const VOICEOVER_PATCH_KEYS = ["dialogueAudioId", "narrationAudioId", "audioAnchorId"] as const

/**
 * 产生 `update_node` ops（`{type:"update_node", id, patch}`）。
 *
 * `patch` **只含三个键**：`dialogueAudioId`/`narrationAudioId`/`audioAnchorId`（值非空者才带）。
 * 只对「音轨真的变了」的节点下发（避免无意义写入触发前端失效/重渲染）。
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