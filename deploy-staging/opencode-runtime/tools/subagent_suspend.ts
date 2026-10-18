import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

const EXAMPLE_ARGS = {
  reason: "等待 MiniMax-H3 视频生成任务完成，让出并发槽位",
  timeout_seconds: 60,
  task_id: "task_video_933_minimax_01",
  checkpoint_data: {
    shots_prepared: [1, 2],
    video_prompt: "Camera moves forward slowly through the misty valley",
  },
}
const EXAMPLE_JSON = JSON.stringify(EXAMPLE_ARGS)

export default tool({
  description: [
    "子代理主动挂起并交出并发槽。",
    "何时用：遇到上游限流或视频渲染等长任务，需要把槽位让给其他子任务时。",
    "何时不用：主代理不要调用；普通短暂等待不需要挂起。",
    "关键约束：timeout_seconds 默认 30，到期自动恢复；checkpoint_data 原样回灌；恢复由调度器或 subagent_resume 触发。",
    "示例：subagent_suspend({reason:\"等待视频上游生成\", timeout_seconds:120, task_id:\"vid_123\"})",
  ].join("\n"),
  args: {
    reason: tool.schema
      .string()
      .optional()
      .describe("挂起原因说明（如「等待视频生成完成」「触发限流主动休眠 30 秒」）"),
    timeout_seconds: tool.schema
      .number()
      .optional()
      .describe("挂起等待时长秒数（默认 30 秒，最大 1800 秒；到期自动恢复获得并发槽）"),
    task_id: tool.schema
      .string()
      .optional()
      .describe("等待的上游异步任务 ID（可选）"),
    checkpoint_data: tool.schema
      .record(tool.schema.string(), tool.schema.any())
      .optional()
      .describe("挂起时需保存的上下文状态数据（可选，恢复时注入）"),
  },
  async execute(args, context) {
    const reason = typeof args.reason === "string" ? args.reason.trim() : "子代理主动挂起等待异步任务"
    const timeoutSeconds = typeof args.timeout_seconds === "number" && args.timeout_seconds > 0 ? args.timeout_seconds : 30
    const taskId = typeof args.task_id === "string" ? args.task_id.trim() : undefined

    try {
      const res = await fetch(`${GATEWAY}/internal/subagent/suspend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: context.sessionID,
          reason,
          condition: {
            type: taskId ? "poll_task" : "timer",
            task_id: taskId,
            timeout_seconds: timeoutSeconds,
          },
          checkpoint_data: args.checkpoint_data,
        }),
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        return fail(
          typeof data?.code === "string" && data.code ? data.code : "suspend_failed",
          data?.error || `HTTP ${res.status}`,
          { http_status: res.status },
        )
      }
      return ok({
        title: "子代理已挂起并交出并发槽位",
        subagent_id: data.subagent_id,
        resume_token: data.resume_token,
        status: "suspended",
        timeout_seconds: data.timeout_seconds,
        note: data.note || "并发槽位已成功释放；条件满足或超时后网关将自动恢复本会话执行。",
      })
    } catch (e) {
      return fail("network_error", `挂起通信失败：${e instanceof Error ? e.message : String(e)}`)
    }
  },
})
