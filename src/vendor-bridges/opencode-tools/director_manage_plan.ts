import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, guardFail, activePlanOf } from "../lib/director-common"

// 3D 导演台方案管理（片4，2026-09-02；R3 2026-09-03 补 add_plan）。schema 照搬 kunpeng managePlanTool；
// add_plan=addPlan（bare 壳 {name, shots:[]}，gateway 本就会激活新方案，set_active=false 时建后切回原方案）；
// switch=setActivePlan；rename=updatePlan（名称/摘要至少一项，轮子守卫文案）；
// duplicate=duplicatePlan（新方案 id 从 changed 回读）；delete=removePlan（至少留一）。

export default tool({
  description:
    "管理导演方案：新建、切换、重命名、复制或删除。add_plan 新建方案（工程无方案或要多方案时用）；切换不会修改内容；删除至少保留一个方案。",
  args: {
    operation: tool.schema.enum(["add_plan", "switch", "rename", "duplicate", "delete"]).describe("方案操作"),
    plan_id: tool.schema.string().optional().describe("目标方案 ID（switch/rename/duplicate/delete 必填；add_plan 不需要）"),
    name: tool.schema.string().optional().describe("方案名称（rename 与 name/summary 至少一项；add_plan 可选，默认「未命名方案」）"),
    summary: tool.schema.string().optional().describe("rename 时的方案摘要"),
    set_active: tool.schema.boolean().optional().describe("add_plan 时是否切换为活动方案；缺省 true（gateway addPlan 本就会激活新方案）"),
    reason: tool.schema.string().min(1).describe("一句话说明为什么做这次方案操作（进决策日志，供审计）"),
  },
  async execute(args, context) {
    try {
      const id = String(args.plan_id ?? "")
      const operation = String(args.operation ?? "")
      if (operation === "add_plan") {
        const planName = String(args.name ?? "").trim() || "未命名方案"
        const ops: Array<Record<string, unknown>> = [{ op: "addPlan", plan: { name: planName, shots: [] } }]
        let prevActive: string | null = null
        if (args.set_active === false) {
          const state = await directorFetch(context.sessionID, "state", "GET", undefined, context.abort)
          prevActive = activePlanOf(state)?.id ?? null
          if (prevActive) ops.push({ op: "setActivePlan", plan_id: prevActive })
        }
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          { ops, reason: args.reason },
          context.abort,
        )
        const changed = (data.changed as string[] | undefined)?.find((entry) => entry.startsWith("plan:"))
        const project = data.project as { activePlanId?: string | null } | undefined
        return ok({
          operation,
          plan_id: changed ? changed.slice("plan:".length) : (project?.activePlanId ?? null),
          active_plan_id: project?.activePlanId ?? null,
          ...(prevActive ? { note: "set_active=false：新方案已建，活动方案已切回原方案" } : {}),
          revision: data.revision,
        })
      }
      if (!id) return fail("director_invalid_args", `方案操作 ${operation || "(空)"} 需要 plan_id`)
      if (operation === "switch") {
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          { ops: [{ op: "setActivePlan", plan_id: id }], reason: args.reason },
          context.abort,
        )
        const project = data.project as { activePlanId?: string | null } | undefined
        return ok({ operation, plan_id: id, active_plan_id: project?.activePlanId ?? null, revision: data.revision })
      }
      const state = await directorFetch(context.sessionID, "state", "GET", undefined, context.abort)
      const activePlan = activePlanOf(state)
      const plans = (state.project as { plans?: Array<{ id: string }> }).plans ?? []
      if (!plans.some((item) => item.id === id)) {
        return fail("director_not_found", `找不到方案 ${id}`)
      }
      void activePlan
      if (operation === "rename") {
        if (!String(args.name ?? "").trim() && args.summary === undefined) {
          return fail("director_invalid_args", "需要提供方案名称或摘要")
        }
        const patch: { name?: string; summary?: string } = {}
        if (String(args.name ?? "").trim()) patch.name = String(args.name).trim()
        if (args.summary !== undefined) patch.summary = String(args.summary)
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          { ops: [{ op: "updatePlan", plan_id: id, patch }], reason: args.reason },
          context.abort,
        )
        return ok({ operation, plan_id: id, revision: data.revision })
      }
      if (operation === "duplicate") {
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          { ops: [{ op: "duplicatePlan", plan_id: id }], reason: args.reason },
          context.abort,
        )
        const changed = (data.changed as string[] | undefined)?.find((entry) => entry.startsWith("plan:"))
        const project = data.project as { activePlanId?: string | null } | undefined
        return ok({ duplicated_from: id, created_plan_id: project?.activePlanId ?? (changed ? changed.slice("plan:".length) : null), revision: data.revision })
      }
      if (operation === "delete") {
        if (plans.length <= 1) return fail("director_blocked", "导演台至少保留一个方案")
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          { ops: [{ op: "removePlan", plan_id: id }], reason: args.reason },
          context.abort,
        )
        const project = data.project as { activePlanId?: string | null } | undefined
        return ok({ operation, plan_id: id, active_plan_id: project?.activePlanId ?? null, revision: data.revision })
      }
      return fail("director_invalid_args", `不支持的方案操作 ${operation}`)
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return guardFail(e)
    }
  },
})
