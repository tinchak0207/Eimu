import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

const EXAMPLE_ARGS = {
  header: "角色服装选型确认",
  question: "第一幕有两套服装方案：A 方案现代休闲装，B 方案复古礼服。请确认采用哪一套？",
  options: ["采用 A 方案现代休闲", "采用 B 方案复古礼服", "由子代理自行权衡决定"],
  is_blocking: true,
  timeout_seconds: 600,
}
const EXAMPLE_JSON = JSON.stringify(EXAMPLE_ARGS)

export default tool({
  description: [
    "子代理向发起方（主代理/用户）发起定向结构化请示（Parent-Child RPC / AskParent）。",
    "用于向派工方确认关键决策、选择方案或请求补充信息，是主从代理协同的核心通信通道。",
    "**必填字段**：`question`（提问详细内容）。",
    "可选字段：`header`（简短标题）、`options`（候选选项清单，供派工方直接挑选）、`is_blocking`（true=阻塞等待答复，默认 true；false=非阻塞告知性提问）、`timeout_seconds`（超时秒数，默认 600 秒）。",
    "主代理将通过系统自动唤醒收到此提问，并可通过 subagent_message（携带返回的 question_id）直接给本子代理回送答复。",
    `示例参数：${EXAMPLE_JSON}`,
  ].join("\n"),
  args: {
    question: tool.schema
      .string()
      .optional()
      .describe("向派工方提出的详细问题内容（必填）"),
    header: tool.schema
      .string()
      .optional()
      .describe("提问简短标题，如「角色服装选型确认」「画质档位选择」（可选，默认「子代理提问」）"),
    options: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("候选选项清单（可选，如 [\"方案A\", \"方案B\"]，便于派工方/用户单选决策）"),
    is_blocking: tool.schema
      .boolean()
      .optional()
      .describe("是否为阻塞式提问（true=必须获得答案才能继续推进，默认 true；false=非阻塞建议/告知）"),
    timeout_seconds: tool.schema
      .number()
      .optional()
      .describe("等待答复的最大有效秒数（默认 600 秒）"),
  },
  async execute(args, context) {
    const question = typeof args.question === "string" ? args.question.trim() : ""
    if (!question) {
      return fail(
        "missing_required_args",
        `ask_parent 缺少必填字段：question。请补齐后重呼；示例：${EXAMPLE_JSON}`,
        { missing: ["question"], example: EXAMPLE_ARGS },
      )
    }
    const header = typeof args.header === "string" ? args.header.trim() : "子代理提问"
    const isBlocking = args.is_blocking !== false
    const options = Array.isArray(args.options) ? args.options.map((o) => String(o).trim()).filter(Boolean) : undefined
    const timeoutSeconds = typeof args.timeout_seconds === "number" && args.timeout_seconds > 0 ? args.timeout_seconds : 600

    try {
      const res = await fetch(`${GATEWAY}/internal/subagent/ask-parent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: context.sessionID,
          header,
          question,
          options,
          is_blocking: isBlocking,
          timeout_seconds: timeoutSeconds,
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        return fail(
          typeof data?.code === "string" && data.code ? data.code : "ask_parent_failed",
          data?.error || `HTTP ${res.status}`,
          { http_status: res.status },
        )
      }
      return ok({
        title: "已向派工方发起请示",
        question_id: data.question_id,
        header,
        is_blocking: isBlocking,
        parent_woken: data.parent_woken === true,
        delivery: data.delivery,
        resolve_by: data.resolve_by,
        note: data.note || "提问已送达派工方；答复将通过下一回合消息直接回送给你。",
      })
    } catch (e) {
      return fail("network_error", `向派工方提问网络失败：${e instanceof Error ? e.message : String(e)}`)
    }
  },
})
