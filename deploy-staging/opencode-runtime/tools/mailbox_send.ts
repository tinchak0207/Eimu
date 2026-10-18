import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

// 约束：与 gateway MESSAGE_TYPES 保持一致；"*" 广播已移除，未知类型会被 gateway 拒绝。
const MAILBOX_TYPES = [
  "message",
  "idle_notification",
  "task_assignment",
  "task_completed",
  "teammate_terminated",
  "plan_approval_request",
  "plan_approval_response",
  "permission_request",
  "permission_response",
  "sandbox_permission_request",
  "sandbox_permission_response",
] as const

function selfAgent(context: { agent?: unknown }): string {
  const agent = typeof context.agent === "string" ? context.agent.trim() : ""
  const fromEnv = typeof process.env.AGENT_NAME === "string" ? process.env.AGENT_NAME.trim() : ""
  return agent || fromEnv || "team-lead"
}

export default tool({
  description: [
    "给同一会话内另一个 agent 或 lead（main）发持久邮箱消息。",
    "何时用：跨 agent 传结论、请求协作或回执；要纠偏运行中的子代理、回答它的阻塞提问，用 subagent_message。",
    "何时不用：不要把 agent 消息当用户授权；不要用广播代替逐个通知（广播已禁用）。",
    "关键约束：to 只能是 mailbox_agents 列出的成员或 main；收件人未知时先 mailbox_agents 查，不要猜名字；工具不接收 msg_id，重发即重复；只有回执带 msg_id 才算送达。",
    "失败处置：missing_required_args 表示 to 或 text 为空；其它 mailbox code 按 gateway 文本修正（收件人未知会回 candidates）；gateway_unreachable 稍后重试。",
    "互指：读取用 mailbox_read，成员名用 mailbox_agents；改变子代理当前工作用 subagent_message，不要用邮箱代替。",
    "示例：mailbox_send({to:reviewer, text:请复核 final.mp4 的字幕轴, summary:请求复核字幕})",
  ].join("\n"),
  args: {
    to: tool.schema.string().optional().describe("收件人：已登记成员名或 \"main\"（必填；禁止 \"*\"）"),
    text: tool.schema.string().optional().describe("消息正文（必填）；协议帧类型时必须是 JSON 字符串"),
    summary: tool.schema.string().optional().describe("一行摘要（可选）"),
    type: tool.schema.enum(MAILBOX_TYPES).optional().describe("消息类型（可选，默认 message）"),
    msg_id: tool.schema
      .string()
      .optional()
      .describe("幂等键（可选，≤128 字符）；网络重试时原样带回，避免重复投递"),
  },
  async execute(args, context) {
    const to = typeof args.to === "string" ? args.to.trim() : ""
    const text = typeof args.text === "string" ? args.text : ""
    if (!to) return fail("missing_required_args", "mailbox_send 需要 to（成员名或 \"main\"）")
    if (!text) return fail("missing_required_args", "mailbox_send 需要非空 text")
    try {
      const res = await fetch(`${GATEWAY}/internal/mailbox/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: context.sessionID,
          from: selfAgent(context as { agent?: unknown }),
          to,
          text,
          ...(typeof args.summary === "string" ? { summary: args.summary } : {}),
          ...(args.type !== undefined ? { type: args.type } : {}),
          ...(typeof args.msg_id === "string" && args.msg_id.trim() ? { msg_id: args.msg_id.trim() } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || data.ok !== true) {
        const error = (data.error ?? {}) as Record<string, unknown>
        return fail(
          typeof error.code === "string" && error.code ? error.code : "mailbox_send_failed",
          typeof error.message === "string" && error.message ? error.message : `HTTP ${res.status}`,
          { http_status: res.status, candidates: data.candidates },
        )
      }
      return ok({
        title: data.delivered === true ? `已发送给 ${String(data.to ?? to)}` : `消息已存在（未重复投递）：${String(data.to ?? to)}`,
        msg_id: data.msg_id,
        to: data.to,
        team: data.team,
        duplicate: data.duplicate === true,
        delivered: data.delivered === true,
      })
    } catch (e) {
      return fail("gateway_unreachable", e instanceof Error ? e.message : String(e))
    }
  },
})
