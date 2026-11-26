import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, directorFail } from "../lib/director-common"

// 3D 导演台候选方案生成（片4，2026-09-02）。kunpeng proposePlansTool → gateway
// POST /agent/v1/director/proposals（planning-core 轮子 fallbackPlans 链，30 分钟 TTL 暂存）。
// 守卫照搬：只生成候选不写入工程，返回 requires_user_confirmation:true。

export default tool({
  description:
    "基于当前白模工程提出 2 至 3 套候选导演方案，只生成候选，不写入工程。返回 proposal_id 后必须展示给用户确认。",
  args: {
    instruction: tool.schema.string().describe("用户对导演方案的要求（如节奏、情绪、运镜风格）"),
  },
  async execute(args, context) {
    try {
      const data = await directorFetch(
        context.sessionID,
        "proposals",
        "POST",
        { instruction: String(args.instruction ?? "") },
        context.abort,
      )
      return ok({
        proposal_ids: data.proposal_ids,
        requires_user_confirmation: true,
        plans: data.plans,
        note: "候选方案未写入工程。必须把方案摘要展示给用户，等用户明确选择后才能用 director_apply_proposal 写入。",
      })
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return directorFail(e)
    }
  },
})
