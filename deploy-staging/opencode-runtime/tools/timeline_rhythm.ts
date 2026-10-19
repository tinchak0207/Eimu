import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, resolveKey } from "../lib/client"

// 时间线节奏计算器（B3，2026-08-31）：包 gateway（loopback）/agent/v1/timeline/rhythm 只读端点。
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
    "节奏计算器（规则版，REQ-EDIT-02）：对当前时间线做可复现的节奏体检，返回结构化 JSON 报告，不是散文。curve=2 秒滑动窗口的对白密度（字/秒）与平均镜头时长与情绪标签；flags=定位到毫秒区间的问题清单（dialog_overload 对白过载>6字/秒、shot_too_long 单镜>8s、dead_air 连续≥2s 无字幕无音频且总占比>15%、pace_flat 节奏平铺、climax_off_expected 高潮偏离 75% 位置超 10%），每条含 severity 与指向具体 clip_id 的修改建议；climax=最后一个高潮情绪标签镜头中点与期望位置的偏移（无任何 emotionTag 时为 null 并在 notes 诚实降级）；beats=有 BGM 时的节拍秒数组（可选 bgm 参数覆盖时间线 BGM，支持本地路径或 http URL）。先修 must/should 且 clip_id 明确的 flag，再按 curve 微调长短交错。",
  args: {
    bgm: tool.schema
      .string()
      .optional()
      .describe("可选：BGM 音频文件路径或 http URL，用于节拍检测；缺省时用时间线自带 bgm（如有）"),
  },
  async execute(args, context) {
    let key: string
    try {
      key = await resolveKey(context.sessionID, context.abort)
    } catch (e) {
      return fail("auth_error", (e as Error).message || "无法解析 API key")
    }
    let url = `${GATEWAY}/agent/v1/timeline/rhythm?session_id=${encodeURIComponent(context.sessionID)}`
    if (args.bgm) url += `&bgm=${encodeURIComponent(args.bgm)}`
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
