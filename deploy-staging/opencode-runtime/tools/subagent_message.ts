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
    "给一个已在运行（或刚结束）的子代理追加指令/纠偏——不必把它杀死重派。",
    "**什么时候用**：subagent_status 显示它跑偏了（方向错、范围错、卡在错的做法上），或你拿到了新信息需要它中途调整；此时用本工具把新指令投给它，它会在自己那一轮里继续执行。",
    "**mode 语义**（缺省 start_or_steer）：`start_or_steer`＝它正在跑就 steer 当前轮，空闲（含刚结束、仍在续跑窗口内的终态子代理）则**复活并后台续跑**；`start_if_idle`＝它正在跑就只把消息排队（不打断），空闲才起一轮；`steer`＝只在指定轮正在跑时投递，须同时给 `expected_turn_id`，不符会被拒（turn_mismatch）。",
    "**给已终态子代理发消息＝后台续跑**：已经完成的子代理只要还在续跑窗口内，再给它发消息即唤醒它继续干活，不需要重新派遣。例外：被你自己用 subagent_stop 硬停的（或人工取消的）不自动续跑，会回 `agent_cancelled`。",
    "**接受 ≠ 已处理**：成功回执里的 `submission_id` 只是「网关已收下这条消息」的接受标识，`delivery` 说明投递方式（steered/started/queued），`note` 固定提醒接受标识不代表对方已经读到或照做。不要把它当「已生效」。",
    "**回答子代理的提问**：子代理若登记了阻塞式提问（subagent_status 的 `pending_questions`），用本工具带 `kind:\"question\"` 与取自该清单的 `question_id` 把答复投过去，网关按 id 精确解除阻塞；成功回执会带 `question_resolved:true`。回答提问同样需要 `text`（答复正文）。",
    `**必填**：subagent_id（完整 runId / label 前缀 / \"latest\"）与 text。缺任一个会被拒并回传可照抄的完整参数示例。示例参数：${EXAMPLE_JSON}`,
  ].join("\n"),
  args: {
    subagent_id: tool.schema
      .string()
      .optional()
      .describe("目标子代理：subagent_dispatch 返回的完整 runId、label 前缀，或 \"latest\"（本会话最近一次 run）；必填"),
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
