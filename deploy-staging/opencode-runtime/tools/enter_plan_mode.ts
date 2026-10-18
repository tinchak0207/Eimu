import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, harnessInternalHeaders } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description: [
    "进入计划模式：只研究与规划，不写代码、不执行写操作。",
    "何时用：需要先产出完整实现计划、再由用户批准时；单纯查资料或读代码不要进入。",
    "关键约束：写操作会被工具闸拦下；计划必须写入返回的 plan_file_path；离开必须走 exit_plan_mode。",
    "失败处置：enter_plan_mode_failed 说明网关拒绝或状态已变化，按错误文本修正后重呼；gateway_unreachable 表示网关不可达，稍后重试；不要用写操作试探是否已进入计划模式。",
    "互指：退出并请求批准用 exit_plan_mode；任务拆解用 task_create；计划文件是唯一权威，不要只写在对话里。",
    "示例：enter_plan_mode()",
  ].join("\n"),
  args: {},
  async execute(_args, context) {
    try {
      const res = await fetch(`${GATEWAY}/internal/plan/enter`, {
        method: "POST",
        headers: harnessInternalHeaders(),
        body: JSON.stringify({ session_id: context.sessionID }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || data.success === false) {
        return fail(
          typeof data.code === "string" && data.code ? data.code : "enter_plan_mode_failed",
          typeof data.error === "string" && data.error ? data.error : `HTTP ${res.status}`,
          { http_status: res.status },
        )
      }
      return ok({
        title: "已进入计划模式",
        mode: data.mode,
        plan_file_path: data.planFilePath,
        plan_slug: data.planSlug,
        pre_plan_mode: data.prePlanMode,
        note: `把完整计划写入 ${String(data.planFilePath)}，完成后调用 exit_plan_mode 请求用户批准。批准前不要开始实施。`,
      })
    } catch (e) {
      return fail("gateway_unreachable", `进入计划模式失败：${e instanceof Error ? e.message : String(e)}`)
    }
  },
})
