/**
 * 出曲后自动挂 lyric-align（异步，失败不挡 audio.done / 播放跳转）。
 *
 * 触发：music_gen（或其它带 lyrics 入参 + 音频 URL 出参）完成后 fire-and-forget。
 * 路径：
 *   1) 出曲即入库（同步，R1/R2）：把曲目 upsert 进 store 的
 *      uploads/ba-deng-liu-zhao/tracks.json（无歌词也登记：lyrics_plain 缺省、
 *      lyric_status=aligning，但不排队对齐）——播放器打开即有歌名/可播，不再依赖本机 worker。
 *   2) 有歌词再排队对齐：LYRIC_ALIGN_WEBHOOK（本机 GPU worker，VPS 经 ssh -R）
 *      否则落盘 QUEUE_DIR（VPS: /opt/agent-harness/state/lyric-align-queue）。
 *
 * 降级：store 写入 / webhook / 队列失败只打日志；播放器 deep-link 未命中仍可注入临时曲目。
 * 写通道：IMAGE_DATA_STORE_BASE（默认取本机可达的 store 入口）＋ IMAGE_DATA_API_KEY（母钥）。
 */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

export type LyricAlignEnqueueInput = {
  url: string
  lyrics?: string
  title?: string
  tool?: string
  sessionId?: string
  cover?: string
}

const DEFAULT_QUEUE =
  process.env.LYRIC_ALIGN_QUEUE_DIR?.trim() ||
  path.join(process.env.DIRECTOR_DATA_ROOT?.trim() || "/opt/agent-harness/state", "lyric-align-queue")

/** 近期已 enqueue 的音频 URL，避免同轮 audios[] / 安全网重复投递。 */
const recent = new Map<string, number>()
const RECENT_TTL_MS = 10 * 60 * 1000
const RECENT_CAP = 200

function remember(url: string): boolean {
  const now = Date.now()
  for (const [k, t] of recent) {
    if (now - t > RECENT_TTL_MS) recent.delete(k)
  }
  if (recent.has(url)) return false
  recent.set(url, now)
  if (recent.size > RECENT_CAP) {
    const oldest = recent.keys().next().value
    if (oldest !== undefined) recent.delete(oldest)
  }
  return true
}

function extractLyrics(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const o = input as Record<string, unknown>
  const raw = o.lyrics ?? o.lyric ?? o.lyrics_text
  return typeof raw === "string" ? raw.trim() : ""
}

function extractTitle(input: unknown, parsed: unknown): string {
  if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>
    if (typeof p.title === "string" && p.title && p.title !== "音乐生成完成") return p.title.trim()
    if (Array.isArray(p.audios) && p.audios[0] && typeof (p.audios[0] as { title?: unknown }).title === "string") {
      return String((p.audios[0] as { title: string }).title).trim()
    }
  }
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>
    if (typeof o.title === "string" && o.title.trim()) return o.title.trim()
    if (typeof o.prompt === "string" && o.prompt.trim()) {
      const line = o.prompt.trim().split(/\n/)[0]!.slice(0, 40)
      return line || "未命名曲目"
    }
  }
  return "未命名曲目"
}

