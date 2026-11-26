import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, resolveKey } from "../lib/client"

// 风格货架信号层（B7，2026-08-31）：包 gateway（loopback）/agent/v1/timeline/style 端点族。
// list=查货架目录与各 clip 当前调色/转场；apply=套用（preset_id 或四滑杆，可选转场预设）；
// subtitles_ass=导出字卡 ASS 文本（烧录在母带导出闸执行）。
// 鉴权抄 timeline_mix 同款轮子（resolveKey → Bearer）。
const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

/** 错误体两种形状：409 为 flat {error:string}；400/404/500 为 {error:{message,type,code}} */
function extractError(data: Record<string, unknown>, status: number): string {
  const e = data?.error
  if (typeof e === "string" && e) return e
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message
  }
  return `HTTP ${status}`
}

export default tool({
  description:
    "风格货架（REQ-EDIT-08）：list 返回 12 个调色预设（cinematic/film/bw 等，四滑杆 brightness/contrast/saturation/temperature）、16 个转场预设（fade/fadeblack/circleopen 等，映射 ffmpeg xfade）、各 clip 当前 filter/transition、unsupported 清单（fx 组件/运动追踪不支持）。apply 给 clip_id 加 preset_id（或自定义四滑杆），可选 transition_preset_id 一起套；版本号+1，可 timeline_restore 回滚。subtitles_ass 返回当前时间线字幕的 ASS 文本（无字幕为空串）。fx 组件与运动追踪是妥协项，勿再请求。",
  args: {
    action: tool.schema.enum(["list", "apply", "subtitles_ass"]).describe("list=货架目录；apply=套用调色/转场；subtitles_ass=导出字卡 ASS 文本"),
    clip_id: tool.schema.string().optional().describe("apply 必填：目标 clip id"),
    preset_id: tool.schema.string().optional().describe("apply：调色预设 id（缺省时用 filter 四滑杆）"),
    brightness: tool.schema.number().min(-100).max(100).optional().describe("apply 自定义四滑杆"),
    contrast: tool.schema.number().min(-100).max(100).optional().describe("apply 自定义四滑杆"),
    saturation: tool.schema.number().min(-100).max(100).optional().describe("apply 自定义四滑杆"),
    temperature: tool.schema.number().min(-100).max(100).optional().describe("apply 自定义四滑杆"),
    transition_preset_id: tool.schema.string().optional().describe("apply：同批套用的转场预设 id（可省）"),
    transition_duration_sec: tool.schema.number().min(0).max(30).optional().describe("apply：转场时长，缺省用预设 defaultDuration"),
  },
  async execute(args, context) {
    let key: string
    try {
      key = await resolveKey(context.sessionID, context.abort)
    } catch (e) {
      return fail("auth_error", (e as Error).message || "无法解析 API key")
    }
    const base = `${GATEWAY}/agent/v1/timeline/style?session_id=${encodeURIComponent(context.sessionID)}`
    try {
      if (args.action === "subtitles_ass") {
        const res = await fetch(`${base}/subtitles.ass`, { headers: { Authorization: `Bearer ${key}` }, signal: context.abort })
        const text = await res.text()
        if (res.ok) return ok({ ass: text, empty: text.trim().length === 0 })
        return fail(`http_${res.status}`, text.slice(0, 300))
      }
      if (args.action === "list") {
        const res = await fetch(base, { headers: { Authorization: `Bearer ${key}` }, signal: context.abort })
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
        if (res.ok) return ok(data)
        return fail(`http_${res.status}`, extractError(data, res.status))
      }
      // apply
      if (!args.clip_id) return fail("bad_args", "apply 需要 clip_id（先 timeline_query 查 clip 列表）")
      if (!args.preset_id && args.brightness === undefined && args.contrast === undefined && args.saturation === undefined && args.temperature === undefined && !args.transition_preset_id) {
        return fail("bad_args", "apply 需要 preset_id、四滑杆至少一项、或 transition_preset_id")
      }
      const body: Record<string, unknown> = { clipId: args.clip_id, reason: "agent set_style" }
      if (args.preset_id) body.presetId = args.preset_id
      if (args.brightness !== undefined || args.contrast !== undefined || args.saturation !== undefined || args.temperature !== undefined) {
        body.filter = {
          brightness: args.brightness ?? 0,
          contrast: args.contrast ?? 0,
          saturation: args.saturation ?? 0,
          temperature: args.temperature ?? 0,
        }
      }
      if (args.transition_preset_id) body.transition = { presetId: args.transition_preset_id, durationSec: args.transition_duration_sec }
      const res = await fetch(base, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: context.abort,
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (res.ok) return ok(data)
      return fail(res.status === 400 ? "timeline_bad_query" : res.status === 404 ? "timeline_not_found" : `http_${res.status}`, extractError(data, res.status))
    } catch (e) {
      return fail("network_error", (e as Error).message || "gateway 不可达")
    }
  },
})
