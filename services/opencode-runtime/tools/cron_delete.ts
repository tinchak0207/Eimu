import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, harnessInternalHeaders } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description: [
    "按 id 取消一个由 cron_create 创建的定时任务。",
    "durable 任务会同时从 scheduled_tasks.json 移除；仅本会话的任务从内存表移除。",
    "关键约束：id 必须是 cron_list 返回的正整数；删除不存在的任务会回 cron_delete_failed；取消不可撤销。",
    "失败处置：missing_required_args 表示 id 非正整数；cron_delete_failed 表示任务不存在或不属于本会话，先 cron_list 核对；gateway_unreachable 稍后重试。",
    "互指：找 id 用 cron_list；重排时间用 cron_create 新建；一次性唤醒取消用 schedule_wakeup 的 stop。",
    "示例：cron_delete({id:3})",
  ].join("\n"),
  args: {
    id: tool.schema.number().describe("cron_list 返回的任务 id"),
  },
  async execute(args, context) {
    const id = typeof args.id === "number" && Number.isInteger(args.id) && args.id > 0 ? args.id : null
    if (id === null) return fail("missing_required_args", "id 必须是正整数。")
    try {
      const res = await fetch(`${GATEWAY}/internal/cron/delete`, {
        method: "POST",
        headers: harnessInternalHeaders(),
        body: JSON.stringify({ session_id: context.sessionID, id }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || data.success === false) {
        return fail(
          typeof data.code === "string" && data.code ? data.code : "cron_delete_failed",
          typeof data.error === "string" && data.error ? data.error : "定时任务不存在或不属于本会话",
          { http_status: res.status, id },
        )
      }
      return ok({ title: `已取消定时任务 #${id}`, id })
    } catch (e) {
      return fail("gateway_unreachable", `取消定时任务失败：${e instanceof Error ? e.message : String(e)}`)
    }
  },
})
