// critic-audio-parts.ts — 评审席（critic）原生听被审的音乐/音频。
//
// 背景（2026-11-22 暴君追问「critic／音乐创作反馈全周期有覆盖吗」）：此前只有用户上传的音频能被原生听
// （turn-audio-parts）；critic 子会话只收到带 audio_url 的文字任务书，没有任何听音频的通路，
// checkCriticReceipt 又只认图片/视频的感知回执 → 音乐交付永远判 PARTIAL/退回。
//
// 本档：从 critic 任务书文字里抽音频 URL → 下载（限 https、拒内网、15MB 上限）→ 与上传共用
// encodeAudioFile（非 wav/mp3 转 mp3）→ 产出 file part ＋ 回执（artifact/sha256/bytes/model）。
// 回执交给 checkCriticReceipt 当「实际感知」证据，只有真的把音频送进了能听的模型才有，换到不能听的
// 模型（故障转移）回执为空 → 诚实判 PARTIAL，不冒充。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { MAX_AUDIO_BYTES, MAX_AUDIO_TOTAL_BYTES, MAX_TURN_AUDIOS, encodeAudioFile, type TurnAudioPart } from "./turn-audio-parts.ts"

const AUDIO_URL_RE = /\.(m4a|mp3|wav|aac|ogg|flac|opus)(?:[?#]|$)/i
const DOWNLOAD_TIMEOUT_MS = 25_000

export type CriticAudioReceipt = { artifact: string; sha256: string; bytes: number; mime: string; model: string }
export type CriticAudioResult = {
  parts: TurnAudioPart[]
  receipts: CriticAudioReceipt[]
  skipped: Array<{ artifact: string; reason: string }>
  /** 任务书里出现过的音频目标总数（0＝与音频无关，调用方不注入任何提示）。 */
  targets: number
}

/** 拒绝内网/回环/链路本地主机（交付正文是 agent 写的文字，不能当 SSRF 入口）。 */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

// 不复用 media-quality 的 URL_RE：任务书是 orchestrator 手写的 markdown，URL 常被反引号/全角竖线包着
// （2026-11-22 真会话：`https://…m4a` ｜ 本地 WAV），那条正则会把反引号吞进 URL，扩展名对不上 → 漏附音频。
const WRAPPED_URL_RE = /https?:\/\/[^\s"'<>)\]`，。、;；｜|]+/gi

export function extractAudioTargets(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return []
  const seen = new Set<string>()
  for (const m of text.matchAll(WRAPPED_URL_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/, "")
    if (AUDIO_URL_RE.test(url)) seen.add(url)
  }
  return [...seen]
}

export async function buildCriticAudioParts(opts: {
  prompt: string
  model: { providerID: string; modelID: string }
  fetchImpl?: typeof fetch
}): Promise<CriticAudioResult> {
  const targets = extractAudioTargets(opts.prompt)
  const out: CriticAudioResult = { parts: [], receipts: [], skipped: [], targets: targets.length }
  if (targets.length === 0) return out
  const doFetch = opts.fetchImpl ?? fetch
  const modelLabel = `${opts.model.providerID}/${opts.model.modelID}`
  let total = 0
  for (const url of targets) {
    if (out.parts.length >= MAX_TURN_AUDIOS) {
      out.skipped.push({ artifact: url, reason: "over_audio_limit" })
      continue
    }
    let u: URL
    try {
      u = new URL(url)
    } catch {
      out.skipped.push({ artifact: url, reason: "bad_url" })
      continue
    }
    if (u.protocol !== "https:" || isBlockedHost(u.hostname)) {
      out.skipped.push({ artifact: url, reason: "url_not_allowed" })
      continue
    }
    const dir = mkdtempSync(path.join(tmpdir(), "critic-audio-"))
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: "error" })
      if (!res.ok) {
        out.skipped.push({ artifact: url, reason: `download_http_${res.status}` })
        continue
      }
      const declared = Number(res.headers.get("content-length") ?? "0")
      if (declared > MAX_AUDIO_BYTES) {
        out.skipped.push({ artifact: url, reason: "audio_too_large" })
        continue
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0) {
        out.skipped.push({ artifact: url, reason: "empty_file" })
        continue
      }
      if (buf.length > MAX_AUDIO_BYTES || total + buf.length > MAX_AUDIO_TOTAL_BYTES) {
        out.skipped.push({ artifact: url, reason: "audio_too_large" })
        continue
      }
      const ext = (path.extname(u.pathname) || ".bin").replace(/[^.a-zA-Z0-9]/g, "").slice(0, 8) || ".bin"
      const file = path.join(dir, `artifact${ext}`)
      writeFileSync(file, buf)
      const enc = await encodeAudioFile(file, total)
      if ("reason" in enc) {
        out.skipped.push({ artifact: url, reason: enc.reason })
        continue
      }
      total += enc.bytes
      out.parts.push(enc.part)
      out.receipts.push({ artifact: url, sha256: enc.sha256, bytes: enc.bytes, mime: enc.part.mime, model: modelLabel })
    } catch (e) {
      out.skipped.push({ artifact: url, reason: e instanceof Error ? `download_failed:${e.message.slice(0, 80)}` : "download_failed" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  return out
}
