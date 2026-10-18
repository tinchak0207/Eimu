import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, harnessInternalHeaders } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

type CronTask = {
  id?: number
  cron?: string
  prompt?: string
  recurring?: boolean
  durable?: boolean
  permanent?: boolean
  next_fire_at?: number | null
  last_fired_at?: number | null
  created_at?: number
  status?: string
}

function local(ms: unknown): string | null {
  return typeof ms === "number" && Number.isFinite(ms)
    ? new Date(ms).toLocaleString("zh-CN", { hour12: false })
    : null
}

export default tool({
  description: [
    "列出通过 cron_create 创建的定时任务（含 durable 与仅本会话两种）。",
    "每条返回 id、cron、prompt、recurring、durable、实际下一次触发时间 next_fire_at。",
    "何时用：汇报触发时间、核对任务是否仍在、删除前找 id；向用户说时间要用 next_fire_at，不要用 cron 表达式里的分钟。",
    "status=unknown 表示可能已经投递，排程暂停且没有下一次触发时间；先核对原会话，禁止直接重建或重投。",
    "失败处置：cron_list_failed 按 gateway 文本修正；gateway_unreachable 稍后重试；空列表是合法结果。",
    "互指：创建用 cron_create，取消用 cron_delete；一次性唤醒用 schedule_wakeup。",
    "示例：cron_list()",
  ].join("\n"),
  args: {},
  async execute(_args, context) {
    try {
      const res = await fetch(`${GATEWAY}/internal/cron/list`, {
        method: "POST",
        headers: harnessInternalHeaders(),
        body: JSON.stringify({ session_id: context.sessionID }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || data.success === false) {
        return fail(
          typeof data.code === "string" && data.code ? data.code : "cron_list_failed",
          typeof data.error === "string" && data.error ? data.error : `HTTP ${res.status}`,
          { http_status: res.status },
        )
      }
      const tasks = (Array.isArray(data.tasks) ? data.tasks : []) as CronTask[]
      return ok({
        title: tasks.length > 0 ? `共 ${tasks.length} 个定时任务` : "当前没有定时任务",
        tasks: tasks.map((task) => ({
          ...task,
          next_fire_local: local(task.next_fire_at),
          last_fired_local: local(task.last_fired_at),
        })),
      })
    } catch (e) {
      return fail("gateway_unreachable", `读取定时任务失败：${e instanceof Error ? e.message : String(e)}`)
    }
  },
})
