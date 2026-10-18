import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description: [
    "更新任务字段、状态与依赖（认领、推进、补依赖、改描述、删除作废任务）。",
    "何时用：任务一完成立刻标 completed；被阻塞时补 addBlockedBy；作废任务用 status=deleted 真删。",
    "何时不用：不要用它伪造完成；未完全达成验收标准时保持 in_progress。",
    "状态语义：pending 待办、in_progress 进行中、completed 完全达成、deleted 永久删除；completed 前 gateway 会校验 blockedBy。",
    "失败处置：missing_required_args 表示 taskId 非法；task_blocked 表示 blockedBy 未完成，先解决依赖；task_update_failed 按 gateway 文本修正；gateway_unreachable 稍后重试。",
    "互指：改前用 task_get 读最新态；查重用 task_list；不要用 task_create 代替更新。",
    "示例：task_update({taskId:7, status:in_progress, owner:director})",
  ].join("\n"),
  args: {
    taskId: tool.schema.number().describe("要更新的任务 ID"),
    status: tool.schema
      .enum(["pending", "in_progress", "completed", "deleted"])
      .optional()
      .describe("新状态：pending 待办 / in_progress 进行中 / completed 已完成（必须完全达成）/ deleted 永久删除"),
    subject: tool.schema.string().optional().describe("新的任务标题（祈使句）"),
    description: tool.schema.string().optional().describe("新的完整任务描述"),
    activeForm: tool.schema.string().optional().describe("进行中显示的一行文案"),
    owner: tool.schema.string().optional().describe("认领人；空字符串或 null 表示释放认领"),
    metadata: tool.schema.object({}).passthrough().optional().describe("要合并进 metadata 的键值；值为 null 表示删除该键"),
    addBlocks: tool.schema.array(tool.schema.number()).optional().describe("本任务阻塞了哪些任务（这些任务要等本任务完成）"),
    addBlockedBy: tool.schema.array(tool.schema.number()).optional().describe("本任务依赖哪些任务（它们未完成前本任务不得 completed）"),
    removeBlocks: tool.schema.array(tool.schema.number()).optional().describe("解除「本任务阻塞某些任务」的依赖（对称清理对端 blockedBy）"),
    removeBlockedBy: tool.schema.array(tool.schema.number()).optional().describe("解除「本任务依赖某些任务」的依赖（对称清理对端 blocks）"),
  },
  async execute(args, context) {
    const taskId = args.taskId
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return fail("missing_required_args", "task_update 需要正整数 taskId")
    }
    try {
      const res = await fetch(`${GATEWAY}/internal/task/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: context.sessionID,
          taskId,
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(args.subject !== undefined ? { subject: args.subject } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.activeForm !== undefined ? { activeForm: args.activeForm } : {}),
          ...(args.owner !== undefined ? { owner: args.owner } : {}),
          ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
          ...(args.addBlocks !== undefined ? { addBlocks: args.addBlocks } : {}),
          ...(args.addBlockedBy !== undefined ? { addBlockedBy: args.addBlockedBy } : {}),
          ...(args.removeBlocks !== undefined ? { removeBlocks: args.removeBlocks } : {}),
          ...(args.removeBlockedBy !== undefined ? { removeBlockedBy: args.removeBlockedBy } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || data.success === false) {
        const blocked = typeof data.error === "string" && data.error.startsWith("blocked by")
        const code = blocked ? "task_blocked" : typeof data.code === "string" && data.code ? data.code : "task_update_failed"
        const message = typeof data.error === "string" && data.error ? data.error : `HTTP ${res.status}`
        return fail(code, message, { http_status: res.status, result: data })
      }
      const statusChange = data.statusChange as { from?: unknown; to?: unknown } | undefined
      const title =
        typeof statusChange?.to === "string" ? `任务 #${taskId} → ${statusChange.to}` : `任务 #${taskId} 已更新`
      return ok({ title, ...data })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
