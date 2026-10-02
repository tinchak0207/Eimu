import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description:
    "查询已派出子代理（subagent）的运行状态/结果。用于：async 派出后主动查进度、判断多个并行子代理是否到齐、唤醒过后想复核摘要。返回运行中（done=false，含已耗时）或终态（done=true，ok=summary / error=死因）。结果保留 10 分钟，过期会报不存在。禁止用它在循环里 sleep 轮询等待——后台子代理完成会自动唤醒你。",
  args: {
    subagent_id: tool.schema.string().describe("subagent_dispatch 返回的 subagent_id"),
  },
  async execute(args, context) {
    try {
      const res = await fetch(`${GATEWAY}/internal/subagent/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: context.sessionID, subagent_id: args.subagent_id }),
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        return fail("not_found", data?.error || `HTTP ${res.status}`)
      }
      if (data.done) {
        if (data.status === "ok") {
          return ok({ title: "子代理已完成", status: "ok", summary: data.summary ?? "" })
        }
        return fail("subagent_error", data.error || data.summary || "子代理失败", { done: true })
      }
      return ok({
        title: "子代理运行中",
        subagent_id: args.subagent_id,
        status: "running",
        label: data.label ?? "",
        elapsed_ms: data.elapsed_ms ?? 0,
        note: "仍在运行，结束本轮等自动唤醒即可；不要 sleep 轮询。",
      })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
