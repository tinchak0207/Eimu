import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, harnessInternalHeaders } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

function formatLocal(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null
  return new Date(ms).toLocaleString("zh-CN", { hour12: false })
}

export default tool({
  description: [
    "在未来的某个时间把一段 prompt 送进本会话：周期执行（cron）或只执行一次。",
    "使用标准 5 字段 cron，按用户本地时区解释（分 时 日 月 周）；一次性任务 recurring:false 并把日/月/时/分钉死。",
    "关键约束：任务只在会话空闲时触发；durable 默认 false，只有用户明确要求跨会话保留才传 true；周期任务 7 天后过期，permanent:true 可跳过；运行时加固定偏移。",
    "失败处置：missing_required_args 补齐 cron/prompt；cron_create_failed 按 gateway 文本修正（表达式非法/无下次触发）；gateway_unreachable 稍后重试。",
    "互指：一次性稍后检查用 schedule_wakeup；等待外部事件用 monitor_watch；取消用 cron_delete。",
    "示例：cron_create({cron:0 9 * * 1-5, prompt:汇总昨日交付并列出未完成项, recurring:true})",
  ].join("\n"),
  args: {
    cron: tool.schema
      .string()
      .describe("5 字段 cron（本地时区）：minute hour day-of-month month day-of-week，如 `*/5 * * * *`"),
    prompt: tool.schema.string().describe("到点要送进本会话的完整 prompt"),
    recurring: tool.schema
      .boolean()
      .optional()
      .describe("是否周期执行；默认 true。一次性提醒传 false，并把日/月/时/分钉死"),
    durable: tool.schema
      .boolean()
      .optional()
      .describe("是否落盘跨重启保留；默认 false（仅当前会话）。仅当用户明确要求持久化时传 true"),
    permanent: tool.schema
      .boolean()
      .optional()
      .describe("周期任务是否跳过 7 天过期；默认 false"),
  },
  async execute(args, context) {
    const cron = typeof args.cron === "string" ? args.cron.trim() : ""
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
    if (!cron || !prompt) {
      return fail("missing_required_args", "cron 与 prompt 都是必填字段。", {
        missing: [!cron ? "cron" : "", !prompt ? "prompt" : ""].filter(Boolean),
      })
    }
    try {
      const res = await fetch(`${GATEWAY}/internal/cron/create`, {
        method: "POST",
        headers: harnessInternalHeaders(),
        body: JSON.stringify({
          session_id: context.sessionID,
          cron,
          prompt,
          recurring: args.recurring !== false,
          durable: args.durable === true,
          permanent: args.permanent === true,
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || data.success === false) {
        return fail(
          typeof data.code === "string" && data.code ? data.code : "cron_create_failed",
          typeof data.error === "string" && data.error ? data.error : `HTTP ${res.status}`,
          { http_status: res.status },
        )
      }
      const next = formatLocal(data.next_fire_at)
      return ok({
        title: `定时任务已创建 #${String(data.id)}`,
        ...data,
        next_fire_local: next,
        note: next
          ? `实际下一次触发：${next}（含网关偏移）。请把这个时间告诉用户。`
          : "该表达式在可搜索窗口内没有下一次触发时间，请检查 cron 表达式。",
      })
    } catch (e) {
      return fail("gateway_unreachable", `创建定时任务失败：${e instanceof Error ? e.message : String(e)}`)
    }
  },
})
