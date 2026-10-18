import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

const MIN_DELAY_SECONDS = 60
const MAX_DELAY_SECONDS = 3600

function errorText(data: unknown, fallback: string): string {
  const d = (data ?? {}) as Record<string, unknown>
  if (typeof d.error === "string" && d.error) return d.error
  const nested = d.error as Record<string, unknown> | undefined
  if (nested && typeof nested.hint === "string" && nested.hint) return nested.hint
  if (nested && typeof nested.message === "string" && nested.message) return nested.message
  if (typeof d.code === "string" && d.code) return `${fallback} (${d.code})`
  return fallback
}

export default tool({
  description: [
    "安排一次自调度唤醒：到期把 prompt 原样送回当前会话；也可停止循环。",
    "何时用：需要稍后再查一次状态、循环任务续期，或本轮检查无变化要安静续期；等待外部条件优先 monitor_watch。",
    "关键约束：delaySeconds 钳制 60–3600；reason 与 prompt 必填，prompt 是完整指令不是摘要；stop=true 取消该会话全部待触发唤醒；noop=true 只属于本工具（表示无变化，折叠并累计 streak）。",
    "失败处置：missing_delay/missing_reason/missing_prompt 补齐对应字段；wakeup_failed 按 gateway 文本修正；gateway_unreachable 稍后重试。",
    "互指：monitor_watch 没有 noop 参数；监视外部事件用 monitor_watch，周期任务用 cron_create。",
    "示例：schedule_wakeup({delaySeconds:300, reason:检查视频任务, prompt:检查 task_id=abc 的状态；完成则下载验收，未完成则再安排 300 秒后检查。})",
  ].join("\n"),
  args: {
    delaySeconds: tool.schema
      .number()
      .optional()
      .describe("多少秒后唤醒；运行时钳制到 60–3600（必填，stop=true 时忽略）"),
    reason: tool.schema
      .string()
      .optional()
      .describe("一句话说明这次唤醒要做什么（给用户看，必填；stop=true 时忽略）"),
    prompt: tool.schema
      .string()
      .optional()
      .describe("唤醒时原样送入会话的完整指令（必填；stop=true 时忽略）"),
    stop: tool.schema
      .boolean()
      .optional()
      .describe("true = 立即结束循环，取消该会话所有待触发唤醒，忽略其他字段"),
    noop: tool.schema
      .boolean()
      .optional()
      .describe("true = 本次检查无变化（连续 noop 折叠并记录 streak）"),
  },
  async execute(args, context) {
    const stop = args.stop === true
    let clampedDelay = MIN_DELAY_SECONDS
    if (!stop) {
      if (typeof args.delaySeconds !== "number" || !Number.isFinite(args.delaySeconds)) {
        return fail("missing_delay", `delaySeconds 必填，取值 ${MIN_DELAY_SECONDS}–${MAX_DELAY_SECONDS} 秒`)
      }
      clampedDelay = Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, Math.round(args.delaySeconds)))
      if (typeof args.reason !== "string" || !args.reason.trim()) {
        return fail("missing_reason", "reason 必填：用一句话说明这次唤醒要做什么（给用户看）")
      }
      if (typeof args.prompt !== "string" || !args.prompt.trim()) {
        return fail("missing_prompt", "prompt 必填：唤醒时原样送入会话的完整指令")
      }
    }

    const pathname = stop ? "/internal/wakeup/stop" : "/internal/wakeup/schedule"
    const payload: Record<string, unknown> = { session_id: context.sessionID }
    if (!stop) {
      payload.delaySeconds = clampedDelay
      payload.reason = args.reason
      payload.prompt = args.prompt
      if (args.noop === true) payload.noop = true
    }

    try {
      const res = await fetch(`${GATEWAY}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || (data as { ok?: boolean })?.ok === false) {
        return fail(
          typeof (data as { code?: unknown })?.code === "string" ? ((data as { code: string }).code) : "wakeup_failed",
          errorText(data, `HTTP ${res.status}`),
          { http_status: res.status },
        )
      }
      if (stop) {
        return ok({ stopped: true, cancelled: (data as { cancelled?: number }).cancelled ?? 0 })
      }
      return ok({
        scheduled: true,
        id: (data as { id?: number }).id,
        fire_at: (data as { fire_at?: number }).fire_at,
        delaySeconds: (data as { delaySeconds?: number }).delaySeconds ?? clampedDelay,
        noop_streak: (data as { noop_streak?: number }).noop_streak ?? 0,
      })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error)?.message || String(e))
    }
  },
})
