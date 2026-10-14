import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

const EXAMPLE_ARGS = {
  subagent_id: "latest",
  payload: {
    video_url: "https://store.tinchak0207.xyz/rendered/video_933.mp4",
    status: "completed",
  },
}
const EXAMPLE_JSON = JSON.stringify(EXAMPLE_ARGS)

export default tool({
  description: [
    "主动恢复一个处于挂起（suspended）状态的子代理（Resume Subagent）。",
    "可由主代理在观察到异步长任务完成或满足恢复条件时显式调用；若当前并发槽已满（3/3），恢复请求将自动进入排队队列，待槽位释放后自动获取槽位恢复执行。",
    "**字段说明**：",
    "  - `subagent_id`：要恢复的子代理 ID，或 `latest`；",
    "  - `resume_token`：可选令牌（若由子代理自身挂起回传）；",
    "  - `payload`：可选回传给恢复后子代理的数据或结果文本（如异步完成的视频链接）。",
    `示例参数：${EXAMPLE_JSON}`,
  ].join("\n"),
  args: {
    subagent_id: tool.schema
      .string()
      .optional()
      .describe("要恢复的子代理 ID，或传 `latest`（必填）"),
    resume_token: tool.schema
      .string()
      .optional()
      .describe("挂起时返回的 resume_token（可选）"),
    payload: tool.schema
      .any()
      .optional()
      .describe("注入给子代理的恢复数据（如异步任务已就绪的生成 URL 或数据对象）"),
  },
  async execute(args, context) {
    const subagentId = typeof args.subagent_id === "string" ? args.subagent_id.trim() : ""
    if (!subagentId) {
      return fail(
        "missing_required_args",
        `subagent_resume 缺少必填字段：subagent_id。示例：${EXAMPLE_JSON}`,
        { missing: ["subagent_id"], example: EXAMPLE_ARGS },
      )
    }

    try {
      const res = await fetch(`${GATEWAY}/internal/subagent/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: context.sessionID,
          subagent_id: subagentId,
          resume_token: args.resume_token,
          payload: args.payload,
          trigger_source: "manual",
        }),
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        return fail(
          typeof data?.code === "string" && data.code ? data.code : "resume_failed",
          data?.error || `HTTP ${res.status}`,
          { http_status: res.status },
        )
      }
      return ok({
        title: data.queued ? "恢复请求已入队等待槽位" : "子代理已恢复运行",
        ...data,
      })
    } catch (e) {
      return fail("network_error", `恢复通信失败：${e instanceof Error ? e.message : String(e)}`)
    }
  },
})
