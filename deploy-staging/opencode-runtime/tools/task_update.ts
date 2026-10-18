// @deprecated 已从 opencode.json 禁用：eimu-guard 对 task 工具抛错，且 tools/ 会被加载器注册。不要删除本文件。
import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const token = process.env.HARNESS_INTERNAL_TOKEN
  if (token) headers["X-Internal-Token"] = token
  return headers
}

/** P2-11：解析网关 {error:{message,type,code}}，返回真实 message/code。 */
function errorDetail(data: Record<string, unknown>, status: number, fallbackCode: string): { code: string; message: string } {
  const err = data.error as { message?: unknown; type?: unknown; code?: unknown } | string | undefined
  if (err && typeof err === "object") {
    const message = typeof err.message === "string" && err.message ? err.message : `HTTP ${status}`
    const code =
      typeof err.code === "string" && err.code
        ? err.code
        : typeof err.type === "string" && err.type
          ? err.type
          : fallbackCode
    return { code, message }
  }
  if (typeof err === "string" && err) return { code: fallbackCode, message: err }
  return { code: fallbackCode, message: `HTTP ${status}` }
}

export default tool({
  description: [
    "更新任务字段、状态与依赖（认领、推进、补依赖、改描述、删除作废任务）。",
    "何时用：任务一完成立刻标 completed；被阻塞时补 addBlockedBy；作废任务用 status=deleted 真删。",
    "何时不用：不要用它伪造完成；未完全达成验收标准时保持 in_progress。",
    "状态语义：pending 待办、in_progress 进行中、completed 完全达成、deleted 永久删除；completed 前 gateway 会校验 blockedBy。",
    "失败处置：missing_required_args 表示 taskId 非法；task_blocked 表示 blockedBy 未完成，先解决依赖；task_update_failed 按 gateway 文本修正；gateway_unreachable 稍后重试。",
    "互指：改前用 task_get 读最新态；查重用 task_list；不要用 task_create 代替更新。",
    "Hook 语义：TaskCompleted 是写库后的通知（fire-and-forget），hook 失败不会回滚或拒绝本次更新。",
    "owner：任意合法 agent 名（如 director）；空字符串或 null 表示释放认领。",
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
        headers: authHeaders(),
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
        const detail = errorDetail(data, res.status, "task_update_failed")
        const blocked = detail.message.startsWith("blocked by")
        return fail(blocked ? "task_blocked" : detail.code, detail.message, { http_status: res.status, result: data })
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
