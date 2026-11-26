/**
 * 出曲即入库（music_gen 成功路径的登记接点，2026-10-10）。
 *
 * 目的：让「music_gen 成功产出一首带歌词的曲子」这件事**不依赖 gateway 是否追踪该会话**——
 * 只要工具成功返回，曲目就立刻带真歌名 + 歌词文本进 store（播放器打开即有名、可播、可对齐）。
 *
 * 复用（R4）：整套 store 读改写 / upsert / 幂等 / ready 保护 / 进程内串行化 mutex 都在
 * gateway/lyric-align-hook.ts 的 enqueueLyricAlign 里；本档只做「从入参+回执抽字段」与
 * fail-open 包装，绝不重抄第二份 store 逻辑。
 *
 * 失败政策（R3）：任何失败只 console.warn，绝不抛出、绝不改动回执。
 */
import { enqueueLyricAlign } from "../../../gateway/lyric-align-hook.ts"

const PLACEHOLDER_TITLE = "音乐生成完成"

/** 歌词里首个「非标签、非空、非纯括号（哼鸣/和声）」行；没有回空串。 */
function firstLyricLine(lyrics: unknown): string {
  if (typeof lyrics !== "string" || !lyrics) return ""
  for (const raw of lyrics.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (/^\[[^\]]*\]$/.test(line)) continue // 段落标签 [Verse]/[Chorus]…
    if (/^[（(].*[)）]$/.test(line)) continue // 纯括号行（哼鸣/和声）
    return line
  }
  return ""
}

/** 歌名回退：audios[0].title → 歌词首个非标签非空行 → prompt 首行(≤40) → 未命名曲目。绝不落占位。 */
function pickTitle(parsed: Record<string, unknown>, args: Record<string, unknown>): string {
  const audio0 = Array.isArray(parsed.audios) ? (parsed.audios[0] as Record<string, unknown> | undefined) : undefined
  const fromAudio = typeof audio0?.title === "string" ? audio0.title.trim() : ""
  if (fromAudio && fromAudio !== PLACEHOLDER_TITLE) return fromAudio

  const fromLyrics = firstLyricLine(args.lyrics)
  if (fromLyrics) return fromLyrics

  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
  const firstPromptLine = (prompt.split(/\r?\n/)[0] || "").trim().slice(0, 40).trim()
  if (firstPromptLine) return firstPromptLine

  return "未命名曲目"
}

/** 音频 URL：audios[0].url 优先，回退顶层 url。 */
function pickUrl(parsed: Record<string, unknown>): string {
  const audio0 = Array.isArray(parsed.audios) ? (parsed.audios[0] as Record<string, unknown> | undefined) : undefined
  const fromAudio = typeof audio0?.url === "string" ? audio0.url.trim() : ""
  if (fromAudio) return fromAudio
  return typeof parsed.url === "string" ? parsed.url.trim() : ""
}

/** 只认回执里真有的 http(s) 封面 URL；没有就回 undefined（绝不套别的专辑封面）。 */
function pickCover(parsed: Record<string, unknown>): string | undefined {
  const audio0 = Array.isArray(parsed.audios) ? (parsed.audios[0] as Record<string, unknown> | undefined) : undefined
  const cands: unknown[] = [parsed.cover, parsed.cover_url, parsed.image_url, parsed.thumbnail, audio0?.cover]
  for (const c of cands) {
    if (typeof c === "string" && /^https?:\/\//i.test(c.trim())) return c.trim()
  }
  return undefined
}

/**
 * 把一次 music_gen 的成功回执登记进 store。fail-open：任何异常只 warn，绝不抛。
 * @param args   工具入参（取 lyrics / prompt）
 * @param result 工具回执（{ output: "<json string>" }；解析 audios[0].url / title）
 */
export async function registerMusicGenTrack(
  args: Record<string, unknown> | undefined,
  result: unknown,
): Promise<void> {
  try {
    const output = (result as { output?: unknown } | undefined)?.output
    if (typeof output !== "string" || !output.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(output)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== "object") return
    const p = parsed as Record<string, unknown>
    if (p.ok === false) return
    const url = pickUrl(p)
    if (!url) return
    const a = (args ?? {}) as Record<string, unknown>
    const lyrics = typeof a.lyrics === "string" ? a.lyrics : ""
    const title = pickTitle(p, a)
    const cover = pickCover(p)
    await enqueueLyricAlign({
      url,
      lyrics,
      title,
      tool: "music_gen",
      ...(cover ? { cover } : {}),
    })
  } catch (e) {
    console.warn(`[music_gen][lyric-register] ${e instanceof Error ? e.message : String(e)}`)
  }
}
