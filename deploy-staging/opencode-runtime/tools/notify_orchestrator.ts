import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

// D2：必填自检 + 可照抄的完整参数示例。
const EXAMPLE_ARGS = {
  kind: "blocked",
  text: "缺角色设定图，无法继续第一镜的分镜生成；需要派工方确认用哪一版参考图。",
  question: {
    header: "用哪版角色参考图？",
    options: ["用 A 版三视图", "用 B 版定妆照", "等我上传新图"],
    is_blocking: true,
  },
}
const EXAMPLE_JSON = JSON.stringify(EXAMPLE_ARGS)

export default tool({
  description: [
    "子代理向派工方（orchestrator）上报的通道——这是「子→父」方向。",
    "**什么时候用**：任务遇到阻塞、需要派工方决策、或到达一个值得让派工方知道的里程碑（阶段完成、真实产物已落盘）。",
    "**kind**：`progress`＝里程碑/阶段进展；`blocked`＝被卡住、无法自行推进；`question`＝需要派工方拿主意的决策，可带 `question` 对象（`header` 提问标题、`options` 候选答案、`is_blocking` 是否阻塞等待答复、`is_secret` 是否敏感）。",
    "**父方忙碌时不会被打断**：消息进它的待读队列，回执 `delivery:\"skipped_inactive\"`、`parent_woken:false`；该回报**会在派工方下一次被唤醒时一并送达**（不保证立即）。父方空闲时唤醒一次，回 `delivery:\"accepted\"`、`parent_woken:true`。**唤醒有 60s 窗口限流，且按类别分道：progress／blocked（连同 `is_blocking:false` 的非阻塞提问）一道，`is_blocking:true` 的阻塞式提问另一道，各自独立计时——一类刚唤醒过不会抑制另一类。** 若回执带 `throttled:true`，表示**本类**在本窗口内已唤醒过父方、本条只入队：回报不会丢，会在派工方**下一次被唤醒时一并送达**（不保证立即，不会立刻被读到）。若你在等答复而长时间无回应，用 `subagent_status` 复核 `pending_questions`，别原地重投。等待唤醒不靠轮询——以本工具的真实回执为准。",
    "**不要用它刷进度**：只为需要对方知晓或决策的事件上报，琐碎的过程日志不要投。上报内容不是正式交付，正式成果仍按任务书交付契约回传。",
    `**必填**：kind 与 text。缺任一个会被拒并回传可照抄的完整参数示例。示例参数：${EXAMPLE_JSON}`,
  ].join("\n"),
  args: {
    kind: tool.schema
      .enum(["progress", "blocked", "question"])
      .optional()
      .describe("上报类型：progress=里程碑/进展；blocked=被卡住；question=需要派工方决策（可带 question 对象）"),
    text: tool.schema
      .string()
      .optional()
      .describe("一句话说明发生了什么、你需要什么。必填"),
    question: tool.schema
      .object({
        header: tool.schema.string().describe("提问标题（简短）"),
        options: tool.schema.array(tool.schema.string()).optional().describe("候选答案清单（可选，供派工方/用户挑选）"),
        is_blocking: tool.schema.boolean().optional().describe("true=你需要答复才能继续；缺省 false（不阻塞）"),
        is_secret: tool.schema.boolean().optional().describe("true=提问涉及敏感信息，展示时注意"),
      })
      .optional()
      .describe("kind=\"question\" 时携带的结构化提问：header 必填，options/is_blocking/is_secret 可选"),
  },
  async execute(args, context) {
    const kind = typeof args.kind === "string" ? args.kind.trim() : ""
    const text = typeof args.text === "string" ? args.text.trim() : ""
    const missing: string[] = []
    if (!kind) missing.push("kind")
    if (!text) missing.push("text")
    if (missing.length > 0) {
      return fail(
        "missing_required_args",
        `notify_orchestrator 缺少必填字段：${missing.join("、")}。请补齐后重呼；完整参数示例：${EXAMPLE_JSON}`,
        { missing, example: EXAMPLE_ARGS },
      )
    }
    try {
      // session_id 必须是「子代理自己的 opencode 会话 id」，网关据此反查父会话。
      const res = await fetch(`${GATEWAY}/internal/subagent/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: context.sessionID,
          kind,
          text,
          ...(args.question && typeof args.question === "object" ? { question: args.question } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        return fail(
          typeof data?.code === "string" && data.code ? data.code : "notify_failed",
          data?.error || `HTTP ${res.status}`,
          { http_status: res.status },
        )
      }
      const delivery = data.delivery ?? "accepted"
      // R5(b)（FIX-G3/T1 分道）：唤醒有 60s 窗口限流，progress／blocked（＋is_blocking:false 的
      // 非阻塞提问）与 is_blocking:true 的阻塞式提问**分道独立计时**——gateway 回 throttled:true
      // 时如实透出「本类已唤醒过、本条只入队」，让子代理知道别原地空转重投。
      const throttled = data.throttled === true
      const isBlockingQ = kind === "question" && !(args.question && typeof args.question === "object" && args.question.is_blocking === false)
      return ok({
        title: "已上报派工方",
        delivery,
        parent_woken: data.parent_woken === true,
        ...(throttled ? { throttled: true } : {}),
        ...(data.question_id !== undefined ? { question_id: data.question_id } : {}),
        note: throttled
          ? isBlockingQ
            ? "派工方本 60s 窗口内已因提问被唤醒过（提问道独立计时，progress 不占这道），本条已入队、未再次唤醒；回报不会丢，会在派工方下一次被唤醒时一并送达（不保证立即，不会立刻被读到）。若你在等答复而长时间无回应，用 subagent_status 复核 pending_questions，不要原地重投。"
            : "派工方本 60s 窗口内已被唤醒过（progress/blocked 类独立计时），本条已入队、未再次唤醒；回报不会丢，会在派工方下一次被唤醒时一并送达（不保证立即，不会立刻被读到）。不要原地空转重投——以真实回执为准。"
          : delivery === "skipped_inactive"
            ? "派工方当前忙碌，消息已进它的待读队列（不打断）；会在派工方下一次被唤醒时一并送达（不保证立即）。等待唤醒不靠轮询，以真实回执为准。"
            : "派工方空闲，已唤醒一次。等待唤醒不靠轮询，以真实回执为准。",
      })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
