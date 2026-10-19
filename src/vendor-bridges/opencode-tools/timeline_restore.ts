import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, resolveKey } from "../lib/client"

// 时间线还原面（B2，2026-08-31）：包 gateway（loopback）/agent/v1/timeline/restore。
// 鉴权抄 tts_speak 同款轮子（resolveKey → Bearer）。
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
    "把时间线还原到指定历史版本的快照。内容回到该版本，但版本号单调递增（生成新版本号=当前+1，不是回退编号）；restore 本身已记决策日志，可再次还原（撤销可再撤销）。调用前先用 timeline_query(what=versions) 确认目标版本仍在保留（最近 20 版 + 每 10 版里程碑），被裁剪的版本会返回 timeline_version_not_found。",
  args: {
    version: tool.schema.number().int().min(1).describe("要还原到的目标版本号（timeline_query what=versions 可查）"),
  },
  async execute(args, context) {
    let key: string
    try {
      key = await resolveKey(context.sessionID, context.abort)
    } catch (e) {
      return fail("auth_error", (e as Error).message || "无法解析 API key")
    }
    try {
      const res = await fetch(`${GATEWAY}/agent/v1/timeline/restore?session_id=${encodeURIComponent(context.sessionID)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ version: args.version }),
        signal: context.abort,
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (res.ok) {
        return ok({
          version: data.version,
          restored_from: data.restored_from,
          total_duration_sec: data.total_duration_sec,
          diff: data.diff,
          note: "restore 已记决策日志，版本号单调递增（新版本号=当前+1，非回到旧编号）。",
        })
      }
      const errMsg = extractError(data, res.status)
      if (res.status === 404) {
        return fail("timeline_version_not_found", `${errMsg}。用 timeline_query(what=versions) 查当前保留的版本号（最近 20 版 + 每 10 版里程碑）。`)
      }
      if (res.status === 400) return fail("timeline_invalid_op", errMsg)
      return fail(`http_${res.status}`, errMsg)
    } catch (e) {
      return fail("network_error", (e as Error).message || "gateway 不可达")
    }
  },
})
