import { tool } from "@opencode-ai/plugin/tool"
import { spawn } from "node:child_process"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { ok, fail, resolveKey } from "../lib/client"

// 配音时间轴（2026-08-31 片4）：台词表 → 逐行真 TTS → ffprobe 实测时长 → 累计 offset 锚点。
// 复用 tts_speak 的上游调法（gateway /agent/v1/tts，loopback，非平台 /v1——平台无 tts 端点）。
// 诚实纪律：时长一律 ffprobe 实测，不信估算；上游不可用如实回 tts_unavailable，不编造音频。

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"
// 静态 ffprobe（johnvansickle build）：URL 直读会段错误，必须先下载到本地档再探。
const FFPROBE = "/opt/eimu-harness/bin/ffprobe"
const RUN_DIR = "/opt/eimu-harness/workspace/.run"

interface Line {
  role: string
  text: string
}

/** 解析台词表：JSON 行阵列（{role|character, text|content|line}）或纯文字（每行一句，可「角色：内容」）。 */
function parseScript(raw: string): { lines: Line[]; error?: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { lines: [], error: "台词表为空" }
  // 先试 JSON
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
      return { lines: [], error: "JSON 解析失败：请传合法 JSON 行阵列，或用纯文字（每行一句）" }
    }
  }
  // 纯文字：按行切，支持「角色：内容」「角色: 内容」「- 内容」
  const lines: Line[] = []
  for (const ln of trimmed.split(/\r?\n/)) {
    const s = ln.replace(/^[-•*]\s*/, "").trim()
    if (!s) continue
    const m = /^([^：:]{1,20})[：:]\s*(.+)$/.exec(s)
    if (m && m[2].trim()) lines.push({ role: m[1].trim(), text: m[2].trim() })
    else lines.push({ role: "", text: s })
  }
  if (!lines.length) return { lines: [], error: "未解析到任何台词行" }
  return { lines }
}

/** ffprobe 实测本地音频档时长（秒）。失败回 null，不编造。 */
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
      env: { PATH: "/opt/eimu-harness/bin:/usr/local/bin:/usr/bin:/bin", HOME: "/opt/eimu-harness/workspace", LANG: "C.UTF-8" },
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
    "配音时间轴（audio-first）：输入台词表（JSON 行阵列 [{role, text}] 或纯文字每行一句，支持「角色：内容」），逐行调真 TTS 生成配音，ffprobe 实测每行时长，输出带累计 offset_ms 锚点的时间轴 JSON。用于「先配音后配画」的短片/动画时间轴锚点。\n\n【诚实】时长一律 ffprobe 实测，不信估算；TTS 上游不可用时回 tts_unavailable，不编造音频 URL；单行探测失败该行 duration_ms 标 null 并在 note 说明，不冒充。\n\n【成本】逐行按字符计价（当前极低，以每行返回的 cost_coins 为准，总和见 total_cost_coins）。max_lines 默认 20 防爆预算。speed 目前上游未接入语速控制，传入不生效（如实标注）。",
  args: {
    script: tool.schema
      .string()
      .min(1)
      .describe("台词表：JSON 行阵列字串 [{role, text}]（text/content/line 皆可，role/character/speaker 皆可），或纯文字每行一句"),
    voice: tool.schema.string().optional().describe("音色名（可选，透传上游）"),
    speed: tool.schema.number().min(0.5).max(2).optional().describe("语速（可选；当前上游未支持，传入不生效，如实标注）"),
    gap_ms: tool.schema.number().int().min(0).max(5000).optional().describe("行间静默毫秒，默认 0（offset 纯累加）"),
    max_lines: tool.schema.number().int().min(1).max(50).optional().describe("行数上限，默认 20，超出截断并在 truncated 标注"),
  },
  async execute(args, context) {
    const { lines, error } = parseScript(args.script)
    if (error) return fail("invalid_script", error, { title: "台词表解析失败" })

    const maxLines = args.max_lines ?? 20
    const truncated = lines.length > maxLines
    const work = lines.slice(0, maxLines)
    const gapMs = args.gap_ms ?? 0

    let key: string
    try {
      key = await resolveKey(context.sessionID, context.abort)
    } catch (e: any) {
      return fail("key_unresolved", e?.message || "无法解析 API key", { title: "钥匙解析失败" })
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
        // 1) 调 TTS（复用 tts_speak 上游调法）
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
      return fail(anyUnavailable.code, anyUnavailable.hint, {
        title: "配音上游暂缺",
        note: "台词已收到，但当前无法真实生成音轨；请如实告知用户，勿编造音频链接。",
      })
    }

    const totalDurationMs = offsetMs - (timeline.length ? gapMs : 0) // 末行不补尾间隔
    return ok(
      {
        title: `配音时间轴：${timeline.length} 行（实测 ${probedCount} 行时长）`,
        timeline,
        total_duration_ms: Math.max(0, totalDurationMs),
        total_cost_coins: Math.round(totalCost * 1e6) / 1e6,
        lines_requested: lines.length,
        lines_processed: timeline.length,
        truncated,
        speed_note: args.speed !== undefined ? "speed 已传入但当前上游未支持语速控制，不生效" : null,
        note: "逐行真 TTS + ffprobe 实测时长；offset_ms 为累计锚点（含 gap_ms）。duration_ms=null 的行探测失败未编造。",
      },
      { lines: timeline.length, total_duration_ms: Math.max(0, totalDurationMs) },
    )
  },
})
