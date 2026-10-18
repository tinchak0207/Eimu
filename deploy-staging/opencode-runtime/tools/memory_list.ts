import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description: [
    "列出某 agent 在指定 scope 下的记忆文件。",
    "何时用：写新文件前看已有文件，避免重复创建；要正文时用 memory_read。",
    "关键约束：只返回相对 path、bytes、updatedAt；不跟随 symlink；scope 为 user/project/local。",
    "失败处置：missing_required_args 补齐 scope/agent；memory_list_failed 按 gateway 文本修正；gateway_unreachable 稍后重试；空目录是合法结果。",
    "互指：读正文用 memory_read；写入用 memory_save；跨会话检索用 memory_recall。",
    "示例：memory_list({scope:local, agent:director})",
  ].join("\n"),
  args: {
    scope: tool.schema.enum(["user", "project", "local"]).describe("user=跨项目个人记忆；project=本项目共享；local=本项目本会话隔离"),
    agent: tool.schema.string().describe("agent 名，例如 main、reviewer、director"),
  },
  async execute(args, context) {
    const scope = typeof args.scope === "string" ? args.scope : ""
    const agent = typeof args.agent === "string" ? args.agent.trim() : ""
    const missing: string[] = []
    if (!scope) missing.push("scope")
    if (!agent) missing.push("agent")
    if (missing.length > 0) {
      return fail("missing_required_args", `memory_list 缺少必填字段：${missing.join("、")}。请补齐后重呼。`, { missing })
    }
    const sessionID = typeof context.sessionID === "string" ? context.sessionID.trim() : ""
    if (!sessionID) {
      return fail("missing_session", "memory_list 需要会话上下文（sessionID），当前调用没有。")
    }
    try {
      const res = await fetch(`${GATEWAY}/internal/memory/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionID, scope, agent }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || data.success === false) {
        const error = data.error as { code?: unknown; message?: unknown } | undefined
        const code = typeof error?.code === "string" && error.code ? error.code : "memory_list_failed"
        const message = typeof error?.message === "string" && error.message ? error.message : `HTTP ${res.status}`
        return fail(code, message, { http_status: res.status })
      }
      const count = typeof data.count === "number" ? data.count : Array.isArray(data.files) ? data.files.length : 0
      return ok({
        title: `记忆文件 ${count} 个`,
        ...data,
      })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
