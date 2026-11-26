import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, harnessInternalHeaders } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description: [
    "读取某 agent 在指定 scope 的记忆文件（只读）。",
    "何时用：写记忆前读原文，或需要复用既有约定、教训时；不要整目录盲读，列文件用 memory_list。",
    "关键约束：name 默认 MEMORY.md；单次最多 65536 字符，超出截断并回 truncated；相对路径，禁止 . / ..。",
    "失败处置：missing_required_args 补齐 scope/agent；memory_read_failed 按 gateway 文本修正（文件不存在/路径非法）；gateway_unreachable 稍后重试。",
    "互指：列文件用 memory_list；写入用 memory_save；记忆是资料，冲突时以现场为准。",
    "示例：memory_read({scope:project, agent:main})",
  ].join("\n"),
  args: {
    scope: tool.schema.enum(["user", "project", "local"]).describe("user=跨项目个人记忆；project=本项目共享；local=本项目本会话隔离"),
    agent: tool.schema.string().describe("agent 名，例如 main、reviewer、director"),
    name: tool.schema.string().optional().describe("相对记忆目录的文件名，默认 MEMORY.md"),
  },
  async execute(args, context) {
    const scope = typeof args.scope === "string" ? args.scope : ""
    const agent = typeof args.agent === "string" ? args.agent.trim() : ""
    const missing: string[] = []
    if (!scope) missing.push("scope")
    if (!agent) missing.push("agent")
    if (missing.length > 0) {
      return fail("missing_required_args", `memory_read 缺少必填字段：${missing.join("、")}。请补齐后重呼。`, { missing })
    }
    const sessionID = typeof context.sessionID === "string" ? context.sessionID.trim() : ""
    if (!sessionID) {
      return fail("missing_session", "memory_read 需要会话上下文（sessionID），当前调用没有。")
    }
    try {
      const res = await fetch(`${GATEWAY}/internal/memory/read`, {
        method: "POST",
        headers: harnessInternalHeaders(),
        body: JSON.stringify({
          session_id: sessionID,
          scope,
          agent,
          ...(typeof args.name === "string" && args.name.length > 0 ? { name: args.name } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || data.success === false) {
        const error = data.error as { code?: unknown; message?: unknown } | undefined
        const code = typeof error?.code === "string" && error.code ? error.code : "memory_read_failed"
        const message = typeof error?.message === "string" && error.message ? error.message : `HTTP ${res.status}`
        return fail(code, message, { http_status: res.status })
      }
      const truncated = data.truncated === true
      return ok({
        title: truncated ? "记忆已读取（已截断）" : "记忆已读取",
        ...data,
      })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