/** 只认 parsed 里真有封面的 URL；没有就不写 cover 键（播放器据此不套别的专辑封面）。 */
function extractCover(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined
  const p = parsed as Record<string, unknown>
  const cands: unknown[] = [p.cover, p.cover_url, p.image, p.image_url, p.thumbnail]
  if (Array.isArray(p.images) && p.images[0] && typeof (p.images[0] as { url?: unknown }).url === "string") {
    cands.push((p.images[0] as { url: string }).url)
  }
  if (Array.isArray(p.audios) && p.audios[0] && typeof (p.audios[0] as { cover?: unknown }).cover === "string") {
    cands.push((p.audios[0] as { cover: string }).cover)
  }
  for (const c of cands) {
    if (typeof c === "string" && /^https?:\/\//i.test(c.trim())) return c.trim()
  }
  return undefined
}

function collectAudioUrls(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object") return []
  const isAudioUrl = (u: unknown): u is string =>
    typeof u === "string" && u.length > 0 && /\.(m4a|mp3|wav|aac|ogg|flac|opus)(\?|$)/i.test(u)
  const out: string[] = []
  const p = parsed as Record<string, unknown>
  if (isAudioUrl(p.url)) out.push(p.url)
  if (isAudioUrl(p.audio_url)) out.push(p.audio_url)
  if (Array.isArray(p.audios)) {
    for (const a of p.audios as { url?: unknown }[]) {
      if (isAudioUrl(a?.url)) out.push(a.url as string)
    }
  }
  return [...new Set(out)]
}

// ── 出曲即入库（store tracks.json 同步 upsert） ───────────────────────────────
// 写通道＝本机可达的 store 入口（IMAGE_DATA_STORE_BASE；容器 image-data-api，
// 宿主与 gateway 同一台）。母钥读 IMAGE_DATA_API_KEY；缺失时只打日志、退回队列路径。
const STORE_BASE = (process.env.IMAGE_DATA_STORE_BASE?.trim() || "https://store.tinchak0207.xyz/image-data").replace(/\/+$/, "")
const TRACKS_PATHNAME = process.env.LYRIC_ALIGN_TRACKS_PATH?.trim() || "uploads/ba-deng-liu-zhao/tracks.json"
/** 专辑正文曲目统一归到这张专辑。 */
const TRACK_ARTIST = "把灯留着"

type StoreTrack = Record<string, unknown> & { url?: string; lrc?: string; lyric_status?: string }

function storeKey(): string {
  return (process.env.IMAGE_DATA_API_KEY || "").trim()
}

/** 按 url 归一化（去 ?／# 之后）比较，避免带参数/哈希的同一音频被当两首。 */
function normalizeUrl(raw: unknown): string {
  return typeof raw === "string" ? raw.split(/[?#]/)[0]!.trim() : ""
}

// 同一进程内多首并发要排队（读改写不可交错，否则互相覆盖）。
let storeChain: Promise<void> = Promise.resolve()
function serializeStore<T>(task: () => Promise<T>): Promise<T> {
  const run = storeChain.then(task, task)
  storeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function readStoreTracks(key: string): Promise<StoreTrack[]> {
  const res = await fetch(`${STORE_BASE}/api/blob/get?path=${encodeURIComponent(TRACKS_PATHNAME)}`, {
    headers: { "x-image-data-key": key },
    signal: AbortSignal.timeout(5000),
  })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`GET ${res.status}`)
  const text = await res.text()
  // 现档尾部可能带历史 padding 空格：先 rstrip 再 parse。
  const trimmed = text.replace(/\s+$/, "")
  if (!trimmed) return []
  const data = JSON.parse(trimmed)
  return Array.isArray(data) ? (data as StoreTrack[]) : []
}

async function writeStoreTracks(key: string, tracks: StoreTrack[]): Promise<void> {
  const res = await fetch(`${STORE_BASE}/api/blob/${TRACKS_PATHNAME}`, {
    method: "PUT",
    headers: {
      "x-image-data-key": key,
      "Content-Type": "application/octet-stream",
      "x-content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(tracks),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`PUT ${res.status}`)
}

/**
 * 同步把曲目 upsert 进 store（失败只 warn，不抛，不挡播放）。
 * 回传是否应继续排队对齐：ready 曲目回 false（不降级、不清 lrc、不重跑对齐）。
 * - 同 URL 重复触发不产生重复条目；不覆盖 ready 曲目，保留已有非空 lrc（不清空）。
 * - 无歌词：lyrics_plain 缺省、lyric_status=aligning，仍登记（器乐也能显示歌名/可播）。
 */
async function upsertTrackInStore(t: { url: string; name: string; lyricsPlain: string; cover?: string }): Promise<boolean> {
  const key = storeKey()
  if (!key) {
    console.warn("[lyric-align] IMAGE_DATA_API_KEY missing — skip store upsert (queue path only)")
    return true
  }
  return serializeStore(async () => {
    try {
      const tracks = await readStoreTracks(key)
      const target = normalizeUrl(t.url)
      const idx = tracks.findIndex((x) => normalizeUrl(x?.url) === target)
      const entry: StoreTrack = {
        name: t.name,
        artist: TRACK_ARTIST,
        url: t.url,
        ...(t.cover ? { cover: t.cover } : {}),
        lrc: "",
        ...(t.lyricsPlain ? { lyrics_plain: t.lyricsPlain } : {}),
        lyric_status: "aligning",
      }
      if (idx >= 0) {
        const prev = tracks[idx]!
        // 已对齐（ready）的曲目一字不动：不降级、不清 lrc、不重跑对齐。
        if (prev.lyric_status === "ready") {
          console.log(`[lyric-align] store: skip ready track url=${t.url.slice(0, 80)}`)
          return false
        }
        // 其余情况：更新 name/lyrics_plain/status，但**保留已有 lrc**（非空不清空）。
        const prevLrc = typeof prev.lrc === "string" ? prev.lrc : ""
        const merged: StoreTrack = { ...prev, ...entry }
        if (prevLrc.length > 0) merged.lrc = prevLrc
        tracks[idx] = merged
      } else {
        tracks.push(entry)
      }
      await writeStoreTracks(key, tracks)
      console.log(`[lyric-align] store upsert ${idx >= 0 ? "update" : "add"} ok url=${t.url.slice(0, 80)} count=${tracks.length}`)
      return true
    } catch (e) {
      console.warn(`[lyric-align] store upsert failed (playback still ok): ${e instanceof Error ? e.message : e}`)
      return true
    }
  })
}

async function postWebhook(webhook: string, body: LyricAlignEnqueueInput): Promise<void> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 4000)
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      console.warn(`[lyric-align] webhook HTTP ${res.status}: ${text.slice(0, 200)}`)
    } else {
      console.log(`[lyric-align] webhook accepted url=${body.url.slice(0, 80)}`)
    }
  } finally {
    clearTimeout(t)
  }
}

async function dropQueueFile(body: LyricAlignEnqueueInput): Promise<void> {
  const dir = DEFAULT_QUEUE
  await mkdir(dir, { recursive: true })
  const id = `la_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const file = path.join(dir, `${id}.json`)
  await writeFile(
    file,
    JSON.stringify(
      {
        id,
        url: body.url,
        title: body.title,
        lyrics: body.lyrics,
        tool: body.tool,
        sessionId: body.sessionId,
        created_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  )
  console.log(`[lyric-align] queued file ${file}`)
}

/** 显式投递一单（music_tools 也可直接调）。无歌词也登记（不排队对齐）。 */
export async function enqueueLyricAlign(input: LyricAlignEnqueueInput): Promise<void> {
  const url = (input.url || "").trim()
  if (!url) return
  if (!remember(url)) return
  const lyrics = (input.lyrics || "").trim()
  const title = (input.title || "未命名曲目").trim()
  const cover = typeof input.cover === "string" && input.cover.trim() ? input.cover.trim() : undefined

  // R1/R2：出曲即入库——同步 upsert 进 store（无歌词也登记，器乐可显示歌名/可播）。
  const proceed = await upsertTrackInStore({ url, name: title, lyricsPlain: lyrics, cover })
  // 已 ready 的曲目：连对齐也不重跑（保护既有时间轴）。
  if (!proceed) return

  // 无歌词（器乐）：已登记，不对齐、不占队列。
  if (!lyrics) {
    console.log(`[lyric-align] registered (no lyrics) url=${url.slice(0, 80)}`)
    return
  }
  const body: LyricAlignEnqueueInput = {
    url,
    lyrics,
    title,
    tool: input.tool,
    sessionId: input.sessionId,
    ...(cover ? { cover } : {}),
  }
  const webhook = process.env.LYRIC_ALIGN_WEBHOOK?.trim()
  try {
    if (webhook) {
      await postWebhook(webhook.endsWith("/enqueue") ? webhook : `${webhook.replace(/\/$/, "")}/enqueue`, body)
      return
    }
    await dropQueueFile(body)
  } catch (e) {
    console.warn(`[lyric-align] enqueue failed (playback still ok): ${e instanceof Error ? e.message : e}`)
  }
}

/**
 * 从 tool completed 的 input/output 自动判断并登记（无歌词也登记）+ enqueue。
 * 在 emitAudioDone 之后调用；内部异步，不抛给调用方。
 */
export function maybeEnqueueLyricAlignFromTool(opts: {
  toolName: string
  input: unknown
  parsed: unknown
  sessionId?: string
}): void {
  // 有歌词的生曲工具；也允许通用名里带 music / song
  const tool = opts.toolName || ""
  // 只挂生曲工具，避免无关工具偶发带 lyrics 字段误触发。
  const likely = tool === "music_gen" || /^(music_|song_)/i.test(tool) || /music_gen|generate_music|song_gen/i.test(tool)
  if (!likely) return
  const urls = collectAudioUrls(opts.parsed)
  if (urls.length === 0) return
  // 无歌词（器乐）走同一条登记路径：lyrics_plain 缺省、lyric_status=aligning，不排队对齐。
  const lyrics = extractLyrics(opts.input)
  const title = extractTitle(opts.input, opts.parsed)
  const cover = extractCover(opts.parsed)
  for (const url of urls) {
    void enqueueLyricAlign({
      url,
      lyrics,
      title,
      tool,
      sessionId: opts.sessionId,
      ...(cover ? { cover } : {}),
    })
  }
}
