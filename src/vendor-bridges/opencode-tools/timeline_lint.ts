import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, resolveKey } from "../lib/client"

// 剪辑诊断器信号层（B4，2026-08-31）：包 gateway（loopback）/agent/v1/timeline/lint 只读端点。
// 鉴权抄 timeline_query 同款轮子（resolveKey → Bearer）。
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
    "剪辑诊断器·信号层（REQ-EDIT-03，电影语言 linter 的可复现子集）：交付前必跑；对当前时间线逐 clip 的 trim 窗口跑 ffmpeg 信号检测，返回结构化 LintResult（issues/passed/skipped），不是散文。issues 每条含时间线毫秒坐标 t_start_ms/t_end_ms、clip_id、type、severity 与证据、修复提示：must 级=black_frame 黑帧、white_flash 闪白（YAVG>240 连续≥3帧）、audio_clip 爆音削顶（Peak>-0.5dB）、av_mismatch 尾段超源时长（导出会黑/冻）、no_audio_track 无声硬伤（源无音轨且无配音/BGM 覆盖）；should 级=silence_gap 长停顿（-40dB≥1.5s）、volume_jump 相邻片段响度差>12dB、freeze 冻帧≥2s、lint_timeout 单 clip 检测超时60s。must 未清不可导出（B6 导出硬闸门前置规矩，此处先立）。skipped 诚实列出语义层五项（越轴/动作连续性/光/脸/口型）——当前无可靠复现检测，不谎报。逐条按 clip_id 修，修完重跑直到 passed=true。",
  args: {},
  async execute(args, context) {
    let key: string
    try {
      key = await resolveKey(context.sessionID, context.abort)
    } catch (e) {
      return fail("auth_error", (e as Error).message || "无法解析 API key")
    }
    const url = `${GATEWAY}/agent/v1/timeline/lint?session_id=${encodeURIComponent(context.sessionID)}`
    try {
      const res = await fetch(url, {
        method: "GET",
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
