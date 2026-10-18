import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description: [
    "写入 agent 记忆文件（user/project/local）。",
    "何时用：用户明确要求记住，或提炼出对未来会话稳定的偏好、教训；临时过程可从现场重得的事实不要写。",
    "关键约束：单文件 ≤100KB；name 以 .md 结尾、NFC、禁止 . / .. 与反斜线；append 仍受同一上限；不得写入凭证、token、私钥或连接串；保存成功后不要立刻读回。",
    "失败处置：missing_required_args 补齐 scope/agent/content；memory_save_failed 按 gateway 的路径/大小/secret 扫描错误修正；gateway_unreachable 稍后重试。",
    "互指：写前用 memory_read 读原文，列文件用 memory_list；需要跨会话检索用 memory_recall。",
    "示例：memory_save({scope:project, agent:main, content:交付前必须核对真实成片，不以工具回执代替。, mode:append})",
  ].join("\n"),
  args: {
    scope: tool.schema.enum(["user", "project", "local"]).describe("user=跨项目个人记忆；project=本项目共享；local=本项目本会话隔离"),
    agent: tool.schema.string().describe("agent 名，例如 main、reviewer、director"),
    name: tool.schema.string().optional().describe("相对记忆目录的文件名，默认 MEMORY.md；可含子目录，必须以 .md 结尾"),
    content: tool.schema.string().describe("要写入的完整内容，UTF-8 文本"),
    mode: tool.schema.enum(["overwrite", "append"]).optional().describe("默认 overwrite；append 追加"),
  },
  async execute(args, context) {
    const scope = typeof args.scope === "string" ? args.scope : ""
    const agent = typeof args.agent === "string" ? args.agent.trim() : ""
    const content = typeof args.content === "string" ? args.content : ""
    const missing: string[] = []
    if (!scope) missing.push("scope")
    if (!agent) missing.push("agent")
    if (typeof args.content !== "string") missing.push("content")
    if (missing.length > 0) {
      return fail("missing_required_args", `memory_save 缺少必填字段：${missing.join("、")}。请补齐后重呼。`, { missing })
    }
    // 约束：租户/工作区由网关用 session 解析，工具只持有 session id。
    const sessionID = typeof context.sessionID === "string" ? context.sessionID.trim() : ""
    if (!sessionID) {
      return fail("missing_session", "memory_save 需要会话上下文（sessionID），当前调用没有。")
    }
    try {
      const res = await fetch(`${GATEWAY}/internal/memory/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionID,
          scope,
          agent,
          content,
          ...(typeof args.name === "string" && args.name.length > 0 ? { name: args.name } : {}),
          ...(typeof args.mode === "string" ? { mode: args.mode } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || data.success === false) {
        const error = data.error as { code?: unknown; message?: unknown } | undefined
        const code = typeof error?.code === "string" && error.code ? error.code : "memory_save_failed"
        const message = typeof error?.message === "string" && error.message ? error.message : `HTTP ${res.status}`
        return fail(code, message, { http_status: res.status })
      }
      const bytes = typeof data.bytes === "number" ? data.bytes : null
      return ok({
        title: bytes === null ? "记忆已写入" : `记忆已写入（${bytes} bytes）`,
        ...data,
      })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
