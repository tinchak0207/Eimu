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
    "子代理主动挂起当前执行并交出并发槽位（Suspend & Yield Concurrency）。",
    "用于在遇到上游限流或异步长任务（视频渲染、批次生图）时主动休眠，将宝贵的 3 个并发槽位腾出给其他子任务；待计时器到期或任务就绪时，由调度器自动恢复（Resume）并回灌结果。",
    "**字段说明**：",
    "  - `reason`：挂起原因（如「等待视频上游生成」「等待上游限流冷却」）；",
    "  - `timeout_seconds`：挂起时长秒数（默认 30 秒，到期网关自动恢复本子代理）；",
    "  - `task_id`：可选上游长任务 ID；",
    "  - `checkpoint_data`：挂起时保存的临时上下文数据（恢复时原样回灌）。",
    `示例参数：${EXAMPLE_JSON}`,
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
