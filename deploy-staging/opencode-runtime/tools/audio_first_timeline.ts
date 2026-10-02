import { tool } from "@opencode-ai/plugin/tool"
import { spawn } from "node:child_process"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { ok, fail, resolveKey } from "../lib/client"

// 配音時間軸（2026-08-31 片4）：台詞表 → 逐行真 TTS → ffprobe 實測時長 → 累計 offset 錨點。
// 復用 tts_speak 的上游調法（gateway /agent/v1/tts，loopback，非平台 /v1——平台無 tts 端點）。
// 誠實紀律：時長一律 ffprobe 實測，不信估算；上游不可用如實回 tts_unavailable，不編造音頻。

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"
// 靜態 ffprobe（johnvansickle build）：URL 直讀會段錯誤，必須先下載到本地檔再探。
const FFPROBE = "/opt/agent-harness/bin/ffprobe"
const RUN_DIR = "/opt/agent-harness/workspace/.run"

interface Line {
  role: string
  text: string
}

/** 解析台詞表：JSON 行陣列（{role|character, text|content|line}）或純文字（每行一句，可「角色：內容」）。 */
function parseScript(raw: string): { lines: Line[]; error?: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { lines: [], error: "台詞表為空" }
  // 先試 JSON
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed)
      const arr = Array.isArray(j) ? j : [j]
      const lines: Line[] = []
      for (const item of arr) {
        if (typeof item === "string") {
          if (item.trim()) lines.push({ role: "", text: item.trim() })
          continue
        }
        if (item && typeof item === "object") {
          const o = item as Record<string, unknown>
          const text = [o.text, o.content, o.line, o.dialogue].find(
            (v): v is string => typeof v === "string" && v.trim().length > 0,
          )
          const role = [o.role, o.character, o.speaker, o.name].find(
            (v): v is string => typeof v === "string" && v.trim().length > 0,
          )
          if (text) lines.push({ role: (role ?? "").trim(), text: text.trim() })
        }
      }
      if (!lines.length) return { lines: [], error: "JSON 中未解析到任何含 text/content/line 的行" }
      return { lines }
    } catch {
      return { lines: [], error: "JSON 解析失敗：請傳合法 JSON 行陣列，或用純文字（每行一句）" }
    }
  }
  // 純文字：按行切，支持「角色：內容」「角色: 內容」「- 內容」
  const lines: Line[] = []
  for (const ln of trimmed.split(/\r?\n/)) {
    const s = ln.replace(/^[-•*]\s*/, "").trim()
    if (!s) continue
    const m = /^([^：:]{1,20})[：:]\s*(.+)$/.exec(s)
    if (m && m[2].trim()) lines.push({ role: m[1].trim(), text: m[2].trim() })
    else lines.push({ role: "", text: s })
  }
  if (!lines.length) return { lines: [], error: "未解析到任何台詞行" }
  return { lines }
}

/** ffprobe 實測本地音頻檔時長（秒）。失敗回 null，不編造。 */
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

export default tool({
  description:
    "配音時間軸（audio-first）：輸入台詞表（JSON 行陣列 [{role, text}] 或純文字每行一句，支持「角色：內容」），逐行調真 TTS 生成配音，ffprobe 實測每行時長，輸出帶累計 offset_ms 錨點的時間軸 JSON。用於「先配音後配畫」的短片/動畫時間軸錨點。\n\n【誠實】時長一律 ffprobe 實測，不信估算；TTS 上游不可用時回 tts_unavailable，不編造音頻 URL；單行探測失敗該行 duration_ms 標 null 並在 note 說明，不冒充。\n\n【成本】逐行按字符計價（當前極低，以每行返回的 cost_coins 為準，總和見 total_cost_coins）。max_lines 默認 20 防爆預算。speed 目前上游未接入語速控制，傳入不生效（如實標注）。",
  args: {
    script: tool.schema
      .string()
      .min(1)
      .describe("台詞表：JSON 行陣列字串 [{role, text}]（text/content/line 皆可，role/character/speaker 皆可），或純文字每行一句"),
    voice: tool.schema.string().optional().describe("音色名（可選，透傳上游）"),
    speed: tool.schema.number().min(0.5).max(2).optional().describe("語速（可選；當前上游未支持，傳入不生效，如實標注）"),
    gap_ms: tool.schema.number().int().min(0).max(5000).optional().describe("行間靜默毫秒，默認 0（offset 純累加）"),
    max_lines: tool.schema.number().int().min(1).max(50).optional().describe("行數上限，默認 20，超出截斷並在 truncated 標注"),
  },
  async execute(args, context) {
    const { lines, error } = parseScript(args.script)
    if (error) return fail("invalid_script", error, { title: "台詞表解析失敗" })

    const maxLines = args.max_lines ?? 20
    const truncated = lines.length > maxLines
    const work = lines.slice(0, maxLines)
    const gapMs = args.gap_ms ?? 0

    let key: string
    try {
      key = await resolveKey(context.sessionID, context.abort)
    } catch (e: any) {
      return fail("key_unresolved", e?.message || "無法解析 API key", { title: "鑰匙解析失敗" })
    }

    const dir = `${RUN_DIR}/a4t-${Date.now()}-${randomBytes(4).toString("hex")}`
    await mkdir(dir, { recursive: true }).catch(() => {})

    const timeline: Record<string, unknown>[] = []
    let offsetMs = 0
    let totalCost = 0
    let anyUnavailable: { code: string; hint: string } | null = null
    let probedCount = 0

    try {
      for (let i = 0; i < work.length; i++) {
        const line = work[i]
        const entry: Record<string, unknown> = {
          index: i,
          role: line.role || null,
          text: line.text,
          offset_ms: offsetMs,
        }
        // 1) 調 TTS（復用 tts_speak 上游調法）
        let ttsResp: Response
        try {
          ttsResp = await fetch(`${GATEWAY}/agent/v1/tts`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              text: line.text,
              ...(args.voice ? { voice: args.voice } : {}),
              ...(args.speed !== undefined ? { speed: args.speed } : {}),
            }),
            signal: context.abort,
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
          const audio = await fetch(data.url, { signal: context.abort ?? AbortSignal.timeout(30_000) })
          if (audio.ok) {
            const buf = Buffer.from(await audio.arrayBuffer())
            if (buf.length > 0) {
              const f = `${dir}/line_${i}.mp3`
              await writeFile(f, buf)
              const sec = await probeDurationSec(f, context.abort)
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
      return fail(anyUnavailable.code, anyUnavailable.hint, {
        title: "配音上游暫缺",
        note: "台詞已收到，但當前無法真實生成音軌；請如實告知用戶，勿編造音頻鏈接。",
      })
    }

    const totalDurationMs = offsetMs - (timeline.length ? gapMs : 0) // 末行不補尾間隔
    return ok(
      {
        title: `配音時間軸：${timeline.length} 行（實測 ${probedCount} 行時長）`,
        timeline,
        total_duration_ms: Math.max(0, totalDurationMs),
        total_cost_coins: Math.round(totalCost * 1e6) / 1e6,
        lines_requested: lines.length,
        lines_processed: timeline.length,
        truncated,
        speed_note: args.speed !== undefined ? "speed 已傳入但當前上游未支持語速控制，不生效" : null,
        note: "逐行真 TTS + ffprobe 實測時長；offset_ms 為累計錨點（含 gap_ms）。duration_ms=null 的行探測失敗未編造。",
      },
      { lines: timeline.length, total_duration_ms: Math.max(0, totalDurationMs) },
    )
  },
})
