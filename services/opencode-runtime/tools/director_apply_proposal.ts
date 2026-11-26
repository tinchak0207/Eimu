import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, directorFail } from "../lib/director-common"

// 3D 导演台候选方案写入（片4，2026-09-02）。kunpeng applyProposalTool → gateway
// POST /agent/v1/director/apply_proposal（replacePlans + emit；30 分钟 TTL 守卫在 gateway，
// 拒绝文案「候选方案不存在或已过期，请重新生成」由 gateway 返回，工具透传）。

export default tool({
  description:
    "把用户已明确选择的候选方案写入白模工程。会替换方案列表，可撤销；没有确认时严禁调用。",
  args: {
    proposal_id: tool.schema.string().describe("director_propose_plans 返回且用户已明确选择的候选方案 ID"),
    reason: tool.schema.string().min(1).describe("一句话记录用户的确认决定（进决策日志，供审计）"),
  },
  async execute(args, context) {
    try {
      const data = await directorFetch(
        context.sessionID,
        "apply_proposal",
        "POST",
        { proposal_id: String(args.proposal_id ?? "") },
        context.abort,
      )
      const project = data.project as { plans?: unknown[] } | undefined
      return ok({
        applied: Array.isArray(project?.plans) ? project!.plans!.length : null,
        undo_available: true,
        note: "候选方案已写入工程（replacePlans）。可用 director_transport(action=undo) 撤销。",
        revision: data.revision,
      })
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return directorFail(e)
    }
  },
})
