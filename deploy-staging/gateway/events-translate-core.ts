import type { SessionState } from "./types-gateway.ts"
// ---- opencode event translation -> frontend events ----

// sessionID lives in different properties depending on event type:
//   session.*            -> properties.sessionID
//   message.updated      -> properties.sessionID AND properties.info.sessionID
//   message.part.updated -> properties.part.sessionID (NO properties.sessionID)
//   message.part.delta   -> properties.sessionID
export function eventSessionId(event: any): string | undefined {
  const p = event?.properties
  return p?.sessionID ?? p?.part?.sessionID ?? p?.info?.sessionID
}

export function boundMap<T>(map: Map<string, T>, max: number): void {
  if (map.size <= max) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}

export function boundSet<T>(set: Set<T>, max: number): void {
  if (set.size <= max) return
  const oldest = set.values().next().value
  if (oldest !== undefined) set.delete(oldest)
}

// Text parts carry no role, so the only way to tell the assistant's reply from
// the user's own prompt is the messageID -> role map built from message.updated.
// Unknown messageID => false: message.updated for a message always precedes its
// parts, so an unknown id means something is off and dropping is the safe side.
export function isAssistantMessage(state: SessionState, messageID: unknown): boolean {
  if (typeof messageID !== "string" || messageID.length === 0) return false
  return state.messageRole.get(messageID) === "assistant"
}
// tool state.output arrives as a JSON string (e.g. an HTTP 401 with ok:false).
// Parse defensively; malformed/absent output yields null so callers fall back to
// ok:false instead of throwing.
export function parseToolOutput(
  output: unknown,
): { ok?: boolean; url?: string; cost_coins?: number; task_id?: string; error?: unknown } | null {
  if (typeof output === "string") {
    try {
      const parsed: unknown = JSON.parse(output)
      if (parsed && typeof parsed === "object") {
        return parsed as { ok?: boolean; url?: string; cost_coins?: number; task_id?: string; error?: unknown }
      }
      return null
    } catch {
      return null
    }
  }
  if (output && typeof output === "object") {
    return output as { ok?: boolean; url?: string; cost_coins?: number; task_id?: string; error?: unknown }
  }
  return null
}

// 2026-10-02：有界巢状成品 URL 提取器（自 translateToolStatus completed 分支抽出，零行为变更；
// subagent.ts 的子代理工具结果路径共用同一提取器）。真实取件工具回的是**巢状**形状——
// video_result_fetch 回 {jobs:[{video_url}]}、last_frame_video_chain 回 {shots:[{mp4_url}]}；
// 旧版只认顶层 url/video_url/audio_url 与字面 videos[]/audios[]，两者都不命中（模型手动查到
// 成品、把 URL 贴进文字时，网关不发卡，用户只看到泡泡里一条纯文字连结）。
// 走访有界（深度 ≤3、节点 ≤200，防病态大 payload），逐层认候选键；判定仍只认既有副档名正则，
// 不因工具名放宽（不猜）。cost_coins 优先用候选项自己那颗物件的，没有才退回顶层（照原写法）。
// 纯函式、无副作用。
export function collectToolOutputMediaUrls(parsed: unknown): {
  video: { url: string; cost_coins?: number; title?: string }[]
  audio: { url: string; cost_coins?: number; title?: string; cover?: string }[]
} {
  const video: { url: string; cost_coins?: number; title?: string }[] = []
  const audio: { url: string; cost_coins?: number; title?: string; cover?: string }[] = []
  if (parsed === null || typeof parsed !== "object") return { video, audio }
  const isVideoUrl = (u: unknown): u is string =>
    typeof u === "string" && u.length > 0 && /\.(mp4|mov|webm|m4v)(\?|$)/i.test(u)
  const isAudioUrl = (u: unknown): u is string =>
    typeof u === "string" && u.length > 0 && /\.(m4a|mp3|wav|aac|ogg|flac|opus)(\?|$)/i.test(u)
  // 候选键：顶层 url/video_url/audio_url 保留，新增 mp4_url/output_url；容器项再收 file_url。
  const CANDIDATE_URL_KEYS = new Set(["url", "video_url", "mp4_url", "output_url", "audio_url", "file_url"])
  const MAX_SCAN_DEPTH = 3
  const MAX_SCAN_NODES = 200
  const vidCands: { url: string; cost_coins?: number; title?: string }[] = []
  const audCands: { url: string; cost_coins?: number; title?: string; cover?: string }[] = []
  let visited = 0
  const walk = (node: unknown, depth: number): void => {
    if (node === null || depth > MAX_SCAN_DEPTH || visited >= MAX_SCAN_NODES) return
    if (Array.isArray(node)) {
      visited++
      for (const el of node) {
        if (visited >= MAX_SCAN_NODES) break
        walk(el, depth + 1)
      }
      return
    }
    if (typeof node !== "object") return
    visited++
    const obj = node as Record<string, unknown>
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || typeof v !== "object") {
        if (CANDIDATE_URL_KEYS.has(k) && typeof v === "string" && v.length > 0) {
          // cost_coins 优先用候选项自己那颗物件的，没有才退回顶层（照现有写法）。
          const cc = typeof obj.cost_coins === "number" ? obj.cost_coins : undefined
          // 真歌名/封面：候选物件自己带 title/cover 才认（缺省不带键，事件形状不变）。
          const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : undefined
          const cover = typeof obj.cover === "string" && obj.cover.trim() ? obj.cover.trim() : undefined
          if (isVideoUrl(v)) vidCands.push({ url: v, cost_coins: cc, ...(title ? { title } : {}) })
          if (isAudioUrl(v)) audCands.push({ url: v, cost_coins: cc, ...(title ? { title } : {}), ...(cover ? { cover } : {}) })
        }
        continue
      }
      walk(v, depth + 1)
    }
  }
  walk(parsed, 0)
  const topCost =
    typeof (parsed as Record<string, unknown>).cost_coins === "number"
      ? ((parsed as Record<string, unknown>).cost_coins as number)
      : undefined
  for (const c of vidCands) video.push({ url: c.url, cost_coins: c.cost_coins ?? topCost, ...(c.title ? { title: c.title } : {}) })
  for (const c of audCands) audio.push({ url: c.url, cost_coins: c.cost_coins ?? topCost, ...(c.title ? { title: c.title } : {}), ...(c.cover ? { cover: c.cover } : {}) })
  return { video, audio }
}
