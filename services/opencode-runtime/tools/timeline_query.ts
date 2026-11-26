import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, resolveKey } from "../lib/client"

// 时间线查询面（B2，2026-08-31）：包 gateway（loopback）/agent/v1/timeline 只读族
// （state/versions/diff/log）。鉴权抄 tts_speak 同款轮子（resolveKey → Bearer）。
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
    "时间线查询面：读取当前时间线完整状态（what=state，含每个 clip 的 id/path/inSec/outSec/speed/locked/group 与 total_duration_sec）、版本列表（versions）、两版本字段级差异（diff，需 a,b）、决策日志（log）。返回结构化 JSON，可直接继续计算，不是散文。执行任何 timeline_ops 前先用 state 拿真实 clip id；执行 timeline_restore 前先用 versions 查可用版本号（保留策略：最近 20 版 + 每 10 版里程碑）。",
  args: {
    what: tool.schema
      .enum(["state", "versions", "diff", "log"])
      .describe("state=当前时间线；versions=版本列表；diff=两版本对比（需 a、b）；log=决策日志"),
    a: tool.schema.number().int().min(1).optional().describe("diff 版本对：较早版本号（what=diff 时必填）"),
    b: tool.schema.number().int().min(1).optional().describe("diff 版本对：较晚版本号（what=diff 时必填）"),
    version: tool.schema.number().int().min(1).optional().describe("保留字段：当前未使用（单版本内容请用 versions+diff 获取）"),
  },
  async execute(args, context) {
    if (args.what === "diff" && (args.a === undefined || args.b === undefined)) {
      return fail("bad_args", "what=diff 需要 a 与 b（两个正整数版本号，先用 what=versions 查）")
    }
    let key: string
    try {
      key = await resolveKey(context.sessionID, context.abort)
    } catch (e) {
      return fail("auth_error", (e as Error).message || "无法解析 API key")
    }
    const paths: Record<string, string> = {
      state: "/agent/v1/timeline",
      versions: "/agent/v1/timeline/versions",
      diff: "/agent/v1/timeline/diff",
      log: "/agent/v1/timeline/log",
    }
    let url = `${GATEWAY}${paths[args.what]}?session_id=${encodeURIComponent(context.sessionID)}`
    if (args.what === "diff") url += `&a=${args.a}&b=${args.b}`
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        signal: context.abort,
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (res.ok) return ok({ what: args.what, ...data })
      const errMsg = extractError(data, res.status)
      if (res.status === 400) return fail("timeline_bad_query", errMsg)
      if (res.status === 404) return fail("timeline_not_found", errMsg)
      return fail(`http_${res.status}`, errMsg)
    } catch (e) {
      return fail("network_error", (e as Error).message || "gateway 不可达")
    }
  },
})
