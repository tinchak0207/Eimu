import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, resolveKey } from "../lib/client"

// 混音量测信号层（B5，2026-08-31）：包 gateway（loopback）/agent/v1/timeline/mix 端点。
// 默认 GET 只量测不落盘；args.apply=true 走 POST 渲染 mix.wav。
// 鉴权抄 timeline_lint 同款轮子（resolveKey → Bearer）。
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
    "混音量测与渲染（REQ-EDIT-06，三轨 voice/music/sfx）：默认只量测不落盘，返回结构化 MixReport——layers 各轨 clip 数、measured（ebur128 实测 integrated_lufs/true_peak_dbtp/lra，非估计）、compliant（|LUFS+16|<=1.5 且 TP<=-1.0）、ducking_events（人声侧链压制 BGM/SFX 的进出事件，in 事件 depth_db 为实测）、sync_errors（track 不存在/超出时间线/素材不可达等）、notes（诚实边界）。args.apply=true 时渲染落盘 mix.wav（loudnorm 两遍法 I=-16/TP=-1.5/LRA=11）并返回 outPath/publicUrl。sync_errors 非空时不渲染不量测——先按 clip_id 修时间线再重跑；compliant=false 如实返回实测数据，由你调整 timeline 音量/素材后重跑，无自动重混闭环。",
  args: {
    apply: tool.schema.boolean().optional().describe("true=渲染落盘 mix.wav（POST）；缺省/false=只量测报告（GET）"),
  },
  async execute(args, context) {
    let key: string
    try {
      key = await resolveKey(context.sessionID, context.abort)
    } catch (e) {
      return fail("auth_error", (e as Error).message || "无法解析 API key")
    }
    const apply = args.apply === true
    const url = `${GATEWAY}/agent/v1/timeline/mix?session_id=${encodeURIComponent(context.sessionID)}`
    try {
      const res = await fetch(url, {
        method: apply ? "POST" : "GET",
        headers: { Authorization: `Bearer ${key}` },
        signal: context.abort,
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (res.ok) return ok(data)
      const errMsg = extractError(data, res.status)
      if (res.status === 400) return fail("timeline_bad_query", errMsg)
      if (res.status === 404) return fail("timeline_not_found", errMsg)
      return fail(`http_${res.status}`, errMsg)
    } catch (e) {
      return fail("network_error", (e as Error).message || "gateway 不可达")
    }
  },
})
