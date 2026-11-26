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
    "按 msg_id 把本 agent 自己邮箱里的消息标记为已读（不删除）。",
    "何时用：读完一批消息后想让未读归零；drain 会消费整批，只想标记指定消息时用本工具。",
    "关键约束：只能操作调用者自己的邮箱（身份由网关按 session 推导，指定他人不存在入口）；msg_ids 必须是消息的 msg_id 字符串数组；全部非法（非字符串/空白）时返回 400。",
    "失败处置：missing_required_args 表示 msg_ids 为空；msg_ids 全非法按 gateway 文本修正；网关不可达稍后重试。",
    "互指：读消息用 mailbox_read；发消息用 mailbox_send；成员名用 mailbox_agents。",
    "示例：mailbox_mark_read({msg_ids:[\"msg_abc\",\"msg_def\"]})",
  ].join("\n"),
  args: {
    msg_ids: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("要标记已读的 msg_id 数组（必填，至少一个非空字符串）"),
  },
  async execute(args, context) {
    const msgIds = Array.isArray(args.msg_ids) ? args.msg_ids : []
    if (msgIds.length === 0) return fail("missing_required_args", "mailbox_mark_read 需要非空 msg_ids")
    try {
      const res = await fetch(`${GATEWAY}/internal/mailbox/mark-read`, {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify({
          session_id: context.sessionID,
          msg_ids: msgIds,
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || data.ok !== true) {
        const error = (data.error ?? {}) as Record<string, unknown>
        return fail(
          typeof error.code === "string" && error.code ? error.code : "mailbox_mark_read_failed",
          typeof error.message === "string" && error.message ? error.message : `HTTP ${res.status}`,
          { http_status: res.status },
        )
      }
      const marked = typeof data.marked === "number" ? data.marked : 0
      return ok({ title: `已标记 ${marked} 条消息为已读`, marked, agent: data.agent })
    } catch (e) {
      return fail("gateway_unreachable", e instanceof Error ? e.message : String(e))
    }
  },
})
