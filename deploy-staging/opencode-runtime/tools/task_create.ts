import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description: [
    "新建一条跨轮保留的持久任务，写进会话任务板。",
    "何时用：任务 ≥3 步、需要拆成多个任务、或用户明确要任务清单；单一步骤的琐事直接做，不建任务。",
    "关键约束：建前先 task_list 查重；subject 用祈使句；description 写清目标、素材、验收标准与产出格式；依赖用 task_update 的 addBlocks/addBlockedBy 设置。",
    "失败处置：missing_required_args 表示 subject 或 description 为空，补齐后重呼；task_create_failed 带 gateway 原始 code，按错误文本修正；gateway_unreachable 表示网关不可达，稍后重试，不要重复建同一条。",
    "互指：查重与浏览用 task_list；读完整描述用 task_get；任何状态/依赖变更用 task_update，不要重建任务代替更新。",
    "示例：task_create({subject:整理素材清单, description:列出 uploads 下全部图片、尺寸与用途，输出 Markdown 表格；验收：每张图都有路径与用途。})",
  ].join("\n"),
  args: {
    subject: tool.schema.string().describe("任务标题，祈使句，简短可读，如「整理素材清单」"),
    description: tool.schema.string().describe("完整任务描述：要做什么、素材与输入、验收标准、预期产出格式"),
    activeForm: tool.schema.string().optional().describe("任务进行中显示的一行文案，如「正在整理素材」"),
    metadata: tool.schema.object({}).passthrough().optional().describe("自由附加的键值，用于记录出处、链接等非流程信息"),
  },
  async execute(args, context) {
    const subject = typeof args.subject === "string" ? args.subject.trim() : ""
    const description = typeof args.description === "string" ? args.description.trim() : ""
    const missing: string[] = []
    if (!subject) missing.push("subject")
    if (!description) missing.push("description")
    if (subject.length > 200) {
      return fail("invalid_subject", `subject 最多 200 字符（当前 ${subject.length}），请收敛成一句祈使句`)
    }
    if (description.length > 8000) {
      return fail("invalid_description", `description 最多 8000 字符（当前 ${description.length}），请压缩成可执行的验收描述`)
    }
    if (missing.length > 0) {
      return fail("missing_required_args", `task_create 缺少必填字段：${missing.join("、")}。请补齐后重呼。`, { missing })
    }
    try {
      const res = await fetch(`${GATEWAY}/internal/task/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: context.sessionID,
          subject,
          description,
          ...(typeof args.activeForm === "string" ? { activeForm: args.activeForm } : {}),
          ...(args.metadata && typeof args.metadata === "object" ? { metadata: args.metadata } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || data.success === false) {
        const code = typeof data.code === "string" && data.code ? data.code : "task_create_failed"
        const message = typeof data.error === "string" && data.error ? data.error : `HTTP ${res.status}`
        return fail(code, message, { http_status: res.status, result: data })
      }
      const task = data.task as { id?: unknown; subject?: unknown } | undefined
      const id = typeof task?.id === "number" ? task.id : null
      return ok({ title: id === null ? "任务已创建" : `已创建任务 #${id}`, ...data })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
