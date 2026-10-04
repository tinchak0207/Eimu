import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, directorFail } from "../lib/director-common"

// 3D 导演台焦点切换（片4，2026-09-02）。schema 照搬 kunpeng selectTool；文档操作 =
// setActivePlan/setActiveShot 两 op（选中对象是 UI 层概念，gateway 文档无 selectedIds 栏位）。

export default tool({
  description:
    "切换方案或镜头，并选中一个真实舞台对象。只改变当前工作焦点，不修改工程内容。",
  args: {
    plan_id: tool.schema.string().optional().describe("要切换到的方案 ID"),
    shot_id: tool.schema.string().optional().describe("要切换到的镜头 ID"),
    element_id: tool.schema.string().optional().describe("要选中的对象 ID；传空字符串可清除对象选择。"),
    reason: tool.schema.string().min(1).describe("一句话说明为什么切换焦点（进决策日志，供审计）"),
  },
  async execute(args, context) {
    try {
      const ops: Array<Record<string, unknown>> = []
      if (args.plan_id !== undefined) ops.push({ op: "setActivePlan", plan_id: args.plan_id })
      if (args.shot_id !== undefined) ops.push({ op: "setActiveShot", shot_id: args.shot_id })
      if (ops.length === 0) {
        return fail("director_invalid_args", "至少提供 plan_id 或 shot_id 之一（对象选择不改变工程内容，直接在回复中确认即可）")
      }
      const data = await directorFetch(context.sessionID, "op", "POST", { ops, reason: args.reason }, context.abort)
      const project = data.project as { activePlanId?: string | null; activeShotId?: string | null } | undefined
      return ok({
        active_plan_id: project?.activePlanId ?? null,
        active_shot_id: project?.activeShotId ?? null,
        selected_element_id: args.element_id ?? null,
        revision: data.revision,
      })
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return directorFail(e)
    }
  },
})
