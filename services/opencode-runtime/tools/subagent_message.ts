import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

// D2（沿用 subagent_dispatch 范式）：必填自检 + 可照抄的完整参数示例。
const EXAMPLE_ARGS = {
  subagent_id: "latest",
  text: "方向调整：交付改成 3 组而不是 5 组，其余不变。",
  mode: "start_or_steer",
}
const EXAMPLE_JSON = JSON.stringify(EXAMPLE_ARGS)

// 409 的 code → 可读指引（逐字对映规格 §3.1 的 code 取值）。
const GUIDANCE: Record<string, string> = {
  agent_cancelled:
    "该子代理已被人工停止（subagent_stop），不会自动续跑；消息被拒绝。如需继续这项任务，请重新派遣。",
  turn_not_steerable:
    "该子代理当前这一轮不可 steer（如内审/压缩轮）。可改用 mode:\"start_if_idle\" 把消息排队，等这一轮结束后再处理。",
  turn_mismatch:
    "expected_turn_id 与它当前正在跑的轮不符（那一轮已结束或已换轮）。先用 subagent_status 取回 current_turn_id，再用新的 turn id 或省略 expected_turn_id 重发。",
  not_messageable:
    "该子代理当前状态不接受消息（可能已被硬停、记录已过期或已终止）。先用 subagent_status 复核实况再决定。",
}

export default tool({
  description: [
    "给运行中或刚结束的子代理追加指令或纠偏。",
    "何时用：子代理跑偏、需要中途调整，或回答它的阻塞提问时；任务作废要停用 subagent_stop，全新任务重新派遣。",
    "关键约束：必填 subagent_id 与 text；mode 默认 start_or_steer；回答提问须 kind=question 与 question_id；submission_id 只代表已收下，不代表已生效。",
    "调用权限：主会话（orchestrator）可给本会话任意子代理发消息；子代理默认只能给自己派出的子 run 发，操作兄弟会被拒为 sibling_forbidden。",
    "失败处置：agent_cancelled 表示已被停，只能重派；turn_not_steerable 改用 start_if_idle；turn_mismatch 先用 subagent_status 取 current_turn_id；not_messageable 核实状态；sibling_forbidden 表示越权，改由主会话处理；missing_required_args 补字段。",
    "互指：短期邮箱消息用 mailbox_send；查状态用 subagent_status；停止用 subagent_stop。",
    "示例：subagent_message({subagent_id:latest, text:只修 src/auth.ts:42 的空指针，不要改测试。})",
  ].join("\n"),
  args: {
    subagent_id: tool.schema
      .string()
      .optional()
      .describe("目标子代理：subagent_dispatch 返回的完整 runId、派遣时指定的 name、label 前缀，或 \"latest\"（本会话最近一次 run）；必填"),
    text: tool.schema
      .string()
      .optional()
      .describe("要给子代理的话：纠偏指令、补充信息或追问。子代理会把它当作派工方的正常任务方向执行；必填"),
    mode: tool.schema
      .enum(["start_or_steer", "start_if_idle", "steer"])
      .optional()
      .describe(
        "投递方式，缺省 start_or_steer：start_or_steer=在跑则 steer、空闲则起轮（已终态在续跑窗口内即复活续跑）；start_if_idle=在跑则排队不打断；steer=只在指定轮在跑时投递（须给 expected_turn_id）",
      ),
    expected_turn_id: tool.schema
      .string()
      .optional()
      .describe("配合 mode:\"steer\" 使用：要求它正在跑的是这一轮；不符会被拒（turn_mismatch）。可用 subagent_status 的 current_turn_id 取得"),
    kind: tool.schema
      .enum(["message", "followup", "question"])
      .optional()
      .describe(
        "消息类型，缺省 message：message=普通纠偏指示；followup=追询；question=回答子代理的阻塞式提问（**须同时带 question_id**，把子代理从「等答复」解锁）。仅在传了值时才外发给网关。",
      ),
    question_id: tool.schema
      .string()
      .optional()
      .describe(
        "kind:\"question\" 时带上：要解除的提问 id。取自 subagent_status 运行中回执的 pending_questions[].question_id；网关只按该 id 精确解除，不带或不符则不解。",
      ),
  },
  async execute(args, context) {
    const subagentId = typeof args.subagent_id === "string" ? args.subagent_id.trim() : ""
    const text = typeof args.text === "string" ? args.text.trim() : ""
    const missing: string[] = []
    if (!subagentId) missing.push("subagent_id")
    if (!text) missing.push("text")
    if (missing.length > 0) {
      return fail(
        "missing_required_args",
        `subagent_message 缺少必填字段：${missing.join("、")}。请补齐后重呼；完整参数示例：${EXAMPLE_JSON}`,
        { missing, example: EXAMPLE_ARGS },
      )
    }
    try {
      const mode = typeof args.mode === "string" && args.mode.trim() ? args.mode.trim() : undefined
      const expectedTurnId =
        typeof args.expected_turn_id === "string" && args.expected_turn_id.trim() ? args.expected_turn_id.trim() : undefined
      // R2：kind/question_id 只在**传了值**时才进 body——不传时外发 body 与旧版逐字相同（零回归）。
      // question_id 是解除子代理阻塞式提问的唯一入口（gateway resolveQuestionOnAnswer 只认它）。
      const kind = typeof args.kind === "string" && args.kind.trim() ? args.kind.trim() : undefined
      const questionId = typeof args.question_id === "string" && args.question_id.trim() ? args.question_id.trim() : undefined
      const res = await fetch(`${GATEWAY}/internal/subagent/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: context.sessionID,
          subagent_id: subagentId,
          text,
          ...(mode !== undefined ? { mode } : {}),
          ...(expectedTurnId !== undefined ? { expected_turn_id: expectedTurnId } : {}),
          ...(kind !== undefined ? { kind } : {}),
          ...(questionId !== undefined ? { question_id: questionId } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        const code =
          typeof data?.code === "string" && data.code
            ? data.code
            : res.status === 409
              ? "not_messageable"
              : "message_failed"
        // 409 与具名 code：给可读指引（照规格 §3.1 的 code 分支）。
        const guidance = GUIDANCE[code]
        if (guidance) {
          return fail(code, guidance, {
            http_status: res.status,
            ...(typeof data?.error === "string" && data.error ? { gateway_error: data.error } : {}),
          })
        }
        return fail(code, data?.error || `HTTP ${res.status}`, { http_status: res.status })
      }
      // 成功：把接受标识与投递方式如实透传；note 强调「接受≠已处理」。
      // R2(c)/R5(a)：把 gateway 实际会回的 resumed_from（复活了哪条 run）/question_resolved
      // （是否把某条阻塞式提问解掉了）/pending_count（排队中的消息数）存在才透传。
      return ok({
        title: "消息已投给子代理",
        subagent_id: data.subagent_id ?? subagentId,
        delivery: data.delivery ?? "queued",
        submission_id: data.submission_id ?? "",
        ...(data.resumed_from !== undefined ? { resumed_from: data.resumed_from } : {}),
        ...(data.question_resolved !== undefined ? { question_resolved: data.question_resolved } : {}),
        ...(data.pending_count !== undefined ? { pending_count: data.pending_count } : {}),
        note: typeof data.note === "string" && data.note ? data.note : "接受标识不代表已被处理。",
      })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
