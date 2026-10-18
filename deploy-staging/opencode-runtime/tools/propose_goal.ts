import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"
const CONDITION_MAX_CHARS = 500

const EXAMPLE_ARGS = {
  condition: "所有测试通过（bun test 退出码 0），且仓库无未提交的调试输出",
  ask_user: true,
}
const EXAMPLE_JSON = JSON.stringify(EXAMPLE_ARGS)

export default tool({
  description: [
    "为当前会话设定一个可独立核验的完成条件（ProposeGoal）。",
    "何时用：终态可验证且工作需要跨多轮时才提；单步任务、无法核验的「做好一点/让用户满意」不要提。",
    "关键约束：condition ≤500 字符、可观察可判定；用户拒绝后不得重提或换句话重提；同一会话只保留 1 个 active；ask_user=false 仅当用户原话已明确表达该结果。",
    "失败处置：missing_required_args 表示 condition 为空；invalid_condition 表示超过 500 字符，收敛成一句；goal_propose_failed 按 gateway code 修正；gateway_unreachable 稍后重试。",
    "互指：goal 是终态验收，不替代任务板；拆步骤用 task_create/task_update，评审问题用 report_findings。",
    "示例：propose_goal({condition:三个章节全部交付且每章都有真实成片链接, ask_user:true})",
  ].join("\n"),
  args: {
    condition: tool.schema
      .string()
      .optional()
      .describe("会话目标的可核验完成条件（必填，≤500 字符，独立验收者仅凭对话即可判定）"),
    ask_user: tool.schema
      .boolean()
      .optional()
      .describe("true（默认）=先提案并弹一键确认卡；false=仅当用户原话已明确表达该结果时直接生效"),
  },
  async execute(args, context) {
    const condition = typeof args.condition === "string" ? args.condition.trim() : ""
    if (!condition) {
      return fail(
        "missing_required_args",
        `propose_goal 缺少必填字段：condition。请补齐后重呼；示例：${EXAMPLE_JSON}`,
        { missing: ["condition"], example: EXAMPLE_ARGS },
      )
    }
    if ([...condition].length > CONDITION_MAX_CHARS) {
      return fail("invalid_condition", `condition 最多 ${CONDITION_MAX_CHARS} 字符，请收敛成一句可核验的完成条件`)
    }
    if (/[\u0000-\u001f\u007f-\u009f]/.test(condition)) {
      return fail("invalid_condition", "condition 不得包含 NUL/ANSI 控制字符")
    }
    const askUser = args.ask_user !== false

    try {
      const res = await fetch(`${GATEWAY}/internal/goal/propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: context.sessionID,
          condition,
          ask_user: askUser,
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        return fail(
          typeof data?.code === "string" && data.code ? data.code : "goal_propose_failed",
          data?.error || `HTTP ${res.status}`,
          { http_status: res.status },
        )
      }
      const goalId = data.goal?.id
      const status = data.goal?.status
      if (status === "active") {
        return ok({
          title: "会话目标已生效",
          goal_id: goalId,
          status,
          condition,
          note: "已在对话中留下可见通知；无需复述本回执。",
        })
      }
      const delivered = data.card_delivered === true
      return ok({
        title: delivered ? "目标待用户确认" : "目标已登记（卡片未送达）",
        goal_id: goalId,
        status,
        request_id: data.request_id ?? null,
        card_delivered: delivered,
        condition,
        note: delivered
          ? "确认卡已推送；提案非阻塞，继续当前工作，不要等待用户答复。"
          : "会话不在线，确认卡未推送；目标仍为 proposed，待后续审批。",
      })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
