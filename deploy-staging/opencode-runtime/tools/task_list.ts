import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const token = process.env.HARNESS_INTERNAL_TOKEN
  if (token) headers["X-Internal-Token"] = token
  return headers
}

/** P2-11：解析网关 {error:{message,type,code}}，返回真实 message/code。 */
function errorDetail(data: Record<string, unknown>, status: number, fallbackCode: string): { code: string; message: string } {
  const err = data.error as { message?: unknown; type?: unknown; code?: unknown } | string | undefined
  if (err && typeof err === "object") {
    const message = typeof err.message === "string" && err.message ? err.message : `HTTP ${status}`
    const code =
      typeof err.code === "string" && err.code
        ? err.code
        : typeof err.type === "string" && err.type
          ? err.type
          : fallbackCode
    return { code, message }
  }
  if (typeof err === "string" && err) return { code: fallbackCode, message: err }
  return { code: fallbackCode, message: `HTTP ${status}` }
}

export default tool({
  description: [
    "列出本会话全部任务摘要（id、subject、status、owner、blockedBy），按 id 升序。",
    "何时用：挑下一个工作、建任务前查重、检查整体进度；已知 taskId 且要完整描述时改用 task_get。",
    "关键约束：摘要不含完整描述；多个候选优先 id 较小的 pending 任务；blockedBy 非空的不做。",
    "失败处置：task_list_failed 按 gateway 错误文本处理；gateway_unreachable 表示网关不可达，稍后重试；空列表是合法结果，不要据此伪造任务。",
    "互指：读单条全文用 task_get；建任务用 task_create；改状态用 task_update。",
    "示例：task_list()",
  ].join("\n"),
  args: {},
  async execute(_args, context) {
    try {
      const res = await fetch(`${GATEWAY}/internal/task/list`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ session_id: context.sessionID }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || data.success === false) {
        const detail = errorDetail(data, res.status, "task_list_failed")
        return fail(detail.code, detail.message, { http_status: res.status, result: data })
      }
      const tasks = Array.isArray(data.tasks) ? data.tasks : []
      return ok({ title: `共 ${tasks.length} 条任务`, ...data, tasks })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
