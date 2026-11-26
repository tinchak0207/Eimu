import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

function internalHeaders(): Record<string, string> {
  const token = process.env.HARNESS_INTERNAL_TOKEN
  return {
    "Content-Type": "application/json",
    ...(typeof token === "string" && token ? { "X-Internal-Token": token } : {}),
  }
}

export default tool({
  description: [
    "列出本会话可寻址的 agent 名、角色与 main 别名。",
    "何时用：mailbox_send 前不确定收件人时；已知成员名可直接发，不必每次查。",
    "关键约束：to 只能取这份清单；清单为空时先让 lead 登记成员，不要猜名字；返回 addressable 与 team 供核对。",
    "失败处置：mailbox_agents_failed 按 gateway 文本修正；gateway_unreachable 表示网关不可达，稍后重试；空清单是合法结果，不要据此编造成员。",
    "互指：发消息用 mailbox_send，收消息用 mailbox_read；子代理派遣用 subagent_dispatch。",
    "示例：mailbox_agents()",
  ].join("\n"),
  args: {},
  async execute(_args, context) {
    try {
      const res = await fetch(`${GATEWAY}/internal/mailbox/agents`, {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify({ session_id: context.sessionID }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || data.ok !== true) {
        const error = (data.error ?? {}) as Record<string, unknown>
        return fail(
          typeof error.code === "string" && error.code ? error.code : "mailbox_agents_failed",
          typeof error.message === "string" && error.message ? error.message : `HTTP ${res.status}`,
          { http_status: res.status },
        )
      }
      return ok({
        title: `可寻址 agent ${Array.isArray(data.agents) ? data.agents.length : 0} 个`,
        self: data.self,
        team: data.team,
        lead: data.lead,
        agents: data.agents,
        addressable: data.addressable,
      })
    } catch (e) {
      return fail("gateway_unreachable", e instanceof Error ? e.message : String(e))
    }
  },
})
