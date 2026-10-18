import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

function selfAgent(context: { agent?: unknown }): string {
  const agent = typeof context.agent === "string" ? context.agent.trim() : ""
  const fromEnv = typeof process.env.AGENT_NAME === "string" ? process.env.AGENT_NAME.trim() : ""
  return agent || fromEnv || "team-lead"
}

export default tool({
  description: [
    "读取本 agent 的持久 mailbox（未读优先、同级最旧优先）。",
    "何时用：开工前、等待协作回执、唤醒后检查消息；只是要成员名用 mailbox_agents。",
    "何时不用：drain=true 会物理删除已读消息，只在确定消费完时使用。",
    "关键约束：默认不破坏数据；limit 默认 50、上限 500；after 为非负消息 id；读完不会自动标记已读。",
    "失败处置：invalid_args 表示 limit/after 越界或非整数；mailbox_read_failed 按 gateway 文本修正；gateway_unreachable 稍后重试。",
    "互指：发消息用 mailbox_send；查可寻址成员用 mailbox_agents；子代理实时状态用 subagent_status。",
    "示例：mailbox_read({limit:20})",
  ].join("\n"),
  args: {
    limit: tool.schema.number().optional().describe("最多读取条数（默认 50，上限 500）"),
    drain: tool.schema.boolean().optional().describe("true=消费即剪除本次返回及已读消息；默认 false"),
    after: tool.schema.number().optional().describe("只读消息 id 大于该值的记录（可选，按 id 升序分页）"),
    agent: tool.schema.string().optional().describe("要读取的信箱名（可选，默认读自己；读他人时必须已登记）"),
  },
  async execute(args, context) {
    const limit = args.limit
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > 500)) {
      return fail("invalid_args", "limit 必须是 1..500 的整数")
    }
    if (args.after !== undefined && (!Number.isInteger(args.after) || args.after < 0)) {
      return fail("invalid_args", "after 必须是非负整数消息 id")
    }
    try {
      const res = await fetch(`${GATEWAY}/internal/mailbox/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: context.sessionID,
          agent:
            typeof args.agent === "string" && args.agent.trim()
              ? args.agent.trim()
              : selfAgent(context as { agent?: unknown }),
          ...(limit !== undefined ? { limit } : {}),
          ...(args.after !== undefined ? { after: args.after } : {}),
          ...(args.drain === true ? { drain: true } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || data.ok !== true) {
        const error = (data.error ?? {}) as Record<string, unknown>
        return fail(
          typeof error.code === "string" && error.code ? error.code : "mailbox_read_failed",
          typeof error.message === "string" && error.message ? error.message : `HTTP ${res.status}`,
          { http_status: res.status },
        )
      }
      const messages = Array.isArray(data.messages) ? data.messages : []
      return ok({ title: `收到 ${messages.length} 条消息`, messages, count: messages.length })
    } catch (e) {
      return fail("gateway_unreachable", e instanceof Error ? e.message : String(e))
    }
  },
})
