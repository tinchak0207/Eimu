import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description: [
    "读取一条任务的完整内容：描述、状态、owner、blocks/blockedBy 与 metadata。",
    "何时用：开工前、修改前需要完整描述与依赖时；只想挑选任务用 task_list 即可，不必逐条 task_get。",
    "关键约束：blockedBy 非空不得开工；修改前先读最新态，避免拿过期信息覆盖；taskId 必须是正整数。",
    "失败处置：missing_required_args 表示 taskId 不是正整数；task_not_found 表示任务不存在或不属于本会话，先用 task_list 核对；gateway_unreachable 稍后重试。",
    "互指：批量浏览用 task_list；改状态/依赖用 task_update；建新任务用 task_create。",
    "示例：task_get({taskId:7})",
  ].join("\n"),
  args: {
    taskId: tool.schema.number().describe("任务 ID（task_create / task_list 返回的 id）"),
  },
  async execute(args, context) {
    const taskId = args.taskId
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return fail("missing_required_args", "task_get 需要正整数 taskId")
    }
    try {
      const res = await fetch(`${GATEWAY}/internal/task/get`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: context.sessionID, taskId }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || data.success === false) {
        const code = typeof data.code === "string" && data.code ? data.code : "task_not_found"
        const message = typeof data.error === "string" && data.error ? data.error : `HTTP ${res.status}`
        return fail(code, message, { http_status: res.status, result: data })
      }
      return ok({ title: `任务 #${taskId}`, ...data })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
