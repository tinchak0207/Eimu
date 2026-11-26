import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

const EXAMPLE_ARGS = {
  stage: "第一幕分镜生成",
  progress: 40,
  data: {
    shots_completed: [1, 2, 3],
    task_ids: ["task_img_001", "task_img_002", "task_img_003"],
    selected_theme: "cyberpunk_neon",
  },
  summary: "前 3 镜分镜已生成并完成质检，已提交上游批次",
}
const EXAMPLE_JSON = JSON.stringify(EXAMPLE_ARGS)

export default tool({
  description: [
    "子代理每完成一个阶段工作时，立即落盘结构化检查点并同步事件流给主代理（Heartbeat & Checkpoint Stream）。",
    "即使子代理进程中断、超时或被打断，主代理可以直接接管该检查点，或派另一个后继子代理直接从断点接续（通过 subagent_dispatch 的 from_checkpoint_run_id），绝不从零重跑已完成的成果。",
    "**必填字段**：`stage`（当前阶段名称，如「角色设计锁定」「分镜提交任务池」）与 `progress`（进度百分比 0-100）。",
    "建议附带 `data`（结构化数据，如任务ID数组、参数JSON、生成结果）与 `summary`（阶段完成一句话摘要）。",
    `示例参数：${EXAMPLE_JSON}`,
  ].join("\n"),
  args: {
    stage: tool.schema
      .string()
      .optional()
      .describe("当前阶段名称（必填，如「素材解析」「音频对齐」「分镜任务池提交」）"),
    progress: tool.schema
      .number()
      .optional()
      .describe("当前任务整体进度百分比（0-100，必填）"),
    data: tool.schema
      .record(tool.schema.string(), tool.schema.any())
      .optional()
      .describe("阶段产出的关键结构化数据（如已完成的任务ID、选择的参数、阶段结论等，供断点接管继承）"),
    summary: tool.schema
      .string()
      .optional()
      .describe("当前阶段完成的一句话人话摘要"),
  },
  async execute(args, context) {
    const stage = typeof args.stage === "string" ? args.stage.trim() : ""
    const progress = typeof args.progress === "number" ? Math.min(100, Math.max(0, args.progress)) : undefined
    const missing: string[] = []
    if (!stage) missing.push("stage")
    if (progress === undefined) missing.push("progress")
    if (missing.length > 0) {
      return fail(
        "missing_required_args",
        `report_checkpoint 缺少必填字段：${missing.join("、")}。请补齐后重呼；示例：${EXAMPLE_JSON}`,
        { missing, example: EXAMPLE_ARGS },
      )
    }
    const data = typeof args.data === "object" && args.data !== null && !Array.isArray(args.data) ? args.data : {}
    const summary = typeof args.summary === "string" ? args.summary.trim() : ""

    try {
      const res = await fetch(`${GATEWAY}/internal/subagent/checkpoint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: context.sessionID,
          stage,
          progress,
          data,
          summary,
        }),
        signal: AbortSignal.timeout(15000),
      })
      const resp = await res.json().catch(() => ({}))
      if (!res.ok || !resp?.ok) {
        return fail(
          typeof resp?.code === "string" && resp.code ? resp.code : "checkpoint_failed",
          resp?.error || `HTTP ${res.status}`,
          { http_status: res.status },
        )
      }
      return ok({
        title: "阶段检查点已落盘同步",
        checkpoint_id: resp.checkpoint_id,
        stage: resp.stage,
        progress: resp.progress,
        at: resp.at,
        note: "检查点已持久化落盘并推送到父会话事件流；后续断点可通过 from_checkpoint_run_id 无损接续。",
      })
    } catch (e) {
      return fail("network_error", `检查点上报网络失败：${e instanceof Error ? e.message : String(e)}`)
    }
  },
})
